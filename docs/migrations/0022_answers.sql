-- Этап 08a: ответное ядро и диалоги (D-019, D-027; проект — docs/architecture/08a-answer-core-design.md §5, §6, §9).
-- Диалоги, сообщения и состояние хода — в PostgreSQL; стриминга нет: ответ появляется сообщением только в транзакции
-- завершения прогона. Непроверенный текст модели (черновик, отклонённые утверждения, сводка) не хранится — только
-- хэши. Пакет оснований и утверждения пишутся только пока прогон выполняется; основание — фрагмент области своего
-- прогона поиска; текст утверждения — только у показанного. Словарь статусов ответа отделён от результатов проверки.

-- ---------------------------------------------------------------- Права второй линии

-- Право на договор: действующая выдача contract.read (явная или автору договора, D-022).
CREATE FUNCTION contract_readable_by(p_user uuid, p_contract uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM contract_access a
                  WHERE a.contract_id = p_contract AND a.user_id = p_user AND a.capability = 'contract.read' AND a.revoked_at IS NULL)
$$;

-- ---------------------------------------------------------------- Диалог

CREATE TABLE dialog (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_kind      text NOT NULL CHECK (context_kind IN ('tender', 'contract')),
  tender_id         uuid REFERENCES tender (id),
  contract_id       uuid REFERENCES contract (id),
  stage_id          uuid,
  mode              text NOT NULL CHECK (mode IN ('working', 'review', 'contract')),
  evidence_scope_id uuid,
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_by        uuid NOT NULL REFERENCES app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dialog_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT dialog_scope_fk FOREIGN KEY (evidence_scope_id, tender_id) REFERENCES evidence_scope (id, tender_id),
  CONSTRAINT dialog_context_shape CHECK (
    (context_kind = 'tender' AND tender_id IS NOT NULL AND contract_id IS NULL AND stage_id IS NOT NULL
      AND ((mode = 'working' AND evidence_scope_id IS NULL) OR (mode = 'review' AND evidence_scope_id IS NOT NULL)))
    OR (context_kind = 'contract' AND contract_id IS NOT NULL AND tender_id IS NULL AND stage_id IS NULL
      AND evidence_scope_id IS NULL AND mode = 'contract'))
);
CREATE INDEX dialog_owner_idx ON dialog (created_by, created_at DESC);

-- Диалог создаёт человек с правом читать контекст: участник тендера (tender.read) или держатель contract.read;
-- снимок области — того же этапа.
CREATE FUNCTION dialog_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = NEW.created_by AND u.kind = 'human') THEN
    RAISE EXCEPTION 'dialog: диалог создаёт человек' USING ERRCODE = '42501';
  END IF;
  IF NEW.context_kind = 'tender' THEN
    IF NOT ('tender.read' = ANY (tender_capabilities(NEW.created_by, NEW.tender_id))) THEN
      RAISE EXCEPTION 'dialog: нет права читать тендер' USING ERRCODE = '42501';
    END IF;
    IF NEW.mode = 'review' AND NOT EXISTS (SELECT 1 FROM evidence_scope s WHERE s.id = NEW.evidence_scope_id AND s.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'dialog: снимок области другого этапа' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT contract_readable_by(NEW.created_by, NEW.contract_id) THEN
    RAISE EXCEPTION 'dialog: нет права contract.read' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dialog_insert_guard BEFORE INSERT ON dialog FOR EACH ROW EXECUTE FUNCTION dialog_insert_guard();
CREATE TRIGGER dialog_immutable BEFORE UPDATE OR DELETE ON dialog FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER dialog_no_truncate BEFORE TRUNCATE ON dialog FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Сообщения

CREATE TABLE dialog_message (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dialog_id     uuid NOT NULL REFERENCES dialog (id),
  seq           int NOT NULL CHECK (seq > 0),
  role          text NOT NULL CHECK (role IN ('user', 'assistant')),
  text          text NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  created_by    uuid REFERENCES app_user (id),
  answer_run_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dialog_message_seq_key UNIQUE (dialog_id, seq),
  CONSTRAINT dialog_message_run_key UNIQUE (answer_run_id),
  CONSTRAINT dialog_message_id_dialog_key UNIQUE (id, dialog_id),
  CONSTRAINT dialog_message_author_shape CHECK ((role = 'user') = (created_by IS NOT NULL)),
  CONSTRAINT dialog_message_run_shape CHECK ((role = 'assistant') = (answer_run_id IS NOT NULL)),
  CONSTRAINT dialog_message_question_len CHECK (role <> 'user' OR length(text) <= 4000)
);

-- ---------------------------------------------------------------- Прогон ответа

CREATE TABLE answer_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dialog_id           uuid NOT NULL REFERENCES dialog (id),
  seq                 int NOT NULL CHECK (seq > 0),
  question_message_id uuid NOT NULL,
  search_run_id       uuid NOT NULL REFERENCES search_run (id),
  requested_by        uuid NOT NULL REFERENCES app_user (id),
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  -- Словарь статусов ответа (AD-08a-2) — отдельный от результатов проверки (`review_check_result.outcome`).
  answer_status       text CHECK (answer_status IN ('confirmed_by_citations', 'citations_disagree', 'needs_clarification', 'not_found_in_scope',
                                                     'incomplete_processing', 'no_data', 'not_provided', 'confirmed_discrepancy')),
  incomplete_reason   text CHECK (incomplete_reason IN ('insufficient_evidence', 'model_failed', 'draft_invalid', 'model_disabled', 'scope_incomplete',
                                                         'no_readable_evidence')),
  plan                jsonb NOT NULL,
  planner_version     text NOT NULL CHECK (length(planner_version) BETWEEN 1 AND 40),
  provider_id         text CHECK (provider_id IN ('fake', 'openai_compatible')),
  model_id            text CHECK (length(model_id) <= 200),
  model_version       text CHECK (length(model_version) <= 200),
  prompt_version      text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 40),
  prompt_sha256       text NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  verifier_mode       text NOT NULL CHECK (verifier_mode IN ('off', 'same_model')),
  verification_level  text CHECK (verification_level IN ('none', 'hard_checks', 'model')),
  inference_config    jsonb,
  config_sha256       text CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  input_sha256        text CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  draft_sha256        text CHECK (draft_sha256 ~ '^[0-9a-f]{64}$'),
  repairs             int NOT NULL DEFAULT 0 CHECK (repairs BETWEEN 0 AND 2),
  coverage            jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt             int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  job_id              uuid REFERENCES job (id),
  failure_code        text CHECK (length(failure_code) <= 60),
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  row_version         int NOT NULL DEFAULT 1,
  CONSTRAINT answer_run_seq_key UNIQUE (dialog_id, seq),
  CONSTRAINT answer_run_question_key UNIQUE (question_message_id),
  CONSTRAINT answer_run_search_key UNIQUE (search_run_id),
  CONSTRAINT answer_run_question_fk FOREIGN KEY (question_message_id, dialog_id) REFERENCES dialog_message (id, dialog_id),
  CONSTRAINT answer_run_status_shape CHECK (
    CASE status
      WHEN 'queued' THEN started_at IS NULL AND finished_at IS NULL AND failure_code IS NULL AND answer_status IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND finished_at IS NULL AND failure_code IS NULL AND answer_status IS NULL
      WHEN 'failed' THEN finished_at IS NOT NULL AND failure_code IS NOT NULL AND answer_status IS NULL
      ELSE started_at IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NULL AND answer_status IS NOT NULL AND verification_level IS NOT NULL
    END),
  CONSTRAINT answer_run_incomplete_shape CHECK ((incomplete_reason IS NOT NULL) = (answer_status IS NOT DISTINCT FROM 'incomplete_processing')),
  -- Ответное ядро 08a не присваивает: «не предусмотрено» не выводится из ненайденного (I07), подтверждённое
  -- разногласие — решение человека этапа 09.
  CONSTRAINT answer_run_not_assigned CHECK (answer_status IS NULL OR answer_status NOT IN ('not_provided', 'confirmed_discrepancy'))
);
-- Один незавершённый прогон на диалог: новый вопрос — после ответа на предыдущий.
CREATE UNIQUE INDEX answer_run_pending_key ON answer_run (dialog_id) WHERE status IN ('queued', 'running');

ALTER TABLE dialog_message ADD CONSTRAINT dialog_message_run_fk FOREIGN KEY (answer_run_id) REFERENCES answer_run (id) DEFERRABLE INITIALLY DEFERRED;

-- Сообщение: номер — следующий в диалоге; вопрос пишет только автор диалога; ответ — только для своего прогона, который
-- в этой же транзакции завершается (вставка ответа допустима, пока прогон выполняется).
CREATE FUNCTION dialog_message_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_dialog dialog%ROWTYPE;
  v_last   int;
  v_run    answer_run%ROWTYPE;
BEGIN
  SELECT * INTO v_dialog FROM dialog WHERE id = NEW.dialog_id;
  PERFORM pg_advisory_xact_lock(hashtext('dialog_message'), hashtext(NEW.dialog_id::text));
  SELECT max(seq) INTO v_last FROM dialog_message WHERE dialog_id = NEW.dialog_id;
  IF NEW.seq <> coalesce(v_last, 0) + 1 THEN
    RAISE EXCEPTION 'dialog_message: номер сообщения — следующий в диалоге' USING ERRCODE = '23514';
  END IF;
  IF NEW.role = 'user' THEN
    IF NEW.created_by IS DISTINCT FROM v_dialog.created_by THEN
      RAISE EXCEPTION 'dialog_message: вопрос пишет только автор диалога' USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT * INTO v_run FROM answer_run WHERE id = NEW.answer_run_id;
    IF v_run.id IS NULL OR v_run.dialog_id <> NEW.dialog_id OR v_run.status <> 'running' THEN
      RAISE EXCEPTION 'dialog_message: ответ — только для выполняющегося прогона этого диалога' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dialog_message_insert_guard BEFORE INSERT ON dialog_message FOR EACH ROW EXECUTE FUNCTION dialog_message_insert_guard();
CREATE TRIGGER dialog_message_immutable BEFORE UPDATE OR DELETE ON dialog_message FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER dialog_message_no_truncate BEFORE TRUNCATE ON dialog_message FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Прогон создаётся в состоянии queued: номер — следующий в диалоге; вопрос — сообщение автора этого диалога;
-- прогон поиска — того же контекста (тендер, этап, режим, снимок или договор) и того же автора.
CREATE FUNCTION answer_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_dialog dialog%ROWTYPE;
  v_msg    dialog_message%ROWTYPE;
  v_search search_run%ROWTYPE;
  v_last   int;
BEGIN
  IF NEW.status <> 'queued' OR NEW.row_version <> 1 OR NEW.attempt <> 0 OR NEW.answer_status IS NOT NULL OR NEW.repairs <> 0 THEN
    RAISE EXCEPTION 'answer_run: прогон создаётся в состоянии queued' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_dialog FROM dialog WHERE id = NEW.dialog_id;
  SELECT * INTO v_msg FROM dialog_message WHERE id = NEW.question_message_id;
  IF v_msg.role IS DISTINCT FROM 'user' OR v_msg.created_by IS DISTINCT FROM v_dialog.created_by OR NEW.requested_by IS DISTINCT FROM v_dialog.created_by THEN
    RAISE EXCEPTION 'answer_run: вопрос — сообщение автора диалога' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_search FROM search_run WHERE id = NEW.search_run_id;
  IF v_search.requested_by IS DISTINCT FROM NEW.requested_by
     OR v_search.tender_id IS DISTINCT FROM v_dialog.tender_id
     OR v_search.contract_id IS DISTINCT FROM v_dialog.contract_id
     OR (v_dialog.context_kind = 'tender' AND (v_search.stage_id IS DISTINCT FROM v_dialog.stage_id OR v_search.mode IS DISTINCT FROM v_dialog.mode
         OR v_search.evidence_scope_id IS DISTINCT FROM v_dialog.evidence_scope_id)) THEN
    RAISE EXCEPTION 'answer_run: прогон поиска другого контекста или автора' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('answer_run'), hashtext(NEW.dialog_id::text));
  SELECT max(seq) INTO v_last FROM answer_run WHERE dialog_id = NEW.dialog_id;
  IF NEW.seq <> coalesce(v_last, 0) + 1 THEN
    RAISE EXCEPTION 'answer_run: номер хода — следующий в диалоге' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER answer_run_insert_guard BEFORE INSERT ON answer_run FOR EACH ROW EXECUTE FUNCTION answer_run_insert_guard();

-- Меняются только ход и итог; переходы — по машине состояний; после финала прогон неизменен (frozen-after).
CREATE FUNCTION answer_run_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.dialog_id, NEW.seq, NEW.question_message_id, NEW.search_run_id, NEW.requested_by, NEW.verifier_mode, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.dialog_id, OLD.seq, OLD.question_message_id, OLD.search_run_id, OLD.requested_by, OLD.verifier_mode, OLD.created_at) THEN
    RAISE EXCEPTION 'answer_run: условия прогона неизменны' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'answer_run: завершённый прогон неизменен' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'answer_run: row_version увеличивается на 1' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'running' AND NEW.status IN ('running', 'completed', 'failed'))
       OR (OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))) THEN
    RAISE EXCEPTION 'answer_run: недопустимый переход % → %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER answer_run_update_guard BEFORE UPDATE ON answer_run FOR EACH ROW EXECUTE FUNCTION answer_run_update_guard();
CREATE TRIGGER answer_run_no_delete BEFORE DELETE ON answer_run FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER answer_run_no_truncate BEFORE TRUNCATE ON answer_run FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Завершённый прогон имеет сообщение ответа (проверка на COMMIT: сообщение и статус — одной транзакцией).
CREATE FUNCTION answer_run_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM answer_run WHERE id = NEW.id;
  IF v_status = 'completed' AND NOT EXISTS (SELECT 1 FROM dialog_message m WHERE m.answer_run_id = NEW.id AND m.role = 'assistant') THEN
    RAISE EXCEPTION 'answer_run: завершённый прогон без сообщения ответа' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER answer_run_commit_check AFTER INSERT OR UPDATE ON answer_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION answer_run_commit_check();

-- ---------------------------------------------------------------- Пакет оснований и утверждения

CREATE TABLE answer_evidence (
  run_id       uuid NOT NULL REFERENCES answer_run (id),
  label        text NOT NULL CHECK (label ~ '^E[1-9][0-9]{0,2}$'),
  ordinal      int NOT NULL CHECK (ordinal > 0),
  fragment_id  uuid NOT NULL REFERENCES evidence_fragment (id),
  origin       text NOT NULL,
  version_note text NOT NULL CHECK (version_note IN ('current', 'superseded', 'conflict')),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  PRIMARY KEY (run_id, label),
  CONSTRAINT answer_evidence_fragment_key UNIQUE (run_id, fragment_id),
  CONSTRAINT answer_evidence_ordinal_key UNIQUE (run_id, ordinal),
  CONSTRAINT answer_evidence_label_shape CHECK (label = 'E' || ordinal)
);

-- Основание — фрагмент области своего прогона поиска (allowed_source_unit_ids, ADR-008 §4); пишется, пока прогон выполняется.
CREATE FUNCTION answer_evidence_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_units  uuid[];
  v_frag   evidence_fragment%ROWTYPE;
BEGIN
  SELECT r.status, s.allowed_source_unit_ids INTO v_status, v_units
    FROM answer_run r JOIN search_run s ON s.id = r.search_run_id WHERE r.id = NEW.run_id;
  IF v_status IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'answer_evidence: пакет пишется, пока прогон выполняется' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_frag FROM evidence_fragment WHERE id = NEW.fragment_id;
  IF NOT (v_frag.source_unit_id = ANY (v_units)) THEN
    RAISE EXCEPTION 'answer_evidence: фрагмент вне области прогона поиска' USING ERRCODE = '23514';
  END IF;
  IF NEW.origin IS DISTINCT FROM v_frag.origin THEN
    RAISE EXCEPTION 'answer_evidence: происхождение — как у фрагмента' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER answer_evidence_insert_guard BEFORE INSERT ON answer_evidence FOR EACH ROW EXECUTE FUNCTION answer_evidence_insert_guard();
CREATE TRIGGER answer_evidence_immutable BEFORE UPDATE OR DELETE ON answer_evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER answer_evidence_no_truncate BEFORE TRUNCATE ON answer_evidence FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE TABLE answer_claim (
  run_id          uuid NOT NULL REFERENCES answer_run (id),
  claim_no        int NOT NULL CHECK (claim_no BETWEEN 1 AND 40),
  kind            text NOT NULL CHECK (kind IN ('fact', 'amount', 'percentage', 'date', 'period', 'condition', 'comparison')),
  text_sha256     text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  text            text CHECK (length(text) BETWEEN 1 AND 600),
  labels          text[] NOT NULL,
  check_status    text NOT NULL CHECK (check_status IN ('passed', 'unsupported', 'contradicted')),
  issues          text[] NOT NULL DEFAULT '{}',
  verifier_status text CHECK (verifier_status IN ('supported', 'unsupported', 'contradicted', 'ambiguous')),
  final_status    text NOT NULL CHECK (final_status IN ('supported', 'unsupported', 'contradicted', 'ambiguous')),
  shown           boolean NOT NULL,
  citations       int[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, claim_no),
  CONSTRAINT answer_claim_shown_shape CHECK (shown = (final_status = 'supported')),
  -- Непроверенный текст не хранится: текст — только у показанного утверждения.
  CONSTRAINT answer_claim_text_shape CHECK ((text IS NOT NULL) = shown),
  CONSTRAINT answer_claim_passed_shape CHECK (NOT shown OR check_status = 'passed'),
  CONSTRAINT answer_claim_citations_shape CHECK (shown OR cardinality(citations) = 0)
);

-- Утверждение пишется, пока прогон выполняется; у показанного каждая метка — основание пакета этого прогона, а
-- хэш — от хранимого текста.
CREATE FUNCTION answer_claim_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM answer_run WHERE id = NEW.run_id) IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'answer_claim: утверждения пишутся, пока прогон выполняется' USING ERRCODE = '55000';
  END IF;
  IF NEW.shown THEN
    IF cardinality(NEW.labels) = 0 OR EXISTS (SELECT 1 FROM unnest(NEW.labels) l
                                              WHERE NOT EXISTS (SELECT 1 FROM answer_evidence e WHERE e.run_id = NEW.run_id AND e.label = l)) THEN
      RAISE EXCEPTION 'answer_claim: показанное утверждение цитирует только основания пакета' USING ERRCODE = '23514';
    END IF;
    IF NEW.text_sha256 <> encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'answer_claim: хэш не совпадает с текстом' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER answer_claim_insert_guard BEFORE INSERT ON answer_claim FOR EACH ROW EXECUTE FUNCTION answer_claim_insert_guard();
CREATE TRIGGER answer_claim_immutable BEFORE UPDATE OR DELETE ON answer_claim FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER answer_claim_no_truncate BEFORE TRUNCATE ON answer_claim FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT ON dialog, dialog_message, answer_evidence, answer_claim TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON answer_run TO kontur_app;
