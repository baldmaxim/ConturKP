-- 0007 — точность ссылок на страницы и линейность истории прогонов (ревью 04-2: R04-10, R04-12).
--
-- R04-10 — сверка счётчиков со строками страниц не проверяла сами номера: прогон с одной
--          страницей page_index = 999 при pages_total = 1 сходился по числам и объявлялся
--          complete, хотя страницы 0 в нём нет. Доказательство могло ссылаться на страницу,
--          которой в прогоне не существует.
-- R04-12 — история прогонов ветвилась: два архива, загруженные до обработки первого,
--          получали общего предшественника, и цепочка supersedes переставала быть цепочкой.

-- ---------------------------------------------------------------- R04-10: страницы фрагмента

-- Ссылка доказательства на страницу обязана вести к существующей странице своего прогона.
-- MATCH SIMPLE: фрагмент без страницы (page_index IS NULL) проверке не подлежит — такие
-- фрагменты штатны (секция markdown без блока, штамп без привязки).
ALTER TABLE evidence_fragment ADD CONSTRAINT evidence_fragment_page_fk
  FOREIGN KEY (run_id, page_index) REFERENCES recognition_page (run_id, page_index);

-- ---------------------------------------------------------------- R04-12: одна активная версия

-- Не более одного незавершённого прогона на редакцию: иначе два архива, принятые подряд,
-- становятся братьями с общим supersedes_run_id, и история перестаёт быть линейной.
CREATE UNIQUE INDEX recognition_run_active_key
  ON recognition_run (document_revision_id) WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------- R04-10: набор индексов

-- Тот же охранник, что в 0006, плюс проверка точного набора индексов 0..pages_total-1.
-- Совпадения количества мало: номера страниц — часть доказательства полноты (I18).
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
     OR NEW.tender_id <> OLD.tender_id
     OR NEW.engine <> OLD.engine
     OR NEW.source_artifact_sha256 <> OLD.source_artifact_sha256
     OR NEW.source_artifact_name IS DISTINCT FROM OLD.source_artifact_name
     OR NEW.supersedes_run_id IS DISTINCT FROM OLD.supersedes_run_id
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
    -- (run_id, page_index) уникальны, поэтому совпадения количества, минимума и максимума
    -- достаточно, чтобы набор индексов был ровно 0..pages_total-1.
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
