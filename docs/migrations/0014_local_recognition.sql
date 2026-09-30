-- 0014 — этап 05a: локальное распознавание форматов вне охвата RDWeb (D-014, D-024).
-- Проект и матрица — docs/architecture/05a-local-recognition-design.md. Новых таблиц нет: единица
-- источника расширяет страницу прогона, идентичность локального прогона — колонки прогона, выбор
-- предпочтительного прогона — функция БД и охранники снимка и прогона поиска. Колонки владельца
-- не добавляются: владелец строк локального прогона — владелец редакции (D-023).

-- ---------------------------------------------------------------- OD-1, OD-4: маршрут и формат

-- Явная политика маршрута PDF. auto — автоматического локального распознавания нет; local — разрешено;
-- rdweb — только RDWeb. Для DOCX/XLSX/CSV политика не действует: RDWeb их не обрабатывает.
ALTER TABLE document ADD COLUMN recognition_route text NOT NULL DEFAULT 'auto'
  CHECK (recognition_route IN ('auto', 'local', 'rdweb'));

-- Закрытый перечень форматов локального распознавания (OD-4); прочее — unsupported_format.
CREATE FUNCTION local_input_format(p_media_type text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_media_type
    WHEN 'application/pdf' THEN 'pdf'
    WHEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN 'docx'
    WHEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' THEN 'xlsx'
    WHEN 'text/csv' THEN 'csv'
  END
$$;

-- Маршрут редакции (OD-1): PDF с прогоном RDWeb (идущим или успешным) — rdweb; иначе политика
-- документа. Угадывания по имени, папке или содержимому нет.
CREATE FUNCTION recognition_revision_route(p_revision uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN local_input_format(b.media_type) IS NULL THEN 'unsupported'
           WHEN local_input_format(b.media_type) <> 'pdf' THEN 'local'
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

-- ---------------------------------------------------------------- AD-05a-2: идентичность прогона

-- Описание распознавателя: идентификатор и версия, формат, способ обработки, языки, конфигурация.
-- Языки — только ru и en (OD-5), отсортированы; OCR есть только у PDF.
CREATE FUNCTION local_recognizer_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(p) IS DISTINCT FROM 'object' THEN false
    WHEN (p - ARRAY['recognizerId', 'recognizerVersion', 'inputFormat', 'processing', 'languages', 'config']) <> '{}'::jsonb THEN false
    WHEN jsonb_typeof(p -> 'recognizerId') IS DISTINCT FROM 'string' OR length(p ->> 'recognizerId') NOT BETWEEN 1 AND 60 THEN false
    WHEN jsonb_typeof(p -> 'recognizerVersion') IS DISTINCT FROM 'string' OR length(p ->> 'recognizerVersion') NOT BETWEEN 1 AND 40 THEN false
    WHEN NOT coalesce(p ->> 'inputFormat' IN ('pdf', 'docx', 'xlsx', 'csv'), false) THEN false
    WHEN NOT coalesce(p ->> 'processing' IN ('structured_parser', 'native_text', 'native_text+ocr'), false) THEN false
    WHEN jsonb_typeof(p -> 'config') IS DISTINCT FROM 'object' THEN false
    WHEN jsonb_typeof(p -> 'languages') IS DISTINCT FROM 'array' THEN false
    WHEN ((p ->> 'inputFormat') = 'pdf') <> ((p ->> 'processing') IN ('native_text', 'native_text+ocr')) THEN false
    WHEN ((p ->> 'processing') = 'native_text+ocr') <> (jsonb_array_length(p -> 'languages') > 0) THEN false
    ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'languages') AS l(v)
                      WHERE jsonb_typeof(l.v) <> 'string' OR l.v #>> '{}' NOT IN ('eng', 'rus'))
         -- Языки отсортированы и не повторяются: одинаковая конфигурация даёт одинаковый отпечаток.
         AND (SELECT coalesce(array_agg(l.v ORDER BY l.n) = array_agg(DISTINCT l.v ORDER BY l.v), true)
                FROM jsonb_array_elements_text(p -> 'languages') WITH ORDINALITY AS l(v, n))
  END
$$;

-- Отпечаток и хэш конфигурации считает БД из канонического вида jsonb: клиент их не передаёт,
-- расхождения приложения и БД нет.
CREATE FUNCTION local_recognizer_config_hash(p jsonb) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to((p -> 'config')::text, 'UTF8')), 'hex')
$$;

CREATE FUNCTION local_recognizer_fingerprint(p jsonb) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
           'recognizerId', p -> 'recognizerId', 'recognizerVersion', p -> 'recognizerVersion',
           'inputFormat', p -> 'inputFormat', 'processing', p -> 'processing',
           'languages', p -> 'languages', 'config', p -> 'config')::text, 'UTF8')), 'hex')
$$;

ALTER TABLE recognition_run
  ADD COLUMN recognizer             jsonb,
  ADD COLUMN recognizer_fingerprint text CHECK (recognizer_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN recognizer_config_hash text CHECK (recognizer_config_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE recognition_run ADD CONSTRAINT recognition_run_recognizer_shape CHECK (
  (engine = 'local_ocr') = (recognizer IS NOT NULL)
  AND (recognizer IS NULL) = (recognizer_fingerprint IS NULL)
  AND (recognizer IS NULL) = (recognizer_config_hash IS NULL)
  AND (recognizer IS NULL OR local_recognizer_valid(recognizer)));

-- Одна идентичность — один прогон (OD-2): тот же распознаватель с той же конфигурацией повторно не
-- ставится, новая версия или конфигурация — новый прогон. Для RDWeb ключ прежний: один архив — один прогон.
DROP INDEX recognition_run_artifact_key;
CREATE UNIQUE INDEX recognition_run_artifact_key
  ON recognition_run (document_revision_id, source_artifact_sha256, coalesce(recognizer_fingerprint, ''))
  WHERE status NOT IN ('failed', 'cancelled');

-- Тот же охранник, что в 0008, плюс правила локального прогона (D-014, D-024).
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
  -- Автоматический локальный OCR PDF без явной политики запрещён: при auto нужна явная команда
  -- пользователя, а у автоматической постановки автора нет (OD-1 п. 4–5, OD-2).
  IF v_format = 'pdf' AND v_route = 'auto' AND NEW.created_by IS NULL THEN
    RAISE EXCEPTION 'recognition_run: PDF с политикой auto распознаётся локально только по явной команде (OD-1)'
      USING ERRCODE = '23514';
  END IF;
  -- Источник — неизменяемая редакция, а не путь или имя файла (AD-05a-2).
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

-- Тот же охранник, что в 0007, плюс: владелец договора и описание распознавателя неизменяемы;
-- tender_id сравнивается с учётом NULL (редакции договора, D-023).
CREATE OR REPLACE FUNCTION recognition_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual_pages      int;
  actual_recognized int;
  min_index         int;
  max_index         int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recognition_run: удаление запрещено (I15)' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('complete', 'partial', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'recognition_run (frozen-after): прогон завершён, изменение запрещено' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.document_revision_id <> OLD.document_revision_id
     OR NEW.tender_id IS DISTINCT FROM OLD.tender_id
     OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.engine <> OLD.engine
     OR NEW.source_artifact_sha256 <> OLD.source_artifact_sha256
     OR NEW.source_artifact_name IS DISTINCT FROM OLD.source_artifact_name
     OR NEW.supersedes_run_id IS DISTINCT FROM OLD.supersedes_run_id
     OR NEW.recognizer IS DISTINCT FROM OLD.recognizer
     OR NEW.recognizer_fingerprint IS DISTINCT FROM OLD.recognizer_fingerprint
     OR NEW.recognizer_config_hash IS DISTINCT FROM OLD.recognizer_config_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'recognition_run: поля идентичности и источника неизменяемы' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'queued' AND NEW.status IN ('queued', 'running', 'failed', 'cancelled'))
       OR (OLD.status = 'running' AND NEW.status IN ('running', 'complete', 'partial', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION 'recognition_run: недопустимый переход % → % (state-machines §4)', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IN ('complete', 'partial') THEN
    SELECT count(*), count(*) FILTER (WHERE status = 'recognized'), min(page_index), max(page_index)
      INTO actual_pages, actual_recognized, min_index, max_index
      FROM recognition_page WHERE run_id = NEW.id;
    IF NEW.pages_total IS DISTINCT FROM actual_pages THEN
      RAISE EXCEPTION 'recognition_run: pages_total = % при % фактических страницах прогона (I18)',
        NEW.pages_total, actual_pages USING ERRCODE = '23514';
    END IF;
    IF NEW.pages_recognized <> actual_recognized THEN
      RAISE EXCEPTION 'recognition_run: pages_recognized = % при % распознанных страницах прогона (I18)',
        NEW.pages_recognized, actual_recognized USING ERRCODE = '23514';
    END IF;
    IF min_index IS DISTINCT FROM 0 OR max_index IS DISTINCT FROM NEW.pages_total - 1 THEN
      RAISE EXCEPTION 'recognition_run: номера страниц % не образуют набор 0..% (I18)',
        format('%s..%s', min_index, max_index), NEW.pages_total - 1 USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'recognition_run: row_version увеличивается на 1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- AD-05a-1: единица источника

-- Страница прогона обобщается до единицы источника. Физическая страница PDF сохраняет размеры;
-- у логической единицы (лист XLSX, таблица CSV, тело DOCX) размеров, поворота и номера листа чертежа
-- нет — фиктивных пикселей не бывает. needs_review — единица прочитана, но не прошла шлюз качества (OD-6).
ALTER TABLE recognition_page ADD COLUMN unit_kind text NOT NULL DEFAULT 'pdf_page'
  CHECK (unit_kind IN ('pdf_page', 'xlsx_sheet', 'csv_table', 'docx_body'));
ALTER TABLE recognition_page DROP CONSTRAINT recognition_page_status_check;
ALTER TABLE recognition_page ADD CONSTRAINT recognition_page_status_check
  CHECK (status IN ('recognized', 'missing', 'failed', 'needs_review'));
ALTER TABLE recognition_page DROP CONSTRAINT recognition_page_size_shape;
ALTER TABLE recognition_page ADD CONSTRAINT recognition_page_unit_shape CHECK (
  (unit_kind = 'pdf_page' AND (status <> 'recognized' OR (width_px IS NOT NULL AND height_px IS NOT NULL)))
  OR (unit_kind <> 'pdf_page' AND width_px IS NULL AND height_px IS NULL AND rotation = 0 AND sheet_label IS NULL));

-- Вид единицы соответствует прогону: у RDWeb — только страницы PDF; у локального — единица своего формата.
CREATE FUNCTION recognition_page_unit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_engine text;
  v_format text;
BEGIN
  SELECT r.engine, r.recognizer ->> 'inputFormat' INTO v_engine, v_format FROM recognition_run r WHERE r.id = NEW.run_id;
  IF NEW.unit_kind IS DISTINCT FROM (CASE WHEN v_engine = 'local_ocr' THEN
                                       CASE v_format WHEN 'pdf' THEN 'pdf_page' WHEN 'xlsx' THEN 'xlsx_sheet'
                                                     WHEN 'csv' THEN 'csv_table' WHEN 'docx' THEN 'docx_body' END
                                     ELSE 'pdf_page' END) THEN
    RAISE EXCEPTION 'recognition_page: вид единицы % не соответствует прогону (%, %) (AD-05a-1)', NEW.unit_kind, v_engine, v_format
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'needs_review' AND v_engine IS DISTINCT FROM 'local_ocr' THEN
    RAISE EXCEPTION 'recognition_page: статус needs_review ставит только шлюз качества локального прогона (OD-6)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER recognition_page_unit_guard BEFORE INSERT ON recognition_page
  FOR EACH ROW EXECUTE FUNCTION recognition_page_unit_guard();

-- Целое число не меньше 1 по ключу jsonb.
CREATE FUNCTION jsonb_positive_int(p jsonb, k text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(p -> k) = 'number'
              THEN (p ->> k)::numeric = trunc((p ->> k)::numeric) AND (p ->> k)::numeric BETWEEN 1 AND 2147483647
              ELSE false END
$$;

-- Структурный якорь локального фрагмента (AD-05a-1). Номера — с единицы, как их видит человек.
CREATE FUNCTION evidence_locator_valid(p jsonb) RETURNS boolean
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
    ELSE false
  END
$$;

ALTER TABLE evidence_fragment ADD COLUMN locator jsonb;
ALTER TABLE evidence_fragment ADD CONSTRAINT evidence_fragment_locator_shape
  CHECK (locator IS NULL OR evidence_locator_valid(locator));

-- Локальный фрагмент: единица и якорь обязательны и согласованы, координат нет (D-014), распознанный
-- текст — только у OCR, извлечённый — у остальных способов (I06). У фрагментов RDWeb якоря нет.
CREATE FUNCTION evidence_fragment_local_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_engine text;
  v_kind   text;
BEGIN
  IF NEW.run_id IS NULL THEN
    IF NEW.locator IS NOT NULL THEN
      RAISE EXCEPTION 'evidence_fragment: структурный якорь есть только у фрагмента прогона' USING ERRCODE = '23514';
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
  -- coalesce обязателен: у якоря без способа (XLSX, CSV, DOCX) ->> 'method' даёт NULL, и без него
  -- условие стало бы NULL, а IF NULL отказа не даёт.
  IF NOT ((NEW.origin = 'recognized_text' AND coalesce(NEW.locator ->> 'method', '') = 'ocr')
       OR (NEW.origin = 'document_text' AND coalesce(NEW.locator ->> 'method', '') <> 'ocr')) THEN
    RAISE EXCEPTION 'evidence_fragment: происхождение % не соответствует способу обработки (I06)', NEW.origin USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_fragment_local_guard BEFORE INSERT ON evidence_fragment
  FOR EACH ROW EXECUTE FUNCTION evidence_fragment_local_guard();

-- ---------------------------------------------------------------- AD-05a-3: предпочтительный прогон

-- Детерминированный выбор: среди успешных прогонов редакции класс RDWeb выше локального, внутри класса —
-- глубже по линейной истории supersedes_run_id. Время создания, номер задания и порядок worker в правиле
-- не участвуют. Для истории только из прогонов RDWeb результат равен хвосту цепочки — прежнему выбору.
CREATE FUNCTION recognition_preferred_run(p_revision uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT r.id, r.engine, 1 AS depth
      FROM recognition_run r
     WHERE r.document_revision_id = p_revision AND r.supersedes_run_id IS NULL AND r.status IN ('complete', 'partial')
    UNION ALL
    SELECT c.id, c.engine, chain.depth + 1
      FROM recognition_run c JOIN chain ON c.supersedes_run_id = chain.id
     WHERE c.status IN ('complete', 'partial')
  )
  SELECT id FROM chain
   ORDER BY CASE WHEN engine IN ('rdweb_export', 'rdweb_api') THEN 0 ELSE 1 END, depth DESC
   LIMIT 1
$$;

-- Тот же охранник, что в 0012, плюс вторая линия выбора: в снимок входит предпочтительный прогон
-- редакции, а если успешного прогона нет — «только оригинал» (NULL).
CREATE OR REPLACE FUNCTION evidence_scope_item_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recognition_run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM recognition_run r WHERE r.id = NEW.recognition_run_id AND r.status IN ('complete', 'partial')) THEN
    RAISE EXCEPTION 'evidence_scope_item: в снимок входит только завершённый прогон распознавания' USING ERRCODE = '23514';
  END IF;
  IF NEW.unit_type = 'document_recognition'
     AND NEW.recognition_run_id IS DISTINCT FROM recognition_preferred_run(NEW.document_revision_id) THEN
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
  RETURN NEW;
END;
$$;

-- Тот же охранник, что в 0012, плюс: текущая область (режим working, в том числе контекст договора)
-- состоит из предпочтительных прогонов своих редакций. Режим review берёт единицы снимка, проверенные
-- охранником снимка при его создании.
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
                        SELECT 1 FROM contract_tender l WHERE l.contract_id = r.contract_id AND l.tender_id = NEW.tender_id))))) THEN
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
        WHERE recognition_preferred_run(r.document_revision_id) IS DISTINCT FROM r.id) THEN
    RAISE EXCEPTION 'search_run: единица текущей области — не предпочтительный прогон своей редакции (AD-05a-3)'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM search_index_version v WHERE v.id = NEW.index_version_id AND v.purged_at IS NULL) THEN
    RAISE EXCEPTION 'search_run: версия индекса удалена' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
