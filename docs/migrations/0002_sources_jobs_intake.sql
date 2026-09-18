-- 0002 — источники и редакции, импорт, очередь заданий, каналы поступления, барьер актуальности,
-- решения по элементам импорта, наборы источников (data-model §4.2, §4.3, §4.7, §4.12;
-- state-machines §1.1, §2, §3, §3.1, §5; ADR-003, ADR-004).

-- ---------------------------------------------------------------- Барьер актуальности

CREATE TABLE stage_input_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id      uuid NOT NULL REFERENCES tender_stage (id),
  seq           bigint NOT NULL CHECK (seq > 0),
  event_class   text NOT NULL CHECK (event_class IN ('source', 'calculation', 'content')),
  event_type    text NOT NULL CHECK (event_type IN (
                  'import_accepted', 'document_revision_registered', 'communication_linked',
                  'transcript_revision_added', 'qa_form_added', 'calculation_revision_added',
                  'decision_recorded', 'draft_field_changed', 'source_set_changed', 'recognition_run_completed')),
  ref_type      text NOT NULL,
  ref_id        uuid NOT NULL,
  actor_user_id uuid REFERENCES app_user (id),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_input_event_seq_key UNIQUE (stage_id, seq)
);
CREATE TRIGGER stage_input_event_append_only BEFORE UPDATE OR DELETE ON stage_input_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER stage_input_event_no_truncate BEFORE TRUNCATE ON stage_input_event
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- Вторая линия (R01-03): input_version растёт только на 1, событие вставляется с seq = новой версии.
CREATE FUNCTION tender_stage_input_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.input_version <> OLD.input_version AND NEW.input_version <> OLD.input_version + 1 THEN
    RAISE EXCEPTION 'input_version меняется только на 1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tender_stage_input_version_guard BEFORE UPDATE ON tender_stage
  FOR EACH ROW EXECUTE FUNCTION tender_stage_input_version_guard();

CREATE FUNCTION stage_input_event_seq_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seq <> (SELECT input_version FROM tender_stage WHERE id = NEW.stage_id) THEN
    RAISE EXCEPTION 'seq события должен равняться текущему input_version этапа' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stage_input_event_seq_guard BEFORE INSERT ON stage_input_event
  FOR EACH ROW EXECUTE FUNCTION stage_input_event_seq_guard();

-- ---------------------------------------------------------------- Хранилище и документы

CREATE TABLE blob (
  sha256      text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),
  media_type  text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER blob_immutable BEFORE UPDATE OR DELETE ON blob
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER blob_no_truncate BEFORE TRUNCATE ON blob
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE TABLE document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id   uuid NOT NULL REFERENCES tender (id),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  -- Ключ группировки редакций по наблюдаемому имени (нижний регистр, без пути).
  -- Предложение системы; инженер может перегруппировать (portal-api PATCH /documents).
  name_key    text NOT NULL,
  doc_type    text NOT NULL DEFAULT 'other' CHECK (doc_type IN ('tz', 'pd', 'rd', 'contract', 'boq', 'qa_form', 'letter', 'minutes', 'supplier_quote', 'other')),
  doc_code    text CHECK (length(doc_code) <= 100),
  scope_note  text CHECK (length(scope_note) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1
);
CREATE INDEX document_tender_name_idx ON document (tender_id, name_key);

CREATE TABLE document_revision (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id            uuid NOT NULL REFERENCES document (id),
  tender_id              uuid NOT NULL REFERENCES tender (id),
  blob_sha256            text NOT NULL REFERENCES blob (sha256),
  revision_seq           int NOT NULL CHECK (revision_seq > 0),
  revision_label         text,
  supersedes_revision_id uuid REFERENCES document_revision (id),
  received_at            timestamptz NOT NULL DEFAULT now(),
  registered_by          uuid REFERENCES app_user (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_revision_doc_blob_key UNIQUE (document_id, blob_sha256),
  CONSTRAINT document_revision_doc_seq_key UNIQUE (document_id, revision_seq),
  -- Одно содержимое в тендере — одна редакция: повторное получение даёт происхождение, а не новый документ (A14).
  CONSTRAINT document_revision_tender_blob_key UNIQUE (tender_id, blob_sha256)
);
CREATE TRIGGER document_revision_immutable BEFORE UPDATE OR DELETE ON document_revision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER document_revision_no_truncate BEFORE TRUNCATE ON document_revision
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Каналы поступления

CREATE TABLE intake_channel (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id               uuid NOT NULL REFERENCES tender (id),
  kind                    text NOT NULL CHECK (kind IN ('watched_folder', 'mail_sync', 'negotiation_sync')),
  -- Откуда приходят файлы в наблюдаемую папку: локально, клиент Яндекс Диска, сетевой ресурс SMB.
  origin                  text NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'yandex_disk', 'smb')),
  locator                 text NOT NULL CHECK (length(locator) BETWEEN 1 AND 1000),
  active                  boolean NOT NULL DEFAULT true,
  freshness_window        interval NOT NULL DEFAULT interval '15 minutes',
  scan_interval_seconds   int NOT NULL DEFAULT 60 CHECK (scan_interval_seconds BETWEEN 5 AND 86400),
  last_scan_started_at    timestamptz,
  last_successful_scan_at timestamptz,
  last_error_code         text,
  last_error_at           timestamptz,
  -- Файлы, ещё не прошедшие проверку стабильности на последнем скане: пока они есть, скан не «успешный».
  pending_unstable        int NOT NULL DEFAULT 0,
  disabled_reason         text,
  created_by              uuid NOT NULL REFERENCES app_user (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  row_version             bigint NOT NULL DEFAULT 1,
  CHECK (active OR disabled_reason IS NOT NULL)
);

-- Состояние файлов наблюдаемой папки между сканами: проверка стабильности и повторного обнаружения.
-- Производные данные (derived): можно пересобрать, источник истины — редакции и происхождения.
CREATE TABLE intake_file_state (
  channel_id      uuid NOT NULL REFERENCES intake_channel (id),
  rel_path        text NOT NULL,
  size_bytes      bigint NOT NULL,
  mtime_ms        bigint NOT NULL,
  first_seen_at   timestamptz NOT NULL,
  unchanged_since timestamptz NOT NULL,
  imported_size   bigint,
  imported_mtime  bigint,
  imported_sha256 text,
  missing_since   timestamptz,
  PRIMARY KEY (channel_id, rel_path)
);

-- ---------------------------------------------------------------- Импорт

CREATE TABLE import_batch (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id          uuid NOT NULL REFERENCES tender (id),
  stage_id           uuid REFERENCES tender_stage (id),
  source_kind        text NOT NULL CHECK (source_kind IN ('upload', 'watched_folder')),
  intake_channel_id  uuid REFERENCES intake_channel (id),
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed')),
  upload_name        text,
  upload_blob_sha256 text REFERENCES blob (sha256),
  failure_code       text,
  -- Состав партии известен (архив разобран, скан записал элементы): только после этого партию можно завершить.
  expanded_at        timestamptz,
  created_by         uuid REFERENCES app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  CHECK ((source_kind = 'watched_folder') = (intake_channel_id IS NOT NULL)),
  CHECK ((status = 'running') = (completed_at IS NULL))
);
CREATE INDEX import_batch_tender_idx ON import_batch (tender_id, created_at DESC);

-- frozen-after: после завершения партия не меняется.
CREATE FUNCTION import_batch_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'running' THEN
    RAISE EXCEPTION 'import_batch (frozen-after): партия завершена, операция % запрещена', TG_OP USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_batch_guard BEFORE UPDATE OR DELETE ON import_batch
  FOR EACH ROW EXECUTE FUNCTION import_batch_guard();

CREATE TABLE import_item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id               uuid NOT NULL REFERENCES import_batch (id),
  tender_id              uuid NOT NULL REFERENCES tender (id),
  member_path            text NOT NULL,
  observed_name          text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'skipped_partial', 'rejected', 'registered', 'duplicate')),
  reject_reason          text CHECK (reject_reason IN ('path_traversal', 'size_limit', 'type_not_allowed', 'unstable_file', 'corrupt')),
  reject_detail          text,
  size_bytes             bigint,
  blob_sha256            text REFERENCES blob (sha256),
  document_revision_id   uuid REFERENCES document_revision (id),
  resolution             text NOT NULL DEFAULT 'none' CHECK (resolution IN ('none', 'reimported', 'not_applicable')),
  resolved_by_item_id    uuid REFERENCES import_item (id),
  resolution_decision_id uuid,
  resolved_by            uuid REFERENCES app_user (id),
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  row_version            bigint NOT NULL DEFAULT 1,
  CONSTRAINT import_item_member_key UNIQUE (batch_id, member_path),
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CHECK (status NOT IN ('registered', 'duplicate') OR (blob_sha256 IS NOT NULL AND document_revision_id IS NOT NULL)),
  CHECK (resolution = 'none' OR status IN ('rejected', 'skipped_partial')),
  CHECK ((resolution = 'reimported') = (resolved_by_item_id IS NOT NULL)),
  CHECK ((resolution = 'not_applicable') = (resolution_decision_id IS NOT NULL))
);
CREATE INDEX import_item_tender_idx ON import_item (tender_id);

-- Пока партия выполняется, меняется статус элемента. После завершения — только исход
-- (resolution) и только один раз: технический отказ остаётся в истории (R01-09).
CREATE FUNCTION import_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  batch_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import_item: удаление запрещено' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO batch_status FROM import_batch WHERE id = OLD.batch_id;
  IF batch_status = 'running' THEN
    IF OLD.resolution <> NEW.resolution THEN
      RAISE EXCEPTION 'import_item: исход задаётся после завершения партии' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.resolution <> 'none'
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.reject_reason IS DISTINCT FROM OLD.reject_reason
     OR NEW.blob_sha256 IS DISTINCT FROM OLD.blob_sha256 OR NEW.document_revision_id IS DISTINCT FROM OLD.document_revision_id
     OR NEW.member_path <> OLD.member_path OR NEW.batch_id <> OLD.batch_id THEN
    RAISE EXCEPTION 'import_item (frozen-after): партия завершена, меняется только исход и только один раз' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_item_guard BEFORE UPDATE OR DELETE ON import_item
  FOR EACH ROW EXECUTE FUNCTION import_item_guard();

CREATE TABLE document_occurrence (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_revision_id uuid NOT NULL REFERENCES document_revision (id),
  tender_id            uuid NOT NULL REFERENCES tender (id),
  source_kind          text NOT NULL CHECK (source_kind IN ('upload', 'watched_folder', 'archive_member', 'yandex_disk', 'smb', 'mail_attachment', 'rdweb_export')),
  source_locator       text NOT NULL,
  observed_name        text NOT NULL,
  observed_at          timestamptz NOT NULL DEFAULT now(),
  import_item_id       uuid REFERENCES import_item (id),
  intake_channel_id    uuid REFERENCES intake_channel (id)
);
CREATE INDEX document_occurrence_revision_idx ON document_occurrence (document_revision_id);
CREATE TRIGGER document_occurrence_append_only BEFORE UPDATE OR DELETE ON document_occurrence
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER document_occurrence_no_truncate BEFORE TRUNCATE ON document_occurrence
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- ---------------------------------------------------------------- Решения

CREATE TABLE decision (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id              uuid NOT NULL REFERENCES tender (id),
  stage_id               uuid REFERENCES tender_stage (id),
  subject_type           text NOT NULL,
  subject_id             uuid NOT NULL,
  -- Этап 03 вводит решения по элементам импорта; остальные виды добавляются миграциями этапов 08–13.
  decision_type          text NOT NULL CHECK (decision_type IN ('import_item_disposition')),
  statement              text NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  rationale              text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 4000),
  basis_fragment_ids     uuid[] NOT NULL DEFAULT '{}',
  decided_by             uuid NOT NULL REFERENCES app_user (id),
  supersedes_decision_id uuid REFERENCES decision (id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER decision_immutable BEFORE UPDATE OR DELETE ON decision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER decision_no_truncate BEFORE TRUNCATE ON decision
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Вторая линия ADR-006 §4: решение принимает только активный человек — руководитель этого тендера.
CREATE FUNCTION decision_author_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER decision_author_guard BEFORE INSERT ON decision
  FOR EACH ROW EXECUTE FUNCTION decision_author_guard();

ALTER TABLE import_item ADD CONSTRAINT import_item_decision_fk FOREIGN KEY (resolution_decision_id) REFERENCES decision (id);

-- ---------------------------------------------------------------- Наборы источников

CREATE TABLE source_set (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id   uuid NOT NULL REFERENCES tender_stage (id),
  purpose    text NOT NULL CHECK (purpose IN ('working', 'review', 'release')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_set_stage_purpose_key UNIQUE (stage_id, purpose)
);

CREATE TABLE source_set_revision (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_set_id    uuid NOT NULL REFERENCES source_set (id),
  seq              int NOT NULL CHECK (seq > 0),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen')),
  base_revision_id uuid REFERENCES source_set_revision (id),
  frozen_at        timestamptz,
  frozen_by        uuid REFERENCES app_user (id),
  content_hash     text,
  created_by       uuid NOT NULL REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  row_version      bigint NOT NULL DEFAULT 1,
  CONSTRAINT source_set_revision_seq_key UNIQUE (source_set_id, seq),
  CHECK ((status = 'frozen') = (frozen_at IS NOT NULL AND content_hash IS NOT NULL))
);
-- Одна draft-ревизия на набор.
CREATE UNIQUE INDEX source_set_revision_one_draft ON source_set_revision (source_set_id) WHERE status = 'draft';

CREATE FUNCTION source_set_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'frozen' THEN
    RAISE EXCEPTION 'source_set_revision (frozen-after): операция % запрещена', TG_OP USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_set_revision_guard BEFORE UPDATE OR DELETE ON source_set_revision
  FOR EACH ROW EXECUTE FUNCTION source_set_revision_guard();

CREATE TABLE source_set_item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_set_revision_id uuid NOT NULL REFERENCES source_set_revision (id),
  document_revision_id   uuid NOT NULL REFERENCES document_revision (id),
  inclusion              text NOT NULL CHECK (inclusion IN ('included', 'excluded_not_applicable', 'inherited')),
  decided_by             uuid REFERENCES app_user (id),
  reason                 text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_set_item_key UNIQUE (source_set_revision_id, document_revision_id),
  CHECK (inclusion <> 'excluded_not_applicable' OR (reason IS NOT NULL AND length(reason) > 0))
);

CREATE FUNCTION source_set_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rev uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.source_set_revision_id ELSE NEW.source_set_revision_id END;
BEGIN
  IF (SELECT status FROM source_set_revision WHERE id = rev) <> 'draft' THEN
    RAISE EXCEPTION 'source_set_item: состав замороженной ревизии не меняется' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER source_set_item_guard BEFORE INSERT OR UPDATE OR DELETE ON source_set_item
  FOR EACH ROW EXECUTE FUNCTION source_set_item_guard();

-- ---------------------------------------------------------------- Очередь заданий (ADR-004)

CREATE TABLE job (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL,
  dedupe_key         text,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  resource_class     text NOT NULL DEFAULT 'default' CHECK (resource_class IN ('default', 'network', 'gpu')),
  priority           int NOT NULL DEFAULT 0,
  run_after          timestamptz NOT NULL DEFAULT now(),
  attempts           int NOT NULL DEFAULT 0,
  max_attempts       int NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  lease_token        uuid,
  locked_by          text,
  locked_until       timestamptz,
  cancel_requested   boolean NOT NULL DEFAULT false,
  last_error_code    text,
  last_error_message text,
  tender_id          uuid REFERENCES tender (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  CHECK ((status = 'running') = (lease_token IS NOT NULL))
);
CREATE UNIQUE INDEX job_dedupe_active_key ON job (dedupe_key) WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL;
CREATE INDEX job_claim_idx ON job (priority DESC, run_after) WHERE status = 'queued';
CREATE INDEX job_running_idx ON job (locked_until) WHERE status = 'running';

CREATE TABLE resource_slot (
  slot_key      text PRIMARY KEY CHECK (slot_key IN ('gpu')),
  holder_job_id uuid REFERENCES job (id),
  lease_token   uuid,
  locked_until  timestamptz
);
INSERT INTO resource_slot (slot_key) VALUES ('gpu');

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT ON stage_input_event, blob, document_revision, document_occurrence, decision TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON document, intake_channel, import_batch, import_item, source_set_revision, job TO kontur_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON intake_file_state, source_set_item TO kontur_app;
GRANT SELECT, INSERT ON source_set TO kontur_app;
GRANT SELECT, UPDATE ON resource_slot TO kontur_app;
GRANT SELECT ON stage_input_event, blob, document, document_revision, document_occurrence, intake_channel, intake_file_state,
  import_batch, import_item, decision, source_set, source_set_revision, source_set_item, job, resource_slot TO kontur_backup;
