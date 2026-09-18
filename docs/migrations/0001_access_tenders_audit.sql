-- 0001 — доступ, тендеры и этапы, журнал действий, идемпотентность, heartbeat процессов.
-- Выполняется ролью kontur_migrator (владелец объектов). Роль приложения kontur_app
-- получает только перечисленные права (ADR-002 §3–4, data-model §1, §4.1, §4.2, §4.12).

-- Вторая линия неизменяемости: триггер запрещает изменение строк append-only/immutable.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'таблица % (%): операция % запрещена', TG_TABLE_NAME, TG_ARGV[0], TG_OP
    USING ERRCODE = '55000';
END;
$$;

-- ---------------------------------------------------------------- Доступ

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('human', 'service')),
  service_kind  text CHECK (service_kind IN ('integration', 'model', 'system')),
  login         text NOT NULL CHECK (login ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  password_hash text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   bigint NOT NULL DEFAULT 1,
  CONSTRAINT app_user_login_key UNIQUE (login),
  CONSTRAINT app_user_kind_shape CHECK (
    (kind = 'human' AND service_kind IS NULL)
    OR (kind = 'service' AND service_kind IS NOT NULL AND password_hash IS NULL)
  )
);

CREATE TABLE user_role (
  user_id    uuid NOT NULL REFERENCES app_user (id),
  role       text NOT NULL CHECK (role IN ('admin', 'manager', 'engineer')),
  granted_by uuid REFERENCES app_user (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- Роли только у людей (data-model §4.1).
CREATE FUNCTION user_role_human_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND kind = 'human') THEN
    RAISE EXCEPTION 'роль может получить только пользователь-человек' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_role_human_only BEFORE INSERT OR UPDATE ON user_role
  FOR EACH ROW EXECUTE FUNCTION user_role_human_only();

CREATE TABLE session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   bytea NOT NULL UNIQUE,
  csrf_hash    bytea NOT NULL,
  user_id      uuid NOT NULL REFERENCES app_user (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('logout', 'password_changed', 'user_disabled', 'roles_changed'))
);
CREATE INDEX session_user_active_idx ON session (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- Тендеры

CREATE TABLE tender (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  customer_name text CHECK (length(customer_name) <= 500),
  object_name   text CHECK (length(object_name) <= 500),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by    uuid NOT NULL REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   bigint NOT NULL DEFAULT 1,
  CONSTRAINT tender_code_key UNIQUE (code)
);

CREATE TABLE tender_member (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id   uuid NOT NULL REFERENCES tender (id),
  user_id     uuid NOT NULL REFERENCES app_user (id),
  member_role text NOT NULL CHECK (member_role IN ('engineer', 'manager')),
  assigned_by uuid NOT NULL REFERENCES app_user (id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  uuid REFERENCES app_user (id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX tender_member_active_key ON tender_member (tender_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX tender_member_user_idx ON tender_member (user_id) WHERE removed_at IS NULL;

-- Вторая линия к проверке в транзакции назначения (ADR-006 §8): только активный человек
-- с соответствующей глобальной ролью; активных инженеров на тендере не больше двух.
-- Блокировка строки тендера сериализует параллельные назначения, а счёт в READ COMMITTED
-- берёт свежий снимок после ожидания блокировки.
CREATE FUNCTION tender_member_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  engineers int;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tender_id <> OLD.tender_id OR NEW.user_id <> OLD.user_id
      OR NEW.member_role <> OLD.member_role OR NEW.assigned_at <> OLD.assigned_at
      OR OLD.removed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'назначение меняется только снятием' USING ERRCODE = '55000';
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id
    WHERE u.id = NEW.user_id AND u.kind = 'human' AND u.status = 'active' AND r.role = NEW.member_role
  ) THEN
    RAISE EXCEPTION 'назначить можно только активного пользователя с ролью %', NEW.member_role
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM tender WHERE id = NEW.tender_id FOR UPDATE;
  IF NEW.member_role = 'engineer' THEN
    SELECT count(*) INTO engineers FROM tender_member
    WHERE tender_id = NEW.tender_id AND member_role = 'engineer' AND removed_at IS NULL AND id <> NEW.id;
    IF engineers >= 2 THEN
      RAISE EXCEPTION 'на тендере уже два инженера' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tender_member_guard BEFORE INSERT OR UPDATE ON tender_member
  FOR EACH ROW EXECUTE FUNCTION tender_member_guard();
CREATE TRIGGER tender_member_no_delete BEFORE DELETE ON tender_member
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('history');

CREATE TABLE tender_stage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id           uuid NOT NULL REFERENCES tender (id),
  seq                 int NOT NULL CHECK (seq > 0),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  submission_deadline timestamptz,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  kp_total_rule       text,
  -- Счётчик барьера актуальности (state-machines §1.1). События stage_input_event
  -- появляются с этапа 03; до тех пор счётчик не меняется.
  input_version       bigint NOT NULL DEFAULT 0 CHECK (input_version >= 0),
  created_by          uuid NOT NULL REFERENCES app_user (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         bigint NOT NULL DEFAULT 1,
  CONSTRAINT tender_stage_seq_key UNIQUE (tender_id, seq)
);

-- ---------------------------------------------------------------- Сервисные

CREATE TABLE audit_event (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                  bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  actor_user_id        uuid REFERENCES app_user (id),
  principal_id         uuid REFERENCES app_user (id),
  principal_kind       text NOT NULL CHECK (principal_kind IN ('human', 'model_via_mcp', 'integration', 'system', 'anonymous')),
  on_behalf_of_user_id uuid REFERENCES app_user (id),
  action               text NOT NULL,
  entity_type          text,
  entity_id            uuid,
  tender_id            uuid REFERENCES tender (id),
  request_id           text,
  outcome              text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
  details              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_event_tender_idx ON audit_event (tender_id, seq DESC);
CREATE INDEX audit_event_global_idx ON audit_event (seq DESC) WHERE tender_id IS NULL;
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- frozen-after: запись вставляется завершённой в транзакции команды и не меняется;
-- удалить можно только запись с истёкшим сроком хранения (ADR-005 §10).
CREATE TABLE idempotency_record (
  principal_id    uuid NOT NULL REFERENCES app_user (id),
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash    text NOT NULL,
  response_status int NOT NULL,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (principal_id, key),
  CHECK (expires_at >= created_at + interval '7 days')
);
CREATE FUNCTION idempotency_record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.expires_at < now() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'idempotency_record (frozen-after): операция % запрещена', TG_OP USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER idempotency_record_guard BEFORE UPDATE OR DELETE ON idempotency_record
  FOR EACH ROW EXECUTE FUNCTION idempotency_record_guard();

-- Heartbeat процессов для /ready (ADR-011 §4). Не бизнес-данные.
CREATE TABLE process_heartbeat (
  process_id   text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('worker')),
  pid          int NOT NULL,
  started_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT, UPDATE ON app_user, tender, tender_stage, session, process_heartbeat TO kontur_app;
GRANT SELECT, INSERT, DELETE ON user_role TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON tender_member TO kontur_app;
GRANT SELECT, INSERT ON audit_event TO kontur_app;
GRANT SELECT, INSERT, DELETE ON idempotency_record TO kontur_app;
GRANT SELECT ON audit_event TO kontur_backup;
GRANT SELECT ON app_user, user_role, session, tender, tender_member, tender_stage, idempotency_record, process_heartbeat TO kontur_backup;
