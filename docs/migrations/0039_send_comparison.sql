-- Этап 15 (D-035; проект docs/architecture/15-send-comparison-design.md): регистрация отправки выпуска с основанием и
-- сверкой точных вложений письма с комплектом для заказчика, нарушения (недопустимая отправка вне системы), удержания
-- после отправки (state-machines §1.1 п. 4) и сравнение двух выпусков по закреплённым входам с причинами выводов.
-- Принятые миграции 0001–0038 не меняются (ADR-002); функции возможностей тендера и удержаний заменяются целиком.

-- ---------------------------------------------------------------- Права

-- send.register — инженер тендера, человек (state-machines §17, ADR-006 п. 3): отправка и нарушение.
-- send.accept_extras — руководитель тендера (D-035 В-15-1): лишние вложения письма не относятся к комплекту.
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
                              'candidate.create', 'delivery.manage'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm',
                              'finding.accept_risk', 'source_priority.manage', 'template.manage', 'candidate.approve', 'risk.accept',
                              'send.accept_extras'];
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

-- Составной ключ выпуска для внешних ключей по тендеру (S15-07).
ALTER TABLE release ADD CONSTRAINT release_id_tender_key UNIQUE (id, tender_id);

-- ---------------------------------------------------------------- Сверка вложений (проект §4)

-- Комплект для заказчика — тот же набор, что у ZIP для заказчика и размещения без внутренних материалов (этапы 13–14).
CREATE FUNCTION send_kit_files(p_release uuid) RETURNS TABLE (path text, sha256 text, size_bytes bigint)
LANGUAGE sql STABLE AS $$
  SELECT f.path, f.blob_sha256, f.size_bytes
    FROM release r JOIN candidate_file f ON f.candidate_id = r.candidate_id
   WHERE r.id = p_release AND f.audience = 'customer' AND f.role <> 'preview'
$$;

-- Класс вложения по содержимому: файл комплекта; иной файл этого выпуска (внутренний, превью, манифесты); файл другого
-- выпуска того же тендера (последнего по времени выпуска); неизвестное.
CREATE FUNCTION send_file_class(p_release uuid, p_sha256 text, OUT class text, OUT kit_path text, OUT other_release_id uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r release%ROWTYPE;
BEGIN
  SELECT * INTO r FROM release WHERE id = p_release;
  SELECT k.path INTO kit_path FROM send_kit_files(p_release) k WHERE k.sha256 = p_sha256 ORDER BY k.path LIMIT 1;
  IF kit_path IS NOT NULL THEN
    class := 'kit';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_file f WHERE f.candidate_id = r.candidate_id AND f.blob_sha256 = p_sha256)
     OR p_sha256 = r.release_manifest_blob_sha256
     OR EXISTS (SELECT 1 FROM release_candidate c WHERE c.id = r.candidate_id AND c.manifest_blob_sha256 = p_sha256) THEN
    class := 'internal';
    RETURN;
  END IF;
  SELECT o.id INTO other_release_id
    FROM release o JOIN candidate_file f ON f.candidate_id = o.candidate_id
   WHERE o.tender_id = r.tender_id AND o.id <> r.id AND f.blob_sha256 = p_sha256
   ORDER BY o.released_at DESC, o.id LIMIT 1;
  class := CASE WHEN other_release_id IS NULL THEN 'unknown' ELSE 'other_release' END;
END;
$$;

-- ---------------------------------------------------------------- Готовность к отправке (вторая линия, проект §6)

-- Первая причина, по которой выпуск нельзя отправить: решение «влияет» (навсегда, R13-03), непокрытые события без
-- «не влияет», несвежий канал поступления. Сервер считает то же в releaseSendReadiness.
CREATE FUNCTION release_send_problem(p_release uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r release%ROWTYPE;
BEGIN
  SELECT * INTO r FROM release WHERE id = p_release;
  IF NOT FOUND THEN
    RETURN 'RELEASE_MISSING';
  END IF;
  IF r.mode <> 'production' THEN
    RETURN 'RELEASE_IS_TEST';
  END IF;
  IF EXISTS (SELECT 1 FROM readiness_hold h WHERE h.candidate_id = r.candidate_id AND h.status = 'resolved_requires_new_candidate') THEN
    RETURN 'EXCLUDED';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_uncovered_events(r.candidate_id)) THEN
    RETURN 'HELD';
  END IF;
  IF EXISTS (SELECT 1 FROM intake_channel ch WHERE ch.tender_id = r.tender_id AND ch.active
                AND (ch.last_successful_scan_at IS NULL OR ch.last_successful_scan_at < now() - ch.freshness_window)) THEN
    RETURN 'INTAKE_NOT_CURRENT';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------- Файл-основание

-- Файл-основание ручной регистрации (скан, снимок экрана, квитанция): принят сервером от инженера для конкретного
-- выпуска. Отправка и нарушение ссылаются только на свою загрузку — чужой файл хранилища по известному SHA-256 основанием
-- стать не может (иначе скачивание основания открывало бы закрытый файл).
CREATE TABLE send_evidence_upload (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id  uuid NOT NULL,
  tender_id   uuid NOT NULL,
  blob_sha256 text NOT NULL REFERENCES blob (sha256),
  file_name   text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),
  uploaded_by uuid NOT NULL REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_evidence_upload_release_fk FOREIGN KEY (release_id, tender_id) REFERENCES release (id, tender_id)
);

CREATE FUNCTION send_evidence_upload_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce('send.register' = ANY (tender_capabilities(NEW.uploaded_by, NEW.tender_id)), false) THEN
    RAISE EXCEPTION 'send_evidence_upload: файл-основание загружает инженер тендера (send.register)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER send_evidence_upload_guard BEFORE INSERT ON send_evidence_upload FOR EACH ROW EXECUTE FUNCTION send_evidence_upload_guard();
CREATE TRIGGER send_evidence_upload_immutable BEFORE UPDATE OR DELETE ON send_evidence_upload FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER send_evidence_upload_no_truncate BEFORE TRUNCATE ON send_evidence_upload FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- Загрузка — этого выпуска, этого пользователя, с тем же файлом и именем.
CREATE FUNCTION send_evidence_upload_matches(p_upload uuid, p_release uuid, p_user uuid, p_sha256 text, p_name text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM send_evidence_upload u
                  WHERE u.id = p_upload AND u.release_id = p_release AND u.uploaded_by = p_user AND u.blob_sha256 = p_sha256 AND u.file_name = p_name)
$$;

-- ---------------------------------------------------------------- Отправка

CREATE TABLE send_event (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id               uuid NOT NULL,
  tender_id                uuid NOT NULL,
  stage_id                 uuid NOT NULL,
  seq                      int NOT NULL CHECK (seq >= 1),
  channel                  text NOT NULL CHECK (channel IN ('email', 'customer_portal', 'paper', 'other')),
  sent_at                  timestamptz NOT NULL,
  -- Адресаты ручной регистрации. У письма-основания не копируются: их читает тот, у кого есть mail.read (проект §12).
  recipients               jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recipients) = 'array'),
  evidence_kind            text NOT NULL CHECK (evidence_kind IN ('mail_message', 'uploaded_file', 'manual_note')),
  mail_message_revision_id uuid,
  mail_message_id          uuid,
  mail_communication_id    uuid REFERENCES mail_communication (id),
  mail_raw_sha256          text CHECK (mail_raw_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_upload_id       uuid REFERENCES send_evidence_upload (id),
  evidence_blob_sha256     text REFERENCES blob (sha256),
  evidence_file_name       text CHECK (length(evidence_file_name) BETWEEN 1 AND 255),
  note                     text CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  attachment_check         text NOT NULL CHECK (attachment_check IN ('matched', 'mismatched', 'not_checked')),
  check_detail             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(check_detail) = 'object'),
  kit_sha256               text NOT NULL CHECK (kit_sha256 ~ '^[0-9a-f]{64}$'),
  release_manifest_sha256  text NOT NULL CHECK (release_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status                   text NOT NULL CHECK (status IN ('registered', 'verified', 'disputed')),
  extras_accepted          boolean NOT NULL DEFAULT false,
  registered_by            uuid NOT NULL REFERENCES app_user (id),
  registered_at            timestamptz NOT NULL DEFAULT now(),
  idempotency_key          text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_xact             xid8 NOT NULL DEFAULT pg_current_xact_id(),
  row_version              bigint NOT NULL DEFAULT 1,
  CONSTRAINT send_event_release_fk FOREIGN KEY (release_id, tender_id) REFERENCES release (id, tender_id),
  CONSTRAINT send_event_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT send_event_revision_fk FOREIGN KEY (mail_message_revision_id, mail_message_id) REFERENCES mail_message_revision (id, message_id),
  CONSTRAINT send_event_seq_key UNIQUE (release_id, seq),
  CONSTRAINT send_event_idempotency_key UNIQUE (registered_by, idempotency_key),
  CONSTRAINT send_event_evidence_shape CHECK (
    CASE evidence_kind
      WHEN 'mail_message' THEN mail_message_revision_id IS NOT NULL AND mail_message_id IS NOT NULL AND mail_communication_id IS NOT NULL
        AND mail_raw_sha256 IS NOT NULL AND num_nonnulls(evidence_upload_id, evidence_blob_sha256, evidence_file_name) = 0 AND note IS NULL
        AND recipients = '[]'::jsonb AND channel = 'email' AND attachment_check <> 'not_checked'
      WHEN 'uploaded_file' THEN num_nonnulls(mail_message_revision_id, mail_message_id, mail_communication_id, mail_raw_sha256) = 0
        AND num_nonnulls(evidence_upload_id, evidence_blob_sha256, evidence_file_name) = 3 AND attachment_check = 'not_checked'
      ELSE num_nonnulls(mail_message_revision_id, mail_message_id, mail_communication_id, mail_raw_sha256, evidence_upload_id, evidence_blob_sha256,
                        evidence_file_name) = 0
        AND note IS NOT NULL AND length(btrim(note)) >= 10 AND attachment_check = 'not_checked'
    END),
  -- Состав не совпал — не отправка утверждённого комплекта (A32); «лишние приняты» — только у подтверждённой.
  CONSTRAINT send_event_status_shape CHECK (
    CASE attachment_check
      WHEN 'not_checked' THEN status = 'registered' AND NOT extras_accepted
      WHEN 'matched' THEN status = 'verified' AND NOT extras_accepted
      ELSE (status = 'disputed' AND NOT extras_accepted) OR (status = 'verified' AND extras_accepted)
    END)
);
-- Одно письмо — одна отправка выпуска, в скольких бы папках и ящиках оно ни лежало (A34): по коммуникации (Message-ID)
-- и по байтам исходного письма (письма без Message-ID).
CREATE UNIQUE INDEX send_event_communication_key ON send_event (release_id, mail_communication_id) WHERE mail_communication_id IS NOT NULL;
CREATE UNIQUE INDEX send_event_raw_key ON send_event (release_id, mail_raw_sha256) WHERE mail_raw_sha256 IS NOT NULL;
CREATE INDEX send_event_release_idx ON send_event (release_id, seq);

-- Вложения письма-основания со сверкой (неизменяемо; только в транзакции регистрации).
CREATE TABLE send_event_file (
  send_event_id      uuid NOT NULL REFERENCES send_event (id),
  ordinal            int NOT NULL CHECK (ordinal >= 1),
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes         bigint NOT NULL CHECK (size_bytes >= 0),
  class              text NOT NULL CHECK (class IN ('kit', 'internal', 'other_release', 'unknown')),
  kit_path           text,
  other_release_id   uuid REFERENCES release (id),
  mail_attachment_id uuid NOT NULL REFERENCES mail_attachment (id),
  inline             boolean NOT NULL,
  PRIMARY KEY (send_event_id, ordinal),
  CONSTRAINT send_event_file_class_shape CHECK ((class = 'kit') = (kit_path IS NOT NULL) AND (class = 'other_release') = (other_release_id IS NOT NULL))
);

-- Решения человека по отправке (только добавление): по записи этой транзакции вторая линия проверяет переход.
CREATE TABLE send_event_decision (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_event_id uuid NOT NULL REFERENCES send_event (id),
  action        text NOT NULL CHECK (action IN ('accept_extras')),
  actor_user_id uuid NOT NULL REFERENCES app_user (id),
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_xact  xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX send_event_decision_idx ON send_event_decision (send_event_id, created_at);

-- Засчитанная отправка выпуска кандидата: подтверждена или зарегистрирована без сверки. «Состав не совпал» не считается.
CREATE FUNCTION release_has_counted_send(p_candidate uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM release r JOIN send_event s ON s.release_id = r.id
                  WHERE r.candidate_id = p_candidate AND s.status IN ('registered', 'verified'))
$$;

-- Расхождение — только лишние вложения неизвестного происхождения: каждый файл комплекта на месте, внутренних файлов и
-- файлов другого выпуска нет (D-035 В-15-1).
CREATE FUNCTION send_event_extras_only(p_send uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM send_event s, send_kit_files(s.release_id) k
                      WHERE s.id = p_send AND NOT EXISTS (SELECT 1 FROM send_event_file f WHERE f.send_event_id = s.id AND f.sha256 = k.sha256))
     AND NOT EXISTS (SELECT 1 FROM send_event_file f WHERE f.send_event_id = p_send AND f.class NOT IN ('kit', 'unknown'))
     AND EXISTS (SELECT 1 FROM send_event_file f WHERE f.send_event_id = p_send AND f.class = 'unknown')
$$;

CREATE FUNCTION send_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r release%ROWTYPE;
  v_problem text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO r FROM release WHERE id = NEW.release_id;
    IF r.mode <> 'production' THEN
      RAISE EXCEPTION 'send_event: тестовый выпуск не регистрируется как отправка (RELEASE_IS_TEST)' USING ERRCODE = '23514';
    END IF;
    IF NEW.stage_id <> r.stage_id OR NEW.row_version <> 1 OR NEW.extras_accepted OR NEW.created_xact <> pg_current_xact_id()
       OR NEW.release_manifest_sha256 <> r.release_manifest_sha256
       OR NEW.seq <> (SELECT coalesce(max(seq), 0) + 1 FROM send_event WHERE release_id = NEW.release_id) THEN
      RAISE EXCEPTION 'send_event: отправка создаётся со следующим номером, этапом и манифестом выпуска' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.registered_by, NEW.stage_id, 'send.register') THEN
      RAISE EXCEPTION 'send_event: отправку регистрирует инженер тендера (send.register)' USING ERRCODE = '42501';
    END IF;
    v_problem := release_send_problem(NEW.release_id);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'send_event: выпуск не готов к отправке (%)', v_problem USING ERRCODE = '23514';
    END IF;
    -- Время ручной регистрации вводится с точностью до минуты: сравнение — с минутой выпуска.
    IF NEW.sent_at < date_trunc('minute', r.released_at) OR NEW.sent_at > now() + interval '1 day' THEN
      RAISE EXCEPTION 'send_event: время отправки — не раньше минуты выпуска и не в будущем' USING ERRCODE = '23514';
    END IF;
    IF NEW.evidence_kind = 'mail_message' THEN
      -- Письмо-основание: отправленное, связанное с тендером; время, коммуникация и байты — из закреплённой ревизии.
      IF NOT EXISTS (SELECT 1 FROM mail_message_revision v JOIN mail_message m ON m.id = v.message_id
                      WHERE v.id = NEW.mail_message_revision_id AND m.id = NEW.mail_message_id AND m.communication_id = NEW.mail_communication_id
                        AND v.direction = 'outbound' AND v.sent_at = NEW.sent_at AND v.raw_blob_sha256 = NEW.mail_raw_sha256)
         OR NOT EXISTS (SELECT 1 FROM mail_message_tender l WHERE l.message_id = NEW.mail_message_id AND l.tender_id = NEW.tender_id AND l.status = 'linked') THEN
        RAISE EXCEPTION 'send_event: основание — отправленное письмо, связанное с тендером выпуска' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.evidence_kind = 'uploaded_file'
       AND NOT send_evidence_upload_matches(NEW.evidence_upload_id, NEW.release_id, NEW.registered_by, NEW.evidence_blob_sha256, NEW.evidence_file_name) THEN
      RAISE EXCEPTION 'send_event: файл-основание — собственная загрузка регистрирующего для этого выпуска' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Единственное изменение: «состав не совпал» → «подтверждена, лишние вложения приняты» (D-035 В-15-1).
  IF (to_jsonb(NEW) - 'status' - 'extras_accepted' - 'row_version') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'extras_accepted' - 'row_version') THEN
    RAISE EXCEPTION 'send_event (frozen-after): запись отправки неизменна' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'disputed' OR NEW.status <> 'verified' OR NOT NEW.extras_accepted OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'send_event (frozen-after): меняется только «состав не совпал» — принятием лишних вложений' USING ERRCODE = '55000';
  END IF;
  IF NOT send_event_extras_only(NEW.id) THEN
    RAISE EXCEPTION 'send_event: принять можно только лишние вложения; отсутствующий, внутренний или файл другого выпуска так не снимается' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM send_event_decision d WHERE d.send_event_id = NEW.id AND d.action = 'accept_extras' AND d.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'send_event: лишние вложения принимаются решением руководителя в этой транзакции' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER send_event_guard BEFORE INSERT OR UPDATE ON send_event FOR EACH ROW EXECUTE FUNCTION send_event_guard();
CREATE TRIGGER send_event_no_delete BEFORE DELETE ON send_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER send_event_no_truncate BEFORE TRUNCATE ON send_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

CREATE FUNCTION send_event_file_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s send_event%ROWTYPE;
  c record;
BEGIN
  SELECT * INTO s FROM send_event WHERE id = NEW.send_event_id;
  IF s.created_xact IS DISTINCT FROM pg_current_xact_id() OR s.evidence_kind <> 'mail_message' THEN
    RAISE EXCEPTION 'send_event_file: вложения закрепляются в транзакции регистрации отправки по письму' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mail_attachment a WHERE a.id = NEW.mail_attachment_id AND a.revision_id = s.mail_message_revision_id
                    AND a.ordinal = NEW.ordinal AND a.sha256 = NEW.sha256 AND a.size_bytes = NEW.size_bytes AND (a.disposition = 'inline') = NEW.inline) THEN
    RAISE EXCEPTION 'send_event_file: вложение — вложение закреплённой ревизии письма' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO c FROM send_file_class(s.release_id, NEW.sha256);
  IF (NEW.class, NEW.kit_path, NEW.other_release_id) IS DISTINCT FROM (c.class, c.kit_path, c.other_release_id) THEN
    RAISE EXCEPTION 'send_event_file: класс вложения не соответствует сверке с выпуском' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER send_event_file_guard BEFORE INSERT ON send_event_file FOR EACH ROW EXECUTE FUNCTION send_event_file_guard();
CREATE TRIGGER send_event_file_immutable BEFORE UPDATE OR DELETE ON send_event_file FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER send_event_file_no_truncate BEFORE TRUNCATE ON send_event_file FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- В конце транзакции регистрации: вложения отправки — ровно вложения ревизии письма; итог сверки и хэш комплекта равны
-- вычисленным по выпуску (инвариант 3).
CREATE FUNCTION send_event_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s send_event%ROWTYPE;
  v_matched boolean;
  v_kit text;
BEGIN
  SELECT * INTO s FROM send_event WHERE id = NEW.id;
  SELECT encode(sha256(convert_to('kontur.send_kit.v1' || E'\n' || coalesce(string_agg(k.path || '|' || k.sha256 || '|' || k.size_bytes, E'\n' ORDER BY k.path COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO v_kit FROM send_kit_files(s.release_id) k;
  IF s.kit_sha256 <> v_kit THEN
    RAISE EXCEPTION 'send_event: хэш комплекта не соответствует файлам выпуска для заказчика' USING ERRCODE = '23514';
  END IF;
  IF s.evidence_kind <> 'mail_message' THEN
    IF EXISTS (SELECT 1 FROM send_event_file f WHERE f.send_event_id = s.id) THEN
      RAISE EXCEPTION 'send_event: вложения сверяются только у письма-основания' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM send_event_file f WHERE f.send_event_id = s.id) <> (SELECT count(*) FROM mail_attachment a WHERE a.revision_id = s.mail_message_revision_id) THEN
    RAISE EXCEPTION 'send_event: закреплены не все вложения письма-основания' USING ERRCODE = '23514';
  END IF;
  v_matched := NOT EXISTS (SELECT 1 FROM send_kit_files(s.release_id) k WHERE NOT EXISTS (SELECT 1 FROM send_event_file f WHERE f.send_event_id = s.id AND f.sha256 = k.sha256))
           AND NOT EXISTS (SELECT 1 FROM send_event_file f WHERE f.send_event_id = s.id AND f.class <> 'kit')
           AND EXISTS (SELECT 1 FROM send_kit_files(s.release_id));
  IF (s.attachment_check = 'matched') <> v_matched THEN
    RAISE EXCEPTION 'send_event: итог сверки вложений не соответствует составу письма и выпуска' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER send_event_check AFTER INSERT ON send_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION send_event_check();

CREATE FUNCTION send_event_decision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
BEGIN
  SELECT stage_id INTO v_stage FROM send_event WHERE id = NEW.send_event_id;
  IF NOT has_stage_capability(NEW.actor_user_id, v_stage, 'send.accept_extras') THEN
    RAISE EXCEPTION 'send_event_decision: лишние вложения принимает руководитель тендера (send.accept_extras)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER send_event_decision_guard BEFORE INSERT ON send_event_decision FOR EACH ROW EXECUTE FUNCTION send_event_decision_guard();
CREATE TRIGGER send_event_decision_immutable BEFORE UPDATE OR DELETE ON send_event_decision FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER send_event_decision_no_truncate BEFORE TRUNCATE ON send_event_decision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- ---------------------------------------------------------------- Нарушение (проект §7)

-- Недопустимая отправка, совершённая вне системы: тестовый или не готовый к отправке комплект ушёл заказчику. Не
-- отправка: выпуск не подтверждает, режим и готовность не меняет, на удержания не влияет.
CREATE TABLE compliance_incident (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id               uuid NOT NULL,
  tender_id                uuid NOT NULL,
  stage_id                 uuid NOT NULL,
  incident_kind            text NOT NULL CHECK (incident_kind IN ('test_release_sent_externally', 'sent_despite_blocker', 'other')),
  occurred_at              timestamptz NOT NULL,
  description              text NOT NULL CHECK (length(btrim(description)) BETWEEN 10 AND 4000),
  mail_message_revision_id uuid,
  mail_message_id          uuid,
  evidence_upload_id       uuid REFERENCES send_evidence_upload (id),
  evidence_blob_sha256     text REFERENCES blob (sha256),
  evidence_file_name       text CHECK (length(evidence_file_name) BETWEEN 1 AND 255),
  registered_by            uuid NOT NULL REFERENCES app_user (id),
  registered_at            timestamptz NOT NULL DEFAULT now(),
  idempotency_key          text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT compliance_incident_release_fk FOREIGN KEY (release_id, tender_id) REFERENCES release (id, tender_id),
  CONSTRAINT compliance_incident_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT compliance_incident_revision_fk FOREIGN KEY (mail_message_revision_id, mail_message_id) REFERENCES mail_message_revision (id, message_id),
  CONSTRAINT compliance_incident_idempotency_key UNIQUE (registered_by, idempotency_key),
  CONSTRAINT compliance_incident_evidence_shape CHECK (
    (mail_message_revision_id IS NULL) = (mail_message_id IS NULL)
    AND num_nonnulls(evidence_upload_id, evidence_blob_sha256, evidence_file_name) IN (0, 3)
    AND num_nonnulls(mail_message_revision_id, evidence_blob_sha256) <= 1)
);
CREATE INDEX compliance_incident_release_idx ON compliance_incident (release_id, registered_at);

CREATE FUNCTION compliance_incident_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r release%ROWTYPE;
BEGIN
  SELECT * INTO r FROM release WHERE id = NEW.release_id;
  IF NEW.stage_id <> r.stage_id THEN
    RAISE EXCEPTION 'compliance_incident: этап нарушения — этап выпуска' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.registered_by, NEW.stage_id, 'send.register') THEN
    RAISE EXCEPTION 'compliance_incident: нарушение регистрирует инженер тендера (send.register)' USING ERRCODE = '42501';
  END IF;
  IF (NEW.incident_kind = 'test_release_sent_externally') <> (r.mode = 'test') AND NEW.incident_kind <> 'other' THEN
    RAISE EXCEPTION 'compliance_incident: вид нарушения не соответствует режиму выпуска' USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at > now() + interval '1 day' THEN
    RAISE EXCEPTION 'compliance_incident: время нарушения не в будущем' USING ERRCODE = '23514';
  END IF;
  IF NEW.mail_message_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM mail_message_tender l WHERE l.message_id = NEW.mail_message_id AND l.tender_id = NEW.tender_id AND l.status = 'linked') THEN
    RAISE EXCEPTION 'compliance_incident: письмо-основание связано с тендером выпуска' USING ERRCODE = '23514';
  END IF;
  IF NEW.evidence_upload_id IS NOT NULL
     AND NOT send_evidence_upload_matches(NEW.evidence_upload_id, NEW.release_id, NEW.registered_by, NEW.evidence_blob_sha256, NEW.evidence_file_name) THEN
    RAISE EXCEPTION 'compliance_incident: файл-основание — собственная загрузка регистрирующего для этого выпуска' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER compliance_incident_guard BEFORE INSERT ON compliance_incident FOR EACH ROW EXECUTE FUNCTION compliance_incident_guard();
CREATE TRIGGER compliance_incident_immutable BEFORE UPDATE OR DELETE ON compliance_incident FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER compliance_incident_no_truncate BEFORE TRUNCATE ON compliance_incident FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- ---------------------------------------------------------------- Удержания после отправки (S15-02; state-machines §1.1 п. 4)

-- Действующий кандидат — выпущенный без засчитанной отправки: отправленный выпуск — история, новые события этапа его
-- не удерживают. Остальное — как в 0034.
CREATE OR REPLACE FUNCTION stage_input_event_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO readiness_hold (candidate_id, tender_id, stage_id, input_event_id)
  SELECT c.id, c.tender_id, c.stage_id, NEW.id FROM release_candidate c
   WHERE c.stage_id = NEW.stage_id AND c.status IN ('assembling', 'ready_for_approval', 'approved', 'released')
     AND NOT (c.status = 'released' AND release_has_counted_send(c.id))
     AND stage_event_affects(c.id, NEW.id) AND NOT stage_event_covered(c.id, NEW.id)
  ON CONFLICT (candidate_id, input_event_id) DO NOTHING;
  RETURN NULL;
END;
$$;

-- Повторная отправка: недостающие удержания по касающимся непокрытым событиям (готовность считается по событиям, а не
-- по строкам удержаний). Возвращает число созданных. Вызывающий держит блокировку этапа.
CREATE FUNCTION ensure_release_holds(p_candidate uuid) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  WITH ins AS (
    INSERT INTO readiness_hold (candidate_id, tender_id, stage_id, input_event_id)
    SELECT c.id, c.tender_id, c.stage_id, u.id
      FROM release_candidate c, candidate_uncovered_events(c.id) u(id)
     WHERE c.id = p_candidate AND c.status = 'released'
    ON CONFLICT (candidate_id, input_event_id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------- Сравнение выпусков (проект §8–§11)

CREATE TABLE release_comparison (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                 uuid NOT NULL REFERENCES tender (id),
  left_release_id           uuid NOT NULL,
  right_release_id          uuid NOT NULL,
  method_version            text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 60),
  status                    text NOT NULL DEFAULT 'computing' CHECK (status IN ('computing', 'ready', 'failed')),
  failure_reason            text CHECK (length(failure_reason) BETWEEN 1 AND 1000),
  calculation_comparison_id uuid,
  summary                   jsonb CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object'),
  result_sha256             text CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by              uuid NOT NULL REFERENCES app_user (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  finished_at               timestamptz,
  created_xact              xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT release_comparison_left_fk FOREIGN KEY (left_release_id, tender_id) REFERENCES release (id, tender_id),
  CONSTRAINT release_comparison_right_fk FOREIGN KEY (right_release_id, tender_id) REFERENCES release (id, tender_id),
  CONSTRAINT release_comparison_calculation_fk FOREIGN KEY (calculation_comparison_id, tender_id) REFERENCES calculation_comparison (id, tender_id),
  CONSTRAINT release_comparison_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT release_comparison_distinct CHECK (left_release_id <> right_release_id),
  CONSTRAINT release_comparison_ready_shape CHECK ((status = 'ready') = (result_sha256 IS NOT NULL AND summary IS NOT NULL)),
  CONSTRAINT release_comparison_failed_shape CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT release_comparison_finished_shape CHECK ((status = 'computing') = (finished_at IS NULL))
);
CREATE INDEX release_comparison_tender_idx ON release_comparison (tender_id, created_at DESC);

CREATE FUNCTION release_comparison_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'computing' OR NEW.created_xact <> pg_current_xact_id() THEN
      RAISE EXCEPTION 'release_comparison: сравнение создаётся в состоянии computing' USING ERRCODE = '23514';
    END IF;
    IF NOT coalesce('economics.compare' = ANY (tender_capabilities(NEW.requested_by, NEW.tender_id)), false) THEN
      RAISE EXCEPTION 'release_comparison: сравнение запускает участник тендера с economics.compare' USING ERRCODE = '42501';
    END IF;
    -- Левая сторона выпущена не позже правой (при равном времени — по ID): порядок сторон детерминирован.
    IF NOT EXISTS (SELECT 1 FROM release l JOIN release r ON r.id = NEW.right_release_id
                    WHERE l.id = NEW.left_release_id AND (l.released_at, l.id) < (r.released_at, r.id)) THEN
      RAISE EXCEPTION 'release_comparison: левая сторона — выпуск, сделанный раньше правой' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'computing' OR OLD.created_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'release_comparison (frozen-after): сравнение % завершено и неизменно', OLD.id USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.left_release_id, NEW.right_release_id, NEW.method_version, NEW.requested_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.left_release_id, OLD.right_release_id, OLD.method_version, OLD.requested_by, OLD.created_at, OLD.created_xact)
     OR NEW.status = 'computing' THEN
    RAISE EXCEPTION 'release_comparison (frozen-after): стороны и метод неизменны; исход — ready или failed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_comparison_guard BEFORE INSERT OR UPDATE ON release_comparison FOR EACH ROW EXECUTE FUNCTION release_comparison_guard();
CREATE TRIGGER release_comparison_no_delete BEFORE DELETE ON release_comparison FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER release_comparison_no_truncate BEFORE TRUNCATE ON release_comparison FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Вывод сравнения: только ссылки, хэши, коды и числа — свободного текста нет (текст подставляется при чтении по правам).
CREATE TABLE release_comparison_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id uuid NOT NULL REFERENCES release_comparison (id),
  ordinal       int NOT NULL CHECK (ordinal >= 1),
  section       text NOT NULL CHECK (section IN ('sources', 'requirements', 'questions', 'terms', 'decisions', 'applications', 'received')),
  change        text NOT NULL CHECK (change ~ '^[a-z_]{3,40}$'),
  subject_type  text NOT NULL CHECK (subject_type ~ '^[a-z_]{3,40}$'),
  item_key      text NOT NULL CHECK (length(item_key) BETWEEN 1 AND 400),
  left_ref      uuid,
  right_ref     uuid,
  left_sha256   text CHECK (left_sha256 ~ '^[0-9a-f]{64}$'),
  right_sha256  text CHECK (right_sha256 ~ '^[0-9a-f]{64}$'),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT release_comparison_item_ordinal_key UNIQUE (comparison_id, ordinal),
  CONSTRAINT release_comparison_item_pair_key UNIQUE (id, comparison_id)
);
CREATE INDEX release_comparison_item_section_idx ON release_comparison_item (comparison_id, section, ordinal);

CREATE FUNCTION release_comparison_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM release_comparison c WHERE c.id = NEW.comparison_id AND c.status = 'computing' AND c.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'release_comparison_item: выводы пишутся только в транзакции создания сравнения' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_comparison_item_guard BEFORE INSERT ON release_comparison_item FOR EACH ROW EXECUTE FUNCTION release_comparison_item_guard();
CREATE TRIGGER release_comparison_item_immutable BEFORE UPDATE OR DELETE ON release_comparison_item FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER release_comparison_item_no_truncate BEFORE TRUNCATE ON release_comparison_item FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Причина вывода — версии (I11): «не установлена» → «гипотеза» → «подтверждена»; ставит только человек.
CREATE TABLE release_comparison_reason (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES tender (id),
  comparison_id uuid NOT NULL,
  item_id       uuid NOT NULL,
  version       int NOT NULL CHECK (version > 0),
  reason_kind   text NOT NULL CHECK (reason_kind IN ('document', 'answer', 'supplier', 'internal_decision', 'unknown')),
  reason_status text NOT NULL CHECK (reason_status IN ('unknown', 'hypothesis', 'confirmed')),
  rationale     text CHECK (length(rationale) BETWEEN 1 AND 4000),
  actor_user_id uuid NOT NULL REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_xact  xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT release_comparison_reason_comparison_fk FOREIGN KEY (comparison_id, tender_id) REFERENCES release_comparison (id, tender_id),
  CONSTRAINT release_comparison_reason_item_fk FOREIGN KEY (item_id, comparison_id) REFERENCES release_comparison_item (id, comparison_id),
  CONSTRAINT release_comparison_reason_version_key UNIQUE (item_id, version),
  CONSTRAINT release_comparison_reason_kind_shape CHECK ((reason_kind = 'unknown') = (reason_status = 'unknown') AND (reason_status = 'unknown' OR rationale IS NOT NULL))
);

CREATE FUNCTION release_comparison_reason_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM release_comparison c WHERE c.id = NEW.comparison_id AND c.status = 'ready') THEN
    RAISE EXCEPTION 'release_comparison_reason: причина ставится по готовому сравнению' USING ERRCODE = '23514';
  END IF;
  IF NOT coalesce('change_reason.confirm' = ANY (tender_capabilities(NEW.actor_user_id, NEW.tender_id)), false) THEN
    RAISE EXCEPTION 'release_comparison_reason: причину ставит участник тендера с change_reason.confirm' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('release_comparison_reason'), hashtext(NEW.item_id::text));
  IF NEW.version <> (SELECT coalesce(max(version), 0) + 1 FROM release_comparison_reason WHERE item_id = NEW.item_id) THEN
    RAISE EXCEPTION 'release_comparison_reason: версия — следующая по выводу' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_comparison_reason_guard BEFORE INSERT ON release_comparison_reason FOR EACH ROW EXECUTE FUNCTION release_comparison_reason_guard();
CREATE TRIGGER release_comparison_reason_immutable BEFORE UPDATE OR DELETE ON release_comparison_reason FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER release_comparison_reason_no_truncate BEFORE TRUNCATE ON release_comparison_reason FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE TABLE release_comparison_reason_basis (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reason_id   uuid NOT NULL REFERENCES release_comparison_reason (id),
  tender_id   uuid NOT NULL REFERENCES tender (id),
  basis_type  text NOT NULL CHECK (basis_type IN ('fragment', 'decision')),
  fragment_id uuid REFERENCES evidence_fragment (id),
  decision_id uuid REFERENCES decision (id),
  CONSTRAINT release_comparison_reason_basis_shape CHECK (
    (basis_type = 'fragment') = (fragment_id IS NOT NULL) AND (basis_type = 'decision') = (decision_id IS NOT NULL)),
  CONSTRAINT release_comparison_reason_basis_key UNIQUE (reason_id, fragment_id, decision_id)
);

-- Основание — только вместе с версией причины; фрагмент — из снимков этапа одной из сторон, решение — этого тендера.
CREATE FUNCTION release_comparison_reason_basis_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_left uuid;
  v_right uuid;
BEGIN
  SELECT l.stage_id, r.stage_id INTO v_left, v_right
    FROM release_comparison_reason e JOIN release_comparison c ON c.id = e.comparison_id
    JOIN release l ON l.id = c.left_release_id JOIN release r ON r.id = c.right_release_id
   WHERE e.id = NEW.reason_id AND e.tender_id = NEW.tender_id AND e.created_xact = pg_current_xact_id();
  IF v_left IS NULL THEN
    RAISE EXCEPTION 'release_comparison_reason_basis: основания пишутся вместе с версией причины' USING ERRCODE = '55000';
  END IF;
  IF (NEW.fragment_id IS NOT NULL AND NOT (fragment_in_stage(NEW.fragment_id, v_left) OR fragment_in_stage(NEW.fragment_id, v_right)))
     OR (NEW.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.tender_id = NEW.tender_id)) THEN
    RAISE EXCEPTION 'release_comparison_reason_basis: основание вне этапов сторон или тендера сравнения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_comparison_reason_basis_guard BEFORE INSERT ON release_comparison_reason_basis FOR EACH ROW EXECUTE FUNCTION release_comparison_reason_basis_guard();
CREATE TRIGGER release_comparison_reason_basis_immutable BEFORE UPDATE OR DELETE ON release_comparison_reason_basis FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER release_comparison_reason_basis_no_truncate BEFORE TRUNCATE ON release_comparison_reason_basis FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- В конце транзакции: «подтверждена» — с основанием; «не установлена» — без оснований.
CREATE FUNCTION release_comparison_reason_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_bases int;
BEGIN
  SELECT count(*) INTO v_bases FROM release_comparison_reason_basis b WHERE b.reason_id = NEW.id;
  IF NEW.reason_status = 'unknown' AND v_bases > 0 THEN
    RAISE EXCEPTION 'release_comparison_reason: у «не установлена» оснований нет' USING ERRCODE = '23514';
  END IF;
  IF NEW.reason_status = 'confirmed' AND v_bases = 0 THEN
    RAISE EXCEPTION 'release_comparison_reason: подтверждённая причина — с основанием' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER release_comparison_reason_check AFTER INSERT ON release_comparison_reason
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION release_comparison_reason_check();

-- ---------------------------------------------------------------- Статус интеграций

-- Чтение отправленных писем MailHub: машинного доступа, перечня отправленных, Message-ID и хэшей вложений нет (X-03).
-- Штатный путь — отправленное письмо, импортированное EML в ящик портала (проект §5).
INSERT INTO integration_status (system, component, status, details)
VALUES ('mailhub', 'MailHubSentReader', 'BLOCKED_EXTERNAL', '{"blockedBy": "X-03", "fallback": "eml_import_outbound", "decision": "D-035"}'::jsonb)
ON CONFLICT (system, component) DO NOTHING;

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT, UPDATE ON send_event, release_comparison TO kontur_app;
GRANT SELECT, INSERT ON send_evidence_upload, send_event_file, send_event_decision, compliance_incident, release_comparison_item,
                        release_comparison_reason, release_comparison_reason_basis TO kontur_app;
