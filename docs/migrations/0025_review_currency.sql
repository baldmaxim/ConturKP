-- Этап 09, Review 09-1: R09-01, R09-02, R09-03. Вход прогона закрепляется при запуске неизменяемым снимком (содержимое
-- реестра, покрытие, вход модели, отпечаток содержимого этапа) — программная часть и модель читают один набор (R09-02).
-- Решение по замечанию и разногласию, ось и принятие гипотезы записываются только по актуальному основанию: замечание
-- не «устарело», все события барьера этапа обработаны инвалидацией (R09-01, R09-03). Код обрабатывает необработанные
-- события в транзакции команды под блокировкой этапа; здесь — вторая линия. Принятые миграции не меняются (ADR-002).

-- ---------------------------------------------------------------- Закреплённый вход прогона (R09-02)

CREATE TABLE review_run_input (
  run_id              uuid PRIMARY KEY REFERENCES review_run (id),
  input               jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  model_input         jsonb CHECK (model_input IS NULL OR jsonb_typeof(model_input) = 'object'),
  input_sha256        text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  created_xact        xid8 NOT NULL DEFAULT pg_current_xact_id()
);

-- Вход пишется только в транзакции запуска прогона, пока прогон в очереди; вход модели — у прогона с моделью.
CREATE FUNCTION review_run_input_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run review_run%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM review_run WHERE id = NEW.run_id;
  IF v_run.created_xact IS DISTINCT FROM pg_current_xact_id() OR v_run.status <> 'queued' THEN
    RAISE EXCEPTION 'review_run_input: вход закрепляется в транзакции запуска прогона' USING ERRCODE = '55000';
  END IF;
  IF (NEW.model_input IS NULL) <> (v_run.model_provider IS NULL) THEN
    RAISE EXCEPTION 'review_run_input: вход модели — у прогона с моделью' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_run_input_guard BEFORE INSERT ON review_run_input FOR EACH ROW EXECUTE FUNCTION review_run_input_guard();
CREATE TRIGGER review_run_input_immutable BEFORE UPDATE OR DELETE ON review_run_input FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER review_run_input_no_truncate BEFORE TRUNCATE ON review_run_input FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Каждый новый прогон — с закреплённым входом (проверка в конце транзакции запуска).
CREATE FUNCTION review_run_input_required() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM review_run_input i WHERE i.run_id = NEW.id) THEN
    RAISE EXCEPTION 'review_run: прогон создаётся с закреплённым входом' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER review_run_input_required AFTER INSERT ON review_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION review_run_input_required();

-- ---------------------------------------------------------------- Актуальность основания решений (R09-01, R09-03)

-- Необработанные инвалидацией события барьера этапа: пока они есть, актуальность основания не установлена.
CREATE FUNCTION stage_events_pending(p_stage uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM stage_input_event e
                  WHERE e.stage_id = p_stage AND NOT EXISTS (SELECT 1 FROM stage_input_event_processing p WHERE p.event_id = e.id))
$$;

-- Замечание действует для решения: не «устарело» и события этапа обработаны.
CREATE FUNCTION finding_basis_current(p_finding uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN f.status = 'stale' THEN 'finding_stale'
              WHEN stage_events_pending(f.stage_id) THEN 'events_pending'
              ELSE NULL END
    FROM finding f WHERE f.id = p_finding
$$;

CREATE FUNCTION review_decision_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_finding uuid;
  v_problem text;
BEGIN
  IF NEW.decision_type NOT IN ('finding_resolution', 'finding_risk_acceptance', 'discrepancy_decision') THEN
    RETURN NEW;
  END IF;
  v_finding := CASE NEW.decision_type WHEN 'discrepancy_decision' THEN (SELECT d.finding_id FROM discrepancy d WHERE d.id = NEW.subject_id) ELSE NEW.subject_id END;
  v_problem := finding_basis_current(v_finding);
  IF v_problem = 'finding_stale' THEN
    RAISE EXCEPTION 'decision: основание замечания изменилось — решение только после перепроверки' USING ERRCODE = '23514';
  ELSIF v_problem = 'events_pending' THEN
    RAISE EXCEPTION 'decision: есть необработанные события этапа — актуальность основания не установлена' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_decision_currency_guard BEFORE INSERT ON decision FOR EACH ROW EXECUTE FUNCTION review_decision_currency_guard();

CREATE FUNCTION discrepancy_event_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_problem text;
BEGIN
  v_problem := finding_basis_current((SELECT d.finding_id FROM discrepancy d WHERE d.id = NEW.discrepancy_id));
  IF v_problem = 'finding_stale' THEN
    RAISE EXCEPTION 'discrepancy_status_event: основание замечания изменилось — ось только после перепроверки' USING ERRCODE = '23514';
  ELSIF v_problem = 'events_pending' THEN
    RAISE EXCEPTION 'discrepancy_status_event: есть необработанные события этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discrepancy_event_currency_guard BEFORE INSERT ON discrepancy_status_event FOR EACH ROW EXECUTE FUNCTION discrepancy_event_currency_guard();

-- Разногласие открывается у действующего замечания.
CREATE FUNCTION discrepancy_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF finding_basis_current(NEW.finding_id) IS NOT NULL THEN
    RAISE EXCEPTION 'discrepancy: замечание устарело или события этапа не обработаны' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discrepancy_currency_guard BEFORE INSERT ON discrepancy FOR EACH ROW EXECUTE FUNCTION discrepancy_currency_guard();

-- Гипотеза принимается, только когда события этапа обработаны (истёкшую гипотезу принять нельзя — 0024).
CREATE FUNCTION model_suggestion_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status = 'open' AND stage_events_pending(NEW.stage_id) THEN
    RAISE EXCEPTION 'model_suggestion: есть необработанные события этапа — гипотеза могла устареть' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_suggestion_currency_guard BEFORE UPDATE ON model_suggestion FOR EACH ROW EXECUTE FUNCTION model_suggestion_currency_guard();

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT ON review_run_input TO kontur_app;
