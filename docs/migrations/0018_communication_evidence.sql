-- 0018 — этап 07: письма, вложения и транскрипции в общей цепочке доказательств, поиска и снимка
-- (D-025: AD-07-1a — вариант A, AD-07-2a — вариант A, ограниченный). Матрицы — docs/architecture/
-- 07-mail-model-design.md §11 (почтовые доказательства) и §12 (документ вложения).
--
-- Правила:
-- * у документа ровно одно происхождение: тендер, договор или вложение письма (типизированная третья
--   ветка только у document, без owner_type/owner_id);
-- * ниже по цепочке документа колонок владельца не добавляется: у строк документа вложения нет ни
--   тендера, ни договора, а охранники вставки требуют «без владельца ⇔ документ вложения»;
-- * у фрагмента доказательства ровно один источник по виду: прогон редакции документа, ревизия письма
--   или редакция транскрипции — явные nullable FK и CHECK; ящик и письмо выводятся через
--   mail_message_revision → mail_message → mailbox, mailbox_id в старые таблицы не добавляется;
-- * в таблицах индекса tender_id/contract_id — только у единиц-прогонов (как в 0012); единицы писем
--   и транскрипций идентифицируются собственными FK; строки индекса связаны с чанком и фрагментом
--   ещё и FK без владельца — чанк не смешивает единицы ни в одной ветке;
-- * права пользователя (mail.read, доступ к тендеру) БД не хранит — их проверяет приложение до
--   ранжирования и повторно при чтении, как contract.read на 06a; БД гарантирует состав и происхождение.

-- ---------------------------------------------------------------- Документ вложения (матрица B)

ALTER TABLE document ADD COLUMN mail_attachment_id uuid REFERENCES mail_attachment (id);
ALTER TABLE document DROP CONSTRAINT document_owner_shape;
ALTER TABLE document
  ADD CONSTRAINT document_owner_shape CHECK (num_nonnulls(tender_id, contract_id, mail_attachment_id) = 1),
  ADD CONSTRAINT document_mail_attachment_key UNIQUE (mail_attachment_id);

CREATE OR REPLACE FUNCTION document_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tender_id IS DISTINCT FROM OLD.tender_id OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.mail_attachment_id IS DISTINCT FROM OLD.mail_attachment_id
     OR NEW.contract_role IS DISTINCT FROM OLD.contract_role OR NEW.main_document_id IS DISTINCT FROM OLD.main_document_id THEN
    RAISE EXCEPTION 'document: владелец, роль и ссылка на основной документ неизменны (D-023, D-025)' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Документом становится только принятое вложение.
CREATE FUNCTION document_mail_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mail_attachment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM mail_attachment a WHERE a.id = NEW.mail_attachment_id AND a.status = 'registered') THEN
    RAISE EXCEPTION 'document: документом становится только принятое вложение (AD-07-2a)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_mail_insert_guard BEFORE INSERT ON document
  FOR EACH ROW EXECUTE FUNCTION document_mail_insert_guard();

-- Редакция документа вложения — в почтовой ветке, если её документ — вложение.
CREATE FUNCTION document_revision_mail_owned(p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM document_revision r JOIN document d ON d.id = r.document_id
                  WHERE r.id = p_revision AND d.mail_attachment_id IS NOT NULL)
$$;

ALTER TABLE document_revision DROP CONSTRAINT document_revision_owner_shape;
ALTER TABLE document_revision ADD CONSTRAINT document_revision_owner_shape CHECK (num_nonnulls(tender_id, contract_id) <= 1);

-- Без владельца ⇔ документ вложения; у документа вложения ровно одна редакция — содержимое вложения.
-- Тендер и договор по-прежнему сверяют составные FK на документ (0012).
CREATE FUNCTION document_revision_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_attachment uuid;
  v_blob       text;
BEGIN
  SELECT d.mail_attachment_id, a.blob_sha256 INTO v_attachment, v_blob
    FROM document d LEFT JOIN mail_attachment a ON a.id = d.mail_attachment_id
   WHERE d.id = NEW.document_id;
  IF (NEW.tender_id IS NULL AND NEW.contract_id IS NULL) <> (v_attachment IS NOT NULL) THEN
    RAISE EXCEPTION 'document_revision: владелец редакции не совпадает с владельцем документа (D-025)' USING ERRCODE = '23514';
  END IF;
  IF v_attachment IS NOT NULL AND (NEW.blob_sha256 IS DISTINCT FROM v_blob OR NEW.revision_seq <> 1 OR NEW.supersedes_revision_id IS NOT NULL) THEN
    RAISE EXCEPTION 'document_revision: у документа вложения одна редакция — содержимое самого вложения (AD-07-2a)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_revision_owner_guard BEFORE INSERT ON document_revision
  FOR EACH ROW EXECUTE FUNCTION document_revision_owner_guard();

ALTER TABLE recognition_run DROP CONSTRAINT recognition_run_owner_shape;
ALTER TABLE recognition_run ADD CONSTRAINT recognition_run_owner_shape CHECK (num_nonnulls(tender_id, contract_id) <= 1);

-- Прежний охранник 0014 плюс: без владельца ⇔ редакция документа вложения.
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
  SELECT local_input_format(b.media_type), dr.blob_sha256 INTO v_format, v_blob
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

-- ---------------------------------------------------------------- Фрагмент доказательства (матрица A)

ALTER TABLE evidence_fragment
  ADD COLUMN mail_message_revision_id uuid REFERENCES mail_message_revision (id),
  ADD COLUMN transcript_revision_id   uuid,
  ADD COLUMN transcript_segment_id    uuid;
ALTER TABLE evidence_fragment
  DROP CONSTRAINT evidence_fragment_owner_shape,
  DROP CONSTRAINT evidence_fragment_unit_shape,
  DROP CONSTRAINT evidence_fragment_unit_id_shape,
  DROP CONSTRAINT evidence_fragment_source_unit_type_check;
-- Значение communication заменено ревизией письма: строк с ним нет (этапы 04–06a его не писали).
ALTER TABLE evidence_fragment
  ADD CONSTRAINT evidence_fragment_source_unit_type_check
    CHECK (source_unit_type IN ('recognition_run', 'mail_message_revision', 'transcript_revision')),
  -- Ровно один источник по виду: колонка источника равна source_unit_id, остальные пусты; владелец
  -- тендер или договор — только у ветки прогона (у прогона вложения — никакого, охранник ниже).
  ADD CONSTRAINT evidence_fragment_source_shape CHECK (
    CASE source_unit_type
      WHEN 'recognition_run' THEN
        run_id IS NOT NULL AND source_unit_id = run_id AND document_revision_id IS NOT NULL
        AND num_nonnulls(tender_id, contract_id) <= 1
        AND num_nonnulls(mail_message_revision_id, transcript_revision_id, transcript_segment_id) = 0
        AND origin IN ('document_text', 'recognized_text', 'model_description')
      WHEN 'mail_message_revision' THEN
        mail_message_revision_id IS NOT NULL AND source_unit_id = mail_message_revision_id
        AND num_nonnulls(run_id, document_revision_id, tender_id, contract_id, transcript_revision_id, transcript_segment_id) = 0
        AND origin = 'email_body'
      WHEN 'transcript_revision' THEN
        transcript_revision_id IS NOT NULL AND source_unit_id = transcript_revision_id AND transcript_segment_id IS NOT NULL
        AND num_nonnulls(run_id, document_revision_id, tender_id, contract_id, mail_message_revision_id) = 0
        AND origin IN ('negotiation_speech', 'negotiation_hint')
    END),
  ADD CONSTRAINT evidence_fragment_transcript_fk FOREIGN KEY (transcript_revision_id) REFERENCES transcript_revision (id),
  ADD CONSTRAINT evidence_fragment_segment_fk
    FOREIGN KEY (transcript_segment_id, transcript_revision_id) REFERENCES transcript_segment (id, revision_id),
  -- Цели FK индекса без владельца; ключ фрагмента уникален в своей единице для любого вида.
  ADD CONSTRAINT evidence_fragment_unit_key UNIQUE (id, source_unit_id),
  ADD CONSTRAINT evidence_fragment_unit_fragment_key UNIQUE (source_unit_id, fragment_key);

-- Происхождение и неизменность фрагментов по виду источника:
-- * ветка прогона: без владельца ⇔ прогон документа вложения (тендер и договор сверяют FK 0012);
-- * письмо и транскрипция: фрагменты пишет только транзакция создания ревизии, как вложения и сегменты;
--   речь и подсказка соответствуют виду сегмента (I06, A03).
CREATE FUNCTION evidence_fragment_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
BEGIN
  IF NEW.source_unit_type = 'recognition_run' THEN
    IF NEW.tender_id IS NULL AND NEW.contract_id IS NULL AND NOT EXISTS (
         SELECT 1 FROM recognition_run r
          WHERE r.id = NEW.run_id AND r.document_revision_id = NEW.document_revision_id
            AND r.tender_id IS NULL AND r.contract_id IS NULL) THEN
      RAISE EXCEPTION 'evidence_fragment: без владельца бывает только фрагмент прогона документа вложения своей редакции (D-025)'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source_unit_type = 'mail_message_revision' THEN
    IF NOT EXISTS (SELECT 1 FROM mail_message_revision r
                    WHERE r.id = NEW.mail_message_revision_id AND r.created_xact = pg_current_xact_id() AND r.created_at = now()) THEN
      RAISE EXCEPTION 'evidence_fragment: фрагменты письма пишет только транзакция создания ревизии (I15)' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM transcript_revision r
                    WHERE r.id = NEW.transcript_revision_id AND r.created_xact = pg_current_xact_id() AND r.created_at = now()) THEN
      RAISE EXCEPTION 'evidence_fragment: фрагменты транскрипции пишет только транзакция создания редакции (I15)' USING ERRCODE = '55000';
    END IF;
    SELECT segment_kind INTO v_kind FROM transcript_segment WHERE id = NEW.transcript_segment_id;
    IF NOT ((v_kind = 'speech' AND NEW.origin = 'negotiation_speech') OR (v_kind = 'hint' AND NEW.origin = 'negotiation_hint')) THEN
      RAISE EXCEPTION 'evidence_fragment: подсказка участнику не становится речью и наоборот (I06, A03)' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_fragment_source_guard BEFORE INSERT ON evidence_fragment
  FOR EACH ROW EXECUTE FUNCTION evidence_fragment_source_guard();

-- Якоря письма и транскрипции (по образцу AD-05a-1): часть тела письма с признаком цитаты и сегмент
-- транскрипции с таймкодом. Прежние виды не меняются.
CREATE OR REPLACE FUNCTION evidence_locator_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(p) IS DISTINCT FROM 'object' THEN false
    WHEN p ->> 'kind' = 'pdf_text' THEN
      (p - ARRAY['kind', 'page', 'method', 'block']) = '{}'::jsonb
      AND jsonb_positive_int(p, 'page') AND jsonb_positive_int(p, 'block')
      AND coalesce(p ->> 'method' IN ('native_text', 'ocr'), false)
    WHEN p ->> 'kind' = 'xlsx_cells' THEN
      CASE WHEN (p - ARRAY['kind', 'sheet', 'sheetIndex', 'range', 'rowFrom', 'rowTo', 'colFrom', 'colTo', 'merged']) = '{}'::jsonb
                AND jsonb_typeof(p -> 'sheet') = 'string' AND length(p ->> 'sheet') BETWEEN 1 AND 31
                AND jsonb_positive_int(p, 'sheetIndex')
                AND coalesce((p ->> 'range') ~ '^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$', false)
                AND jsonb_positive_int(p, 'rowFrom') AND jsonb_positive_int(p, 'rowTo')
                AND jsonb_positive_int(p, 'colFrom') AND jsonb_positive_int(p, 'colTo')
                AND (NOT p ? 'merged' OR jsonb_typeof(p -> 'merged') = 'array')
           THEN (p ->> 'rowFrom')::int <= (p ->> 'rowTo')::int AND (p ->> 'colFrom')::int <= (p ->> 'colTo')::int
           ELSE false END
    WHEN p ->> 'kind' = 'csv_rows' THEN
      CASE WHEN (p - ARRAY['kind', 'rowFrom', 'rowTo', 'colFrom', 'colTo', 'headerRow', 'lineFrom', 'lineTo']) = '{}'::jsonb
                AND jsonb_positive_int(p, 'rowFrom') AND jsonb_positive_int(p, 'rowTo')
                AND jsonb_positive_int(p, 'colFrom') AND jsonb_positive_int(p, 'colTo')
                AND jsonb_positive_int(p, 'lineFrom') AND jsonb_positive_int(p, 'lineTo')
                AND (jsonb_typeof(p -> 'headerRow') = 'null' OR jsonb_positive_int(p, 'headerRow'))
           THEN (p ->> 'rowFrom')::int <= (p ->> 'rowTo')::int AND (p ->> 'colFrom')::int <= (p ->> 'colTo')::int
                AND (p ->> 'lineFrom')::int <= (p ->> 'lineTo')::int
           ELSE false END
    WHEN p ->> 'kind' = 'docx_paragraph' THEN
      (p - ARRAY['kind', 'part', 'block', 'section']) = '{}'::jsonb
      AND coalesce(p ->> 'part' IN ('body', 'footnotes', 'endnotes'), false)
      AND jsonb_positive_int(p, 'block') AND jsonb_positive_int(p, 'section')
    WHEN p ->> 'kind' = 'docx_table_row' THEN
      CASE WHEN (p - ARRAY['kind', 'part', 'block', 'section', 'table', 'row', 'cellFrom', 'cellTo']) = '{}'::jsonb
                AND coalesce(p ->> 'part' IN ('body', 'footnotes', 'endnotes'), false)
                AND jsonb_positive_int(p, 'block') AND jsonb_positive_int(p, 'section') AND jsonb_positive_int(p, 'table')
                AND jsonb_positive_int(p, 'row') AND jsonb_positive_int(p, 'cellFrom') AND jsonb_positive_int(p, 'cellTo')
           THEN (p ->> 'cellFrom')::int <= (p ->> 'cellTo')::int
           ELSE false END
    WHEN p ->> 'kind' = 'mail_body' THEN
      (p - ARRAY['kind', 'block', 'quoted']) = '{}'::jsonb
      AND jsonb_positive_int(p, 'block') AND jsonb_typeof(p -> 'quoted') = 'boolean'
    WHEN p ->> 'kind' = 'transcript_segment' THEN
      CASE WHEN (p - ARRAY['kind', 'segment', 'startMs', 'endMs']) = '{}'::jsonb
                AND jsonb_positive_int(p, 'segment')
                AND jsonb_typeof(p -> 'startMs') = 'number' AND jsonb_typeof(p -> 'endMs') = 'number'
           THEN (p ->> 'startMs')::numeric >= 0 AND (p ->> 'endMs')::numeric >= (p ->> 'startMs')::numeric
           ELSE false END
    ELSE false
  END
$$;

-- Прежний охранник 0014 для прогонов; фрагменты письма и транскрипции обязаны иметь якорь своего
-- вида и не имеют страницы и координат.
CREATE OR REPLACE FUNCTION evidence_fragment_local_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_engine text;
  v_kind   text;
BEGIN
  IF NEW.run_id IS NULL THEN
    IF NEW.locator IS NULL OR NOT evidence_locator_valid(NEW.locator)
       OR NEW.locator ->> 'kind' IS DISTINCT FROM (CASE NEW.source_unit_type WHEN 'mail_message_revision' THEN 'mail_body'
                                                                             WHEN 'transcript_revision' THEN 'transcript_segment' END) THEN
      RAISE EXCEPTION 'evidence_fragment: у фрагмента письма и транскрипции обязателен якорь своего вида' USING ERRCODE = '23514';
    END IF;
    IF NEW.page_index IS NOT NULL OR NEW.bbox_norm IS NOT NULL OR NEW.polygon_norm IS NOT NULL OR NEW.bbox_space IS NOT NULL
       OR NEW.shape_type IS NOT NULL OR NEW.rotation IS NOT NULL OR NEW.external_crop_url IS NOT NULL OR NEW.derived_model_ref IS NOT NULL THEN
      RAISE EXCEPTION 'evidence_fragment: у фрагмента письма и транскрипции нет страницы и координат' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT engine INTO v_engine FROM recognition_run WHERE id = NEW.run_id;
  IF v_engine IS DISTINCT FROM 'local_ocr' THEN
    IF NEW.locator IS NOT NULL THEN
      RAISE EXCEPTION 'evidence_fragment: структурный якорь есть только у локального прогона' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.locator IS NULL OR NEW.page_index IS NULL OR NOT evidence_locator_valid(NEW.locator) THEN
    RAISE EXCEPTION 'evidence_fragment: у локального фрагмента обязательны единица и корректный якорь (AD-05a-1)' USING ERRCODE = '23514';
  END IF;
  IF NEW.bbox_norm IS NOT NULL OR NEW.polygon_norm IS NOT NULL OR NEW.bbox_space IS NOT NULL OR NEW.shape_type IS NOT NULL
     OR NEW.rotation IS NOT NULL OR NEW.external_crop_url IS NOT NULL OR NEW.derived_model_ref IS NOT NULL THEN
    RAISE EXCEPTION 'evidence_fragment: у локального фрагмента нет координат (D-014)' USING ERRCODE = '23514';
  END IF;
  SELECT unit_kind INTO v_kind FROM recognition_page WHERE run_id = NEW.run_id AND page_index = NEW.page_index;
  IF v_kind IS NULL OR NOT (
       (v_kind = 'pdf_page' AND NEW.locator ->> 'kind' = 'pdf_text' AND (NEW.locator ->> 'page')::int = NEW.page_index + 1)
    OR (v_kind = 'xlsx_sheet' AND NEW.locator ->> 'kind' = 'xlsx_cells' AND (NEW.locator ->> 'sheetIndex')::int = NEW.page_index + 1)
    OR (v_kind = 'csv_table' AND NEW.locator ->> 'kind' = 'csv_rows')
    OR (v_kind = 'docx_body' AND NEW.locator ->> 'kind' IN ('docx_paragraph', 'docx_table_row'))) THEN
    RAISE EXCEPTION 'evidence_fragment: якорь фрагмента не соответствует единице источника (AD-05a-1)' USING ERRCODE = '23514';
  END IF;
  IF NOT ((NEW.origin = 'recognized_text' AND coalesce(NEW.locator ->> 'method', '') = 'ocr')
       OR (NEW.origin = 'document_text' AND coalesce(NEW.locator ->> 'method', '') <> 'ocr')) THEN
    RAISE EXCEPTION 'evidence_fragment: происхождение % не соответствует способу обработки (I06)', NEW.origin USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Индекс поиска (матрица A)

-- Производное состояние индексации: идентификатор единицы любого вида (у прогона — прежнее значение).
ALTER TABLE fragment_index_state RENAME COLUMN run_id TO source_unit_id;

-- Владелец строки индекса-прогона равен владельцу прогона: для тендера и договора это сверяют составные
-- FK 0012, для прогона вложения (без владельца) — эта функция.
CREATE FUNCTION recognition_run_owner_matches(p_run uuid, p_tender uuid, p_contract uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM recognition_run r
                  WHERE r.id = p_run AND r.tender_id IS NOT DISTINCT FROM p_tender AND r.contract_id IS NOT DISTINCT FROM p_contract)
$$;

ALTER TABLE search_index_unit
  ADD COLUMN mail_message_revision_id uuid REFERENCES mail_message_revision (id),
  ADD COLUMN transcript_revision_id   uuid REFERENCES transcript_revision (id);
ALTER TABLE search_index_unit DROP CONSTRAINT search_index_unit_owner_shape, DROP CONSTRAINT search_index_unit_source_unit_type_check;
ALTER TABLE search_index_unit
  ADD CONSTRAINT search_index_unit_source_unit_type_check
    CHECK (source_unit_type IN ('recognition_run', 'mail_message_revision', 'transcript_revision')),
  ADD CONSTRAINT search_index_unit_source_shape CHECK (
    CASE source_unit_type
      WHEN 'recognition_run' THEN num_nonnulls(tender_id, contract_id) <= 1 AND num_nonnulls(mail_message_revision_id, transcript_revision_id) = 0
      WHEN 'mail_message_revision' THEN mail_message_revision_id = source_unit_id
        AND num_nonnulls(tender_id, contract_id, transcript_revision_id) = 0
      WHEN 'transcript_revision' THEN transcript_revision_id = source_unit_id
        AND num_nonnulls(tender_id, contract_id, mail_message_revision_id) = 0
    END);

ALTER TABLE search_chunk
  ADD COLUMN mail_message_revision_id uuid REFERENCES mail_message_revision (id),
  ADD COLUMN transcript_revision_id   uuid REFERENCES transcript_revision (id);
ALTER TABLE search_chunk ALTER COLUMN document_revision_id DROP NOT NULL;
ALTER TABLE search_chunk DROP CONSTRAINT search_chunk_owner_shape, DROP CONSTRAINT search_chunk_source_unit_type_check;
ALTER TABLE search_chunk
  ADD CONSTRAINT search_chunk_source_unit_type_check
    CHECK (source_unit_type IN ('recognition_run', 'mail_message_revision', 'transcript_revision')),
  ADD CONSTRAINT search_chunk_source_shape CHECK (
    CASE source_unit_type
      WHEN 'recognition_run' THEN document_revision_id IS NOT NULL AND num_nonnulls(tender_id, contract_id) <= 1
        AND num_nonnulls(mail_message_revision_id, transcript_revision_id) = 0
      WHEN 'mail_message_revision' THEN mail_message_revision_id = source_unit_id
        AND num_nonnulls(document_revision_id, tender_id, contract_id, transcript_revision_id) = 0
      WHEN 'transcript_revision' THEN transcript_revision_id = source_unit_id
        AND num_nonnulls(document_revision_id, tender_id, contract_id, mail_message_revision_id) = 0
    END),
  ADD CONSTRAINT search_chunk_unit_key UNIQUE (id, index_version_id, source_unit_id);

-- Единица и чанк прогона без владельца — только у прогона вложения (у него владельца нет); редакция
-- такого чанка — редакция прогона. Строки с тендером или договором по-прежнему сверяют составные FK 0012.
CREATE FUNCTION search_index_unit_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_unit_type = 'recognition_run' AND NEW.tender_id IS NULL AND NEW.contract_id IS NULL
     AND NOT recognition_run_owner_matches(NEW.source_unit_id, NULL, NULL) THEN
    RAISE EXCEPTION 'search_index_unit: без владельца бывает только единица прогона документа вложения (D-025)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER search_index_unit_owner_guard BEFORE INSERT ON search_index_unit
  FOR EACH ROW EXECUTE FUNCTION search_index_unit_owner_guard();

CREATE FUNCTION search_chunk_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_unit_type = 'recognition_run' AND NEW.tender_id IS NULL AND NEW.contract_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM recognition_run r
        WHERE r.id = NEW.source_unit_id AND r.document_revision_id = NEW.document_revision_id
          AND r.tender_id IS NULL AND r.contract_id IS NULL) THEN
    RAISE EXCEPTION 'search_chunk: без владельца бывает только чанк прогона документа вложения своей редакции (D-025)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER search_chunk_owner_guard BEFORE INSERT ON search_chunk
  FOR EACH ROW EXECUTE FUNCTION search_chunk_owner_guard();

-- Связь чанка с фрагментом и вектор: FK без владельца — фрагмент той же единицы, что и чанк, в любой
-- ветке; владелец строки равен владельцу чанка (у почтовой ветки — никакого).
ALTER TABLE search_chunk_fragment DROP CONSTRAINT search_chunk_fragment_owner_shape;
ALTER TABLE search_chunk_fragment
  ADD CONSTRAINT search_chunk_fragment_owner_shape CHECK (num_nonnulls(tender_id, contract_id) <= 1),
  ADD CONSTRAINT search_chunk_fragment_chunk_unit_fk FOREIGN KEY (chunk_id, index_version_id, source_unit_id)
    REFERENCES search_chunk (id, index_version_id, source_unit_id) ON DELETE CASCADE,
  ADD CONSTRAINT search_chunk_fragment_fragment_unit_fk FOREIGN KEY (fragment_id, source_unit_id)
    REFERENCES evidence_fragment (id, source_unit_id);

ALTER TABLE search_chunk_vector DROP CONSTRAINT search_chunk_vector_owner_shape;
ALTER TABLE search_chunk_vector
  ADD CONSTRAINT search_chunk_vector_owner_shape CHECK (num_nonnulls(tender_id, contract_id) <= 1),
  ADD CONSTRAINT search_chunk_vector_chunk_unit_fk FOREIGN KEY (chunk_id, index_version_id, source_unit_id)
    REFERENCES search_chunk (id, index_version_id, source_unit_id) ON DELETE CASCADE;

-- Строка без владельца — только у чанка без владельца; с тендером или договором сверяют FK 0012.
CREATE FUNCTION search_chunk_child_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tender_id IS NULL AND NEW.contract_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM search_chunk c WHERE c.id = NEW.chunk_id AND c.tender_id IS NULL AND c.contract_id IS NULL) THEN
    RAISE EXCEPTION '%: владелец строки не совпадает с владельцем чанка (D-025)', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER search_chunk_fragment_owner_guard BEFORE INSERT ON search_chunk_fragment
  FOR EACH ROW EXECUTE FUNCTION search_chunk_child_owner_guard();
CREATE TRIGGER search_chunk_vector_owner_guard BEFORE INSERT ON search_chunk_vector
  FOR EACH ROW EXECUTE FUNCTION search_chunk_child_owner_guard();

-- ---------------------------------------------------------------- Снимок области (матрица A и B)

ALTER TABLE evidence_scope_item
  ADD COLUMN mail_message_revision_id uuid,
  ADD COLUMN mail_message_id          uuid,
  ADD COLUMN transcript_revision_id   uuid;
ALTER TABLE evidence_scope_item ALTER COLUMN document_revision_id DROP NOT NULL;
ALTER TABLE evidence_scope_item DROP CONSTRAINT evidence_scope_item_unit_type_check;
-- Тендер у единицы — только у единицы документа тендера: у договора — contract_id, у вложения и
-- письма — связь письма с тендером снимка, у транскрипции — собственный FK по тендеру.
ALTER TABLE evidence_scope_item ALTER COLUMN unit_tender_id SET EXPRESSION AS (
  CASE WHEN unit_type = 'document_recognition' AND contract_id IS NULL AND mail_message_id IS NULL THEN tender_id END);
ALTER TABLE evidence_scope_item
  ADD CONSTRAINT evidence_scope_item_unit_type_check
    CHECK (unit_type IN ('document_recognition', 'mail_message', 'transcript_revision')),
  ADD CONSTRAINT evidence_scope_item_unit_shape CHECK (
    CASE unit_type
      WHEN 'document_recognition' THEN document_revision_id IS NOT NULL
        AND num_nonnulls(contract_id, mail_message_id) <= 1
        AND num_nonnulls(mail_message_revision_id, transcript_revision_id) = 0
      WHEN 'mail_message' THEN mail_message_revision_id IS NOT NULL AND mail_message_id IS NOT NULL
        AND num_nonnulls(document_revision_id, recognition_run_id, contract_id, transcript_revision_id) = 0
      WHEN 'transcript_revision' THEN transcript_revision_id IS NOT NULL
        AND num_nonnulls(document_revision_id, recognition_run_id, contract_id, mail_message_revision_id, mail_message_id) = 0
    END),
  -- Существование редакции и прогона в любой ветке (FK по тендеру и договору — прежние).
  ADD CONSTRAINT evidence_scope_item_revision_any_fk FOREIGN KEY (document_revision_id) REFERENCES document_revision (id),
  ADD CONSTRAINT evidence_scope_item_run_any_fk FOREIGN KEY (recognition_run_id) REFERENCES recognition_run (id),
  ADD CONSTRAINT evidence_scope_item_mail_revision_fk
    FOREIGN KEY (mail_message_revision_id, mail_message_id) REFERENCES mail_message_revision (id, message_id),
  ADD CONSTRAINT evidence_scope_item_mail_link_fk FOREIGN KEY (mail_message_id, tender_id) REFERENCES mail_message_tender (message_id, tender_id),
  ADD CONSTRAINT evidence_scope_item_transcript_fk FOREIGN KEY (transcript_revision_id, tender_id) REFERENCES transcript_revision (id, tender_id),
  ADD CONSTRAINT evidence_scope_item_mail_revision_key UNIQUE (scope_id, mail_message_revision_id),
  ADD CONSTRAINT evidence_scope_item_transcript_key UNIQUE (scope_id, transcript_revision_id);
-- Одно письмо — одна ревизия в снимке.
CREATE UNIQUE INDEX evidence_scope_item_mail_message_key ON evidence_scope_item (scope_id, mail_message_id) WHERE unit_type = 'mail_message';

-- Письмо вложения (для единицы документа вложения).
CREATE FUNCTION document_revision_mail_message(p_revision uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT mr.message_id FROM document_revision r
    JOIN document d ON d.id = r.document_id
    JOIN mail_attachment a ON a.id = d.mail_attachment_id
    JOIN mail_message_revision mr ON mr.id = a.revision_id
   WHERE r.id = p_revision
$$;

-- Последняя ревизия письма и последняя редакция сессии — выбор снимка и текущей области.
CREATE FUNCTION mail_message_latest_revision(p_message uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM mail_message_revision WHERE message_id = p_message ORDER BY seq DESC LIMIT 1
$$;
CREATE FUNCTION transcript_latest_revision(p_session uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM transcript_revision WHERE session_id = p_session ORDER BY seq DESC LIMIT 1
$$;

-- Действующая связь письма с тендером; этап связи, если задан, должен совпасть с этапом снимка.
CREATE FUNCTION mail_message_linked(p_message uuid, p_tender uuid, p_stage uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM mail_message_tender l
                  WHERE l.message_id = p_message AND l.tender_id = p_tender AND l.status = 'linked'
                    AND (l.stage_id IS NULL OR p_stage IS NULL OR l.stage_id = p_stage))
$$;

CREATE OR REPLACE FUNCTION evidence_scope_item_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
BEGIN
  SELECT stage_id INTO v_stage FROM evidence_scope WHERE id = NEW.scope_id;
  IF NEW.unit_type = 'mail_message' THEN
    -- Письмо входит в снимок при действующей связи с тендером (и этапом) снимка — последней ревизией.
    IF NOT mail_message_linked(NEW.mail_message_id, NEW.tender_id, v_stage) THEN
      RAISE EXCEPTION 'evidence_scope_item: письмо не связано с тендером снимка действующей связью (OD-07-7)' USING ERRCODE = '23514';
    END IF;
    IF NEW.mail_message_revision_id IS DISTINCT FROM mail_message_latest_revision(NEW.mail_message_id) THEN
      RAISE EXCEPTION 'evidence_scope_item: в снимок входит последняя ревизия письма на момент создания' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.unit_type = 'transcript_revision' THEN
    IF NEW.transcript_revision_id IS DISTINCT FROM (
         SELECT transcript_latest_revision(r.session_id) FROM transcript_revision r WHERE r.id = NEW.transcript_revision_id) THEN
      RAISE EXCEPTION 'evidence_scope_item: в снимок входит последняя редакция транскрипции сессии' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.recognition_run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM recognition_run r WHERE r.id = NEW.recognition_run_id AND r.status IN ('complete', 'partial')) THEN
    RAISE EXCEPTION 'evidence_scope_item: в снимок входит только завершённый прогон распознавания' USING ERRCODE = '23514';
  END IF;
  IF NEW.recognition_run_id IS DISTINCT FROM recognition_preferred_run(NEW.document_revision_id) THEN
    RAISE EXCEPTION 'evidence_scope_item: в снимок входит предпочтительный прогон редакции (AD-05a-3)' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM evidence_scope s
         JOIN source_set_item i ON i.source_set_revision_id = s.source_set_revision_id
        WHERE s.id = NEW.scope_id AND i.document_revision_id = NEW.document_revision_id
          AND i.inclusion <> 'excluded_not_applicable') THEN
    RAISE EXCEPTION 'evidence_scope_item: редакция не включена в основу снимка' USING ERRCODE = '23514';
  END IF;
  IF NEW.contract_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM contract_tender l
        WHERE l.contract_id = NEW.contract_id AND l.tender_id = NEW.tender_id AND l.status = 'active') THEN
    RAISE EXCEPTION 'evidence_scope_item: договор не связан с тендером снимка действующей связью' USING ERRCODE = '23514';
  END IF;
  -- Документ вложения: письмо единицы — письмо вложения, связь с тендером снимка действует.
  IF document_revision_mail_owned(NEW.document_revision_id) THEN
    IF NEW.mail_message_id IS DISTINCT FROM document_revision_mail_message(NEW.document_revision_id) THEN
      RAISE EXCEPTION 'evidence_scope_item: письмо единицы не совпадает с письмом вложения' USING ERRCODE = '23514';
    END IF;
    IF NOT mail_message_linked(NEW.mail_message_id, NEW.tender_id, v_stage) THEN
      RAISE EXCEPTION 'evidence_scope_item: письмо вложения не связано с тендером снимка действующей связью' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.mail_message_id IS NOT NULL THEN
    RAISE EXCEPTION 'evidence_scope_item: ссылка на письмо есть только у единицы вложения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Хэш состава: формула data-model §5 заполняет слоты 4 и 5 — ID ревизии письма и ID редакции
-- транскрипции; строки документов дают прежний текст, поэтому хэш существующих снимков не меняется.
CREATE OR REPLACE FUNCTION evidence_scope_composition_hash(p_scope uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
           'kontur.evidence_scope.v1' || E'\n' || r.content_hash || E'\n[' ||
           coalesce((SELECT string_agg(u.row_json, ',' ORDER BY u.sort_key COLLATE "C")
                       FROM (SELECT '["' || i.unit_type || '","' || coalesce(i.document_revision_id::text, '') || '","'
                                    || coalesce(i.recognition_run_id::text, '') || '","'
                                    || coalesce(i.mail_message_revision_id::text, '') || '","'
                                    || coalesce(i.transcript_revision_id::text, '') || '"]' AS row_json,
                                    i.unit_type || '|' || coalesce(i.document_revision_id::text, '') || '|'
                                    || coalesce(i.recognition_run_id::text, '') || '|'
                                    || coalesce(i.mail_message_revision_id::text, '') || '|'
                                    || coalesce(i.transcript_revision_id::text, '') AS sort_key
                               FROM evidence_scope_item i
                              WHERE i.scope_id = s.id) u), '') || ']',
           'UTF8')), 'hex')
    FROM evidence_scope s
    JOIN source_set_revision r ON r.id = s.source_set_revision_id
   WHERE s.id = p_scope
$$;

-- Полнота (state-machines §5.1): каждая включённая редакция основы; каждое письмо с действующей связью
-- с тендером (и этапом) снимка; каждая сессия переговоров тендера — последней редакцией.
CREATE OR REPLACE FUNCTION evidence_scope_verify(p_scope uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_base   uuid;
  v_hash   text;
  v_tender uuid;
  v_stage  uuid;
BEGIN
  SELECT source_set_revision_id, content_hash, tender_id, stage_id INTO v_base, v_hash, v_tender, v_stage
    FROM evidence_scope WHERE id = p_scope;
  IF EXISTS (
       SELECT 1 FROM source_set_item i
        WHERE i.source_set_revision_id = v_base AND i.inclusion <> 'excluded_not_applicable'
          AND NOT EXISTS (SELECT 1 FROM evidence_scope_item e WHERE e.scope_id = p_scope AND e.document_revision_id = i.document_revision_id)) THEN
    RAISE EXCEPTION 'evidence_scope %: состав неполон — включённая редакция основы не вошла в снимок', p_scope
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
       SELECT 1 FROM mail_message_tender l
        WHERE l.tender_id = v_tender AND l.status = 'linked' AND (l.stage_id IS NULL OR l.stage_id = v_stage)
          AND NOT EXISTS (SELECT 1 FROM evidence_scope_item e
                           WHERE e.scope_id = p_scope AND e.unit_type = 'mail_message' AND e.mail_message_id = l.message_id)) THEN
    RAISE EXCEPTION 'evidence_scope %: состав неполон — связанное письмо не вошло в снимок', p_scope USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
       SELECT 1 FROM negotiation_session s
        WHERE s.tender_id = v_tender AND transcript_latest_revision(s.id) IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM evidence_scope_item e
                           WHERE e.scope_id = p_scope AND e.transcript_revision_id = transcript_latest_revision(s.id))) THEN
    RAISE EXCEPTION 'evidence_scope %: состав неполон — редакция транскрипции не вошла в снимок', p_scope USING ERRCODE = '23514';
  END IF;
  IF evidence_scope_composition_hash(p_scope) IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'evidence_scope %: content_hash не соответствует составу единиц', p_scope USING ERRCODE = '23514';
  END IF;
END;
$$;

-- ---------------------------------------------------------------- Прогон поиска и его результаты

-- Единица области тендера: прогон тендера; прогон договора со связью; прогон документа вложения
-- и ревизия письма, у которого есть пара с тендером; редакция транскрипции тендера. В режиме
-- working — только текущий выбор: предпочтительный прогон, последняя ревизия письма при действующей
-- связи, последняя редакция транскрипции. Права пользователя проверяет приложение (D-025).
CREATE OR REPLACE FUNCTION search_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'search_run: прогон создаётся в состоянии pending (state-machines §21)' USING ERRCODE = '55000';
  END IF;
  IF NEW.context_kind = 'tender' AND EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_source_unit_ids) AS u(id)
        WHERE NOT EXISTS (
                SELECT 1 FROM recognition_run r
                 WHERE r.id = u.id
                   AND (r.tender_id = NEW.tender_id
                        OR (r.contract_id IS NOT NULL AND EXISTS (
                              SELECT 1 FROM contract_tender l WHERE l.contract_id = r.contract_id AND l.tender_id = NEW.tender_id))
                        OR (r.tender_id IS NULL AND r.contract_id IS NULL AND EXISTS (
                              SELECT 1 FROM mail_message_tender l
                               WHERE l.message_id = document_revision_mail_message(r.document_revision_id) AND l.tender_id = NEW.tender_id))))
          AND NOT EXISTS (
                SELECT 1 FROM mail_message_revision mr JOIN mail_message_tender l ON l.message_id = mr.message_id
                 WHERE mr.id = u.id AND l.tender_id = NEW.tender_id)
          AND NOT EXISTS (SELECT 1 FROM transcript_revision t WHERE t.id = u.id AND t.tender_id = NEW.tender_id)) THEN
    RAISE EXCEPTION 'search_run: единица области не принадлежит тендеру прогона' USING ERRCODE = '23514';
  END IF;
  IF NEW.context_kind = 'contract' AND EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_source_unit_ids) AS u(id)
        WHERE NOT EXISTS (SELECT 1 FROM recognition_run r WHERE r.id = u.id AND r.contract_id = NEW.contract_id)) THEN
    RAISE EXCEPTION 'search_run: единица области не принадлежит договору прогона' USING ERRCODE = '23514';
  END IF;
  IF NEW.mode = 'working' AND EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_source_unit_ids) AS u(id)
         JOIN recognition_run r ON r.id = u.id
        WHERE recognition_preferred_run(r.document_revision_id) IS DISTINCT FROM r.id
           OR (r.tender_id IS NULL AND r.contract_id IS NULL
               AND NOT mail_message_linked(document_revision_mail_message(r.document_revision_id), NEW.tender_id, NEW.stage_id))) THEN
    RAISE EXCEPTION 'search_run: единица текущей области — не предпочтительный прогон своей редакции или вложение без действующей связи'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.mode = 'working' AND EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_source_unit_ids) AS u(id)
         JOIN mail_message_revision mr ON mr.id = u.id
        WHERE mail_message_latest_revision(mr.message_id) IS DISTINCT FROM mr.id
           OR NOT mail_message_linked(mr.message_id, NEW.tender_id, NEW.stage_id)) THEN
    RAISE EXCEPTION 'search_run: письмо текущей области — последняя ревизия при действующей связи' USING ERRCODE = '23514';
  END IF;
  IF NEW.mode = 'working' AND EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_source_unit_ids) AS u(id)
         JOIN transcript_revision t ON t.id = u.id
        WHERE transcript_latest_revision(t.session_id) IS DISTINCT FROM t.id) THEN
    RAISE EXCEPTION 'search_run: транскрипция текущей области — последняя редакция сессии' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM search_index_version v WHERE v.id = NEW.index_version_id AND v.purged_at IS NULL) THEN
    RAISE EXCEPTION 'search_run: версия индекса удалена' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION search_run_result_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run record;
BEGIN
  SELECT status, context_kind, tender_id, contract_id, allowed_source_unit_ids INTO run FROM search_run WHERE id = NEW.run_id FOR SHARE;
  IF run.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'search_run_result: результаты принимает только нетерминальный прогон' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM evidence_fragment f
        WHERE f.id = NEW.fragment_id
          AND CASE run.context_kind
                WHEN 'tender' THEN f.tender_id = run.tender_id
                  OR (f.contract_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM contract_tender l WHERE l.contract_id = f.contract_id AND l.tender_id = run.tender_id))
                  OR (f.source_unit_type = 'recognition_run' AND f.tender_id IS NULL AND f.contract_id IS NULL AND EXISTS (
                        SELECT 1 FROM mail_message_tender l
                         WHERE l.message_id = document_revision_mail_message(f.document_revision_id) AND l.tender_id = run.tender_id))
                  OR (f.source_unit_type = 'mail_message_revision' AND EXISTS (
                        SELECT 1 FROM mail_message_revision mr JOIN mail_message_tender l ON l.message_id = mr.message_id
                         WHERE mr.id = f.mail_message_revision_id AND l.tender_id = run.tender_id))
                  OR (f.source_unit_type = 'transcript_revision' AND EXISTS (
                        SELECT 1 FROM transcript_revision t WHERE t.id = f.transcript_revision_id AND t.tender_id = run.tender_id))
                WHEN 'contract' THEN f.contract_id = run.contract_id
              END
          AND f.source_unit_id = ANY (run.allowed_source_unit_ids)
          AND f.origin = NEW.origin
          AND f.origin IN ('document_text', 'recognized_text', 'email_body', 'attachment_text', 'negotiation_speech')) THEN
    RAISE EXCEPTION 'search_run_result: фрагмент вне закреплённой области или недоказательного происхождения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
