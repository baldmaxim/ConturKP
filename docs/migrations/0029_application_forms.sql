-- Этап 11 (D-031; проект docs/architecture/11-forms-design.md): шаблоны приложений компании и заказчика с ревизиями
-- схемы forms/1, библиотека утверждённых формулировок, приложения этапа и версии значений полей с происхождением и
-- основаниями, предложения модели с закреплённым входом. Значение поля — неизменяемая версия: история правок — сами
-- версии, «устарело» — отметка инвалидации или заменённое основание, текст не перезаписывается. Принятые миграции
-- 0001–0028 не меняются (ADR-002).

-- ---------------------------------------------------------------- Права

-- Участник тендера заполняет приложения (application.fill); руководитель тендера ведёт шаблоны заказчика
-- (template.manage). Глобальные права на шаблоны компании и формулировки — роль «руководитель» (D-031 В-11-3):
-- доступа к содержимому тендеров они не дают. Таблица повторяет packages/core/src/capabilities.ts.
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
                              'review.run', 'finding.write', 'economics.compare', 'change_reason.confirm', 'application.fill'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm',
                              'finding.accept_risk', 'source_priority.manage', 'template.manage'];
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

-- Действующий пользователь с глобальной ролью.
CREATE FUNCTION user_has_role(p_user uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM app_user u JOIN user_role r ON r.user_id = u.id
                  WHERE u.id = p_user AND u.kind = 'human' AND u.status = 'active' AND r.role = p_role)
$$;

-- Право вести шаблон: компании — роль «руководитель», заказчика — template.manage по тендеру шаблона.
CREATE FUNCTION can_manage_template(p_user uuid, p_tender uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_tender IS NULL THEN user_has_role(p_user, 'manager')
              ELSE coalesce('template.manage' = ANY (tender_capabilities(p_user, p_tender)), false) END
$$;

-- ---------------------------------------------------------------- Шаблоны и ревизии

CREATE TABLE application_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind  text NOT NULL CHECK (owner_kind IN ('company', 'customer')),
  tender_id   uuid REFERENCES tender (id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  is_demo     boolean NOT NULL DEFAULT false,
  created_by  uuid NOT NULL REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT application_template_owner_shape CHECK ((owner_kind = 'customer') = (tender_id IS NOT NULL)),
  CONSTRAINT application_template_id_tender_key UNIQUE (id, tender_id)
);

CREATE FUNCTION application_template_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.row_version <> 1 OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'application_template: шаблон создаётся действующим' USING ERRCODE = '23514';
    END IF;
    IF NOT can_manage_template(NEW.created_by, NEW.tender_id) THEN
      RAISE EXCEPTION 'application_template: шаблон компании ведёт руководитель, шаблон заказчика — руководитель тендера' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.owner_kind, NEW.tender_id, NEW.is_demo, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.owner_kind, OLD.tender_id, OLD.is_demo, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'application_template: владелец, демо-признак и автор неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'application_template: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER application_template_guard BEFORE INSERT OR UPDATE ON application_template FOR EACH ROW EXECUTE FUNCTION application_template_guard();
CREATE TRIGGER application_template_no_delete BEFORE DELETE ON application_template FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER application_template_no_truncate BEFORE TRUNCATE ON application_template FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Ревизия: содержание (схема, отпечаток, ключи, образец) неизменно с создания; утверждённая — до выбытия.
-- Ключи полей и безусловно обязательные поля — для проверок БД (условия схемы БД не вычисляет).
CREATE TABLE template_revision (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id          uuid NOT NULL REFERENCES application_template (id),
  tender_id            uuid,
  seq                  int NOT NULL CHECK (seq > 0),
  schema_version       text NOT NULL CHECK (schema_version = 'forms/1'),
  field_schema         jsonb NOT NULL CHECK (jsonb_typeof(field_schema) = 'object'),
  schema_sha256        text NOT NULL CHECK (schema_sha256 ~ '^[0-9a-f]{64}$'),
  field_keys           text[] NOT NULL CHECK (cardinality(field_keys) BETWEEN 1 AND 5000),
  required_keys        text[] NOT NULL,
  sample_blob_sha256   text CHECK (sample_blob_sha256 ~ '^[0-9a-f]{64}$'),
  sample_name          text CHECK (length(sample_name) BETWEEN 1 AND 300),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  basis_fragment_ids   uuid[] NOT NULL DEFAULT '{}',
  basis_decision_id    uuid REFERENCES decision (id),
  basis_note           text CHECK (length(basis_note) BETWEEN 1 AND 2000),
  created_by           uuid NOT NULL REFERENCES app_user (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  approved_by          uuid REFERENCES app_user (id),
  approved_at          timestamptz,
  retired_at           timestamptz,
  row_version          bigint NOT NULL DEFAULT 1,
  CONSTRAINT template_revision_seq_key UNIQUE (template_id, seq),
  CONSTRAINT template_revision_template_fk FOREIGN KEY (template_id, tender_id) REFERENCES application_template (id, tender_id),
  CONSTRAINT template_revision_required_shape CHECK (required_keys <@ field_keys),
  CONSTRAINT template_revision_sample_shape CHECK ((sample_blob_sha256 IS NULL) = (sample_name IS NULL)),
  CONSTRAINT template_revision_approved_shape CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT template_revision_retired_shape CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE INDEX template_revision_template_idx ON template_revision (template_id, seq DESC);

CREATE FUNCTION template_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tender uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT tender_id INTO v_tender FROM application_template WHERE id = NEW.template_id AND archived_at IS NULL;
    IF NOT FOUND OR NEW.tender_id IS DISTINCT FROM v_tender THEN
      RAISE EXCEPTION 'template_revision: ревизия — действующего шаблона с его тендером' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL OR NEW.row_version <> 1
       OR NEW.seq <> (SELECT coalesce(max(seq), 0) + 1 FROM template_revision WHERE template_id = NEW.template_id) THEN
      RAISE EXCEPTION 'template_revision: ревизия создаётся черновиком со следующим номером' USING ERRCODE = '23514';
    END IF;
    IF NOT can_manage_template(NEW.created_by, NEW.tender_id) THEN
      RAISE EXCEPTION 'template_revision: ревизию готовит тот, кто ведёт шаблон' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.template_id, NEW.tender_id, NEW.seq, NEW.schema_version, NEW.field_schema, NEW.schema_sha256, NEW.field_keys, NEW.required_keys,
      NEW.sample_blob_sha256, NEW.sample_name, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.template_id, OLD.tender_id, OLD.seq, OLD.schema_version, OLD.field_schema, OLD.schema_sha256, OLD.field_keys, OLD.required_keys,
      OLD.sample_blob_sha256, OLD.sample_name, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'template_revision: содержание ревизии неизменно' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'template_revision: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'retired' OR NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'retired'))
    OR (OLD.status = 'approved' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'template_revision: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- Основание задаётся только при утверждении черновика.
  IF NOT (OLD.status = 'draft' AND NEW.status = 'approved')
     AND (NEW.basis_fragment_ids, NEW.basis_decision_id, NEW.basis_note, NEW.approved_by, NEW.approved_at)
         IS DISTINCT FROM (OLD.basis_fragment_ids, OLD.basis_decision_id, OLD.basis_note, OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'template_revision: основание и утверждение задаются при утверждении' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'approved' AND OLD.status = 'draft' THEN
    IF NEW.approved_by IS NULL OR NOT can_manage_template(NEW.approved_by, NEW.tender_id) THEN
      RAISE EXCEPTION 'template_revision: утверждает тот, кто ведёт шаблон' USING ERRCODE = '42501';
    END IF;
    -- Шаблон заказчика — только с основанием в его тендере (D-031 В-11-9).
    IF NEW.tender_id IS NOT NULL AND cardinality(NEW.basis_fragment_ids) = 0 AND NEW.basis_decision_id IS NULL THEN
      RAISE EXCEPTION 'template_revision: ревизия шаблона заказчика утверждается с основанием (документ, письмо или решение)' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.basis_fragment_ids) b(id) LEFT JOIN evidence_fragment f ON f.id = b.id
                WHERE f.id IS NULL OR f.tender_id IS DISTINCT FROM NEW.tender_id)
       OR (NEW.basis_decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.basis_decision_id AND d.tender_id = NEW.tender_id)) THEN
      RAISE EXCEPTION 'template_revision: основание — фрагмент или решение тендера шаблона' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER template_revision_guard BEFORE INSERT OR UPDATE ON template_revision FOR EACH ROW EXECUTE FUNCTION template_revision_guard();
CREATE TRIGGER template_revision_no_delete BEFORE DELETE ON template_revision FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER template_revision_no_truncate BEFORE TRUNCATE ON template_revision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- ---------------------------------------------------------------- Библиотека утверждённых формулировок

-- Формулировка компании (scope_tender_id NULL) или заказчика (тендер). Текст версии неизменен; статус — предложена,
-- утверждена, выбыла. Предлагает участник с содержательной ролью, утверждает тот, кто ведёт шаблоны этого владельца.
CREATE TABLE wording (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_tender_id uuid REFERENCES tender (id),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  created_by      uuid NOT NULL REFERENCES app_user (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION can_propose_wording(p_user uuid, p_tender uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_tender IS NULL THEN user_has_role(p_user, 'manager') OR user_has_role(p_user, 'engineer')
              ELSE coalesce('application.fill' = ANY (tender_capabilities(p_user, p_tender)), false) END
$$;

CREATE FUNCTION wording_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT can_propose_wording(NEW.created_by, NEW.scope_tender_id) THEN
    RAISE EXCEPTION 'wording: формулировку предлагает участник с содержательной ролью' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wording_guard BEFORE INSERT ON wording FOR EACH ROW EXECUTE FUNCTION wording_guard();
CREATE TRIGGER wording_immutable BEFORE UPDATE OR DELETE ON wording FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER wording_no_truncate BEFORE TRUNCATE ON wording FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE TABLE wording_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wording_id   uuid NOT NULL REFERENCES wording (id),
  version      int NOT NULL CHECK (version > 0),
  text         text NOT NULL CHECK (length(text) BETWEEN 1 AND 100000),
  tags         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'retired')),
  proposed_by  uuid NOT NULL REFERENCES app_user (id),
  approved_by  uuid REFERENCES app_user (id),
  approved_at  timestamptz,
  retired_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  row_version  bigint NOT NULL DEFAULT 1,
  CONSTRAINT wording_version_key UNIQUE (wording_id, version),
  CONSTRAINT wording_version_approved_shape CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT wording_version_retired_shape CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE FUNCTION wording_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tender uuid;
BEGIN
  SELECT scope_tender_id INTO v_tender FROM wording WHERE id = NEW.wording_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.approved_by IS NOT NULL OR NEW.row_version <> 1
       OR NEW.version <> (SELECT coalesce(max(version), 0) + 1 FROM wording_version WHERE wording_id = NEW.wording_id) THEN
      RAISE EXCEPTION 'wording_version: версия создаётся предложенной со следующим номером' USING ERRCODE = '23514';
    END IF;
    IF NOT can_propose_wording(NEW.proposed_by, v_tender) THEN
      RAISE EXCEPTION 'wording_version: формулировку предлагает участник с содержательной ролью' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.wording_id, NEW.version, NEW.text, NEW.tags, NEW.proposed_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.wording_id, OLD.version, OLD.text, OLD.tags, OLD.proposed_by, OLD.created_at) THEN
    RAISE EXCEPTION 'wording_version: текст версии неизменен' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'wording_version: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'retired' OR NOT ((OLD.status = 'proposed' AND NEW.status IN ('approved', 'retired')) OR (OLD.status = 'approved' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'wording_version: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND (NEW.approved_by IS NULL OR NOT can_manage_template(NEW.approved_by, v_tender)) THEN
    RAISE EXCEPTION 'wording_version: утверждает тот, кто ведёт шаблоны этого владельца' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'approved' AND (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'wording_version: утверждение неизменно' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wording_version_guard BEFORE INSERT OR UPDATE ON wording_version FOR EACH ROW EXECUTE FUNCTION wording_version_guard();
CREATE TRIGGER wording_version_no_delete BEFORE DELETE ON wording_version FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER wording_version_no_truncate BEFORE TRUNCATE ON wording_version FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- ---------------------------------------------------------------- Приложения этапа

CREATE TABLE application_draft (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id              uuid NOT NULL REFERENCES tender (id),
  stage_id               uuid NOT NULL,
  template_revision_id   uuid NOT NULL REFERENCES template_revision (id),
  title                  text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  status                 text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'complete', 'superseded')),
  migrated_from_draft_id uuid REFERENCES application_draft (id),
  migration_report       jsonb CHECK (migration_report IS NULL OR jsonb_typeof(migration_report) = 'object'),
  created_by             uuid NOT NULL REFERENCES app_user (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  completed_by           uuid REFERENCES app_user (id),
  completed_at           timestamptz,
  row_version            bigint NOT NULL DEFAULT 1,
  created_xact           xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT application_draft_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT application_draft_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT application_draft_migration_shape CHECK ((migrated_from_draft_id IS NULL) = (migration_report IS NULL)),
  CONSTRAINT application_draft_complete_shape CHECK ((status = 'complete') = (completed_by IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX application_draft_stage_idx ON application_draft (stage_id, created_at);

-- Поле приложения — якорь версий значения (ETag поля); создаётся вместе с приложением по ключам ревизии.
CREATE TABLE draft_field (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id   uuid NOT NULL,
  tender_id  uuid NOT NULL,
  field_key  text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT draft_field_key UNIQUE (draft_id, field_key),
  CONSTRAINT draft_field_draft_fk FOREIGN KEY (draft_id, tender_id) REFERENCES application_draft (id, tender_id),
  CONSTRAINT draft_field_id_tender_key UNIQUE (id, tender_id)
);

-- Основание версии значения — действующее (D-031 В-11-5, В-11-6; урок R10-01, R10-03): фрагмент и решение — по функции
-- актуальности 0027–0028; ревизия требования — подтверждена и не заменена; факт графа D-018 — в состоянии «действует».
CREATE FUNCTION field_basis_problem(p_stage uuid, p_fragment uuid, p_decision uuid, p_requirement_revision uuid, p_evidence_fact uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_fragment IS NOT NULL OR p_decision IS NOT NULL THEN change_basis_supersession(p_stage, p_fragment, p_decision)
    WHEN p_requirement_revision IS NOT NULL THEN (
      SELECT CASE WHEN r.status <> 'confirmed' OR EXISTS (SELECT 1 FROM requirement_revision n WHERE n.supersedes_revision_id = r.id)
                  THEN 'requirement_revision_superseded' END
        FROM requirement_revision r WHERE r.id = p_requirement_revision)
    WHEN p_evidence_fact IS NOT NULL THEN (
      SELECT CASE coalesce(s.status, 'unknown') WHEN 'active' THEN NULL WHEN 'superseded' THEN 'fact_superseded'
                  WHEN 'conflict' THEN 'fact_conflict' ELSE 'fact_unknown' END
        FROM (SELECT p_evidence_fact AS id) x LEFT JOIN fact_state s ON s.evidence_fact_id = x.id)
  END
$$;

CREATE FUNCTION application_draft_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rev template_revision%ROWTYPE;
  v_problem text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_rev FROM template_revision WHERE id = NEW.template_revision_id;
    IF v_rev.status <> 'approved' OR (v_rev.tender_id IS NOT NULL AND v_rev.tender_id <> NEW.tender_id) THEN
      RAISE EXCEPTION 'application_draft: приложение — по утверждённой ревизии шаблона компании или заказчика этого тендера' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'in_progress' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'application_draft: приложение создаётся в работе' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.created_by, NEW.stage_id, 'application.fill') THEN
      RAISE EXCEPTION 'application_draft: приложение создаёт участник тендера с application.fill' USING ERRCODE = '42501';
    END IF;
    IF NEW.migrated_from_draft_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM application_draft p WHERE p.id = NEW.migrated_from_draft_id AND p.stage_id = NEW.stage_id AND p.status <> 'superseded') THEN
      RAISE EXCEPTION 'application_draft: перенос — из действующего приложения этого этапа' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.template_revision_id, NEW.migrated_from_draft_id, NEW.migration_report, NEW.created_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.template_revision_id, OLD.migrated_from_draft_id, OLD.migration_report, OLD.created_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'application_draft: ревизия шаблона, этап и перенос неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'application_draft: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'application_draft: заменённое приложение неизменно' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'complete' AND OLD.status <> 'complete' THEN
    IF NOT has_stage_capability(NEW.completed_by, NEW.stage_id, 'application.fill') THEN
      RAISE EXCEPTION 'application_draft: «заполнено» отмечает участник с application.fill' USING ERRCODE = '42501';
    END IF;
    v_problem := draft_completion_problem(NEW.id);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'application_draft: «заполнено» при незавершённых пунктах (%)', v_problem USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'superseded' AND NOT EXISTS (SELECT 1 FROM application_draft n WHERE n.migrated_from_draft_id = NEW.id) THEN
    RAISE EXCEPTION 'application_draft: «заменено» — только переносом на новую ревизию' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER application_draft_guard BEFORE INSERT OR UPDATE ON application_draft FOR EACH ROW EXECUTE FUNCTION application_draft_guard();
CREATE TRIGGER application_draft_no_delete BEFORE DELETE ON application_draft FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER application_draft_no_truncate BEFORE TRUNCATE ON application_draft FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

CREATE FUNCTION draft_field_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM application_draft a JOIN template_revision r ON r.id = a.template_revision_id
                  WHERE a.id = NEW.draft_id AND a.created_xact = pg_current_xact_id() AND NEW.field_key = ANY (r.field_keys)) THEN
    RAISE EXCEPTION 'draft_field: поля создаются вместе с приложением по ключам его ревизии' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER draft_field_guard BEFORE INSERT ON draft_field FOR EACH ROW EXECUTE FUNCTION draft_field_guard();
CREATE TRIGGER draft_field_immutable BEFORE UPDATE OR DELETE ON draft_field FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER draft_field_no_truncate BEFORE TRUNCATE ON draft_field FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Предложения модели

CREATE TABLE field_suggestion_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id         uuid NOT NULL REFERENCES tender (id),
  stage_id          uuid NOT NULL,
  draft_id          uuid NOT NULL,
  evidence_scope_id uuid NOT NULL,
  model_provider    text CHECK (length(model_provider) BETWEEN 1 AND 60),
  model_id          text CHECK (length(model_id) BETWEEN 1 AND 200),
  model_version     text CHECK (length(model_version) BETWEEN 1 AND 200),
  prompt_version    text CHECK (length(prompt_version) BETWEEN 1 AND 60),
  prompt_sha256     text CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'completed_with_gaps', 'failed')),
  coverage          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(coverage) = 'object'),
  failure_code      text CHECK (length(failure_code) BETWEEN 1 AND 60),
  requested_by      uuid NOT NULL REFERENCES app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  created_xact      xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT field_suggestion_run_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT field_suggestion_run_draft_fk FOREIGN KEY (draft_id, tender_id) REFERENCES application_draft (id, tender_id),
  CONSTRAINT field_suggestion_run_scope_fk FOREIGN KEY (evidence_scope_id, tender_id) REFERENCES evidence_scope (id, tender_id),
  CONSTRAINT field_suggestion_run_model_shape CHECK (num_nulls(model_provider, model_id, model_version, prompt_version, prompt_sha256) IN (0, 5)),
  CONSTRAINT field_suggestion_run_finished_shape CHECK ((status IN ('completed', 'completed_with_gaps', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT field_suggestion_run_failure_shape CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX field_suggestion_run_draft_idx ON field_suggestion_run (draft_id, created_at DESC);

CREATE FUNCTION field_suggestion_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' THEN
      RAISE EXCEPTION 'field_suggestion_run: прогон создаётся в очереди' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.requested_by, NEW.stage_id, 'application.fill') THEN
      RAISE EXCEPTION 'field_suggestion_run: предложения запрашивает участник с application.fill' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM application_draft a WHERE a.id = NEW.draft_id AND a.stage_id = NEW.stage_id AND a.status <> 'superseded')
       OR NOT EXISTS (SELECT 1 FROM evidence_scope s WHERE s.id = NEW.evidence_scope_id AND s.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'field_suggestion_run: приложение и снимок области — этого этапа' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('completed', 'completed_with_gaps', 'failed') THEN
    RAISE EXCEPTION 'field_suggestion_run: завершённый прогон неизменен' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.draft_id, NEW.evidence_scope_id, NEW.model_provider, NEW.model_id, NEW.model_version,
      NEW.prompt_version, NEW.prompt_sha256, NEW.requested_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.draft_id, OLD.evidence_scope_id, OLD.model_provider, OLD.model_id, OLD.model_version,
      OLD.prompt_version, OLD.prompt_sha256, OLD.requested_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'field_suggestion_run: закреплённые входы прогона неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
                                    OR (OLD.status = 'running' AND NEW.status IN ('completed', 'completed_with_gaps', 'failed'))) THEN
    RAISE EXCEPTION 'field_suggestion_run: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER field_suggestion_run_guard BEFORE INSERT OR UPDATE ON field_suggestion_run FOR EACH ROW EXECUTE FUNCTION field_suggestion_run_guard();
CREATE TRIGGER field_suggestion_run_no_delete BEFORE DELETE ON field_suggestion_run FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER field_suggestion_run_no_truncate BEFORE TRUNCATE ON field_suggestion_run FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

CREATE TABLE field_suggestion_run_input (
  run_id       uuid PRIMARY KEY REFERENCES field_suggestion_run (id),
  input        jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  created_xact xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE FUNCTION field_suggestion_run_input_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM field_suggestion_run r WHERE r.id = NEW.run_id AND r.status = 'queued' AND r.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'field_suggestion_run_input: вход закрепляется в транзакции запуска прогона' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER field_suggestion_run_input_guard BEFORE INSERT ON field_suggestion_run_input FOR EACH ROW EXECUTE FUNCTION field_suggestion_run_input_guard();
CREATE TRIGGER field_suggestion_run_input_immutable BEFORE UPDATE OR DELETE ON field_suggestion_run_input FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER field_suggestion_run_input_no_truncate BEFORE TRUNCATE ON field_suggestion_run_input FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE FUNCTION field_suggestion_run_input_required() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM field_suggestion_run_input i WHERE i.run_id = NEW.id) THEN
    RAISE EXCEPTION 'field_suggestion_run: прогон создаётся с закреплённым входом' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER field_suggestion_run_input_required AFTER INSERT ON field_suggestion_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION field_suggestion_run_input_required();

-- Предложение модели: прошло гейт цитат (иначе не пишется); значением становится только принятием человека.
CREATE TABLE field_suggestion (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id        uuid NOT NULL REFERENCES tender (id),
  stage_id         uuid NOT NULL REFERENCES tender_stage (id),
  run_id           uuid NOT NULL REFERENCES field_suggestion_run (id),
  draft_id         uuid NOT NULL REFERENCES application_draft (id),
  field_id         uuid NOT NULL REFERENCES draft_field (id),
  value            jsonb NOT NULL,
  rationale        text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'expired')),
  decided_by       uuid REFERENCES app_user (id),
  decided_at       timestamptz,
  decision_reason  text CHECK (length(decision_reason) BETWEEN 1 AND 2000),
  field_version_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  row_version      bigint NOT NULL DEFAULT 1,
  created_xact     xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT field_suggestion_key UNIQUE (run_id, field_id),
  CONSTRAINT field_suggestion_decided_shape CHECK ((status IN ('accepted', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT field_suggestion_version_shape CHECK ((status = 'accepted') = (field_version_id IS NOT NULL))
);

CREATE FUNCTION field_suggestion_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'open' OR NOT EXISTS (
       SELECT 1 FROM field_suggestion_run r JOIN draft_field f ON f.draft_id = r.draft_id
        WHERE r.id = NEW.run_id AND r.status = 'running' AND r.stage_id = NEW.stage_id AND r.tender_id = NEW.tender_id AND r.draft_id = NEW.draft_id AND f.id = NEW.field_id) THEN
    RAISE EXCEPTION 'field_suggestion: предложение пишет выполняющийся прогон по полю своего приложения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER field_suggestion_insert_guard BEFORE INSERT ON field_suggestion FOR EACH ROW EXECUTE FUNCTION field_suggestion_insert_guard();

CREATE FUNCTION field_suggestion_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'field_suggestion: решённое предложение неизменно' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.run_id, NEW.draft_id, NEW.field_id, NEW.value, NEW.rationale, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.run_id, OLD.draft_id, OLD.field_id, OLD.value, OLD.rationale, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'field_suggestion: содержание предложения неизменно' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'field_suggestion: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IN ('accepted', 'rejected') AND NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'application.fill') THEN
    RAISE EXCEPTION 'field_suggestion: предложение решает человек с application.fill' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
       SELECT 1 FROM draft_field_version v WHERE v.id = NEW.field_version_id AND v.suggestion_id = NEW.id AND v.field_id = NEW.field_id) THEN
    RAISE EXCEPTION 'field_suggestion: принятие — с версией значения по этому предложению' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER field_suggestion_update_guard BEFORE UPDATE ON field_suggestion FOR EACH ROW EXECUTE FUNCTION field_suggestion_update_guard();
CREATE TRIGGER field_suggestion_no_delete BEFORE DELETE ON field_suggestion FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER field_suggestion_no_truncate BEFORE TRUNCATE ON field_suggestion FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Цитата предложения — фрагмент закреплённого входа этого поля, с дословной фразой.
CREATE TABLE field_suggestion_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id uuid NOT NULL REFERENCES field_suggestion (id),
  fragment_id   uuid NOT NULL REFERENCES evidence_fragment (id),
  quote         text NOT NULL CHECK (length(quote) BETWEEN 1 AND 2000),
  CONSTRAINT field_suggestion_evidence_key UNIQUE (suggestion_id, fragment_id)
);
CREATE FUNCTION field_suggestion_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM field_suggestion s JOIN field_suggestion_run_input i ON i.run_id = s.run_id JOIN draft_field f ON f.id = s.field_id
        WHERE s.id = NEW.suggestion_id AND s.created_xact = pg_current_xact_id()
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.input -> 'fields') x
                       WHERE x ->> 'fieldKey' = f.field_key
                         AND EXISTS (SELECT 1 FROM jsonb_array_elements(x -> 'fragments') g WHERE g ->> 'fragmentId' = NEW.fragment_id::text))) THEN
    RAISE EXCEPTION 'field_suggestion_evidence: цитата — фрагмент закреплённого входа этого поля' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER field_suggestion_evidence_guard BEFORE INSERT ON field_suggestion_evidence FOR EACH ROW EXECUTE FUNCTION field_suggestion_evidence_guard();
CREATE TRIGGER field_suggestion_evidence_immutable BEFORE UPDATE OR DELETE ON field_suggestion_evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER field_suggestion_evidence_no_truncate BEFORE TRUNCATE ON field_suggestion_evidence FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Версии значений полей

CREATE TABLE draft_field_version (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id             uuid NOT NULL,
  draft_id             uuid NOT NULL,
  tender_id            uuid NOT NULL,
  version              int NOT NULL CHECK (version > 0),
  value                jsonb,
  state                text NOT NULL CHECK (state IN ('accepted', 'edited', 'needs_discussion', 'cleared', 'carried_over')),
  origin               text NOT NULL CHECK (origin IN ('manual', 'approved_wording', 'model_suggestion', 'system_suggestion', 'carried_over')),
  wording_version_id   uuid REFERENCES wording_version (id),
  suggestion_id        uuid REFERENCES field_suggestion (id),
  previous_version_id  uuid REFERENCES draft_field_version (id),
  carried_from_version_id uuid REFERENCES draft_field_version (id),
  comment              text CHECK (length(comment) BETWEEN 1 AND 4000),
  responsible_user_id  uuid REFERENCES app_user (id),
  customer_question_id uuid REFERENCES customer_question (id),
  actor_user_id        uuid NOT NULL REFERENCES app_user (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_xact         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT draft_field_version_key UNIQUE (field_id, version),
  CONSTRAINT draft_field_version_field_fk FOREIGN KEY (field_id, tender_id) REFERENCES draft_field (id, tender_id),
  CONSTRAINT draft_field_version_value_shape CHECK (
    (state IN ('accepted', 'edited', 'carried_over') AND value IS NOT NULL)
    OR (state = 'cleared' AND value IS NULL)
    OR (state = 'needs_discussion' AND comment IS NOT NULL)),
  CONSTRAINT draft_field_version_origin_shape CHECK (
    (origin = 'approved_wording') = (wording_version_id IS NOT NULL)
    AND (origin = 'model_suggestion') = (suggestion_id IS NOT NULL)
    AND ((origin = 'carried_over') = (state = 'carried_over'))
    AND ((origin = 'carried_over') = (carried_from_version_id IS NOT NULL)))
);
CREATE INDEX draft_field_version_draft_idx ON draft_field_version (draft_id, field_id, version DESC);

CREATE FUNCTION draft_field_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_draft application_draft%ROWTYPE;
  v_field draft_field%ROWTYPE;
  v_prev  uuid;
  v_scope uuid;
BEGIN
  SELECT * INTO v_field FROM draft_field WHERE id = NEW.field_id;
  SELECT * INTO v_draft FROM application_draft WHERE id = v_field.draft_id;
  IF NEW.draft_id <> v_field.draft_id OR NEW.tender_id <> v_draft.tender_id THEN
    RAISE EXCEPTION 'draft_field_version: версия — поля своего приложения' USING ERRCODE = '23514';
  END IF;
  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'draft_field_version: значение меняется только у приложения в работе' USING ERRCODE = '55000';
  END IF;
  IF NOT has_stage_capability(NEW.actor_user_id, v_draft.stage_id, 'application.fill') THEN
    RAISE EXCEPTION 'draft_field_version: значение вносит участник тендера с application.fill' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_prev FROM draft_field_version WHERE field_id = NEW.field_id ORDER BY version DESC LIMIT 1;
  IF NEW.version <> (SELECT coalesce(max(version), 0) + 1 FROM draft_field_version WHERE field_id = NEW.field_id)
     OR NEW.previous_version_id IS DISTINCT FROM v_prev THEN
    RAISE EXCEPTION 'draft_field_version: следующая версия поля со ссылкой на текущую' USING ERRCODE = '23514';
  END IF;
  IF NEW.origin = 'carried_over' AND (v_draft.created_xact <> pg_current_xact_id() OR NOT EXISTS (
       SELECT 1 FROM draft_field_version c JOIN draft_field cf ON cf.id = c.field_id
        WHERE c.id = NEW.carried_from_version_id AND cf.draft_id = v_draft.migrated_from_draft_id AND cf.field_key = v_field.field_key)) THEN
    RAISE EXCEPTION 'draft_field_version: перенос — в транзакции переноса из того же поля прежнего приложения' USING ERRCODE = '23514';
  END IF;
  IF NEW.origin = 'approved_wording' THEN
    SELECT w.scope_tender_id INTO v_scope FROM wording_version v JOIN wording w ON w.id = v.wording_id WHERE v.id = NEW.wording_version_id AND v.status = 'approved';
    IF NOT FOUND OR (v_scope IS NOT NULL AND v_scope <> NEW.tender_id) THEN
      RAISE EXCEPTION 'draft_field_version: формулировка — утверждённая версия библиотеки компании или этого тендера' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.origin = 'model_suggestion' AND NOT EXISTS (
       SELECT 1 FROM field_suggestion s WHERE s.id = NEW.suggestion_id AND s.field_id = NEW.field_id AND s.status = 'open') THEN
    RAISE EXCEPTION 'draft_field_version: принимается открытое предложение этого поля' USING ERRCODE = '23514';
  END IF;
  IF NEW.customer_question_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM customer_question q WHERE q.id = NEW.customer_question_id AND q.stage_id = v_draft.stage_id) THEN
    RAISE EXCEPTION 'draft_field_version: вопрос заказчику — этого этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER draft_field_version_guard BEFORE INSERT ON draft_field_version FOR EACH ROW EXECUTE FUNCTION draft_field_version_guard();
CREATE TRIGGER draft_field_version_immutable BEFORE UPDATE OR DELETE ON draft_field_version FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER draft_field_version_no_truncate BEFORE TRUNCATE ON draft_field_version FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

ALTER TABLE field_suggestion ADD CONSTRAINT field_suggestion_version_fk FOREIGN KEY (field_version_id) REFERENCES draft_field_version (id);

CREATE TABLE draft_field_basis (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_version_id        uuid NOT NULL REFERENCES draft_field_version (id),
  tender_id               uuid NOT NULL REFERENCES tender (id),
  basis_type              text NOT NULL CHECK (basis_type IN ('fragment', 'decision', 'requirement_revision', 'evidence_fact')),
  fragment_id             uuid REFERENCES evidence_fragment (id),
  decision_id             uuid REFERENCES decision (id),
  requirement_revision_id uuid REFERENCES requirement_revision (id),
  evidence_fact_id        uuid REFERENCES evidence_fact (id),
  quote                   text CHECK (length(quote) BETWEEN 1 AND 2000),
  CONSTRAINT draft_field_basis_shape CHECK (
    num_nonnulls(fragment_id, decision_id, requirement_revision_id, evidence_fact_id) = 1
    AND (basis_type = 'fragment') = (fragment_id IS NOT NULL)
    AND (basis_type = 'decision') = (decision_id IS NOT NULL)
    AND (basis_type = 'requirement_revision') = (requirement_revision_id IS NOT NULL)
    AND (basis_type = 'evidence_fact') = (evidence_fact_id IS NOT NULL)),
  CONSTRAINT draft_field_basis_key UNIQUE (field_version_id, fragment_id, decision_id, requirement_revision_id, evidence_fact_id)
);
CREATE INDEX draft_field_basis_version_idx ON draft_field_basis (field_version_id);

CREATE FUNCTION draft_field_basis_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
BEGIN
  SELECT a.stage_id INTO v_stage FROM draft_field_version v JOIN application_draft a ON a.id = v.draft_id
   WHERE v.id = NEW.field_version_id AND v.tender_id = NEW.tender_id AND v.created_xact = pg_current_xact_id();
  IF v_stage IS NULL THEN
    RAISE EXCEPTION 'draft_field_basis: основания пишутся вместе с версией значения' USING ERRCODE = '55000';
  END IF;
  IF (NEW.fragment_id IS NOT NULL AND NOT fragment_in_stage(NEW.fragment_id, v_stage))
     OR (NEW.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.tender_id = NEW.tender_id))
     OR (NEW.requirement_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM requirement_revision r WHERE r.id = NEW.requirement_revision_id AND r.tender_id = NEW.tender_id))
     OR (NEW.evidence_fact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fact_state s WHERE s.evidence_fact_id = NEW.evidence_fact_id AND s.tender_id = NEW.tender_id)) THEN
    RAISE EXCEPTION 'draft_field_basis: основание вне этапа или тендера приложения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER draft_field_basis_guard BEFORE INSERT ON draft_field_basis FOR EACH ROW EXECUTE FUNCTION draft_field_basis_guard();
CREATE TRIGGER draft_field_basis_immutable BEFORE UPDATE OR DELETE ON draft_field_basis FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER draft_field_basis_no_truncate BEFORE TRUNCATE ON draft_field_basis FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Основание — действующее: при вставке и в конце транзакции (замена, зафиксированная параллельно).
CREATE FUNCTION draft_field_basis_fresh() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
  v_cause text;
BEGIN
  SELECT a.stage_id INTO v_stage FROM draft_field_version v JOIN application_draft a ON a.id = v.draft_id WHERE v.id = NEW.field_version_id;
  v_cause := field_basis_problem(v_stage, NEW.fragment_id, NEW.decision_id, NEW.requirement_revision_id, NEW.evidence_fact_id);
  IF v_cause IS NOT NULL THEN
    RAISE EXCEPTION 'draft_field_basis: основание заменено или в конфликте (%): значение по нему не подтверждается', v_cause USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER draft_field_basis_fresh AFTER INSERT ON draft_field_basis FOR EACH ROW EXECUTE FUNCTION draft_field_basis_fresh();
CREATE CONSTRAINT TRIGGER draft_field_basis_fresh_at_commit AFTER INSERT ON draft_field_basis
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION draft_field_basis_fresh();

-- Проверки «заполнено» второй линией: безусловно обязательные поля — с подтверждённым значением; нет перенесённых
-- без подтверждения, требующих обсуждения и с заменённым или конфликтующим основанием (условия схемы — сервер).
CREATE FUNCTION draft_completion_problem(p_draft uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH d AS (SELECT a.id, a.stage_id, r.required_keys FROM application_draft a JOIN template_revision r ON r.id = a.template_revision_id WHERE a.id = p_draft),
  latest AS (
    SELECT DISTINCT ON (f.id) f.field_key, v.id AS version_id, v.state, v.value
      FROM draft_field f JOIN draft_field_version v ON v.field_id = f.id
     WHERE f.draft_id = p_draft
     ORDER BY f.id, v.version DESC)
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM d, unnest(d.required_keys) k(key)
                  WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.field_key = k.key AND l.state IN ('accepted', 'edited') AND l.value IS NOT NULL))
      THEN 'required_empty'
    WHEN EXISTS (SELECT 1 FROM latest WHERE state = 'carried_over') THEN 'carried_over'
    WHEN EXISTS (SELECT 1 FROM latest WHERE state = 'needs_discussion') THEN 'needs_discussion'
    WHEN EXISTS (SELECT 1 FROM latest l JOIN draft_field_basis b ON b.field_version_id = l.version_id, d
                  WHERE field_basis_problem(d.stage_id, b.fragment_id, b.decision_id, b.requirement_revision_id, b.evidence_fact_id) IS NOT NULL)
      THEN 'basis_superseded'
  END
$$;

-- Предложение системы и модели принимается с основанием (D-031 В-11-5, В-11-6).
CREATE FUNCTION draft_field_version_basis_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin IN ('model_suggestion', 'system_suggestion') AND NOT EXISTS (SELECT 1 FROM draft_field_basis b WHERE b.field_version_id = NEW.id) THEN
    RAISE EXCEPTION 'draft_field_version: принятое предложение — с основанием' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER draft_field_version_basis_check AFTER INSERT ON draft_field_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION draft_field_version_basis_check();

-- ---------------------------------------------------------------- Зависимости и инвалидация

ALTER TABLE evidence_dependency DROP CONSTRAINT evidence_dependency_dependent_type_check;
ALTER TABLE evidence_dependency
  ADD CONSTRAINT evidence_dependency_dependent_type_check CHECK (dependent_type IN ('finding', 'discrepancy_status_event', 'model_suggestion',
                                                                                   'change_explanation', 'change_reason_suggestion',
                                                                                   'draft_field_version', 'field_suggestion'));
ALTER TABLE evidence_invalidation DROP CONSTRAINT evidence_invalidation_dependent_type_check;
ALTER TABLE evidence_invalidation
  ADD CONSTRAINT evidence_invalidation_dependent_type_check CHECK (dependent_type IN ('finding', 'decision', 'discrepancy_status_event', 'model_suggestion',
                                                                                     'change_explanation', 'change_reason_suggestion',
                                                                                     'draft_field_version', 'field_suggestion'));

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT ON wording, draft_field, draft_field_version, draft_field_basis, field_suggestion_run_input, field_suggestion_evidence TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON application_template, template_revision, wording_version, application_draft, field_suggestion_run, field_suggestion TO kontur_app;
