-- Этап 11, Review 11-1: R11-01, R11-02, R11-03. Принятая 0029 не меняется (ADR-002); функции заменяются целиком.
--
-- R11-03. Актуальность косвенного основания значения поля проверялась только по самой сущности: у ревизии требования —
-- статус и следующая ревизия, у факта графа D-018 — `fact_state`, у решения — следующее решение. Заменённый исходный
-- документ (новая редакция ТЗ или договора до перестроения графа) подтверждал новую версию поля — и в API, и обоими
-- триггерами 0029, которые пользуются `field_basis_problem`. Теперь основание раскрывается до фрагментов, из которых
-- получен его текст (`field_basis_source_fragments`), и каждый фрагмент проверяется той же функцией актуальности
-- 0027–0028, что и прямое основание: редакция документа, письма, транскрипции, ответа заказчика, повторное распознавание,
-- исключение из состава источников этапа. Вторая линия (при вставке и в конце транзакции) и «заполнено» (0029)
-- получают проверку автоматически.
--
-- R11-01. Основанием поля служит решение по требованию (`requirement_decision`): его закрытость определена замыканием
-- этапа 08 (R08-02). Решения других видов основаниями значения поля не принимаются — их права источника не раскрываются
-- до фрагментов по графу этапа.
--
-- R11-02. Версия, повторяющая значение другой версии (обсуждение, повторное подтверждение, перенос), ссылается на неё
-- (`value_from_version_id`): права и происхождение скопированного значения наследуются по этой ссылке. Обсуждение со
-- значением и перенос без такой ссылки в БД не записываются.

-- ---------------------------------------------------------------- R11-03: источники основания

-- Фрагменты, из которых получен текст основания: фрагмент — он сам; ревизия требования — основания ревизии в любой роли
-- и основания кандидата, из которого она подтверждена; решение — его основания; факт графа — фрагменты, из которых он
-- прочитан.
CREATE FUNCTION field_basis_source_fragments(p_fragment uuid, p_decision uuid, p_requirement_revision uuid, p_evidence_fact uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT p_fragment WHERE p_fragment IS NOT NULL
  UNION
  SELECT l.fragment_id FROM evidence_link l WHERE p_requirement_revision IS NOT NULL AND l.requirement_revision_id = p_requirement_revision
  UNION
  SELECT l.fragment_id FROM requirement_revision r JOIN evidence_link l ON l.requirement_candidate_id = r.candidate_id
   WHERE p_requirement_revision IS NOT NULL AND r.id = p_requirement_revision
  UNION
  SELECT l.fragment_id FROM evidence_link l WHERE p_decision IS NOT NULL AND l.decision_id = p_decision
  UNION
  SELECT unnest(d.basis_fragment_ids) FROM decision d WHERE p_decision IS NOT NULL AND d.id = p_decision
  UNION
  SELECT ff.fragment_id FROM evidence_fact_fragment ff WHERE p_evidence_fact IS NOT NULL AND ff.evidence_fact_id = p_evidence_fact
$$;

-- Проблема основания сейчас: сначала сама сущность (заменённое решение, изменённое требование, состояние факта), затем
-- каждый исходный фрагмент по функции актуальности 0027–0028.
CREATE OR REPLACE FUNCTION field_basis_problem(p_stage uuid, p_fragment uuid, p_decision uuid, p_requirement_revision uuid, p_evidence_fact uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    CASE
      WHEN p_decision IS NOT NULL AND EXISTS (SELECT 1 FROM decision n WHERE n.supersedes_decision_id = p_decision)
        THEN 'decision_superseded'
      WHEN p_requirement_revision IS NOT NULL THEN (
        SELECT CASE WHEN r.status <> 'confirmed' OR EXISTS (SELECT 1 FROM requirement_revision n WHERE n.supersedes_revision_id = r.id)
                    THEN 'requirement_revision_superseded' END
          FROM requirement_revision r WHERE r.id = p_requirement_revision)
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

-- ---------------------------------------------------------------- R11-01: решение-основание — решение по требованию

CREATE OR REPLACE FUNCTION draft_field_basis_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
BEGIN
  SELECT a.stage_id INTO v_stage FROM draft_field_version v JOIN application_draft a ON a.id = v.draft_id
   WHERE v.id = NEW.field_version_id AND v.tender_id = NEW.tender_id AND v.created_xact = pg_current_xact_id();
  IF v_stage IS NULL THEN
    RAISE EXCEPTION 'draft_field_basis: основания пишутся вместе с версией значения' USING ERRCODE = '55000';
  END IF;
  IF (NEW.fragment_id IS NOT NULL AND NOT fragment_in_stage(NEW.fragment_id, v_stage))
     OR (NEW.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.tender_id = NEW.tender_id))
     OR (NEW.requirement_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM requirement_revision r WHERE r.id = NEW.requirement_revision_id AND r.tender_id = NEW.tender_id))
     OR (NEW.evidence_fact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fact_state s WHERE s.evidence_fact_id = NEW.evidence_fact_id AND s.tender_id = NEW.tender_id)) THEN
    RAISE EXCEPTION 'draft_field_basis: основание вне этапа или тендера приложения' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.decision_type = 'requirement_decision') THEN
    RAISE EXCEPTION 'draft_field_basis: основание-решение — решение по требованию (закрытость по замыканию этапа, R11-01)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- R11-02: источник скопированного значения

ALTER TABLE draft_field_version ADD COLUMN value_from_version_id uuid REFERENCES draft_field_version (id);

-- Скопированное значение — то же, что у версии-источника; источник — текущая версия поля или версия, с которой
-- перенесено. Обсуждение со значением и перенос — только со ссылкой на источник.
CREATE FUNCTION draft_field_version_value_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_value jsonb;
BEGIN
  IF NEW.state = 'carried_over' AND NEW.value_from_version_id IS DISTINCT FROM NEW.carried_from_version_id THEN
    RAISE EXCEPTION 'draft_field_version: перенесённое значение ссылается на версию, с которой перенесено (R11-02)' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'needs_discussion' AND NEW.value IS NOT NULL AND NEW.value_from_version_id IS DISTINCT FROM NEW.previous_version_id THEN
    RAISE EXCEPTION 'draft_field_version: значение обсуждения — значение текущей версии поля со ссылкой на неё (R11-02)' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_from_version_id IS NOT NULL THEN
    IF NEW.value_from_version_id IS DISTINCT FROM NEW.previous_version_id AND NEW.value_from_version_id IS DISTINCT FROM NEW.carried_from_version_id THEN
      RAISE EXCEPTION 'draft_field_version: источник значения — текущая версия поля или версия, с которой перенесено' USING ERRCODE = '23514';
    END IF;
    SELECT v.value INTO v_value FROM draft_field_version v WHERE v.id = NEW.value_from_version_id;
    IF v_value IS DISTINCT FROM NEW.value THEN
      RAISE EXCEPTION 'draft_field_version: скопированное значение отличается от значения версии-источника' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER draft_field_version_value_source BEFORE INSERT ON draft_field_version FOR EACH ROW EXECUTE FUNCTION draft_field_version_value_source();
