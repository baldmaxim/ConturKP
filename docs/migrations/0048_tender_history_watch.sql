ALTER TABLE tender_history_import ADD COLUMN origin text NOT NULL DEFAULT 'legacy' CHECK(origin IN ('legacy','filesystem'));
CREATE TABLE tender_history_related (
 binding_id uuid NOT NULL REFERENCES tender_history_binding(id), tender_id uuid NOT NULL REFERENCES tender(id),
 reason text NOT NULL, created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(binding_id,tender_id)
);
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON tender_history_related FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE tender_history_watch (
 binding_id uuid PRIMARY KEY REFERENCES tender_history_binding(id),root_path text NOT NULL,enabled boolean NOT NULL DEFAULT true,
 configured_by uuid NOT NULL REFERENCES app_user(id),row_version bigint NOT NULL DEFAULT 1,
 scan_interval_seconds integer NOT NULL DEFAULT 300 CHECK(scan_interval_seconds>=60),stability_seconds integer NOT NULL DEFAULT 60 CHECK(stability_seconds>=0),
 last_scheduled_at timestamptz,last_verify_scheduled_at timestamptz,last_checked_at timestamptz,last_success_at timestamptz,last_error_code text,
 last_full_hash_at timestamptz
);
CREATE TABLE tender_history_observation (
 binding_id uuid NOT NULL REFERENCES tender_history_binding(id),path_key text NOT NULL,relative_path text NOT NULL,
 file_id uuid NOT NULL REFERENCES tender_history_file(id),size_bytes bigint NOT NULL CHECK(size_bytes>=0),mtime_ms bigint NOT NULL,
 sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),verified_at timestamptz,stable_since timestamptz NOT NULL,
 present boolean NOT NULL DEFAULT true,missing_count integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'observed',
 last_seen_at timestamptz NOT NULL,PRIMARY KEY(binding_id,path_key)
);
CREATE INDEX history_observation_verify ON tender_history_observation(binding_id,verified_at) WHERE present;
CREATE TABLE tender_history_scan (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),binding_id uuid NOT NULL REFERENCES tender_history_binding(id),job_id uuid REFERENCES job(id),
 mode text NOT NULL CHECK(mode IN ('scan','verify')),started_at timestamptz NOT NULL,finished_at timestamptz NOT NULL DEFAULT now(),
 complete boolean NOT NULL,files_seen integer NOT NULL DEFAULT 0,changed integer NOT NULL DEFAULT 0,hashed integer NOT NULL DEFAULT 0,
 errors jsonb NOT NULL DEFAULT '[]',CHECK(started_at<=finished_at)
);
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON tender_history_scan FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT,INSERT ON tender_history_related,tender_history_scan TO kontur_app;
GRANT SELECT,INSERT,UPDATE ON tender_history_watch,tender_history_observation TO kontur_app;
