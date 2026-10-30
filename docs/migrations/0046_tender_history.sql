-- External chronology is provenance, never an approval, send confirmation or stored original.
CREATE TABLE tender_history_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender(id),
  external_folder_id text NOT NULL CHECK (length(external_folder_id) BETWEEN 1 AND 200),
  folder_name text NOT NULL CHECK (length(folder_name) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_folder_id),
  UNIQUE (id, tender_id)
);
CREATE TABLE tender_history_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES tender_history_binding(id),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  observation_started_at timestamptz NOT NULL,
  complete boolean NOT NULL,
  folder_name text NOT NULL,
  imported_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (observation_started_at <= observed_at),
  UNIQUE (binding_id, source_sha256)
  ,UNIQUE (id,binding_id)
);
CREATE TABLE tender_history_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES tender_history_binding(id),
  import_id uuid NOT NULL REFERENCES tender_history_import(id),
  external_key text NOT NULL CHECK (length(external_key) BETWEEN 1 AND 1000),
  revision integer NOT NULL CHECK (revision > 0),
  previous_id uuid REFERENCES tender_history_record(id),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  occurred_at timestamptz,
  source_path text,
  source_label text NOT NULL,
  restricted boolean NOT NULL DEFAULT false,
  technical boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (binding_id, external_key, revision)
  ,FOREIGN KEY (import_id,binding_id) REFERENCES tender_history_import(id,binding_id)
);
CREATE INDEX tender_history_record_order ON tender_history_record(binding_id, occurred_at DESC, id);
CREATE TABLE tender_history_file (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES tender_history_binding(id),
  import_id uuid NOT NULL REFERENCES tender_history_import(id),
  relative_path text NOT NULL,
  path_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  modified_at timestamptz,
  verified_at timestamptz,
  status text NOT NULL,
  technical boolean NOT NULL DEFAULT false,
  UNIQUE (import_id, path_key)
  ,FOREIGN KEY (import_id,binding_id) REFERENCES tender_history_import(id,binding_id)
);
CREATE INDEX tender_history_file_binding ON tender_history_file(binding_id, import_id);
CREATE FUNCTION tender_history_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='mail' AND NOT NEW.restricted THEN
    RAISE EXCEPTION 'legacy mail requires mailbox verification' USING ERRCODE='23514';
  END IF;
  IF NEW.revision=1 AND NEW.previous_id IS NOT NULL OR NEW.revision>1 AND NOT EXISTS(
    SELECT 1 FROM tender_history_record p WHERE p.id=NEW.previous_id AND p.binding_id=NEW.binding_id
      AND p.external_key=NEW.external_key AND p.revision=NEW.revision-1
  ) THEN RAISE EXCEPTION 'history revision chain' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tender_history_record_guard BEFORE INSERT ON tender_history_record FOR EACH ROW EXECUTE FUNCTION tender_history_record_guard();
CREATE TABLE tender_history_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tender(id),
  record_id uuid REFERENCES tender_history_record(id),
  file_id uuid REFERENCES tender_history_file(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  owner_user_id uuid REFERENCES app_user(id),
  due_at timestamptz,
  resolution text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND length(trim(resolution)) > 0))
);
CREATE UNIQUE INDEX tender_history_task_record ON tender_history_task(record_id) WHERE record_id IS NOT NULL;
CREATE TABLE tender_history_task_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tender_history_task(id),
  actor_user_id uuid NOT NULL REFERENCES app_user(id),
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tender_history_sync (
  binding_id uuid PRIMARY KEY REFERENCES tender_history_binding(id),
  report_path text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  configured_by uuid NOT NULL REFERENCES app_user(id),
  row_version bigint NOT NULL DEFAULT 1,
  last_scheduled_at timestamptz,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error_code text
);
GRANT SELECT,INSERT,UPDATE ON tender_history_sync TO kontur_app;
CREATE FUNCTION tender_history_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; target uuid;
BEGIN
  IF TG_TABLE_NAME='tender_history_binding' THEN actor:=NEW.created_by; target:=NEW.tender_id;
  ELSE actor:=NEW.imported_by; SELECT tender_id INTO target FROM tender_history_binding WHERE id=NEW.binding_id; END IF;
  IF NOT ('source.write'=ANY(tender_capabilities(actor,target))) OR NOT (
    'hold.resolve'=ANY(tender_capabilities(actor,target)) OR EXISTS(SELECT 1 FROM user_role WHERE user_id=actor AND role='admin')
  ) THEN RAISE EXCEPTION 'history import authorization' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tender_history_binding_guard BEFORE INSERT ON tender_history_binding FOR EACH ROW EXECUTE FUNCTION tender_history_binding_guard();
CREATE TRIGGER tender_history_import_guard BEFORE INSERT ON tender_history_import FOR EACH ROW EXECUTE FUNCTION tender_history_binding_guard();
CREATE FUNCTION tender_history_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tender_history_record r JOIN tender_history_binding b ON b.id=r.binding_id
    WHERE r.id=NEW.record_id AND b.tender_id=NEW.tender_id AND NOT r.restricted
  ) THEN RAISE EXCEPTION 'history record scope' USING ERRCODE='23514'; END IF;
  IF NEW.file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tender_history_file f JOIN tender_history_binding b ON b.id=f.binding_id
    WHERE f.id=NEW.file_id AND b.tender_id=NEW.tender_id
  ) THEN RAISE EXCEPTION 'history file scope' USING ERRCODE='23514'; END IF;
  IF NEW.owner_user_id IS NOT NULL AND NOT ('source.write'=ANY(tender_capabilities(NEW.owner_user_id,NEW.tender_id))) THEN
    RAISE EXCEPTION 'history owner is not an active member' USING ERRCODE='23514';
  END IF;
  IF NOT ('source.write'=ANY(tender_capabilities(NEW.updated_by,NEW.tender_id))) THEN
    RAISE EXCEPTION 'history task write denied' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.tender_id,NEW.record_id,NEW.file_id,NEW.created_by) IS DISTINCT FROM (OLD.tender_id,OLD.record_id,OLD.file_id,OLD.created_by) THEN
    RAISE EXCEPTION 'history task identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.row_version<>OLD.row_version+1) THEN
    RAISE EXCEPTION 'history task version or identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tender_history_task_guard BEFORE INSERT OR UPDATE ON tender_history_task FOR EACH ROW EXECUTE FUNCTION tender_history_task_guard();
CREATE FUNCTION tender_history_task_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tender_history_task_event(task_id,actor_user_id,state)
    VALUES(NEW.id,NEW.updated_by,jsonb_build_object('status',NEW.status,'ownerUserId',NEW.owner_user_id,'dueAt',NEW.due_at,'resolution',NEW.resolution,'title',NEW.title));
  RETURN NEW;
END $$;
CREATE TRIGGER tender_history_task_log AFTER INSERT OR UPDATE ON tender_history_task FOR EACH ROW EXECUTE FUNCTION tender_history_task_log();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tender_history_binding','tender_history_import','tender_history_record','tender_history_file','tender_history_task_event'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()',t);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO kontur_app',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON tender_history_task TO kontur_app;
