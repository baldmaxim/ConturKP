-- S18-26: конкретный формат может быть подтверждён после первоначальной загрузки образца.
-- Байты и первоначальная метаинформация blob остаются неизменными. Никакого угадывания по имени
-- или остатку данных: декларацию дописывает существующий путь регистрации конкретного MIME.
-- CHECK ниже вызывает функцию при pg_restore с пустым search_path (S18-27, ADR-011).
-- Применённые миграции не меняем: настройка добавлена в ещё не установленную 0055.
ALTER FUNCTION local_input_format(text) SET search_path TO public;
CREATE TABLE blob_format_declaration (
  blob_sha256 text NOT NULL REFERENCES blob(sha256),
  media_type text NOT NULL CHECK (local_input_format(media_type) IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(blob_sha256,media_type)
);
CREATE TRIGGER blob_format_declaration_immutable BEFORE UPDATE OR DELETE ON blob_format_declaration
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER blob_format_declaration_no_truncate BEFORE TRUNCATE ON blob_format_declaration
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
GRANT SELECT,INSERT ON blob_format_declaration TO kontur_app;
GRANT SELECT ON blob_format_declaration TO kontur_backup;

-- При несовместимых декларациях формат закрыт, а не выбран по порядку записей.
-- Конкретный неподдерживаемый MIME не превращается в поддерживаемый.
CREATE FUNCTION blob_local_input_format(p_sha256 text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN b.media_type = 'application/octet-stream' THEN
      (SELECT CASE WHEN count(DISTINCT local_input_format(d.media_type))=1
                   THEN min(local_input_format(d.media_type)) END
         FROM blob_format_declaration d WHERE d.blob_sha256=b.sha256)
    WHEN EXISTS(SELECT 1 FROM blob_format_declaration d WHERE d.blob_sha256=b.sha256
                 AND local_input_format(d.media_type) IS DISTINCT FROM local_input_format(b.media_type)) THEN NULL
    ELSE local_input_format(b.media_type)
  END
  FROM blob b WHERE b.sha256=p_sha256
$$;

-- Те же правила маршрута и создания прогона; меняется только источник подтверждённого формата.
CREATE OR REPLACE FUNCTION recognition_revision_route(p_revision uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN blob_local_input_format(b.sha256) IS NULL THEN 'unsupported'
           WHEN blob_local_input_format(b.sha256) <> 'pdf' THEN 'local'
           WHEN EXISTS (SELECT 1 FROM recognition_run r
                         WHERE r.document_revision_id = dr.id AND r.engine IN ('rdweb_export', 'rdweb_api')
                           AND r.status IN ('queued', 'running', 'complete', 'partial')) THEN 'rdweb'
           ELSE d.recognition_route
         END
    FROM document_revision dr
    JOIN blob b ON b.sha256 = dr.blob_sha256
    JOIN document d ON d.id = dr.document_id
   WHERE dr.id = p_revision
$$;

CREATE OR REPLACE FUNCTION recognition_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_format text;
  v_blob   text;
  v_route  text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('recognition_import'), hashtext(NEW.document_revision_id::text));
  IF NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'recognition_run: прогон создаётся в состоянии queued' USING ERRCODE = '55000';
  END IF;
  IF (NEW.tender_id IS NULL AND NEW.contract_id IS NULL) <> document_revision_mail_owned(NEW.document_revision_id) THEN
    RAISE EXCEPTION 'recognition_run: владелец прогона не совпадает с владельцем редакции (D-025)' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM recognition_run p
        WHERE p.id = NEW.supersedes_run_id
          AND p.document_revision_id = NEW.document_revision_id
          AND p.status IN ('complete', 'partial')
     ) THEN
    RAISE EXCEPTION 'recognition_run: предшественник — завершённый прогон той же редакции' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_run_id IS NULL AND EXISTS (
       SELECT 1 FROM recognition_run p
        WHERE p.document_revision_id = NEW.document_revision_id
          AND p.status IN ('complete', 'partial')
     ) THEN
    RAISE EXCEPTION 'recognition_run: у редакции уже есть история распознавания — новый прогон встаёт за её хвостом (A10)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_run_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM recognition_run c
        WHERE c.supersedes_run_id = NEW.supersedes_run_id AND c.status NOT IN ('failed', 'cancelled')
     ) THEN
    RAISE EXCEPTION 'recognition_run: предшественник уже перекрыт — новый прогон встаёт за хвостом истории (A10)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.engine <> 'local_ocr' THEN
    IF NEW.recognizer IS NOT NULL OR NEW.recognizer_fingerprint IS NOT NULL OR NEW.recognizer_config_hash IS NOT NULL THEN
      RAISE EXCEPTION 'recognition_run: описание распознавателя есть только у локального прогона' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT blob_local_input_format(b.sha256), dr.blob_sha256 INTO v_format, v_blob
    FROM document_revision dr JOIN blob b ON b.sha256 = dr.blob_sha256
   WHERE dr.id = NEW.document_revision_id;
  IF v_format IS NULL THEN
    RAISE EXCEPTION 'recognition_run: формат оригинала не входит в перечень локального распознавания (unsupported_format, OD-4)'
      USING ERRCODE = '23514';
  END IF;
  v_route := recognition_revision_route(NEW.document_revision_id);
  IF v_route = 'rdweb' THEN
    RAISE EXCEPTION 'recognition_run: маршрут редакции — RDWeb, локальный прогон не ставится (OD-1, D-014)' USING ERRCODE = '23514';
  END IF;
  IF v_format = 'pdf' AND v_route = 'auto' AND NEW.created_by IS NULL THEN
    RAISE EXCEPTION 'recognition_run: PDF с политикой auto распознаётся локально только по явной команде (OD-1)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_artifact_sha256 <> v_blob OR NEW.source_artifact_name IS NOT NULL THEN
    RAISE EXCEPTION 'recognition_run: источник локального прогона — оригинал редакции без имени файла (AD-05a-2)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.recognizer IS NULL OR NOT local_recognizer_valid(NEW.recognizer) OR NEW.recognizer ->> 'inputFormat' <> v_format THEN
    RAISE EXCEPTION 'recognition_run: описание распознавателя неполно или не совпадает с форматом оригинала (AD-05a-2)'
      USING ERRCODE = '23514';
  END IF;
  NEW.recognizer_fingerprint := local_recognizer_fingerprint(NEW.recognizer);
  NEW.recognizer_config_hash := local_recognizer_config_hash(NEW.recognizer);
  RETURN NEW;
END;
$$;
