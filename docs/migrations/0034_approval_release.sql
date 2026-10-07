-- Этап 13 (D-033; проект docs/architecture/13-approval-release-design.md): согласование, возврат, отзыв и выпуск
-- кандидата; принятие бизнес-риска; удержания по событиям входов и решения по ним; правила покрытия событий кандидатом
-- (state-machines §1.1) — одна реализация для сервера и охранников. Принятые миграции 0001–0033 не меняются (ADR-002).

-- ---------------------------------------------------------------- Права

-- candidate.approve и risk.accept — руководитель тендера, candidate.release — инженер тендера (ADR-006 §3, D-033
-- В-13-7); только активный человек с той же глобальной ролью; модель и MCP не получают (I12).
-- Таблица повторяет packages/core/src/capabilities.ts.
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
                              'candidate.create'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm',
                              'finding.accept_risk', 'source_priority.manage', 'template.manage', 'candidate.approve', 'risk.accept'];
  END IF;
  IF v_role = 'engineer' THEN
    v_caps := v_caps || ARRAY['candidate.release'];
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

-- ---------------------------------------------------------------- Решение по событию входов (удержание)

-- Предмет — событие этапа; «не влияет» / «влияет» и причина; решает человек с hold.resolve. Событий барьера решение
-- не порождает (state-machines §1.1, R01-07): его вставляет только команда удержания, а не emitStageEvents.
ALTER TABLE decision DROP CONSTRAINT decision_decision_type_check;
ALTER TABLE decision
  ADD CONSTRAINT decision_decision_type_check CHECK (decision_type IN (
    'import_item_disposition', 'requirement_decision', 'finding_resolution', 'finding_risk_acceptance', 'discrepancy_decision',
    'input_event_disposition')),
  ADD CONSTRAINT decision_input_event_shape CHECK (
    decision_type <> 'input_event_disposition'
    OR (stage_id IS NOT NULL AND basis_fragment_ids = '{}' AND subject_type = 'stage_input_event'
        AND statement IN ('не влияет', 'влияет') AND supersedes_decision_id IS NULL));

CREATE OR REPLACE FUNCTION decision_author_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cap text;
BEGIN
  IF NEW.decision_type = 'input_event_disposition' THEN
    IF NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'hold.resolve') THEN
      RAISE EXCEPTION 'решение по событию входов принимает руководитель тендера (hold.resolve)' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM stage_input_event e JOIN tender_stage s ON s.id = e.stage_id
                    WHERE e.id = NEW.subject_id AND e.stage_id = NEW.stage_id AND s.tender_id = NEW.tender_id) THEN
      RAISE EXCEPTION 'decision: предмет решения — событие входов этого этапа' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
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

-- ---------------------------------------------------------------- Покрытие событий кандидатом (state-machines §1.1)

-- Событие касается кандидата: любое, кроме правки поля чужого приложения (D-032 В-12-9).
CREATE FUNCTION stage_event_affects(p_candidate uuid, p_event uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT e.event_type <> 'draft_field_changed'
      OR EXISTS (SELECT 1 FROM draft_field_version v
                   JOIN candidate_input ci ON ci.candidate_id = p_candidate AND ci.kind = 'application_draft' AND ci.ref_id = v.draft_id
                  WHERE v.id = e.ref_id)
    FROM stage_input_event e WHERE e.id = p_event
$$;

-- Редакция есть в ревизии набора источников — включена, унаследована или исключена с причиной.
CREATE FUNCTION source_set_has_revision(p_set_revision uuid, p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM source_set_item i WHERE i.source_set_revision_id = p_set_revision AND i.document_revision_id = p_revision)
$$;

-- Исход элемента партии покрыт (state-machines §3.1): зарегистрированный и дубликат — редакция в наборе;
-- отказ — решение руководителя о неприменимости или покрытый элемент повторного импорта.
CREATE FUNCTION import_item_covered(p_set_revision uuid, p_item uuid, p_depth int DEFAULT 0) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  i import_item%ROWTYPE;
BEGIN
  SELECT * INTO i FROM import_item WHERE id = p_item;
  IF NOT FOUND OR p_depth > 50 THEN
    RETURN false;
  END IF;
  IF i.status IN ('registered', 'duplicate') THEN
    RETURN source_set_has_revision(p_set_revision, i.document_revision_id);
  END IF;
  IF i.status IN ('rejected', 'skipped_partial') THEN
    IF i.resolution = 'not_applicable' THEN
      RETURN true;
    END IF;
    IF i.resolution = 'reimported' THEN
      RETURN import_item_covered(p_set_revision, i.resolved_by_item_id, p_depth + 1);
    END IF;
  END IF;
  RETURN false;
END;
$$;

-- Покрыто ли событие составом кандидата. Расчёт и содержание — числовыми базами транзакции создания кандидата;
-- источники — составом снимка: числа снимка актуальность не подтверждают, кроме входов, отбор которых правило снимка
-- уже выполнило при его создании (прогон распознавания — предпочтительный на момент снимка, 05a; вопросы–ответы —
-- последние ревизии на момент снимка). Неизвестный тип — не покрыт.
CREATE FUNCTION stage_event_covered(p_candidate uuid, p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c  release_candidate%ROWTYPE;
  e  stage_input_event%ROWTYPE;
  sc evidence_scope%ROWTYPE;
  v_revision uuid;
  v_run_created timestamptz;
  v_session uuid;
  v_seq int;
BEGIN
  SELECT * INTO c FROM release_candidate WHERE id = p_candidate;
  SELECT * INTO e FROM stage_input_event WHERE id = p_event;
  IF c.id IS NULL OR e.id IS NULL OR e.stage_id <> c.stage_id THEN
    RETURN false;
  END IF;
  IF e.event_type = 'calculation_revision_added' THEN
    RETURN e.seq <= c.calculation_baseline_version;
  END IF;
  IF e.event_type IN ('decision_recorded', 'draft_field_changed') THEN
    RETURN e.seq <= c.content_baseline_version;
  END IF;
  SELECT * INTO sc FROM evidence_scope WHERE id = c.evidence_scope_id;
  CASE e.event_type
    WHEN 'document_revision_registered' THEN
      RETURN source_set_has_revision(sc.source_set_revision_id, e.ref_id);
    WHEN 'recognition_run_completed' THEN
      SELECT r.document_revision_id, r.created_at INTO v_revision, v_run_created FROM recognition_run r WHERE r.id = e.ref_id;
      IF v_revision IS NULL THEN
        RETURN false;
      END IF;
      IF EXISTS (SELECT 1 FROM source_set_item i WHERE i.source_set_revision_id = sc.source_set_revision_id
                    AND i.document_revision_id = v_revision AND i.inclusion = 'excluded_not_applicable') THEN
        RETURN true;
      END IF;
      RETURN EXISTS (
        SELECT 1 FROM evidence_scope_item u LEFT JOIN recognition_run r ON r.id = u.recognition_run_id
         WHERE u.scope_id = sc.id AND u.unit_type = 'document_recognition' AND u.document_revision_id = v_revision
           AND (u.recognition_run_id = e.ref_id
                OR (r.id IS NOT NULL AND (r.created_at, r.id) > (v_run_created, e.ref_id))
                OR e.seq <= sc.input_version));
    WHEN 'import_accepted' THEN
      IF NOT EXISTS (SELECT 1 FROM import_batch b WHERE b.id = e.ref_id AND b.status IN ('completed', 'completed_with_errors'))
         OR NOT EXISTS (SELECT 1 FROM import_item i WHERE i.batch_id = e.ref_id) THEN
        RETURN false;
      END IF;
      RETURN NOT EXISTS (SELECT 1 FROM import_item i WHERE i.batch_id = e.ref_id AND NOT import_item_covered(sc.source_set_revision_id, i.id));
    WHEN 'communication_linked' THEN
      RETURN EXISTS (SELECT 1 FROM evidence_scope_item u WHERE u.scope_id = sc.id AND u.unit_type = 'mail_message' AND u.mail_message_id = e.ref_id)
          OR EXISTS (SELECT 1 FROM mail_message_tender t WHERE t.message_id = e.ref_id AND t.tender_id = c.tender_id
                        AND t.status = 'unlinked' AND t.updated_at <= c.created_at);
    WHEN 'transcript_revision_added' THEN
      SELECT t.session_id, t.seq INTO v_session, v_seq FROM transcript_revision t WHERE t.id = e.ref_id;
      RETURN EXISTS (SELECT 1 FROM evidence_scope_item u JOIN transcript_revision t ON t.id = u.transcript_revision_id
                      WHERE u.scope_id = sc.id AND u.unit_type = 'transcript_revision' AND t.session_id = v_session AND t.seq >= v_seq);
    WHEN 'qa_form_added' THEN
      RETURN e.seq <= sc.input_version;
    WHEN 'source_set_changed' THEN
      RETURN EXISTS (SELECT 1 FROM source_set_revision changed JOIN source_set_revision base ON base.id = sc.source_set_revision_id
                      WHERE changed.id = e.ref_id AND changed.source_set_id = base.source_set_id AND changed.seq <= base.seq);
    ELSE
      RETURN false;
  END CASE;
END;
$$;

-- ---------------------------------------------------------------- Кандидат: статусы этапа 13

ALTER TABLE release_candidate DROP CONSTRAINT release_candidate_status_check;
ALTER TABLE release_candidate
  ADD CONSTRAINT release_candidate_status_check CHECK (status IN (
    'assembling', 'assembly_failed', 'ready_for_approval', 'approved', 'returned', 'released', 'superseded'));
ALTER TABLE release_candidate DROP CONSTRAINT release_candidate_ready_shape;
ALTER TABLE release_candidate
  ADD CONSTRAINT release_candidate_ready_shape CHECK (
    (status IN ('ready_for_approval', 'approved', 'returned', 'released', 'superseded'))
      = (manifest_blob_sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL AND converter_version IS NOT NULL));

-- ---------------------------------------------------------------- Согласование

CREATE TABLE approval (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id           uuid NOT NULL,
  tender_id              uuid NOT NULL,
  stage_id               uuid NOT NULL,
  candidate_content_hash text NOT NULL CHECK (candidate_content_hash ~ '^[0-9a-f]{64}$'),
  input_version          bigint NOT NULL CHECK (input_version >= 0),
  gate                   jsonb NOT NULL CHECK (jsonb_typeof(gate) = 'object'),
  accepted_risk_ids      uuid[] NOT NULL DEFAULT '{}',
  comment                text CHECK (length(comment) BETWEEN 1 AND 2000),
  approved_by            uuid NOT NULL REFERENCES app_user (id),
  approved_at            timestamptz NOT NULL DEFAULT now(),
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'superseded')),
  revoked_by             uuid REFERENCES app_user (id),
  revoke_reason          text CHECK (length(revoke_reason) BETWEEN 1 AND 2000),
  ended_at               timestamptz,
  row_version            bigint NOT NULL DEFAULT 1,
  CONSTRAINT approval_candidate_fk FOREIGN KEY (candidate_id, tender_id) REFERENCES release_candidate (id, tender_id),
  CONSTRAINT approval_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT approval_id_candidate_key UNIQUE (id, candidate_id),
  CONSTRAINT approval_end_shape CHECK ((status = 'active') = (ended_at IS NULL)),
  CONSTRAINT approval_revoke_shape CHECK ((status = 'revoked') = (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE UNIQUE INDEX approval_one_active ON approval (candidate_id) WHERE status = 'active';
CREATE INDEX approval_candidate_idx ON approval (candidate_id, approved_at);

-- ---------------------------------------------------------------- Принятие бизнес-риска (D-033 В-13-3)

CREATE TABLE risk_acceptance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id    uuid NOT NULL,
  tender_id       uuid NOT NULL,
  stage_id        uuid NOT NULL,
  blocker_code    text NOT NULL CHECK (blocker_code IN ('REVIEW_UNCERTAIN', 'CRITICAL_FINDINGS_OPEN', 'QUESTIONS_UNANSWERED', 'FIELDS_INCOMPLETE', 'NUMBERS_UNVERIFIED')),
  subject_type    text NOT NULL,
  subject_id      uuid NOT NULL,
  subject_key     text NOT NULL DEFAULT '' CHECK (length(subject_key) <= 200),
  subject_version bigint CHECK (subject_version > 0),
  reason          text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  accepted_by     uuid NOT NULL REFERENCES app_user (id),
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_acceptance_candidate_fk FOREIGN KEY (candidate_id, tender_id) REFERENCES release_candidate (id, tender_id),
  CONSTRAINT risk_acceptance_subject_key UNIQUE NULLS NOT DISTINCT (candidate_id, blocker_code, subject_type, subject_id, subject_key, subject_version),
  -- Код блокера — бизнес-класса D-033; предмет — свой для кода.
  CONSTRAINT risk_acceptance_subject_shape CHECK (
    subject_type = CASE blocker_code
      WHEN 'REVIEW_UNCERTAIN' THEN 'review_check_result'
      WHEN 'CRITICAL_FINDINGS_OPEN' THEN 'finding'
      WHEN 'QUESTIONS_UNANSWERED' THEN 'customer_question'
      WHEN 'FIELDS_INCOMPLETE' THEN 'field_version'
      WHEN 'NUMBERS_UNVERIFIED' THEN 'candidate_check' END
    AND (subject_version IS NOT NULL) = (subject_type IN ('finding', 'customer_question')))
);
CREATE INDEX risk_acceptance_candidate_idx ON risk_acceptance (candidate_id, accepted_at);

-- ---------------------------------------------------------------- Удержание готовности (state-machines §13)

CREATE TABLE readiness_hold (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id   uuid NOT NULL,
  tender_id      uuid NOT NULL,
  stage_id       uuid NOT NULL,
  input_event_id uuid NOT NULL REFERENCES stage_input_event (id),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_not_applicable', 'resolved_requires_new_candidate')),
  decision_id    uuid REFERENCES decision (id),
  resolved_by    uuid REFERENCES app_user (id),
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  row_version    bigint NOT NULL DEFAULT 1,
  CONSTRAINT readiness_hold_candidate_fk FOREIGN KEY (candidate_id, tender_id) REFERENCES release_candidate (id, tender_id),
  CONSTRAINT readiness_hold_key UNIQUE (candidate_id, input_event_id),
  CONSTRAINT readiness_hold_resolved_shape CHECK ((status = 'open') = (decision_id IS NULL AND resolved_by IS NULL AND resolved_at IS NULL))
);
CREATE INDEX readiness_hold_stage_idx ON readiness_hold (stage_id, status);

-- Касающиеся непокрытые события без решения «не влияет» для этого кандидата. Удержание с решением «влияет» события
-- не покрывает. Опирается на события, а не на наличие строк удержаний (R01-03).
CREATE FUNCTION candidate_uncovered_events(p_candidate uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT e.id FROM release_candidate c JOIN stage_input_event e ON e.stage_id = c.stage_id
   WHERE c.id = p_candidate
     AND NOT (e.event_class = 'calculation' AND e.seq <= c.calculation_baseline_version)
     AND NOT (e.event_class = 'content' AND e.seq <= c.content_baseline_version)
     AND stage_event_affects(c.id, e.id)
     AND NOT stage_event_covered(c.id, e.id)
     AND NOT EXISTS (SELECT 1 FROM readiness_hold h WHERE h.candidate_id = c.id AND h.input_event_id = e.id AND h.status = 'resolved_not_applicable')
   ORDER BY e.seq
$$;

-- ---------------------------------------------------------------- Возврат на доработку

CREATE TABLE candidate_return (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL UNIQUE,
  tender_id    uuid NOT NULL,
  reason       text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  hold_id      uuid REFERENCES readiness_hold (id),
  returned_by  uuid NOT NULL REFERENCES app_user (id),
  returned_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidate_return_candidate_fk FOREIGN KEY (candidate_id, tender_id) REFERENCES release_candidate (id, tender_id)
);

-- ---------------------------------------------------------------- Выпуск

CREATE TABLE release (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id                 uuid NOT NULL UNIQUE,
  approval_id                  uuid NOT NULL,
  tender_id                    uuid NOT NULL,
  stage_id                     uuid NOT NULL,
  mode                         text NOT NULL CHECK (mode IN ('test', 'production')),
  input_version                bigint NOT NULL CHECK (input_version >= 0),
  content_hash                 text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  release_manifest_blob_sha256 text NOT NULL REFERENCES blob (sha256),
  release_manifest_sha256      text NOT NULL CHECK (release_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  gate                         jsonb NOT NULL CHECK (jsonb_typeof(gate) = 'object'),
  released_by                  uuid NOT NULL REFERENCES app_user (id),
  released_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT release_candidate_fk FOREIGN KEY (candidate_id, tender_id) REFERENCES release_candidate (id, tender_id),
  CONSTRAINT release_approval_fk FOREIGN KEY (approval_id, candidate_id) REFERENCES approval (id, candidate_id),
  CONSTRAINT release_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id)
);
CREATE INDEX release_stage_idx ON release (stage_id, released_at DESC);

-- ---------------------------------------------------------------- Неснимаемые блокеры (вторая линия, D-033)

-- Первый неснимаемый блокер целостности или технический для согласования и выпуска: актуальность (§1.1), свежесть
-- каналов, прогон проверок (D-033 ут. 1), устаревшие основания полей (ут. 2), ограничения боевого режима (Q-01/X-01,
-- Q-08, Q-05). Сервер проверяет ту же матрицу полнее (с пунктами и бизнес-блокерами); здесь — запрет обхода.
CREATE FUNCTION candidate_gate_problem(p_candidate uuid) RETURNS text
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
    IF EXISTS (SELECT 1 FROM calculation_revision r WHERE r.id = c.calculation_revision_id AND r.kind = 'provisional') THEN
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
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------- Охранники

-- Переходы кандидата этапа 13 (state-machines §11): согласование, возврат, отзыв, выпуск, замена; содержимое, входы,
-- базы и режим неизменны (как в 0032).
CREATE OR REPLACE FUNCTION release_candidate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_version bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'assembling' OR NEW.row_version <> 1 OR NEW.manifest_sha256 IS NOT NULL OR NEW.superseded_by_candidate_id IS NOT NULL
       OR NEW.seq <> (SELECT coalesce(max(seq), 0) + 1 FROM release_candidate WHERE stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'release_candidate: кандидат создаётся «собирается» со следующим номером этапа' USING ERRCODE = '23514';
    END IF;
    IF NOT ('candidate.create' = ANY (tender_capabilities(NEW.created_by, NEW.tender_id))) THEN
      RAISE EXCEPTION 'release_candidate: кандидата собирает участник тендера с candidate.create' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM calculation_revision r WHERE r.id = NEW.calculation_revision_id AND r.stage_id = NEW.stage_id)
       OR NOT EXISTS (SELECT 1 FROM evidence_scope s WHERE s.id = NEW.evidence_scope_id AND s.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'release_candidate: ревизия расчёта и снимок области — этого этапа' USING ERRCODE = '23514';
    END IF;
    SELECT input_version INTO v_version FROM tender_stage WHERE id = NEW.stage_id;
    IF NEW.calculation_baseline_version > v_version OR NEW.content_baseline_version > v_version THEN
      RAISE EXCEPTION 'release_candidate: база актуальности — не позже текущей версии входов этапа' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.seq, NEW.mode, NEW.calculation_revision_id, NEW.evidence_scope_id, NEW.calculation_baseline_version,
      NEW.content_baseline_version, NEW.inputs_sha256, NEW.created_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.seq, OLD.mode, OLD.calculation_revision_id, OLD.evidence_scope_id, OLD.calculation_baseline_version,
      OLD.content_baseline_version, OLD.inputs_sha256, OLD.created_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'release_candidate: режим, входы и базы неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'release_candidate: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'assembling' AND NEW.status IN ('ready_for_approval', 'assembly_failed'))
       OR (OLD.status = 'ready_for_approval' AND NEW.status IN ('approved', 'returned', 'superseded'))
       OR (OLD.status = 'approved' AND NEW.status IN ('ready_for_approval', 'released', 'returned', 'superseded'))
       OR (OLD.status = 'returned' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'release_candidate: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'assembling'
     AND (NEW.converter_version, NEW.manifest_blob_sha256, NEW.manifest_sha256, NEW.failure_code, NEW.failure_detail, NEW.finished_at)
         IS DISTINCT FROM (OLD.converter_version, OLD.manifest_blob_sha256, OLD.manifest_sha256, OLD.failure_code, OLD.failure_detail, OLD.finished_at) THEN
    RAISE EXCEPTION 'release_candidate: содержимое собранного кандидата неизменно' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'assembling' AND NEW.status = 'ready_for_approval' AND NOT EXISTS (SELECT 1 FROM candidate_file f WHERE f.candidate_id = NEW.id AND f.role <> 'preview') THEN
    RAISE EXCEPTION 'release_candidate: готовый кандидат — с файлами' USING ERRCODE = '23514';
  END IF;
  -- Согласован — с действующим согласованием; отзыв, возврат и замена — без него.
  IF NEW.status = 'approved' AND NOT EXISTS (SELECT 1 FROM approval a WHERE a.candidate_id = NEW.id AND a.status = 'active') THEN
    RAISE EXCEPTION 'release_candidate: «согласован» — с действующим согласованием' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('ready_for_approval', 'returned', 'superseded') AND EXISTS (SELECT 1 FROM approval a WHERE a.candidate_id = NEW.id AND a.status = 'active') THEN
    RAISE EXCEPTION 'release_candidate: % — без действующего согласования', NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'returned' AND NOT EXISTS (SELECT 1 FROM candidate_return r WHERE r.candidate_id = NEW.id) THEN
    RAISE EXCEPTION 'release_candidate: возврат — с причиной' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'released' AND NOT EXISTS (SELECT 1 FROM release r WHERE r.candidate_id = NEW.id) THEN
    RAISE EXCEPTION 'release_candidate: «выпущен» — с записью выпуска' USING ERRCODE = '23514';
  END IF;
  -- Замена — более новым готовым кандидатом того же этапа и режима (D-033 В-13-6).
  IF NEW.status = 'superseded' AND NOT EXISTS (
       SELECT 1 FROM release_candidate n WHERE n.id = NEW.superseded_by_candidate_id AND n.stage_id = NEW.stage_id AND n.seq > NEW.seq
                                           AND n.mode = NEW.mode AND n.status = 'ready_for_approval') THEN
    RAISE EXCEPTION 'release_candidate: заменяет более новый готовый кандидат того же этапа и режима' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Согласование: вставка — человек с candidate.approve, кандидат «готов», хэш — его манифеста, неснимаемых блокеров нет;
-- принятые риски — этого кандидата. Меняются только поля завершения и только из «действует».
CREATE FUNCTION approval_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c release_candidate%ROWTYPE;
  v_problem text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO c FROM release_candidate WHERE id = NEW.candidate_id;
    IF NEW.status <> 'active' OR NEW.row_version <> 1 OR NEW.revoked_by IS NOT NULL OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'approval: согласование создаётся действующим' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.approved_by, NEW.stage_id, 'candidate.approve') THEN
      RAISE EXCEPTION 'approval: согласует руководитель тендера (candidate.approve)' USING ERRCODE = '42501';
    END IF;
    IF c.stage_id <> NEW.stage_id OR c.status <> 'ready_for_approval' OR c.manifest_sha256 IS DISTINCT FROM NEW.candidate_content_hash THEN
      RAISE EXCEPTION 'approval: согласуется готовый кандидат этого этапа с хэшем его манифеста' USING ERRCODE = '23514';
    END IF;
    v_problem := candidate_gate_problem(c.id);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'approval: неснимаемый блокер %', v_problem USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.accepted_risk_ids) x(id) LEFT JOIN risk_acceptance r ON r.id = x.id AND r.candidate_id = NEW.candidate_id WHERE r.id IS NULL) THEN
      RAISE EXCEPTION 'approval: принятые риски — этого кандидата' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.candidate_id, NEW.tender_id, NEW.stage_id, NEW.candidate_content_hash, NEW.input_version, NEW.gate, NEW.accepted_risk_ids,
      NEW.comment, NEW.approved_by, NEW.approved_at)
     IS DISTINCT FROM
     (OLD.id, OLD.candidate_id, OLD.tender_id, OLD.stage_id, OLD.candidate_content_hash, OLD.input_version, OLD.gate, OLD.accepted_risk_ids,
      OLD.comment, OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'approval: содержание согласования неизменно' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'active' OR NEW.status = 'active' OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'approval: завершается только действующее согласование' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM release r WHERE r.approval_id = NEW.id) THEN
    RAISE EXCEPTION 'approval: согласование выпуска не отзывается и не заменяется' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'revoked' AND NOT has_stage_capability(NEW.revoked_by, NEW.stage_id, 'candidate.approve') THEN
    RAISE EXCEPTION 'approval: отзывает руководитель тендера (candidate.approve)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approval_guard BEFORE INSERT OR UPDATE ON approval FOR EACH ROW EXECUTE FUNCTION approval_guard();
CREATE TRIGGER approval_no_delete BEFORE DELETE ON approval FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER approval_no_truncate BEFORE TRUNCATE ON approval FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Выпуск: человек с candidate.release; кандидат «согласован»; согласование действует, того же кандидата и содержимого;
-- режим кандидата; неснимаемых блокеров нет. Запись неизменна.
CREATE FUNCTION release_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c release_candidate%ROWTYPE;
  v_problem text;
BEGIN
  SELECT * INTO c FROM release_candidate WHERE id = NEW.candidate_id;
  IF NOT has_stage_capability(NEW.released_by, NEW.stage_id, 'candidate.release') THEN
    RAISE EXCEPTION 'release: выпускает инженер тендера (candidate.release)' USING ERRCODE = '42501';
  END IF;
  IF c.stage_id <> NEW.stage_id OR c.status <> 'approved' OR c.mode <> NEW.mode OR c.manifest_sha256 IS DISTINCT FROM NEW.content_hash THEN
    RAISE EXCEPTION 'release: выпускается согласованный кандидат этого этапа в его режиме и с его содержимым' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM approval a WHERE a.id = NEW.approval_id AND a.candidate_id = NEW.candidate_id AND a.status = 'active'
                    AND a.candidate_content_hash = NEW.content_hash) THEN
    RAISE EXCEPTION 'release: согласование — действующее, этого кандидата и содержимого' USING ERRCODE = '23514';
  END IF;
  v_problem := candidate_gate_problem(c.id);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'release: неснимаемый блокер %', v_problem USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_guard BEFORE INSERT ON release FOR EACH ROW EXECUTE FUNCTION release_guard();
CREATE TRIGGER release_immutable BEFORE UPDATE OR DELETE ON release FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER release_no_truncate BEFORE TRUNCATE ON release FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Принятие риска: человек с risk.accept; кандидат «готов»; предмет — пункт бизнес-блокера этого кандидата; у поля —
-- без неснимаемой проблемы (D-033 ут. 2). Запись неизменна.
CREATE FUNCTION risk_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c release_candidate%ROWTYPE;
  v_ok boolean;
BEGIN
  SELECT * INTO c FROM release_candidate WHERE id = NEW.candidate_id;
  IF NOT has_stage_capability(NEW.accepted_by, NEW.stage_id, 'risk.accept') THEN
    RAISE EXCEPTION 'risk_acceptance: риск принимает руководитель тендера (risk.accept)' USING ERRCODE = '42501';
  END IF;
  IF c.stage_id <> NEW.stage_id OR c.status <> 'ready_for_approval' THEN
    RAISE EXCEPTION 'risk_acceptance: риск принимается по готовому кандидату этого этапа' USING ERRCODE = '23514';
  END IF;
  v_ok := CASE NEW.subject_type
    WHEN 'finding' THEN EXISTS (SELECT 1 FROM finding f WHERE f.id = NEW.subject_id AND f.stage_id = c.stage_id AND f.severity = 'critical'
                                  AND f.status IN ('open', 'in_progress', 'stale') AND f.row_version = NEW.subject_version)
    WHEN 'customer_question' THEN EXISTS (SELECT 1 FROM customer_question q WHERE q.id = NEW.subject_id AND q.stage_id = c.stage_id
                                            AND q.status = 'sent' AND q.row_version = NEW.subject_version)
    WHEN 'review_check_result' THEN EXISTS (SELECT 1 FROM review_check_result x JOIN candidate_input ci ON ci.candidate_id = c.id AND ci.kind = 'review_run' AND ci.ref_id = x.run_id
                                              WHERE x.id = NEW.subject_id AND x.check_code = 'coverage' AND x.outcome = 'incomplete')
    WHEN 'field_version' THEN EXISTS (SELECT 1 FROM candidate_input ci WHERE ci.candidate_id = c.id AND ci.kind = 'field_version' AND ci.ref_id = NEW.subject_id)
                              AND field_version_basis_problem(c.stage_id, NEW.subject_id) IS NULL AND NOT field_version_invalidated(NEW.subject_id)
    WHEN 'candidate_check' THEN EXISTS (SELECT 1 FROM candidate_check k WHERE k.id = NEW.subject_id AND k.candidate_id = c.id
                                          AND k.code = 'numbers_match_calculation' AND k.outcome = 'unverified')
  END;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'risk_acceptance: предмет — текущий пункт бизнес-блокера этого кандидата' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER risk_acceptance_guard BEFORE INSERT ON risk_acceptance FOR EACH ROW EXECUTE FUNCTION risk_acceptance_guard();
CREATE TRIGGER risk_acceptance_immutable BEFORE UPDATE OR DELETE ON risk_acceptance FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER risk_acceptance_no_truncate BEFORE TRUNCATE ON risk_acceptance FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Удержание: создаётся «открытым» для действующего кандидата и события того же этапа; решение — только из «открыто»,
-- человек с hold.resolve и решение input_event_disposition по этому событию; после решения неизменно.
CREATE FUNCTION readiness_hold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'readiness_hold: удержание создаётся открытым' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM release_candidate c JOIN stage_input_event e ON e.stage_id = c.stage_id
                    WHERE c.id = NEW.candidate_id AND e.id = NEW.input_event_id AND c.stage_id = NEW.stage_id
                      AND c.status IN ('assembling', 'ready_for_approval', 'approved', 'released')) THEN
      RAISE EXCEPTION 'readiness_hold: событие и действующий кандидат одного этапа' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.candidate_id, NEW.tender_id, NEW.stage_id, NEW.input_event_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.candidate_id, OLD.tender_id, OLD.stage_id, OLD.input_event_id, OLD.created_at)
     OR OLD.status <> 'open' OR NEW.status = 'open' OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'readiness_hold: решается только открытое удержание, один раз' USING ERRCODE = '55000';
  END IF;
  IF NOT has_stage_capability(NEW.resolved_by, NEW.stage_id, 'hold.resolve') THEN
    RAISE EXCEPTION 'readiness_hold: решает руководитель тендера (hold.resolve)' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.decision_type = 'input_event_disposition'
                    AND d.subject_id = NEW.input_event_id AND d.decided_by = NEW.resolved_by
                    AND d.statement = CASE NEW.status WHEN 'resolved_not_applicable' THEN 'не влияет' ELSE 'влияет' END) THEN
    RAISE EXCEPTION 'readiness_hold: решение — по этому событию, тем же человеком, с тем же исходом' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER readiness_hold_guard BEFORE INSERT OR UPDATE ON readiness_hold FOR EACH ROW EXECUTE FUNCTION readiness_hold_guard();
CREATE TRIGGER readiness_hold_no_delete BEFORE DELETE ON readiness_hold FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER readiness_hold_no_truncate BEFORE TRUNCATE ON readiness_hold FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Возврат: человек с candidate.approve (по решению «влияет» — тот же руководитель с hold.resolve); кандидат «готов»
-- или «согласован» (согласование завершается в той же транзакции). Запись неизменна.
CREATE FUNCTION candidate_return_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM release_candidate c WHERE c.id = NEW.candidate_id AND c.status IN ('ready_for_approval', 'approved')
                    AND has_stage_capability(NEW.returned_by, c.stage_id, CASE WHEN NEW.hold_id IS NULL THEN 'candidate.approve' ELSE 'hold.resolve' END)) THEN
    RAISE EXCEPTION 'candidate_return: возвращает руководитель тендера готовый или согласованный кандидат' USING ERRCODE = '42501';
  END IF;
  IF NEW.hold_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM readiness_hold h WHERE h.id = NEW.hold_id AND h.candidate_id = NEW.candidate_id) THEN
    RAISE EXCEPTION 'candidate_return: удержание — этого кандидата' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER candidate_return_guard BEFORE INSERT ON candidate_return FOR EACH ROW EXECUTE FUNCTION candidate_return_guard();
CREATE TRIGGER candidate_return_immutable BEFORE UPDATE OR DELETE ON candidate_return FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER candidate_return_no_truncate BEFORE TRUNCATE ON candidate_return FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Согласованное состояние в конце транзакции: «согласован» — ровно одно действующее согласование; «выпущен» — запись
-- выпуска по действующему согласованию; действующее согласование — только у согласованного или выпущенного.
CREATE FUNCTION release_candidate_approval_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_candidate uuid;
  v_status text;
BEGIN
  IF TG_TABLE_NAME = 'release_candidate' THEN
    v_candidate := NEW.id;
  ELSE
    v_candidate := NEW.candidate_id;
  END IF;
  SELECT status INTO v_status FROM release_candidate WHERE id = v_candidate;
  IF (v_status IN ('approved', 'released')) <> EXISTS (SELECT 1 FROM approval a WHERE a.candidate_id = v_candidate AND a.status = 'active') THEN
    RAISE EXCEPTION 'release_candidate: «согласован» и «выпущен» — ровно с одним действующим согласованием' USING ERRCODE = '23514';
  END IF;
  IF v_status = 'released' AND NOT EXISTS (SELECT 1 FROM release r JOIN approval a ON a.id = r.approval_id AND a.status = 'active' WHERE r.candidate_id = v_candidate) THEN
    RAISE EXCEPTION 'release_candidate: выпуск — по действующему согласованию' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER release_candidate_approval_check AFTER UPDATE ON release_candidate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION release_candidate_approval_check();
CREATE CONSTRAINT TRIGGER approval_state_check AFTER INSERT OR UPDATE ON approval
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION release_candidate_approval_check();

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT ON release, risk_acceptance, candidate_return TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON approval, readiness_hold TO kontur_app;
