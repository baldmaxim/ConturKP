-- 0016 — R05a-01 (Review 05a-2): исключение «страница PDF без размеров» — только rdweb_export + missing.
-- Миграция 0015 разрешила в CHECK recognition_page_unit_shape страницу pdf_page в статусе missing без
-- размеров для любого движка, а охранник вставки закрыл это только для local_ocr. Прогоны text_layer и
-- rdweb_api схема допускает, и прямой вставкой под ролью приложения их страница missing записывалась без
-- размеров. Исключение нужно ровно одному случаю: импорт экспорта RDWeb (этап 04, R04-03) заводит строку на
-- каждую страницу оригинала, а размеры знает только из _blocks.json, поэтому страницу, которой в экспорте
-- нет, пишет missing без размеров. Для rdweb_api принятого контракта нет (X-05), и исключение на него
-- не распространяется.
--
-- CHECK остаётся общим (движок прогона он не видит); узкое правило — в охраннике вставки:
-- у pdf_page без размеров допустимы только engine = 'rdweb_export' и status = 'missing'.
-- recognition_page неизменяема, поэтому существующие строки проверяются один раз здесь.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM recognition_page p JOIN recognition_run r ON r.id = p.run_id
              WHERE p.unit_kind = 'pdf_page' AND (p.width_px IS NULL OR p.height_px IS NULL)
                AND NOT (r.engine = 'rdweb_export' AND p.status = 'missing')) THEN
    RAISE EXCEPTION '0016: есть страница PDF без размеров вне исключения rdweb_export + missing (R05a-01)' USING ERRCODE = '23514';
  END IF;
END;
$$;

-- Вид единицы соответствует прогону: у RDWeb — только страницы PDF; у локального — единица своего формата.
-- R05a-01: страница PDF без размеров — только страница экспорта RDWeb, которой нет в _blocks.json.
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
  IF NEW.unit_kind = 'pdf_page' AND (NEW.width_px IS NULL OR NEW.height_px IS NULL)
     AND NOT (v_engine IS NOT DISTINCT FROM 'rdweb_export' AND NEW.status = 'missing') THEN
    RAISE EXCEPTION 'recognition_page: страница PDF без размеров допустима только у экспорта RDWeb в статусе missing (AD-05a-1, R05a-01); движок %, статус %',
      v_engine, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
