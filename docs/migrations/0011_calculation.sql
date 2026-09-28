-- 0011 — этап 06: TenderHub — источник расчёта этапа, выгрузки и неизменяемые ревизии расчёта.
-- data-model §4.2 (stage_calculation_source, external_ref), §4.5; state-machines §6, §11.1;
-- ADR-007 §5–8; ADR-005 §1–2 (деньги — numeric без округления плюс исходная лексема числа).
-- Вторая линия в БД по образцу R05-01: у kontur_app есть INSERT на строки содержимого, поэтому
-- полнота и хэш содержимого, линейность ревизий и неизменность записей держат триггеры.

-- ---------------------------------------------------------------- Источник расчёта этапа (Q-03)

-- Связь этапа с тендером TenderHub. external_tender_id — id строки tenders TenderHub: каждая версия
-- тендера там — отдельная строка (docs/discovery.md §4.2). Один primary на этап; тот же тендер
-- TenderHub может быть связан с несколькими этапами, у этапа могут быть справочные связи —
-- так поддерживаются обе схемы «этап ↔ версия», пока владелец не ответил на Q-03.
CREATE TABLE stage_calculation_source (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id           uuid NOT NULL,
  tender_id          uuid NOT NULL,
  system             text NOT NULL CHECK (system IN ('tenderhub')),
  external_tender_id uuid NOT NULL,
  -- Версия, заявленная при связывании; наблюдённую версию пишет выгрузка (source_observed).
  external_version   integer CHECK (external_version IS NULL OR external_version >= 0),
  role               text NOT NULL CHECK (role IN ('primary', 'reference')),
  created_by         uuid NOT NULL REFERENCES app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  row_version        bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT stage_calculation_source_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT stage_calculation_source_key UNIQUE (stage_id, system, external_tender_id),
  CONSTRAINT stage_calculation_source_id_tender_key UNIQUE (id, tender_id)
);
CREATE UNIQUE INDEX stage_calculation_source_primary_key ON stage_calculation_source (stage_id) WHERE role = 'primary';

-- Связь меняется только ролью и заявленной версией; этап, тендер и внешний id неизменны.
CREATE FUNCTION stage_calculation_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage_id <> OLD.stage_id OR NEW.tender_id <> OLD.tender_id OR NEW.system <> OLD.system
     OR NEW.external_tender_id <> OLD.external_tender_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'stage_calculation_source: этап, тендер и внешний id связи неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'stage_calculation_source: row_version растёт на 1 при каждом изменении' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stage_calculation_source_guard BEFORE UPDATE ON stage_calculation_source
  FOR EACH ROW EXECUTE FUNCTION stage_calculation_source_guard();
CREATE TRIGGER stage_calculation_source_no_delete BEFORE DELETE ON stage_calculation_source
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('history');
CREATE TRIGGER stage_calculation_source_no_truncate BEFORE TRUNCATE ON stage_calculation_source
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

-- ---------------------------------------------------------------- Внешние идентификаторы

-- Наблюдённая идентичность тендера во внешней системе: номер тендера TenderHub (общий для всех
-- его версий) принадлежит ровно одному тендеру портала — иначе данные двух тендеров портала
-- смешались бы (I05). Запись неизменна.
CREATE TABLE external_ref (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text NOT NULL CHECK (entity_type IN ('tender')),
  entity_id        uuid NOT NULL,
  tender_id        uuid NOT NULL REFERENCES tender (id),
  system           text NOT NULL CHECK (system IN ('tenderhub')),
  external_id      text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  external_version text CHECK (length(external_version) BETWEEN 1 AND 100),
  observed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_ref_tender_shape CHECK (entity_type <> 'tender' OR entity_id = tender_id),
  CONSTRAINT external_ref_key UNIQUE NULLS NOT DISTINCT (system, external_id, external_version, entity_type)
);
CREATE TRIGGER external_ref_immutable BEFORE UPDATE OR DELETE ON external_ref
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER external_ref_no_truncate BEFORE TRUNCATE ON external_ref
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Выгрузка (state-machines §6)

CREATE TABLE calculation_capture (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id           uuid NOT NULL,
  tender_id          uuid NOT NULL,
  source_id          uuid NOT NULL,
  system             text NOT NULL CHECK (system IN ('tenderhub')),
  external_tender_id uuid NOT NULL,
  -- portal_capture — собственная выгрузка маршрутов API (до X-01); tenderhub_revision — ревизия по ID (после X-01).
  capture_kind       text NOT NULL CHECK (capture_kind IN ('portal_capture', 'tenderhub_revision')),
  -- D-016: один адаптер, транспорт фиксируется; прямое чтение БД TenderHub на этапе 06 не реализуется.
  transport          text NOT NULL CHECK (transport IN ('api')),
  -- deadline — сигнал срока подачи из TenderHub (ADR-007 §7), а не собственный механизм закрытия.
  trigger            text NOT NULL CHECK (trigger IN ('manual', 'deadline')),
  deadline_basis     timestamptz,
  status             text NOT NULL DEFAULT 'capturing' CHECK (status IN ('capturing', 'complete', 'inconsistent', 'failed')),
  requested_by       uuid REFERENCES app_user (id),
  -- Журнал попыток: каждая попытка дописывается, прежние не меняются.
  attempts           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attempts) = 'array'),
  consistency        jsonb,
  source_observed    jsonb,
  raw_bundle_sha256  text REFERENCES blob (sha256),
  contract_version   text CHECK (length(contract_version) BETWEEN 1 AND 60),
  content_id         uuid,
  revision_id        uuid,
  failure_code       text CHECK (length(failure_code) BETWEEN 1 AND 60),
  failure_detail     text CHECK (length(failure_detail) <= 500),
  job_id             uuid REFERENCES job (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  row_version        bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT calculation_capture_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT calculation_capture_source_fk FOREIGN KEY (source_id, tender_id) REFERENCES stage_calculation_source (id, tender_id),
  CONSTRAINT calculation_capture_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT calculation_capture_finished_shape CHECK ((status = 'capturing') = (finished_at IS NULL)),
  CONSTRAINT calculation_capture_complete_shape CHECK (
    status <> 'complete' OR (revision_id IS NOT NULL AND content_id IS NOT NULL AND raw_bundle_sha256 IS NOT NULL
                             AND consistency IS NOT NULL AND contract_version IS NOT NULL AND failure_code IS NULL)),
  CONSTRAINT calculation_capture_failure_shape CHECK ((status IN ('failed', 'inconsistent')) = (failure_code IS NOT NULL)),
  CONSTRAINT calculation_capture_result_shape CHECK (status = 'complete' OR (revision_id IS NULL AND content_id IS NULL)),
  -- Ручную выгрузку запрашивает человек, выгрузку по сроку — система.
  CONSTRAINT calculation_capture_trigger_shape CHECK (
    (trigger = 'manual' AND requested_by IS NOT NULL AND deadline_basis IS NULL)
    OR (trigger = 'deadline' AND requested_by IS NULL AND deadline_basis IS NOT NULL))
);
-- Одна незавершённая выгрузка на (этап, тендер TenderHub).
CREATE UNIQUE INDEX calculation_capture_active_key ON calculation_capture (stage_id, external_tender_id) WHERE status = 'capturing';
CREATE INDEX calculation_capture_stage_idx ON calculation_capture (stage_id, created_at DESC);

-- frozen-after: создаётся только capturing из связи того же этапа; после терминального статуса
-- строка неизменна; закреплённые поля не меняются; журнал попыток только дописывается.
CREATE FUNCTION calculation_capture_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'capturing' OR NEW.row_version <> 1 OR jsonb_array_length(NEW.attempts) <> 0 THEN
      RAISE EXCEPTION 'calculation_capture: выгрузка создаётся в состоянии capturing без попыток' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM stage_calculation_source s
          WHERE s.id = NEW.source_id AND s.stage_id = NEW.stage_id AND s.system = NEW.system
            AND s.external_tender_id = NEW.external_tender_id) THEN
      RAISE EXCEPTION 'calculation_capture: связь не принадлежит этапу или другому тендеру TenderHub' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'capturing' THEN
    RAISE EXCEPTION 'calculation_capture (frozen-after): выгрузка % завершена, запись неизменна', OLD.id USING ERRCODE = '55000';
  END IF;
  IF NEW.stage_id <> OLD.stage_id OR NEW.tender_id <> OLD.tender_id OR NEW.source_id <> OLD.source_id OR NEW.system <> OLD.system
     OR NEW.external_tender_id <> OLD.external_tender_id OR NEW.capture_kind <> OLD.capture_kind OR NEW.transport <> OLD.transport
     OR NEW.trigger <> OLD.trigger OR NEW.deadline_basis IS DISTINCT FROM OLD.deadline_basis
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.created_at <> OLD.created_at
     OR NEW.job_id IS DISTINCT FROM OLD.job_id AND OLD.job_id IS NOT NULL THEN
    RAISE EXCEPTION 'calculation_capture: закреплённые поля выгрузки неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'calculation_capture: row_version растёт на 1 при каждом изменении' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(NEW.attempts) < jsonb_array_length(OLD.attempts)
     OR EXISTS (SELECT 1 FROM generate_series(0, jsonb_array_length(OLD.attempts) - 1) AS g(i)
                 WHERE NEW.attempts -> g.i IS DISTINCT FROM OLD.attempts -> g.i) THEN
    RAISE EXCEPTION 'calculation_capture: журнал попыток только дописывается' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_capture_guard BEFORE INSERT OR UPDATE ON calculation_capture
  FOR EACH ROW EXECUTE FUNCTION calculation_capture_guard();
CREATE TRIGGER calculation_capture_no_delete BEFORE DELETE ON calculation_capture
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER calculation_capture_no_truncate BEFORE TRUNCATE ON calculation_capture
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- ---------------------------------------------------------------- Содержимое расчёта

-- Содержимое дедуплицируется по content_hash (R01-04): одинаковое хранится один раз. Итог КП
-- не выводится, пока владелец не задал правило (Q-05): kp_total пуст без kp_total_rule.
-- source_grand_total — cached_grand_total шапки TenderHub как значение источника, итогом КП
-- портала он не объявляется.
CREATE TABLE calculation_content (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash          text NOT NULL UNIQUE CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  normalization_version text NOT NULL CHECK (length(normalization_version) BETWEEN 1 AND 40),
  source_grand_total    numeric,
  usd_rate              numeric,
  eur_rate              numeric,
  cny_rate              numeric,
  kp_total              numeric,
  kp_total_currency     text CHECK (kp_total_currency IN ('RUB', 'USD', 'EUR', 'CNY')),
  kp_total_rule         text CHECK (length(kp_total_rule) BETWEEN 1 AND 60),
  kp_total_semantics    jsonb NOT NULL,
  raw_lexemes           jsonb NOT NULL CHECK (jsonb_typeof(raw_lexemes) = 'object'),
  positions_count       integer NOT NULL CHECK (positions_count >= 0),
  lines_count           integer NOT NULL CHECK (lines_count >= 0),
  created_xact          xid8,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calculation_content_kp_total_shape CHECK (
    (kp_total IS NULL AND kp_total_currency IS NULL) OR (kp_total IS NOT NULL AND kp_total_currency IS NOT NULL AND kp_total_rule IS NOT NULL))
);

CREATE TABLE calculation_position (
  id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id                         uuid NOT NULL REFERENCES calculation_content (id),
  external_position_id               uuid NOT NULL,
  position_number                    numeric NOT NULL,
  item_no                            text,
  work_name                          text NOT NULL,
  unit_code                          text,
  volume                             numeric,
  -- manual_volume и manual_note хранятся как значения источника: семантика не подтверждена.
  manual_volume                      numeric,
  manual_note                        text,
  client_note                        text,
  section_number                     text,
  position_name                      text,
  -- Заголовок раздела по правилу TenderHub; работой не считается.
  is_section                         boolean NOT NULL,
  is_additional                      boolean,
  hierarchy_level                    integer,
  parent_external_position_id        uuid,
  -- «Самая частая категория строк позиции» по TenderHub: строкам не присваивается.
  cost_category_name                 text,
  total_material                     numeric,
  total_works                        numeric,
  material_cost_per_unit             numeric,
  work_cost_per_unit                 numeric,
  total_commercial_material          numeric,
  total_commercial_work              numeric,
  total_commercial_material_per_unit numeric,
  total_commercial_work_per_unit     numeric,
  base_total                         numeric,
  commercial_total                   numeric,
  material_cost_total                numeric,
  work_cost_total                    numeric,
  markup_percentage                  numeric,
  items_count                        integer CHECK (items_count >= 0),
  raw_lexemes                        jsonb NOT NULL CHECK (jsonb_typeof(raw_lexemes) = 'object'),
  CONSTRAINT calculation_position_key UNIQUE (content_id, external_position_id)
);

CREATE TABLE calculation_line (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id                   uuid NOT NULL REFERENCES calculation_content (id),
  external_item_id             uuid NOT NULL,
  external_position_id         uuid NOT NULL,
  sort_number                  integer,
  -- Виды строк и справочные признаки — словарь источника, хранится как есть.
  item_type                    text NOT NULL CHECK (length(item_type) BETWEEN 1 AND 40),
  material_type                text,
  description                  text,
  work_name                    text,
  material_name                text,
  unit_code                    text,
  quantity                     numeric,
  base_quantity                numeric,
  consumption_coefficient      numeric,
  conversion_coefficient       numeric,
  unit_rate                    numeric,
  currency                     text CHECK (currency IN ('RUB', 'USD', 'EUR', 'CNY')),
  delivery_price_type          text,
  delivery_amount              numeric,
  total_amount                 numeric,
  commercial_markup            numeric,
  total_commercial_material    numeric,
  total_commercial_work        numeric,
  quote_link                   text,
  -- Даты источника цены маршрут boq-items-full не отдаёт; на этапе 06 всегда пусты.
  quote_price_date             date,
  quote_valid_until            date,
  cost_category                text,
  detail_cost_category         text,
  detail_cost_location         text,
  work_name_id                 text,
  material_name_id             text,
  detail_cost_category_id      text,
  parent_work_external_item_id uuid,
  raw_lexemes                  jsonb NOT NULL CHECK (jsonb_typeof(raw_lexemes) = 'object'),
  CONSTRAINT calculation_line_key UNIQUE (content_id, external_item_id),
  CONSTRAINT calculation_line_position_fk FOREIGN KEY (content_id, external_position_id)
    REFERENCES calculation_position (content_id, external_position_id)
);
CREATE INDEX calculation_line_position_idx ON calculation_line (content_id, external_position_id);

-- Каноническая запись полей для хэша содержимого. Та же форма — в packages/core/src/calculation.ts:
-- NULL — «~», текст — JSON-строка, число — десятичная запись без экспоненты и хвостовых нулей
-- (trim_scale), логическое — t/f, uuid — строчными. Менять вместе.
CREATE FUNCTION calc_enc_text(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN '~' ELSE to_jsonb(v)::text END
$$;
CREATE FUNCTION calc_enc_num(v numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN '~' ELSE trim_scale(v)::text END
$$;
CREATE FUNCTION calc_enc_int(v bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN '~' ELSE v::text END
$$;
CREATE FUNCTION calc_enc_bool(v boolean) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN '~' WHEN v THEN 't' ELSE 'f' END
$$;
CREATE FUNCTION calc_enc_uuid(v uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN '~' ELSE v::text END
$$;

-- Хэш фактического содержимого: шапка, позиции по внешнему id, строки по внешнему id.
CREATE FUNCTION calculation_content_hash(p_content uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
           'kontur.calculation_content.v1' || E'\n'
           || 'H|' || calc_enc_text(c.normalization_version) || '|' || calc_enc_num(c.source_grand_total)
           || '|' || calc_enc_num(c.usd_rate) || '|' || calc_enc_num(c.eur_rate) || '|' || calc_enc_num(c.cny_rate)
           || '|' || calc_enc_num(c.kp_total) || '|' || calc_enc_text(c.kp_total_currency) || '|' || calc_enc_text(c.kp_total_rule)
           || '|' || calc_enc_int(c.positions_count) || '|' || calc_enc_int(c.lines_count) || E'\n'
           || coalesce((
                SELECT string_agg(
                         'P|' || calc_enc_uuid(p.external_position_id) || '|' || calc_enc_num(p.position_number)
                         || '|' || calc_enc_text(p.item_no) || '|' || calc_enc_text(p.work_name) || '|' || calc_enc_text(p.unit_code)
                         || '|' || calc_enc_num(p.volume) || '|' || calc_enc_num(p.manual_volume) || '|' || calc_enc_text(p.manual_note)
                         || '|' || calc_enc_text(p.client_note) || '|' || calc_enc_text(p.section_number) || '|' || calc_enc_text(p.position_name)
                         || '|' || calc_enc_bool(p.is_section) || '|' || calc_enc_bool(p.is_additional) || '|' || calc_enc_int(p.hierarchy_level)
                         || '|' || calc_enc_uuid(p.parent_external_position_id) || '|' || calc_enc_text(p.cost_category_name)
                         || '|' || calc_enc_num(p.total_material) || '|' || calc_enc_num(p.total_works)
                         || '|' || calc_enc_num(p.material_cost_per_unit) || '|' || calc_enc_num(p.work_cost_per_unit)
                         || '|' || calc_enc_num(p.total_commercial_material) || '|' || calc_enc_num(p.total_commercial_work)
                         || '|' || calc_enc_num(p.total_commercial_material_per_unit) || '|' || calc_enc_num(p.total_commercial_work_per_unit)
                         || '|' || calc_enc_num(p.base_total) || '|' || calc_enc_num(p.commercial_total)
                         || '|' || calc_enc_num(p.material_cost_total) || '|' || calc_enc_num(p.work_cost_total)
                         || '|' || calc_enc_num(p.markup_percentage) || '|' || calc_enc_int(p.items_count),
                         E'\n' ORDER BY p.external_position_id::text COLLATE "C") || E'\n'
                  FROM calculation_position p WHERE p.content_id = c.id), '')
           || coalesce((
                SELECT string_agg(
                         'L|' || calc_enc_uuid(l.external_item_id) || '|' || calc_enc_uuid(l.external_position_id)
                         || '|' || calc_enc_int(l.sort_number) || '|' || calc_enc_text(l.item_type) || '|' || calc_enc_text(l.material_type)
                         || '|' || calc_enc_text(l.description) || '|' || calc_enc_text(l.work_name) || '|' || calc_enc_text(l.material_name)
                         || '|' || calc_enc_text(l.unit_code) || '|' || calc_enc_num(l.quantity) || '|' || calc_enc_num(l.base_quantity)
                         || '|' || calc_enc_num(l.consumption_coefficient) || '|' || calc_enc_num(l.conversion_coefficient)
                         || '|' || calc_enc_num(l.unit_rate) || '|' || calc_enc_text(l.currency) || '|' || calc_enc_text(l.delivery_price_type)
                         || '|' || calc_enc_num(l.delivery_amount) || '|' || calc_enc_num(l.total_amount) || '|' || calc_enc_num(l.commercial_markup)
                         || '|' || calc_enc_num(l.total_commercial_material) || '|' || calc_enc_num(l.total_commercial_work)
                         || '|' || calc_enc_text(l.quote_link) || '|' || calc_enc_text(l.cost_category) || '|' || calc_enc_text(l.detail_cost_category)
                         || '|' || calc_enc_text(l.detail_cost_location) || '|' || calc_enc_text(l.work_name_id) || '|' || calc_enc_text(l.material_name_id)
                         || '|' || calc_enc_text(l.detail_cost_category_id) || '|' || calc_enc_uuid(l.parent_work_external_item_id),
                         E'\n' ORDER BY l.external_item_id::text COLLATE "C") || E'\n'
                  FROM calculation_line l WHERE l.content_id = c.id), ''),
           'UTF8')), 'hex')
    FROM calculation_content c
   WHERE c.id = p_content
$$;

-- Полнота (заявленное число позиций и строк) и совпадение content_hash с пересчитанным БД хэшем.
CREATE FUNCTION calculation_content_verify(p_content uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_hash      text;
  v_positions integer;
  v_lines     integer;
BEGIN
  SELECT content_hash, positions_count, lines_count INTO v_hash, v_positions, v_lines FROM calculation_content WHERE id = p_content;
  IF (SELECT count(*) FROM calculation_position WHERE content_id = p_content) <> v_positions
     OR (SELECT count(*) FROM calculation_line WHERE content_id = p_content) <> v_lines THEN
    RAISE EXCEPTION 'calculation_content %: состав неполон — число позиций или строк не равно заявленному', p_content USING ERRCODE = '23514';
  END IF;
  IF calculation_content_hash(p_content) IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'calculation_content %: content_hash не соответствует содержимому', p_content USING ERRCODE = '23514';
  END IF;
END;
$$;

-- Печать транзакции создания (как у снимка области, миграция 0010): значения ставит триггер.
CREATE FUNCTION calculation_content_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_xact := pg_current_xact_id();
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_content_stamp BEFORE INSERT ON calculation_content
  FOR EACH ROW EXECUTE FUNCTION calculation_content_stamp();

-- Позиции и строки вставляются только транзакцией, создавшей содержимое; в любой другой — отказ.
CREATE FUNCTION calculation_content_creation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM calculation_content c
        WHERE c.id = NEW.content_id AND c.created_xact = pg_current_xact_id() AND c.created_at = now()) THEN
    RAISE EXCEPTION '%: содержимое % зафиксировано — строки добавляются только в транзакции его создания', TG_TABLE_NAME, NEW.content_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_position_creation_guard BEFORE INSERT ON calculation_position
  FOR EACH ROW EXECUTE FUNCTION calculation_content_creation_guard();
CREATE TRIGGER calculation_line_creation_guard BEFORE INSERT ON calculation_line
  FOR EACH ROW EXECUTE FUNCTION calculation_content_creation_guard();

-- После каждой команды вставки позиций или строк содержимое сверяется целиком: позиции и строки
-- пишутся одной командой; досрочная проверка через SET CONSTRAINTS … IMMEDIATE его не открывает.
CREATE FUNCTION calculation_content_statement_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_content uuid;
BEGIN
  FOR v_content IN SELECT DISTINCT content_id FROM added LOOP
    PERFORM calculation_content_verify(v_content);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER calculation_position_statement_check AFTER INSERT ON calculation_position
  REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION calculation_content_statement_check();
CREATE TRIGGER calculation_line_statement_check AFTER INSERT ON calculation_line
  REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION calculation_content_statement_check();

-- При COMMIT содержимое сверяется ещё раз: без позиций и строк (или с неполными) не фиксируется.
CREATE FUNCTION calculation_content_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM calculation_content_verify(NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER calculation_content_commit_check
  AFTER INSERT ON calculation_content
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION calculation_content_commit_check();

CREATE TRIGGER calculation_content_immutable BEFORE UPDATE OR DELETE ON calculation_content
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER calculation_content_no_truncate BEFORE TRUNCATE ON calculation_content
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER calculation_position_immutable BEFORE UPDATE OR DELETE ON calculation_position
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER calculation_position_no_truncate BEFORE TRUNCATE ON calculation_position
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER calculation_line_immutable BEFORE UPDATE OR DELETE ON calculation_line
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER calculation_line_no_truncate BEFORE TRUNCATE ON calculation_line
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Ревизия расчёта

-- Наблюдение источника, отдельное от содержимого (R01-04). provisional — выгрузка портала до X-01;
-- verified — ревизия TenderHub по её ID (после X-01), только со ссылкой на внешнюю ревизию.
CREATE TABLE calculation_revision (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id               uuid NOT NULL,
  tender_id              uuid NOT NULL,
  content_id             uuid NOT NULL REFERENCES calculation_content (id),
  capture_id             uuid NOT NULL,
  seq                    integer NOT NULL CHECK (seq > 0),
  kind                   text NOT NULL CHECK (kind IN ('provisional', 'verified')),
  system                 text NOT NULL CHECK (system IN ('tenderhub')),
  external_tender_id     uuid NOT NULL,
  external_revision_ref  text CHECK (length(external_revision_ref) BETWEEN 1 AND 200),
  supersedes_revision_id uuid REFERENCES calculation_revision (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calculation_revision_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT calculation_revision_capture_fk FOREIGN KEY (capture_id, tender_id) REFERENCES calculation_capture (id, tender_id),
  CONSTRAINT calculation_revision_seq_key UNIQUE (stage_id, seq),
  CONSTRAINT calculation_revision_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT calculation_revision_kind_shape CHECK ((kind = 'verified') = (external_revision_ref IS NOT NULL))
);
CREATE UNIQUE INDEX calculation_revision_verified_key ON calculation_revision (stage_id, external_revision_ref) WHERE kind = 'verified';
CREATE INDEX calculation_revision_source_idx ON calculation_revision (stage_id, external_tender_id, seq DESC);

-- Ревизию создаёт только незавершённая выгрузка того же этапа и тендера TenderHub; вид ревизии
-- соответствует виду выгрузки; номер — следующий по этапу; перекрывается только последняя ревизия
-- того же тендера TenderHub; повтор выгрузки с тем же содержимым новую provisional не создаёт.
CREATE FUNCTION calculation_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_capture calculation_capture%ROWTYPE;
  v_last    calculation_revision%ROWTYPE;
  v_max     integer;
BEGIN
  SELECT * INTO v_capture FROM calculation_capture WHERE id = NEW.capture_id;
  IF v_capture.stage_id IS DISTINCT FROM NEW.stage_id OR v_capture.external_tender_id IS DISTINCT FROM NEW.external_tender_id
     OR v_capture.system IS DISTINCT FROM NEW.system THEN
    RAISE EXCEPTION 'calculation_revision: выгрузка относится к другому этапу или тендеру TenderHub' USING ERRCODE = '23514';
  END IF;
  IF v_capture.status <> 'capturing' THEN
    RAISE EXCEPTION 'calculation_revision: ревизию создаёт только незавершённая выгрузка' USING ERRCODE = '23514';
  END IF;
  IF (NEW.kind = 'provisional') <> (v_capture.capture_kind = 'portal_capture') THEN
    RAISE EXCEPTION 'calculation_revision: вид ревизии % не соответствует виду выгрузки %', NEW.kind, v_capture.capture_kind USING ERRCODE = '23514';
  END IF;
  SELECT max(seq) INTO v_max FROM calculation_revision WHERE stage_id = NEW.stage_id;
  IF NEW.seq <> coalesce(v_max, 0) + 1 THEN
    RAISE EXCEPTION 'calculation_revision: номер ревизии этапа — следующий по порядку (%)', coalesce(v_max, 0) + 1 USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_last FROM calculation_revision
   WHERE stage_id = NEW.stage_id AND system = NEW.system AND external_tender_id = NEW.external_tender_id
   ORDER BY seq DESC LIMIT 1;
  IF NEW.supersedes_revision_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'calculation_revision: ревизия перекрывает только последнюю ревизию того же тендера TenderHub' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'provisional' AND v_last.id IS NOT NULL AND v_last.content_id = NEW.content_id THEN
    RAISE EXCEPTION 'calculation_revision: содержимое совпадает с последней ревизией — выгрузка связывается с ней' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_revision_insert_guard BEFORE INSERT ON calculation_revision
  FOR EACH ROW EXECUTE FUNCTION calculation_revision_insert_guard();
CREATE TRIGGER calculation_revision_immutable BEFORE UPDATE OR DELETE ON calculation_revision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER calculation_revision_no_truncate BEFORE TRUNCATE ON calculation_revision
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

ALTER TABLE calculation_capture
  ADD CONSTRAINT calculation_capture_content_fk FOREIGN KEY (content_id) REFERENCES calculation_content (id),
  ADD CONSTRAINT calculation_capture_revision_fk FOREIGN KEY (revision_id, tender_id) REFERENCES calculation_revision (id, tender_id);

-- Завершённая выгрузка ссылается на последнюю ревизию своего (этапа, тендера TenderHub) с тем же
-- содержимым: новую или прежнюю (повтор той же выгрузки идемпотентен).
CREATE FUNCTION calculation_capture_complete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last calculation_revision%ROWTYPE;
BEGIN
  SELECT * INTO v_last FROM calculation_revision
   WHERE stage_id = NEW.stage_id AND system = NEW.system AND external_tender_id = NEW.external_tender_id
   ORDER BY seq DESC LIMIT 1;
  IF v_last.id IS DISTINCT FROM NEW.revision_id OR v_last.content_id IS DISTINCT FROM NEW.content_id THEN
    RAISE EXCEPTION 'calculation_capture: завершённая выгрузка ссылается на последнюю ревизию с тем же содержимым' USING ERRCODE = '23514';
  END IF;
  IF (v_last.kind = 'provisional') <> (NEW.capture_kind = 'portal_capture') THEN
    RAISE EXCEPTION 'calculation_capture: вид ревизии не соответствует виду выгрузки' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_capture_complete_guard BEFORE UPDATE ON calculation_capture
  FOR EACH ROW WHEN (NEW.status = 'complete' AND OLD.status = 'capturing')
  EXECUTE FUNCTION calculation_capture_complete_guard();

-- ---------------------------------------------------------------- Статус у источника (после X-01)

-- Закрытие, повторное открытие и замена ревизии у источника — события, запись ревизии не меняется.
-- Бывают только у ревизии источника (verified); повтор того же статуса подряд не пишется.
CREATE TABLE calculation_revision_status_event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id       uuid NOT NULL REFERENCES calculation_revision (id),
  seq               integer NOT NULL CHECK (seq > 0),
  status            text NOT NULL CHECK (status IN ('closed_at_source', 'reopened_at_source', 'superseded_at_source')),
  observed_at       timestamptz NOT NULL,
  source_raw_sha256 text NOT NULL REFERENCES blob (sha256),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calculation_revision_status_event_seq_key UNIQUE (revision_id, seq)
);

CREATE FUNCTION calculation_revision_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_prev calculation_revision_status_event%ROWTYPE;
BEGIN
  SELECT kind INTO v_kind FROM calculation_revision WHERE id = NEW.revision_id;
  IF v_kind IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'calculation_revision_status_event: статус у источника бывает только у ревизии verified (X-01)' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_prev FROM calculation_revision_status_event WHERE revision_id = NEW.revision_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_prev.seq, 0) + 1 THEN
    RAISE EXCEPTION 'calculation_revision_status_event: номер события — следующий по порядку' USING ERRCODE = '23514';
  END IF;
  IF v_prev.status = 'superseded_at_source' THEN
    RAISE EXCEPTION 'calculation_revision_status_event: ревизия заменена у источника, дальнейших статусов нет' USING ERRCODE = '23514';
  END IF;
  IF v_prev.status IS NOT DISTINCT FROM NEW.status
     OR (NEW.status = 'reopened_at_source' AND v_prev.status IS DISTINCT FROM 'closed_at_source') THEN
    RAISE EXCEPTION 'calculation_revision_status_event: недопустимый переход % → %', coalesce(v_prev.status, '—'), NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_revision_status_guard BEFORE INSERT ON calculation_revision_status_event
  FOR EACH ROW EXECUTE FUNCTION calculation_revision_status_guard();
CREATE TRIGGER calculation_revision_status_append_only BEFORE UPDATE OR DELETE ON calculation_revision_status_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER calculation_revision_status_no_truncate BEFORE TRUNCATE ON calculation_revision_status_event
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- ---------------------------------------------------------------- Lineage позиций

-- Хранение сопоставлений позиций между ревизиями (A22: разделение и слияние — несколько строк).
-- Автоматическое предложение и экономический разбор — этап 10; решение человека — method = manual.
CREATE TABLE position_lineage (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Порядок записи: решения одной транзакции имеют одно время created_at.
  seq                      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tender_id                uuid NOT NULL,
  from_revision_id         uuid NOT NULL,
  from_external_position_id uuid NOT NULL,
  to_revision_id           uuid NOT NULL,
  to_external_position_id  uuid NOT NULL,
  method                   text NOT NULL CHECK (method IN ('source_lineage', 'exact_key', 'manual')),
  confidence               numeric CHECK (confidence >= 0 AND confidence <= 1),
  status                   text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  decided_by               uuid REFERENCES app_user (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT position_lineage_from_fk FOREIGN KEY (from_revision_id, tender_id) REFERENCES calculation_revision (id, tender_id),
  CONSTRAINT position_lineage_to_fk FOREIGN KEY (to_revision_id, tender_id) REFERENCES calculation_revision (id, tender_id),
  CONSTRAINT position_lineage_distinct CHECK (from_revision_id <> to_revision_id),
  CONSTRAINT position_lineage_decision_shape CHECK ((status = 'proposed') = (decided_by IS NULL)),
  CONSTRAINT position_lineage_manual_shape CHECK (method <> 'manual' OR status <> 'proposed')
);
CREATE INDEX position_lineage_to_idx ON position_lineage (to_revision_id, seq);

-- Позиции сопоставления существуют в содержимом своих ревизий.
CREATE FUNCTION position_lineage_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM calculation_revision r JOIN calculation_position p ON p.content_id = r.content_id
        WHERE r.id = NEW.from_revision_id AND p.external_position_id = NEW.from_external_position_id) THEN
    RAISE EXCEPTION 'position_lineage: позиции % нет в ревизии-источнике', NEW.from_external_position_id USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM calculation_revision r JOIN calculation_position p ON p.content_id = r.content_id
        WHERE r.id = NEW.to_revision_id AND p.external_position_id = NEW.to_external_position_id) THEN
    RAISE EXCEPTION 'position_lineage: позиции % нет в ревизии-приёмнике', NEW.to_external_position_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER position_lineage_guard BEFORE INSERT ON position_lineage
  FOR EACH ROW EXECUTE FUNCTION position_lineage_guard();
CREATE TRIGGER position_lineage_append_only BEFORE UPDATE OR DELETE ON position_lineage
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('append-only');
CREATE TRIGGER position_lineage_no_truncate BEFORE TRUNCATE ON position_lineage
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('append-only');

-- ---------------------------------------------------------------- Статус интеграции

-- Ревизия TenderHub по ID, состояние закрытия и лента изменений зависят от внешней доработки X-01.
INSERT INTO integration_status (system, component, status, details)
VALUES ('tenderhub', 'TenderHubRevisionReader', 'BLOCKED_EXTERNAL', '{"blockedBy": "X-01"}'::jsonb)
ON CONFLICT (system, component) DO NOTHING;

-- ---------------------------------------------------------------- Права ролей

-- mutable / frozen-after: без DELETE (удаление запрещают и триггеры).
GRANT SELECT, INSERT, UPDATE ON stage_calculation_source, calculation_capture TO kontur_app;
-- immutable / append-only: только чтение и вставка.
GRANT SELECT, INSERT ON external_ref, calculation_content, calculation_position, calculation_line, calculation_revision,
  calculation_revision_status_event, position_lineage TO kontur_app;
GRANT SELECT ON stage_calculation_source, external_ref, calculation_capture, calculation_content, calculation_position,
  calculation_line, calculation_revision, calculation_revision_status_event, position_lineage TO kontur_backup;
