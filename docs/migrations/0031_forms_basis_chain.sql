-- Этап 11, Review 11-2: R11-03 (неполнота исправления 0030), R11-05. Принятые 0029–0030 не меняются (ADR-002); функции
-- заменяются целиком.
--
-- R11-03. Решение по требованию без собственных цитат не раскрывалось до требования-предмета: `field_basis_source_fragments`
-- (0030) читала только основания самого решения, поэтому заменённый исходный документ требования не делал основание
-- «заменённым», а зависимость поля от документа не записывалась. Решение теперь закрепляет ревизию требования, на
-- которую оно опирается (`decision_requirement_revision`; для решений, записанных до 0031, — ревизия, действовавшая на
-- момент решения). Источники решения — его собственные основания и основания закреплённой ревизии; закреплённая
-- ревизия, заменённая следующей или не подтверждённая, — `requirement_revision_superseded`. Текущей ревизией
-- закреплённая не подменяется.
--
-- R11-05. Копия значения (обсуждение, повторное подтверждение, перенос) ссылалась на версию-источник (0030), но
-- актуальность оснований проверялась только по собственным основаниям текущей версии: после замены документа копия
-- не была «устаревшей», подтверждение и «заполнено» проходили. Теперь проблема основания значения версии считается по
-- всей цепочке источников (`field_version_basis_problem`); подтверждение копии по заменённому основанию отвергается
-- второй линией при вставке и в конце транзакции; «заполнено» проверяет цепочку.

-- ---------------------------------------------------------------- R11-03: ревизия требования, закреплённая решением

CREATE TABLE decision_requirement_revision (
  decision_id             uuid PRIMARY KEY REFERENCES decision (id),
  requirement_revision_id uuid NOT NULL REFERENCES requirement_revision (id)
);

-- Решения, записанные до 0031: ревизия требования, действовавшая на момент решения.
INSERT INTO decision_requirement_revision (decision_id, requirement_revision_id)
SELECT d.id, r.id
  FROM decision d
  JOIN LATERAL (SELECT x.id FROM requirement_revision x
                 WHERE x.requirement_id = d.subject_id AND x.created_at <= d.created_at
                 ORDER BY x.seq DESC LIMIT 1) r ON true
 WHERE d.decision_type = 'requirement_decision';

-- Закрепляется текущая ревизия требования-предмета решения по требованию.
CREATE FUNCTION decision_requirement_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM decision d JOIN requirement q ON q.id = d.subject_id
        WHERE d.id = NEW.decision_id AND d.decision_type = 'requirement_decision' AND q.current_revision_id = NEW.requirement_revision_id) THEN
    RAISE EXCEPTION 'decision_requirement_revision: закрепляется текущая ревизия требования-предмета решения по требованию' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_requirement_revision_guard BEFORE INSERT ON decision_requirement_revision FOR EACH ROW EXECUTE FUNCTION decision_requirement_revision_guard();
CREATE TRIGGER decision_requirement_revision_immutable BEFORE UPDATE OR DELETE ON decision_requirement_revision FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER decision_requirement_revision_no_truncate BEFORE TRUNCATE ON decision_requirement_revision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Ревизия требования, на которую опирается решение: закреплённая; без закрепления (запись в обход штатного пути) —
-- действовавшая на момент решения.
CREATE FUNCTION decision_requirement_revision_of(p_decision uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT p.requirement_revision_id FROM decision_requirement_revision p WHERE p.decision_id = p_decision),
    (SELECT x.id FROM decision d JOIN requirement_revision x ON x.requirement_id = d.subject_id
      WHERE d.id = p_decision AND d.decision_type = 'requirement_decision' AND x.created_at <= d.created_at
      ORDER BY x.seq DESC LIMIT 1))
$$;

-- Источники основания (0030) + у решения — основания закреплённой ревизии требования-предмета и её кандидата.
CREATE OR REPLACE FUNCTION field_basis_source_fragments(p_fragment uuid, p_decision uuid, p_requirement_revision uuid, p_evidence_fact uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH req AS (
    SELECT p_requirement_revision AS id WHERE p_requirement_revision IS NOT NULL
    UNION
    SELECT decision_requirement_revision_of(p_decision) WHERE p_decision IS NOT NULL
  )
  SELECT p_fragment WHERE p_fragment IS NOT NULL
  UNION
  SELECT l.fragment_id FROM req JOIN evidence_link l ON l.requirement_revision_id = req.id
  UNION
  SELECT l.fragment_id FROM req JOIN requirement_revision r ON r.id = req.id JOIN evidence_link l ON l.requirement_candidate_id = r.candidate_id
  UNION
  SELECT l.fragment_id FROM evidence_link l WHERE p_decision IS NOT NULL AND l.decision_id = p_decision
  UNION
  SELECT unnest(d.basis_fragment_ids) FROM decision d WHERE p_decision IS NOT NULL AND d.id = p_decision
  UNION
  SELECT ff.fragment_id FROM evidence_fact_fragment ff WHERE p_evidence_fact IS NOT NULL AND ff.evidence_fact_id = p_evidence_fact
$$;

-- Проблема основания (0030) + у решения — закреплённая ревизия требования заменена или не подтверждена.
CREATE OR REPLACE FUNCTION field_basis_problem(p_stage uuid, p_fragment uuid, p_decision uuid, p_requirement_revision uuid, p_evidence_fact uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    CASE
      WHEN p_decision IS NOT NULL AND EXISTS (SELECT 1 FROM decision n WHERE n.supersedes_decision_id = p_decision)
        THEN 'decision_superseded'
      WHEN p_decision IS NOT NULL OR p_requirement_revision IS NOT NULL THEN (
        SELECT CASE WHEN r.status <> 'confirmed' OR EXISTS (SELECT 1 FROM requirement_revision n WHERE n.supersedes_revision_id = r.id)
                    THEN 'requirement_revision_superseded' END
          FROM requirement_revision r WHERE r.id = coalesce(p_requirement_revision, decision_requirement_revision_of(p_decision)))
      WHEN p_evidence_fact IS NOT NULL THEN (
        SELECT CASE coalesce(s.status, 'unknown') WHEN 'active' THEN NULL WHEN 'superseded' THEN 'fact_superseded'
                    WHEN 'conflict' THEN 'fact_conflict' ELSE 'fact_unknown' END
          FROM (SELECT p_evidence_fact AS id) x LEFT JOIN fact_state s ON s.evidence_fact_id = x.id)
    END,
    (SELECT c FROM (SELECT change_basis_supersession(p_stage, f.id, NULL) AS c
                      FROM field_basis_source_fragments(p_fragment, p_decision, p_requirement_revision, p_evidence_fact) AS f(id)) x
      WHERE c IS NOT NULL ORDER BY c LIMIT 1)
  )
$$;

-- ---------------------------------------------------------------- R11-05: актуальность по цепочке копий значения

-- Версия-источник значения: ссылка 0030; у версий до 0030 — версия, с которой перенесено, или текущая на момент
-- обсуждения со значением.
CREATE FUNCTION draft_field_value_source(p_version uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(v.value_from_version_id,
                  CASE WHEN v.state = 'carried_over' THEN v.carried_from_version_id
                       WHEN v.state = 'needs_discussion' AND v.value IS NOT NULL THEN v.previous_version_id END)
    FROM draft_field_version v WHERE v.id = p_version
$$;

-- Проблема основания значения версии: основания самой версии и всех версий-источников скопированного значения.
CREATE FUNCTION field_version_basis_problem(p_stage uuid, p_version uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain(vid, depth) AS (
    SELECT p_version, 0 WHERE p_version IS NOT NULL
    UNION ALL
    SELECT draft_field_value_source(c.vid), c.depth + 1 FROM chain c
     WHERE draft_field_value_source(c.vid) IS NOT NULL AND c.depth < 10000
  )
  SELECT x.p FROM (
    SELECT field_basis_problem(p_stage, b.fragment_id, b.decision_id, b.requirement_revision_id, b.evidence_fact_id) AS p, c.depth
      FROM chain c JOIN draft_field_basis b ON b.field_version_id = c.vid) x
   WHERE x.p IS NOT NULL ORDER BY x.depth, x.p LIMIT 1
$$;

-- Отметка «основание изменилось»: у самой версии и — у копии без подтверждения (обсуждение, перенос) — у версий-
-- источников до ближайшей подтверждённой включительно. Подтверждение по действующему основанию отметки не наследует.
CREATE FUNCTION field_version_invalidated(p_version uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain(vid, state, depth) AS (
    SELECT v.id, v.state, 0 FROM draft_field_version v WHERE v.id = p_version
    UNION ALL
    SELECT s.id, s.state, c.depth + 1 FROM chain c JOIN draft_field_version s ON s.id = draft_field_value_source(c.vid)
     WHERE c.state IN ('needs_discussion', 'carried_over') AND c.depth < 10000
  )
  SELECT EXISTS (SELECT 1 FROM chain c JOIN evidence_invalidation i ON i.dependent_type = 'draft_field_version' AND i.dependent_id = c.vid)
$$;

-- Подтверждённое значение, повторяющее другую версию, — только по действующим основаниям всей цепочки (при вставке и
-- в конце транзакции).
CREATE FUNCTION draft_field_version_chain_fresh() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
  v_cause text;
BEGIN
  IF NEW.value_from_version_id IS NULL OR NEW.state NOT IN ('accepted', 'edited') THEN
    RETURN NULL;
  END IF;
  SELECT a.stage_id INTO v_stage FROM application_draft a WHERE a.id = NEW.draft_id;
  v_cause := field_version_basis_problem(v_stage, NEW.value_from_version_id);
  IF v_cause IS NOT NULL THEN
    RAISE EXCEPTION 'draft_field_version: скопированное значение по заменённому или конфликтующему основанию (%) не подтверждается', v_cause USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER draft_field_version_chain_fresh AFTER INSERT ON draft_field_version FOR EACH ROW EXECUTE FUNCTION draft_field_version_chain_fresh();
CREATE CONSTRAINT TRIGGER draft_field_version_chain_fresh_at_commit AFTER INSERT ON draft_field_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION draft_field_version_chain_fresh();

-- «Заполнено» второй линией (0029) — проблема основания по цепочке копий значения текущих версий.
CREATE OR REPLACE FUNCTION draft_completion_problem(p_draft uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH d AS (SELECT a.id, a.stage_id, r.required_keys FROM application_draft a JOIN template_revision r ON r.id = a.template_revision_id WHERE a.id = p_draft),
  latest AS (
    SELECT DISTINCT ON (f.id) f.field_key, v.id AS version_id, v.state, v.value
      FROM draft_field f JOIN draft_field_version v ON v.field_id = f.id
     WHERE f.draft_id = p_draft
     ORDER BY f.id, v.version DESC)
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM d, unnest(d.required_keys) k(key)
                  WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.field_key = k.key AND l.state IN ('accepted', 'edited') AND l.value IS NOT NULL))
      THEN 'required_empty'
    WHEN EXISTS (SELECT 1 FROM latest WHERE state = 'carried_over') THEN 'carried_over'
    WHEN EXISTS (SELECT 1 FROM latest WHERE state = 'needs_discussion') THEN 'needs_discussion'
    WHEN EXISTS (SELECT 1 FROM latest l, d WHERE field_version_basis_problem(d.stage_id, l.version_id) IS NOT NULL)
      THEN 'basis_superseded'
  END
$$;

GRANT SELECT, INSERT ON decision_requirement_revision TO kontur_app;
