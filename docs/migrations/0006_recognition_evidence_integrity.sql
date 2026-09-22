-- 0006 — целостность прогона распознавания и доказательств (ревью 04-1: R04-02, R04-04,
-- R04-05, R04-06). Миграция 0005 уже применена и по правилу раннера неизменяема, поэтому
-- все поправки схемы этапа 04 живут здесь.
--
-- R04-02 — отмена задания обязана терминализовать прогон: вводится статус cancelled.
-- R04-04 — терминальный прогон становится неизменяемым агрегатом: дочерние строки нельзя
--          добавить ни в queued, ни в завершённый прогон, а счётчики сверяются с фактом.
-- R04-05 — фрагмент связывается составным FK с редакцией своего прогона.
-- R04-06 — длинный текст блока сохраняется частями, а не усечением: part_index/part_total.

-- ---------------------------------------------------------------- R04-02: статус cancelled

-- Отмена — не ошибка: failure_code у cancelled пуст, поэтому recognition_run_failure_shape
-- не меняется. Терминальность фиксируется finished_at, как у остальных конечных статусов.
ALTER TABLE recognition_run DROP CONSTRAINT recognition_run_status_check;
ALTER TABLE recognition_run ADD CONSTRAINT recognition_run_status_check
  CHECK (status IN ('queued', 'running', 'complete', 'partial', 'failed', 'cancelled'));

ALTER TABLE recognition_run DROP CONSTRAINT recognition_run_finished_shape;
ALTER TABLE recognition_run ADD CONSTRAINT recognition_run_finished_shape
  CHECK ((status IN ('complete', 'partial', 'failed', 'cancelled')) = (finished_at IS NOT NULL));

-- Отменённый прогон не занимает пару «редакция + архив»: повторная загрузка того же экспорта
-- после отмены обязана создавать новый прогон с новым заданием, а не возвращать вечный reused.
DROP INDEX recognition_run_artifact_key;
CREATE UNIQUE INDEX recognition_run_artifact_key
  ON recognition_run (document_revision_id, source_artifact_sha256)
  WHERE status NOT IN ('failed', 'cancelled');

-- ---------------------------------------------------------------- R04-05: фрагмент и редакция

-- Простого FK на document_revision (id) недостаточно: строка могла ссылаться на редакцию
-- чужого тендера при корректных run_id и tender_id, и доказательство получало ложную связь.
ALTER TABLE recognition_run ADD CONSTRAINT recognition_run_id_revision_tender_key
  UNIQUE (id, document_revision_id, tender_id);

-- Прогонный фрагмент обязан иметь редакцию: иначе составной FK (MATCH SIMPLE) не проверялся бы.
ALTER TABLE evidence_fragment ADD CONSTRAINT evidence_fragment_revision_shape
  CHECK (run_id IS NULL OR document_revision_id IS NOT NULL);
ALTER TABLE evidence_fragment ADD CONSTRAINT evidence_fragment_run_revision_tender_fk
  FOREIGN KEY (run_id, document_revision_id, tender_id)
  REFERENCES recognition_run (id, document_revision_id, tender_id);

-- ---------------------------------------------------------------- R04-06: части фрагмента

-- Текст блока длиннее предела разбора сохраняется несколькими неизменяемыми фрагментами
-- со стабильными ключами; усечения доказательства не происходит нигде.
ALTER TABLE evidence_fragment
  ADD COLUMN part_index int NOT NULL DEFAULT 0 CHECK (part_index >= 0),
  ADD COLUMN part_total int NOT NULL DEFAULT 1 CHECK (part_total >= 1);
ALTER TABLE evidence_fragment ADD CONSTRAINT evidence_fragment_part_shape CHECK (part_index < part_total);

-- Порядок чтения частей обязан быть определённым: id — случайный uuid, он для этого не годится.
DROP INDEX evidence_fragment_page_idx;
CREATE INDEX evidence_fragment_page_idx ON evidence_fragment (run_id, page_index, ordinal, part_index, id);

-- ---------------------------------------------------------------- R04-04: агрегат прогона

-- Дочерние строки добавляются только в выполняющийся прогон. Строка прогона блокируется:
-- это сериализует вставку с финальной транзакцией worker, которая держит ту же блокировку,
-- поэтому после терминализации новая страница или фрагмент появиться физически не могут.
CREATE FUNCTION recognition_child_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
BEGIN
  IF NEW.run_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT status INTO run_status FROM recognition_run WHERE id = NEW.run_id FOR UPDATE;
  IF run_status IS NULL THEN
    RAISE EXCEPTION '%: прогон % не найден', TG_TABLE_NAME, NEW.run_id USING ERRCODE = '23503';
  END IF;
  IF run_status <> 'running' THEN
    RAISE EXCEPTION '%: доказательства добавляются только в выполняющийся прогон (статус %) (I15)',
      TG_TABLE_NAME, run_status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recognition_page_insert_guard BEFORE INSERT ON recognition_page
  FOR EACH ROW EXECUTE FUNCTION recognition_child_insert_guard();
CREATE TRIGGER evidence_fragment_insert_guard BEFORE INSERT ON evidence_fragment
  FOR EACH ROW EXECUTE FUNCTION recognition_child_insert_guard();

-- Тот же охранник, что в 0005, плюс: переходы в cancelled и вторая линия счётчиков полноты.
-- Объявить complete или partial по числам, не подтверждённым строками recognition_page,
-- больше нельзя: заголовок прогона и его содержимое обязаны совпадать (I15, I18).
CREATE OR REPLACE FUNCTION recognition_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual_pages      int;
  actual_recognized int;
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
    SELECT count(*), count(*) FILTER (WHERE status = 'recognized')
      INTO actual_pages, actual_recognized
      FROM recognition_page WHERE run_id = NEW.id;
    IF NEW.pages_total IS DISTINCT FROM actual_pages THEN
      RAISE EXCEPTION 'recognition_run: pages_total = % при % фактических страницах прогона (I18)',
        NEW.pages_total, actual_pages USING ERRCODE = '23514';
    END IF;
    IF NEW.pages_recognized <> actual_recognized THEN
      RAISE EXCEPTION 'recognition_run: pages_recognized = % при % распознанных страницах прогона (I18)',
        NEW.pages_recognized, actual_recognized USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'recognition_run: row_version увеличивается на 1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
