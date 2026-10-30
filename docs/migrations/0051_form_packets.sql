-- Проверочные комплекты Q-08: версии входа и сборки неизменны; права дополнительно проверяются API по этапу.
CREATE TABLE form_packet (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 stage_id uuid NOT NULL REFERENCES tender_stage(id),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
 based_on_id uuid REFERENCES form_packet(id),
 current_version_id uuid,
 row_version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE form_packet_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 packet_id uuid NOT NULL REFERENCES form_packet(id),
 seq integer NOT NULL CHECK(seq>0),
 input jsonb NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 changes jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(packet_id,seq), UNIQUE(packet_id,id)
);
ALTER TABLE form_packet ADD CONSTRAINT form_packet_current_fk
 FOREIGN KEY(id,current_version_id) REFERENCES form_packet_version(packet_id,id);
CREATE TABLE form_packet_source (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 packet_id uuid NOT NULL REFERENCES form_packet(id),
 name text NOT NULL,
 role text NOT NULL DEFAULT 'reference' CHECK(role IN ('reference','attachment','internal')),
 origin text NOT NULL DEFAULT '',
 blob_sha256 text NOT NULL REFERENCES blob(sha256),
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE form_packet_build (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version_id uuid NOT NULL REFERENCES form_packet_version(id),
 issues jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE form_packet_file (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 build_id uuid NOT NULL REFERENCES form_packet_build(id),
 name text NOT NULL,
 blob_sha256 text NOT NULL REFERENCES blob(sha256),
 media_type text NOT NULL,
 source_id uuid REFERENCES form_packet_source(id),
 template_revision_id uuid REFERENCES template_revision(id)
 ,UNIQUE(build_id,name)
);
CREATE FUNCTION form_packet_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'form packet history is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER immutable_form_packet_version BEFORE UPDATE OR DELETE ON form_packet_version FOR EACH ROW EXECUTE FUNCTION form_packet_immutable();
CREATE TRIGGER immutable_form_packet_source BEFORE UPDATE OR DELETE ON form_packet_source FOR EACH ROW EXECUTE FUNCTION form_packet_immutable();
CREATE TRIGGER immutable_form_packet_build BEFORE UPDATE OR DELETE ON form_packet_build FOR EACH ROW EXECUTE FUNCTION form_packet_immutable();
CREATE TRIGGER immutable_form_packet_file BEFORE UPDATE OR DELETE ON form_packet_file FOR EACH ROW EXECUTE FUNCTION form_packet_immutable();
GRANT SELECT,INSERT,UPDATE ON form_packet TO kontur_app;
GRANT SELECT,INSERT ON form_packet_version,form_packet_source,form_packet_build,form_packet_file TO kontur_app;
GRANT SELECT ON form_packet,form_packet_version,form_packet_source,form_packet_build,form_packet_file TO kontur_backup;
