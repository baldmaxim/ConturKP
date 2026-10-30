-- External observations are history, not stored originals or confirmed signatures.
CREATE TABLE contract_history_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contract(id),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 100),
  group_key text NOT NULL CHECK (length(group_key) BETWEEN 1 AND 200),
  folder_name text NOT NULL CHECK (length(folder_name) BETWEEN 1 AND 1000),
  folder_path text NOT NULL,
  mapping_basis text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(contract_id,source_key,group_key)
);
CREATE TABLE contract_history_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES contract_history_binding(id),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  complete boolean NOT NULL,
  imported_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(started_at <= observed_at),
  UNIQUE(binding_id,source_sha256)
);
CREATE TABLE contract_history_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES contract_history_import(id),
  external_key text NOT NULL CHECK(length(external_key) BETWEEN 1 AND 200),
  relative_path text NOT NULL CHECK(length(relative_path) BETWEEN 1 AND 4000),
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 1000),
  role text NOT NULL CHECK(role IN ('main','addendum','appendix','act','other')),
  relation_status text NOT NULL CHECK(relation_status IN ('linked','needs_review','unassigned')),
  relation_basis text NOT NULL,
  main_key text,
  parent_key text,
  document_date date,
  date_basis text,
  modified_at timestamptz,
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0),
  mtime_ns text NOT NULL CHECK(mtime_ns ~ '^[0-9]{1,24}$'),
  signed_hint boolean NOT NULL DEFAULT false,
  draft_hint boolean NOT NULL DEFAULT false,
  locus jsonb,
  notes text NOT NULL DEFAULT '',
  UNIQUE(import_id,external_key),
  UNIQUE(import_id,relative_path),
  FOREIGN KEY(import_id,main_key) REFERENCES contract_history_entry(import_id,external_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(import_id,parent_key) REFERENCES contract_history_entry(import_id,external_key) DEFERRABLE INITIALLY DEFERRED,
  CHECK(main_key IS NULL OR main_key <> external_key),
  CHECK(parent_key IS NULL OR parent_key <> external_key),
  CHECK(role <> 'main' OR (main_key IS NULL AND parent_key IS NULL)),
  CHECK(role <> 'addendum' OR parent_key IS NULL OR parent_key=main_key),
  CHECK(relation_status <> 'linked' OR role NOT IN ('addendum','appendix') OR main_key IS NOT NULL)
);
CREATE INDEX contract_history_binding_contract ON contract_history_binding(contract_id);
CREATE INDEX contract_history_import_binding ON contract_history_import(binding_id,observed_at DESC,created_at DESC);
CREATE INDEX contract_history_entry_import ON contract_history_entry(import_id,document_date DESC,id);
CREATE FUNCTION contract_history_family_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.main_key IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM contract_history_entry m WHERE m.import_id=NEW.import_id AND m.external_key=NEW.main_key AND m.role='main'
  ) THEN RAISE EXCEPTION 'history main must be a main file in the same import' USING ERRCODE='23514'; END IF;
  IF NEW.parent_key IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM contract_history_entry p WHERE p.import_id=NEW.import_id AND p.external_key=NEW.parent_key AND p.role IN ('main','addendum')
      AND (p.external_key=NEW.main_key OR p.main_key=NEW.main_key)
  ) THEN RAISE EXCEPTION 'history parent must be in the same family' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER contract_history_family_guard AFTER INSERT ON contract_history_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contract_history_family_guard();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['contract_history_binding','contract_history_import','contract_history_entry'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()',t);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO kontur_app',t);
    EXECUTE format('GRANT SELECT ON %I TO kontur_backup',t);
  END LOOP;
END $$;
