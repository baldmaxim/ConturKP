-- 0017 — этап 07: почта, вопросы–ответы и переговоры как источники (D-025).
-- Письмо — не документ (AD-07-1): ящик → письмо (копия в одном ящике) → неизменяемые ревизии источника;
-- логическая коммуникация объединяет копии из разных ящиков, не сливая их (И-07-1); связь письма
-- с тендером — отдельная пара «письмо, тендер» со статусом, владельцем письма она не является.
-- Q&A и переговоры принадлежат тендеру (модель D-023 не меняется). Доказательства, поиск и снимок
-- области — миграция 0018. Физического удаления нет: DELETE роли приложения не выдаётся, охранники
-- запрещают удаление и TRUNCATE. Матрица — docs/architecture/07-mail-model-design.md §3, §13.

-- ---------------------------------------------------------------- Общие функции

-- Печать транзакции создания: состав неизменяемой ревизии (вложения, сегменты, фрагменты) дописывается
-- только транзакцией, создавшей ревизию, как единицы снимка области (0010).
CREATE FUNCTION stamp_creation_xact() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_xact := pg_current_xact_id();
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Ящик и выдачи (OD-07-2, OD-07-3)

-- Ящик — контекст доступа и интеграции. Регистрируется явно (OD-07-2); сканирования всех ящиков нет.
-- system = manual — ручной импорт EML; mailhub — ящик MailHub, автоматическое чтение которого ждёт X-03.
CREATE TABLE mailbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system              text NOT NULL CHECK (system IN ('manual', 'mailhub')),
  external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 200),
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by          uuid NOT NULL REFERENCES app_user (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         bigint NOT NULL DEFAULT 1,
  CONSTRAINT mailbox_account_key UNIQUE (system, external_account_id)
);

CREATE FUNCTION mailbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mailbox: ящик не удаляется — только архив' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.system <> OLD.system OR NEW.external_account_id <> OLD.external_account_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'mailbox: система, внешний идентификатор и автор ящика неизменны' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mailbox_guard BEFORE UPDATE OR DELETE ON mailbox
  FOR EACH ROW EXECUTE FUNCTION mailbox_guard();
CREATE TRIGGER mailbox_no_truncate BEFORE TRUNCATE ON mailbox
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

-- Выдачи по ящику — образец contract_access (D-022): явная строка на тройку «ящик, пользователь,
-- возможность». Связь письма с тендером права читать не даёт (OD-07-3). Выдачи ведёт администратор
-- (admin.mailbox); выдача действует при роли инженера или руководителя (packages/core).
CREATE TABLE mail_access (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id  uuid NOT NULL REFERENCES mailbox (id),
  user_id     uuid NOT NULL REFERENCES app_user (id),
  capability  text NOT NULL CHECK (capability IN ('mail.read', 'mail.import', 'mail.link', 'mail.manage')),
  granted_by  uuid NOT NULL REFERENCES app_user (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  uuid REFERENCES app_user (id),
  revoked_at  timestamptz,
  CONSTRAINT mail_access_revoke_shape CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX mail_access_active_key ON mail_access (mailbox_id, user_id, capability) WHERE revoked_at IS NULL;
CREATE INDEX mail_access_user_idx ON mail_access (user_id) WHERE revoked_at IS NULL;

CREATE FUNCTION mail_access_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mail_access: выдача не удаляется — только отзыв' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'mail_access: отозванная выдача неизменна' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.mailbox_id <> OLD.mailbox_id OR NEW.user_id <> OLD.user_id OR NEW.capability <> OLD.capability
     OR NEW.granted_by <> OLD.granted_by OR NEW.granted_at <> OLD.granted_at THEN
    RAISE EXCEPTION 'mail_access: у выдачи меняется только отметка отзыва' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_access_guard BEFORE UPDATE OR DELETE ON mail_access
  FOR EACH ROW EXECUTE FUNCTION mail_access_guard();
CREATE TRIGGER mail_access_no_truncate BEFORE TRUNCATE ON mail_access
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

-- ---------------------------------------------------------------- Письмо (AD-07-1, AD-07-3, И-07-1)

-- Логическая коммуникация: 1..N копий одного письма в разных ящиках. Ключ группировки — нормализованный
-- Message-ID; письмо без Message-ID — отдельная коммуникация. Группировка копии не сливает и доступа
-- к копии чужого ящика не даёт.
CREATE TABLE mail_communication (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key  text CHECK (length(group_key) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mail_communication_group_key ON mail_communication (group_key) WHERE group_key IS NOT NULL;
CREATE TRIGGER mail_communication_immutable BEFORE UPDATE OR DELETE ON mail_communication
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER mail_communication_no_truncate BEFORE TRUNCATE ON mail_communication
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Письмо — копия в ровно одном ящике. Идентичность в ящике (AD-07-3): внешний ID источника, иначе
-- Message-ID, иначе SHA-256 исходного EML; Message-ID сам по себе глобальным ключом не является.
CREATE TABLE mail_message (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id       uuid NOT NULL REFERENCES mailbox (id),
  communication_id uuid NOT NULL REFERENCES mail_communication (id),
  identity_kind    text NOT NULL CHECK (identity_kind IN ('source_id', 'message_id', 'raw_sha256')),
  identity_value   text NOT NULL CHECK (length(identity_value) BETWEEN 1 AND 1000),
  created_by       uuid NOT NULL REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_message_identity_key UNIQUE (mailbox_id, identity_kind, identity_value),
  CONSTRAINT mail_message_id_mailbox_key UNIQUE (id, mailbox_id)
);
CREATE INDEX mail_message_communication_idx ON mail_message (communication_id);
CREATE TRIGGER mail_message_immutable BEFORE UPDATE OR DELETE ON mail_message
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER mail_message_no_truncate BEFORE TRUNCATE ON mail_message
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Ревизия письма — неизменяемый снимок источника (OD-07-1). Побайтный повтор того же EML в том же
-- письме — та же ревизия; изменённая копия с той же идентичностью — новая ревизия за хвостом истории,
-- прежняя остаётся (исторический снимок фиксирует конкретную ревизию).
CREATE TABLE mail_message_revision (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id             uuid NOT NULL REFERENCES mail_message (id),
  seq                    int NOT NULL CHECK (seq > 0),
  raw_blob_sha256        text NOT NULL REFERENCES blob (sha256),
  message_id_header      text CHECK (length(message_id_header) BETWEEN 1 AND 1000),
  subject                text CHECK (length(subject) <= 2000),
  sent_at                timestamptz,
  from_address           text CHECK (length(from_address) <= 320),
  participants           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(participants) = 'array'),
  direction              text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'unknown')),
  folder                 text CHECK (length(folder) BETWEEN 1 AND 200),
  in_reply_to            text CHECK (length(in_reply_to) <= 1000),
  reference_ids          text[] NOT NULL DEFAULT '{}',
  source                 text NOT NULL CHECK (source IN ('eml_import', 'mailhub_api')),
  source_item_id         text CHECK (length(source_item_id) BETWEEN 1 AND 200),
  body_text_sha256       text CHECK (body_text_sha256 ~ '^[0-9a-f]{64}$'),
  parse_warnings         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parse_warnings) = 'array'),
  supersedes_revision_id uuid REFERENCES mail_message_revision (id),
  imported_by            uuid NOT NULL REFERENCES app_user (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_xact           xid8,
  CONSTRAINT mail_message_revision_raw_key UNIQUE (message_id, raw_blob_sha256),
  CONSTRAINT mail_message_revision_seq_key UNIQUE (message_id, seq),
  CONSTRAINT mail_message_revision_id_message_key UNIQUE (id, message_id),
  CONSTRAINT mail_message_revision_history_shape CHECK ((seq = 1) = (supersedes_revision_id IS NULL))
);
CREATE TRIGGER mail_message_revision_stamp BEFORE INSERT ON mail_message_revision
  FOR EACH ROW EXECUTE FUNCTION stamp_creation_xact();

-- История линейна: новая ревизия встаёт за последней ревизией того же письма. Параллельные импорты
-- сериализуются advisory-блокировкой письма (строки неизменяемых таблиц роль приложения не блокирует —
-- у неё нет UPDATE; образец — 0008), ту же блокировку берёт приложение до чтения хвоста.
CREATE FUNCTION mail_message_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mail_message_revision'), hashtext(NEW.message_id::text));
  SELECT id, seq INTO v_last FROM mail_message_revision WHERE message_id = NEW.message_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_last.seq, 0) + 1 OR NEW.supersedes_revision_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'mail_message_revision: новая ревизия встаёт за последней ревизией письма' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_message_revision_insert_guard BEFORE INSERT ON mail_message_revision
  FOR EACH ROW EXECUTE FUNCTION mail_message_revision_insert_guard();
CREATE TRIGGER mail_message_revision_immutable BEFORE UPDATE OR DELETE ON mail_message_revision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER mail_message_revision_no_truncate BEFORE TRUNCATE ON mail_message_revision
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Вложение ревизии. Одинаковый blob у двух писем — две строки: хранилище делит байты, доступ — нет.
-- Принятое вложение становится документом с владельцем-вложением (0018, AD-07-2a); отклонённое
-- (тип, размер, повреждение) хранит только метаданные и хэш.
CREATE TABLE mail_attachment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id   uuid NOT NULL REFERENCES mail_message_revision (id),
  ordinal       int NOT NULL CHECK (ordinal >= 1),
  filename      text NOT NULL CHECK (length(filename) BETWEEN 1 AND 500),
  mime_type     text NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 200),
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  disposition   text NOT NULL CHECK (disposition IN ('attachment', 'inline')),
  content_id    text CHECK (length(content_id) BETWEEN 1 AND 500),
  status        text NOT NULL CHECK (status IN ('registered', 'rejected')),
  reject_reason text CHECK (reject_reason IN ('type_not_allowed', 'size_limit', 'corrupt')),
  blob_sha256   text REFERENCES blob (sha256),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_attachment_ordinal_key UNIQUE (revision_id, ordinal),
  CONSTRAINT mail_attachment_id_revision_key UNIQUE (id, revision_id),
  CONSTRAINT mail_attachment_status_shape CHECK (
    (status = 'registered') = (blob_sha256 IS NOT NULL)
    AND (status = 'rejected') = (reject_reason IS NOT NULL)
    AND (blob_sha256 IS NULL OR blob_sha256 = sha256))
);

-- Состав ревизии неизменен: вложение дописывает только транзакция, создавшая ревизию.
CREATE FUNCTION mail_revision_child_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM mail_message_revision r
        WHERE r.id = NEW.revision_id AND r.created_xact = pg_current_xact_id() AND r.created_at = now()) THEN
    RAISE EXCEPTION '%: состав ревизии письма дописывается только транзакцией её создания', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_attachment_creation_guard BEFORE INSERT ON mail_attachment
  FOR EACH ROW EXECUTE FUNCTION mail_revision_child_guard();
CREATE TRIGGER mail_attachment_immutable BEFORE UPDATE OR DELETE ON mail_attachment
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER mail_attachment_no_truncate BEFORE TRUNCATE ON mail_attachment
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Импорт EML (AD-07-3)

-- Принятый файл EML в конкретный ящик; разбирает worker. Исход: done — письмо и ревизия (новая или
-- прежняя при побайтном повторе), failed — детерминированный отказ разбора с причиной (без повторов).
-- Связь с тендером может быть задана при импорте: её создаёт worker от имени импортирующего после
-- разбора (право mail.link проверено командой).
CREATE TABLE mail_import (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id       uuid NOT NULL REFERENCES mailbox (id),
  raw_blob_sha256  text NOT NULL REFERENCES blob (sha256),
  file_name        text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  direction        text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'unknown')),
  folder           text CHECK (length(folder) BETWEEN 1 AND 200),
  link_tender_id   uuid REFERENCES tender (id),
  link_stage_id    uuid,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done', 'failed')),
  failure_code     text CHECK (length(failure_code) BETWEEN 1 AND 60),
  failure_detail   text CHECK (length(failure_detail) <= 2000),
  message_id       uuid REFERENCES mail_message (id),
  revision_id      uuid REFERENCES mail_message_revision (id),
  created_revision boolean,
  imported_by      uuid NOT NULL REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  row_version      bigint NOT NULL DEFAULT 1,
  CONSTRAINT mail_import_stage_fk FOREIGN KEY (link_stage_id, link_tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT mail_import_outcome_shape CHECK (
    (status = 'queued' AND finished_at IS NULL AND failure_code IS NULL AND message_id IS NULL AND revision_id IS NULL AND created_revision IS NULL)
    OR (status = 'done' AND finished_at IS NOT NULL AND failure_code IS NULL AND message_id IS NOT NULL AND revision_id IS NOT NULL AND created_revision IS NOT NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND message_id IS NULL AND revision_id IS NULL))
);
CREATE INDEX mail_import_mailbox_idx ON mail_import (mailbox_id, created_at DESC);

-- queued → done | failed; исход неизменен; ящик, файл и автор не меняются.
CREATE FUNCTION mail_import_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mail_import: запись импорта не удаляется' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'queued' THEN
    RAISE EXCEPTION 'mail_import: исход импорта неизменен' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.mailbox_id <> OLD.mailbox_id OR NEW.raw_blob_sha256 <> OLD.raw_blob_sha256
     OR NEW.imported_by <> OLD.imported_by OR NEW.created_at <> OLD.created_at
     OR NEW.link_tender_id IS DISTINCT FROM OLD.link_tender_id OR NEW.link_stage_id IS DISTINCT FROM OLD.link_stage_id
     OR NEW.direction <> OLD.direction OR NEW.folder IS DISTINCT FROM OLD.folder THEN
    RAISE EXCEPTION 'mail_import: параметры импорта неизменны — меняется только исход' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_import_guard BEFORE UPDATE OR DELETE ON mail_import
  FOR EACH ROW EXECUTE FUNCTION mail_import_guard();
CREATE TRIGGER mail_import_no_truncate BEFORE TRUNCATE ON mail_import
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

-- ---------------------------------------------------------------- Связь письма с тендером (OD-07-7)

-- Пара «письмо, тендер» 0..N на письмо. Создаёт только пользователь с mail.link (автоматического
-- подтверждения нет); снятие — статус unlinked, письмо и снимки остаются. Строка — цель FK снимка
-- области, поэтому не удаляется; история — в журнале аудита, как у contract_tender.
CREATE TABLE mail_message_tender (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES mail_message (id),
  tender_id   uuid NOT NULL REFERENCES tender (id),
  stage_id    uuid,
  status      text NOT NULL DEFAULT 'linked' CHECK (status IN ('linked', 'unlinked')),
  linked_by   uuid NOT NULL REFERENCES app_user (id),
  linked_at   timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NOT NULL REFERENCES app_user (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT mail_message_tender_pair_key UNIQUE (message_id, tender_id),
  CONSTRAINT mail_message_tender_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id)
);
CREATE INDEX mail_message_tender_tender_idx ON mail_message_tender (tender_id);

CREATE FUNCTION mail_message_tender_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mail_message_tender: связь не удаляется — только снятие (статус unlinked)' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.message_id <> OLD.message_id OR NEW.tender_id <> OLD.tender_id
     OR NEW.linked_by <> OLD.linked_by OR NEW.linked_at <> OLD.linked_at THEN
    RAISE EXCEPTION 'mail_message_tender: письмо и тендер связи неизменны' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_message_tender_guard BEFORE UPDATE OR DELETE ON mail_message_tender
  FOR EACH ROW EXECUTE FUNCTION mail_message_tender_guard();
CREATE TRIGGER mail_message_tender_no_truncate BEFORE TRUNCATE ON mail_message_tender
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

-- ---------------------------------------------------------------- Вопросы–ответы (OD-07-6)

-- Импорт версионированного manifest. Номер импорта в тендере растёт под блокировкой тендера; повтор
-- того же файла подряд идемпотентен (возвращается последний импорт), а возврат к прежнему файлу после
-- другого (A → B → A) — новый импорт: неизменённые вопросы ревизий не получают, изменённые — получают.
CREATE TABLE qa_import (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id            uuid NOT NULL REFERENCES tender (id),
  seq                  int NOT NULL CHECK (seq > 0),
  manifest_blob_sha256 text NOT NULL REFERENCES blob (sha256),
  format_version       text NOT NULL CHECK (format_version IN ('kontur.qa.v1')),
  imported_by          uuid NOT NULL REFERENCES app_user (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_import_seq_key UNIQUE (tender_id, seq),
  CONSTRAINT qa_import_id_tender_key UNIQUE (id, tender_id)
);

CREATE TABLE qa_thread (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id    uuid NOT NULL REFERENCES tender (id),
  stage_id     uuid,
  external_ref text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 200),
  title        text CHECK (length(title) BETWEEN 1 AND 500),
  created_by   uuid NOT NULL REFERENCES app_user (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_thread_ref_key UNIQUE (tender_id, external_ref),
  CONSTRAINT qa_thread_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT qa_thread_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id)
);

-- Вопрос с устойчивым номером; содержание — в неизменяемых ревизиях.
CREATE TABLE qa_item (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid NOT NULL,
  tender_id  uuid NOT NULL,
  item_no    text NOT NULL CHECK (length(item_no) BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_item_thread_fk FOREIGN KEY (thread_id, tender_id) REFERENCES qa_thread (id, tender_id),
  CONSTRAINT qa_item_no_key UNIQUE (thread_id, item_no),
  CONSTRAINT qa_item_id_tender_key UNIQUE (id, tender_id)
);

-- Состояние вопроса и ответа по импорту. Ревизия создаётся, только если содержание отличается от
-- последней: повтор manifest ничего не добавляет, а A → B → A даёт третью ревизию с содержанием A.
CREATE TABLE qa_item_revision (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id                uuid NOT NULL,
  tender_id              uuid NOT NULL,
  seq                    int NOT NULL CHECK (seq > 0),
  question               text NOT NULL CHECK (length(question) BETWEEN 1 AND 100000),
  answer                 text CHECK (length(answer) BETWEEN 1 AND 100000),
  status                 text NOT NULL CHECK (status IN ('open', 'answered', 'withdrawn')),
  asked_at               timestamptz,
  answered_at            timestamptz,
  external_ref           text CHECK (length(external_ref) BETWEEN 1 AND 200),
  import_id              uuid NOT NULL,
  content_sha256         text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  supersedes_revision_id uuid REFERENCES qa_item_revision (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_item_revision_item_fk FOREIGN KEY (item_id, tender_id) REFERENCES qa_item (id, tender_id),
  CONSTRAINT qa_item_revision_import_fk FOREIGN KEY (import_id, tender_id) REFERENCES qa_import (id, tender_id),
  CONSTRAINT qa_item_revision_seq_key UNIQUE (item_id, seq),
  CONSTRAINT qa_item_revision_answer_shape CHECK (
    (status = 'answered') = (answer IS NOT NULL) AND (answered_at IS NULL OR status = 'answered')),
  CONSTRAINT qa_item_revision_history_shape CHECK ((seq = 1) = (supersedes_revision_id IS NULL))
);

CREATE FUNCTION qa_item_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('qa_item_revision'), hashtext(NEW.item_id::text));
  SELECT id, seq, content_sha256 INTO v_last FROM qa_item_revision WHERE item_id = NEW.item_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_last.seq, 0) + 1 OR NEW.supersedes_revision_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'qa_item_revision: новая ревизия встаёт за последней ревизией вопроса' USING ERRCODE = '23514';
  END IF;
  IF NEW.content_sha256 = v_last.content_sha256 THEN
    RAISE EXCEPTION 'qa_item_revision: содержание не изменилось — новая ревизия не создаётся' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER qa_item_revision_insert_guard BEFORE INSERT ON qa_item_revision
  FOR EACH ROW EXECUTE FUNCTION qa_item_revision_insert_guard();

-- ---------------------------------------------------------------- Переговоры (Q-06: файловый импорт)

-- Импорт manifest переговоров: номер в тендере, повтор того же файла подряд идемпотентен (как у qa_import).
CREATE TABLE negotiation_import (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id            uuid NOT NULL REFERENCES tender (id),
  seq                  int NOT NULL CHECK (seq > 0),
  manifest_blob_sha256 text NOT NULL REFERENCES blob (sha256),
  format_version       text NOT NULL CHECK (format_version IN ('kontur.negotiation.v1')),
  imported_by          uuid NOT NULL REFERENCES app_user (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT negotiation_import_seq_key UNIQUE (tender_id, seq),
  CONSTRAINT negotiation_import_id_tender_key UNIQUE (id, tender_id)
);

-- Аудио — ссылка и хэш: портал не хранит запись (data-model §4.6).
CREATE TABLE negotiation_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id           uuid NOT NULL REFERENCES tender (id),
  stage_id            uuid,
  external_session_id text NOT NULL CHECK (length(external_session_id) BETWEEN 1 AND 200),
  title               text CHECK (length(title) BETWEEN 1 AND 500),
  started_at          timestamptz NOT NULL,
  audio_ref           text CHECK (length(audio_ref) BETWEEN 1 AND 2000),
  audio_sha256        text CHECK (audio_sha256 ~ '^[0-9a-f]{64}$'),
  source              text NOT NULL CHECK (source IN ('manifest_import', 'service_api')),
  created_by          uuid NOT NULL REFERENCES app_user (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT negotiation_session_ref_key UNIQUE (tender_id, external_session_id),
  CONSTRAINT negotiation_session_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT negotiation_session_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id)
);

CREATE TABLE negotiation_participant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL,
  tender_id     uuid NOT NULL,
  speaker_label text NOT NULL CHECK (length(speaker_label) BETWEEN 1 AND 100),
  name          text CHECK (length(name) BETWEEN 1 AND 200),
  side          text NOT NULL CHECK (side IN ('customer', 'contractor', 'unknown')),
  CONSTRAINT negotiation_participant_session_fk FOREIGN KEY (session_id, tender_id) REFERENCES negotiation_session (id, tender_id),
  CONSTRAINT negotiation_participant_label_key UNIQUE (session_id, speaker_label)
);

-- Редакция транскрипции: исправление — новая редакция за последней; повтор того же содержания подряд
-- новой редакции не даёт, возврат к прежнему тексту — новая редакция.
CREATE TABLE transcript_revision (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id             uuid NOT NULL,
  tender_id              uuid NOT NULL,
  seq                    int NOT NULL CHECK (seq > 0),
  source_revision        text NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 50),
  content_sha256         text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  import_id              uuid NOT NULL,
  supersedes_revision_id uuid REFERENCES transcript_revision (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_xact           xid8,
  CONSTRAINT transcript_revision_session_fk FOREIGN KEY (session_id, tender_id) REFERENCES negotiation_session (id, tender_id),
  CONSTRAINT transcript_revision_import_fk FOREIGN KEY (import_id, tender_id) REFERENCES negotiation_import (id, tender_id),
  CONSTRAINT transcript_revision_seq_key UNIQUE (session_id, seq),
  CONSTRAINT transcript_revision_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT transcript_revision_history_shape CHECK ((seq = 1) = (supersedes_revision_id IS NULL))
);
CREATE TRIGGER transcript_revision_stamp BEFORE INSERT ON transcript_revision
  FOR EACH ROW EXECUTE FUNCTION stamp_creation_xact();

CREATE FUNCTION transcript_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('transcript_revision'), hashtext(NEW.session_id::text));
  SELECT id, seq, content_sha256 INTO v_last FROM transcript_revision WHERE session_id = NEW.session_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_last.seq, 0) + 1 OR NEW.supersedes_revision_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'transcript_revision: новая редакция встаёт за последней редакцией сессии' USING ERRCODE = '23514';
  END IF;
  IF NEW.content_sha256 = v_last.content_sha256 THEN
    RAISE EXCEPTION 'transcript_revision: содержание не изменилось — новая редакция не создаётся' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transcript_revision_insert_guard BEFORE INSERT ON transcript_revision
  FOR EACH ROW EXECUTE FUNCTION transcript_revision_insert_guard();

-- Сегмент: речь и подсказка участнику — разные виды (I06, A03); подсказка не становится речью заказчика.
CREATE TABLE transcript_segment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id   uuid NOT NULL,
  tender_id     uuid NOT NULL,
  segment_no    int NOT NULL CHECK (segment_no >= 1),
  speaker_label text NOT NULL CHECK (length(speaker_label) BETWEEN 1 AND 100),
  t_start_ms    int NOT NULL CHECK (t_start_ms >= 0),
  t_end_ms      int NOT NULL,
  segment_kind  text NOT NULL CHECK (segment_kind IN ('speech', 'hint')),
  text          text NOT NULL CHECK (length(text) BETWEEN 1 AND 100000),
  CONSTRAINT transcript_segment_revision_fk FOREIGN KEY (revision_id, tender_id) REFERENCES transcript_revision (id, tender_id),
  CONSTRAINT transcript_segment_no_key UNIQUE (revision_id, segment_no),
  CONSTRAINT transcript_segment_id_revision_key UNIQUE (id, revision_id),
  CONSTRAINT transcript_segment_time_shape CHECK (t_end_ms >= t_start_ms)
);

CREATE FUNCTION transcript_child_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM transcript_revision r
        WHERE r.id = NEW.revision_id AND r.created_xact = pg_current_xact_id() AND r.created_at = now()) THEN
    RAISE EXCEPTION 'transcript_segment: сегменты дописываются только транзакцией создания редакции' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transcript_segment_creation_guard BEFORE INSERT ON transcript_segment
  FOR EACH ROW EXECUTE FUNCTION transcript_child_guard();

-- Неизменность и запрет удаления у Q&A и переговоров.
CREATE TRIGGER qa_import_immutable BEFORE UPDATE OR DELETE ON qa_import FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER qa_import_no_truncate BEFORE TRUNCATE ON qa_import FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER qa_thread_immutable BEFORE UPDATE OR DELETE ON qa_thread FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER qa_thread_no_truncate BEFORE TRUNCATE ON qa_thread FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER qa_item_immutable BEFORE UPDATE OR DELETE ON qa_item FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER qa_item_no_truncate BEFORE TRUNCATE ON qa_item FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER qa_item_revision_immutable BEFORE UPDATE OR DELETE ON qa_item_revision FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER qa_item_revision_no_truncate BEFORE TRUNCATE ON qa_item_revision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER negotiation_import_immutable BEFORE UPDATE OR DELETE ON negotiation_import FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER negotiation_import_no_truncate BEFORE TRUNCATE ON negotiation_import FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER negotiation_session_immutable BEFORE UPDATE OR DELETE ON negotiation_session FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER negotiation_session_no_truncate BEFORE TRUNCATE ON negotiation_session FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER negotiation_participant_immutable BEFORE UPDATE OR DELETE ON negotiation_participant FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER negotiation_participant_no_truncate BEFORE TRUNCATE ON negotiation_participant FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER transcript_revision_immutable BEFORE UPDATE OR DELETE ON transcript_revision FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER transcript_revision_no_truncate BEFORE TRUNCATE ON transcript_revision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER transcript_segment_immutable BEFORE UPDATE OR DELETE ON transcript_segment FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER transcript_segment_no_truncate BEFORE TRUNCATE ON transcript_segment FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Статус интеграций (D-025)

-- Автоматическое чтение MailHub ждёт машинную авторизацию и ленту изменений (X-03); API сервиса
-- переговоров не подтверждён (Q-06). Штатный путь этапа 07 — ручной импорт EML и manifest-файлов.
INSERT INTO integration_status (system, component, status, details)
VALUES ('mailhub', 'MailHubMailboxReader', 'BLOCKED_EXTERNAL', '{"blockedBy": "X-03"}'::jsonb),
       ('negotiations', 'NegotiationServiceClient', 'BLOCKED_EXTERNAL', '{"blockedBy": "Q-06"}'::jsonb)
ON CONFLICT (system, component) DO NOTHING;

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT, UPDATE ON mailbox, mail_access, mail_import, mail_message_tender TO kontur_app;
GRANT SELECT, INSERT ON mail_communication, mail_message, mail_message_revision, mail_attachment,
  qa_import, qa_thread, qa_item, qa_item_revision,
  negotiation_import, negotiation_session, negotiation_participant, transcript_revision, transcript_segment TO kontur_app;
GRANT SELECT ON mailbox, mail_access, mail_import, mail_communication, mail_message, mail_message_revision, mail_attachment, mail_message_tender,
  qa_import, qa_thread, qa_item, qa_item_revision,
  negotiation_import, negotiation_session, negotiation_participant, transcript_revision, transcript_segment TO kontur_backup;
