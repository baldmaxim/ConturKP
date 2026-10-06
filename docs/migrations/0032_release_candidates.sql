-- Этап 12 (D-032; ADR-013; проект docs/architecture/12-generation-design.md): разметка образцов шаблонов, библиотека
-- стандартных вложений, неизменяемый кандидат выпуска с закреплёнными входами, точными файлами, итогами проверок и
-- манифестом. Согласование, удержания, выпуск — этап 13. Принятые миграции 0001–0031 не меняются (ADR-002).

-- ---------------------------------------------------------------- Права

-- candidate.create — участник тендера (руководитель или инженер, D-032 В-12-7); модель и MCP его не получают (I12).
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

-- ---------------------------------------------------------------- Разметка образца ревизии шаблона (В-12-3)

-- Размеченная копия образца, формат генерации, аудитория и итог проверки разметки — содержание ревизии: задаются при
-- создании вместе со схемой и неизменны; оригинал образца (`sample_blob_sha256`) сохраняется.
ALTER TABLE template_revision
  ADD COLUMN output_format text CHECK (output_format IN ('docx', 'xlsx')),
  ADD COLUMN audience text NOT NULL DEFAULT 'customer' CHECK (audience IN ('customer', 'internal')),
  ADD COLUMN marked_sample_blob_sha256 text CHECK (marked_sample_blob_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN marked_sample_name text CHECK (length(marked_sample_name) BETWEEN 1 AND 300),
  ADD COLUMN markup jsonb CHECK (jsonb_typeof(markup) = 'object'),
  ADD CONSTRAINT template_revision_markup_shape CHECK (
    (marked_sample_blob_sha256 IS NULL) = (marked_sample_name IS NULL)
    AND (marked_sample_blob_sha256 IS NULL) = (output_format IS NULL)
    AND (marked_sample_blob_sha256 IS NULL) = (markup IS NULL)
    AND (markup IS NULL OR jsonb_typeof(markup -> 'ok') = 'boolean'));

CREATE OR REPLACE FUNCTION template_revision_guard() RETURNS trigger
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
    IF NEW.marked_sample_blob_sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blob b WHERE b.sha256 = NEW.marked_sample_blob_sha256) THEN
      RAISE EXCEPTION 'template_revision: размеченный образец — файл хранилища' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.template_id, NEW.tender_id, NEW.seq, NEW.schema_version, NEW.field_schema, NEW.schema_sha256, NEW.field_keys, NEW.required_keys,
      NEW.sample_blob_sha256, NEW.sample_name, NEW.created_by, NEW.created_at,
      NEW.output_format, NEW.audience, NEW.marked_sample_blob_sha256, NEW.marked_sample_name, NEW.markup)
     IS DISTINCT FROM
     (OLD.id, OLD.template_id, OLD.tender_id, OLD.seq, OLD.schema_version, OLD.field_schema, OLD.schema_sha256, OLD.field_keys, OLD.required_keys,
      OLD.sample_blob_sha256, OLD.sample_name, OLD.created_by, OLD.created_at,
      OLD.output_format, OLD.audience, OLD.marked_sample_blob_sha256, OLD.marked_sample_name, OLD.markup) THEN
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
  IF NOT (OLD.status = 'draft' AND NEW.status = 'approved')
     AND (NEW.basis_fragment_ids, NEW.basis_decision_id, NEW.basis_note, NEW.approved_by, NEW.approved_at)
         IS DISTINCT FROM (OLD.basis_fragment_ids, OLD.basis_decision_id, OLD.basis_note, OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'template_revision: основание и утверждение задаются при утверждении' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'approved' AND OLD.status = 'draft' THEN
    IF NEW.approved_by IS NULL OR NOT can_manage_template(NEW.approved_by, NEW.tender_id) THEN
      RAISE EXCEPTION 'template_revision: утверждает тот, кто ведёт шаблон' USING ERRCODE = '42501';
    END IF;
    IF NEW.tender_id IS NOT NULL AND cardinality(NEW.basis_fragment_ids) = 0 AND NEW.basis_decision_id IS NULL THEN
      RAISE EXCEPTION 'template_revision: ревизия шаблона заказчика утверждается с основанием (документ, письмо или решение)' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.basis_fragment_ids) b(id) LEFT JOIN evidence_fragment f ON f.id = b.id
                WHERE f.id IS NULL OR f.tender_id IS DISTINCT FROM NEW.tender_id)
       OR (NEW.basis_decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.basis_decision_id AND d.tender_id = NEW.tender_id)) THEN
      RAISE EXCEPTION 'template_revision: основание — фрагмент или решение тендера шаблона' USING ERRCODE = '23514';
    END IF;
    -- Разметка образца — только проверенная (D-032 В-12-3).
    IF NEW.markup IS NOT NULL AND NOT (NEW.markup ->> 'ok')::boolean THEN
      RAISE EXCEPTION 'template_revision: размеченный образец с ошибками разметки не утверждается' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Библиотека стандартных вложений (В-12-4)

-- Вложение компании (scope_tender_id NULL) или тендера; файл ревизии — «как есть»; утверждает тот, кто ведёт шаблоны.
CREATE TABLE standard_attachment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_tender_id uuid REFERENCES tender (id),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  created_by      uuid NOT NULL REFERENCES app_user (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION standard_attachment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT can_manage_template(NEW.created_by, NEW.scope_tender_id) THEN
    RAISE EXCEPTION 'standard_attachment: вложение создаёт тот, кто ведёт шаблоны' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER standard_attachment_guard BEFORE INSERT ON standard_attachment FOR EACH ROW EXECUTE FUNCTION standard_attachment_guard();
CREATE TRIGGER standard_attachment_immutable BEFORE UPDATE OR DELETE ON standard_attachment FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER standard_attachment_no_truncate BEFORE TRUNCATE ON standard_attachment FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE TABLE standard_attachment_revision (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id   uuid NOT NULL REFERENCES standard_attachment (id),
  seq             int NOT NULL CHECK (seq > 0),
  blob_sha256     text NOT NULL REFERENCES blob (sha256),
  file_name       text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 300),
  media_type      text NOT NULL CHECK (media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                                      'application/msword', 'application/pdf')),
  audience        text NOT NULL CHECK (audience IN ('customer', 'internal')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_by      uuid NOT NULL REFERENCES app_user (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid REFERENCES app_user (id),
  approved_at     timestamptz,
  retired_at      timestamptz,
  row_version     bigint NOT NULL DEFAULT 1,
  CONSTRAINT standard_attachment_revision_seq_key UNIQUE (attachment_id, seq),
  CONSTRAINT standard_attachment_revision_approved_shape CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT standard_attachment_revision_retired_shape CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE FUNCTION standard_attachment_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_scope uuid;
BEGIN
  SELECT scope_tender_id INTO v_scope FROM standard_attachment WHERE id = NEW.attachment_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL OR NEW.row_version <> 1
       OR NEW.seq <> (SELECT coalesce(max(seq), 0) + 1 FROM standard_attachment_revision WHERE attachment_id = NEW.attachment_id) THEN
      RAISE EXCEPTION 'standard_attachment_revision: ревизия создаётся черновиком со следующим номером' USING ERRCODE = '23514';
    END IF;
    IF NOT can_manage_template(NEW.created_by, v_scope) THEN
      RAISE EXCEPTION 'standard_attachment_revision: ревизию готовит тот, кто ведёт шаблоны' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.attachment_id, NEW.seq, NEW.blob_sha256, NEW.file_name, NEW.media_type, NEW.audience, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.attachment_id, OLD.seq, OLD.blob_sha256, OLD.file_name, OLD.media_type, OLD.audience, OLD.created_by, OLD.created_at)
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'standard_attachment_revision: содержание ревизии неизменно' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'retired' OR NOT ((OLD.status = 'draft' AND NEW.status IN ('approved', 'retired')) OR (OLD.status = 'approved' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'standard_attachment_revision: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND (NEW.approved_by IS NULL OR NOT can_manage_template(NEW.approved_by, v_scope)) THEN
    RAISE EXCEPTION 'standard_attachment_revision: утверждает тот, кто ведёт шаблоны' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = 'draft' AND NEW.status = 'approved') AND (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'standard_attachment_revision: утверждение задаётся при утверждении' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER standard_attachment_revision_guard BEFORE INSERT OR UPDATE ON standard_attachment_revision FOR EACH ROW EXECUTE FUNCTION standard_attachment_revision_guard();
CREATE TRIGGER standard_attachment_revision_no_delete BEFORE DELETE ON standard_attachment_revision FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER standard_attachment_revision_no_truncate BEFORE TRUNCATE ON standard_attachment_revision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- ---------------------------------------------------------------- Кандидат выпуска

-- Создаётся «собирается» с закреплёнными входами; задание сборки переводит в «готов к согласованию» (файлы, проверки,
-- манифест) или «сборка не удалась» (код и описание). Содержимое, входы и базы неизменны; новый готовый кандидат этапа
-- заменяет прежний готовый («заменён»). Согласование и выпуск — этап 13 (расширит перечень статусов).
CREATE TABLE release_candidate (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                    uuid NOT NULL,
  stage_id                     uuid NOT NULL,
  seq                          int NOT NULL CHECK (seq > 0),
  mode                         text NOT NULL CHECK (mode IN ('test', 'production')),
  status                       text NOT NULL DEFAULT 'assembling' CHECK (status IN ('assembling', 'assembly_failed', 'ready_for_approval', 'superseded')),
  calculation_revision_id      uuid NOT NULL,
  evidence_scope_id            uuid NOT NULL,
  calculation_baseline_version bigint NOT NULL CHECK (calculation_baseline_version >= 0),
  content_baseline_version     bigint NOT NULL CHECK (content_baseline_version >= 0),
  inputs_sha256                text NOT NULL CHECK (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  converter_version            text CHECK (length(converter_version) BETWEEN 1 AND 200),
  manifest_blob_sha256         text REFERENCES blob (sha256),
  manifest_sha256              text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  failure_code                 text CHECK (failure_code ~ '^[a-z_]{1,64}$'),
  failure_detail               text CHECK (length(failure_detail) BETWEEN 1 AND 4000),
  created_by                   uuid NOT NULL REFERENCES app_user (id),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_xact                 xid8 NOT NULL DEFAULT pg_current_xact_id(),
  finished_at                  timestamptz,
  superseded_by_candidate_id   uuid REFERENCES release_candidate (id),
  row_version                  bigint NOT NULL DEFAULT 1,
  CONSTRAINT release_candidate_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT release_candidate_calculation_fk FOREIGN KEY (calculation_revision_id, tender_id) REFERENCES calculation_revision (id, tender_id),
  CONSTRAINT release_candidate_scope_fk FOREIGN KEY (evidence_scope_id, tender_id) REFERENCES evidence_scope (id, tender_id),
  CONSTRAINT release_candidate_seq_key UNIQUE (stage_id, seq),
  CONSTRAINT release_candidate_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT release_candidate_ready_shape CHECK (
    (status IN ('ready_for_approval', 'superseded'))
      = (manifest_blob_sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL AND converter_version IS NOT NULL)),
  CONSTRAINT release_candidate_failed_shape CHECK ((status = 'assembly_failed') = (failure_code IS NOT NULL)),
  CONSTRAINT release_candidate_finished_shape CHECK ((status = 'assembling') = (finished_at IS NULL)),
  CONSTRAINT release_candidate_superseded_shape CHECK ((status = 'superseded') = (superseded_by_candidate_id IS NOT NULL))
);
CREATE UNIQUE INDEX release_candidate_one_assembling ON release_candidate (stage_id) WHERE status = 'assembling';
CREATE INDEX release_candidate_stage_idx ON release_candidate (stage_id, seq DESC);

CREATE FUNCTION release_candidate_guard() RETURNS trigger
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
       OR (OLD.status = 'ready_for_approval' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'release_candidate: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'assembling'
     AND (NEW.converter_version, NEW.manifest_blob_sha256, NEW.manifest_sha256, NEW.failure_code, NEW.failure_detail, NEW.finished_at)
         IS DISTINCT FROM (OLD.converter_version, OLD.manifest_blob_sha256, OLD.manifest_sha256, OLD.failure_code, OLD.failure_detail, OLD.finished_at) THEN
    RAISE EXCEPTION 'release_candidate: содержимое собранного кандидата неизменно' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'ready_for_approval' AND NOT EXISTS (SELECT 1 FROM candidate_file f WHERE f.candidate_id = NEW.id AND f.role <> 'preview') THEN
    RAISE EXCEPTION 'release_candidate: готовый кандидат — с файлами' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'superseded' AND NOT EXISTS (
       SELECT 1 FROM release_candidate n WHERE n.id = NEW.superseded_by_candidate_id AND n.stage_id = NEW.stage_id AND n.seq > NEW.seq AND n.status = 'ready_for_approval') THEN
    RAISE EXCEPTION 'release_candidate: заменяет более новый готовый кандидат того же этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_candidate_guard BEFORE INSERT OR UPDATE ON release_candidate FOR EACH ROW EXECUTE FUNCTION release_candidate_guard();
CREATE TRIGGER release_candidate_no_delete BEFORE DELETE ON release_candidate FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER release_candidate_no_truncate BEFORE TRUNCATE ON release_candidate FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Закреплённые входы — в транзакции создания кандидата; объекты этапа и тендера кандидата.
CREATE TABLE candidate_input (
  candidate_id uuid NOT NULL REFERENCES release_candidate (id),
  kind         text NOT NULL CHECK (kind IN ('review_run', 'decision', 'application_draft', 'field_version', 'template_revision', 'attachment_revision')),
  ref_id       uuid NOT NULL,
  ordinal      int NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (candidate_id, kind, ref_id)
);

CREATE FUNCTION candidate_input_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c release_candidate%ROWTYPE;
  v_ok boolean;
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
  END;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'candidate_input: вход % — не объект этапа и тендера кандидата или не в допустимом состоянии', NEW.kind USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER candidate_input_guard BEFORE INSERT ON candidate_input FOR EACH ROW EXECUTE FUNCTION candidate_input_guard();
CREATE TRIGGER candidate_input_immutable BEFORE UPDATE OR DELETE ON candidate_input FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER candidate_input_no_truncate BEFORE TRUNCATE ON candidate_input FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Файлы кандидата: пишет задание сборки, пока кандидат «собирается»; файл — неизменяемый blob того же размера.
CREATE TABLE candidate_file (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id           uuid NOT NULL REFERENCES release_candidate (id),
  ordinal                int NOT NULL CHECK (ordinal > 0),
  path                   text NOT NULL CHECK (path ~ '^[^/\\:*?"<>|]{1,200}$'),
  role                   text NOT NULL CHECK (role IN ('document', 'attachment', 'preview')),
  audience               text NOT NULL CHECK (audience IN ('customer', 'internal')),
  media_type             text NOT NULL CHECK (length(media_type) BETWEEN 3 AND 200),
  blob_sha256            text NOT NULL REFERENCES blob (sha256),
  size_bytes             bigint NOT NULL CHECK (size_bytes >= 0),
  source_file_id         uuid REFERENCES candidate_file (id),
  template_revision_id   uuid REFERENCES template_revision (id),
  draft_id               uuid REFERENCES application_draft (id),
  attachment_revision_id uuid REFERENCES standard_attachment_revision (id),
  pages                  int CHECK (pages >= 0),
  fonts                  text[],
  CONSTRAINT candidate_file_path_key UNIQUE (candidate_id, path),
  CONSTRAINT candidate_file_ordinal_key UNIQUE (candidate_id, ordinal),
  CONSTRAINT candidate_file_preview_shape CHECK ((role = 'preview') = (source_file_id IS NOT NULL) AND (role <> 'preview' OR audience = 'internal')),
  CONSTRAINT candidate_file_origin_shape CHECK (
    (role = 'document') = (template_revision_id IS NOT NULL AND draft_id IS NOT NULL)
    AND (role = 'attachment') = (attachment_revision_id IS NOT NULL))
);
CREATE INDEX candidate_file_candidate_idx ON candidate_file (candidate_id, ordinal);

CREATE FUNCTION candidate_file_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM release_candidate c WHERE c.id = NEW.candidate_id AND c.status = 'assembling') THEN
    RAISE EXCEPTION 'candidate_file: файлы пишет сборка кандидата, пока он «собирается»' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM blob b WHERE b.sha256 = NEW.blob_sha256 AND b.size_bytes = NEW.size_bytes) THEN
    RAISE EXCEPTION 'candidate_file: размер не совпадает с файлом хранилища' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM candidate_file s WHERE s.id = NEW.source_file_id AND s.candidate_id = NEW.candidate_id AND s.role <> 'preview') THEN
    RAISE EXCEPTION 'candidate_file: превью — файла того же кандидата' USING ERRCODE = '23514';
  END IF;
  IF (NEW.template_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM candidate_input i WHERE i.candidate_id = NEW.candidate_id AND i.kind = 'template_revision' AND i.ref_id = NEW.template_revision_id))
     OR (NEW.draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM candidate_input i WHERE i.candidate_id = NEW.candidate_id AND i.kind = 'application_draft' AND i.ref_id = NEW.draft_id))
     OR (NEW.attachment_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM candidate_input i WHERE i.candidate_id = NEW.candidate_id AND i.kind = 'attachment_revision' AND i.ref_id = NEW.attachment_revision_id)) THEN
    RAISE EXCEPTION 'candidate_file: файл — из закреплённых входов кандидата' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER candidate_file_guard BEFORE INSERT ON candidate_file FOR EACH ROW EXECUTE FUNCTION candidate_file_guard();
CREATE TRIGGER candidate_file_immutable BEFORE UPDATE OR DELETE ON candidate_file FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER candidate_file_no_truncate BEFORE TRUNCATE ON candidate_file FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Итоги проверок сборки (D-032 В-12-2, В-12-6, В-12-10): пишет сборка, пока кандидат «собирается».
CREATE TABLE candidate_check (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES release_candidate (id),
  ordinal      int NOT NULL CHECK (ordinal > 0),
  code         text NOT NULL CHECK (code ~ '^[a-z_]{1,64}$'),
  outcome      text NOT NULL CHECK (outcome IN ('passed', 'failed', 'unverified', 'not_applicable')),
  path         text CHECK (length(path) BETWEEN 1 AND 200),
  detail       text CHECK (length(detail) BETWEEN 1 AND 4000),
  CONSTRAINT candidate_check_ordinal_key UNIQUE (candidate_id, ordinal)
);

CREATE FUNCTION candidate_check_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM release_candidate c WHERE c.id = NEW.candidate_id AND c.status = 'assembling') THEN
    RAISE EXCEPTION 'candidate_check: итоги проверок пишет сборка кандидата' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER candidate_check_guard BEFORE INSERT ON candidate_check FOR EACH ROW EXECUTE FUNCTION candidate_check_guard();
CREATE TRIGGER candidate_check_immutable BEFORE UPDATE OR DELETE ON candidate_check FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER candidate_check_no_truncate BEFORE TRUNCATE ON candidate_check FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Готовый кандидат — без проваленных проверок (в конце транзакции завершения сборки).
CREATE FUNCTION release_candidate_ready_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ready_for_approval' AND EXISTS (SELECT 1 FROM candidate_check k WHERE k.candidate_id = NEW.id AND k.outcome = 'failed') THEN
    RAISE EXCEPTION 'release_candidate: готовый кандидат — без проваленных проверок сборки' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER release_candidate_ready_check AFTER UPDATE ON release_candidate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION release_candidate_ready_check();

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT ON standard_attachment, candidate_input, candidate_file, candidate_check TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON standard_attachment_revision, release_candidate TO kontur_app;
