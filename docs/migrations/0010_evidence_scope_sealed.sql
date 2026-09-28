-- 0010 — состав снимка области доказательств фиксируется в транзакции его создания (R05-01, Review 05-1).
-- У kontur_app есть INSERT на evidence_scope и evidence_scope_item, поэтому неизменность состава
-- обеспечивают триггеры, а не только код команды: после фиксации снимка единицу в него не добавить,
-- content_hash всегда равен хэшу фактического состава, неполный снимок не фиксируется.
-- data-model §4.3, §5 (формула хэша), state-machines §5.1.

-- ---------------------------------------------------------------- Печать транзакции создания

-- Транзакция, создавшая снимок. Значение ставит триггер — приложение его не задаёт. Вместе с номером
-- печать сверяет время начала транзакции (created_at = now()): после восстановления из pg_dump номера
-- транзакций нового кластера могут совпасть со старыми, время начала — нет. У снимков, созданных до
-- этой миграции, печати нет: они закрыты для вставки навсегда.
ALTER TABLE evidence_scope ADD COLUMN created_xact xid8;

CREATE FUNCTION evidence_scope_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_xact := pg_current_xact_id();
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_scope_stamp BEFORE INSERT ON evidence_scope
  FOR EACH ROW EXECUTE FUNCTION evidence_scope_stamp();

-- Единица вставляется только транзакцией, создавшей снимок; в любой другой — отказ до остальных
-- проверок (имя триггера идёт раньше evidence_scope_item_insert_guard). pg_current_xact_id()
-- возвращает номер транзакции верхнего уровня и внутри точки сохранения.
CREATE FUNCTION evidence_scope_item_creation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM evidence_scope s
        WHERE s.id = NEW.scope_id AND s.created_xact = pg_current_xact_id() AND s.created_at = now()) THEN
    RAISE EXCEPTION 'evidence_scope_item: снимок % зафиксирован — единицы добавляются только в транзакции его создания', NEW.scope_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_scope_item_creation_guard BEFORE INSERT ON evidence_scope_item
  FOR EACH ROW EXECUTE FUNCTION evidence_scope_item_creation_guard();

-- ---------------------------------------------------------------- Сверка состава

-- Хэш фактического состава по формуле data-model §5. Та же формула — evidenceScopeContentHash
-- в packages/core/src/search.ts: строки [unit_type, ID редакции, ID прогона или '', '', ''] в JSON без
-- пробелов, порядок — по строке, склеенной через '|', побайтно (COLLATE "C"). Значения — латиница,
-- цифры и дефисы, экранирование JSON им не нужно.
CREATE FUNCTION evidence_scope_composition_hash(p_scope uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
           'kontur.evidence_scope.v1' || E'\n' || r.content_hash || E'\n[' ||
           coalesce((SELECT string_agg(u.row_json, ',' ORDER BY u.sort_key COLLATE "C")
                       FROM (SELECT '["' || i.unit_type || '","' || i.document_revision_id::text || '","'
                                    || coalesce(i.recognition_run_id::text, '') || '","",""]' AS row_json,
                                    i.unit_type || '|' || i.document_revision_id::text || '|'
                                    || coalesce(i.recognition_run_id::text, '') || '||' AS sort_key
                               FROM evidence_scope_item i
                              WHERE i.scope_id = s.id) u), '') || ']',
           'UTF8')), 'hex')
    FROM evidence_scope s
    JOIN source_set_revision r ON r.id = s.source_set_revision_id
   WHERE s.id = p_scope
$$;

-- Полнота (state-machines §5.1: каждая включённая редакция основы записывается в снимок) и
-- совпадение content_hash с хэшем фактического состава.
CREATE FUNCTION evidence_scope_verify(p_scope uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_base uuid;
  v_hash text;
BEGIN
  SELECT source_set_revision_id, content_hash INTO v_base, v_hash FROM evidence_scope WHERE id = p_scope;
  IF EXISTS (
       SELECT 1 FROM source_set_item i
        WHERE i.source_set_revision_id = v_base AND i.inclusion <> 'excluded_not_applicable'
          AND NOT EXISTS (SELECT 1 FROM evidence_scope_item e WHERE e.scope_id = p_scope AND e.document_revision_id = i.document_revision_id)) THEN
    RAISE EXCEPTION 'evidence_scope %: состав неполон — включённая редакция основы не вошла в снимок', p_scope
      USING ERRCODE = '23514';
  END IF;
  IF evidence_scope_composition_hash(p_scope) IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'evidence_scope %: content_hash не соответствует составу единиц', p_scope USING ERRCODE = '23514';
  END IF;
END;
$$;

-- После каждой команды вставки единиц состав затронутых снимков сверяется сразу: весь состав
-- записывается одной командой, частичная вставка отклоняется. Это же закрывает досрочную проверку
-- через SET CONSTRAINTS … IMMEDIATE: единица, добавленная после неё, меняет хэш и отклоняется.
CREATE FUNCTION evidence_scope_item_composition_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_scope uuid;
BEGIN
  FOR v_scope IN SELECT DISTINCT scope_id FROM added LOOP
    PERFORM evidence_scope_verify(v_scope);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER evidence_scope_item_composition_check AFTER INSERT ON evidence_scope_item
  REFERENCING NEW TABLE AS added
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_scope_item_composition_check();

-- При фиксации транзакции снимок сверяется ещё раз: снимок без команды вставки единиц (или с
-- неполной) не фиксируется. Частично заполненный снимок до COMMIT другим транзакциям не виден.
CREATE FUNCTION evidence_scope_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM evidence_scope_verify(NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER evidence_scope_commit_check
  AFTER INSERT ON evidence_scope
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION evidence_scope_commit_check();

-- ---------------------------------------------------------------- Уже созданные снимки

-- Снимки, созданные до этой миграции, проверяются тем же правилом: расхождение не даёт применить миграцию.
DO $$
DECLARE
  v_scope uuid;
BEGIN
  FOR v_scope IN SELECT id FROM evidence_scope LOOP
    PERFORM evidence_scope_verify(v_scope);
  END LOOP;
END;
$$;
