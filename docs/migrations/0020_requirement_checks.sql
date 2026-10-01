-- R08-01 (Review 08-1): «неверная единица» и «конфликтующие требования» — обязательные проверки задания этапа 08.
-- Несовпадение единицы требования и позиции или строки расчёта отмечается БД у объекта покрытия; покрытие с ним
-- записывается только с явным пояснением и показывается отдельно. Противоречащее основание кандидата или другое
-- значение параметра того же имени у действующего требования реестра (пересекающаяся область) — конфликт:
-- подтверждение только с пояснением, конфликт виден в реестре и карточке. Автоматическое разрешение конфликтов —
-- правила этапа 09. Архитектура этапа 08 не меняется: новые колонки, функции и условия в охранниках 0019.

-- ---------------------------------------------------------------- Единицы

-- Нормализация единицы для сравнения: регистр, пробелы, точки, «^», надстрочные цифры, частые написания.
CREATE FUNCTION unit_normalize(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR btrim(p) = '' THEN NULL ELSE (
    SELECT CASE v
             WHEN 'кубм' THEN 'м3' WHEN 'мкуб' THEN 'м3' WHEN 'м3' THEN 'м3'
             WHEN 'квм' THEN 'м2' WHEN 'мкв' THEN 'м2' WHEN 'м2' THEN 'м2'
             WHEN 'пм' THEN 'м' WHEN 'погм' THEN 'м' WHEN 'мп' THEN 'м'
             WHEN 'тн' THEN 'т' WHEN 'тонна' THEN 'т'
             WHEN 'штук' THEN 'шт' WHEN 'комплект' THEN 'компл'
             ELSE v END
      FROM (SELECT regexp_replace(translate(lower(btrim(p)), '³²^.', '32'), '\s+', '', 'g') AS v) x) END
$$;

-- Единицы параметров ревизии требования (нормализованные, без повторов).
CREATE FUNCTION requirement_revision_units(p_revision uuid) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(DISTINCT unit_normalize(p ->> 'unit')) FILTER (WHERE unit_normalize(p ->> 'unit') IS NOT NULL), '{}')
    FROM requirement_revision v CROSS JOIN LATERAL jsonb_array_elements(v.parameters) p
   WHERE v.id = p_revision
$$;

-- Единица объекта расчёта: у строки — её единица, у позиции без строки — единица позиции.
CREATE FUNCTION calculation_object_unit(p_calc uuid, p_position uuid, p_item uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_item IS NOT NULL THEN (SELECT l.unit_code FROM calculation_revision r JOIN calculation_line l ON l.content_id = r.content_id
                                          WHERE r.id = p_calc AND l.external_item_id = p_item AND l.external_position_id = p_position)
           ELSE (SELECT p.unit_code FROM calculation_revision r JOIN calculation_position p ON p.content_id = r.content_id
                  WHERE r.id = p_calc AND p.external_position_id = p_position)
         END
$$;

-- Сравнение: нет позиции, нет единиц у требования или у расчёта — сравнить нечего (not_comparable).
CREATE FUNCTION coverage_unit_status(p_revision uuid, p_calc uuid, p_position uuid, p_item uuid)
RETURNS TABLE (requirement_units text[], calculation_unit text, unit_status text)
LANGUAGE sql STABLE AS $$
  SELECT u.req, u.calc,
         CASE WHEN p_position IS NULL OR cardinality(u.req) = 0 OR unit_normalize(u.calc) IS NULL THEN 'not_comparable'
              WHEN unit_normalize(u.calc) = ANY (u.req) THEN 'match'
              ELSE 'mismatch' END
    FROM (SELECT requirement_revision_units(p_revision) AS req, calculation_object_unit(p_calc, p_position, p_item) AS calc) u
$$;

ALTER TABLE requirement_coverage_object
  ADD COLUMN requirement_units text[],
  ADD COLUMN calculation_unit  text,
  ADD COLUMN unit_status       text CHECK (unit_status IN ('match', 'mismatch', 'not_comparable'));
ALTER TABLE requirement_coverage ADD COLUMN unit_mismatch_reason text CHECK (length(unit_mismatch_reason) BETWEEN 1 AND 1000);

-- Существующие объекты расчёта (0019) получают статус единиц той же функцией. Таблица неизменяема: охранник
-- снимается только на время этого заполнения в транзакции миграции.
ALTER TABLE requirement_coverage_object DISABLE TRIGGER requirement_coverage_object_immutable;
UPDATE requirement_coverage_object o
   SET (requirement_units, calculation_unit, unit_status) = (
         SELECT u.requirement_units, u.calculation_unit, u.unit_status
           FROM requirement_coverage c, coverage_unit_status(c.requirement_revision_id, o.calculation_revision_id, o.external_position_id, o.external_item_id) u
          WHERE c.id = o.coverage_id)
 WHERE o.object_type = 'calculation_revision';
ALTER TABLE requirement_coverage_object ENABLE TRIGGER requirement_coverage_object_immutable;
ALTER TABLE requirement_coverage_object
  ADD CONSTRAINT requirement_coverage_object_unit_shape CHECK ((object_type = 'calculation_revision') = (unit_status IS NOT NULL));

-- ---------------------------------------------------------------- Конфликтующие требования

-- Ключ параметра — нормализованное имя; значение — нормализованные число или текст и единица.
CREATE FUNCTION requirement_param_key(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(p ->> 'name'), '\s+', ' ', 'g'))
$$;
CREATE FUNCTION requirement_param_value(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(replace(btrim(p ->> 'value'), ',', '.'), '\s+', '', 'g')) || '|' || coalesce(unit_normalize(p ->> 'unit'), '')
$$;
-- Области пересекаются, если ни один ключ (объект, секция, этаж, помещение), заданный в обеих, не различается.
CREATE FUNCTION object_scopes_overlap(a jsonb, b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM jsonb_each_text(a) x JOIN jsonb_each_text(b) y ON y.key = x.key
                      WHERE lower(btrim(x.value)) <> lower(btrim(y.value)))
$$;

-- Действующие требования реестра (кроме p_requirement) с тем же параметром и другим значением в пересекающейся области.
CREATE FUNCTION requirement_parameter_conflicts(p_registry uuid, p_requirement uuid, p_parameters jsonb, p_scope jsonb)
RETURNS TABLE (requirement_id uuid, code text, parameter text)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT q.id, q.code, requirement_param_key(np)
    FROM requirement q
    JOIN requirement_revision v ON v.id = q.current_revision_id
   CROSS JOIN LATERAL jsonb_array_elements(v.parameters) op
   CROSS JOIN LATERAL jsonb_array_elements(p_parameters) np
   WHERE v.registry_id = p_registry AND v.status = 'confirmed' AND q.id IS DISTINCT FROM p_requirement
     AND requirement_param_key(op) = requirement_param_key(np)
     AND requirement_param_value(op) <> requirement_param_value(np)
     AND object_scopes_overlap(v.object_scope, p_scope)
$$;

ALTER TABLE requirement_revision ADD COLUMN conflict_note text CHECK (length(conflict_note) BETWEEN 1 AND 1000);

-- ---------------------------------------------------------------- Охранники 0019 с проверками R08-01

CREATE OR REPLACE FUNCTION requirement_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last requirement_revision%ROWTYPE;
  v_cand requirement_candidate%ROWTYPE;
  v_from requirement_revision%ROWTYPE;
  v_reg  requirement_registry%ROWTYPE;
  v_conflicted boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('requirement_revision'), hashtext(NEW.requirement_id::text));
  SELECT * INTO v_last FROM requirement_revision WHERE requirement_id = NEW.requirement_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_last.seq, 0) + 1 OR NEW.supersedes_revision_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'requirement_revision: новая ревизия встаёт за последней ревизией требования' USING ERRCODE = '40001';
  END IF;
  IF v_last.status = 'superseded' THEN
    RAISE EXCEPTION 'requirement_revision: заменённое требование не меняется' USING ERRCODE = '23514';
  END IF;
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'requirement_revision: ревизия пишется только в активный реестр этапа' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_reg FROM requirement_registry WHERE id = NEW.registry_id;
  NEW.content_sha256 := requirement_content_hash(NEW.statement, NEW.parameters, NEW.object_scope);
  IF NEW.change_kind = 'confirmation' THEN
    SELECT * INTO v_cand FROM requirement_candidate WHERE id = NEW.candidate_id;
    IF v_cand.status IS DISTINCT FROM 'confirmed' OR v_cand.registry_id <> NEW.registry_id OR v_cand.decided_by <> NEW.confirmed_by
       OR v_cand.created_by <> NEW.authored_by
       OR v_cand.target_requirement_id IS DISTINCT FROM (CASE WHEN NEW.seq = 1 THEN NULL ELSE NEW.requirement_id END) THEN
      RAISE EXCEPTION 'requirement_revision: подтверждение — по кандидату этого реестра в статусе confirmed (инвариант 2)' USING ERRCODE = '23514';
    END IF;
    IF v_last.id IS NOT NULL AND v_last.registry_id <> NEW.registry_id AND v_cand.carried_from_revision_id IS DISTINCT FROM v_last.id THEN
      RAISE EXCEPTION 'requirement_revision: требование прежнего реестра сначала переносится в активный' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'requirement.confirm') THEN
      RAISE EXCEPTION 'requirement_revision: подтверждает пользователь с requirement.confirm' USING ERRCODE = '42501';
    END IF;
    -- R08-01: противоречащее основание кандидата или другой параметр того же имени у действующего требования
    -- реестра (пересекающаяся область) — подтверждение только с пояснением; без конфликта пояснения нет.
    v_conflicted := EXISTS (SELECT 1 FROM evidence_link l WHERE l.requirement_candidate_id = NEW.candidate_id AND l.role = 'contradicts')
                 OR EXISTS (SELECT 1 FROM requirement_parameter_conflicts(NEW.registry_id, NEW.requirement_id, NEW.parameters, NEW.object_scope));
    IF v_conflicted AND NEW.conflict_note IS NULL THEN
      RAISE EXCEPTION 'requirement_revision: конфликт требований или противоречащее основание — подтверждение только с пояснением (R08-01)' USING ERRCODE = '23514';
    END IF;
    IF NOT v_conflicted AND NEW.conflict_note IS NOT NULL THEN
      RAISE EXCEPTION 'requirement_revision: пояснение к конфликту без конфликта' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.conflict_note IS NOT NULL THEN
    RAISE EXCEPTION 'requirement_revision: пояснение к конфликту — только при подтверждении' USING ERRCODE = '23514';
  END IF;
  IF NEW.change_kind = 'carry_over' THEN
    SELECT * INTO v_from FROM requirement_revision WHERE id = NEW.carried_from_revision_id;
    IF v_from.id IS DISTINCT FROM v_last.id OR v_last.registry_id IS DISTINCT FROM v_reg.previous_registry_id
       OR v_from.content_sha256 <> NEW.content_sha256 OR v_from.authored_by <> NEW.authored_by THEN
      RAISE EXCEPTION 'requirement_revision: перенос — без изменения последней ревизии из предыдущего реестра' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'requirement.manage') THEN
      RAISE EXCEPTION 'requirement_revision: перенос выполняет пользователь с requirement.manage' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.change_kind = 'supersede' THEN
    IF v_last.registry_id <> NEW.registry_id OR v_last.content_sha256 <> NEW.content_sha256 OR v_last.authored_by <> NEW.authored_by THEN
      RAISE EXCEPTION 'requirement_revision: замена не меняет содержание и выполняется в активном реестре' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM requirement q JOIN requirement_revision c ON c.id = q.current_revision_id
                    WHERE q.id = NEW.superseded_by_requirement_id AND c.status = 'confirmed' AND c.registry_id = NEW.registry_id) THEN
      RAISE EXCEPTION 'requirement_revision: заменяющее требование — действующее в активном реестре' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'requirement.manage') THEN
      RAISE EXCEPTION 'requirement_revision: заменяет пользователь с requirement.manage' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_coverage_object_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cov requirement_coverage%ROWTYPE;
BEGIN
  SELECT * INTO v_cov FROM requirement_coverage WHERE id = NEW.coverage_id;
  IF v_cov.created_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'requirement_coverage_object: объекты пишет только транзакция оценки' USING ERRCODE = '55000';
  END IF;
  -- R08-01: единицы считает БД — значения клиента не принимаются.
  NEW.requirement_units := NULL;
  NEW.calculation_unit := NULL;
  NEW.unit_status := NULL;
  IF NEW.object_type = 'calculation_revision' THEN
    SELECT u.requirement_units, u.calculation_unit, u.unit_status INTO NEW.requirement_units, NEW.calculation_unit, NEW.unit_status
      FROM coverage_unit_status(v_cov.requirement_revision_id, NEW.calculation_revision_id, NEW.external_position_id, NEW.external_item_id) u;
    IF NOT EXISTS (SELECT 1 FROM calculation_revision r WHERE r.id = NEW.calculation_revision_id AND r.stage_id = v_cov.stage_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: ревизия расчёта другого этапа' USING ERRCODE = '23514';
    END IF;
    IF NEW.external_position_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM calculation_revision r JOIN calculation_position p ON p.content_id = r.content_id
          WHERE r.id = NEW.calculation_revision_id AND p.external_position_id = NEW.external_position_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: позиции нет в содержимом ревизии расчёта' USING ERRCODE = '23514';
    END IF;
    IF NEW.external_item_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM calculation_revision r JOIN calculation_line l ON l.content_id = r.content_id
          WHERE r.id = NEW.calculation_revision_id AND l.external_item_id = NEW.external_item_id
            AND l.external_position_id = NEW.external_position_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: строки нет в этой позиции ревизии расчёта' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.object_type = 'decision' THEN
    IF NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.decision_type = 'requirement_decision' AND d.stage_id = v_cov.stage_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: решение — по требованию этого этапа' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.object_type = 'evidence_fragment' THEN
    IF NOT evidence_scope_has_fragment(
         (SELECT g.evidence_scope_id FROM requirement_revision v JOIN requirement_registry g ON g.id = v.registry_id WHERE v.id = v_cov.requirement_revision_id),
         NEW.fragment_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: фрагмент вне снимка реестра' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION requirement_coverage_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_n int;
  v_mismatch boolean;
BEGIN
  SELECT count(*) INTO v_n FROM requirement_coverage_object WHERE coverage_id = NEW.id;
  IF (NEW.state IN ('covered', 'partial')) <> (v_n > 0) THEN
    RAISE EXCEPTION 'requirement_coverage: состояние % несовместимо с числом объектов %', NEW.state, v_n USING ERRCODE = '23514';
  END IF;
  -- R08-01: покрытие с несовпадением единиц — только с явным пояснением; без несовпадения пояснения нет.
  v_mismatch := EXISTS (SELECT 1 FROM requirement_coverage_object o WHERE o.coverage_id = NEW.id AND o.unit_status = 'mismatch');
  IF v_mismatch AND NEW.unit_mismatch_reason IS NULL THEN
    RAISE EXCEPTION 'requirement_coverage: единица требования не совпадает с единицей расчёта — нужно пояснение (R08-01)' USING ERRCODE = '23514';
  END IF;
  IF NOT v_mismatch AND NEW.unit_mismatch_reason IS NOT NULL THEN
    RAISE EXCEPTION 'requirement_coverage: пояснение к несовпадению единиц без несовпадения' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
