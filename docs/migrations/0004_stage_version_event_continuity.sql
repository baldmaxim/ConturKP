-- 0004 — непрерывность барьера актуальности по ревью 03-2 (R03-03).
-- Прежняя отложенная проверка перечитывала финальную версию этапа, поэтому два повышения
-- в одной транзакции закрывались одним событием последнего номера: промежуточный номер
-- оставался без события. Теперь проверяется образ строки КАЖДОГО обновления: у версии,
-- установленной этим UPDATE, должно быть своё событие. Стартовая версия этапа — только 0.

CREATE OR REPLACE FUNCTION stage_version_event_pair_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- NEW — образ строки на момент этого обновления, а не финальное состояние транзакции.
  IF NEW.input_version > 0 AND NOT EXISTS (
       SELECT 1 FROM stage_input_event WHERE stage_id = NEW.id AND seq = NEW.input_version
     ) THEN
    RAISE EXCEPTION 'повышение версии входов этапа до % не имеет своего события барьера: версия и событие фиксируются вместе', NEW.input_version
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;

-- Событие не может оказаться впереди версии этапа (вторая половина пары).
CREATE FUNCTION stage_event_within_version_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version bigint;
BEGIN
  SELECT input_version INTO version FROM tender_stage WHERE id = NEW.stage_id;
  IF version IS NULL OR NEW.seq > version THEN
    RAISE EXCEPTION 'событие барьера % больше версии входов этапа (%)', NEW.seq, version USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER stage_input_event_version_pair ON stage_input_event;
CREATE CONSTRAINT TRIGGER stage_input_event_version_pair
  AFTER INSERT ON stage_input_event
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION stage_event_within_version_check();

-- Этап создаётся с нулевой версией входов: иначе историю барьера можно было бы начать
-- с номера, для которого событий не существует.
CREATE FUNCTION tender_stage_initial_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.input_version <> 0 THEN
    RAISE EXCEPTION 'новый этап создаётся с input_version = 0' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tender_stage_initial_version_guard BEFORE INSERT ON tender_stage
  FOR EACH ROW EXECUTE FUNCTION tender_stage_initial_version_guard();
