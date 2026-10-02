-- Этап 09: проверки и договорные разногласия (D-029; проект — docs/architecture/09-review-checks-design.md §2, §9).
-- Прогон проверки закрепляет входы, версию правил и модели; программные проверки пишут исходы и замечания, модель —
-- только гипотезы. Замечание — изменяемый указатель с журналом событий; каждое изменение — событие того же автора в той же
-- транзакции. Разногласие — четыре независимые оси, значения которых — события человека с основаниями (I08, I09).
-- Инвалидация — по зависимостям; объекты не удаляются и не переписываются, изменившиеся основания отмечаются.

-- ---------------------------------------------------------------- Справочники

CREATE TABLE review_check (
  code             text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,59}$'),
  ordinal          int NOT NULL UNIQUE CHECK (ordinal > 0),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  method           text NOT NULL CHECK (method IN ('rule', 'model')),
  normative_source text NOT NULL CHECK (length(normative_source) BETWEEN 1 AND 200)
);
INSERT INTO review_check (code, ordinal, title, method, normative_source) VALUES
  ('processing', 1, 'Полнота обработки источников', 'rule', 'I18, A16'),
  ('registry', 2, 'Полнота реестра требований', 'rule', 'A44, I07'),
  ('coverage', 3, 'Покрытие требований расчётом', 'rule', 'A05, I07'),
  ('parameters', 4, 'Параметры требований в строках расчёта', 'rule', 'A01'),
  ('units', 5, 'Единицы требований и расчёта', 'rule', 'spec §7, R08-01'),
  ('quantities', 6, 'Количества, дубли и объёмы', 'rule', 'spec §7, D-029 В-09-6'),
  ('obligations', 7, 'Договорные обязательства', 'rule', 'A02'),
  ('pd_uncertainty', 8, 'Неопределённость ПД', 'rule', 'A06'),
  ('source_conflicts', 9, 'Конфликты источников', 'rule', 'A04, D-018, D-029 В-09-1'),
  ('customer_silence', 10, 'Молчание заказчика', 'rule', 'spec §7, D-029 В-09-4'),
  ('stale_basis', 11, 'Устаревшие основания', 'rule', 'A10, D-018'),
  ('model_hypotheses', 12, 'Гипотезы модели', 'model', 'ADR-009, I11, I12, D-029 В-09-5');
CREATE TRIGGER review_check_immutable BEFORE UPDATE OR DELETE ON review_check FOR EACH ROW EXECUTE FUNCTION forbid_mutation('reference');
CREATE TRIGGER review_check_no_truncate BEFORE TRUNCATE ON review_check FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('reference');

-- Вид замечания: проверка, критичность по умолчанию (D-029, таблица §11.1), допустимость принятия риска (В-09-3).
CREATE TABLE review_finding_kind (
  code             text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,59}$'),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  check_code       text REFERENCES review_check (code),
  default_severity text CHECK (default_severity IN ('major', 'minor')),
  risk_acceptable  boolean NOT NULL,
  normative_source text NOT NULL CHECK (length(normative_source) BETWEEN 1 AND 200)
);
INSERT INTO review_finding_kind (code, title, check_code, default_severity, risk_acceptable, normative_source) VALUES
  ('coverage_gap', 'Требование не покрыто расчётом', 'coverage', 'major', true, 'D-029 §11.1'),
  ('parameter_mismatch', 'Параметр требования не найден в строке расчёта', 'parameters', 'major', true, 'D-029 §11.1, A01'),
  ('unit_mismatch', 'Единица требования и расчёта не совпадает', 'units', 'major', true, 'D-029 §11.1'),
  ('quantity_mismatch', 'Количество требования не совпадает с объёмом', 'quantities', 'major', true, 'D-029 §11.1'),
  ('quantity_uncertain', 'Величины не сопоставимы', 'quantities', 'minor', true, 'D-029 §11.1, В-09-6'),
  ('duplicate_position', 'Дубль позиции расчёта', 'quantities', 'minor', true, 'D-029 §11.1'),
  ('contract_obligation', 'Обязательство договора не отражено в расчёте', 'obligations', 'major', true, 'D-029 §11.1, A02'),
  ('pd_uncertainty', 'Неопределённость ПД без допущения или вопроса', 'pd_uncertainty', 'minor', true, 'D-029 §11.1, A06'),
  ('source_conflict', 'Источники дают разные значения', 'source_conflicts', 'major', true, 'D-029 §11.1, A04'),
  ('customer_silence', 'Вопрос заказчику без ответа', 'customer_silence', 'minor', true, 'D-029 §11.1, В-09-4'),
  ('stale_basis', 'Основание перекрыто или устарело', 'stale_basis', 'major', false, 'D-029 §11.1, В-09-3'),
  ('registry_incomplete', 'Реестр требований не пройден полностью', 'registry', 'major', false, 'D-029 §11.1, В-09-3'),
  ('model_hypothesis', 'Гипотеза модели, принятая человеком', 'model_hypotheses', NULL, true, 'D-029 §11.1, I11'),
  ('human', 'Замечание человека', NULL, NULL, true, 'state-machines §10');
CREATE TRIGGER review_finding_kind_immutable BEFORE UPDATE OR DELETE ON review_finding_kind FOR EACH ROW EXECUTE FUNCTION forbid_mutation('reference');
CREATE TRIGGER review_finding_kind_no_truncate BEFORE TRUNCATE ON review_finding_kind FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('reference');

-- ---------------------------------------------------------------- Права (Р-08-8: таблица ролей повторяет core)

-- Этап 09: запуск проверки и ведение замечаний — участник тендера; принятие риска и приоритет источников — руководитель.
CREATE OR REPLACE FUNCTION tender_capabilities(p_user uuid, p_tender uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_admin boolean;
  v_role  text;
  v_caps  text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = p_user AND kind = 'human' AND status = 'active') THEN
    RETURN v_caps;
  END IF;
  v_admin := EXISTS (SELECT 1 FROM user_role WHERE user_id = p_user AND role = 'admin');
  SELECT m.member_role INTO v_role
    FROM tender_member m
   WHERE m.tender_id = p_tender AND m.user_id = p_user AND m.removed_at IS NULL
     AND EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = p_user AND r.role = m.member_role);
  IF v_role IS NOT NULL THEN
    v_caps := v_caps || ARRAY['tender.read', 'stage.write', 'source.write', 'calculation.capture',
                              'requirement.read', 'requirement.create', 'analysis.run', 'fact.read', 'fact.create',
                              'review.run', 'finding.write'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm',
                              'finding.accept_risk', 'source_priority.manage'];
  END IF;
  IF v_role = 'manager' OR v_admin THEN
    v_caps := v_caps || ARRAY['audit.read'];
  END IF;
  IF v_admin THEN
    v_caps := v_caps || ARRAY['admin.tender'];
  END IF;
  RETURN v_caps;
END;
$$;

-- Фрагмент входит в снимок области: его единица — единица снимка.
CREATE FUNCTION fragment_in_scope(p_fragment uuid, p_scope uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM evidence_fragment f JOIN evidence_scope_item i ON i.scope_id = p_scope
     WHERE f.id = p_fragment
       AND f.source_unit_id = coalesce(i.recognition_run_id, i.mail_message_revision_id, i.transcript_revision_id, i.qa_item_revision_id))
$$;

-- Фрагмент входит в какой-либо снимок области этапа.
CREATE FUNCTION fragment_in_stage(p_fragment uuid, p_stage uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM evidence_scope s WHERE s.stage_id = p_stage AND fragment_in_scope(p_fragment, s.id))
$$;

-- ---------------------------------------------------------------- Приоритет источников (D-029, В-09-1)

-- Упорядоченный список всех восьми видов источника; действует последняя ревизия тендера. Без ревизии — порядок по
-- умолчанию из кода. Приоритет только подсказывает: граф фактов и статусы он не меняет.
CREATE TABLE source_priority_revision (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id    uuid NOT NULL REFERENCES tender (id),
  seq          int NOT NULL CHECK (seq > 0),
  kinds        text[] NOT NULL,
  reason       text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_by   uuid NOT NULL REFERENCES app_user (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_xact xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT source_priority_revision_seq_key UNIQUE (tender_id, seq),
  CONSTRAINT source_priority_revision_kinds_shape CHECK (
    cardinality(kinds) = 8 AND kinds @> ARRAY['contract', 'tz', 'qa_answer', 'customer_letter', 'pd_rd', 'minutes', 'negotiation_speech', 'other'])
);
CREATE FUNCTION source_priority_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ('source_priority.manage' = ANY (tender_capabilities(NEW.created_by, NEW.tender_id))) THEN
    RAISE EXCEPTION 'source_priority_revision: приоритет меняет руководитель тендера' USING ERRCODE = '42501';
  END IF;
  IF NEW.seq <> (SELECT coalesce(max(seq), 0) + 1 FROM source_priority_revision WHERE tender_id = NEW.tender_id) THEN
    RAISE EXCEPTION 'source_priority_revision: номер ревизии — следующий по тендеру' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_priority_revision_guard BEFORE INSERT ON source_priority_revision FOR EACH ROW EXECUTE FUNCTION source_priority_revision_guard();
CREATE TRIGGER source_priority_revision_immutable BEFORE UPDATE OR DELETE ON source_priority_revision FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER source_priority_revision_no_truncate BEFORE TRUNCATE ON source_priority_revision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Прогон проверки

CREATE TABLE review_run (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id               uuid NOT NULL REFERENCES tender (id),
  stage_id                uuid NOT NULL REFERENCES tender_stage (id),
  evidence_scope_id       uuid NOT NULL REFERENCES evidence_scope (id),
  registry_id             uuid REFERENCES requirement_registry (id),
  calculation_revision_id uuid REFERENCES calculation_revision (id),
  priority_revision_id    uuid REFERENCES source_priority_revision (id),
  priority_kinds          text[] NOT NULL CHECK (cardinality(priority_kinds) = 8),
  -- Версия входов этапа при запуске и при фиксации снимка: прогон устарел, если входы этапа новее.
  stage_input_version     bigint NOT NULL CHECK (stage_input_version >= 0),
  scope_input_version     bigint NOT NULL CHECK (scope_input_version >= 0),
  rules_version           text NOT NULL CHECK (length(rules_version) BETWEEN 1 AND 60),
  rules_sha256            text NOT NULL CHECK (rules_sha256 ~ '^[0-9a-f]{64}$'),
  -- Модель гипотез: все поля или ни одного (модель не настроена — проверка гипотез неполная, D-029 В-09-5).
  model_provider          text CHECK (length(model_provider) BETWEEN 1 AND 60),
  model_id                text CHECK (length(model_id) BETWEEN 1 AND 200),
  model_version           text CHECK (length(model_version) BETWEEN 1 AND 200),
  prompt_version          text CHECK (length(prompt_version) BETWEEN 1 AND 60),
  prompt_sha256           text CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  status                  text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'completed_with_gaps', 'failed')),
  coverage                jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(coverage) = 'object'),
  failure_code            text CHECK (length(failure_code) BETWEEN 1 AND 60),
  requested_by            uuid NOT NULL REFERENCES app_user (id),
  job_id                  uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  started_at              timestamptz,
  finished_at             timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  row_version             bigint NOT NULL DEFAULT 1,
  created_xact            xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT review_run_id_stage_key UNIQUE (id, stage_id),
  CONSTRAINT review_run_model_shape CHECK (num_nulls(model_provider, model_id, model_version, prompt_version, prompt_sha256) IN (0, 5)),
  CONSTRAINT review_run_finished_shape CHECK ((status IN ('completed', 'completed_with_gaps', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT review_run_failure_shape CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX review_run_stage_idx ON review_run (stage_id, created_at DESC);

-- Входы — этого этапа и закреплены при запуске; автор — участник с review.run.
CREATE FUNCTION review_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage tender_stage%ROWTYPE;
BEGIN
  SELECT * INTO v_stage FROM tender_stage WHERE id = NEW.stage_id;
  IF v_stage.tender_id IS DISTINCT FROM NEW.tender_id THEN
    RAISE EXCEPTION 'review_run: этап — этап тендера прогона' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.requested_by, NEW.stage_id, 'review.run') THEN
    RAISE EXCEPTION 'review_run: проверку запускает участник тендера с review.run' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'review_run: прогон создаётся в очереди' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM evidence_scope s WHERE s.id = NEW.evidence_scope_id AND s.stage_id = NEW.stage_id AND s.input_version = NEW.scope_input_version) THEN
    RAISE EXCEPTION 'review_run: снимок области — снимок этого этапа' USING ERRCODE = '23514';
  END IF;
  IF NEW.stage_input_version <> v_stage.input_version THEN
    RAISE EXCEPTION 'review_run: версия входов — текущая версия этапа' USING ERRCODE = '23514';
  END IF;
  IF NEW.registry_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM requirement_registry g WHERE g.id = NEW.registry_id AND g.stage_id = NEW.stage_id AND g.evidence_scope_id = NEW.evidence_scope_id) THEN
    RAISE EXCEPTION 'review_run: реестр — реестр этапа на снимке прогона' USING ERRCODE = '23514';
  END IF;
  IF NEW.calculation_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM calculation_revision c WHERE c.id = NEW.calculation_revision_id AND c.stage_id = NEW.stage_id) THEN
    RAISE EXCEPTION 'review_run: ревизия расчёта — ревизия этого этапа' USING ERRCODE = '23514';
  END IF;
  IF NEW.priority_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM source_priority_revision p WHERE p.id = NEW.priority_revision_id AND p.tender_id = NEW.tender_id AND p.kinds = NEW.priority_kinds) THEN
    RAISE EXCEPTION 'review_run: приоритет — ревизия этого тендера' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_run_insert_guard BEFORE INSERT ON review_run FOR EACH ROW EXECUTE FUNCTION review_run_insert_guard();

-- Входы неизменны; переходы queued → running | failed, running → completed | completed_with_gaps | failed; финал неизменен.
CREATE FUNCTION review_run_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'completed_with_gaps', 'failed') THEN
    RAISE EXCEPTION 'review_run: завершённый прогон неизменен' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.evidence_scope_id, NEW.registry_id, NEW.calculation_revision_id, NEW.priority_revision_id,
      NEW.priority_kinds, NEW.stage_input_version, NEW.scope_input_version, NEW.rules_version, NEW.rules_sha256, NEW.model_provider,
      NEW.model_id, NEW.model_version, NEW.prompt_version, NEW.prompt_sha256, NEW.requested_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.evidence_scope_id, OLD.registry_id, OLD.calculation_revision_id, OLD.priority_revision_id,
      OLD.priority_kinds, OLD.stage_input_version, OLD.scope_input_version, OLD.rules_version, OLD.rules_sha256, OLD.model_provider,
      OLD.model_id, OLD.model_version, OLD.prompt_version, OLD.prompt_sha256, OLD.requested_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'review_run: закреплённые входы прогона неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
    OR (OLD.status = 'running' AND NEW.status IN ('completed', 'completed_with_gaps', 'failed'))) THEN
    RAISE EXCEPTION 'review_run: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_run_update_guard BEFORE UPDATE ON review_run FOR EACH ROW EXECUTE FUNCTION review_run_update_guard();
CREATE TRIGGER review_run_no_delete BEFORE DELETE ON review_run FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER review_run_no_truncate BEFORE TRUNCATE ON review_run FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- ---------------------------------------------------------------- Исходы проверок

CREATE TABLE review_check_result (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES review_run (id),
  check_code   text NOT NULL REFERENCES review_check (code),
  outcome      text NOT NULL CHECK (outcome IN ('passed', 'failed', 'not_applicable', 'incomplete', 'error')),
  reason       text CHECK (length(reason) BETWEEN 1 AND 2000),
  counts       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_xact xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT review_check_result_key UNIQUE (run_id, check_code),
  -- Пробел охвата всегда с причиной: «неполно» без объяснения не допускается (I18).
  CONSTRAINT review_check_result_reason_shape CHECK (outcome NOT IN ('incomplete', 'error') OR reason IS NOT NULL)
);
CREATE FUNCTION review_check_result_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM review_run r WHERE r.id = NEW.run_id AND r.status = 'running') THEN
    RAISE EXCEPTION 'review_check_result: исход пишет выполняющийся прогон' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_check_result_guard BEFORE INSERT ON review_check_result FOR EACH ROW EXECUTE FUNCTION review_check_result_guard();
CREATE TRIGGER review_check_result_immutable BEFORE UPDATE OR DELETE ON review_check_result FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER review_check_result_no_truncate BEFORE TRUNCATE ON review_check_result FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Итог прогона определяется исходами (I07, I18): завершён — все проверки есть; «завершён полностью» — ни одной неполной
-- или ошибочной; «с пробелами» — хотя бы одна. Проверяется в конце транзакции перевода.
CREATE FUNCTION review_run_final_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_total  int;
  v_gaps   int;
BEGIN
  SELECT status INTO v_status FROM review_run WHERE id = NEW.id;
  IF v_status NOT IN ('completed', 'completed_with_gaps') THEN
    RETURN NULL;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE outcome IN ('incomplete', 'error')) INTO v_total, v_gaps FROM review_check_result WHERE run_id = NEW.id;
  IF v_total <> (SELECT count(*) FROM review_check) THEN
    RAISE EXCEPTION 'review_run: завершённый прогон содержит исходы всех проверок' USING ERRCODE = '23514';
  END IF;
  IF (v_status = 'completed') <> (v_gaps = 0) THEN
    RAISE EXCEPTION 'review_run: «завершён» — только без неполных и ошибочных проверок, иначе «с пробелами»' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER review_run_final_check AFTER UPDATE ON review_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION review_run_final_check();

-- ---------------------------------------------------------------- Замечание

CREATE TABLE finding (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id             uuid NOT NULL REFERENCES tender (id),
  stage_id              uuid NOT NULL REFERENCES tender_stage (id),
  finding_key           text NOT NULL CHECK (finding_key ~ '^[0-9a-f]{64}$'),
  kind                  text NOT NULL REFERENCES review_finding_kind (code),
  check_code            text REFERENCES review_check (code),
  origin                text NOT NULL CHECK (origin IN ('rule', 'model_suggestion', 'human')),
  title                 text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  detail                text CHECK (length(detail) BETWEEN 1 AND 4000),
  severity              text NOT NULL CHECK (severity IN ('critical', 'major', 'minor')),
  confidence            text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'accepted_risk', 'rejected', 'stale')),
  owner_user_id         uuid REFERENCES app_user (id),
  action                text CHECK (length(action) BETWEEN 1 AND 1000),
  impact                text CHECK (length(impact) BETWEEN 1 AND 1000),
  suggested_side        text CHECK (suggested_side IN ('left', 'right')),
  first_run_id          uuid REFERENCES review_run (id),
  suggestion_id         uuid,
  created_by            uuid REFERENCES app_user (id),
  created_input_version bigint NOT NULL CHECK (created_input_version >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           bigint NOT NULL DEFAULT 1,
  created_xact          xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT finding_origin_shape CHECK (CASE origin
    WHEN 'rule' THEN first_run_id IS NOT NULL AND created_by IS NULL AND suggestion_id IS NULL AND check_code IS NOT NULL
    WHEN 'model_suggestion' THEN suggestion_id IS NOT NULL AND created_by IS NOT NULL AND first_run_id IS NOT NULL AND kind = 'model_hypothesis'
    ELSE created_by IS NOT NULL AND first_run_id IS NULL AND suggestion_id IS NULL END)
);
-- Одно действующее замечание на условие этапа: устаревшее остаётся в истории, новое условие — новое замечание.
CREATE UNIQUE INDEX finding_live_key ON finding (stage_id, finding_key) WHERE status <> 'stale';
CREATE INDEX finding_stage_idx ON finding (stage_id, status);

CREATE FUNCTION finding_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind review_finding_kind%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tender_stage s WHERE s.id = NEW.stage_id AND s.tender_id = NEW.tender_id) THEN
    RAISE EXCEPTION 'finding: этап — этап тендера замечания' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'open' THEN
    RAISE EXCEPTION 'finding: замечание создаётся открытым' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_kind FROM review_finding_kind WHERE code = NEW.kind;
  IF NEW.origin = 'rule' THEN
    IF NOT EXISTS (SELECT 1 FROM review_run r WHERE r.id = NEW.first_run_id AND r.stage_id = NEW.stage_id AND r.status = 'running') THEN
      RAISE EXCEPTION 'finding: замечание правила пишет выполняющийся прогон этапа' USING ERRCODE = '23514';
    END IF;
    -- Правило ставит критичность по таблице владельца; «критичное» — только человек (D-029 В-09-7).
    IF v_kind.check_code IS DISTINCT FROM NEW.check_code OR v_kind.default_severity IS DISTINCT FROM NEW.severity THEN
      RAISE EXCEPTION 'finding: вид, проверка и критичность правила — по справочнику' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT has_stage_capability(NEW.created_by, NEW.stage_id, 'finding.write') THEN
      RAISE EXCEPTION 'finding: замечание создаёт участник тендера с finding.write' USING ERRCODE = '42501';
    END IF;
    IF NEW.origin = 'model_suggestion' AND NOT EXISTS (
         SELECT 1 FROM model_suggestion m WHERE m.id = NEW.suggestion_id AND m.stage_id = NEW.stage_id AND m.run_id = NEW.first_run_id) THEN
      RAISE EXCEPTION 'finding: гипотеза — гипотеза прогона этого этапа' USING ERRCODE = '23514';
    END IF;
    IF NEW.origin = 'human' AND NEW.kind = 'model_hypothesis' THEN
      RAISE EXCEPTION 'finding: вид гипотезы модели — только из принятой гипотезы' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.created_input_version > (SELECT input_version FROM tender_stage WHERE id = NEW.stage_id) THEN
    RAISE EXCEPTION 'finding: версия оснований не новее входов этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finding_insert_guard BEFORE INSERT ON finding FOR EACH ROW EXECUTE FUNCTION finding_insert_guard();

-- Содержание неизменно; меняются статус (по машине состояний §10), критичность, уверенность, ответственный, действие, влияние.
CREATE FUNCTION finding_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.finding_key, NEW.kind, NEW.check_code, NEW.origin, NEW.title, NEW.detail, NEW.suggested_side,
      NEW.first_run_id, NEW.suggestion_id, NEW.created_by, NEW.created_input_version, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.finding_key, OLD.kind, OLD.check_code, OLD.origin, OLD.title, OLD.detail, OLD.suggested_side,
      OLD.first_run_id, OLD.suggestion_id, OLD.created_by, OLD.created_input_version, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'finding: содержание замечания неизменно' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('in_progress', 'resolved', 'accepted_risk', 'rejected', 'stale'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('resolved', 'accepted_risk', 'rejected', 'stale'))
    OR (OLD.status IN ('resolved', 'accepted_risk', 'rejected') AND NEW.status = 'stale')
    OR (OLD.status = 'stale' AND NEW.status = 'open')) THEN
    RAISE EXCEPTION 'finding: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'in_progress' AND NEW.owner_user_id IS NULL THEN
    RAISE EXCEPTION 'finding: в работу — с ответственным' USING ERRCODE = '23514';
  END IF;
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id AND NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM tender_member m WHERE m.tender_id = NEW.tender_id AND m.user_id = NEW.owner_user_id AND m.removed_at IS NULL) THEN
    RAISE EXCEPTION 'finding: ответственный — участник тендера' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finding_update_guard BEFORE UPDATE ON finding FOR EACH ROW EXECUTE FUNCTION finding_update_guard();
CREATE TRIGGER finding_no_delete BEFORE DELETE ON finding FOR EACH ROW EXECUTE FUNCTION forbid_mutation('pointer');
CREATE TRIGGER finding_no_truncate BEFORE TRUNCATE ON finding FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('pointer');

-- ---------------------------------------------------------------- Решения этапа 09

ALTER TABLE decision DROP CONSTRAINT decision_decision_type_check;
ALTER TABLE decision
  ADD CONSTRAINT decision_decision_type_check CHECK (decision_type IN (
    'import_item_disposition', 'requirement_decision', 'finding_resolution', 'finding_risk_acceptance', 'discrepancy_decision')),
  ADD CONSTRAINT decision_review_shape CHECK (
    decision_type NOT IN ('finding_resolution', 'finding_risk_acceptance', 'discrepancy_decision')
    OR (stage_id IS NOT NULL AND basis_fragment_ids = '{}'
        AND subject_type = CASE decision_type WHEN 'discrepancy_decision' THEN 'discrepancy' ELSE 'finding' END));

-- Решения по замечанию и разногласию — человек с правом этапа; принятие риска — руководитель с finding.accept_risk и
-- только для вида, допускающего риск (D-029 В-09-3); замена — того же вида и предмета.
CREATE OR REPLACE FUNCTION decision_author_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cap text;
BEGIN
  IF NEW.decision_type IN ('requirement_decision', 'finding_resolution', 'finding_risk_acceptance', 'discrepancy_decision') THEN
    IF NOT EXISTS (SELECT 1 FROM tender_stage s WHERE s.id = NEW.stage_id AND s.tender_id = NEW.tender_id) THEN
      RAISE EXCEPTION 'decision: этап решения — этап тендера решения' USING ERRCODE = '23514';
    END IF;
    v_cap := CASE NEW.decision_type
               WHEN 'requirement_decision' THEN 'requirement.decide'
               WHEN 'finding_resolution' THEN 'finding.write'
               WHEN 'finding_risk_acceptance' THEN 'finding.accept_risk'
               ELSE 'requirement.decide' END;
    IF NOT has_stage_capability(NEW.decided_by, NEW.stage_id, v_cap) THEN
      RAISE EXCEPTION 'решение % принимает пользователь с %', NEW.decision_type, v_cap USING ERRCODE = '42501';
    END IF;
    IF NEW.decision_type = 'requirement_decision' AND NOT EXISTS (SELECT 1 FROM requirement r WHERE r.id = NEW.subject_id AND r.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'decision: предмет решения — требование этого этапа' USING ERRCODE = '23514';
    END IF;
    IF NEW.decision_type IN ('finding_resolution', 'finding_risk_acceptance')
       AND NOT EXISTS (SELECT 1 FROM finding f WHERE f.id = NEW.subject_id AND f.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'decision: предмет решения — замечание этого этапа' USING ERRCODE = '23514';
    END IF;
    IF NEW.decision_type = 'finding_risk_acceptance' AND NOT EXISTS (
         SELECT 1 FROM finding f JOIN review_finding_kind k ON k.code = f.kind WHERE f.id = NEW.subject_id AND k.risk_acceptable) THEN
      RAISE EXCEPTION 'decision: технические замечания риском не принимаются' USING ERRCODE = '23514';
    END IF;
    IF NEW.decision_type = 'discrepancy_decision' AND NOT EXISTS (SELECT 1 FROM discrepancy d WHERE d.id = NEW.subject_id AND d.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'decision: предмет решения — разногласие этого этапа' USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes_decision_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM decision d WHERE d.id = NEW.supersedes_decision_id AND d.decision_type = NEW.decision_type
                                    AND d.subject_id = NEW.subject_id AND d.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'decision: заменяется решение того же вида и предмета' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_user u
      JOIN user_role r ON r.user_id = u.id AND r.role = 'manager'
      JOIN tender_member m ON m.user_id = u.id AND m.tender_id = NEW.tender_id AND m.member_role = 'manager' AND m.removed_at IS NULL
     WHERE u.id = NEW.decided_by AND u.kind = 'human' AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION 'решение % может принять только руководитель тендера', NEW.decision_type USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Журнал замечания

CREATE TABLE finding_event (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id           uuid NOT NULL REFERENCES finding (id),
  tender_id            uuid NOT NULL REFERENCES tender (id),
  seq                  int NOT NULL CHECK (seq > 0),
  event_kind           text NOT NULL CHECK (event_kind IN ('created', 'status', 'severity', 'confidence', 'owner', 'action', 'impact')),
  from_value           text CHECK (length(from_value) <= 1000),
  to_value             text CHECK (length(to_value) <= 1000),
  reason               text CHECK (length(reason) BETWEEN 1 AND 2000),
  actor_kind           text NOT NULL CHECK (actor_kind IN ('human', 'system')),
  actor_user_id        uuid REFERENCES app_user (id),
  decision_id          uuid REFERENCES decision (id),
  stage_input_event_id uuid REFERENCES stage_input_event (id),
  run_id               uuid REFERENCES review_run (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_xact         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT finding_event_seq_key UNIQUE (finding_id, seq),
  CONSTRAINT finding_event_actor_shape CHECK ((actor_kind = 'human') = (actor_user_id IS NOT NULL))
);
CREATE INDEX finding_event_finding_idx ON finding_event (finding_id, seq);

-- Вторая линия ADR-006 и I12: человек — с finding.write; решено — с решением по замечанию; принять риск — с решением
-- руководителя; отклонить — с причиной; система только создаёт замечание правила и ставит «устарело» по событию барьера.
CREATE FUNCTION finding_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_f finding%ROWTYPE;
BEGIN
  SELECT * INTO v_f FROM finding WHERE id = NEW.finding_id;
  IF v_f.tender_id IS DISTINCT FROM NEW.tender_id THEN
    RAISE EXCEPTION 'finding_event: тендер события — тендер замечания' USING ERRCODE = '23514';
  END IF;
  IF NEW.seq <> (SELECT coalesce(max(seq), 0) + 1 FROM finding_event WHERE finding_id = NEW.finding_id) THEN
    RAISE EXCEPTION 'finding_event: номер события — следующий' USING ERRCODE = '23514';
  END IF;
  IF NEW.actor_kind = 'human' THEN
    IF NOT has_stage_capability(NEW.actor_user_id, v_f.stage_id, 'finding.write') THEN
      RAISE EXCEPTION 'finding_event: замечания ведёт участник тендера с finding.write' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT ((NEW.event_kind = 'created' AND v_f.origin = 'rule' AND NEW.run_id IS NOT NULL)
          OR (NEW.event_kind = 'status' AND NEW.to_value = 'stale' AND NEW.stage_input_event_id IS NOT NULL AND NEW.reason IS NOT NULL)) THEN
    RAISE EXCEPTION 'finding_event: система только создаёт замечание правила и отмечает устаревание' USING ERRCODE = '42501';
  END IF;
  IF NEW.event_kind = 'status' THEN
    IF NEW.to_value = 'resolved' AND NOT EXISTS (
         SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.decision_type = 'finding_resolution' AND d.subject_id = NEW.finding_id) THEN
      RAISE EXCEPTION 'finding_event: «решено» — с решением по замечанию' USING ERRCODE = '23514';
    END IF;
    IF NEW.to_value = 'accepted_risk' AND NOT EXISTS (
         SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.decision_type = 'finding_risk_acceptance' AND d.subject_id = NEW.finding_id
                                    AND d.decided_by = NEW.actor_user_id) THEN
      RAISE EXCEPTION 'finding_event: принятие риска — с решением руководителя' USING ERRCODE = '23514';
    END IF;
    IF NEW.to_value IN ('rejected', 'stale', 'accepted_risk') AND NEW.reason IS NULL THEN
      RAISE EXCEPTION 'finding_event: переход требует причины' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finding_event_guard BEFORE INSERT ON finding_event FOR EACH ROW EXECUTE FUNCTION finding_event_guard();
CREATE TRIGGER finding_event_immutable BEFORE UPDATE OR DELETE ON finding_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER finding_event_no_truncate BEFORE TRUNCATE ON finding_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- Каждое изменение замечания записано событием той же транзакции с тем же новым значением (проверка в конце транзакции).
CREATE FUNCTION finding_change_logged() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_new finding%ROWTYPE;
BEGIN
  SELECT * INTO v_new FROM finding WHERE id = NEW.id;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM finding_event e WHERE e.finding_id = NEW.id AND e.event_kind = 'created' AND e.created_xact = pg_current_xact_id()) THEN
      RAISE EXCEPTION 'finding: создание записано событием' USING ERRCODE = '23514';
    END IF;
    IF v_new.kind = 'source_conflict' AND NOT (
         EXISTS (SELECT 1 FROM finding_evidence x WHERE x.finding_id = NEW.id AND x.side = 'left')
     AND EXISTS (SELECT 1 FROM finding_evidence x WHERE x.finding_id = NEW.id AND x.side = 'right')) THEN
      RAISE EXCEPTION 'finding: у конфликта источников — обе стороны' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF v_new.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
       SELECT 1 FROM finding_event e WHERE e.finding_id = NEW.id AND e.event_kind = 'status' AND e.to_value = v_new.status AND e.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'finding: смена статуса записана событием' USING ERRCODE = '23514';
  END IF;
  IF v_new.severity IS DISTINCT FROM OLD.severity AND NOT EXISTS (
       SELECT 1 FROM finding_event e WHERE e.finding_id = NEW.id AND e.event_kind = 'severity' AND e.to_value = v_new.severity AND e.actor_kind = 'human'
                                     AND e.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'finding: критичность меняет человек событием' USING ERRCODE = '23514';
  END IF;
  IF v_new.confidence IS DISTINCT FROM OLD.confidence AND NOT EXISTS (
       SELECT 1 FROM finding_event e WHERE e.finding_id = NEW.id AND e.event_kind = 'confidence' AND e.to_value = v_new.confidence AND e.actor_kind = 'human'
                                     AND e.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'finding: уверенность меняет человек событием' USING ERRCODE = '23514';
  END IF;
  IF v_new.owner_user_id IS DISTINCT FROM OLD.owner_user_id AND NOT EXISTS (
       SELECT 1 FROM finding_event e WHERE e.finding_id = NEW.id AND e.event_kind = 'owner' AND e.to_value IS NOT DISTINCT FROM v_new.owner_user_id::text
                                     AND e.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'finding: ответственный меняется событием' USING ERRCODE = '23514';
  END IF;
  IF v_new.action IS DISTINCT FROM OLD.action AND NOT EXISTS (
       SELECT 1 FROM finding_event e WHERE e.finding_id = NEW.id AND e.event_kind = 'action' AND e.to_value IS NOT DISTINCT FROM v_new.action
                                     AND e.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'finding: действие меняется событием' USING ERRCODE = '23514';
  END IF;
  IF v_new.impact IS DISTINCT FROM OLD.impact AND NOT EXISTS (
       SELECT 1 FROM finding_event e WHERE e.finding_id = NEW.id AND e.event_kind = 'impact' AND e.to_value IS NOT DISTINCT FROM v_new.impact
                                     AND e.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'finding: влияние меняется событием' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finding_change_logged AFTER INSERT OR UPDATE ON finding
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finding_change_logged();

-- ---------------------------------------------------------------- Основания замечания

CREATE TABLE finding_evidence (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id              uuid NOT NULL REFERENCES finding (id),
  tender_id               uuid NOT NULL REFERENCES tender (id),
  side                    text NOT NULL CHECK (side IN ('left', 'right', 'context')),
  object_type             text NOT NULL CHECK (object_type IN ('fragment', 'calculation_object', 'requirement_revision', 'evidence_fact',
                                                               'customer_question', 'qa_item_revision', 'assumption', 'document_revision')),
  fragment_id             uuid REFERENCES evidence_fragment (id),
  calculation_revision_id uuid REFERENCES calculation_revision (id),
  external_position_id    uuid,
  external_item_id        uuid,
  requirement_revision_id uuid REFERENCES requirement_revision (id),
  evidence_fact_id        uuid REFERENCES evidence_fact (id),
  customer_question_id    uuid REFERENCES customer_question (id),
  qa_item_revision_id     uuid REFERENCES qa_item_revision (id),
  assumption_id           uuid REFERENCES assumption (id),
  document_revision_id    uuid REFERENCES document_revision (id),
  note                    text CHECK (length(note) BETWEEN 1 AND 1000),
  created_xact            xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT finding_evidence_shape CHECK (CASE object_type
    WHEN 'fragment' THEN num_nonnulls(fragment_id) = 1 AND num_nonnulls(calculation_revision_id, external_position_id, external_item_id, requirement_revision_id,
                                                                          evidence_fact_id, customer_question_id, qa_item_revision_id, assumption_id, document_revision_id) = 0
    WHEN 'calculation_object' THEN calculation_revision_id IS NOT NULL AND external_position_id IS NOT NULL
                                  AND num_nonnulls(fragment_id, requirement_revision_id, evidence_fact_id, customer_question_id, qa_item_revision_id, assumption_id, document_revision_id) = 0
    WHEN 'requirement_revision' THEN num_nonnulls(requirement_revision_id) = 1 AND num_nonnulls(fragment_id, calculation_revision_id, external_position_id, external_item_id,
                                                                                                evidence_fact_id, customer_question_id, qa_item_revision_id, assumption_id, document_revision_id) = 0
    WHEN 'evidence_fact' THEN num_nonnulls(evidence_fact_id) = 1 AND num_nonnulls(fragment_id, calculation_revision_id, external_position_id, external_item_id,
                                                                                  requirement_revision_id, customer_question_id, qa_item_revision_id, assumption_id, document_revision_id) = 0
    WHEN 'customer_question' THEN num_nonnulls(customer_question_id) = 1 AND num_nonnulls(fragment_id, calculation_revision_id, external_position_id, external_item_id,
                                                                                          requirement_revision_id, evidence_fact_id, qa_item_revision_id, assumption_id, document_revision_id) = 0
    WHEN 'qa_item_revision' THEN num_nonnulls(qa_item_revision_id) = 1 AND num_nonnulls(fragment_id, calculation_revision_id, external_position_id, external_item_id,
                                                                                        requirement_revision_id, evidence_fact_id, customer_question_id, assumption_id, document_revision_id) = 0
    WHEN 'assumption' THEN num_nonnulls(assumption_id) = 1 AND num_nonnulls(fragment_id, calculation_revision_id, external_position_id, external_item_id,
                                                                            requirement_revision_id, evidence_fact_id, customer_question_id, qa_item_revision_id, document_revision_id) = 0
    ELSE num_nonnulls(document_revision_id) = 1 AND num_nonnulls(fragment_id, calculation_revision_id, external_position_id, external_item_id,
                                                                 requirement_revision_id, evidence_fact_id, customer_question_id, qa_item_revision_id, assumption_id) = 0 END)
);
CREATE INDEX finding_evidence_finding_idx ON finding_evidence (finding_id);

-- Основания пишутся вместе с замечанием и принадлежат его этапу или тендеру: фрагмент — из снимка этапа, объект расчёта —
-- ревизия этапа, требование, вопрос и допущение — этого этапа, факт — тендера или связанного договора.
CREATE FUNCTION finding_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_f finding%ROWTYPE;
BEGIN
  SELECT * INTO v_f FROM finding WHERE id = NEW.finding_id;
  IF v_f.created_xact IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'finding_evidence: основания пишутся вместе с замечанием' USING ERRCODE = '55000';
  END IF;
  IF v_f.tender_id IS DISTINCT FROM NEW.tender_id THEN
    RAISE EXCEPTION 'finding_evidence: тендер основания — тендер замечания' USING ERRCODE = '23514';
  END IF;
  IF (NEW.fragment_id IS NOT NULL AND NOT fragment_in_stage(NEW.fragment_id, v_f.stage_id))
     OR (NEW.calculation_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calculation_revision c WHERE c.id = NEW.calculation_revision_id AND c.stage_id = v_f.stage_id))
     OR (NEW.requirement_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM requirement_revision v WHERE v.id = NEW.requirement_revision_id AND v.stage_id = v_f.stage_id))
     OR (NEW.customer_question_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_question q WHERE q.id = NEW.customer_question_id AND q.stage_id = v_f.stage_id))
     OR (NEW.assumption_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assumption a WHERE a.id = NEW.assumption_id AND a.stage_id = v_f.stage_id))
     OR (NEW.qa_item_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM qa_item_revision r WHERE r.id = NEW.qa_item_revision_id AND r.tender_id = v_f.tender_id))
     OR (NEW.evidence_fact_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM evidence_fact_owner(NEW.evidence_fact_id) o
            WHERE o.tender_id = v_f.tender_id
               OR EXISTS (SELECT 1 FROM contract_tender ct WHERE ct.contract_id = o.contract_id AND ct.tender_id = v_f.tender_id)))
     OR (NEW.document_revision_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM document_revision r
            WHERE r.id = NEW.document_revision_id
              AND (r.tender_id = v_f.tender_id OR EXISTS (SELECT 1 FROM contract_tender ct WHERE ct.contract_id = r.contract_id AND ct.tender_id = v_f.tender_id)))) THEN
    RAISE EXCEPTION 'finding_evidence: основание вне этапа или тендера замечания' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finding_evidence_guard BEFORE INSERT ON finding_evidence FOR EACH ROW EXECUTE FUNCTION finding_evidence_guard();
CREATE TRIGGER finding_evidence_immutable BEFORE UPDATE OR DELETE ON finding_evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER finding_evidence_no_truncate BEFORE TRUNCATE ON finding_evidence FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Вхождение: прогон обнаружил условие замечания (история между прогонами; дубля замечания нет).
CREATE TABLE finding_occurrence (
  run_id       uuid NOT NULL REFERENCES review_run (id),
  finding_id   uuid NOT NULL REFERENCES finding (id),
  created_xact xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (run_id, finding_id)
);
CREATE INDEX finding_occurrence_finding_idx ON finding_occurrence (finding_id);
CREATE FUNCTION finding_occurrence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM review_run r JOIN finding f ON f.stage_id = r.stage_id WHERE r.id = NEW.run_id AND f.id = NEW.finding_id AND r.status = 'running') THEN
    RAISE EXCEPTION 'finding_occurrence: вхождение пишет выполняющийся прогон этапа замечания' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finding_occurrence_guard BEFORE INSERT ON finding_occurrence FOR EACH ROW EXECUTE FUNCTION finding_occurrence_guard();
CREATE TRIGGER finding_occurrence_immutable BEFORE UPDATE OR DELETE ON finding_occurrence FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER finding_occurrence_no_truncate BEFORE TRUNCATE ON finding_occurrence FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Гипотезы модели (I11, I12)

CREATE TABLE model_suggestion (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id       uuid NOT NULL REFERENCES tender (id),
  stage_id        uuid NOT NULL REFERENCES tender_stage (id),
  run_id          uuid NOT NULL REFERENCES review_run (id),
  request_id      text NOT NULL CHECK (request_id ~ '^[0-9a-f]{64}$'),
  kind            text NOT NULL CHECK (kind IN ('discrepancy_hypothesis')),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  rationale       text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 4000),
  payload         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'expired')),
  decided_by      uuid REFERENCES app_user (id),
  decided_at      timestamptz,
  decision_reason text CHECK (length(decision_reason) BETWEEN 1 AND 2000),
  finding_id      uuid REFERENCES finding (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     bigint NOT NULL DEFAULT 1,
  created_xact    xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT model_suggestion_request_key UNIQUE (run_id, request_id),
  CONSTRAINT model_suggestion_decided_shape CHECK ((status IN ('accepted', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT model_suggestion_finding_shape CHECK ((status = 'accepted') = (finding_id IS NOT NULL))
);
ALTER TABLE finding ADD CONSTRAINT finding_suggestion_fk FOREIGN KEY (suggestion_id) REFERENCES model_suggestion (id);
CREATE INDEX model_suggestion_run_idx ON model_suggestion (run_id);

CREATE FUNCTION model_suggestion_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM review_run r WHERE r.id = NEW.run_id AND r.stage_id = NEW.stage_id AND r.tender_id = NEW.tender_id
                                                AND r.status = 'running' AND r.model_provider IS NOT NULL) THEN
      RAISE EXCEPTION 'model_suggestion: гипотезу пишет выполняющийся прогон с моделью' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'model_suggestion: гипотеза создаётся открытой' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'model_suggestion: решённая гипотеза неизменна' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.run_id, NEW.request_id, NEW.kind, NEW.title, NEW.rationale, NEW.payload, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.run_id, OLD.request_id, OLD.kind, OLD.title, OLD.rationale, OLD.payload, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'model_suggestion: содержание гипотезы неизменно' USING ERRCODE = '55000';
  END IF;
  -- Принимает и отклоняет только человек с finding.write; «истекла» — инвалидация, без автора.
  IF NEW.status IN ('accepted', 'rejected') AND NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'finding.write') THEN
    RAISE EXCEPTION 'model_suggestion: гипотезу принимает участник тендера с finding.write' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM finding f WHERE f.id = NEW.finding_id AND f.suggestion_id = NEW.id AND f.created_by = NEW.decided_by) THEN
    RAISE EXCEPTION 'model_suggestion: принятая гипотеза — замечание принявшего' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'expired' AND (NEW.decided_by IS NOT NULL OR NEW.finding_id IS NOT NULL) THEN
    RAISE EXCEPTION 'model_suggestion: истекшая гипотеза без решения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_suggestion_guard BEFORE INSERT OR UPDATE ON model_suggestion FOR EACH ROW EXECUTE FUNCTION model_suggestion_guard();
CREATE TRIGGER model_suggestion_no_delete BEFORE DELETE ON model_suggestion FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER model_suggestion_no_truncate BEFORE TRUNCATE ON model_suggestion FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

CREATE TABLE model_suggestion_evidence (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id           uuid NOT NULL REFERENCES model_suggestion (id),
  tender_id               uuid NOT NULL REFERENCES tender (id),
  side                    text NOT NULL CHECK (side IN ('left', 'right', 'context')),
  fragment_id             uuid REFERENCES evidence_fragment (id),
  calculation_revision_id uuid REFERENCES calculation_revision (id),
  external_position_id    uuid,
  created_xact            xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT model_suggestion_evidence_shape CHECK (
    (fragment_id IS NOT NULL AND calculation_revision_id IS NULL AND external_position_id IS NULL)
    OR (fragment_id IS NULL AND calculation_revision_id IS NOT NULL AND external_position_id IS NOT NULL))
);
-- Цитата гипотезы — из снимка прогона, позиция — из ревизии расчёта прогона; пишется вместе с гипотезой.
CREATE FUNCTION model_suggestion_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run review_run%ROWTYPE;
BEGIN
  SELECT r.* INTO v_run FROM model_suggestion m JOIN review_run r ON r.id = m.run_id
   WHERE m.id = NEW.suggestion_id AND m.tender_id = NEW.tender_id AND m.created_xact = pg_current_xact_id();
  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'model_suggestion_evidence: основания пишутся вместе с гипотезой' USING ERRCODE = '55000';
  END IF;
  IF (NEW.fragment_id IS NOT NULL AND NOT fragment_in_scope(NEW.fragment_id, v_run.evidence_scope_id))
     OR (NEW.calculation_revision_id IS NOT NULL AND NEW.calculation_revision_id IS DISTINCT FROM v_run.calculation_revision_id) THEN
    RAISE EXCEPTION 'model_suggestion_evidence: основание вне входа прогона' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_suggestion_evidence_guard BEFORE INSERT ON model_suggestion_evidence FOR EACH ROW EXECUTE FUNCTION model_suggestion_evidence_guard();
CREATE TRIGGER model_suggestion_evidence_immutable BEFORE UPDATE OR DELETE ON model_suggestion_evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER model_suggestion_evidence_no_truncate BEFORE TRUNCATE ON model_suggestion_evidence FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Разногласие и четыре оси (I08, I09)

CREATE TABLE discrepancy (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id    uuid NOT NULL REFERENCES tender (id),
  stage_id     uuid NOT NULL REFERENCES tender_stage (id),
  finding_id   uuid NOT NULL REFERENCES finding (id),
  topic        text NOT NULL CHECK (length(topic) BETWEEN 1 AND 300),
  created_by   uuid NOT NULL REFERENCES app_user (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_xact xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT discrepancy_finding_key UNIQUE (finding_id)
);
CREATE FUNCTION discrepancy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finding f WHERE f.id = NEW.finding_id AND f.stage_id = NEW.stage_id AND f.tender_id = NEW.tender_id) THEN
    RAISE EXCEPTION 'discrepancy: замечание — этого этапа' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.created_by, NEW.stage_id, 'finding.write') THEN
    RAISE EXCEPTION 'discrepancy: разногласие создаёт участник тендера с finding.write' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discrepancy_guard BEFORE INSERT ON discrepancy FOR EACH ROW EXECUTE FUNCTION discrepancy_guard();
CREATE TRIGGER discrepancy_immutable BEFORE UPDATE OR DELETE ON discrepancy FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER discrepancy_no_truncate BEFORE TRUNCATE ON discrepancy FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Значение оси — последнее событие оси; без события — значение по умолчанию (§3.3).
CREATE TABLE discrepancy_status_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discrepancy_id uuid NOT NULL REFERENCES discrepancy (id),
  tender_id      uuid NOT NULL REFERENCES tender (id),
  seq            int NOT NULL CHECK (seq > 0),
  axis           text NOT NULL CHECK (axis IN ('customer_position', 'calculation', 'proposal', 'documents')),
  value          text NOT NULL,
  reason         text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  actor_user_id  uuid NOT NULL REFERENCES app_user (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_xact   xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT discrepancy_status_event_seq_key UNIQUE (discrepancy_id, seq),
  CONSTRAINT discrepancy_status_event_value_shape CHECK (CASE axis
    WHEN 'customer_position' THEN value IN ('unknown', 'proposed_by_contractor', 'discussed_orally', 'agreed_in_writing', 'rejected_by_customer')
    WHEN 'calculation' THEN value IN ('not_reflected', 'partially_reflected', 'reflected', 'not_applicable')
    WHEN 'proposal' THEN value IN ('not_reflected', 'reflected', 'not_applicable')
    ELSE value IN ('not_fixed', 'fixed_in_tz', 'fixed_in_contract', 'not_applicable') END)
);
CREATE INDEX discrepancy_status_event_idx ON discrepancy_status_event (discrepancy_id, axis, seq DESC);

CREATE FUNCTION discrepancy_status_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_d discrepancy%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM discrepancy WHERE id = NEW.discrepancy_id;
  IF v_d.tender_id IS DISTINCT FROM NEW.tender_id THEN
    RAISE EXCEPTION 'discrepancy_status_event: тендер события — тендер разногласия' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.actor_user_id, v_d.stage_id, 'finding.write') THEN
    RAISE EXCEPTION 'discrepancy_status_event: ось меняет человек с finding.write' USING ERRCODE = '42501';
  END IF;
  IF NEW.seq <> (SELECT coalesce(max(seq), 0) + 1 FROM discrepancy_status_event WHERE discrepancy_id = NEW.discrepancy_id) THEN
    RAISE EXCEPTION 'discrepancy_status_event: номер события — следующий' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discrepancy_status_event_guard BEFORE INSERT ON discrepancy_status_event FOR EACH ROW EXECUTE FUNCTION discrepancy_status_event_guard();
CREATE TRIGGER discrepancy_status_event_immutable BEFORE UPDATE OR DELETE ON discrepancy_status_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER discrepancy_status_event_no_truncate BEFORE TRUNCATE ON discrepancy_status_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

CREATE TABLE discrepancy_basis (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 uuid NOT NULL REFERENCES discrepancy_status_event (id),
  tender_id                uuid NOT NULL REFERENCES tender (id),
  basis_type               text NOT NULL CHECK (basis_type IN ('fragment', 'qa_item_revision', 'mail_message_revision', 'document_revision', 'decision')),
  fragment_id              uuid REFERENCES evidence_fragment (id),
  qa_item_revision_id      uuid REFERENCES qa_item_revision (id),
  mail_message_revision_id uuid REFERENCES mail_message_revision (id),
  document_revision_id     uuid REFERENCES document_revision (id),
  decision_id              uuid REFERENCES decision (id),
  created_xact             xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT discrepancy_basis_shape CHECK (num_nonnulls(fragment_id, qa_item_revision_id, mail_message_revision_id, document_revision_id, decision_id) = 1
    AND CASE basis_type WHEN 'fragment' THEN fragment_id IS NOT NULL WHEN 'qa_item_revision' THEN qa_item_revision_id IS NOT NULL
                        WHEN 'mail_message_revision' THEN mail_message_revision_id IS NOT NULL WHEN 'document_revision' THEN document_revision_id IS NOT NULL
                        ELSE decision_id IS NOT NULL END)
);
CREATE FUNCTION discrepancy_basis_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
BEGIN
  SELECT d.stage_id INTO v_stage FROM discrepancy_status_event e JOIN discrepancy d ON d.id = e.discrepancy_id
   WHERE e.id = NEW.event_id AND e.tender_id = NEW.tender_id AND e.created_xact = pg_current_xact_id();
  IF v_stage IS NULL THEN
    RAISE EXCEPTION 'discrepancy_basis: основания пишутся вместе с событием оси' USING ERRCODE = '55000';
  END IF;
  IF (NEW.fragment_id IS NOT NULL AND NOT fragment_in_stage(NEW.fragment_id, v_stage))
     OR (NEW.qa_item_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM qa_item_revision r WHERE r.id = NEW.qa_item_revision_id AND r.tender_id = NEW.tender_id))
     OR (NEW.mail_message_revision_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM mail_message_revision r JOIN mail_message_tender t ON t.message_id = r.message_id
            WHERE r.id = NEW.mail_message_revision_id AND t.tender_id = NEW.tender_id AND t.status = 'linked'))
     OR (NEW.document_revision_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM document_revision r
            WHERE r.id = NEW.document_revision_id
              AND (r.tender_id = NEW.tender_id OR EXISTS (SELECT 1 FROM contract_tender ct WHERE ct.contract_id = r.contract_id AND ct.tender_id = NEW.tender_id))))
     OR (NEW.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decision x WHERE x.id = NEW.decision_id AND x.stage_id = v_stage)) THEN
    RAISE EXCEPTION 'discrepancy_basis: основание вне этапа или тендера разногласия' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discrepancy_basis_guard BEFORE INSERT ON discrepancy_basis FOR EACH ROW EXECUTE FUNCTION discrepancy_basis_guard();
CREATE TRIGGER discrepancy_basis_immutable BEFORE UPDATE OR DELETE ON discrepancy_basis FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER discrepancy_basis_no_truncate BEFORE TRUNCATE ON discrepancy_basis FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Вид основания оси: письменное (документ, письмо, ответ заказчика), речь переговоров, подсказка, решение.
CREATE FUNCTION discrepancy_basis_class(p_basis discrepancy_basis) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE p_basis.basis_type
           WHEN 'fragment' THEN (SELECT CASE WHEN f.origin IN ('document_text', 'recognized_text', 'email_body', 'attachment_text', 'qa_answer') THEN 'written'
                                             WHEN f.origin = 'negotiation_speech' THEN 'speech'
                                             WHEN f.origin = 'negotiation_hint' THEN 'hint'
                                             ELSE 'other' END
                                   FROM evidence_fragment f WHERE f.id = p_basis.fragment_id)
           WHEN 'qa_item_revision' THEN (SELECT CASE WHEN r.answer IS NOT NULL THEN 'written' ELSE 'other' END FROM qa_item_revision r WHERE r.id = p_basis.qa_item_revision_id)
           WHEN 'decision' THEN 'decision'
           ELSE 'written' END
$$;

-- Документ основания: из фрагмента прогона распознавания или прямо редакция; вид — ТЗ или договор (D-022: документ договора).
CREATE FUNCTION discrepancy_basis_document_kind(p_basis discrepancy_basis) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN d.contract_id IS NOT NULL OR d.doc_type = 'contract' THEN 'contract' WHEN d.doc_type = 'tz' THEN 'tz' ELSE 'other' END
    FROM document_revision r JOIN document d ON d.id = r.document_id
   WHERE r.id = coalesce(p_basis.document_revision_id, (SELECT f.document_revision_id FROM evidence_fragment f WHERE f.id = p_basis.fragment_id))
$$;

-- Правила оснований оси (I08, A01, A03, A04) — в конце транзакции, когда основания записаны: подсказка переговоров не
-- основание; «согласовано письменно» и «отклонено заказчиком» — с письменным основанием; речь даёт не больше «обсуждено
-- устно»; «закреплено в ТЗ / договоре» — с основанием из документа ТЗ / договора.
CREATE FUNCTION discrepancy_event_basis_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM discrepancy_basis b WHERE b.event_id = NEW.id AND discrepancy_basis_class(b) = 'hint') THEN
    RAISE EXCEPTION 'discrepancy_status_event: подсказка переговоров не основание позиции' USING ERRCODE = '23514';
  END IF;
  IF NEW.value IN ('agreed_in_writing', 'rejected_by_customer')
     AND NOT EXISTS (SELECT 1 FROM discrepancy_basis b WHERE b.event_id = NEW.id AND discrepancy_basis_class(b) = 'written') THEN
    RAISE EXCEPTION 'discrepancy_status_event: % — только с письменным основанием', NEW.value USING ERRCODE = '23514';
  END IF;
  IF NEW.value = 'fixed_in_tz' AND NOT EXISTS (SELECT 1 FROM discrepancy_basis b WHERE b.event_id = NEW.id AND discrepancy_basis_document_kind(b) = 'tz') THEN
    RAISE EXCEPTION 'discrepancy_status_event: «закреплено в ТЗ» — с основанием из ТЗ' USING ERRCODE = '23514';
  END IF;
  IF NEW.value = 'fixed_in_contract' AND NOT EXISTS (SELECT 1 FROM discrepancy_basis b WHERE b.event_id = NEW.id AND discrepancy_basis_document_kind(b) = 'contract') THEN
    RAISE EXCEPTION 'discrepancy_status_event: «закреплено в договоре» — с основанием из договора' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER discrepancy_event_basis_check AFTER INSERT ON discrepancy_status_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION discrepancy_event_basis_check();

-- ---------------------------------------------------------------- Зависимости и инвалидация (§5.4)

CREATE TABLE evidence_dependency (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id       uuid NOT NULL REFERENCES tender (id),
  stage_id        uuid NOT NULL REFERENCES tender_stage (id),
  dependent_type  text NOT NULL CHECK (dependent_type IN ('finding', 'discrepancy_status_event', 'model_suggestion')),
  dependent_id    uuid NOT NULL,
  depends_on_type text NOT NULL CHECK (depends_on_type IN ('document', 'document_revision', 'recognition_run', 'fragment', 'calculation_revision',
                                                           'requirement_revision', 'evidence_fact', 'qa_item', 'qa_item_revision', 'mail_message_revision',
                                                           'transcript_revision', 'customer_question', 'assumption', 'decision')),
  depends_on_id   uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_dependency_key UNIQUE (dependent_type, dependent_id, depends_on_type, depends_on_id)
);
CREATE INDEX evidence_dependency_target_idx ON evidence_dependency (depends_on_type, depends_on_id);
CREATE TRIGGER evidence_dependency_immutable BEFORE UPDATE OR DELETE ON evidence_dependency FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER evidence_dependency_no_truncate BEFORE TRUNCATE ON evidence_dependency FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- Обработка события барьера заданием инвалидации: точно (по зависимостям) или консервативно (область не определена).
CREATE TABLE stage_input_event_processing (
  event_id     uuid PRIMARY KEY REFERENCES stage_input_event (id),
  stage_id     uuid NOT NULL REFERENCES tender_stage (id),
  mode         text NOT NULL CHECK (mode IN ('exact', 'conservative')),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  affected     jsonb NOT NULL CHECK (jsonb_typeof(affected) = 'object'),
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER stage_input_event_processing_immutable BEFORE UPDATE OR DELETE ON stage_input_event_processing FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER stage_input_event_processing_no_truncate BEFORE TRUNCATE ON stage_input_event_processing FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Отметка «основание изменилось» у решения, события оси, замечания и гипотезы; сам объект не меняется (D-029).
CREATE TABLE evidence_invalidation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id            uuid NOT NULL REFERENCES tender (id),
  stage_id             uuid NOT NULL REFERENCES tender_stage (id),
  dependent_type       text NOT NULL CHECK (dependent_type IN ('finding', 'decision', 'discrepancy_status_event', 'model_suggestion')),
  dependent_id         uuid NOT NULL,
  stage_input_event_id uuid NOT NULL REFERENCES stage_input_event (id),
  mode                 text NOT NULL CHECK (mode IN ('exact', 'conservative')),
  reason               text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_invalidation_key UNIQUE (dependent_type, dependent_id, stage_input_event_id)
);
CREATE INDEX evidence_invalidation_dependent_idx ON evidence_invalidation (dependent_type, dependent_id);
-- Отметку пишет только обработка своего события барьера (та же транзакция).
CREATE FUNCTION evidence_invalidation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stage_input_event e WHERE e.id = NEW.stage_input_event_id AND e.stage_id = NEW.stage_id) THEN
    RAISE EXCEPTION 'evidence_invalidation: событие — событие этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_invalidation_guard BEFORE INSERT ON evidence_invalidation FOR EACH ROW EXECUTE FUNCTION evidence_invalidation_guard();
CREATE TRIGGER evidence_invalidation_immutable BEFORE UPDATE OR DELETE ON evidence_invalidation FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER evidence_invalidation_no_truncate BEFORE TRUNCATE ON evidence_invalidation FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT ON review_check, review_finding_kind TO kontur_app;
GRANT SELECT, INSERT ON source_priority_revision, review_check_result, finding_event, finding_evidence, finding_occurrence, model_suggestion_evidence,
                        discrepancy, discrepancy_status_event, discrepancy_basis, evidence_dependency, stage_input_event_processing, evidence_invalidation TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON review_run, finding, model_suggestion TO kontur_app;
