-- Immutable bytes and exact version pairs for file events; no rewriting historical records.
CREATE TABLE tender_history_content (
 file_id uuid PRIMARY KEY REFERENCES tender_history_file(id),
 blob_sha256 text NOT NULL REFERENCES blob(sha256),
 captured_at timestamptz NOT NULL DEFAULT now(),
 provenance text NOT NULL CHECK(provenance IN('watch','existing_blob'))
);
CREATE TABLE tender_history_record_versions (
 record_id uuid PRIMARY KEY REFERENCES tender_history_record(id),
 before_file_id uuid REFERENCES tender_history_file(id),
 after_file_id uuid REFERENCES tender_history_file(id),
 before_absent boolean NOT NULL DEFAULT false,
 after_absent boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT(before_absent AND before_file_id IS NOT NULL)),
 CHECK(NOT(after_absent AND after_file_id IS NOT NULL))
);
CREATE FUNCTION history_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f tender_history_file; size bigint;
BEGIN
 SELECT * INTO STRICT f FROM tender_history_file WHERE id=NEW.file_id;
 SELECT size_bytes INTO STRICT size FROM blob WHERE sha256=NEW.blob_sha256;
 IF size<>f.size_bytes OR(f.sha256 IS NOT NULL AND f.sha256<>NEW.blob_sha256) THEN
  RAISE EXCEPTION 'history content does not match file snapshot' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER history_content_guard BEFORE INSERT ON tender_history_content FOR EACH ROW EXECUTE FUNCTION history_content_guard();
CREATE FUNCTION history_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r tender_history_record; f tender_history_file; file_id uuid;
BEGIN
 SELECT * INTO STRICT r FROM tender_history_record WHERE id=NEW.record_id;
 IF r.restricted OR r.source_path IS NULL OR r.kind NOT IN('file_added','file_modified','file_missing','file_restored','file_content_changed') THEN
  RAISE EXCEPTION 'history event is not a file change' USING ERRCODE='23514';
 END IF;
 FOREACH file_id IN ARRAY ARRAY[NEW.before_file_id,NEW.after_file_id] LOOP
  IF file_id IS NULL THEN CONTINUE; END IF;
  SELECT * INTO STRICT f FROM tender_history_file WHERE id=file_id;
  IF f.binding_id<>r.binding_id OR f.path_key<>lower(normalize(replace(r.source_path,chr(92),'/'),NFC)) THEN
   RAISE EXCEPTION 'history version crosses source or path' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER history_versions_guard BEFORE INSERT ON tender_history_record_versions FOR EACH ROW EXECUTE FUNCTION history_versions_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['tender_history_content','tender_history_record_versions'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation(''append-only'')',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation(''append-only'')',t||'_no_truncate',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON tender_history_content,tender_history_record_versions TO kontur_app;
GRANT SELECT ON tender_history_content,tender_history_record_versions TO kontur_backup;
