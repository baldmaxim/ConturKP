-- Этап 10: экономика и сравнение ревизий расчёта (D-030; проект — docs/architecture/10-economics-design.md §2, §9).
-- Исходные данные расчёта не меняются: отчёт ревизии, десятичный пересчёт строк и сравнение хранятся отдельно и после
-- записи неизменны. Суммы отчёта и сравнения сверяются здесь второй линией с содержимым ревизий (точное numeric).
-- Пары позиций: система подтверждает только source_lineage в одном экземпляре TenderHub, тендере и версии (D-030
-- «Дополнение»); ключи дают предложения. Причины изменений — версии с автором-человеком; модель только предлагает.
-- Принятые миграции не меняются (ADR-002).

-- ---------------------------------------------------------------- Экземпляр TenderHub у выгрузки (D-030 «Дополнение»)

-- source_instance_id — стабильный идентификатор экземпляра из конфигурации worker (TENDERHUB_INSTANCE_ID); source_origin —
-- адрес подключения, для идентичности не используется. Пишутся при завершении выгрузки; у выгрузок до этапа 10 — NULL.
ALTER TABLE calculation_capture
  ADD COLUMN source_instance_id text CHECK (source_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  ADD COLUMN source_origin text CHECK (length(source_origin) BETWEEN 1 AND 300);

CREATE OR REPLACE FUNCTION calculation_capture_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'capturing' OR NEW.row_version <> 1 OR jsonb_array_length(NEW.attempts) <> 0 THEN
      RAISE EXCEPTION 'calculation_capture: выгрузка создаётся в состоянии capturing без попыток' USING ERRCODE = '23514';
    END IF;
    IF NEW.source_instance_id IS NOT NULL OR NEW.source_origin IS NOT NULL THEN
      RAISE EXCEPTION 'calculation_capture: экземпляр источника записывает завершение выгрузки' USING ERRCODE = '23514';
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
  IF (NEW.source_instance_id IS DISTINCT FROM OLD.source_instance_id OR NEW.source_origin IS DISTINCT FROM OLD.source_origin)
     AND NEW.status <> 'complete' THEN
    RAISE EXCEPTION 'calculation_capture: экземпляр источника записывается только при завершении выгрузки' USING ERRCODE = '55000';
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

-- ---------------------------------------------------------------- Права (Р-08-8: таблица ролей повторяет core)

-- Этап 10: сравнение ревизий и подтверждение причин изменений — участник тендера.
CREATE OR REPLACE FUNCTION tender_capabilities(p_user uuid, p_tender uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_admin boolean;
  v_role  text;
  v_caps  text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = p_user AND kind = 'human' AND status = 'active') THEN
    RETURN v_caps;
  END IF;
  v_admin := EXISTS (SELECT 1 FROM user_role WHERE user_id = p_user AND role = 'admin');
  SELECT m.member_role INTO v_role
    FROM tender_member m
   WHERE m.tender_id = p_tender AND m.user_id = p_user AND m.removed_at IS NULL
     AND EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = p_user AND r.role = m.member_role);
  IF v_role IS NOT NULL THEN
    v_caps := v_caps || ARRAY['tender.read', 'stage.write', 'source.write', 'calculation.capture',
                              'requirement.read', 'requirement.create', 'analysis.run', 'fact.read', 'fact.create',
                              'review.run', 'finding.write', 'economics.compare', 'change_reason.confirm'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm',
                              'finding.accept_risk', 'source_priority.manage'];
  END IF;
  IF v_role = 'manager' OR v_admin THEN
    v_caps := v_caps || ARRAY['audit.read'];
  END IF;
  IF v_admin THEN
    v_caps := v_caps || ARRAY['admin.tender'];
  END IF;
  RETURN v_caps;
END;
$$;

-- ---------------------------------------------------------------- Сопоставление позиций (D-030 В-10-5, «Дополнение»)

ALTER TABLE position_lineage DROP CONSTRAINT position_lineage_method_check;
ALTER TABLE position_lineage
  ADD CONSTRAINT position_lineage_method_check CHECK (method IN ('source_lineage', 'exact_key', 'position_key', 'manual'));

-- Служебный пользователь правила source_lineage: войти не может (пароля нет), в списках людей не показывается.
INSERT INTO app_user (kind, service_kind, login, display_name)
VALUES ('service', 'system', 'system.lineage', 'Правило source_lineage (D-030)')
ON CONFLICT (login) DO NOTHING;

-- Ревизии одного экземпляра TenderHub, тендера и версии: идентификатор экземпляра у выгрузок обеих ревизий задан и
-- совпадает, тендер TenderHub один, наблюдённая версия известна и одинакова.
CREATE FUNCTION calculation_revisions_same_source(p_left uuid, p_right uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM calculation_revision a JOIN calculation_capture ca ON ca.id = a.capture_id,
           calculation_revision b JOIN calculation_capture cb ON cb.id = b.capture_id
     WHERE a.id = p_left AND b.id = p_right AND a.tender_id = b.tender_id
       AND ca.source_instance_id IS NOT NULL AND ca.source_instance_id = cb.source_instance_id
       AND a.external_tender_id = b.external_tender_id
       AND ca.source_observed ->> 'version' IS NOT NULL AND ca.source_observed ->> 'version' = cb.source_observed ->> 'version')
$$;

-- Автор решения: человек с calculation.capture; служебный пользователь — только подтверждение source_lineage при
-- совпадении экземпляра, тендера, версии и UUID позиции и строгом соответствии один к одному.
CREATE FUNCTION position_lineage_author_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_user app_user%ROWTYPE;
BEGIN
  IF NEW.decided_by IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_user FROM app_user WHERE id = NEW.decided_by;
  IF v_user.kind = 'service' AND v_user.service_kind = 'system' AND v_user.login = 'system.lineage' THEN
    IF NEW.method <> 'source_lineage' OR NEW.status <> 'confirmed' OR NEW.from_external_position_id <> NEW.to_external_position_id
       OR NOT calculation_revisions_same_source(NEW.from_revision_id, NEW.to_revision_id) THEN
      RAISE EXCEPTION 'position_lineage: система подтверждает только source_lineage одного экземпляра, тендера и версии с тем же UUID' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM position_lineage x
                WHERE x.from_revision_id = NEW.from_revision_id AND x.to_revision_id = NEW.to_revision_id
                  AND (x.from_external_position_id = NEW.from_external_position_id OR x.to_external_position_id = NEW.to_external_position_id)
                  AND NOT (x.status = 'proposed' AND x.from_external_position_id = NEW.from_external_position_id
                           AND x.to_external_position_id = NEW.to_external_position_id)) THEN
      RAISE EXCEPTION 'position_lineage: по позиции уже есть решение — автоподтверждение не один к одному' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ('calculation.capture' = ANY (tender_capabilities(NEW.decided_by, NEW.tender_id))) THEN
    RAISE EXCEPTION 'position_lineage: решение по сопоставлению принимает участник тендера' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER position_lineage_author_guard BEFORE INSERT ON position_lineage FOR EACH ROW EXECUTE FUNCTION position_lineage_author_guard();

CREATE INDEX position_lineage_pair_idx ON position_lineage (from_revision_id, to_revision_id, seq);

-- ---------------------------------------------------------------- Отчёт ревизии (проект §5.5, §5.9)

CREATE TABLE revision_economics (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id             uuid NOT NULL REFERENCES tender (id),
  revision_id           uuid NOT NULL,
  method_version        text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 60),
  cost_total            numeric NOT NULL,
  commercial_total      numeric NOT NULL,
  grand_total           numeric,
  residual              numeric,
  tolerance             numeric NOT NULL CHECK (tolerance >= 0),
  reconciliation_status text NOT NULL CHECK (reconciliation_status IN ('reconciled', 'residual_unconfirmed', 'no_target')),
  line_tolerance_rel    numeric NOT NULL CHECK (line_tolerance_rel >= 0),
  line_tolerance_abs    numeric NOT NULL CHECK (line_tolerance_abs >= 0),
  report                jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_by            uuid REFERENCES app_user (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_xact          xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT revision_economics_revision_fk FOREIGN KEY (revision_id, tender_id) REFERENCES calculation_revision (id, tender_id),
  CONSTRAINT revision_economics_key UNIQUE (revision_id, method_version),
  CONSTRAINT revision_economics_target_shape CHECK ((grand_total IS NULL) = (reconciliation_status = 'no_target') AND (residual IS NULL) = (grand_total IS NULL)),
  CONSTRAINT revision_economics_status_shape CHECK (
    reconciliation_status = 'no_target'
    OR (reconciliation_status = 'reconciled' AND abs(residual) <= tolerance)
    OR (reconciliation_status = 'residual_unconfirmed' AND abs(residual) > tolerance))
);

-- Суммы отчёта сверяются с содержимым ревизии: себестоимость — Σ total_amount, коммерческая часть — Σ колонок строк с
-- непустой коммерческой стоимостью, цель — cached_grand_total ревизии, остаток — цель − ROUND(Σ, 2).
CREATE FUNCTION revision_economics_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_content uuid;
  v_grand   numeric;
  v_cost    numeric;
  v_comm    numeric;
BEGIN
  SELECT r.content_id, c.source_grand_total INTO v_content, v_grand
    FROM calculation_revision r JOIN calculation_content c ON c.id = r.content_id WHERE r.id = NEW.revision_id;
  SELECT coalesce(sum(l.total_amount), 0),
         coalesce(sum(coalesce(l.total_commercial_material, 0) + coalesce(l.total_commercial_work, 0))
                    FILTER (WHERE l.total_commercial_material IS NOT NULL OR l.total_commercial_work IS NOT NULL), 0)
    INTO v_cost, v_comm
    FROM calculation_line l WHERE l.content_id = v_content;
  IF NEW.cost_total <> v_cost OR NEW.commercial_total <> v_comm OR NEW.grand_total IS DISTINCT FROM v_grand
     OR NEW.residual IS DISTINCT FROM (v_grand - round(v_comm, 2)) THEN
    RAISE EXCEPTION 'revision_economics: суммы отчёта не совпадают с содержимым ревизии' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_economics_guard BEFORE INSERT ON revision_economics FOR EACH ROW EXECUTE FUNCTION revision_economics_guard();
CREATE TRIGGER revision_economics_immutable BEFORE UPDATE OR DELETE ON revision_economics FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER revision_economics_no_truncate BEFORE TRUNCATE ON revision_economics FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Десятичный пересчёт строки — отдельно от исходных данных (D-030 п. 7); выведенное количество привязанного материала —
-- диагностика (п. 4); отклонения от ограничений источника — флагами (§5.9).
CREATE TABLE revision_line_check (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  economics_id     uuid NOT NULL REFERENCES revision_economics (id),
  external_item_id uuid NOT NULL,
  formula          text NOT NULL CHECK (formula IN ('work', 'material', 'not_applicable')),
  recomputed_cost  numeric,
  deviation        numeric,
  within_tolerance boolean,
  derived_quantity numeric,
  flags            text[] NOT NULL DEFAULT '{}' CHECK (flags <@ ARRAY['quantity_nonpositive', 'negative_amount', 'unknown_item_type', 'missing_commercial',
                                                                  'missing_fx_rate', 'bound_quantity_mismatch', 'recompute_outside_tolerance']),
  CONSTRAINT revision_line_check_key UNIQUE (economics_id, external_item_id),
  CONSTRAINT revision_line_check_shape CHECK (
    (formula <> 'not_applicable' OR recomputed_cost IS NULL)
    AND (recomputed_cost IS NOT NULL OR (deviation IS NULL AND within_tolerance IS NULL))
    AND ((within_tolerance = false) = ('recompute_outside_tolerance' = ANY (flags))))
);
CREATE FUNCTION revision_line_check_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_econ  revision_economics%ROWTYPE;
  v_total numeric;
  v_found boolean;
BEGIN
  SELECT * INTO v_econ FROM revision_economics WHERE id = NEW.economics_id;
  IF v_econ.created_xact IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'revision_line_check: пересчёт пишется вместе с отчётом ревизии' USING ERRCODE = '55000';
  END IF;
  SELECT true, l.total_amount INTO v_found, v_total
    FROM calculation_revision r JOIN calculation_line l ON l.content_id = r.content_id
   WHERE r.id = v_econ.revision_id AND l.external_item_id = NEW.external_item_id;
  IF v_found IS NULL THEN
    RAISE EXCEPTION 'revision_line_check: строки % нет в ревизии', NEW.external_item_id USING ERRCODE = '23514';
  END IF;
  IF NEW.recomputed_cost IS NOT NULL AND v_total IS NOT NULL AND NEW.deviation IS DISTINCT FROM (v_total - NEW.recomputed_cost) THEN
    RAISE EXCEPTION 'revision_line_check: отклонение — полученное минус пересчитанное' USING ERRCODE = '23514';
  END IF;
  IF NEW.within_tolerance IS NOT NULL AND NEW.within_tolerance <> (abs(NEW.deviation) <= greatest(abs(NEW.recomputed_cost) * v_econ.line_tolerance_rel, v_econ.line_tolerance_abs)) THEN
    RAISE EXCEPTION 'revision_line_check: признак допуска не соответствует допуску отчёта' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_line_check_guard BEFORE INSERT ON revision_line_check FOR EACH ROW EXECUTE FUNCTION revision_line_check_guard();
CREATE TRIGGER revision_line_check_immutable BEFORE UPDATE OR DELETE ON revision_line_check FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER revision_line_check_no_truncate BEFORE TRUNCATE ON revision_line_check FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Отчёт ревизии — с пересчётом каждой строки (проверка в конце транзакции).
CREATE FUNCTION revision_economics_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM revision_line_check WHERE economics_id = NEW.id)
     <> (SELECT c.lines_count FROM calculation_revision r JOIN calculation_content c ON c.id = r.content_id WHERE r.id = NEW.revision_id) THEN
    RAISE EXCEPTION 'revision_economics: отчёт записывается с пересчётом каждой строки ревизии' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER revision_economics_complete AFTER INSERT ON revision_economics
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION revision_economics_complete();

-- ---------------------------------------------------------------- Сравнение ревизий (проект §5.1–5.4)

CREATE TABLE calculation_comparison (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id            uuid NOT NULL REFERENCES tender (id),
  stage_id             uuid NOT NULL,
  left_revision_id     uuid NOT NULL,
  right_revision_id    uuid NOT NULL,
  method_version       text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 60),
  decomposition_method text NOT NULL CHECK (decomposition_method = 'chain_substitution'),
  method_description   jsonb NOT NULL CHECK (jsonb_typeof(method_description) = 'object'),
  tolerance            numeric NOT NULL CHECK (tolerance >= 0),
  lineage_seq          bigint NOT NULL CHECK (lineage_seq >= 0),
  status               text NOT NULL DEFAULT 'computing' CHECK (status IN ('computing', 'ready', 'failed')),
  failure_reason       text CHECK (length(failure_reason) BETWEEN 1 AND 1000),
  totals               jsonb CHECK (totals IS NULL OR jsonb_typeof(totals) = 'object'),
  result_sha256        text CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by         uuid NOT NULL REFERENCES app_user (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  created_xact         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT calculation_comparison_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT calculation_comparison_left_fk FOREIGN KEY (left_revision_id, tender_id) REFERENCES calculation_revision (id, tender_id),
  CONSTRAINT calculation_comparison_right_fk FOREIGN KEY (right_revision_id, tender_id) REFERENCES calculation_revision (id, tender_id),
  CONSTRAINT calculation_comparison_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT calculation_comparison_distinct CHECK (left_revision_id <> right_revision_id),
  CONSTRAINT calculation_comparison_ready_shape CHECK ((status = 'ready') = (result_sha256 IS NOT NULL AND totals IS NOT NULL)),
  CONSTRAINT calculation_comparison_failed_shape CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT calculation_comparison_finished_shape CHECK ((status = 'computing') = (finished_at IS NULL))
);
CREATE INDEX calculation_comparison_stage_idx ON calculation_comparison (stage_id, created_at DESC);

CREATE FUNCTION lineage_pair_seq(p_left uuid, p_right uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(max(seq), 0) FROM position_lineage WHERE from_revision_id = p_left AND to_revision_id = p_right
$$;

CREATE FUNCTION calculation_comparison_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'computing' THEN
    RAISE EXCEPTION 'calculation_comparison: сравнение создаётся в состоянии computing' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.requested_by, NEW.stage_id, 'economics.compare') THEN
    RAISE EXCEPTION 'calculation_comparison: сравнение запускает участник тендера с economics.compare' USING ERRCODE = '42501';
  END IF;
  IF NEW.lineage_seq <> lineage_pair_seq(NEW.left_revision_id, NEW.right_revision_id) THEN
    RAISE EXCEPTION 'calculation_comparison: закреплённое сопоставление — текущее по паре ревизий' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_comparison_insert_guard BEFORE INSERT ON calculation_comparison FOR EACH ROW EXECUTE FUNCTION calculation_comparison_insert_guard();

-- Сравнение считается одной транзакцией: computing → ready | failed только в транзакции создания; затем неизменно.
CREATE FUNCTION calculation_comparison_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'computing' THEN
    RAISE EXCEPTION 'calculation_comparison (frozen-after): сравнение % завершено и неизменно', OLD.id USING ERRCODE = '55000';
  END IF;
  IF OLD.created_xact IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'calculation_comparison: сравнение завершается в транзакции создания' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.left_revision_id, NEW.right_revision_id, NEW.method_version, NEW.decomposition_method,
      NEW.method_description, NEW.tolerance, NEW.lineage_seq, NEW.requested_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.left_revision_id, OLD.right_revision_id, OLD.method_version, OLD.decomposition_method,
      OLD.method_description, OLD.tolerance, OLD.lineage_seq, OLD.requested_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'calculation_comparison: закреплённые поля сравнения неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.status NOT IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'calculation_comparison: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calculation_comparison_update_guard BEFORE UPDATE ON calculation_comparison FOR EACH ROW EXECUTE FUNCTION calculation_comparison_update_guard();
CREATE TRIGGER calculation_comparison_no_delete BEFORE DELETE ON calculation_comparison FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER calculation_comparison_no_truncate BEFORE TRUNCATE ON calculation_comparison FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

CREATE TABLE comparison_unit (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id          uuid NOT NULL REFERENCES calculation_comparison (id),
  unit_no                int NOT NULL CHECK (unit_no > 0),
  kind                   text NOT NULL CHECK (kind IN ('matched', 'added', 'removed', 'split_merge')),
  left_positions         uuid[] NOT NULL,
  right_positions        uuid[] NOT NULL,
  lineage_ids            uuid[] NOT NULL DEFAULT '{}',
  title                  text NOT NULL CHECK (length(title) BETWEEN 1 AND 2000),
  unit_code              text,
  cost_left              numeric,
  cost_right             numeric,
  cost_comparable        boolean NOT NULL,
  cost_reason            text CHECK (length(cost_reason) BETWEEN 1 AND 500),
  commercial_left        numeric,
  commercial_right       numeric,
  commercial_comparable  boolean NOT NULL,
  commercial_reason      text CHECK (length(commercial_reason) BETWEEN 1 AND 500),
  material_column_delta  numeric,
  work_column_delta      numeric,
  column_shift           boolean NOT NULL DEFAULT false,
  CONSTRAINT comparison_unit_no_key UNIQUE (comparison_id, unit_no),
  CONSTRAINT comparison_unit_id_comparison_key UNIQUE (id, comparison_id),
  CONSTRAINT comparison_unit_sides_shape CHECK (
    cardinality(left_positions) + cardinality(right_positions) > 0
    AND (kind <> 'added' OR (cardinality(left_positions) = 0 AND cardinality(right_positions) > 0))
    AND (kind <> 'removed' OR (cardinality(right_positions) = 0 AND cardinality(left_positions) > 0))
    AND (kind <> 'matched' OR (cardinality(left_positions) = 1 AND cardinality(right_positions) = 1))),
  CONSTRAINT comparison_unit_comparable_shape CHECK (
    (cost_comparable = (cost_reason IS NULL)) AND (commercial_comparable = (commercial_reason IS NULL))
    AND (NOT cost_comparable OR (cost_left IS NOT NULL AND cost_right IS NOT NULL))
    AND (NOT commercial_comparable OR (commercial_left IS NOT NULL AND commercial_right IS NOT NULL)))
);

CREATE TABLE comparison_effect (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id uuid NOT NULL REFERENCES calculation_comparison (id),
  unit_id       uuid,
  measure       text NOT NULL CHECK (measure IN ('cost', 'commercial')),
  component     text NOT NULL CHECK (component IN ('volume', 'unit_rate', 'currency_change', 'fx_rate', 'delivery', 'coefficient', 'source_tail',
                                                   'composition_added', 'composition_removed', 'composition_changed', 'not_decomposable',
                                                   'incomparable_units', 'unexplained_remainder')),
  amount        numeric NOT NULL,
  line_refs     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(line_refs) = 'object'),
  CONSTRAINT comparison_effect_unit_fk FOREIGN KEY (unit_id, comparison_id) REFERENCES comparison_unit (id, comparison_id),
  -- Остаток и несопоставимые единицы — только уровень тендера; вклады — только у единицы.
  CONSTRAINT comparison_effect_level_shape CHECK ((unit_id IS NULL) = (component IN ('incomparable_units', 'unexplained_remainder')))
);
CREATE INDEX comparison_effect_comparison_idx ON comparison_effect (comparison_id, unit_id);

-- Единицы и вклады пишет только транзакция, создавшая сравнение, пока оно computing.
CREATE FUNCTION comparison_part_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM calculation_comparison c
                  WHERE c.id = NEW.comparison_id AND c.status = 'computing' AND c.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION '%: части сравнения пишет транзакция его создания', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER comparison_unit_guard BEFORE INSERT ON comparison_unit FOR EACH ROW EXECUTE FUNCTION comparison_part_guard();
CREATE TRIGGER comparison_unit_immutable BEFORE UPDATE OR DELETE ON comparison_unit FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER comparison_unit_no_truncate BEFORE TRUNCATE ON comparison_unit FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER comparison_effect_guard BEFORE INSERT ON comparison_effect FOR EACH ROW EXECUTE FUNCTION comparison_part_guard();
CREATE TRIGGER comparison_effect_immutable BEFORE UPDATE OR DELETE ON comparison_effect FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER comparison_effect_no_truncate BEFORE TRUNCATE ON comparison_effect FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Участвующие позиции ревизии: все, кроме разделов без строк.
CREATE FUNCTION comparison_positions(p_revision uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT p.external_position_id
    FROM calculation_revision r JOIN calculation_position p ON p.content_id = r.content_id
   WHERE r.id = p_revision
     AND (NOT p.is_section OR EXISTS (SELECT 1 FROM calculation_line l WHERE l.content_id = p.content_id AND l.external_position_id = p.external_position_id))
$$;

-- Итог сравнения (вторая линия, I11): каждая участвующая позиция — ровно в одной единице; суммы единиц — по строкам
-- ревизий; Σ вкладов единицы = её дельта; Σ всех вкладов меры = дельта итога; на уровне тендера ровно по одной строке
-- «несопоставимые единицы» и «остаток» на меру. Проверяется при переводе в ready.
CREATE FUNCTION calculation_comparison_final_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cmp      calculation_comparison%ROWTYPE;
  v_left_c   uuid;
  v_right_c  uuid;
  v_bad      int;
  v_measure  text;
  v_delta    numeric;
  v_target_l numeric;
  v_target_r numeric;
BEGIN
  SELECT * INTO v_cmp FROM calculation_comparison WHERE id = NEW.id;
  IF v_cmp.status <> 'ready' THEN
    RETURN NULL;
  END IF;
  SELECT content_id INTO v_left_c FROM calculation_revision WHERE id = v_cmp.left_revision_id;
  SELECT content_id INTO v_right_c FROM calculation_revision WHERE id = v_cmp.right_revision_id;
  -- Покрытие позиций.
  IF (SELECT count(*) FROM (SELECT unnest(left_positions) FROM comparison_unit WHERE comparison_id = NEW.id) u) <> (SELECT count(*) FROM comparison_positions(v_cmp.left_revision_id))
     OR (SELECT count(DISTINCT x) FROM (SELECT unnest(left_positions) AS x FROM comparison_unit WHERE comparison_id = NEW.id) u) <> (SELECT count(*) FROM comparison_positions(v_cmp.left_revision_id))
     OR EXISTS (SELECT 1 FROM (SELECT unnest(left_positions) AS x FROM comparison_unit WHERE comparison_id = NEW.id) u
                 WHERE u.x NOT IN (SELECT comparison_positions(v_cmp.left_revision_id)))
     OR (SELECT count(*) FROM (SELECT unnest(right_positions) FROM comparison_unit WHERE comparison_id = NEW.id) u) <> (SELECT count(*) FROM comparison_positions(v_cmp.right_revision_id))
     OR (SELECT count(DISTINCT x) FROM (SELECT unnest(right_positions) AS x FROM comparison_unit WHERE comparison_id = NEW.id) u) <> (SELECT count(*) FROM comparison_positions(v_cmp.right_revision_id))
     OR EXISTS (SELECT 1 FROM (SELECT unnest(right_positions) AS x FROM comparison_unit WHERE comparison_id = NEW.id) u
                 WHERE u.x NOT IN (SELECT comparison_positions(v_cmp.right_revision_id))) THEN
    RAISE EXCEPTION 'calculation_comparison: каждая позиция обеих ревизий входит ровно в одну единицу' USING ERRCODE = '23514';
  END IF;
  -- Суммы единиц — по строкам ревизий.
  SELECT count(*) INTO v_bad
    FROM comparison_unit u
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(l.total_amount), 0) AS cost,
             coalesce(sum(coalesce(l.total_commercial_material, 0) + coalesce(l.total_commercial_work, 0))
                        FILTER (WHERE l.total_commercial_material IS NOT NULL OR l.total_commercial_work IS NOT NULL), 0) AS comm
        FROM calculation_line l WHERE l.content_id = v_left_c AND l.external_position_id = ANY (u.left_positions)) a
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(l.total_amount), 0) AS cost,
             coalesce(sum(coalesce(l.total_commercial_material, 0) + coalesce(l.total_commercial_work, 0))
                        FILTER (WHERE l.total_commercial_material IS NOT NULL OR l.total_commercial_work IS NOT NULL), 0) AS comm
        FROM calculation_line l WHERE l.content_id = v_right_c AND l.external_position_id = ANY (u.right_positions)) b
   WHERE u.comparison_id = NEW.id
     AND (u.cost_left IS DISTINCT FROM a.cost OR u.cost_right IS DISTINCT FROM b.cost
          OR u.commercial_left IS DISTINCT FROM a.comm OR u.commercial_right IS DISTINCT FROM b.comm);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'calculation_comparison: суммы единиц не совпадают со строками ревизий' USING ERRCODE = '23514';
  END IF;
  -- Σ вкладов сопоставимой единицы = её дельта; у несопоставимой единицы вкладов меры нет.
  SELECT count(*) INTO v_bad
    FROM comparison_unit u
    CROSS JOIN LATERAL (SELECT coalesce(sum(e.amount) FILTER (WHERE e.measure = 'cost'), 0) AS cost,
                               coalesce(sum(e.amount) FILTER (WHERE e.measure = 'commercial'), 0) AS comm,
                               count(*) FILTER (WHERE e.measure = 'cost') AS n_cost,
                               count(*) FILTER (WHERE e.measure = 'commercial') AS n_comm
                          FROM comparison_effect e WHERE e.unit_id = u.id) s
   WHERE u.comparison_id = NEW.id
     AND ((u.cost_comparable AND s.cost <> u.cost_right - u.cost_left) OR (NOT u.cost_comparable AND s.n_cost > 0)
          OR (u.commercial_comparable AND s.comm <> u.commercial_right - u.commercial_left) OR (NOT u.commercial_comparable AND s.n_comm > 0));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'calculation_comparison: Σ вкладов единицы не равна её дельте' USING ERRCODE = '23514';
  END IF;
  -- Уровень тендера.
  FOREACH v_measure IN ARRAY ARRAY['cost', 'commercial'] LOOP
    IF (SELECT count(*) FROM comparison_effect WHERE comparison_id = NEW.id AND unit_id IS NULL AND measure = v_measure AND component = 'unexplained_remainder') <> 1
       OR (SELECT count(*) FROM comparison_effect WHERE comparison_id = NEW.id AND unit_id IS NULL AND measure = v_measure AND component = 'incomparable_units') <> 1 THEN
      RAISE EXCEPTION 'calculation_comparison: на уровне тендера ровно одна строка остатка и одна строка несопоставимых единиц на меру' USING ERRCODE = '23514';
    END IF;
    IF v_measure = 'cost' THEN
      SELECT coalesce(sum(total_amount), 0) INTO v_target_l FROM calculation_line WHERE content_id = v_left_c;
      SELECT coalesce(sum(total_amount), 0) INTO v_target_r FROM calculation_line WHERE content_id = v_right_c;
    ELSE
      SELECT c.source_grand_total INTO v_target_l FROM calculation_content c WHERE c.id = v_left_c;
      SELECT c.source_grand_total INTO v_target_r FROM calculation_content c WHERE c.id = v_right_c;
      IF v_target_l IS NULL OR v_target_r IS NULL THEN
        SELECT coalesce(sum(coalesce(total_commercial_material, 0) + coalesce(total_commercial_work, 0))
                          FILTER (WHERE total_commercial_material IS NOT NULL OR total_commercial_work IS NOT NULL), 0)
          INTO v_target_l FROM calculation_line WHERE content_id = v_left_c;
        SELECT coalesce(sum(coalesce(total_commercial_material, 0) + coalesce(total_commercial_work, 0))
                          FILTER (WHERE total_commercial_material IS NOT NULL OR total_commercial_work IS NOT NULL), 0)
          INTO v_target_r FROM calculation_line WHERE content_id = v_right_c;
      END IF;
    END IF;
    SELECT coalesce(sum(amount), 0) INTO v_delta FROM comparison_effect WHERE comparison_id = NEW.id AND measure = v_measure;
    IF v_delta <> v_target_r - v_target_l
       OR (v_cmp.totals -> v_measure ->> 'delta')::numeric IS DISTINCT FROM (v_target_r - v_target_l)
       OR (v_cmp.totals -> v_measure ->> 'left')::numeric IS DISTINCT FROM v_target_l
       OR (v_cmp.totals -> v_measure ->> 'right')::numeric IS DISTINCT FROM v_target_r THEN
      RAISE EXCEPTION 'calculation_comparison: Σ вкладов меры % не равна дельте итога', v_measure USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER calculation_comparison_final_check AFTER UPDATE ON calculation_comparison
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calculation_comparison_final_check();

-- ---------------------------------------------------------------- Причины изменений (проект §5.8; I11, A23)

-- Необработанные события этапа: пока они есть, актуальность оснований не установлена (как в 0025, R09-01).
CREATE TABLE change_explanation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid NOT NULL REFERENCES tender (id),
  comparison_id uuid NOT NULL,
  unit_id       uuid NOT NULL,
  version       int NOT NULL CHECK (version > 0),
  reason_kind   text NOT NULL CHECK (reason_kind IN ('document', 'answer', 'supplier', 'internal_decision', 'unknown')),
  reason_status text NOT NULL CHECK (reason_status IN ('unknown', 'hypothesis', 'confirmed')),
  rationale     text CHECK (length(rationale) BETWEEN 1 AND 4000),
  suggestion_id uuid,
  actor_user_id uuid NOT NULL REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_xact  xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT change_explanation_comparison_fk FOREIGN KEY (comparison_id, tender_id) REFERENCES calculation_comparison (id, tender_id),
  CONSTRAINT change_explanation_unit_fk FOREIGN KEY (unit_id, comparison_id) REFERENCES comparison_unit (id, comparison_id),
  CONSTRAINT change_explanation_version_key UNIQUE (unit_id, version),
  CONSTRAINT change_explanation_kind_shape CHECK ((reason_kind = 'unknown') = (reason_status = 'unknown') AND (reason_status = 'unknown' OR rationale IS NOT NULL))
);
CREATE FUNCTION change_explanation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cmp calculation_comparison%ROWTYPE;
BEGIN
  SELECT * INTO v_cmp FROM calculation_comparison WHERE id = NEW.comparison_id;
  IF v_cmp.status <> 'ready' THEN
    RAISE EXCEPTION 'change_explanation: причина ставится по готовому сравнению' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.actor_user_id, v_cmp.stage_id, 'change_reason.confirm') THEN
    RAISE EXCEPTION 'change_explanation: причину ставит участник тендера с change_reason.confirm' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> (SELECT coalesce(max(version), 0) + 1 FROM change_explanation WHERE unit_id = NEW.unit_id) THEN
    RAISE EXCEPTION 'change_explanation: версия — следующая по единице' USING ERRCODE = '23514';
  END IF;
  IF NEW.reason_status = 'confirmed' AND stage_events_pending(v_cmp.stage_id) THEN
    RAISE EXCEPTION 'change_explanation: есть необработанные события этапа — актуальность оснований не установлена' USING ERRCODE = '23514';
  END IF;
  IF NEW.suggestion_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM change_reason_suggestion s WHERE s.id = NEW.suggestion_id AND s.unit_id = NEW.unit_id AND s.status = 'open') THEN
    RAISE EXCEPTION 'change_explanation: гипотеза — открытая гипотеза этой единицы' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE change_explanation_basis (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  explanation_id uuid NOT NULL REFERENCES change_explanation (id),
  tender_id      uuid NOT NULL REFERENCES tender (id),
  basis_type     text NOT NULL CHECK (basis_type IN ('fragment', 'decision')),
  fragment_id    uuid REFERENCES evidence_fragment (id),
  decision_id    uuid REFERENCES decision (id),
  CONSTRAINT change_explanation_basis_shape CHECK (
    (basis_type = 'fragment') = (fragment_id IS NOT NULL) AND (basis_type = 'decision') = (decision_id IS NOT NULL)),
  CONSTRAINT change_explanation_basis_key UNIQUE (explanation_id, fragment_id, decision_id)
);
CREATE FUNCTION change_explanation_basis_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
BEGIN
  SELECT c.stage_id INTO v_stage FROM change_explanation e JOIN calculation_comparison c ON c.id = e.comparison_id
   WHERE e.id = NEW.explanation_id AND e.tender_id = NEW.tender_id AND e.created_xact = pg_current_xact_id();
  IF v_stage IS NULL THEN
    RAISE EXCEPTION 'change_explanation_basis: основания пишутся вместе с версией причины' USING ERRCODE = '55000';
  END IF;
  IF (NEW.fragment_id IS NOT NULL AND NOT fragment_in_stage(NEW.fragment_id, v_stage))
     OR (NEW.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.tender_id = NEW.tender_id)) THEN
    RAISE EXCEPTION 'change_explanation_basis: основание вне этапа или тендера сравнения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER change_explanation_basis_guard BEFORE INSERT ON change_explanation_basis FOR EACH ROW EXECUTE FUNCTION change_explanation_basis_guard();
CREATE TRIGGER change_explanation_basis_immutable BEFORE UPDATE OR DELETE ON change_explanation_basis FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER change_explanation_basis_no_truncate BEFORE TRUNCATE ON change_explanation_basis FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Основания по виду причины (в конце транзакции, когда основания записаны): документ, ответ и поставщик — хотя бы одно
-- основание-фрагмент подходящего происхождения; «неизвестно» — без оснований.
CREATE FUNCTION change_explanation_basis_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_origins text[];
BEGIN
  IF NEW.reason_status = 'unknown' THEN
    IF EXISTS (SELECT 1 FROM change_explanation_basis b WHERE b.explanation_id = NEW.id) THEN
      RAISE EXCEPTION 'change_explanation: у «неизвестно» оснований нет' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.reason_status = 'confirmed' AND NEW.reason_kind IN ('document', 'answer', 'supplier') THEN
    v_origins := CASE NEW.reason_kind
                   WHEN 'document' THEN ARRAY['document_text', 'recognized_text', 'attachment_text']
                   WHEN 'answer' THEN ARRAY['qa_answer', 'email_body', 'attachment_text']
                   ELSE ARRAY['document_text', 'recognized_text', 'attachment_text', 'email_body'] END;
    IF NOT EXISTS (SELECT 1 FROM change_explanation_basis b JOIN evidence_fragment f ON f.id = b.fragment_id
                    WHERE b.explanation_id = NEW.id AND f.origin = ANY (v_origins)) THEN
      RAISE EXCEPTION 'change_explanation: подтверждённая причина вида % — с основанием подходящего происхождения', NEW.reason_kind USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER change_explanation_basis_check AFTER INSERT ON change_explanation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION change_explanation_basis_check();

-- Прогон гипотез причин (как review_run): вход закрепляется при запуске; права запустившего перепроверяются кодом
-- перед моделью и каждой пачкой (R09-04).
CREATE TABLE reason_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id         uuid NOT NULL REFERENCES tender (id),
  stage_id          uuid NOT NULL,
  comparison_id     uuid NOT NULL,
  evidence_scope_id uuid NOT NULL,
  model_provider    text CHECK (length(model_provider) BETWEEN 1 AND 60),
  model_id          text CHECK (length(model_id) BETWEEN 1 AND 200),
  model_version     text CHECK (length(model_version) BETWEEN 1 AND 200),
  prompt_version    text CHECK (length(prompt_version) BETWEEN 1 AND 60),
  prompt_sha256     text CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'completed_with_gaps', 'failed')),
  coverage          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(coverage) = 'object'),
  failure_code      text CHECK (length(failure_code) BETWEEN 1 AND 60),
  requested_by      uuid NOT NULL REFERENCES app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  created_xact      xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT reason_run_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT reason_run_comparison_fk FOREIGN KEY (comparison_id, tender_id) REFERENCES calculation_comparison (id, tender_id),
  CONSTRAINT reason_run_scope_fk FOREIGN KEY (evidence_scope_id, tender_id) REFERENCES evidence_scope (id, tender_id),
  CONSTRAINT reason_run_model_shape CHECK (num_nulls(model_provider, model_id, model_version, prompt_version, prompt_sha256) IN (0, 5)),
  CONSTRAINT reason_run_finished_shape CHECK ((status IN ('completed', 'completed_with_gaps', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT reason_run_failure_shape CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX reason_run_comparison_idx ON reason_run (comparison_id, created_at DESC);

CREATE FUNCTION reason_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'reason_run: прогон создаётся в очереди' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.requested_by, NEW.stage_id, 'economics.compare') THEN
    RAISE EXCEPTION 'reason_run: гипотезы причин запускает участник тендера с economics.compare' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM calculation_comparison c WHERE c.id = NEW.comparison_id AND c.stage_id = NEW.stage_id AND c.status = 'ready') THEN
    RAISE EXCEPTION 'reason_run: сравнение — готовое сравнение этого этапа' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM evidence_scope s WHERE s.id = NEW.evidence_scope_id AND s.stage_id = NEW.stage_id) THEN
    RAISE EXCEPTION 'reason_run: снимок области — снимок этого этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reason_run_insert_guard BEFORE INSERT ON reason_run FOR EACH ROW EXECUTE FUNCTION reason_run_insert_guard();

CREATE FUNCTION reason_run_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'completed_with_gaps', 'failed') THEN
    RAISE EXCEPTION 'reason_run: завершённый прогон неизменен' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.comparison_id, NEW.evidence_scope_id, NEW.model_provider, NEW.model_id, NEW.model_version,
      NEW.prompt_version, NEW.prompt_sha256, NEW.requested_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.comparison_id, OLD.evidence_scope_id, OLD.model_provider, OLD.model_id, OLD.model_version,
      OLD.prompt_version, OLD.prompt_sha256, OLD.requested_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'reason_run: закреплённые входы прогона неизменны' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
    OR (OLD.status = 'running' AND NEW.status IN ('completed', 'completed_with_gaps', 'failed'))) THEN
    RAISE EXCEPTION 'reason_run: переход % → % не допускается', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reason_run_update_guard BEFORE UPDATE ON reason_run FOR EACH ROW EXECUTE FUNCTION reason_run_update_guard();
CREATE TRIGGER reason_run_no_delete BEFORE DELETE ON reason_run FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER reason_run_no_truncate BEFORE TRUNCATE ON reason_run FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Закреплённый вход прогона: единицы и кандидаты-основания (фрагменты снимка области), отпечаток входа.
CREATE TABLE reason_run_input (
  run_id       uuid PRIMARY KEY REFERENCES reason_run (id),
  input        jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  created_xact xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE FUNCTION reason_run_input_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reason_run r WHERE r.id = NEW.run_id AND r.status = 'queued' AND r.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'reason_run_input: вход закрепляется в транзакции запуска прогона' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reason_run_input_guard BEFORE INSERT ON reason_run_input FOR EACH ROW EXECUTE FUNCTION reason_run_input_guard();
CREATE TRIGGER reason_run_input_immutable BEFORE UPDATE OR DELETE ON reason_run_input FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER reason_run_input_no_truncate BEFORE TRUNCATE ON reason_run_input FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');
CREATE FUNCTION reason_run_input_required() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reason_run_input i WHERE i.run_id = NEW.id) THEN
    RAISE EXCEPTION 'reason_run: прогон создаётся с закреплённым входом' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER reason_run_input_required AFTER INSERT ON reason_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reason_run_input_required();

-- Гипотеза причины от модели: предложение человеку; принимает только человек с change_reason.confirm.
CREATE TABLE change_reason_suggestion (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id       uuid NOT NULL REFERENCES tender (id),
  stage_id        uuid NOT NULL REFERENCES tender_stage (id),
  run_id          uuid NOT NULL REFERENCES reason_run (id),
  unit_id         uuid NOT NULL REFERENCES comparison_unit (id),
  reason_kind     text NOT NULL CHECK (reason_kind IN ('document', 'answer', 'supplier')),
  rationale       text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'expired')),
  decided_by      uuid REFERENCES app_user (id),
  decided_at      timestamptz,
  decision_reason text CHECK (length(decision_reason) BETWEEN 1 AND 2000),
  explanation_id  uuid REFERENCES change_explanation (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     bigint NOT NULL DEFAULT 1,
  created_xact    xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT change_reason_suggestion_key UNIQUE (run_id, unit_id),
  CONSTRAINT change_reason_suggestion_decided_shape CHECK ((status IN ('accepted', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT change_reason_suggestion_explanation_shape CHECK ((status = 'accepted') = (explanation_id IS NOT NULL))
);
CREATE FUNCTION change_reason_suggestion_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'open' OR NOT EXISTS (
       SELECT 1 FROM reason_run r JOIN comparison_unit u ON u.comparison_id = r.comparison_id
        WHERE r.id = NEW.run_id AND r.status = 'running' AND r.stage_id = NEW.stage_id AND r.tender_id = NEW.tender_id AND u.id = NEW.unit_id) THEN
    RAISE EXCEPTION 'change_reason_suggestion: гипотезу пишет выполняющийся прогон по единице своего сравнения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER change_reason_suggestion_insert_guard BEFORE INSERT ON change_reason_suggestion FOR EACH ROW EXECUTE FUNCTION change_reason_suggestion_insert_guard();

-- open → accepted | rejected (человек с правом) | expired (инвалидация); финал неизменен; принятие — когда события этапа
-- обработаны и создана версия причины с этой гипотезой.
CREATE FUNCTION change_reason_suggestion_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'change_reason_suggestion: решённая гипотеза неизменна' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.run_id, NEW.unit_id, NEW.reason_kind, NEW.rationale, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.run_id, OLD.unit_id, OLD.reason_kind, OLD.rationale, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'change_reason_suggestion: содержание гипотезы неизменно' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'change_reason_suggestion: row_version растёт на 1' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IN ('accepted', 'rejected') AND NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'change_reason.confirm') THEN
    RAISE EXCEPTION 'change_reason_suggestion: гипотезу принимает человек с change_reason.confirm' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'accepted' AND (stage_events_pending(NEW.stage_id) OR NOT EXISTS (
       SELECT 1 FROM change_explanation e WHERE e.id = NEW.explanation_id AND e.suggestion_id = NEW.id AND e.unit_id = NEW.unit_id)) THEN
    RAISE EXCEPTION 'change_reason_suggestion: принятие — с версией причины по этой гипотезе и обработанными событиями этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER change_reason_suggestion_update_guard BEFORE UPDATE ON change_reason_suggestion FOR EACH ROW EXECUTE FUNCTION change_reason_suggestion_update_guard();
CREATE TRIGGER change_reason_suggestion_no_delete BEFORE DELETE ON change_reason_suggestion FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER change_reason_suggestion_no_truncate BEFORE TRUNCATE ON change_reason_suggestion FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Ссылки гипотезы — фрагменты закреплённого входа прогона для этой единицы; пишутся вместе с гипотезой.
CREATE TABLE change_reason_suggestion_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id uuid NOT NULL REFERENCES change_reason_suggestion (id),
  fragment_id   uuid NOT NULL REFERENCES evidence_fragment (id),
  CONSTRAINT change_reason_suggestion_evidence_key UNIQUE (suggestion_id, fragment_id)
);
CREATE FUNCTION change_reason_suggestion_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM change_reason_suggestion s JOIN reason_run_input i ON i.run_id = s.run_id
        WHERE s.id = NEW.suggestion_id AND s.created_xact = pg_current_xact_id()
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.input -> 'units') u
                       WHERE u ->> 'unitId' = s.unit_id::text
                         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(u -> 'fragmentIds') f WHERE f = NEW.fragment_id::text))) THEN
    RAISE EXCEPTION 'change_reason_suggestion_evidence: ссылка — фрагмент закреплённого входа этой единицы' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER change_reason_suggestion_evidence_guard BEFORE INSERT ON change_reason_suggestion_evidence FOR EACH ROW EXECUTE FUNCTION change_reason_suggestion_evidence_guard();
CREATE TRIGGER change_reason_suggestion_evidence_immutable BEFORE UPDATE OR DELETE ON change_reason_suggestion_evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER change_reason_suggestion_evidence_no_truncate BEFORE TRUNCATE ON change_reason_suggestion_evidence FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

ALTER TABLE change_explanation
  ADD CONSTRAINT change_explanation_suggestion_fk FOREIGN KEY (suggestion_id) REFERENCES change_reason_suggestion (id);
CREATE TRIGGER change_explanation_guard BEFORE INSERT ON change_explanation FOR EACH ROW EXECUTE FUNCTION change_explanation_guard();
CREATE TRIGGER change_explanation_immutable BEFORE UPDATE OR DELETE ON change_explanation FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER change_explanation_no_truncate BEFORE TRUNCATE ON change_explanation FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Зависимости и инвалидация (D-029, этап 10)

ALTER TABLE evidence_dependency DROP CONSTRAINT evidence_dependency_dependent_type_check;
ALTER TABLE evidence_dependency
  ADD CONSTRAINT evidence_dependency_dependent_type_check CHECK (dependent_type IN ('finding', 'discrepancy_status_event', 'model_suggestion',
                                                                                   'change_explanation', 'change_reason_suggestion'));
ALTER TABLE evidence_invalidation DROP CONSTRAINT evidence_invalidation_dependent_type_check;
ALTER TABLE evidence_invalidation
  ADD CONSTRAINT evidence_invalidation_dependent_type_check CHECK (dependent_type IN ('finding', 'decision', 'discrepancy_status_event', 'model_suggestion',
                                                                                     'change_explanation', 'change_reason_suggestion'));

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT ON revision_economics, revision_line_check, comparison_unit, comparison_effect, change_explanation, change_explanation_basis,
                        reason_run_input, change_reason_suggestion_evidence TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON calculation_comparison, reason_run, change_reason_suggestion TO kontur_app;
