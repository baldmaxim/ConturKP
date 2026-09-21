-- 0003 — исправления защиты данных по ревью 03-1 (docs/reviews/03-review-1.md):
-- R03-01 состав замороженной ревизии набора источников, R03-02 неизменяемость элемента
-- завершённой партии импорта, R03-03 неразрывность пары «версия входов этапа ↔ событие барьера».

-- ---------------------------------------------------------------- R03-01

-- Прежняя версия проверяла статус только NEW-ревизии: строку замороженной ревизии можно было
-- перенести в черновик и тем изменить замороженный состав. Теперь ссылка на ревизию неизменяема
-- после вставки, а статус проверяется и у OLD, и у NEW.
CREATE OR REPLACE FUNCTION source_set_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_status text;
  new_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.source_set_revision_id <> OLD.source_set_revision_id THEN
    RAISE EXCEPTION 'source_set_item: строка не переносится между ревизиями (состав замороженной ревизии не меняется)'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO old_status FROM source_set_revision WHERE id = OLD.source_set_revision_id;
    IF old_status <> 'draft' THEN
      RAISE EXCEPTION 'source_set_item: состав замороженной ревизии не меняется' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO new_status FROM source_set_revision WHERE id = NEW.source_set_revision_id;
    IF new_status <> 'draft' THEN
      RAISE EXCEPTION 'source_set_item: состав замороженной ревизии не меняется' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- ---------------------------------------------------------------- R03-02

-- После завершения партии разрешён единственный переход исхода (resolution) из none и только
-- сопутствующие ему поля. Поля идентичности и доказательства неизменяемы всегда.
CREATE OR REPLACE FUNCTION import_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  batch_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import_item: удаление запрещено' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.batch_id <> OLD.batch_id OR NEW.tender_id <> OLD.tender_id
     OR NEW.member_path <> OLD.member_path OR NEW.observed_name <> OLD.observed_name
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'import_item: поля идентичности элемента неизменяемы' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO batch_status FROM import_batch WHERE id = OLD.batch_id;
  IF batch_status = 'running' THEN
    IF NEW.resolution <> OLD.resolution OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       OR NEW.resolved_by_item_id IS DISTINCT FROM OLD.resolved_by_item_id
       OR NEW.resolution_decision_id IS DISTINCT FROM OLD.resolution_decision_id THEN
      RAISE EXCEPTION 'import_item: исход задаётся после завершения партии' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- Партия завершена: единственный допустимый переход — задание исхода отклонённому элементу.
  IF OLD.resolution <> 'none' THEN
    RAISE EXCEPTION 'import_item (frozen-after): исход уже задан и не меняется' USING ERRCODE = '55000';
  END IF;
  IF NEW.resolution = 'none' THEN
    RAISE EXCEPTION 'import_item (frozen-after): партия завершена, меняется только исход элемента' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.reject_reason IS DISTINCT FROM OLD.reject_reason
     OR NEW.reject_detail IS DISTINCT FROM OLD.reject_detail
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.blob_sha256 IS DISTINCT FROM OLD.blob_sha256
     OR NEW.document_revision_id IS DISTINCT FROM OLD.document_revision_id THEN
    RAISE EXCEPTION 'import_item (frozen-after): поля доказательства неизменяемы' USING ERRCODE = '55000';
  END IF;
  IF NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'import_item: исход требует автора и времени решения' USING ERRCODE = '23514';
  END IF;
  IF NEW.resolution = 'not_applicable' AND NOT EXISTS (
       SELECT 1 FROM decision d
        WHERE d.id = NEW.resolution_decision_id AND d.decision_type = 'import_item_disposition'
          AND d.subject_type = 'import_item' AND d.subject_id = NEW.id AND d.tender_id = NEW.tender_id
     ) THEN
    RAISE EXCEPTION 'import_item: решение о неприменимости должно относиться к этому элементу и тендеру' USING ERRCODE = '23514';
  END IF;
  IF NEW.resolution = 'reimported' AND NOT EXISTS (
       SELECT 1 FROM import_item other
        WHERE other.id = NEW.resolved_by_item_id AND other.tender_id = NEW.tender_id
          AND other.batch_id <> NEW.batch_id AND other.status IN ('registered', 'duplicate')
     ) THEN
    RAISE EXCEPTION 'import_item: повторный импорт — зарегистрированный элемент другой партии того же тендера' USING ERRCODE = '23514';
  END IF;
  -- Технические поля механизма обновления: версия строки растёт ровно на 1, время не уходит назад.
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'import_item: row_version увеличивается на 1, updated_at не уменьшается' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- R03-03

-- Барьер актуальности (R01-03): изменение tender_stage.input_version и соответствующее событие
-- stage_input_event фиксируются только вместе. Отложенная проверка на COMMIT ловит обе половины:
-- повышение версии без события и событие без повышения версии. Немедленные триггеры 0002
-- (шаг ровно +1 и seq = текущей версии) остаются первой линией.
CREATE FUNCTION stage_version_event_pair_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  stage uuid;
  version bigint;
BEGIN
  -- Поля NEW разные у двух таблиц: обращаться к отсутствующему полю нельзя даже в неиспользуемой ветке.
  IF TG_TABLE_NAME = 'tender_stage' THEN
    stage := NEW.id;
  ELSE
    stage := NEW.stage_id;
  END IF;
  SELECT input_version INTO version FROM tender_stage WHERE id = stage;
  -- Проверка постоянной стоимости по уникальному индексу (stage_id, seq): у текущей версии есть
  -- своё событие и нет событий с большим номером. Вместе с немедленными триггерами 0002
  -- (шаг ровно +1 и seq = текущей версии) это означает «версия и событие фиксируются вместе».
  IF version > 0 AND NOT EXISTS (SELECT 1 FROM stage_input_event WHERE stage_id = stage AND seq = version) THEN
    RAISE EXCEPTION 'версия входов этапа (%) изменена без события барьера: версия и событие фиксируются вместе', version
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM stage_input_event WHERE stage_id = stage AND seq > version) THEN
    RAISE EXCEPTION 'событие барьера с номером больше версии входов этапа (%)', version USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tender_stage_version_pair
  AFTER UPDATE ON tender_stage
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.input_version IS DISTINCT FROM OLD.input_version)
  EXECUTE FUNCTION stage_version_event_pair_check();

CREATE CONSTRAINT TRIGGER stage_input_event_version_pair
  AFTER INSERT ON stage_input_event
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION stage_version_event_pair_check();
