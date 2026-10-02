-- Этап 08a: граф фактов D-018 (D-028; проект — docs/architecture/08a-fact-graph-design.md §3, §9). Прочитанное значение
-- (`evidence_fact`) неизменно и привязано к фрагментам своего прогона распознавания допустимого происхождения (I06 —
-- триггером); производное состояние (`fact_state`) пересчитывается детерминированной функцией графа и изменяемо по D-018.
-- Решение человека — неизменяемое ребро графа (`fact_decision`), а не правка факта. Неоднозначность — замечание
-- (`fact_remark`). Источник фактов — прогоны распознавания документов тендера и договора; вложения писем — нет.

-- ---------------------------------------------------------------- Справочник типов (D-028: 13 типов донора)

CREATE TABLE evidence_fact_type (
  code             text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,59}$'),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  fate             text NOT NULL CHECK (fate IN ('contract_card', 'economics', 'requirement_candidate')),
  normative_source text NOT NULL CHECK (length(normative_source) BETWEEN 1 AND 200)
);
INSERT INTO evidence_fact_type (code, title, fate, normative_source) VALUES
  ('party_customer', 'Заказчик', 'contract_card', 'D-018, D-028: Locus rules/1'),
  ('party_contractor', 'Подрядчик', 'contract_card', 'D-018, D-028: Locus rules/1'),
  ('contract_price', 'Цена договора', 'economics', 'D-018, D-028: Locus rules/1'),
  ('vat_rate', 'Ставка НДС', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('advance_percent', 'Размер аванса', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('advance_term', 'Срок перечисления аванса', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('retention_percent', 'Гарантийное удержание', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('retention_return_term', 'Срок возврата гарантийного удержания', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('warranty_period', 'Гарантийный срок', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('work_start_date', 'Начало работ', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('work_end_date', 'Окончание работ', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('penalty_rate', 'Неустойка', 'requirement_candidate', 'D-018, D-028: Locus rules/1'),
  ('estimate_total', 'Итог сметы', 'economics', 'D-018, D-028: Locus rules/1');
CREATE TRIGGER evidence_fact_type_immutable BEFORE UPDATE OR DELETE ON evidence_fact_type FOR EACH ROW EXECUTE FUNCTION forbid_mutation('reference');
CREATE TRIGGER evidence_fact_type_no_truncate BEFORE TRUNCATE ON evidence_fact_type FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('reference');

-- ---------------------------------------------------------------- Прогон извлечения

-- Один прогон правил на прогон распознавания и версию правил; классификация документа — тем же прогоном.
CREATE TABLE fact_extraction_run (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recognition_run_id   uuid NOT NULL REFERENCES recognition_run (id),
  document_revision_id uuid NOT NULL REFERENCES document_revision (id),
  document_id          uuid NOT NULL REFERENCES document (id),
  tender_id            uuid REFERENCES tender (id),
  contract_id          uuid REFERENCES contract (id),
  rules_version        text NOT NULL CHECK (length(rules_version) BETWEEN 1 AND 60),
  document_kind        text NOT NULL CHECK (document_kind IN ('contract', 'amendment', 'appendix', 'estimate', 'act', 'letter', 'other')),
  document_number      text NOT NULL CHECK (length(document_number) <= 200),
  document_date        date,
  parent_number        text CHECK (length(parent_number) BETWEEN 1 AND 200),
  parent_number_key    text CHECK (length(parent_number_key) BETWEEN 1 AND 200),
  parent_date          date,
  classify_method      text NOT NULL CHECK (length(classify_method) BETWEEN 1 AND 60),
  fragments_scanned    int NOT NULL CHECK (fragments_scanned >= 0),
  facts_found          int NOT NULL CHECK (facts_found >= 0),
  coverage             jsonb NOT NULL CHECK (jsonb_typeof(coverage) = 'object'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_xact         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT fact_extraction_run_key UNIQUE (recognition_run_id, rules_version),
  CONSTRAINT fact_extraction_run_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  CONSTRAINT fact_extraction_run_parent_shape CHECK ((parent_number IS NULL) = (parent_number_key IS NULL))
);
CREATE INDEX fact_extraction_run_tender_idx ON fact_extraction_run (tender_id) WHERE tender_id IS NOT NULL;
CREATE INDEX fact_extraction_run_contract_idx ON fact_extraction_run (contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX fact_extraction_run_document_idx ON fact_extraction_run (document_id);

-- Прогон распознавания — этой редакции этого документа, завершён; владелец — владелец документа (тендер или договор).
CREATE FUNCTION fact_extraction_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT rr.status, rr.document_revision_id, v2.document_id, d.tender_id, d.contract_id, d.mail_attachment_id INTO v
    FROM recognition_run rr
    JOIN document_revision v2 ON v2.id = rr.document_revision_id
    JOIN document d ON d.id = v2.document_id
   WHERE rr.id = NEW.recognition_run_id;
  IF v.document_revision_id IS DISTINCT FROM NEW.document_revision_id OR v.document_id IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'fact_extraction_run: прогон распознавания другой редакции или документа' USING ERRCODE = '23514';
  END IF;
  IF v.mail_attachment_id IS NOT NULL THEN
    RAISE EXCEPTION 'fact_extraction_run: вложения писем не извлекаются (права ящика, D-028)' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tender_id, NEW.contract_id) IS DISTINCT FROM (v.tender_id, v.contract_id) THEN
    RAISE EXCEPTION 'fact_extraction_run: владелец не совпадает с владельцем документа' USING ERRCODE = '23514';
  END IF;
  IF v.status NOT IN ('complete', 'partial') THEN
    RAISE EXCEPTION 'fact_extraction_run: прогон распознавания не завершён' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_extraction_run_insert_guard BEFORE INSERT ON fact_extraction_run FOR EACH ROW EXECUTE FUNCTION fact_extraction_run_insert_guard();
CREATE TRIGGER fact_extraction_run_immutable BEFORE UPDATE OR DELETE ON fact_extraction_run FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER fact_extraction_run_no_truncate BEFORE TRUNCATE ON fact_extraction_run FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Прочитанный факт и его основания

CREATE TABLE evidence_fact (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_run_id uuid NOT NULL REFERENCES fact_extraction_run (id),
  fact_type         text NOT NULL REFERENCES evidence_fact_type (code),
  raw_value         text NOT NULL CHECK (length(raw_value) BETWEEN 1 AND 500),
  normalized        jsonb NOT NULL CHECK (jsonb_typeof(normalized) = 'object'),
  normalized_key    text NOT NULL CHECK (length(normalized_key) BETWEEN 2 AND 1000),
  unit              text NOT NULL CHECK (length(unit) <= 20),
  condition         text NOT NULL CHECK (length(condition) <= 500),
  clause_ref        text NOT NULL CHECK (clause_ref ~ '^([0-9]+(\.[0-9]+)*)?$'),
  amends            boolean NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_xact      xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT evidence_fact_value_key UNIQUE (extraction_run_id, fact_type, normalized_key)
);
CREATE INDEX evidence_fact_run_idx ON evidence_fact (extraction_run_id);

-- Факт пишет только транзакция своего прогона извлечения.
CREATE FUNCTION evidence_fact_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fact_extraction_run x WHERE x.id = NEW.extraction_run_id AND x.created_xact = NEW.created_xact) THEN
    RAISE EXCEPTION 'evidence_fact: факт пишется только в транзакции своего прогона извлечения' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_fact_insert_guard BEFORE INSERT ON evidence_fact FOR EACH ROW EXECUTE FUNCTION evidence_fact_insert_guard();
CREATE TRIGGER evidence_fact_immutable BEFORE UPDATE OR DELETE ON evidence_fact FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER evidence_fact_no_truncate BEFORE TRUNCATE ON evidence_fact FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE TABLE evidence_fact_fragment (
  evidence_fact_id uuid NOT NULL REFERENCES evidence_fact (id),
  fragment_id      uuid NOT NULL REFERENCES evidence_fragment (id),
  ordinal          int NOT NULL CHECK (ordinal > 0),
  created_xact     xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (evidence_fact_id, fragment_id),
  CONSTRAINT evidence_fact_fragment_ordinal_key UNIQUE (evidence_fact_id, ordinal)
);
CREATE INDEX evidence_fact_fragment_fragment_idx ON evidence_fact_fragment (fragment_id);

-- I06 (D-018) триггером: основание — фрагмент того же прогона распознавания и письменного происхождения;
-- описание модели, подсказка и речь переговоров основанием факта не бывают. Пишется в транзакции факта.
CREATE FUNCTION evidence_fact_fragment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT x.recognition_run_id, f.created_xact INTO v
    FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id WHERE f.id = NEW.evidence_fact_id;
  IF v.created_xact IS DISTINCT FROM NEW.created_xact THEN
    RAISE EXCEPTION 'evidence_fact_fragment: основание пишется в транзакции факта' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM evidence_fragment e
        WHERE e.id = NEW.fragment_id AND e.run_id = v.recognition_run_id
          AND e.origin IN ('document_text', 'recognized_text', 'email_body', 'attachment_text')) THEN
    RAISE EXCEPTION 'evidence_fact_fragment: основание — фрагмент того же прогона письменного происхождения (I06, D-018)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_fact_fragment_guard BEFORE INSERT ON evidence_fact_fragment FOR EACH ROW EXECUTE FUNCTION evidence_fact_fragment_guard();
CREATE TRIGGER evidence_fact_fragment_immutable BEFORE UPDATE OR DELETE ON evidence_fact_fragment FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER evidence_fact_fragment_no_truncate BEFORE TRUNCATE ON evidence_fact_fragment FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- У факта есть хотя бы одно основание (проверка на COMMIT).
CREATE FUNCTION evidence_fact_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM evidence_fact_fragment x WHERE x.evidence_fact_id = NEW.id) THEN
    RAISE EXCEPTION 'evidence_fact: факт без основания' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER evidence_fact_commit_check AFTER INSERT ON evidence_fact
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION evidence_fact_commit_check();

-- Владелец факта — владелец его прогона извлечения.
CREATE FUNCTION evidence_fact_owner(p_fact uuid) RETURNS TABLE (tender_id uuid, contract_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT x.tender_id, x.contract_id FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id WHERE f.id = p_fact
$$;

-- ---------------------------------------------------------------- Решение человека — ребро графа

CREATE TABLE fact_decision (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid REFERENCES tender (id),
  contract_id   uuid REFERENCES contract (id),
  fact_id       uuid NOT NULL REFERENCES evidence_fact (id),
  other_fact_id uuid NOT NULL REFERENCES evidence_fact (id),
  kind          text NOT NULL CHECK (kind IN ('prevails', 'distinct', 'rule')),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  decided_by    uuid NOT NULL REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fact_decision_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  CONSTRAINT fact_decision_pair_shape CHECK (fact_id <> other_fact_id)
);
CREATE INDEX fact_decision_fact_idx ON fact_decision (fact_id);
CREATE INDEX fact_decision_other_idx ON fact_decision (other_fact_id);

CREATE FUNCTION fact_decision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = NEW.decided_by AND u.kind = 'human') THEN
    RAISE EXCEPTION 'fact_decision: решение принимает человек' USING ERRCODE = '42501';
  END IF;
  IF (SELECT (o.tender_id, o.contract_id) FROM evidence_fact_owner(NEW.fact_id) o) IS DISTINCT FROM (NEW.tender_id, NEW.contract_id)
     OR (SELECT (o.tender_id, o.contract_id) FROM evidence_fact_owner(NEW.other_fact_id) o) IS DISTINCT FROM (NEW.tender_id, NEW.contract_id) THEN
    RAISE EXCEPTION 'fact_decision: оба факта — одного владельца' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_decision_insert_guard BEFORE INSERT ON fact_decision FOR EACH ROW EXECUTE FUNCTION fact_decision_insert_guard();
CREATE TRIGGER fact_decision_immutable BEFORE UPDATE OR DELETE ON fact_decision FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER fact_decision_no_truncate BEFORE TRUNCATE ON fact_decision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Производное состояние (D-018: изменяемое)

CREATE TABLE fact_state (
  evidence_fact_id      uuid PRIMARY KEY REFERENCES evidence_fact (id),
  tender_id             uuid REFERENCES tender (id),
  contract_id           uuid REFERENCES contract (id),
  status                text NOT NULL CHECK (status IN ('active', 'superseded', 'conflict')),
  superseded_reason     text CHECK (superseded_reason IN ('amendment', 'human', 'document_revision')),
  superseded_by_fact_id uuid REFERENCES evidence_fact (id),
  valid_from            date,
  valid_to              date,
  decided_by            text NOT NULL CHECK (decided_by IN ('rule', 'human')),
  decision_id           uuid REFERENCES fact_decision (id),
  graph_hash            text NOT NULL CHECK (graph_hash ~ '^[0-9a-f]{64}$'),
  computed_at           timestamptz NOT NULL DEFAULT now(),
  row_version           bigint NOT NULL DEFAULT 1,
  CONSTRAINT fact_state_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  CONSTRAINT fact_state_superseded_shape CHECK ((status = 'superseded') = (superseded_reason IS NOT NULL)),
  CONSTRAINT fact_state_replacement_shape CHECK ((superseded_by_fact_id IS NOT NULL) = (superseded_reason IN ('amendment', 'human'))),
  CONSTRAINT fact_state_decision_shape CHECK ((decided_by = 'human') = (decision_id IS NOT NULL))
);
CREATE INDEX fact_state_tender_idx ON fact_state (tender_id) WHERE tender_id IS NOT NULL;
CREATE INDEX fact_state_contract_idx ON fact_state (contract_id) WHERE contract_id IS NOT NULL;

-- Состояние — у факта своего владельца; заменивший факт и решение — того же владельца.
CREATE FUNCTION fact_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT (o.tender_id, o.contract_id) FROM evidence_fact_owner(NEW.evidence_fact_id) o) IS DISTINCT FROM (NEW.tender_id, NEW.contract_id) THEN
    RAISE EXCEPTION 'fact_state: владелец не совпадает с владельцем факта' USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by_fact_id IS NOT NULL
     AND (SELECT (o.tender_id, o.contract_id) FROM evidence_fact_owner(NEW.superseded_by_fact_id) o) IS DISTINCT FROM (NEW.tender_id, NEW.contract_id) THEN
    RAISE EXCEPTION 'fact_state: заменивший факт другого владельца' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM fact_decision d WHERE d.id = NEW.decision_id AND (d.tender_id, d.contract_id) IS NOT DISTINCT FROM (NEW.tender_id, NEW.contract_id)
          AND NEW.evidence_fact_id IN (d.fact_id, d.other_fact_id)) THEN
    RAISE EXCEPTION 'fact_state: решение не о этом факте' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.evidence_fact_id, NEW.tender_id, NEW.contract_id) IS DISTINCT FROM (OLD.evidence_fact_id, OLD.tender_id, OLD.contract_id) THEN
    RAISE EXCEPTION 'fact_state: факт и владелец неизменны' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_state_guard BEFORE INSERT OR UPDATE ON fact_state FOR EACH ROW EXECUTE FUNCTION fact_state_guard();
CREATE TRIGGER fact_state_no_delete BEFORE DELETE ON fact_state FOR EACH ROW EXECUTE FUNCTION forbid_mutation('mutable');
CREATE TRIGGER fact_state_no_truncate BEFORE TRUNCATE ON fact_state FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('mutable');

-- ---------------------------------------------------------------- Замечание для человека

CREATE TABLE fact_remark (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id    uuid REFERENCES tender (id),
  contract_id  uuid REFERENCES contract (id),
  remark_key   text NOT NULL CHECK (remark_key ~ '^[0-9a-f]{32}$'),
  kind         text NOT NULL CHECK (kind IN ('parent_not_found', 'parent_ambiguous', 'undated_amendment', 'amendment_target_ambiguous', 'value_conflict')),
  fact_ids     uuid[] NOT NULL,
  document_ids uuid[] NOT NULL,
  message      text NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  row_version  bigint NOT NULL DEFAULT 1,
  CONSTRAINT fact_remark_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  CONSTRAINT fact_remark_status_shape CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX fact_remark_open_tender_key ON fact_remark (tender_id, remark_key) WHERE status = 'open' AND tender_id IS NOT NULL;
CREATE UNIQUE INDEX fact_remark_open_contract_key ON fact_remark (contract_id, remark_key) WHERE status = 'open' AND contract_id IS NOT NULL;

-- Переход только open → resolved; закрытое замечание неизменно; содержание замечания не меняется.
CREATE FUNCTION fact_remark_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'fact_remark: закрытое замечание неизменно' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.contract_id, NEW.remark_key, NEW.kind, NEW.fact_ids, NEW.document_ids, NEW.message, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.contract_id, OLD.remark_key, OLD.kind, OLD.fact_ids, OLD.document_ids, OLD.message, OLD.opened_at) THEN
    RAISE EXCEPTION 'fact_remark: содержание замечания неизменно' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_remark_update_guard BEFORE UPDATE ON fact_remark FOR EACH ROW EXECUTE FUNCTION fact_remark_update_guard();
CREATE TRIGGER fact_remark_no_delete BEFORE DELETE ON fact_remark FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER fact_remark_no_truncate BEFORE TRUNCATE ON fact_remark FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- ---------------------------------------------------------------- Граф владельца

CREATE TABLE fact_graph (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id     uuid REFERENCES tender (id),
  contract_id   uuid REFERENCES contract (id),
  rules_version text NOT NULL CHECK (length(rules_version) BETWEEN 1 AND 60),
  graph_hash    text NOT NULL CHECK (graph_hash ~ '^[0-9a-f]{64}$'),
  relations     jsonb NOT NULL CHECK (jsonb_typeof(relations) = 'array'),
  coverage      jsonb NOT NULL CHECK (jsonb_typeof(coverage) = 'object'),
  computed_at   timestamptz NOT NULL DEFAULT now(),
  row_version   bigint NOT NULL DEFAULT 1,
  CONSTRAINT fact_graph_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  CONSTRAINT fact_graph_tender_key UNIQUE (tender_id),
  CONSTRAINT fact_graph_contract_key UNIQUE (contract_id)
);
CREATE FUNCTION fact_graph_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tender_id, NEW.contract_id) IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.contract_id) THEN
    RAISE EXCEPTION 'fact_graph: владелец неизменен' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_graph_update_guard BEFORE UPDATE ON fact_graph FOR EACH ROW EXECUTE FUNCTION fact_graph_update_guard();
CREATE TRIGGER fact_graph_no_delete BEFORE DELETE ON fact_graph FOR EACH ROW EXECUTE FUNCTION forbid_mutation('mutable');
CREATE TRIGGER fact_graph_no_truncate BEFORE TRUNCATE ON fact_graph FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('mutable');

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT ON evidence_fact_type TO kontur_app;
GRANT SELECT, INSERT ON fact_extraction_run, evidence_fact, evidence_fact_fragment, fact_decision TO kontur_app;
GRANT SELECT, INSERT, UPDATE ON fact_state, fact_remark, fact_graph TO kontur_app;
