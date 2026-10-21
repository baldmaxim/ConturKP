-- Этап 18 (D-044; проект docs/architecture/18-pilot-design.md §14, §15): правило итога КП и закрытый расчёт решением
-- руководителя. Принятые 0001–0043 не меняются (ADR-002); функции возможностей, охранника входов кандидата и неснимаемых
-- блокеров заменяются целиком.
--
-- Q-01. X-01 (закрытие ревизии у источника) остаётся BLOCKED_EXTERNAL. Без него закрытой считается ревизия расчёта
-- `provisional`, зафиксированная решением руководителя тендера: решение — на одну ревизию, отзывное, журнал неизменяемый.
-- Кандидат закрепляет действующее решение входом `calculation_closure`; блокер CALCULATION_PROVISIONAL не ставится, пока
-- закреплённое решение действует (`calculation_closed_by_decision` — единственный предикат, на него опираются
-- `candidate_gate_problem`, ядро и сервер). Отзыв до выпуска снимает это основание: согласование и выпуск отказывают.
-- У выпущенного кандидата решение остаётся основанием и после отзыва: выпущенное не меняется, история показывает отзыв.
--
-- Q-05. Правило итога КП `th_grand_total_vat_included` ставит захват расчёта (adapters); для боевого выпуска сверка
-- экономики ревизии должна быть «сведена» (`reconciled`), иначе — неснимаемый блокер KP_TOTAL_UNRECONCILED.

-- ---------------------------------------------------------------- Права

-- calculation.close — руководитель тендера (D-044). Таблица повторяет packages/core/src/capabilities.ts.
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
                              'review.run', 'finding.write', 'economics.compare', 'change_reason.confirm', 'application.fill',
                              'candidate.create', 'delivery.manage', 'mcp.propose'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm',
                              'finding.accept_risk', 'source_priority.manage', 'template.manage', 'candidate.approve', 'risk.accept',
                              'send.accept_extras', 'calculation.close'];
  END IF;
  IF v_role = 'engineer' THEN
    v_caps := v_caps || ARRAY['candidate.release', 'send.register'];
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

-- ---------------------------------------------------------------- Решение о закрытом расчёте (Q-01)

CREATE TABLE calculation_closure_decision (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id               uuid NOT NULL REFERENCES tender (id),
  stage_id                uuid NOT NULL,
  calculation_revision_id uuid NOT NULL,
  decided_by              uuid NOT NULL REFERENCES app_user (id),
  reason                  text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  decided_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calculation_closure_decision_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT calculation_closure_decision_revision_fk FOREIGN KEY (calculation_revision_id, tender_id) REFERENCES calculation_revision (id, tender_id)
);
CREATE INDEX calculation_closure_decision_revision_idx ON calculation_closure_decision (calculation_revision_id, decided_at);

CREATE TABLE calculation_closure_revocation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL UNIQUE REFERENCES calculation_closure_decision (id),
  revoked_by  uuid NOT NULL REFERENCES app_user (id),
  reason      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  revoked_at  timestamptz NOT NULL DEFAULT now()
);

-- Решение: ревизия `provisional` этого этапа и тендера; решает человек с calculation.close; на ревизию не больше одного
-- действующего (не отозванного) решения. Сериализация — advisory-блокировка этапа: у роли приложения нет UPDATE,
-- блокировать строки неизменяемых таблиц (FOR UPDATE) она не может.
CREATE FUNCTION calculation_closure_decision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r calculation_revision%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('calculation_closure'), hashtext(NEW.stage_id::text));
  SELECT * INTO r FROM calculation_revision WHERE id = NEW.calculation_revision_id;
  IF NOT FOUND OR r.stage_id <> NEW.stage_id OR r.tender_id <> NEW.tender_id THEN
    RAISE EXCEPTION 'calculation_closure_decision: ревизия расчёта — не этого этапа и тендера' USING ERRCODE = '23514';
  END IF;
  IF r.kind <> 'provisional' THEN
    RAISE EXCEPTION 'calculation_closure_decision: решение принимается только по предварительной (provisional) ревизии' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'calculation.close') THEN
    RAISE EXCEPTION 'calculation_closure_decision: решает руководитель тендера (calculation.close)' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM calculation_closure_decision d
              WHERE d.calculation_revision_id = NEW.calculation_revision_id
                AND NOT EXISTS (SELECT 1 FROM calculation_closure_revocation v WHERE v.decision_id = d.id)) THEN
    RAISE EXCEPTION 'calculation_closure_decision: у ревизии уже есть действующее решение' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_closure_decision_guard BEFORE INSERT ON calculation_closure_decision
  FOR EACH ROW EXECUTE FUNCTION calculation_closure_decision_guard();
CREATE TRIGGER calculation_closure_decision_immutable BEFORE UPDATE OR DELETE ON calculation_closure_decision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER calculation_closure_decision_no_truncate BEFORE TRUNCATE ON calculation_closure_decision
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Отзыв: тот же круг прав; один отзыв на решение (UNIQUE и явная проверка).
CREATE FUNCTION calculation_closure_revocation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d calculation_closure_decision%ROWTYPE;
BEGIN
  SELECT * INTO d FROM calculation_closure_decision WHERE id = NEW.decision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'calculation_closure_revocation: решение не найдено' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('calculation_closure'), hashtext(d.stage_id::text));
  IF NOT has_stage_capability(NEW.revoked_by, d.stage_id, 'calculation.close') THEN
    RAISE EXCEPTION 'calculation_closure_revocation: отзывает руководитель тендера (calculation.close)' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM calculation_closure_revocation v WHERE v.decision_id = NEW.decision_id) THEN
    RAISE EXCEPTION 'calculation_closure_revocation: решение уже отозвано' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_closure_revocation_guard BEFORE INSERT ON calculation_closure_revocation
  FOR EACH ROW EXECUTE FUNCTION calculation_closure_revocation_guard();
CREATE TRIGGER calculation_closure_revocation_immutable BEFORE UPDATE OR DELETE ON calculation_closure_revocation
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER calculation_closure_revocation_no_truncate BEFORE TRUNCATE ON calculation_closure_revocation
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

GRANT SELECT, INSERT ON calculation_closure_decision, calculation_closure_revocation TO kontur_app;

-- Согласование и выпуск берут ту же advisory-блокировку этапа, что решение и отзыв: незакоммиченный отзыв
-- задерживает выпуск, и охранник выпуска (следующий триггер, имена — по алфавиту) видит его после фиксации.
-- Без этого прямые вставки в БД могли разойтись: выпуск проверял решение по снимку до отзыва.
CREATE FUNCTION calculation_closure_serialize() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('calculation_closure'), hashtext(NEW.stage_id::text));
  RETURN NEW;
END;
$$;

CREATE TRIGGER a_calculation_closure_serialize BEFORE INSERT OR UPDATE ON approval
  FOR EACH ROW EXECUTE FUNCTION calculation_closure_serialize();
CREATE TRIGGER a_calculation_closure_serialize BEFORE INSERT ON release
  FOR EACH ROW EXECUTE FUNCTION calculation_closure_serialize();

-- ---------------------------------------------------------------- Вход кандидата и единый предикат

ALTER TABLE candidate_input DROP CONSTRAINT candidate_input_kind_check;
ALTER TABLE candidate_input ADD CONSTRAINT candidate_input_kind_check
  CHECK (kind IN ('review_run', 'decision', 'application_draft', 'field_version', 'template_revision', 'attachment_revision', 'calculation_closure'));

-- Охранник входов 0033 + вид `calculation_closure`: действующее (не отозванное) решение по ревизии кандидата, этого этапа.
CREATE OR REPLACE FUNCTION candidate_input_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c release_candidate%ROWTYPE;
  v_ok boolean;
  v_problem text;
BEGIN
  SELECT * INTO c FROM release_candidate WHERE id = NEW.candidate_id;
  IF c.created_xact <> pg_current_xact_id() OR c.status <> 'assembling' THEN
    RAISE EXCEPTION 'candidate_input: входы закрепляются в транзакции создания кандидата' USING ERRCODE = '55000';
  END IF;
  v_ok := CASE NEW.kind
    WHEN 'review_run' THEN EXISTS (SELECT 1 FROM review_run r WHERE r.id = NEW.ref_id AND r.stage_id = c.stage_id)
    WHEN 'decision' THEN EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.ref_id AND d.stage_id = c.stage_id)
    WHEN 'application_draft' THEN EXISTS (SELECT 1 FROM application_draft a WHERE a.id = NEW.ref_id AND a.stage_id = c.stage_id AND a.status = 'complete')
    WHEN 'field_version' THEN EXISTS (SELECT 1 FROM draft_field_version v JOIN application_draft a ON a.id = v.draft_id WHERE v.id = NEW.ref_id AND a.stage_id = c.stage_id)
    WHEN 'template_revision' THEN EXISTS (SELECT 1 FROM template_revision r WHERE r.id = NEW.ref_id AND r.status = 'approved' AND (r.tender_id IS NULL OR r.tender_id = c.tender_id)
                                           AND (r.markup ->> 'ok')::boolean)
    WHEN 'attachment_revision' THEN EXISTS (SELECT 1 FROM standard_attachment_revision r JOIN standard_attachment a ON a.id = r.attachment_id
                                             WHERE r.id = NEW.ref_id AND r.status = 'approved' AND (a.scope_tender_id IS NULL OR a.scope_tender_id = c.tender_id))
    WHEN 'calculation_closure' THEN EXISTS (SELECT 1 FROM calculation_closure_decision d
                                             WHERE d.id = NEW.ref_id AND d.stage_id = c.stage_id AND d.tender_id = c.tender_id
                                               AND d.calculation_revision_id = c.calculation_revision_id
                                               AND NOT EXISTS (SELECT 1 FROM calculation_closure_revocation v WHERE v.decision_id = d.id))
  END;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'candidate_input: вход % — не объект этапа и тендера кандидата или не в допустимом состоянии', NEW.kind USING ERRCODE = '23514';
  END IF;
  -- R12-02: заполненность приложения и свежесть закрепляемой версии — на момент закрепления.
  IF NEW.kind = 'application_draft' THEN
    v_problem := draft_completion_problem(NEW.ref_id);
  ELSIF NEW.kind = 'field_version' THEN
    v_problem := CASE
      WHEN EXISTS (SELECT 1 FROM draft_field_version v JOIN draft_field_version n ON n.field_id = v.field_id AND n.version > v.version WHERE v.id = NEW.ref_id) THEN 'not_latest'
      WHEN field_version_invalidated(NEW.ref_id) THEN 'invalidated'
      ELSE field_version_basis_problem(c.stage_id, NEW.ref_id)
    END;
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'candidate_input: вход % не закрепляется — %', NEW.kind, v_problem USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Единый предикат закрытого расчёта (D-044): у кандидата закреплено решение по ревизии кандидата, и оно действует —
-- не отозвано, либо кандидат уже выпущен (выпуск проверил решение под блокировкой этапа; выпущенное не меняется).
CREATE FUNCTION calculation_closed_by_decision(p_candidate uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM release_candidate c
      JOIN candidate_input ci ON ci.candidate_id = c.id AND ci.kind = 'calculation_closure'
      JOIN calculation_closure_decision d ON d.id = ci.ref_id AND d.calculation_revision_id = c.calculation_revision_id AND d.stage_id = c.stage_id
     WHERE c.id = p_candidate
       AND (NOT EXISTS (SELECT 1 FROM calculation_closure_revocation v WHERE v.decision_id = d.id)
            OR EXISTS (SELECT 1 FROM release r WHERE r.candidate_id = c.id)))
$$;

-- Последняя сверка экономики ревизии — «сведена» (reconciled). Отчёта нет — не сведена.
CREATE FUNCTION revision_economics_reconciled(p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT e.reconciliation_status = 'reconciled' FROM revision_economics e
                    WHERE e.revision_id = p_revision ORDER BY e.created_at DESC, e.id DESC LIMIT 1), false)
$$;

-- ---------------------------------------------------------------- Неснимаемые блокеры (0037 + D-044)

CREATE OR REPLACE FUNCTION candidate_gate_problem(p_candidate uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c release_candidate%ROWTYPE;
  v_run_ok boolean := false;
BEGIN
  SELECT * INTO c FROM release_candidate WHERE id = p_candidate;
  IF NOT FOUND THEN
    RETURN 'CANDIDATE_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_uncovered_events(c.id)) THEN
    RETURN 'INPUTS_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM intake_channel ch WHERE ch.tender_id = c.tender_id AND ch.active
                AND (ch.last_successful_scan_at IS NULL OR ch.last_successful_scan_at < now() - ch.freshness_window)) THEN
    RETURN 'INTAKE_NOT_CURRENT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM candidate_input ci JOIN review_run r ON r.id = ci.ref_id
                  WHERE ci.candidate_id = c.id AND ci.kind = 'review_run' AND r.status IN ('completed', 'completed_with_gaps')) THEN
    RETURN 'REVIEW_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_input ci JOIN review_run r ON r.id = ci.ref_id
              WHERE ci.candidate_id = c.id AND ci.kind = 'review_run'
                AND (r.evidence_scope_id <> c.evidence_scope_id OR r.calculation_revision_id IS DISTINCT FROM c.calculation_revision_id)) THEN
    RETURN 'REVIEW_SCOPE_MISMATCH';
  END IF;
  -- R13-01, R13-05, R13-06: вход прогона закреплён при запуске вместе с отпечатком содержимого этапа (R09-02); отпечаток
  -- v3 (полные наборы записей входа прогона и вид документов снимка) не совпадает с текущим — прогон устарел. Прогон без
  -- закреплённого входа (до 0025) и вход, закреплённый прежними v1 (до 0036) или v2 (до 0037), полноту изменений не
  -- доказывают — тоже устарел.
  IF EXISTS (SELECT 1 FROM candidate_input ci JOIN review_run r ON r.id = ci.ref_id LEFT JOIN review_run_input i ON i.run_id = r.id
              WHERE ci.candidate_id = c.id AND ci.kind = 'review_run' AND r.status IN ('completed', 'completed_with_gaps')
                AND (i.run_id IS NULL OR i.content_fingerprint <> stage_content_fingerprint_v3(r.stage_id, r.registry_id, r.evidence_scope_id))) THEN
    RETURN 'REVIEW_OUTDATED';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_input ci JOIN review_check_result x ON x.run_id = ci.ref_id
              WHERE ci.candidate_id = c.id AND ci.kind = 'review_run'
                AND (x.outcome = 'error' OR (x.outcome = 'incomplete' AND x.check_code <> 'coverage'))) THEN
    RETURN 'REVIEW_PROCESSING_INCOMPLETE';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_input ci WHERE ci.candidate_id = c.id AND ci.kind = 'field_version'
                AND (field_version_basis_problem(c.stage_id, ci.ref_id) IS NOT NULL OR field_version_invalidated(ci.ref_id))) THEN
    RETURN 'FIELDS_STALE';
  END IF;
  IF c.mode = 'production' THEN
    -- D-044, Q-01: предварительная ревизия не блокирует, если решение руководителя о закрытом расчёте закреплено во входе
    -- кандидата и действует (один предикат с сервером и ядром).
    IF EXISTS (SELECT 1 FROM calculation_revision r WHERE r.id = c.calculation_revision_id AND r.kind = 'provisional')
       AND NOT calculation_closed_by_decision(c.id) THEN
      RETURN 'CALCULATION_PROVISIONAL';
    END IF;
    IF EXISTS (SELECT 1 FROM candidate_input ci JOIN template_revision r ON r.id = ci.ref_id JOIN application_template t ON t.id = r.template_id
                WHERE ci.candidate_id = c.id AND ci.kind = 'template_revision' AND t.is_demo) THEN
      RETURN 'TEMPLATE_DEMO';
    END IF;
    IF EXISTS (SELECT 1 FROM calculation_revision r JOIN calculation_content cc ON cc.id = r.content_id
                WHERE r.id = c.calculation_revision_id AND cc.kp_total_rule IS NULL) THEN
      RETURN 'KP_TOTAL_NOT_APPROVED';
    END IF;
    -- D-044, Q-05 (толкование исполнителя): итог источника отстаёт от строк (D-030) — нужна сверка экономики ревизии «сведена».
    IF NOT revision_economics_reconciled(c.calculation_revision_id) THEN
      RETURN 'KP_TOTAL_UNRECONCILED';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
