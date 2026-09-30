-- 0015 — R05a-01 (Review 05a-1): размеры физической страницы PDF обязательны не только у распознанной.
-- Миграция 0014 (CHECK recognition_page_unit_shape) требовала width_px и height_px у pdf_page лишь при
-- status = 'recognized': прямой вставкой можно было записать страницу PDF в статусе needs_review или
-- failed без размеров, хотя по AD-05a-1 (интерпретация 13, подтверждена Review 05a-1) физическая страница
-- размеры имеет всегда. Размер страницы известен любому конвейеру, который её читал: локальный считает
-- его до проверки текстового слоя и OCR, RDWeb пишет распознанную страницу с размерами (0005).
--
-- Единственное исключение — страница RDWeb в статусе missing. Импорт экспорта (этап 04, R04-03) заводит
-- строку на каждую страницу оригинала, а размеры берёт только из _blocks.json: страницу, которой в экспорте
-- нет, он пишет missing без размеров. Требовать их в CHECK значило бы менять принятый этап 04 и отвергнуть
-- уже записанные неполные прогоны RDWeb. Поэтому:
--   * CHECK: у pdf_page размеры обязательны при любом статусе, кроме missing (для любого движка);
--   * охранник вставки recognition_page_unit_guard: у страницы PDF локального прогона размеры обязательны
--     и при missing — движок прогона CHECK не видит.
-- У логической единицы (лист XLSX, таблица CSV, тело DOCX) правило прежнее: размеров, поворота и номера
-- листа чертежа нет. recognition_page неизменяема, поэтому охранник проверяет только новые строки, а CHECK
-- при добавлении проверяет и все существующие.
ALTER TABLE recognition_page DROP CONSTRAINT recognition_page_unit_shape;
ALTER TABLE recognition_page ADD CONSTRAINT recognition_page_unit_shape CHECK (
  (unit_kind = 'pdf_page' AND (status = 'missing' OR (width_px IS NOT NULL AND height_px IS NOT NULL)))
  OR (unit_kind <> 'pdf_page' AND width_px IS NULL AND height_px IS NULL AND rotation = 0 AND sheet_label IS NULL));

-- Существующие строки: локальная страница PDF без размеров означала бы, что инвариант уже нарушен.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM recognition_page p JOIN recognition_run r ON r.id = p.run_id
              WHERE r.engine = 'local_ocr' AND p.unit_kind = 'pdf_page' AND (p.width_px IS NULL OR p.height_px IS NULL)) THEN
    RAISE EXCEPTION '0015: есть страница PDF локального прогона без размеров (R05a-01)' USING ERRCODE = '23514';
  END IF;
END;
$$;

-- Вид единицы соответствует прогону: у RDWeb — только страницы PDF; у локального — единица своего формата.
-- Плюс R05a-01: страница PDF локального прогона всегда с размерами, в том числе missing и failed.
CREATE OR REPLACE FUNCTION recognition_page_unit_guard() RETURNS trigger
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
  IF v_engine = 'local_ocr' AND NEW.unit_kind = 'pdf_page' AND (NEW.width_px IS NULL OR NEW.height_px IS NULL) THEN
    RAISE EXCEPTION 'recognition_page: у страницы PDF локального прогона размеры обязательны при любом статусе (AD-05a-1, R05a-01)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
