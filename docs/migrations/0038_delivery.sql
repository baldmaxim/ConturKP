-- Этап 14 (D-034; проект docs/architecture/14-delivery-design.md): назначения размещения (папка синхронизации Яндекс
-- Диска и сетевая папка — обе файловые), их версии путей и политики, проверки доступа под учётной записью worker,
-- доставки выпуска с закреплённой версией назначения, состояния файлов, попытки и решения человека. Принятые миграции
-- 0001–0037 не меняются (ADR-002); функция возможностей тендера заменяется целиком.

-- ---------------------------------------------------------------- Права

-- delivery.manage — участник тендера-человек, инженер и руководитель (D-034 В-14-5): «Разместить», «Повторить»,
-- «Повторить после проверки», «Перенаправить», «Подтвердить облако». Назначения настраивает только администратор.
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

-- Действующий администратор-человек (назначения размещения — системная настройка).
CREATE FUNCTION is_active_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id AND r.role = 'admin'
                  WHERE u.id = p_user AND u.kind = 'human' AND u.status = 'active');
$$;

-- ---------------------------------------------------------------- Назначения

CREATE TABLE delivery_destination (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  kind               text NOT NULL CHECK (kind IN ('yandex_disk', 'smb')),
  environment        text NOT NULL CHECK (environment IN ('test', 'production')),
  active             boolean NOT NULL DEFAULT true,
  current_version_id uuid,
  created_by         uuid NOT NULL REFERENCES app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL REFERENCES app_user (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  row_version        bigint NOT NULL DEFAULT 1
);

CREATE TABLE delivery_destination_version (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id   uuid NOT NULL REFERENCES delivery_destination (id),
  version          int NOT NULL CHECK (version >= 1),
  root_path        text NOT NULL CHECK (length(root_path) BETWEEN 2 AND 400),
  staging_path     text NOT NULL CHECK (length(staging_path) BETWEEN 2 AND 400),
  include_internal boolean NOT NULL DEFAULT false,
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  created_by       uuid NOT NULL REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_destination_version_key UNIQUE (destination_id, version),
  CONSTRAINT delivery_destination_version_pair UNIQUE (id, destination_id),
  CONSTRAINT delivery_destination_version_paths CHECK (root_path <> staging_path)
);

ALTER TABLE delivery_destination
  ADD CONSTRAINT delivery_destination_current_fk FOREIGN KEY (current_version_id, id)
  REFERENCES delivery_destination_version (id, destination_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION delivery_destination_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT is_active_admin(NEW.created_by) OR NEW.updated_by <> NEW.created_by OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'delivery_destination: назначение заводит администратор' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.kind, NEW.environment, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.kind, OLD.environment, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'delivery_destination: тип и среда назначения неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'delivery_destination: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  IF NOT is_active_admin(NEW.updated_by) THEN
    RAISE EXCEPTION 'delivery_destination: назначение меняет администратор' USING ERRCODE = '42501';
  END IF;
  -- Указатель — только вперёд: на свою более позднюю версию (первое заполнение — из NULL).
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
     AND OLD.current_version_id IS NOT NULL
     AND (SELECT version FROM delivery_destination_version WHERE id = NEW.current_version_id)
         <= (SELECT version FROM delivery_destination_version WHERE id = OLD.current_version_id) THEN
    RAISE EXCEPTION 'delivery_destination: текущая версия назначения только новее прежней' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_destination_guard BEFORE INSERT OR UPDATE ON delivery_destination FOR EACH ROW EXECUTE FUNCTION delivery_destination_guard();
CREATE TRIGGER delivery_destination_no_delete BEFORE DELETE ON delivery_destination FOR EACH ROW EXECUTE FUNCTION forbid_mutation('mutable');
CREATE TRIGGER delivery_destination_no_truncate BEFORE TRUNCATE ON delivery_destination FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('mutable');

-- Назначение без версии в конце транзакции не остаётся.
CREATE FUNCTION delivery_destination_version_required() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM delivery_destination WHERE id = NEW.id AND current_version_id IS NULL) THEN
    RAISE EXCEPTION 'delivery_destination: у назначения должна быть версия путей' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER delivery_destination_version_required AFTER INSERT OR UPDATE ON delivery_destination
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION delivery_destination_version_required();

CREATE FUNCTION delivery_destination_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT is_active_admin(NEW.created_by) THEN
    RAISE EXCEPTION 'delivery_destination_version: версию заводит администратор' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> (SELECT coalesce(max(version), 0) + 1 FROM delivery_destination_version WHERE destination_id = NEW.destination_id) THEN
    RAISE EXCEPTION 'delivery_destination_version: номер версии — следующий' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_destination_version_guard BEFORE INSERT ON delivery_destination_version FOR EACH ROW EXECUTE FUNCTION delivery_destination_version_guard();
CREATE TRIGGER delivery_destination_version_immutable BEFORE UPDATE OR DELETE ON delivery_destination_version FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER delivery_destination_version_no_truncate BEFORE TRUNCATE ON delivery_destination_version FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Проверка доступа выполняет worker под учётной записью службы (D-034); запрос — администратор.
CREATE TABLE delivery_destination_probe (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id         uuid NOT NULL,
  destination_version_id uuid NOT NULL,
  job_id                 uuid,
  requested_by           uuid NOT NULL REFERENCES app_user (id),
  outcome                text NOT NULL CHECK (outcome IN ('ok', 'failed')),
  error_code             text CHECK (length(error_code) <= 60),
  detail                 text CHECK (length(detail) <= 1000),
  checked_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_destination_probe_version_fk FOREIGN KEY (destination_version_id, destination_id)
    REFERENCES delivery_destination_version (id, destination_id),
  CONSTRAINT delivery_destination_probe_shape CHECK ((outcome = 'ok') = (error_code IS NULL))
);
CREATE INDEX delivery_destination_probe_idx ON delivery_destination_probe (destination_id, checked_at DESC);

CREATE FUNCTION delivery_destination_probe_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT is_active_admin(NEW.requested_by) THEN
    RAISE EXCEPTION 'delivery_destination_probe: проверку назначения запрашивает администратор' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_destination_probe_guard BEFORE INSERT ON delivery_destination_probe FOR EACH ROW EXECUTE FUNCTION delivery_destination_probe_guard();
CREATE TRIGGER delivery_destination_probe_immutable BEFORE UPDATE OR DELETE ON delivery_destination_probe FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER delivery_destination_probe_no_truncate BEFORE TRUNCATE ON delivery_destination_probe FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Доставки

CREATE TABLE delivery (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id                uuid NOT NULL REFERENCES release (id),
  tender_id                 uuid NOT NULL REFERENCES tender (id),
  stage_id                  uuid NOT NULL REFERENCES tender_stage (id),
  destination_id            uuid NOT NULL,
  destination_version_id    uuid NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('yandex_disk', 'smb')),
  environment               text NOT NULL CHECK (environment IN ('test', 'production')),
  target_folder             text NOT NULL CHECK (length(target_folder) BETWEEN 1 AND 240),
  file_set                  text NOT NULL CHECK (file_set IN ('customer', 'all')),
  placement                 jsonb NOT NULL CHECK (jsonb_typeof(placement) = 'object'),
  placement_sha256          text NOT NULL CHECK (placement_sha256 ~ '^[0-9a-f]{64}$'),
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN (
                              'pending', 'staging', 'committing', 'verifying', 'delivered', 'failed', 'outcome_unknown', 'conflict', 'superseded')),
  attempt_count             int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code           text CHECK (length(last_error_code) <= 60),
  last_error_detail         text CHECK (length(last_error_detail) <= 1000),
  superseded_by_delivery_id uuid REFERENCES delivery (id),
  delivered_at              timestamptz,
  cloud_state               text NOT NULL CHECK (cloud_state IN ('not_applicable', 'unconfirmed', 'confirmed')),
  cloud_confirmed_by        uuid REFERENCES app_user (id),
  cloud_confirmed_at        timestamptz,
  cloud_note                text CHECK (length(btrim(cloud_note)) BETWEEN 3 AND 2000),
  created_by                uuid REFERENCES app_user (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- Транзакция создания: набор файлов закрепляется только в ней.
  created_xact              xid8 NOT NULL DEFAULT pg_current_xact_id(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  row_version               bigint NOT NULL DEFAULT 1,
  CONSTRAINT delivery_version_fk FOREIGN KEY (destination_version_id, destination_id) REFERENCES delivery_destination_version (id, destination_id),
  CONSTRAINT delivery_release_version_key UNIQUE (release_id, destination_version_id),
  CONSTRAINT delivery_delivered_shape CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT delivery_cloud_kind CHECK ((kind = 'smb') = (cloud_state = 'not_applicable')),
  CONSTRAINT delivery_cloud_shape CHECK ((cloud_state = 'confirmed') = (cloud_confirmed_by IS NOT NULL AND cloud_confirmed_at IS NOT NULL AND cloud_note IS NOT NULL)),
  CONSTRAINT delivery_cloud_delivered CHECK (cloud_state <> 'confirmed' OR status = 'delivered')
);
-- Не больше одной действующей доставки выпуска в назначение (S14-01): перенаправление сначала заменяет прежнюю.
CREATE UNIQUE INDEX delivery_active_key ON delivery (release_id, destination_id) WHERE status <> 'superseded';
CREATE INDEX delivery_release_idx ON delivery (release_id, created_at);

-- Решения человека и события доставки (только добавление): каждый человеческий переход сопровождается событием в той же
-- транзакции, по нему вторая линия проверяет автора и возможность.
CREATE TABLE delivery_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id   uuid NOT NULL REFERENCES delivery (id),
  action        text NOT NULL CHECK (action IN ('created', 'place', 'retry', 'resolve_conflict', 'redirect', 'confirm_cloud')),
  actor_user_id uuid REFERENCES app_user (id),
  reason        text CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_xact  xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT delivery_event_human_shape CHECK (action IN ('created', 'place') OR (actor_user_id IS NOT NULL AND reason IS NOT NULL))
);
CREATE INDEX delivery_event_idx ON delivery_event (delivery_id, created_at);

CREATE FUNCTION delivery_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
BEGIN
  SELECT stage_id INTO v_stage FROM delivery WHERE id = NEW.delivery_id;
  IF NEW.actor_user_id IS NOT NULL AND NOT has_stage_capability(NEW.actor_user_id, v_stage, 'delivery.manage') THEN
    RAISE EXCEPTION 'delivery_event: решение по размещению — участник тендера с delivery.manage' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_event_guard BEFORE INSERT ON delivery_event FOR EACH ROW EXECUTE FUNCTION delivery_event_guard();
CREATE TRIGGER delivery_event_immutable BEFORE UPDATE OR DELETE ON delivery_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER delivery_event_no_truncate BEFORE TRUNCATE ON delivery_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Событие человека этой транзакции по доставке.
CREATE FUNCTION delivery_human_event(p_delivery uuid, p_action text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM delivery_event e WHERE e.delivery_id = p_delivery AND e.action = p_action
                    AND e.actor_user_id IS NOT NULL AND e.created_xact = pg_current_xact_id());
$$;

CREATE FUNCTION delivery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r release%ROWTYPE;
  d delivery_destination%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO r FROM release WHERE id = NEW.release_id;
    SELECT * INTO d FROM delivery_destination WHERE id = NEW.destination_id;
    IF NEW.status <> 'pending' OR NEW.row_version <> 1 OR NEW.attempt_count <> 0 OR NEW.superseded_by_delivery_id IS NOT NULL
       OR NEW.cloud_state = 'confirmed' OR NEW.created_xact <> pg_current_xact_id() THEN
      RAISE EXCEPTION 'delivery: доставка создаётся ожидающей' USING ERRCODE = '23514';
    END IF;
    -- Среда (RT-05, D-033 В-13-2): тестовый выпуск — только в тестовое назначение, боевой — только в боевое.
    IF NEW.tender_id <> r.tender_id OR NEW.stage_id <> r.stage_id OR NEW.environment <> r.mode OR NEW.environment <> d.environment
       OR NEW.kind <> d.kind THEN
      RAISE EXCEPTION 'delivery: среда, тип и выпуск доставки совпадают с выпуском и назначением' USING ERRCODE = '23514';
    END IF;
    IF NOT d.active OR NEW.destination_version_id IS DISTINCT FROM d.current_version_id THEN
      RAISE EXCEPTION 'delivery: доставка — в активное назначение, текущая версия путей' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_by IS NOT NULL AND NOT has_stage_capability(NEW.created_by, NEW.stage_id, 'delivery.manage') THEN
      RAISE EXCEPTION 'delivery: размещает участник тендера с delivery.manage' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.release_id, NEW.tender_id, NEW.stage_id, NEW.destination_id, NEW.destination_version_id, NEW.kind, NEW.environment,
      NEW.target_folder, NEW.file_set, NEW.placement, NEW.placement_sha256, NEW.created_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.release_id, OLD.tender_id, OLD.stage_id, OLD.destination_id, OLD.destination_version_id, OLD.kind, OLD.environment,
      OLD.target_folder, OLD.file_set, OLD.placement, OLD.placement_sha256, OLD.created_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'delivery: закреплённые поля доставки неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'delivery: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  -- Конечные: delivered меняет только облако; superseded — только ссылку на заменяющую доставку (один раз).
  IF OLD.status = 'delivered' THEN
    IF NEW.status <> 'delivered' OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
      RAISE EXCEPTION 'delivery: размещённая доставка не меняется' USING ERRCODE = '55000';
    END IF;
    IF NEW.cloud_state IS DISTINCT FROM OLD.cloud_state
       AND NOT (OLD.cloud_state = 'unconfirmed' AND NEW.cloud_state = 'confirmed' AND delivery_human_event(NEW.id, 'confirm_cloud')) THEN
      RAISE EXCEPTION 'delivery: облако подтверждает человек с delivery.manage, один раз' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'superseded' THEN
    IF NEW.status <> 'superseded' OR OLD.superseded_by_delivery_id IS NOT NULL THEN
      RAISE EXCEPTION 'delivery: заменённая доставка не меняется' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.cloud_state IS DISTINCT FROM OLD.cloud_state THEN
    RAISE EXCEPTION 'delivery: облако подтверждается только у размещённой доставки' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status IN ('pending', 'outcome_unknown') AND NEW.status = 'staging')
      OR (OLD.status = 'staging' AND NEW.status IN ('committing', 'verifying'))
      OR (OLD.status = 'committing' AND NEW.status = 'verifying')
      OR (OLD.status = 'verifying' AND NEW.status = 'delivered')
      OR (OLD.status IN ('pending', 'staging', 'committing', 'verifying', 'outcome_unknown') AND NEW.status IN ('failed', 'outcome_unknown', 'conflict', 'delivered'))
      OR (OLD.status = 'failed' AND NEW.status = 'pending' AND delivery_human_event(NEW.id, 'retry'))
      OR (OLD.status = 'conflict' AND NEW.status = 'pending' AND delivery_human_event(NEW.id, 'resolve_conflict'))
      OR (OLD.status IN ('failed', 'conflict') AND NEW.status = 'superseded' AND delivery_human_event(NEW.id, 'redirect'))) THEN
      RAISE EXCEPTION 'delivery: недопустимый переход % → % (state-machines §16)', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;
  -- «Размещено» — только когда каждый файл набора и признак сверены в папке выпуска.
  IF NEW.status = 'delivered' AND EXISTS (SELECT 1 FROM delivery_file_state f WHERE f.delivery_id = NEW.id AND f.remote_state <> 'verified') THEN
    RAISE EXCEPTION 'delivery: размещено — только когда все файлы сверены' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_guard BEFORE INSERT OR UPDATE ON delivery FOR EACH ROW EXECUTE FUNCTION delivery_guard();
CREATE TRIGGER delivery_no_delete BEFORE DELETE ON delivery FOR EACH ROW EXECUTE FUNCTION forbid_mutation('mutable');
CREATE TRIGGER delivery_no_truncate BEFORE TRUNCATE ON delivery FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('mutable');

-- Заменённая доставка в конце транзакции ссылается на заменяющую — того же выпуска и назначения.
CREATE FUNCTION delivery_superseded_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM delivery o WHERE o.id = NEW.id AND o.status = 'superseded'
                AND NOT EXISTS (SELECT 1 FROM delivery n WHERE n.id = o.superseded_by_delivery_id AND n.release_id = o.release_id
                                   AND n.destination_id = o.destination_id AND n.id <> o.id)) THEN
    RAISE EXCEPTION 'delivery: заменённая доставка ссылается на новую доставку того же выпуска и назначения' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER delivery_superseded_check AFTER INSERT OR UPDATE ON delivery
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION delivery_superseded_check();

CREATE TABLE delivery_file_state (
  delivery_id   uuid NOT NULL REFERENCES delivery (id),
  ordinal       int NOT NULL CHECK (ordinal >= 1),
  path          text NOT NULL CHECK (length(path) BETWEEN 1 AND 200),
  kind          text NOT NULL CHECK (kind IN ('file', 'manifest', 'marker')),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  remote_state  text NOT NULL DEFAULT 'absent' CHECK (remote_state IN ('absent', 'staged', 'committed', 'verified', 'conflict', 'unknown')),
  remote_sha256 text CHECK (remote_sha256 ~ '^[0-9a-f]{64}$'),
  checked_at    timestamptz,
  PRIMARY KEY (delivery_id, ordinal),
  CONSTRAINT delivery_file_state_path_key UNIQUE (delivery_id, path),
  -- Сверено — только при совпадении отпечатка.
  CONSTRAINT delivery_file_state_verified CHECK (remote_state <> 'verified' OR remote_sha256 = sha256)
);

CREATE FUNCTION delivery_file_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM delivery d WHERE d.id = NEW.delivery_id AND d.status = 'pending' AND d.row_version = 1
                      AND d.created_xact = pg_current_xact_id()) THEN
      RAISE EXCEPTION 'delivery_file_state: набор файлов закрепляется при создании доставки' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.delivery_id, NEW.ordinal, NEW.path, NEW.kind, NEW.sha256, NEW.size_bytes) IS DISTINCT FROM
     (OLD.delivery_id, OLD.ordinal, OLD.path, OLD.kind, OLD.sha256, OLD.size_bytes) THEN
    RAISE EXCEPTION 'delivery_file_state: файл набора неизменен' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM delivery d WHERE d.id = NEW.delivery_id AND d.status IN ('delivered', 'superseded')) THEN
    RAISE EXCEPTION 'delivery_file_state: доставка завершена' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_file_state_guard BEFORE INSERT OR UPDATE ON delivery_file_state FOR EACH ROW EXECUTE FUNCTION delivery_file_state_guard();
CREATE TRIGGER delivery_file_state_no_delete BEFORE DELETE ON delivery_file_state FOR EACH ROW EXECUTE FUNCTION forbid_mutation('mutable');
CREATE TRIGGER delivery_file_state_no_truncate BEFORE TRUNCATE ON delivery_file_state FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('mutable');

-- Набор файлов и признак готовности в конце транзакции создания соответствуют выпуску (A27, I02): файлы — файлы кандидата
-- выпуска выбранного набора с теми же байтами, манифесты — только в наборе «все файлы», признак — один, с закреплённым
-- отпечатком; набор — по политике закреплённой версии назначения; папка выпуска — по раскладке В-14-4.
CREATE FUNCTION delivery_set_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d delivery%ROWTYPE;
  r release%ROWTYPE;
  c release_candidate%ROWTYPE;
  v_internal boolean;
  v_suffix text;
BEGIN
  SELECT * INTO d FROM delivery WHERE id = NEW.id;
  SELECT * INTO r FROM release WHERE id = d.release_id;
  SELECT * INTO c FROM release_candidate WHERE id = r.candidate_id;
  SELECT include_internal INTO v_internal FROM delivery_destination_version WHERE id = d.destination_version_id;
  v_suffix := '/Этап ' || (SELECT seq FROM tender_stage WHERE id = d.stage_id) || '/Выпуск ' || c.seq || ' ' || left(replace(r.id::text, '-', ''), 8);
  IF (d.file_set = 'all') <> v_internal
     OR d.placement->>'schema' IS DISTINCT FROM 'kontur-placement/1'
     OR d.placement->>'fileSet' IS DISTINCT FROM d.file_set
     OR d.placement->'release'->>'id' IS DISTINCT FROM r.id::text
     OR d.placement->'release'->>'mode' IS DISTINCT FROM r.mode
     OR d.placement->'release'->>'contentHash' IS DISTINCT FROM r.content_hash
     OR d.placement->'release'->>'releaseManifestSha256' IS DISTINCT FROM r.release_manifest_sha256
     OR jsonb_typeof(d.placement->'files') IS DISTINCT FROM 'array'
     OR length(d.target_folder) <= length(v_suffix) OR right(d.target_folder, length(v_suffix)) <> v_suffix
     OR left(d.target_folder, length(d.target_folder) - length(v_suffix)) ~ '[/\\]' THEN
    RAISE EXCEPTION 'delivery: признак готовности, набор или папка выпуска не соответствуют выпуску и назначению' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind = 'marker') <> 1
     OR NOT EXISTS (SELECT 1 FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind = 'marker' AND f.path = 'kontur-placement.json'
                       AND f.sha256 = d.placement_sha256)
     OR jsonb_array_length(d.placement->'files') <> (SELECT count(*) FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind <> 'marker')
     OR EXISTS ((SELECT f.path, f.sha256, f.size_bytes FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind <> 'marker')
                EXCEPT (SELECT x.path, x.sha256, x.size FROM jsonb_to_recordset(d.placement->'files') AS x(path text, sha256 text, size bigint)))
     -- Файлы — файлы кандидата выбранного набора, байты и размер — как в хранилище.
     OR EXISTS (SELECT 1 FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind <> 'marker'
                   AND f.size_bytes IS DISTINCT FROM (SELECT b.size_bytes FROM blob b WHERE b.sha256 = f.sha256))
     OR EXISTS (SELECT 1 FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind = 'file'
                   AND NOT EXISTS (SELECT 1 FROM candidate_file cf WHERE cf.candidate_id = c.id AND cf.path = f.path AND cf.blob_sha256 = f.sha256
                                      AND (d.file_set = 'all' OR (cf.audience = 'customer' AND cf.role <> 'preview'))))
     OR EXISTS (SELECT 1 FROM candidate_file cf WHERE cf.candidate_id = c.id AND (d.file_set = 'all' OR (cf.audience = 'customer' AND cf.role <> 'preview'))
                   AND NOT EXISTS (SELECT 1 FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind = 'file' AND f.path = cf.path))
     OR (SELECT count(*) FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind = 'manifest') <> (CASE WHEN d.file_set = 'all' THEN 2 ELSE 0 END)
     OR EXISTS (SELECT 1 FROM delivery_file_state f WHERE f.delivery_id = d.id AND f.kind = 'manifest'
                   AND NOT ((f.path = 'manifest.json' AND f.sha256 = c.manifest_blob_sha256)
                         OR (f.path = 'release-manifest.json' AND f.sha256 = r.release_manifest_blob_sha256))) THEN
    RAISE EXCEPTION 'delivery: набор файлов доставки не соответствует выпуску (A27)' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER delivery_set_check AFTER INSERT ON delivery
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION delivery_set_check();

CREATE TABLE delivery_attempt (
  delivery_id uuid NOT NULL REFERENCES delivery (id),
  seq         int NOT NULL CHECK (seq >= 1),
  job_id      uuid,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  outcome     text NOT NULL CHECK (outcome IN ('delivered', 'failed', 'outcome_unknown', 'conflict', 'interrupted')),
  error_code  text CHECK (length(error_code) <= 60),
  detail      text CHECK (length(detail) <= 1000),
  PRIMARY KEY (delivery_id, seq)
);
CREATE TRIGGER delivery_attempt_immutable BEFORE UPDATE OR DELETE ON delivery_attempt FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER delivery_attempt_no_truncate BEFORE TRUNCATE ON delivery_attempt FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Статус интеграций

-- Оба назначения — файловые (D-034). Без реальных тестовых назначений живой проверки нет: BLOCKED_EXTERNAL; проверки на
-- поддельных данных отмечены в details. VERIFIED_LIVE ставит только живая приёмка с артефактом (проект §16).
INSERT INTO integration_status (system, component, status, details)
VALUES ('yandex_disk', 'FsDeliveryTarget', 'BLOCKED_EXTERNAL', '{"mode": "local_sync_folder", "decision": "D-034", "fixture": "VERIFIED_FIXTURE", "blockedBy": "live test destination"}'::jsonb),
       ('smb', 'FsDeliveryTarget', 'BLOCKED_EXTERNAL', '{"mode": "network_folder", "decision": "D-034", "fixture": "VERIFIED_FIXTURE", "blockedBy": "live test destination"}'::jsonb)
ON CONFLICT (system, component) DO NOTHING;

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT, UPDATE ON delivery_destination, delivery, delivery_file_state TO kontur_app;
GRANT SELECT, INSERT ON delivery_destination_version, delivery_destination_probe, delivery_event, delivery_attempt TO kontur_app;
