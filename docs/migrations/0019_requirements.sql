-- Этап 08: требования, факты, покрытие, решения и полнота (D-026; docs/architecture/08-requirements-model-design.md §13).
-- Решения владельца: docs/reviews/08-owner-decisions.md и docs/reviews/08-arch-decisions-2.md.
-- * права — существующая модель ролей и назначений; вторая линия БД — одна функция has_stage_capability (Р-08-8);
-- * Q&A получает собственные фрагменты от неизменяемой ревизии и единицу снимка; в поисковый индекс не попадает (Р-08-1);
-- * один активный реестр требований на этап, закреплённый на снимке; переход — явной операцией (Р-08-6);
-- * кандидат отдельно от требования и факта; модель пишет только кандидатов (AD-08-2 первого текста);
-- * требование и факт — идентичность и неизменяемые ревизии; основания — фрагменты с ролью;
-- * покрытие — история оценок ревизии требования и типизированные объекты (Р-08-2);
-- * решение — строка decision как неизменяемая версия, замена — supersedes_decision_id (Р-08-3);
-- * допущение, вопрос заказчику и пометка этапа — отдельные типы (OD-08-6);
-- * полнота — по фрагментам снимка; пакетная отметка разворачивается в конкретные ID (Р-08-7).

-- ---------------------------------------------------------------- Права (Р-08-8)

-- Возможности по тендеру — те же, что tenderCapabilities в packages/core/src/capabilities.ts (менять вместе;
-- совпадение проверяет тест). Назначение действует, пока у пользователя есть глобальная роль назначения;
-- администратор без назначения содержательных возможностей не получает.
CREATE FUNCTION tender_capabilities(p_user uuid, p_tender uuid) RETURNS text[]
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
                              'requirement.read', 'requirement.create', 'analysis.run', 'fact.read', 'fact.create'];
  END IF;
  IF v_role = 'manager' THEN
    v_caps := v_caps || ARRAY['stage.manage', 'hold.resolve', 'requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm'];
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

-- Единственный предикат второй линии этапа 08: подтверждение, решение, переходы и иные критичные изменения.
CREATE FUNCTION has_stage_capability(p_user uuid, p_stage uuid, p_capability text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(p_capability = ANY (tender_capabilities(p_user, (SELECT tender_id FROM tender_stage WHERE id = p_stage))), false)
$$;

-- ---------------------------------------------------------------- Ветка доказательств Q&A (Р-08-1)

-- Составной ключ для FK фрагмента и единицы снимка по тендеру.
ALTER TABLE qa_item_revision ADD CONSTRAINT qa_item_revision_id_tender_key UNIQUE (id, tender_id);
-- Транзакция создания ревизии: только она пишет фрагменты ревизии (I15), как у письма и транскрипции.
-- Существующие ревизии получают номер транзакции этой миграции — фрагменты им пишет она же, ниже.
ALTER TABLE qa_item_revision ADD COLUMN created_xact xid8 NOT NULL DEFAULT pg_current_xact_id();

ALTER TABLE evidence_fragment ADD COLUMN qa_item_revision_id uuid;
ALTER TABLE evidence_fragment
  DROP CONSTRAINT evidence_fragment_origin_check,
  DROP CONSTRAINT evidence_fragment_source_unit_type_check,
  DROP CONSTRAINT evidence_fragment_source_shape;
-- I06: вопрос участника и ответ заказчика — разные происхождения; ни то ни другое не проектный текст.
ALTER TABLE evidence_fragment
  ADD CONSTRAINT evidence_fragment_origin_check CHECK (origin IN (
    'document_text', 'recognized_text', 'model_description', 'negotiation_speech', 'negotiation_hint',
    'email_body', 'attachment_text', 'qa_question', 'qa_answer')),
  ADD CONSTRAINT evidence_fragment_source_unit_type_check
    CHECK (source_unit_type IN ('recognition_run', 'mail_message_revision', 'transcript_revision', 'qa_item_revision')),
  -- Ровно один источник по виду (0018); ветка Q&A — по образцу транскрипции: владелец — тендер ревизии.
  ADD CONSTRAINT evidence_fragment_source_shape CHECK (
    CASE source_unit_type
      WHEN 'recognition_run' THEN
        run_id IS NOT NULL AND source_unit_id = run_id AND document_revision_id IS NOT NULL
        AND num_nonnulls(tender_id, contract_id) <= 1
        AND num_nonnulls(mail_message_revision_id, transcript_revision_id, transcript_segment_id, qa_item_revision_id) = 0
        AND origin IN ('document_text', 'recognized_text', 'model_description')
      WHEN 'mail_message_revision' THEN
        mail_message_revision_id IS NOT NULL AND source_unit_id = mail_message_revision_id
        AND num_nonnulls(run_id, document_revision_id, tender_id, contract_id, transcript_revision_id, transcript_segment_id, qa_item_revision_id) = 0
        AND origin = 'email_body'
      WHEN 'transcript_revision' THEN
        transcript_revision_id IS NOT NULL AND source_unit_id = transcript_revision_id AND transcript_segment_id IS NOT NULL
        AND tender_id IS NOT NULL AND contract_id IS NULL
        AND num_nonnulls(run_id, document_revision_id, mail_message_revision_id, qa_item_revision_id) = 0
        AND origin IN ('negotiation_speech', 'negotiation_hint')
      WHEN 'qa_item_revision' THEN
        qa_item_revision_id IS NOT NULL AND source_unit_id = qa_item_revision_id
        AND tender_id IS NOT NULL AND contract_id IS NULL
        AND num_nonnulls(run_id, document_revision_id, mail_message_revision_id, transcript_revision_id, transcript_segment_id) = 0
        AND origin IN ('qa_question', 'qa_answer')
      ELSE false
    END),
  ADD CONSTRAINT evidence_fragment_qa_fk FOREIGN KEY (qa_item_revision_id, tender_id) REFERENCES qa_item_revision (id, tender_id);
CREATE INDEX evidence_fragment_qa_idx ON evidence_fragment (qa_item_revision_id) WHERE qa_item_revision_id IS NOT NULL;

-- Происхождение и неизменность по виду источника (0018) + ветка Q&A: фрагменты пишет транзакция создания
-- ревизии; вопрос — из текста вопроса, ответ — из текста ответа, ничего другого.
CREATE OR REPLACE FUNCTION evidence_fragment_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_qa   qa_item_revision%ROWTYPE;
BEGIN
  IF NEW.source_unit_type = 'recognition_run' THEN
    IF NEW.tender_id IS NULL AND NEW.contract_id IS NULL AND NOT EXISTS (
         SELECT 1 FROM recognition_run r
          WHERE r.id = NEW.run_id AND r.document_revision_id = NEW.document_revision_id
            AND r.tender_id IS NULL AND r.contract_id IS NULL) THEN
      RAISE EXCEPTION 'evidence_fragment: без владельца бывает только фрагмент прогона документа вложения своей редакции (D-025)'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source_unit_type = 'mail_message_revision' THEN
    IF NOT EXISTS (SELECT 1 FROM mail_message_revision r
                    WHERE r.id = NEW.mail_message_revision_id AND r.created_xact = pg_current_xact_id() AND r.created_at = now()) THEN
      RAISE EXCEPTION 'evidence_fragment: фрагменты письма пишет только транзакция создания ревизии (I15)' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.source_unit_type = 'transcript_revision' THEN
    IF NOT EXISTS (SELECT 1 FROM transcript_revision r
                    WHERE r.id = NEW.transcript_revision_id AND r.created_xact = pg_current_xact_id() AND r.created_at = now()) THEN
      RAISE EXCEPTION 'evidence_fragment: фрагменты транскрипции пишет только транзакция создания редакции (I15)' USING ERRCODE = '55000';
    END IF;
    SELECT segment_kind INTO v_kind FROM transcript_segment WHERE id = NEW.transcript_segment_id;
    IF NOT ((v_kind = 'speech' AND NEW.origin = 'negotiation_speech') OR (v_kind = 'hint' AND NEW.origin = 'negotiation_hint')) THEN
      RAISE EXCEPTION 'evidence_fragment: подсказка участнику не становится речью и наоборот (I06, A03)' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO v_qa FROM qa_item_revision WHERE id = NEW.qa_item_revision_id;
    IF v_qa.id IS NULL OR v_qa.created_xact <> pg_current_xact_id() THEN
      RAISE EXCEPTION 'evidence_fragment: фрагменты вопроса–ответа пишет только транзакция создания ревизии (I15)' USING ERRCODE = '55000';
    END IF;
    IF NOT ((NEW.origin = 'qa_question' AND NEW.text = v_qa.question AND NEW.locator ->> 'part' = 'question')
         OR (NEW.origin = 'qa_answer' AND NEW.text IS NOT DISTINCT FROM v_qa.answer AND NEW.locator ->> 'part' = 'answer')) THEN
      RAISE EXCEPTION 'evidence_fragment: фрагмент вопроса–ответа повторяет текст своей части ревизии (I06)' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Якорь фрагмента Q&A: часть ревизии.
CREATE OR REPLACE FUNCTION evidence_locator_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(p) IS DISTINCT FROM 'object' THEN false
    WHEN p ->> 'kind' = 'pdf_text' THEN
      (p - ARRAY['kind', 'page', 'method', 'block']) = '{}'::jsonb
      AND jsonb_positive_int(p, 'page') AND jsonb_positive_int(p, 'block')
      AND coalesce(p ->> 'method' IN ('native_text', 'ocr'), false)
    WHEN p ->> 'kind' = 'xlsx_cells' THEN
      CASE WHEN (p - ARRAY['kind', 'sheet', 'sheetIndex', 'range', 'rowFrom', 'rowTo', 'colFrom', 'colTo', 'merged']) = '{}'::jsonb
                AND jsonb_typeof(p -> 'sheet') = 'string' AND length(p ->> 'sheet') BETWEEN 1 AND 31
                AND jsonb_positive_int(p, 'sheetIndex')
                AND coalesce((p ->> 'range') ~ '^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$', false)
                AND jsonb_positive_int(p, 'rowFrom') AND jsonb_positive_int(p, 'rowTo')
                AND jsonb_positive_int(p, 'colFrom') AND jsonb_positive_int(p, 'colTo')
                AND (NOT p ? 'merged' OR jsonb_typeof(p -> 'merged') = 'array')
           THEN (p ->> 'rowFrom')::int <= (p ->> 'rowTo')::int AND (p ->> 'colFrom')::int <= (p ->> 'colTo')::int
           ELSE false END
    WHEN p ->> 'kind' = 'csv_rows' THEN
      CASE WHEN (p - ARRAY['kind', 'rowFrom', 'rowTo', 'colFrom', 'colTo', 'headerRow', 'lineFrom', 'lineTo']) = '{}'::jsonb
                AND jsonb_positive_int(p, 'rowFrom') AND jsonb_positive_int(p, 'rowTo')
                AND jsonb_positive_int(p, 'colFrom') AND jsonb_positive_int(p, 'colTo')
                AND jsonb_positive_int(p, 'lineFrom') AND jsonb_positive_int(p, 'lineTo')
                AND (jsonb_typeof(p -> 'headerRow') = 'null' OR jsonb_positive_int(p, 'headerRow'))
           THEN (p ->> 'rowFrom')::int <= (p ->> 'rowTo')::int AND (p ->> 'colFrom')::int <= (p ->> 'colTo')::int
                AND (p ->> 'lineFrom')::int <= (p ->> 'lineTo')::int
           ELSE false END
    WHEN p ->> 'kind' = 'docx_paragraph' THEN
      (p - ARRAY['kind', 'part', 'block', 'section']) = '{}'::jsonb
      AND coalesce(p ->> 'part' IN ('body', 'footnotes', 'endnotes'), false)
      AND jsonb_positive_int(p, 'block') AND jsonb_positive_int(p, 'section')
    WHEN p ->> 'kind' = 'docx_table_row' THEN
      CASE WHEN (p - ARRAY['kind', 'part', 'block', 'section', 'table', 'row', 'cellFrom', 'cellTo']) = '{}'::jsonb
                AND coalesce(p ->> 'part' IN ('body', 'footnotes', 'endnotes'), false)
                AND jsonb_positive_int(p, 'block') AND jsonb_positive_int(p, 'section') AND jsonb_positive_int(p, 'table')
                AND jsonb_positive_int(p, 'row') AND jsonb_positive_int(p, 'cellFrom') AND jsonb_positive_int(p, 'cellTo')
           THEN (p ->> 'cellFrom')::int <= (p ->> 'cellTo')::int
           ELSE false END
    WHEN p ->> 'kind' = 'mail_body' THEN
      (p - ARRAY['kind', 'block', 'quoted']) = '{}'::jsonb
      AND jsonb_positive_int(p, 'block') AND jsonb_typeof(p -> 'quoted') = 'boolean'
    WHEN p ->> 'kind' = 'transcript_segment' THEN
      CASE WHEN (p - ARRAY['kind', 'segment', 'startMs', 'endMs']) = '{}'::jsonb
                AND jsonb_positive_int(p, 'segment')
                AND jsonb_typeof(p -> 'startMs') = 'number' AND jsonb_typeof(p -> 'endMs') = 'number'
           THEN (p ->> 'startMs')::numeric >= 0 AND (p ->> 'endMs')::numeric >= (p ->> 'startMs')::numeric
           ELSE false END
    WHEN p ->> 'kind' = 'qa_item' THEN
      (p - ARRAY['kind', 'part']) = '{}'::jsonb AND coalesce(p ->> 'part' IN ('question', 'answer'), false)
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION evidence_fragment_local_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_engine text;
  v_kind   text;
BEGIN
  IF NEW.run_id IS NULL THEN
    IF NEW.locator IS NULL OR NOT evidence_locator_valid(NEW.locator)
       OR NEW.locator ->> 'kind' IS DISTINCT FROM (CASE NEW.source_unit_type WHEN 'mail_message_revision' THEN 'mail_body'
                                                                             WHEN 'transcript_revision' THEN 'transcript_segment'
                                                                             WHEN 'qa_item_revision' THEN 'qa_item' END) THEN
      RAISE EXCEPTION 'evidence_fragment: у фрагмента письма, транскрипции и вопроса–ответа обязателен якорь своего вида' USING ERRCODE = '23514';
    END IF;
    IF NEW.page_index IS NOT NULL OR NEW.bbox_norm IS NOT NULL OR NEW.polygon_norm IS NOT NULL OR NEW.bbox_space IS NOT NULL
       OR NEW.shape_type IS NOT NULL OR NEW.rotation IS NOT NULL OR NEW.external_crop_url IS NOT NULL OR NEW.derived_model_ref IS NOT NULL THEN
      RAISE EXCEPTION 'evidence_fragment: у фрагмента письма, транскрипции и вопроса–ответа нет страницы и координат' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT engine INTO v_engine FROM recognition_run WHERE id = NEW.run_id;
  IF v_engine IS DISTINCT FROM 'local_ocr' THEN
    IF NEW.locator IS NOT NULL THEN
      RAISE EXCEPTION 'evidence_fragment: структурный якорь есть только у локального прогона' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.locator IS NULL OR NEW.page_index IS NULL OR NOT evidence_locator_valid(NEW.locator) THEN
    RAISE EXCEPTION 'evidence_fragment: у локального фрагмента обязательны единица и корректный якорь (AD-05a-1)' USING ERRCODE = '23514';
  END IF;
  IF NEW.bbox_norm IS NOT NULL OR NEW.polygon_norm IS NOT NULL OR NEW.bbox_space IS NOT NULL OR NEW.shape_type IS NOT NULL
     OR NEW.rotation IS NOT NULL OR NEW.external_crop_url IS NOT NULL OR NEW.derived_model_ref IS NOT NULL THEN
    RAISE EXCEPTION 'evidence_fragment: у локального фрагмента нет координат (D-014)' USING ERRCODE = '23514';
  END IF;
  SELECT unit_kind INTO v_kind FROM recognition_page WHERE run_id = NEW.run_id AND page_index = NEW.page_index;
  IF v_kind IS NULL OR NOT (
       (v_kind = 'pdf_page' AND NEW.locator ->> 'kind' = 'pdf_text' AND (NEW.locator ->> 'page')::int = NEW.page_index + 1)
    OR (v_kind = 'xlsx_sheet' AND NEW.locator ->> 'kind' = 'xlsx_cells' AND (NEW.locator ->> 'sheetIndex')::int = NEW.page_index + 1)
    OR (v_kind = 'csv_table' AND NEW.locator ->> 'kind' = 'csv_rows')
    OR (v_kind = 'docx_body' AND NEW.locator ->> 'kind' IN ('docx_paragraph', 'docx_table_row'))) THEN
    RAISE EXCEPTION 'evidence_fragment: якорь фрагмента не соответствует единице источника (AD-05a-1)' USING ERRCODE = '23514';
  END IF;
  IF NOT ((NEW.origin = 'recognized_text' AND coalesce(NEW.locator ->> 'method', '') = 'ocr')
       OR (NEW.origin = 'document_text' AND coalesce(NEW.locator ->> 'method', '') <> 'ocr')) THEN
    RAISE EXCEPTION 'evidence_fragment: происхождение % не соответствует способу обработки (I06)', NEW.origin USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Фрагменты ревизии вопроса–ответа: вопрос и (если есть) ответ — в транзакции создания ревизии.
CREATE FUNCTION qa_item_revision_fragments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, qa_item_revision_id, origin, fragment_kind,
                                 fragment_key, ordinal, text, text_sha256, locator)
  VALUES (NEW.tender_id, 'qa_item_revision', NEW.id, NEW.id, 'qa_question', 'text_block', 'qa:question', 0, NEW.question,
          encode(sha256(convert_to(NEW.question, 'UTF8')), 'hex'), '{"kind": "qa_item", "part": "question"}'::jsonb);
  IF NEW.answer IS NOT NULL THEN
    INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, qa_item_revision_id, origin, fragment_kind,
                                   fragment_key, ordinal, text, text_sha256, locator)
    VALUES (NEW.tender_id, 'qa_item_revision', NEW.id, NEW.id, 'qa_answer', 'text_block', 'qa:answer', 1, NEW.answer,
            encode(sha256(convert_to(NEW.answer, 'UTF8')), 'hex'), '{"kind": "qa_item", "part": "answer"}'::jsonb);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER qa_item_revision_fragments AFTER INSERT ON qa_item_revision
  FOR EACH ROW EXECUTE FUNCTION qa_item_revision_fragments();

-- Существующие ревизии (этап 07): фрагменты пишет эта же транзакция.
INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, qa_item_revision_id, origin, fragment_kind,
                               fragment_key, ordinal, text, text_sha256, locator)
SELECT r.tender_id, 'qa_item_revision', r.id, r.id, 'qa_question', 'text_block', 'qa:question', 0, r.question,
       encode(sha256(convert_to(r.question, 'UTF8')), 'hex'), '{"kind": "qa_item", "part": "question"}'::jsonb
  FROM qa_item_revision r
UNION ALL
SELECT r.tender_id, 'qa_item_revision', r.id, r.id, 'qa_answer', 'text_block', 'qa:answer', 1, r.answer,
       encode(sha256(convert_to(r.answer, 'UTF8')), 'hex'), '{"kind": "qa_item", "part": "answer"}'::jsonb
  FROM qa_item_revision r WHERE r.answer IS NOT NULL;

-- Последняя ревизия вопроса — выбор снимка.
CREATE FUNCTION qa_item_latest_revision(p_item uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM qa_item_revision WHERE item_id = p_item ORDER BY seq DESC LIMIT 1
$$;

-- Вопросы этапа: ветки тендера без этапа или с этим этапом (как связь письма).
CREATE FUNCTION qa_item_in_stage(p_item uuid, p_tender uuid, p_stage uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM qa_item i JOIN qa_thread t ON t.id = i.thread_id
                  WHERE i.id = p_item AND t.tender_id = p_tender AND (t.stage_id IS NULL OR t.stage_id = p_stage))
$$;

-- Единица снимка «ревизия вопроса–ответа».
ALTER TABLE evidence_scope_item ADD COLUMN qa_item_revision_id uuid;
ALTER TABLE evidence_scope_item DROP CONSTRAINT evidence_scope_item_unit_type_check, DROP CONSTRAINT evidence_scope_item_unit_shape;
ALTER TABLE evidence_scope_item
  ADD CONSTRAINT evidence_scope_item_unit_type_check
    CHECK (unit_type IN ('document_recognition', 'mail_message', 'transcript_revision', 'qa_item_revision')),
  ADD CONSTRAINT evidence_scope_item_unit_shape CHECK (
    CASE unit_type
      WHEN 'document_recognition' THEN document_revision_id IS NOT NULL
        AND num_nonnulls(contract_id, mail_message_id) <= 1
        AND num_nonnulls(mail_message_revision_id, transcript_revision_id, qa_item_revision_id) = 0
      WHEN 'mail_message' THEN mail_message_revision_id IS NOT NULL AND mail_message_id IS NOT NULL
        AND num_nonnulls(document_revision_id, recognition_run_id, contract_id, transcript_revision_id, qa_item_revision_id) = 0
      WHEN 'transcript_revision' THEN transcript_revision_id IS NOT NULL
        AND num_nonnulls(document_revision_id, recognition_run_id, contract_id, mail_message_revision_id, mail_message_id, qa_item_revision_id) = 0
      WHEN 'qa_item_revision' THEN qa_item_revision_id IS NOT NULL
        AND num_nonnulls(document_revision_id, recognition_run_id, contract_id, mail_message_revision_id, mail_message_id, transcript_revision_id) = 0
      ELSE false
    END),
  ADD CONSTRAINT evidence_scope_item_qa_fk FOREIGN KEY (qa_item_revision_id, tender_id) REFERENCES qa_item_revision (id, tender_id),
  ADD CONSTRAINT evidence_scope_item_qa_key UNIQUE (scope_id, qa_item_revision_id);

CREATE OR REPLACE FUNCTION evidence_scope_item_insert_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_stage uuid;
BEGIN
  SELECT stage_id INTO v_stage FROM evidence_scope WHERE id = NEW.scope_id;
  IF NEW.unit_type = 'qa_item_revision' THEN
    -- Вопрос–ответ входит в снимок, если его ветка относится к тендеру снимка без этапа или к этапу снимка, —
    -- последней ревизией вопроса на момент создания (Р-08-1).
    IF NOT EXISTS (SELECT 1 FROM qa_item_revision r
                    WHERE r.id = NEW.qa_item_revision_id AND qa_item_in_stage(r.item_id, NEW.tender_id, v_stage)) THEN
      RAISE EXCEPTION 'evidence_scope_item: вопрос–ответ не относится к тендеру и этапу снимка' USING ERRCODE = '23514';
    END IF;
    IF NEW.qa_item_revision_id IS DISTINCT FROM (
         SELECT qa_item_latest_revision(r.item_id) FROM qa_item_revision r WHERE r.id = NEW.qa_item_revision_id) THEN
      RAISE EXCEPTION 'evidence_scope_item: в снимок входит последняя ревизия вопроса–ответа' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.unit_type = 'mail_message' THEN
    -- Письмо входит в снимок при действующей связи с тендером (и этапом) снимка — последней ревизией.
    IF NOT mail_message_linked(NEW.mail_message_id, NEW.tender_id, v_stage) THEN
      RAISE EXCEPTION 'evidence_scope_item: письмо не связано с тендером снимка действующей связью (OD-07-7)' USING ERRCODE = '23514';
    END IF;
    IF NEW.mail_message_revision_id IS DISTINCT FROM mail_message_latest_revision(NEW.mail_message_id) THEN
      RAISE EXCEPTION 'evidence_scope_item: в снимок входит последняя ревизия письма на момент создания' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.unit_type = 'transcript_revision' THEN
    IF NEW.transcript_revision_id IS DISTINCT FROM (
         SELECT transcript_latest_revision(r.session_id) FROM transcript_revision r WHERE r.id = NEW.transcript_revision_id) THEN
      RAISE EXCEPTION 'evidence_scope_item: в снимок входит последняя редакция транскрипции сессии' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.recognition_run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM recognition_run r WHERE r.id = NEW.recognition_run_id AND r.status IN ('complete', 'partial')) THEN
    RAISE EXCEPTION 'evidence_scope_item: в снимок входит только завершённый прогон распознавания' USING ERRCODE = '23514';
  END IF;
  IF NEW.recognition_run_id IS DISTINCT FROM recognition_preferred_run(NEW.document_revision_id) THEN
    RAISE EXCEPTION 'evidence_scope_item: в снимок входит предпочтительный прогон редакции (AD-05a-3)' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM evidence_scope s
         JOIN source_set_item i ON i.source_set_revision_id = s.source_set_revision_id
        WHERE s.id = NEW.scope_id AND i.document_revision_id = NEW.document_revision_id
          AND i.inclusion <> 'excluded_not_applicable') THEN
    RAISE EXCEPTION 'evidence_scope_item: редакция не включена в основу снимка' USING ERRCODE = '23514';
  END IF;
  IF NEW.contract_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM contract_tender l
        WHERE l.contract_id = NEW.contract_id AND l.tender_id = NEW.tender_id AND l.status = 'active') THEN
    RAISE EXCEPTION 'evidence_scope_item: договор не связан с тендером снимка действующей связью' USING ERRCODE = '23514';
  END IF;
  -- Документ вложения: письмо единицы — письмо вложения, связь с тендером снимка действует.
  IF document_revision_mail_owned(NEW.document_revision_id) THEN
    IF NEW.mail_message_id IS DISTINCT FROM document_revision_mail_message(NEW.document_revision_id) THEN
      RAISE EXCEPTION 'evidence_scope_item: письмо единицы не совпадает с письмом вложения' USING ERRCODE = '23514';
    END IF;
    IF NOT mail_message_linked(NEW.mail_message_id, NEW.tender_id, v_stage) THEN
      RAISE EXCEPTION 'evidence_scope_item: письмо вложения не связано с тендером снимка действующей связью' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.mail_message_id IS NOT NULL THEN
    RAISE EXCEPTION 'evidence_scope_item: ссылка на письмо есть только у единицы вложения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Хэш состава: строка Q&A — [вид, '', '', '', '', ID ревизии]; строки прежних видов не меняются,
-- поэтому хэш существующих снимков прежний. Та же формула — evidenceScopeContentHash в @kontur/core.
CREATE OR REPLACE FUNCTION evidence_scope_composition_hash(p_scope uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
           'kontur.evidence_scope.v1' || E'\n' || r.content_hash || E'\n[' ||
           coalesce((SELECT string_agg(u.row_json, ',' ORDER BY u.sort_key COLLATE "C")
                       FROM (SELECT CASE WHEN i.unit_type = 'qa_item_revision'
                                      THEN '["qa_item_revision","","","","","' || i.qa_item_revision_id::text || '"]'
                                      ELSE '["' || i.unit_type || '","' || coalesce(i.document_revision_id::text, '') || '","'
                                           || coalesce(i.recognition_run_id::text, '') || '","'
                                           || coalesce(i.mail_message_revision_id::text, '') || '","'
                                           || coalesce(i.transcript_revision_id::text, '') || '"]' END AS row_json,
                                    CASE WHEN i.unit_type = 'qa_item_revision'
                                      THEN 'qa_item_revision|||||' || i.qa_item_revision_id::text
                                      ELSE i.unit_type || '|' || coalesce(i.document_revision_id::text, '') || '|'
                                           || coalesce(i.recognition_run_id::text, '') || '|'
                                           || coalesce(i.mail_message_revision_id::text, '') || '|'
                                           || coalesce(i.transcript_revision_id::text, '') END AS sort_key
                               FROM evidence_scope_item i
                              WHERE i.scope_id = s.id) u), '') || ']',
           'UTF8')), 'hex')
    FROM evidence_scope s
    JOIN source_set_revision r ON r.id = s.source_set_revision_id
   WHERE s.id = p_scope
$$;

-- Полнота (state-machines §5.1) + каждый вопрос веток этапа — последней ревизией.
CREATE OR REPLACE FUNCTION evidence_scope_verify(p_scope uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_base   uuid;
  v_hash   text;
  v_tender uuid;
  v_stage  uuid;
BEGIN
  SELECT source_set_revision_id, content_hash, tender_id, stage_id INTO v_base, v_hash, v_tender, v_stage
    FROM evidence_scope WHERE id = p_scope;
  IF EXISTS (
       SELECT 1 FROM source_set_item i
        WHERE i.source_set_revision_id = v_base AND i.inclusion <> 'excluded_not_applicable'
          AND NOT EXISTS (SELECT 1 FROM evidence_scope_item e WHERE e.scope_id = p_scope AND e.document_revision_id = i.document_revision_id)) THEN
    RAISE EXCEPTION 'evidence_scope %: состав неполон — включённая редакция основы не вошла в снимок', p_scope
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
       SELECT 1 FROM mail_message_tender l
        WHERE l.tender_id = v_tender AND l.status = 'linked' AND (l.stage_id IS NULL OR l.stage_id = v_stage)
          AND NOT EXISTS (SELECT 1 FROM evidence_scope_item e
                           WHERE e.scope_id = p_scope AND e.unit_type = 'mail_message' AND e.mail_message_id = l.message_id)) THEN
    RAISE EXCEPTION 'evidence_scope %: состав неполон — связанное письмо не вошло в снимок', p_scope USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
       SELECT 1 FROM negotiation_session s
        WHERE s.tender_id = v_tender AND transcript_latest_revision(s.id) IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM evidence_scope_item e
                           WHERE e.scope_id = p_scope AND e.transcript_revision_id = transcript_latest_revision(s.id))) THEN
    RAISE EXCEPTION 'evidence_scope %: состав неполон — редакция транскрипции не вошла в снимок', p_scope USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
       SELECT 1 FROM qa_item i JOIN qa_thread t ON t.id = i.thread_id
        WHERE t.tender_id = v_tender AND (t.stage_id IS NULL OR t.stage_id = v_stage)
          AND NOT EXISTS (SELECT 1 FROM evidence_scope_item e
                           WHERE e.scope_id = p_scope AND e.qa_item_revision_id = qa_item_latest_revision(i.id))) THEN
    RAISE EXCEPTION 'evidence_scope %: состав неполон — вопрос–ответ этапа не вошёл в снимок', p_scope USING ERRCODE = '23514';
  END IF;
  IF evidence_scope_composition_hash(p_scope) IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'evidence_scope %: content_hash не соответствует составу единиц', p_scope USING ERRCODE = '23514';
  END IF;
END;
$$;

-- ---------------------------------------------------------------- Фрагменты снимка

-- Происхождение, допустимое для полноты, входа модели и основания supports: проектный и исходный текст.
-- Описание модели RDWeb (I06) и подсказка участнику переговоров основанием не являются.
CREATE FUNCTION evidence_origin_reviewable(p_origin text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_origin IN ('document_text', 'recognized_text', 'email_body', 'attachment_text', 'negotiation_speech', 'qa_question', 'qa_answer')
$$;

-- Основание факта (D-018): только письменный текст документа, письма, вложения и ответ заказчика Q&A;
-- не описание модели, не речь переговоров (устное ≠ согласованное, I08) и не вопрос участника.
CREATE FUNCTION evidence_origin_fact_basis(p_origin text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_origin IN ('document_text', 'recognized_text', 'email_body', 'attachment_text', 'qa_answer')
$$;

-- Фрагмент входит в снимок: его единица источника — единица снимка (у единицы документа — её прогон).
CREATE FUNCTION evidence_scope_has_fragment(p_scope uuid, p_fragment uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM evidence_fragment f
      JOIN evidence_scope_item i
        ON i.scope_id = p_scope
       AND f.source_unit_id = coalesce(i.recognition_run_id, i.mail_message_revision_id, i.transcript_revision_id, i.qa_item_revision_id)
     WHERE f.id = p_fragment)
$$;

-- ---------------------------------------------------------------- Реестр требований (Р-08-6)

-- Реестр закреплён на снимке. Первый реестр этапа — seq 1 без предыдущего; переход на новый снимок —
-- новый реестр со ссылкой на действующий. Прежний реестр не меняется.
CREATE TABLE requirement_registry (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id            uuid NOT NULL,
  stage_id             uuid NOT NULL,
  evidence_scope_id    uuid NOT NULL,
  seq                  int NOT NULL CHECK (seq > 0),
  previous_registry_id uuid,
  reason               text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_by           uuid NOT NULL REFERENCES app_user (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requirement_registry_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT requirement_registry_scope_fk FOREIGN KEY (evidence_scope_id, tender_id) REFERENCES evidence_scope (id, tender_id),
  CONSTRAINT requirement_registry_seq_key UNIQUE (stage_id, seq),
  CONSTRAINT requirement_registry_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT requirement_registry_id_stage_key UNIQUE (id, stage_id),
  CONSTRAINT requirement_registry_id_scope_key UNIQUE (id, evidence_scope_id),
  CONSTRAINT requirement_registry_previous_fk FOREIGN KEY (previous_registry_id, stage_id) REFERENCES requirement_registry (id, stage_id),
  CONSTRAINT requirement_registry_previous_shape CHECK ((seq = 1) = (previous_registry_id IS NULL))
);
CREATE UNIQUE INDEX requirement_registry_previous_key ON requirement_registry (previous_registry_id) WHERE previous_registry_id IS NOT NULL;

-- Явный указатель активного реестра этапа (не MAX(created_at)).
CREATE TABLE requirement_registry_active (
  stage_id    uuid PRIMARY KEY,
  tender_id   uuid NOT NULL,
  registry_id uuid NOT NULL,
  updated_by  uuid NOT NULL REFERENCES app_user (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT requirement_registry_active_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT requirement_registry_active_registry_fk FOREIGN KEY (registry_id, stage_id) REFERENCES requirement_registry (id, stage_id)
);

CREATE FUNCTION requirement_registry_is_active(p_registry uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM requirement_registry_active a WHERE a.registry_id = p_registry)
$$;

-- Новый реестр: снимок того же этапа, автор с requirement.manage, номер — следующий, предыдущий — действующий.
-- Создания сериализуются по этапу; две параллельные попытки не дадут двух преемников одного реестра.
CREATE FUNCTION requirement_registry_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active uuid;
  v_last   int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('requirement_registry'), hashtext(NEW.stage_id::text));
  IF NOT EXISTS (SELECT 1 FROM evidence_scope s WHERE s.id = NEW.evidence_scope_id AND s.stage_id = NEW.stage_id) THEN
    RAISE EXCEPTION 'requirement_registry: снимок другого этапа' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.created_by, NEW.stage_id, 'requirement.manage') THEN
    RAISE EXCEPTION 'requirement_registry: реестр создаёт пользователь с requirement.manage' USING ERRCODE = '42501';
  END IF;
  SELECT registry_id INTO v_active FROM requirement_registry_active WHERE stage_id = NEW.stage_id;
  SELECT max(seq) INTO v_last FROM requirement_registry WHERE stage_id = NEW.stage_id;
  IF NEW.seq <> coalesce(v_last, 0) + 1 OR NEW.previous_registry_id IS DISTINCT FROM v_active THEN
    RAISE EXCEPTION 'requirement_registry: новый реестр встаёт за действующим реестром этапа' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_registry_insert_guard BEFORE INSERT ON requirement_registry
  FOR EACH ROW EXECUTE FUNCTION requirement_registry_insert_guard();
CREATE TRIGGER requirement_registry_immutable BEFORE UPDATE OR DELETE ON requirement_registry
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER requirement_registry_no_truncate BEFORE TRUNCATE ON requirement_registry
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Указатель: первый — на реестр seq 1, дальше — только на преемника текущего; автор — requirement.manage.
CREATE FUNCTION requirement_registry_active_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT has_stage_capability(NEW.updated_by, NEW.stage_id, 'requirement.manage') THEN
    RAISE EXCEPTION 'requirement_registry_active: активный реестр меняет пользователь с requirement.manage' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM requirement_registry r WHERE r.id = NEW.registry_id AND r.seq = 1) THEN
      RAISE EXCEPTION 'requirement_registry_active: первый активный реестр этапа — реестр № 1' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.stage_id <> OLD.stage_id OR NEW.tender_id <> OLD.tender_id OR NEW.row_version <> OLD.row_version + 1 THEN
      RAISE EXCEPTION 'requirement_registry_active: меняется только реестр (row_version + 1)' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM requirement_registry r WHERE r.id = NEW.registry_id AND r.previous_registry_id = OLD.registry_id) THEN
      RAISE EXCEPTION 'requirement_registry_active: активным становится только преемник текущего реестра' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_registry_active_guard BEFORE INSERT OR UPDATE ON requirement_registry_active
  FOR EACH ROW EXECUTE FUNCTION requirement_registry_active_guard();
CREATE TRIGGER requirement_registry_active_no_delete BEFORE DELETE ON requirement_registry_active
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('pointer');
CREATE TRIGGER requirement_registry_active_no_truncate BEFORE TRUNCATE ON requirement_registry_active
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('pointer');

-- Созданный реестр становится активным в той же транзакции: создание и активация неразделимы.
CREATE FUNCTION requirement_registry_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM requirement_registry_active a WHERE a.stage_id = NEW.stage_id AND a.registry_id = NEW.id) THEN
    RAISE EXCEPTION 'requirement_registry: новый реестр не стал активным в транзакции создания' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER requirement_registry_commit_check AFTER INSERT ON requirement_registry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION requirement_registry_commit_check();

-- ---------------------------------------------------------------- Прогон анализа (Model run)

CREATE TABLE analysis_run (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id             uuid NOT NULL,
  stage_id              uuid NOT NULL,
  registry_id           uuid NOT NULL,
  evidence_scope_id     uuid NOT NULL,
  task                  text NOT NULL CHECK (task IN ('requirement_extraction', 'fact_extraction')),
  provider_id           text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 60),
  model_id              text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  model_version         text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 200),
  prompt_version        text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 60),
  prompt_sha256         text NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  inference_config      jsonb NOT NULL CHECK (jsonb_typeof(inference_config) = 'object'),
  config_sha256         text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  output_schema_version text NOT NULL CHECK (length(output_schema_version) BETWEEN 1 AND 60),
  input_sha256          text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  input_count           int NOT NULL CHECK (input_count >= 0),
  attempt               int NOT NULL CHECK (attempt > 0),
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'completed_with_gaps', 'failed')),
  failure_code          text CHECK (length(failure_code) BETWEEN 1 AND 60),
  coverage              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(coverage) = 'object'),
  progress              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
  result                jsonb,
  requested_by          uuid NOT NULL REFERENCES app_user (id),
  job_id                uuid REFERENCES job (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_xact          xid8 NOT NULL DEFAULT pg_current_xact_id(),
  started_at            timestamptz,
  finished_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           bigint NOT NULL DEFAULT 1,
  CONSTRAINT analysis_run_registry_scope_fk FOREIGN KEY (registry_id, evidence_scope_id) REFERENCES requirement_registry (id, evidence_scope_id),
  CONSTRAINT analysis_run_registry_tender_fk FOREIGN KEY (registry_id, tender_id) REFERENCES requirement_registry (id, tender_id),
  CONSTRAINT analysis_run_registry_stage_fk FOREIGN KEY (registry_id, stage_id) REFERENCES requirement_registry (id, stage_id),
  CONSTRAINT analysis_run_id_registry_key UNIQUE (id, registry_id),
  CONSTRAINT analysis_run_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT analysis_run_attempt_key UNIQUE (registry_id, task, provider_id, model_id, model_version, prompt_sha256, config_sha256, input_sha256, attempt),
  CONSTRAINT analysis_run_status_shape CHECK (
    CASE status
      WHEN 'queued' THEN started_at IS NULL AND finished_at IS NULL AND failure_code IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND finished_at IS NULL AND failure_code IS NULL
      WHEN 'failed' THEN finished_at IS NOT NULL AND failure_code IS NOT NULL
      ELSE started_at IS NOT NULL AND finished_at IS NOT NULL
    END)
);
-- Повтор с теми же реестром, задачей, моделью, промптом, настройками и входом — тот же прогон, пока он не
-- завершился отказом; после отказа — новая попытка (И-08-3).
CREATE UNIQUE INDEX analysis_run_repeat_key ON analysis_run (registry_id, task, provider_id, model_id, model_version, prompt_sha256, config_sha256, input_sha256)
  WHERE status <> 'failed';
CREATE INDEX analysis_run_registry_idx ON analysis_run (registry_id, created_at DESC);

-- Вход прогона: фрагменты снимка допустимого происхождения, которые запустивший может читать (И-08-2).
CREATE TABLE analysis_run_input (
  run_id      uuid NOT NULL REFERENCES analysis_run (id),
  fragment_id uuid NOT NULL REFERENCES evidence_fragment (id),
  PRIMARY KEY (run_id, fragment_id)
);

-- Хэш входа (менять вместе с analysisInputHash в @kontur/core): отсортированные пары «ID фрагмента:SHA-256 текста».
CREATE FUNCTION analysis_input_hash(p_run uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to('kontur.analysis_input.v1' || E'\n' ||
           coalesce(string_agg(f.id::text || ':' || f.text_sha256, ',' ORDER BY f.id::text COLLATE "C"), ''), 'UTF8')), 'hex')
    FROM analysis_run_input i JOIN evidence_fragment f ON f.id = i.fragment_id
   WHERE i.run_id = p_run
$$;

CREATE FUNCTION analysis_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last int;
BEGIN
  IF NEW.status <> 'queued' OR NEW.result IS NOT NULL OR NEW.row_version <> 1 THEN
    RAISE EXCEPTION 'analysis_run: прогон создаётся в состоянии queued' USING ERRCODE = '55000';
  END IF;
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'analysis_run: прогон запускается только в активном реестре этапа' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.requested_by, NEW.stage_id, 'analysis.run') THEN
    RAISE EXCEPTION 'analysis_run: прогон запускает пользователь с analysis.run' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('analysis_run'), hashtext(NEW.registry_id::text || NEW.input_sha256 || NEW.prompt_sha256 || NEW.config_sha256));
  SELECT max(attempt) INTO v_last FROM analysis_run
   WHERE registry_id = NEW.registry_id AND task = NEW.task AND provider_id = NEW.provider_id AND model_id = NEW.model_id
     AND model_version = NEW.model_version AND prompt_sha256 = NEW.prompt_sha256 AND config_sha256 = NEW.config_sha256
     AND input_sha256 = NEW.input_sha256;
  IF NEW.attempt <> coalesce(v_last, 0) + 1 THEN
    RAISE EXCEPTION 'analysis_run: номер попытки — следующий для того же ключа повтора' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_run_insert_guard BEFORE INSERT ON analysis_run
  FOR EACH ROW EXECUTE FUNCTION analysis_run_insert_guard();

-- Меняются только ход и итог; переходы вперёд; после финала прогон неизменен (frozen-after).
CREATE FUNCTION analysis_run_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.registry_id, NEW.evidence_scope_id, NEW.task, NEW.provider_id, NEW.model_id,
      NEW.model_version, NEW.prompt_version, NEW.prompt_sha256, NEW.inference_config, NEW.config_sha256, NEW.output_schema_version,
      NEW.input_sha256, NEW.input_count, NEW.attempt, NEW.requested_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.registry_id, OLD.evidence_scope_id, OLD.task, OLD.provider_id, OLD.model_id,
      OLD.model_version, OLD.prompt_version, OLD.prompt_sha256, OLD.inference_config, OLD.config_sha256, OLD.output_schema_version,
      OLD.input_sha256, OLD.input_count, OLD.attempt, OLD.requested_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'analysis_run: условия прогона неизменны' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed', 'completed_with_gaps', 'failed') THEN
    RAISE EXCEPTION 'analysis_run: завершённый прогон неизменен' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'analysis_run: row_version увеличивается на 1' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = NEW.status)
       OR (OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
       OR (OLD.status = 'running' AND NEW.status IN ('completed', 'completed_with_gaps', 'failed'))) THEN
    RAISE EXCEPTION 'analysis_run: недопустимый переход % → %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_run_update_guard BEFORE UPDATE ON analysis_run
  FOR EACH ROW EXECUTE FUNCTION analysis_run_update_guard();
CREATE TRIGGER analysis_run_no_delete BEFORE DELETE ON analysis_run
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER analysis_run_no_truncate BEFORE TRUNCATE ON analysis_run
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Вход пишет транзакция создания прогона; фрагмент — в снимке прогона, допустимого происхождения.
CREATE FUNCTION analysis_run_input_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run analysis_run%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM analysis_run WHERE id = NEW.run_id;
  IF v_run.created_xact <> pg_current_xact_id() OR v_run.status <> 'queued' THEN
    RAISE EXCEPTION 'analysis_run_input: вход пишет только транзакция создания прогона' USING ERRCODE = '55000';
  END IF;
  IF NOT evidence_scope_has_fragment(v_run.evidence_scope_id, NEW.fragment_id) THEN
    RAISE EXCEPTION 'analysis_run_input: фрагмент вне снимка прогона' USING ERRCODE = '23514';
  END IF;
  IF NOT evidence_origin_reviewable((SELECT origin FROM evidence_fragment WHERE id = NEW.fragment_id)) THEN
    RAISE EXCEPTION 'analysis_run_input: происхождение фрагмента не допускается во вход модели (I06)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_run_input_guard BEFORE INSERT ON analysis_run_input
  FOR EACH ROW EXECUTE FUNCTION analysis_run_input_guard();
CREATE TRIGGER analysis_run_input_immutable BEFORE UPDATE OR DELETE ON analysis_run_input
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER analysis_run_input_no_truncate BEFORE TRUNCATE ON analysis_run_input
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- При фиксации: число и хэш входа совпадают с заявленными — ключ повтора честен.
CREATE FUNCTION analysis_run_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM analysis_run_input WHERE run_id = NEW.id) <> NEW.input_count
     OR analysis_input_hash(NEW.id) IS DISTINCT FROM NEW.input_sha256 THEN
    RAISE EXCEPTION 'analysis_run: вход прогона не совпадает с заявленными числом и хэшем' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER analysis_run_commit_check AFTER INSERT ON analysis_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION analysis_run_commit_check();

-- ---------------------------------------------------------------- Требования: идентичность и ревизии (AD-08-1)

-- Идентичность требования — на этапе; ревизии закреплены за реестром. Указатель — на последнюю ревизию.
CREATE TABLE requirement (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id           uuid NOT NULL,
  stage_id            uuid NOT NULL,
  code                text NOT NULL CHECK (code ~ '^R-[0-9]{4,}$'),
  current_revision_id uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         bigint NOT NULL DEFAULT 1,
  CONSTRAINT requirement_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT requirement_code_key UNIQUE (stage_id, code),
  CONSTRAINT requirement_id_stage_key UNIQUE (id, stage_id),
  CONSTRAINT requirement_id_tender_key UNIQUE (id, tender_id)
);

CREATE TABLE requirement_revision (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id               uuid NOT NULL,
  tender_id                    uuid NOT NULL,
  stage_id                     uuid NOT NULL,
  registry_id                  uuid NOT NULL,
  seq                          int NOT NULL CHECK (seq > 0),
  supersedes_revision_id       uuid REFERENCES requirement_revision (id),
  status                       text NOT NULL CHECK (status IN ('confirmed', 'superseded')),
  change_kind                  text NOT NULL CHECK (change_kind IN ('confirmation', 'carry_over', 'supersede')),
  candidate_id                 uuid,
  carried_from_revision_id     uuid REFERENCES requirement_revision (id),
  statement                    text NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  parameters                   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parameters) = 'array'),
  object_scope                 jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(object_scope) = 'object'),
  superseded_by_requirement_id uuid,
  reason                       text CHECK (length(reason) BETWEEN 1 AND 1000),
  authored_by                  uuid NOT NULL REFERENCES app_user (id),
  confirmed_by                 uuid NOT NULL REFERENCES app_user (id),
  content_sha256               text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_xact                 xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT requirement_revision_requirement_fk FOREIGN KEY (requirement_id, stage_id) REFERENCES requirement (id, stage_id),
  CONSTRAINT requirement_revision_registry_fk FOREIGN KEY (registry_id, stage_id) REFERENCES requirement_registry (id, stage_id),
  CONSTRAINT requirement_revision_registry_tender_fk FOREIGN KEY (registry_id, tender_id) REFERENCES requirement_registry (id, tender_id),
  CONSTRAINT requirement_revision_superseded_by_fk FOREIGN KEY (superseded_by_requirement_id, stage_id) REFERENCES requirement (id, stage_id),
  CONSTRAINT requirement_revision_seq_key UNIQUE (requirement_id, seq),
  CONSTRAINT requirement_revision_id_requirement_key UNIQUE (id, requirement_id),
  CONSTRAINT requirement_revision_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT requirement_revision_id_registry_key UNIQUE (id, registry_id),
  CONSTRAINT requirement_revision_history_shape CHECK ((seq = 1) = (supersedes_revision_id IS NULL)),
  CONSTRAINT requirement_revision_kind_shape CHECK (
    CASE change_kind
      WHEN 'confirmation' THEN candidate_id IS NOT NULL AND carried_from_revision_id IS NULL AND status = 'confirmed' AND superseded_by_requirement_id IS NULL
      WHEN 'carry_over' THEN carried_from_revision_id IS NOT NULL AND candidate_id IS NULL AND status = 'confirmed' AND superseded_by_requirement_id IS NULL AND seq > 1
      WHEN 'supersede' THEN status = 'superseded' AND superseded_by_requirement_id IS NOT NULL AND candidate_id IS NULL AND carried_from_revision_id IS NULL
                            AND superseded_by_requirement_id <> requirement_id AND seq > 1
    END)
);
CREATE INDEX requirement_revision_registry_idx ON requirement_revision (registry_id);
ALTER TABLE requirement ADD CONSTRAINT requirement_current_fk
  FOREIGN KEY (current_revision_id, id) REFERENCES requirement_revision (id, requirement_id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------- Кандидаты (AD-08-2, «Candidate confirmation»)

-- Кандидат требования: модель, правило, человек или явный перенос (carried). Содержание после создания
-- не меняется; меняется только статус из proposed.
CREATE TABLE requirement_candidate (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                 uuid NOT NULL,
  stage_id                  uuid NOT NULL,
  registry_id               uuid NOT NULL,
  origin                    text NOT NULL CHECK (origin IN ('human', 'model', 'rule', 'carried')),
  analysis_run_id           uuid,
  candidate_key             text CHECK (candidate_key ~ '^[0-9a-f]{64}$'),
  target_requirement_id     uuid,
  rebased_from_candidate_id uuid REFERENCES requirement_candidate (id),
  carried_from_revision_id  uuid REFERENCES requirement_revision (id),
  derived_from_candidate_id uuid REFERENCES requirement_candidate (id),
  statement                 text NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  parameters                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parameters) = 'array'),
  object_scope              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(object_scope) = 'object'),
  rationale                 text CHECK (length(rationale) BETWEEN 1 AND 4000),
  confidence                numeric CHECK (confidence >= 0 AND confidence <= 1),
  status                    text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'rejected', 'superseded')),
  status_reason             text CHECK (length(status_reason) BETWEEN 1 AND 1000),
  decided_by                uuid REFERENCES app_user (id),
  decided_at                timestamptz,
  created_by                uuid NOT NULL REFERENCES app_user (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_xact              xid8 NOT NULL DEFAULT pg_current_xact_id(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  row_version               bigint NOT NULL DEFAULT 1,
  CONSTRAINT requirement_candidate_registry_fk FOREIGN KEY (registry_id, stage_id) REFERENCES requirement_registry (id, stage_id),
  CONSTRAINT requirement_candidate_registry_tender_fk FOREIGN KEY (registry_id, tender_id) REFERENCES requirement_registry (id, tender_id),
  CONSTRAINT requirement_candidate_run_fk FOREIGN KEY (analysis_run_id, registry_id) REFERENCES analysis_run (id, registry_id),
  CONSTRAINT requirement_candidate_target_fk FOREIGN KEY (target_requirement_id, stage_id) REFERENCES requirement (id, stage_id),
  CONSTRAINT requirement_candidate_key UNIQUE (analysis_run_id, candidate_key),
  CONSTRAINT requirement_candidate_rebase_key UNIQUE (rebased_from_candidate_id, registry_id),
  CONSTRAINT requirement_candidate_id_registry_key UNIQUE (id, registry_id),
  CONSTRAINT requirement_candidate_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT requirement_candidate_origin_shape CHECK (
    CASE origin
      WHEN 'human' THEN num_nonnulls(analysis_run_id, candidate_key, rebased_from_candidate_id, carried_from_revision_id) = 0
      WHEN 'carried' THEN analysis_run_id IS NULL AND candidate_key IS NULL
                          AND num_nonnulls(rebased_from_candidate_id, carried_from_revision_id) = 1
      ELSE analysis_run_id IS NOT NULL AND candidate_key IS NOT NULL
           AND num_nonnulls(rebased_from_candidate_id, carried_from_revision_id, derived_from_candidate_id) = 0
    END),
  CONSTRAINT requirement_candidate_decision_shape CHECK (
    (status = 'proposed') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)
    AND (status <> 'rejected' OR status_reason IS NOT NULL))
);
CREATE INDEX requirement_candidate_registry_idx ON requirement_candidate (registry_id, status, created_at);
CREATE UNIQUE INDEX requirement_candidate_derived_key ON requirement_candidate (derived_from_candidate_id) WHERE derived_from_candidate_id IS NOT NULL;
ALTER TABLE requirement_revision ADD CONSTRAINT requirement_revision_candidate_fk
  FOREIGN KEY (candidate_id, registry_id) REFERENCES requirement_candidate (id, registry_id);
CREATE UNIQUE INDEX requirement_revision_candidate_key ON requirement_revision (candidate_id) WHERE candidate_id IS NOT NULL;

-- Хэш содержания ревизии: формулировка, параметры, область (jsonb — каноническая форма).
CREATE FUNCTION requirement_content_hash(p_statement text, p_parameters jsonb, p_scope jsonb) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to('kontur.requirement.v1' || E'\n' || p_statement || E'\n' || p_parameters::text || E'\n' || p_scope::text, 'UTF8')), 'hex')
$$;

-- Создание кандидата: только в активном реестре. Ручной — автор с requirement.create; модельный и правиловой —
-- выполняющийся прогон того же реестра, автор — запустивший; перенесённый — явной операцией (requirement.create):
-- исходный кандидат или ревизия — из предыдущего реестра этапа. Производный (правка) — от предложения того же реестра.
CREATE FUNCTION requirement_candidate_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_reg requirement_registry%ROWTYPE;
BEGIN
  IF NEW.status <> 'proposed' OR NEW.row_version <> 1 THEN
    RAISE EXCEPTION 'requirement_candidate: кандидат создаётся в состоянии proposed' USING ERRCODE = '55000';
  END IF;
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'requirement_candidate: кандидат создаётся только в активном реестре этапа' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_reg FROM requirement_registry WHERE id = NEW.registry_id;
  IF NEW.origin IN ('model', 'rule') THEN
    IF NOT EXISTS (SELECT 1 FROM analysis_run r
                    WHERE r.id = NEW.analysis_run_id AND r.status = 'running' AND r.requested_by = NEW.created_by
                      AND r.task = 'requirement_extraction' AND (r.provider_id = 'rules') = (NEW.origin = 'rule')) THEN
      RAISE EXCEPTION 'requirement_candidate: кандидата модели пишет выполняющийся прогон извлечения требований' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT has_stage_capability(NEW.created_by, NEW.stage_id, 'requirement.create') THEN
    RAISE EXCEPTION 'requirement_candidate: кандидата создаёт пользователь с requirement.create' USING ERRCODE = '42501';
  END IF;
  IF NEW.rebased_from_candidate_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM requirement_candidate c JOIN requirement_registry r ON r.id = c.registry_id
        WHERE c.id = NEW.rebased_from_candidate_id AND c.status = 'proposed' AND r.stage_id = NEW.stage_id AND r.id <> NEW.registry_id
          AND (c.statement, c.parameters, c.object_scope, c.target_requirement_id) IS NOT DISTINCT FROM
              (NEW.statement, NEW.parameters, NEW.object_scope, NEW.target_requirement_id)) THEN
    RAISE EXCEPTION 'requirement_candidate: перенос — без изменения предложения другого реестра того же этапа' USING ERRCODE = '23514';
  END IF;
  IF NEW.carried_from_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM requirement_revision v
        WHERE v.id = NEW.carried_from_revision_id AND v.registry_id = v_reg.previous_registry_id AND v.status = 'confirmed'
          AND v.requirement_id = NEW.target_requirement_id
          AND (v.statement, v.parameters, v.object_scope) IS NOT DISTINCT FROM (NEW.statement, NEW.parameters, NEW.object_scope)) THEN
    RAISE EXCEPTION 'requirement_candidate: перенос требования — с подтверждённой ревизии предыдущего реестра' USING ERRCODE = '23514';
  END IF;
  IF NEW.derived_from_candidate_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM requirement_candidate c WHERE c.id = NEW.derived_from_candidate_id AND c.registry_id = NEW.registry_id AND c.status = 'proposed') THEN
    RAISE EXCEPTION 'requirement_candidate: правка — новой версией предложения того же реестра' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_candidate_insert_guard BEFORE INSERT ON requirement_candidate
  FOR EACH ROW EXECUTE FUNCTION requirement_candidate_insert_guard();

-- Переход кандидата: только из proposed, только в активном реестре; подтверждение и отклонение — requirement.confirm;
-- замена — когда есть производный кандидат (правка).
CREATE FUNCTION requirement_candidate_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.registry_id, NEW.origin, NEW.analysis_run_id, NEW.candidate_key, NEW.target_requirement_id,
      NEW.rebased_from_candidate_id, NEW.carried_from_revision_id, NEW.derived_from_candidate_id, NEW.statement, NEW.parameters,
      NEW.object_scope, NEW.rationale, NEW.confidence, NEW.created_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.registry_id, OLD.origin, OLD.analysis_run_id, OLD.candidate_key, OLD.target_requirement_id,
      OLD.rebased_from_candidate_id, OLD.carried_from_revision_id, OLD.derived_from_candidate_id, OLD.statement, OLD.parameters,
      OLD.object_scope, OLD.rationale, OLD.confidence, OLD.created_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'requirement_candidate: содержание кандидата неизменно' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'proposed' OR NEW.status = 'proposed' OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'requirement_candidate: переход только из proposed (row_version + 1)' USING ERRCODE = '55000';
  END IF;
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'requirement_candidate: кандидат прежнего реестра не подтверждается и не отклоняется — нужен явный перенос' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('confirmed', 'rejected') AND NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'requirement.confirm') THEN
    RAISE EXCEPTION 'requirement_candidate: подтверждает и отклоняет пользователь с requirement.confirm' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'superseded' AND (NOT EXISTS (SELECT 1 FROM requirement_candidate c WHERE c.derived_from_candidate_id = NEW.id)
                                    OR NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'requirement.create')) THEN
    RAISE EXCEPTION 'requirement_candidate: предложение заменяется только новой версией (правкой)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_candidate_update_guard BEFORE UPDATE ON requirement_candidate
  FOR EACH ROW EXECUTE FUNCTION requirement_candidate_update_guard();
CREATE TRIGGER requirement_candidate_no_delete BEFORE DELETE ON requirement_candidate
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER requirement_candidate_no_truncate BEFORE TRUNCATE ON requirement_candidate
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Подтверждённый кандидат в той же транзакции получает ревизию требования (инвариант 2).
CREATE FUNCTION requirement_candidate_confirm_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM requirement_revision v WHERE v.candidate_id = NEW.id) THEN
    RAISE EXCEPTION 'requirement_candidate: подтверждение без ревизии требования' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER requirement_candidate_confirm_check AFTER UPDATE ON requirement_candidate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION requirement_candidate_confirm_check();

-- Ревизия требования: линейная история; только в активном реестре; по виду изменения — свои условия и право.
CREATE FUNCTION requirement_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last requirement_revision%ROWTYPE;
  v_cand requirement_candidate%ROWTYPE;
  v_from requirement_revision%ROWTYPE;
  v_reg  requirement_registry%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('requirement_revision'), hashtext(NEW.requirement_id::text));
  SELECT * INTO v_last FROM requirement_revision WHERE requirement_id = NEW.requirement_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_last.seq, 0) + 1 OR NEW.supersedes_revision_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'requirement_revision: новая ревизия встаёт за последней ревизией требования' USING ERRCODE = '40001';
  END IF;
  IF v_last.status = 'superseded' THEN
    RAISE EXCEPTION 'requirement_revision: заменённое требование не меняется' USING ERRCODE = '23514';
  END IF;
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'requirement_revision: ревизия пишется только в активный реестр этапа' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_reg FROM requirement_registry WHERE id = NEW.registry_id;
  NEW.content_sha256 := requirement_content_hash(NEW.statement, NEW.parameters, NEW.object_scope);
  IF NEW.change_kind = 'confirmation' THEN
    SELECT * INTO v_cand FROM requirement_candidate WHERE id = NEW.candidate_id;
    IF v_cand.status IS DISTINCT FROM 'confirmed' OR v_cand.registry_id <> NEW.registry_id OR v_cand.decided_by <> NEW.confirmed_by
       OR v_cand.created_by <> NEW.authored_by
       OR v_cand.target_requirement_id IS DISTINCT FROM (CASE WHEN NEW.seq = 1 THEN NULL ELSE NEW.requirement_id END) THEN
      RAISE EXCEPTION 'requirement_revision: подтверждение — по кандидату этого реестра в статусе confirmed (инвариант 2)' USING ERRCODE = '23514';
    END IF;
    IF v_last.id IS NOT NULL AND v_last.registry_id <> NEW.registry_id AND v_cand.carried_from_revision_id IS DISTINCT FROM v_last.id THEN
      RAISE EXCEPTION 'requirement_revision: требование прежнего реестра сначала переносится в активный' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'requirement.confirm') THEN
      RAISE EXCEPTION 'requirement_revision: подтверждает пользователь с requirement.confirm' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.change_kind = 'carry_over' THEN
    SELECT * INTO v_from FROM requirement_revision WHERE id = NEW.carried_from_revision_id;
    IF v_from.id IS DISTINCT FROM v_last.id OR v_last.registry_id IS DISTINCT FROM v_reg.previous_registry_id
       OR v_from.content_sha256 <> NEW.content_sha256 OR v_from.authored_by <> NEW.authored_by THEN
      RAISE EXCEPTION 'requirement_revision: перенос — без изменения последней ревизии из предыдущего реестра' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'requirement.manage') THEN
      RAISE EXCEPTION 'requirement_revision: перенос выполняет пользователь с requirement.manage' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_last.registry_id <> NEW.registry_id OR v_last.content_sha256 <> NEW.content_sha256 OR v_last.authored_by <> NEW.authored_by THEN
      RAISE EXCEPTION 'requirement_revision: замена не меняет содержание и выполняется в активном реестре' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM requirement q JOIN requirement_revision c ON c.id = q.current_revision_id
                    WHERE q.id = NEW.superseded_by_requirement_id AND c.status = 'confirmed' AND c.registry_id = NEW.registry_id) THEN
      RAISE EXCEPTION 'requirement_revision: заменяющее требование — действующее в активном реестре' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'requirement.manage') THEN
      RAISE EXCEPTION 'requirement_revision: заменяет пользователь с requirement.manage' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_revision_insert_guard BEFORE INSERT ON requirement_revision
  FOR EACH ROW EXECUTE FUNCTION requirement_revision_insert_guard();
CREATE TRIGGER requirement_revision_immutable BEFORE UPDATE OR DELETE ON requirement_revision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER requirement_revision_no_truncate BEFORE TRUNCATE ON requirement_revision
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Указатель требования — только на его последнюю ревизию; иначе требование неизменно.
CREATE FUNCTION requirement_pointer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ((NEW.id, NEW.tender_id, NEW.stage_id, NEW.code, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.code, OLD.created_at)
                           OR NEW.row_version <> OLD.row_version + 1) THEN
    RAISE EXCEPTION 'requirement: меняется только указатель на последнюю ревизию (row_version + 1)' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_pointer_guard BEFORE UPDATE ON requirement
  FOR EACH ROW EXECUTE FUNCTION requirement_pointer_guard();
CREATE TRIGGER requirement_no_delete BEFORE DELETE ON requirement
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('pointer');
CREATE TRIGGER requirement_no_truncate BEFORE TRUNCATE ON requirement
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('pointer');

-- При фиксации указатель — на последнюю ревизию (инвариант 1: требования без ревизии нет).
CREATE FUNCTION requirement_pointer_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_revision_id IS DISTINCT FROM (SELECT id FROM requirement_revision WHERE requirement_id = NEW.id ORDER BY seq DESC LIMIT 1) THEN
    RAISE EXCEPTION 'requirement: указатель не на последнюю ревизию требования' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER requirement_pointer_check AFTER INSERT OR UPDATE ON requirement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION requirement_pointer_check();

-- Новая ревизия обязана стать текущей в той же транзакции.
CREATE FUNCTION requirement_revision_current_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM requirement q WHERE q.id = NEW.requirement_id AND q.current_revision_id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM requirement_revision v WHERE v.requirement_id = NEW.requirement_id AND v.seq > NEW.seq) THEN
    RAISE EXCEPTION 'requirement_revision: новая ревизия не стала текущей' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER requirement_revision_current_check AFTER INSERT ON requirement_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION requirement_revision_current_check();

-- ---------------------------------------------------------------- Факты (OD-08-3, Р-08-4)

-- Справочник видов факта: заполняется только миграцией. Перечня 13 типов D-018 в репозитории нет (Р-08-4):
-- здесь только виды, названные D-018 и манифестом регрессии (И-08-10).
CREATE TABLE fact_kind (
  code             text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,59}$'),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  value_type       text NOT NULL CHECK (value_type IN ('text', 'amount', 'date', 'party')),
  normative_source text NOT NULL CHECK (length(normative_source) BETWEEN 1 AND 200),
  created_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fact_kind (code, title, value_type, normative_source) VALUES
  ('contract_party', 'Сторона договора', 'party', 'D-018: «стороны договора»'),
  ('contract_price', 'Цена договора', 'amount', 'D-018: «цена договора»'),
  ('estimate_total', 'Итог сметы', 'amount', 'D-018: «итог сметы»'),
  ('advance_payment', 'Аванс', 'amount', 'locus-regression-manifest.md, случай 11 pv2-amendment-advance');
CREATE TRIGGER fact_kind_immutable BEFORE UPDATE OR DELETE ON fact_kind
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('reference');
CREATE TRIGGER fact_kind_no_truncate BEFORE TRUNCATE ON fact_kind
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('reference');

CREATE TABLE fact (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id           uuid NOT NULL,
  stage_id            uuid NOT NULL,
  fact_kind           text NOT NULL REFERENCES fact_kind (code),
  current_revision_id uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         bigint NOT NULL DEFAULT 1,
  CONSTRAINT fact_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT fact_id_stage_key UNIQUE (id, stage_id),
  CONSTRAINT fact_id_kind_key UNIQUE (id, fact_kind)
);

CREATE TABLE fact_revision (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id                  uuid NOT NULL,
  tender_id                uuid NOT NULL,
  stage_id                 uuid NOT NULL,
  registry_id              uuid NOT NULL,
  fact_kind                text NOT NULL,
  seq                      int NOT NULL CHECK (seq > 0),
  supersedes_revision_id   uuid REFERENCES fact_revision (id),
  status                   text NOT NULL CHECK (status IN ('confirmed', 'superseded')),
  change_kind              text NOT NULL CHECK (change_kind IN ('confirmation', 'carry_over', 'supersede')),
  candidate_id             uuid,
  carried_from_revision_id uuid REFERENCES fact_revision (id),
  display_value            text NOT NULL CHECK (length(display_value) BETWEEN 1 AND 1000),
  normalized_value         jsonb NOT NULL CHECK (jsonb_typeof(normalized_value) = 'object'),
  unit                     text CHECK (length(unit) BETWEEN 1 AND 40),
  quality                  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quality) = 'object'),
  superseded_by_fact_id    uuid,
  reason                   text CHECK (length(reason) BETWEEN 1 AND 1000),
  authored_by              uuid NOT NULL REFERENCES app_user (id),
  confirmed_by             uuid NOT NULL REFERENCES app_user (id),
  content_sha256           text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_xact             xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT fact_revision_fact_fk FOREIGN KEY (fact_id, fact_kind) REFERENCES fact (id, fact_kind),
  CONSTRAINT fact_revision_fact_stage_fk FOREIGN KEY (fact_id, stage_id) REFERENCES fact (id, stage_id),
  CONSTRAINT fact_revision_registry_fk FOREIGN KEY (registry_id, stage_id) REFERENCES requirement_registry (id, stage_id),
  CONSTRAINT fact_revision_registry_tender_fk FOREIGN KEY (registry_id, tender_id) REFERENCES requirement_registry (id, tender_id),
  CONSTRAINT fact_revision_superseded_by_fk FOREIGN KEY (superseded_by_fact_id, stage_id) REFERENCES fact (id, stage_id),
  CONSTRAINT fact_revision_seq_key UNIQUE (fact_id, seq),
  CONSTRAINT fact_revision_id_fact_key UNIQUE (id, fact_id),
  CONSTRAINT fact_revision_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT fact_revision_history_shape CHECK ((seq = 1) = (supersedes_revision_id IS NULL)),
  CONSTRAINT fact_revision_kind_shape CHECK (
    CASE change_kind
      WHEN 'confirmation' THEN candidate_id IS NOT NULL AND carried_from_revision_id IS NULL AND status = 'confirmed' AND superseded_by_fact_id IS NULL
      WHEN 'carry_over' THEN carried_from_revision_id IS NOT NULL AND candidate_id IS NULL AND status = 'confirmed' AND superseded_by_fact_id IS NULL AND seq > 1
      WHEN 'supersede' THEN status = 'superseded' AND superseded_by_fact_id IS NOT NULL AND candidate_id IS NULL AND carried_from_revision_id IS NULL
                            AND superseded_by_fact_id <> fact_id AND seq > 1
    END)
);
CREATE INDEX fact_revision_registry_idx ON fact_revision (registry_id);
ALTER TABLE fact ADD CONSTRAINT fact_current_fk
  FOREIGN KEY (current_revision_id, id) REFERENCES fact_revision (id, fact_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE fact_candidate (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                 uuid NOT NULL,
  stage_id                  uuid NOT NULL,
  registry_id               uuid NOT NULL,
  fact_kind                 text NOT NULL REFERENCES fact_kind (code),
  origin                    text NOT NULL CHECK (origin IN ('human', 'model', 'rule', 'carried')),
  analysis_run_id           uuid,
  candidate_key             text CHECK (candidate_key ~ '^[0-9a-f]{64}$'),
  target_fact_id            uuid,
  rebased_from_candidate_id uuid REFERENCES fact_candidate (id),
  carried_from_revision_id  uuid REFERENCES fact_revision (id),
  derived_from_candidate_id uuid REFERENCES fact_candidate (id),
  display_value             text NOT NULL CHECK (length(display_value) BETWEEN 1 AND 1000),
  normalized_value          jsonb NOT NULL CHECK (jsonb_typeof(normalized_value) = 'object'),
  unit                      text CHECK (length(unit) BETWEEN 1 AND 40),
  rationale                 text CHECK (length(rationale) BETWEEN 1 AND 4000),
  confidence                numeric CHECK (confidence >= 0 AND confidence <= 1),
  status                    text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'rejected', 'superseded')),
  status_reason             text CHECK (length(status_reason) BETWEEN 1 AND 1000),
  decided_by                uuid REFERENCES app_user (id),
  decided_at                timestamptz,
  created_by                uuid NOT NULL REFERENCES app_user (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_xact              xid8 NOT NULL DEFAULT pg_current_xact_id(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  row_version               bigint NOT NULL DEFAULT 1,
  CONSTRAINT fact_candidate_registry_fk FOREIGN KEY (registry_id, stage_id) REFERENCES requirement_registry (id, stage_id),
  CONSTRAINT fact_candidate_registry_tender_fk FOREIGN KEY (registry_id, tender_id) REFERENCES requirement_registry (id, tender_id),
  CONSTRAINT fact_candidate_run_fk FOREIGN KEY (analysis_run_id, registry_id) REFERENCES analysis_run (id, registry_id),
  CONSTRAINT fact_candidate_target_fk FOREIGN KEY (target_fact_id, fact_kind) REFERENCES fact (id, fact_kind),
  CONSTRAINT fact_candidate_target_stage_fk FOREIGN KEY (target_fact_id, stage_id) REFERENCES fact (id, stage_id),
  CONSTRAINT fact_candidate_key UNIQUE (analysis_run_id, candidate_key),
  CONSTRAINT fact_candidate_rebase_key UNIQUE (rebased_from_candidate_id, registry_id),
  CONSTRAINT fact_candidate_id_registry_key UNIQUE (id, registry_id),
  CONSTRAINT fact_candidate_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT fact_candidate_origin_shape CHECK (
    CASE origin
      WHEN 'human' THEN num_nonnulls(analysis_run_id, candidate_key, rebased_from_candidate_id, carried_from_revision_id) = 0
      WHEN 'carried' THEN analysis_run_id IS NULL AND candidate_key IS NULL
                          AND num_nonnulls(rebased_from_candidate_id, carried_from_revision_id) = 1
      ELSE analysis_run_id IS NOT NULL AND candidate_key IS NOT NULL
           AND num_nonnulls(rebased_from_candidate_id, carried_from_revision_id, derived_from_candidate_id) = 0
    END),
  CONSTRAINT fact_candidate_decision_shape CHECK (
    (status = 'proposed') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)
    AND (status <> 'rejected' OR status_reason IS NOT NULL))
);
CREATE INDEX fact_candidate_registry_idx ON fact_candidate (registry_id, status, created_at);
CREATE UNIQUE INDEX fact_candidate_derived_key ON fact_candidate (derived_from_candidate_id) WHERE derived_from_candidate_id IS NOT NULL;
ALTER TABLE fact_revision ADD CONSTRAINT fact_revision_candidate_fk
  FOREIGN KEY (candidate_id) REFERENCES fact_candidate (id);
CREATE UNIQUE INDEX fact_revision_candidate_key ON fact_revision (candidate_id) WHERE candidate_id IS NOT NULL;

CREATE FUNCTION fact_content_hash(p_kind text, p_display text, p_value jsonb, p_unit text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to('kontur.fact.v1' || E'\n' || p_kind || E'\n' || p_display || E'\n' || p_value::text || E'\n' || coalesce(p_unit, ''), 'UTF8')), 'hex')
$$;

CREATE FUNCTION fact_candidate_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_reg requirement_registry%ROWTYPE;
BEGIN
  IF NEW.status <> 'proposed' OR NEW.row_version <> 1 THEN
    RAISE EXCEPTION 'fact_candidate: кандидат создаётся в состоянии proposed' USING ERRCODE = '55000';
  END IF;
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'fact_candidate: кандидат создаётся только в активном реестре этапа' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_reg FROM requirement_registry WHERE id = NEW.registry_id;
  IF NEW.origin IN ('model', 'rule') THEN
    IF NOT EXISTS (SELECT 1 FROM analysis_run r
                    WHERE r.id = NEW.analysis_run_id AND r.status = 'running' AND r.requested_by = NEW.created_by
                      AND r.task = 'fact_extraction' AND (r.provider_id = 'rules') = (NEW.origin = 'rule')) THEN
      RAISE EXCEPTION 'fact_candidate: кандидата модели пишет выполняющийся прогон извлечения фактов' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT has_stage_capability(NEW.created_by, NEW.stage_id, 'fact.create') THEN
    RAISE EXCEPTION 'fact_candidate: кандидата факта создаёт пользователь с fact.create' USING ERRCODE = '42501';
  END IF;
  IF NEW.rebased_from_candidate_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM fact_candidate c JOIN requirement_registry r ON r.id = c.registry_id
        WHERE c.id = NEW.rebased_from_candidate_id AND c.status = 'proposed' AND r.stage_id = NEW.stage_id AND r.id <> NEW.registry_id
          AND (c.fact_kind, c.display_value, c.normalized_value, c.unit, c.target_fact_id) IS NOT DISTINCT FROM
              (NEW.fact_kind, NEW.display_value, NEW.normalized_value, NEW.unit, NEW.target_fact_id)) THEN
    RAISE EXCEPTION 'fact_candidate: перенос — с предложения другого реестра того же этапа' USING ERRCODE = '23514';
  END IF;
  IF NEW.carried_from_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM fact_revision v
        WHERE v.id = NEW.carried_from_revision_id AND v.registry_id = v_reg.previous_registry_id AND v.status = 'confirmed'
          AND v.fact_id = NEW.target_fact_id
          AND (v.display_value, v.normalized_value, v.unit) IS NOT DISTINCT FROM (NEW.display_value, NEW.normalized_value, NEW.unit)) THEN
    RAISE EXCEPTION 'fact_candidate: перенос факта — с подтверждённой ревизии предыдущего реестра' USING ERRCODE = '23514';
  END IF;
  IF NEW.derived_from_candidate_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM fact_candidate c WHERE c.id = NEW.derived_from_candidate_id AND c.registry_id = NEW.registry_id AND c.status = 'proposed') THEN
    RAISE EXCEPTION 'fact_candidate: правка — новой версией предложения того же реестра' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_candidate_insert_guard BEFORE INSERT ON fact_candidate
  FOR EACH ROW EXECUTE FUNCTION fact_candidate_insert_guard();

CREATE FUNCTION fact_candidate_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.registry_id, NEW.fact_kind, NEW.origin, NEW.analysis_run_id, NEW.candidate_key, NEW.target_fact_id,
      NEW.rebased_from_candidate_id, NEW.carried_from_revision_id, NEW.derived_from_candidate_id, NEW.display_value, NEW.normalized_value,
      NEW.unit, NEW.rationale, NEW.confidence, NEW.created_by, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM
     (OLD.id, OLD.tender_id, OLD.stage_id, OLD.registry_id, OLD.fact_kind, OLD.origin, OLD.analysis_run_id, OLD.candidate_key, OLD.target_fact_id,
      OLD.rebased_from_candidate_id, OLD.carried_from_revision_id, OLD.derived_from_candidate_id, OLD.display_value, OLD.normalized_value,
      OLD.unit, OLD.rationale, OLD.confidence, OLD.created_by, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'fact_candidate: содержание кандидата неизменно' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'proposed' OR NEW.status = 'proposed' OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'fact_candidate: переход только из proposed (row_version + 1)' USING ERRCODE = '55000';
  END IF;
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'fact_candidate: кандидат прежнего реестра не подтверждается и не отклоняется — нужен явный перенос' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('confirmed', 'rejected') AND NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'fact.confirm') THEN
    RAISE EXCEPTION 'fact_candidate: подтверждает и отклоняет пользователь с fact.confirm' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'superseded' AND (NOT EXISTS (SELECT 1 FROM fact_candidate c WHERE c.derived_from_candidate_id = NEW.id)
                                    OR NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'fact.create')) THEN
    RAISE EXCEPTION 'fact_candidate: предложение заменяется только новой версией (правкой)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_candidate_update_guard BEFORE UPDATE ON fact_candidate
  FOR EACH ROW EXECUTE FUNCTION fact_candidate_update_guard();
CREATE TRIGGER fact_candidate_no_delete BEFORE DELETE ON fact_candidate
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('frozen-after');
CREATE TRIGGER fact_candidate_no_truncate BEFORE TRUNCATE ON fact_candidate
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

CREATE FUNCTION fact_candidate_confirm_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM fact_revision v WHERE v.candidate_id = NEW.id) THEN
    RAISE EXCEPTION 'fact_candidate: подтверждение без ревизии факта' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER fact_candidate_confirm_check AFTER UPDATE ON fact_candidate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fact_candidate_confirm_check();

CREATE FUNCTION fact_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last fact_revision%ROWTYPE;
  v_cand fact_candidate%ROWTYPE;
  v_from fact_revision%ROWTYPE;
  v_reg  requirement_registry%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fact_revision'), hashtext(NEW.fact_id::text));
  SELECT * INTO v_last FROM fact_revision WHERE fact_id = NEW.fact_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_last.seq, 0) + 1 OR NEW.supersedes_revision_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'fact_revision: новая ревизия встаёт за последней ревизией факта' USING ERRCODE = '40001';
  END IF;
  IF v_last.status = 'superseded' THEN
    RAISE EXCEPTION 'fact_revision: заменённый факт не меняется' USING ERRCODE = '23514';
  END IF;
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'fact_revision: ревизия пишется только в активный реестр этапа' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_reg FROM requirement_registry WHERE id = NEW.registry_id;
  NEW.content_sha256 := fact_content_hash(NEW.fact_kind, NEW.display_value, NEW.normalized_value, NEW.unit);
  IF NEW.change_kind = 'confirmation' THEN
    SELECT * INTO v_cand FROM fact_candidate WHERE id = NEW.candidate_id;
    IF v_cand.status IS DISTINCT FROM 'confirmed' OR v_cand.registry_id <> NEW.registry_id OR v_cand.decided_by <> NEW.confirmed_by
       OR v_cand.created_by <> NEW.authored_by OR v_cand.fact_kind <> NEW.fact_kind
       OR v_cand.target_fact_id IS DISTINCT FROM (CASE WHEN NEW.seq = 1 THEN NULL ELSE NEW.fact_id END) THEN
      RAISE EXCEPTION 'fact_revision: подтверждение — по кандидату этого реестра в статусе confirmed' USING ERRCODE = '23514';
    END IF;
    IF v_last.id IS NOT NULL AND v_last.registry_id <> NEW.registry_id AND v_cand.carried_from_revision_id IS DISTINCT FROM v_last.id THEN
      RAISE EXCEPTION 'fact_revision: факт прежнего реестра сначала переносится в активный' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'fact.confirm') THEN
      RAISE EXCEPTION 'fact_revision: подтверждает пользователь с fact.confirm' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.change_kind = 'carry_over' THEN
    SELECT * INTO v_from FROM fact_revision WHERE id = NEW.carried_from_revision_id;
    IF v_from.id IS DISTINCT FROM v_last.id OR v_last.registry_id IS DISTINCT FROM v_reg.previous_registry_id
       OR v_from.content_sha256 <> NEW.content_sha256 OR v_from.authored_by <> NEW.authored_by THEN
      RAISE EXCEPTION 'fact_revision: перенос — без изменения последней ревизии из предыдущего реестра' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'requirement.manage') THEN
      RAISE EXCEPTION 'fact_revision: перенос выполняет пользователь с requirement.manage' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_last.registry_id <> NEW.registry_id OR v_last.content_sha256 <> NEW.content_sha256 OR v_last.authored_by <> NEW.authored_by THEN
      RAISE EXCEPTION 'fact_revision: замена не меняет содержание и выполняется в активном реестре' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fact q JOIN fact_revision c ON c.id = q.current_revision_id
                    WHERE q.id = NEW.superseded_by_fact_id AND c.status = 'confirmed' AND c.registry_id = NEW.registry_id) THEN
      RAISE EXCEPTION 'fact_revision: заменяющий факт — действующий в активном реестре' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.confirmed_by, NEW.stage_id, 'fact.confirm') THEN
      RAISE EXCEPTION 'fact_revision: заменяет пользователь с fact.confirm' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_revision_insert_guard BEFORE INSERT ON fact_revision
  FOR EACH ROW EXECUTE FUNCTION fact_revision_insert_guard();
CREATE TRIGGER fact_revision_immutable BEFORE UPDATE OR DELETE ON fact_revision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER fact_revision_no_truncate BEFORE TRUNCATE ON fact_revision
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE FUNCTION fact_pointer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ((NEW.id, NEW.tender_id, NEW.stage_id, NEW.fact_kind, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.fact_kind, OLD.created_at)
                           OR NEW.row_version <> OLD.row_version + 1) THEN
    RAISE EXCEPTION 'fact: меняется только указатель на последнюю ревизию (row_version + 1)' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_pointer_guard BEFORE UPDATE ON fact
  FOR EACH ROW EXECUTE FUNCTION fact_pointer_guard();
CREATE TRIGGER fact_no_delete BEFORE DELETE ON fact
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('pointer');
CREATE TRIGGER fact_no_truncate BEFORE TRUNCATE ON fact
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('pointer');

CREATE FUNCTION fact_pointer_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_revision_id IS DISTINCT FROM (SELECT id FROM fact_revision WHERE fact_id = NEW.id ORDER BY seq DESC LIMIT 1) THEN
    RAISE EXCEPTION 'fact: указатель не на последнюю ревизию факта' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER fact_pointer_check AFTER INSERT OR UPDATE ON fact
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fact_pointer_check();

CREATE FUNCTION fact_revision_current_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fact q WHERE q.id = NEW.fact_id AND q.current_revision_id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM fact_revision v WHERE v.fact_id = NEW.fact_id AND v.seq > NEW.seq) THEN
    RAISE EXCEPTION 'fact_revision: новая ревизия не стала текущей' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER fact_revision_current_check AFTER INSERT ON fact_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fact_revision_current_check();

-- ---------------------------------------------------------------- Решения (Р-08-3)

-- Строка decision — неизменяемая версия решения, замена — supersedes_decision_id (0002). Этап 08 добавляет
-- вид requirement_decision: предмет — требование этапа, основания — evidence_link с ролью, автор — requirement.decide.
ALTER TABLE decision ADD CONSTRAINT decision_id_tender_key UNIQUE (id, tender_id);
ALTER TABLE decision ADD COLUMN created_xact xid8 NOT NULL DEFAULT pg_current_xact_id();
ALTER TABLE decision DROP CONSTRAINT decision_decision_type_check;
ALTER TABLE decision
  ADD CONSTRAINT decision_decision_type_check CHECK (decision_type IN ('import_item_disposition', 'requirement_decision')),
  ADD CONSTRAINT decision_requirement_shape CHECK (
    decision_type <> 'requirement_decision' OR (stage_id IS NOT NULL AND subject_type = 'requirement' AND basis_fragment_ids = '{}'));
-- У решения 08 не больше одной замены: цепочка версий линейна.
CREATE UNIQUE INDEX decision_requirement_supersedes_key ON decision (supersedes_decision_id)
  WHERE decision_type = 'requirement_decision' AND supersedes_decision_id IS NOT NULL;
CREATE INDEX decision_subject_idx ON decision (subject_type, subject_id);

-- Вторая линия ADR-006 §4: решения импорта — как в 0002 (руководитель тендера); решения по требованию —
-- возможность requirement.decide через общую функцию (Р-08-8), предмет — требование этого этапа,
-- замена — того же вида и предмета.
CREATE OR REPLACE FUNCTION decision_author_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision_type = 'requirement_decision' THEN
    IF NOT EXISTS (SELECT 1 FROM tender_stage s WHERE s.id = NEW.stage_id AND s.tender_id = NEW.tender_id) THEN
      RAISE EXCEPTION 'decision: этап решения — этап тендера решения' USING ERRCODE = '23514';
    END IF;
    IF NOT has_stage_capability(NEW.decided_by, NEW.stage_id, 'requirement.decide') THEN
      RAISE EXCEPTION 'решение по требованию принимает пользователь с requirement.decide' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM requirement r WHERE r.id = NEW.subject_id AND r.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'decision: предмет решения — требование этого этапа' USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes_decision_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM decision d WHERE d.id = NEW.supersedes_decision_id AND d.decision_type = 'requirement_decision'
                                    AND d.subject_id = NEW.subject_id AND d.stage_id = NEW.stage_id) THEN
      RAISE EXCEPTION 'decision: заменяется решение того же вида и предмета' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_user u
      JOIN user_role r ON r.user_id = u.id AND r.role = 'manager'
      JOIN tender_member m ON m.user_id = u.id AND m.tender_id = NEW.tender_id AND m.member_role = 'manager' AND m.removed_at IS NULL
     WHERE u.id = NEW.decided_by AND u.kind = 'human' AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION 'решение % может принять только руководитель тендера', NEW.decision_type USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Допущения (OD-08-6)

CREATE TABLE assumption (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id           uuid NOT NULL,
  stage_id            uuid NOT NULL,
  requirement_id      uuid,
  current_revision_id uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         bigint NOT NULL DEFAULT 1,
  CONSTRAINT assumption_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT assumption_requirement_fk FOREIGN KEY (requirement_id, stage_id) REFERENCES requirement (id, stage_id),
  CONSTRAINT assumption_id_stage_key UNIQUE (id, stage_id),
  CONSTRAINT assumption_id_tender_key UNIQUE (id, tender_id)
);

CREATE TABLE assumption_revision (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assumption_id               uuid NOT NULL,
  tender_id                   uuid NOT NULL,
  stage_id                    uuid NOT NULL,
  seq                         int NOT NULL CHECK (seq > 0),
  supersedes_revision_id      uuid REFERENCES assumption_revision (id),
  statement                   text NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  status                      text NOT NULL CHECK (status IN ('open', 'confirmed', 'rejected', 'superseded')),
  superseded_by_assumption_id uuid,
  reason                      text CHECK (length(reason) BETWEEN 1 AND 1000),
  authored_by                 uuid NOT NULL REFERENCES app_user (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_xact                xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT assumption_revision_assumption_fk FOREIGN KEY (assumption_id, stage_id) REFERENCES assumption (id, stage_id),
  CONSTRAINT assumption_revision_assumption_tender_fk FOREIGN KEY (assumption_id, tender_id) REFERENCES assumption (id, tender_id),
  CONSTRAINT assumption_revision_superseded_by_fk FOREIGN KEY (superseded_by_assumption_id, stage_id) REFERENCES assumption (id, stage_id),
  CONSTRAINT assumption_revision_seq_key UNIQUE (assumption_id, seq),
  CONSTRAINT assumption_revision_id_assumption_key UNIQUE (id, assumption_id),
  CONSTRAINT assumption_revision_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT assumption_revision_history_shape CHECK ((seq = 1) = (supersedes_revision_id IS NULL) AND (seq > 1 OR status = 'open')),
  CONSTRAINT assumption_revision_status_shape CHECK (
    (status = 'superseded') = (superseded_by_assumption_id IS NOT NULL) AND superseded_by_assumption_id IS DISTINCT FROM assumption_id
    AND (status <> 'rejected' OR reason IS NOT NULL))
);
ALTER TABLE assumption ADD CONSTRAINT assumption_current_fk
  FOREIGN KEY (current_revision_id, id) REFERENCES assumption_revision (id, assumption_id) DEFERRABLE INITIALLY DEFERRED;

-- Переходы: open → open (правка текста), open → confirmed / rejected (requirement.confirm), open или confirmed →
-- superseded (новым допущением того же этапа). Не open — текст прежний. Автор обязателен.
CREATE FUNCTION assumption_revision_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last assumption_revision%ROWTYPE;
  v_cap  text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('assumption_revision'), hashtext(NEW.assumption_id::text));
  SELECT * INTO v_last FROM assumption_revision WHERE assumption_id = NEW.assumption_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_last.seq, 0) + 1 OR NEW.supersedes_revision_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'assumption_revision: новая ревизия встаёт за последней ревизией допущения' USING ERRCODE = '40001';
  END IF;
  IF v_last.id IS NOT NULL AND NOT (
       (v_last.status = 'open' AND NEW.status IN ('open', 'confirmed', 'rejected', 'superseded'))
    OR (v_last.status = 'confirmed' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'assumption_revision: недопустимый переход % → %', v_last.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF v_last.id IS NOT NULL AND NEW.status <> 'open' AND NEW.statement <> v_last.statement THEN
    RAISE EXCEPTION 'assumption_revision: при смене состояния формулировка не меняется' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'superseded' AND NOT EXISTS (
       SELECT 1 FROM assumption a JOIN assumption_revision c ON c.id = a.current_revision_id
        WHERE a.id = NEW.superseded_by_assumption_id AND c.status IN ('open', 'confirmed')) THEN
    RAISE EXCEPTION 'assumption_revision: заменяющее допущение — действующее' USING ERRCODE = '23514';
  END IF;
  v_cap := CASE WHEN NEW.status IN ('confirmed', 'rejected') OR (NEW.status = 'superseded' AND v_last.status = 'confirmed')
                THEN 'requirement.confirm' ELSE 'requirement.create' END;
  IF NOT has_stage_capability(NEW.authored_by, NEW.stage_id, v_cap) THEN
    RAISE EXCEPTION 'assumption_revision: действие требует %', v_cap USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assumption_revision_insert_guard BEFORE INSERT ON assumption_revision
  FOR EACH ROW EXECUTE FUNCTION assumption_revision_insert_guard();
CREATE TRIGGER assumption_revision_immutable BEFORE UPDATE OR DELETE ON assumption_revision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER assumption_revision_no_truncate BEFORE TRUNCATE ON assumption_revision
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE FUNCTION assumption_pointer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.requirement_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.requirement_id, OLD.created_at)
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'assumption: меняется только указатель на последнюю ревизию (row_version + 1)' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assumption_pointer_guard BEFORE UPDATE ON assumption
  FOR EACH ROW EXECUTE FUNCTION assumption_pointer_guard();
CREATE TRIGGER assumption_no_delete BEFORE DELETE ON assumption
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('pointer');
CREATE TRIGGER assumption_no_truncate BEFORE TRUNCATE ON assumption
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('pointer');

CREATE FUNCTION assumption_pointer_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_revision_id IS DISTINCT FROM (SELECT id FROM assumption_revision WHERE assumption_id = NEW.id ORDER BY seq DESC LIMIT 1) THEN
    RAISE EXCEPTION 'assumption: указатель не на последнюю ревизию допущения' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER assumption_pointer_check AFTER INSERT OR UPDATE ON assumption
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assumption_pointer_check();

-- ---------------------------------------------------------------- Основания (AD-08-3, Р-08-5)

-- Ровно один владелец (nullable FK + CHECK, без owner_type). Набор оснований неизменен после создания
-- владельца: пишет только его транзакция. Фрагмент — в снимке реестра владельца (у решения и допущения —
-- активного реестра этапа); основание supports — допустимого происхождения, у факта — по D-018.
CREATE TABLE evidence_link (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                uuid NOT NULL,
  fragment_id              uuid NOT NULL REFERENCES evidence_fragment (id),
  role                     text NOT NULL CHECK (role IN ('supports', 'contradicts', 'clarifies', 'supersedes_context')),
  requirement_candidate_id uuid,
  requirement_revision_id  uuid,
  fact_candidate_id        uuid,
  fact_revision_id         uuid,
  decision_id              uuid,
  assumption_revision_id   uuid,
  created_by               uuid NOT NULL REFERENCES app_user (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_link_owner_shape CHECK (
    num_nonnulls(requirement_candidate_id, requirement_revision_id, fact_candidate_id, fact_revision_id, decision_id, assumption_revision_id) = 1),
  CONSTRAINT evidence_link_requirement_candidate_fk FOREIGN KEY (requirement_candidate_id, tender_id) REFERENCES requirement_candidate (id, tender_id),
  CONSTRAINT evidence_link_requirement_revision_fk FOREIGN KEY (requirement_revision_id, tender_id) REFERENCES requirement_revision (id, tender_id),
  CONSTRAINT evidence_link_fact_candidate_fk FOREIGN KEY (fact_candidate_id, tender_id) REFERENCES fact_candidate (id, tender_id),
  CONSTRAINT evidence_link_fact_revision_fk FOREIGN KEY (fact_revision_id, tender_id) REFERENCES fact_revision (id, tender_id),
  CONSTRAINT evidence_link_decision_fk FOREIGN KEY (decision_id, tender_id) REFERENCES decision (id, tender_id),
  CONSTRAINT evidence_link_assumption_fk FOREIGN KEY (assumption_revision_id, tender_id) REFERENCES assumption_revision (id, tender_id),
  CONSTRAINT evidence_link_key UNIQUE NULLS NOT DISTINCT
    (requirement_candidate_id, requirement_revision_id, fact_candidate_id, fact_revision_id, decision_id, assumption_revision_id, fragment_id, role)
);
CREATE INDEX evidence_link_fragment_idx ON evidence_link (fragment_id);
CREATE INDEX evidence_link_requirement_candidate_idx ON evidence_link (requirement_candidate_id) WHERE requirement_candidate_id IS NOT NULL;
CREATE INDEX evidence_link_requirement_revision_idx ON evidence_link (requirement_revision_id) WHERE requirement_revision_id IS NOT NULL;
CREATE INDEX evidence_link_fact_candidate_idx ON evidence_link (fact_candidate_id) WHERE fact_candidate_id IS NOT NULL;
CREATE INDEX evidence_link_fact_revision_idx ON evidence_link (fact_revision_id) WHERE fact_revision_id IS NOT NULL;
CREATE INDEX evidence_link_decision_idx ON evidence_link (decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX evidence_link_assumption_idx ON evidence_link (assumption_revision_id) WHERE assumption_revision_id IS NOT NULL;

CREATE FUNCTION evidence_link_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_xact     xid8;
  v_registry uuid;
  v_stage    uuid;
  v_origin   text;
  v_fact     boolean := NEW.fact_candidate_id IS NOT NULL OR NEW.fact_revision_id IS NOT NULL;
BEGIN
  IF NEW.requirement_candidate_id IS NOT NULL THEN
    SELECT created_xact, registry_id INTO v_xact, v_registry FROM requirement_candidate WHERE id = NEW.requirement_candidate_id;
  ELSIF NEW.requirement_revision_id IS NOT NULL THEN
    SELECT created_xact, registry_id INTO v_xact, v_registry FROM requirement_revision WHERE id = NEW.requirement_revision_id;
  ELSIF NEW.fact_candidate_id IS NOT NULL THEN
    SELECT created_xact, registry_id INTO v_xact, v_registry FROM fact_candidate WHERE id = NEW.fact_candidate_id;
  ELSIF NEW.fact_revision_id IS NOT NULL THEN
    SELECT created_xact, registry_id INTO v_xact, v_registry FROM fact_revision WHERE id = NEW.fact_revision_id;
  ELSIF NEW.decision_id IS NOT NULL THEN
    SELECT created_xact, stage_id INTO v_xact, v_stage FROM decision WHERE id = NEW.decision_id;
    SELECT registry_id INTO v_registry FROM requirement_registry_active WHERE stage_id = v_stage;
  ELSE
    SELECT created_xact, stage_id INTO v_xact, v_stage FROM assumption_revision WHERE id = NEW.assumption_revision_id;
    SELECT registry_id INTO v_registry FROM requirement_registry_active WHERE stage_id = v_stage;
  END IF;
  IF v_xact IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'evidence_link: основания пишет только транзакция создания владельца' USING ERRCODE = '55000';
  END IF;
  IF v_registry IS NULL OR NOT evidence_scope_has_fragment((SELECT evidence_scope_id FROM requirement_registry WHERE id = v_registry), NEW.fragment_id) THEN
    RAISE EXCEPTION 'evidence_link: фрагмент вне снимка реестра (инвариант 4)' USING ERRCODE = '23514';
  END IF;
  SELECT origin INTO v_origin FROM evidence_fragment WHERE id = NEW.fragment_id;
  IF NEW.role = 'supports' AND NOT evidence_origin_reviewable(v_origin) THEN
    RAISE EXCEPTION 'evidence_link: % не может быть содержательным основанием (I06)', v_origin USING ERRCODE = '23514';
  END IF;
  IF v_fact AND NEW.role = 'supports' AND NOT evidence_origin_fact_basis(v_origin) THEN
    RAISE EXCEPTION 'evidence_link: основание факта — только письменный текст документа, письма, вложения или ответа (D-018)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_link_insert_guard BEFORE INSERT ON evidence_link
  FOR EACH ROW EXECUTE FUNCTION evidence_link_insert_guard();
CREATE TRIGGER evidence_link_immutable BEFORE UPDATE OR DELETE ON evidence_link
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER evidence_link_no_truncate BEFORE TRUNCATE ON evidence_link
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- При фиксации у кандидата и ревизии требования и факта — хотя бы одно основание supports; основания
-- ревизии из кандидата — те же, что у кандидата; у переноса и замены — те же, что у исходной ревизии.
CREATE FUNCTION evidence_supports_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_col  text := CASE TG_TABLE_NAME WHEN 'requirement_candidate' THEN 'requirement_candidate_id'
                                    WHEN 'requirement_revision' THEN 'requirement_revision_id'
                                    WHEN 'fact_candidate' THEN 'fact_candidate_id' ELSE 'fact_revision_id' END;
  v_ok   boolean;
  v_src  uuid;
  v_scol text;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM evidence_link WHERE %I = $1 AND role = %L)', v_col, 'supports') INTO v_ok USING NEW.id;
  IF NOT v_ok THEN
    RAISE EXCEPTION '%: нет содержательного основания (supports)', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('requirement_revision', 'fact_revision') THEN
    IF NEW.change_kind = 'confirmation' THEN
      v_src := NEW.candidate_id;
      v_scol := CASE TG_TABLE_NAME WHEN 'requirement_revision' THEN 'requirement_candidate_id' ELSE 'fact_candidate_id' END;
    ELSE
      v_src := coalesce(NEW.carried_from_revision_id, NEW.supersedes_revision_id);
      v_scol := v_col;
    END IF;
    EXECUTE format(
      'SELECT NOT EXISTS ((SELECT fragment_id, role FROM evidence_link WHERE %I = $1 EXCEPT SELECT fragment_id, role FROM evidence_link WHERE %I = $2)
                          UNION ALL
                          (SELECT fragment_id, role FROM evidence_link WHERE %I = $2 EXCEPT SELECT fragment_id, role FROM evidence_link WHERE %I = $1))',
      v_col, v_scol, v_scol, v_col) INTO v_ok USING NEW.id, v_src;
    IF NOT v_ok THEN
      RAISE EXCEPTION '%: основания ревизии отличаются от оснований источника', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER requirement_candidate_supports_check AFTER INSERT ON requirement_candidate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION evidence_supports_check();
CREATE CONSTRAINT TRIGGER requirement_revision_supports_check AFTER INSERT ON requirement_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION evidence_supports_check();
CREATE CONSTRAINT TRIGGER fact_candidate_supports_check AFTER INSERT ON fact_candidate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION evidence_supports_check();
CREATE CONSTRAINT TRIGGER fact_revision_supports_check AFTER INSERT ON fact_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION evidence_supports_check();

-- ---------------------------------------------------------------- Покрытие (Р-08-2)

-- История оценок ревизии требования: последняя действует, ревизия требования не меняется.
CREATE TABLE requirement_coverage (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                       uuid NOT NULL,
  stage_id                        uuid NOT NULL,
  requirement_revision_id         uuid NOT NULL,
  seq                             int NOT NULL CHECK (seq > 0),
  supersedes_coverage_id          uuid REFERENCES requirement_coverage (id),
  state                           text NOT NULL CHECK (state IN ('uncovered', 'partial', 'covered', 'not_applicable', 'needs_review')),
  reason                          text CHECK (length(reason) BETWEEN 1 AND 2000),
  origin                          text NOT NULL CHECK (origin IN ('human', 'system')),
  assessed_by                     uuid REFERENCES app_user (id),
  trigger_calculation_revision_id uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_xact                    xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT requirement_coverage_revision_fk FOREIGN KEY (requirement_revision_id, tender_id) REFERENCES requirement_revision (id, tender_id),
  CONSTRAINT requirement_coverage_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT requirement_coverage_trigger_fk FOREIGN KEY (trigger_calculation_revision_id, tender_id) REFERENCES calculation_revision (id, tender_id),
  CONSTRAINT requirement_coverage_seq_key UNIQUE (requirement_revision_id, seq),
  CONSTRAINT requirement_coverage_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT requirement_coverage_history_shape CHECK ((seq = 1) = (supersedes_coverage_id IS NULL)),
  CONSTRAINT requirement_coverage_origin_shape CHECK (
    (origin = 'human') = (assessed_by IS NOT NULL)
    AND (origin = 'human' OR (state = 'needs_review' AND trigger_calculation_revision_id IS NOT NULL))
    AND (state <> 'not_applicable' OR reason IS NOT NULL))
);

CREATE TABLE requirement_coverage_object (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_id             uuid NOT NULL,
  tender_id               uuid NOT NULL,
  object_type             text NOT NULL CHECK (object_type IN ('evidence_fragment', 'calculation_revision', 'decision', 'manual_confirmation')),
  fragment_id             uuid REFERENCES evidence_fragment (id),
  calculation_revision_id uuid,
  external_position_id    uuid,
  external_item_id        uuid,
  match                   text CHECK (match IN ('explicit_line', 'complex_rate')),
  decision_id             uuid,
  note                    text CHECK (length(note) BETWEEN 1 AND 2000),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requirement_coverage_object_coverage_fk FOREIGN KEY (coverage_id, tender_id) REFERENCES requirement_coverage (id, tender_id),
  CONSTRAINT requirement_coverage_object_calculation_fk FOREIGN KEY (calculation_revision_id, tender_id) REFERENCES calculation_revision (id, tender_id),
  CONSTRAINT requirement_coverage_object_decision_fk FOREIGN KEY (decision_id, tender_id) REFERENCES decision (id, tender_id),
  -- Ровно один объект по типу; позиция ревизии расчёта — с видом совпадения: строка — explicit_line,
  -- комплексная расценка без строки — complex_rate (A05).
  CONSTRAINT requirement_coverage_object_shape CHECK (
    CASE object_type
      WHEN 'evidence_fragment' THEN fragment_id IS NOT NULL
        AND num_nonnulls(calculation_revision_id, external_position_id, external_item_id, match, decision_id) = 0
      WHEN 'calculation_revision' THEN calculation_revision_id IS NOT NULL AND num_nonnulls(fragment_id, decision_id) = 0
        AND (external_position_id IS NULL) = (match IS NULL)
        AND (external_item_id IS NULL OR external_position_id IS NOT NULL)
        AND (match IS NULL OR (match = 'explicit_line') = (external_item_id IS NOT NULL))
      WHEN 'decision' THEN decision_id IS NOT NULL
        AND num_nonnulls(fragment_id, calculation_revision_id, external_position_id, external_item_id, match) = 0
      WHEN 'manual_confirmation' THEN note IS NOT NULL
        AND num_nonnulls(fragment_id, calculation_revision_id, external_position_id, external_item_id, match, decision_id) = 0
    END)
);
CREATE INDEX requirement_coverage_object_coverage_idx ON requirement_coverage_object (coverage_id);

-- Оценка — к текущей ревизии требования в активном реестре; человек — requirement.confirm (И-08-13);
-- система — только needs_review по ревизии расчёта этапа, вставленной в этой же транзакции.
CREATE FUNCTION requirement_coverage_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last requirement_coverage%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('requirement_coverage'), hashtext(NEW.requirement_revision_id::text));
  SELECT * INTO v_last FROM requirement_coverage WHERE requirement_revision_id = NEW.requirement_revision_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(v_last.seq, 0) + 1 OR NEW.supersedes_coverage_id IS DISTINCT FROM v_last.id THEN
    RAISE EXCEPTION 'requirement_coverage: новая оценка встаёт за последней оценкой ревизии' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM requirement_revision v JOIN requirement q ON q.current_revision_id = v.id
        WHERE v.id = NEW.requirement_revision_id AND v.status = 'confirmed' AND v.stage_id = NEW.stage_id
          AND requirement_registry_is_active(v.registry_id)) THEN
    RAISE EXCEPTION 'requirement_coverage: покрытие оценивается для текущей ревизии требования в активном реестре (инвариант 8)' USING ERRCODE = '23514';
  END IF;
  IF NEW.origin = 'human' AND NOT has_stage_capability(NEW.assessed_by, NEW.stage_id, 'requirement.confirm') THEN
    RAISE EXCEPTION 'requirement_coverage: оценку покрытия записывает пользователь с requirement.confirm' USING ERRCODE = '42501';
  END IF;
  IF NEW.origin = 'system' AND NOT EXISTS (
       SELECT 1 FROM calculation_revision r WHERE r.id = NEW.trigger_calculation_revision_id AND r.stage_id = NEW.stage_id AND r.created_at = now()) THEN
    RAISE EXCEPTION 'requirement_coverage: системная пометка — только по новой ревизии расчёта этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_coverage_insert_guard BEFORE INSERT ON requirement_coverage
  FOR EACH ROW EXECUTE FUNCTION requirement_coverage_insert_guard();
CREATE TRIGGER requirement_coverage_immutable BEFORE UPDATE OR DELETE ON requirement_coverage
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER requirement_coverage_no_truncate BEFORE TRUNCATE ON requirement_coverage
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Объект: пишет транзакция оценки; ревизия расчёта — этапа оценки, позиция и строка — из её содержимого;
-- решение — по требованию этого этапа; фрагмент — в снимке реестра ревизии требования.
CREATE FUNCTION requirement_coverage_object_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cov requirement_coverage%ROWTYPE;
BEGIN
  SELECT * INTO v_cov FROM requirement_coverage WHERE id = NEW.coverage_id;
  IF v_cov.created_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'requirement_coverage_object: объекты пишет только транзакция оценки' USING ERRCODE = '55000';
  END IF;
  IF NEW.object_type = 'calculation_revision' THEN
    IF NOT EXISTS (SELECT 1 FROM calculation_revision r WHERE r.id = NEW.calculation_revision_id AND r.stage_id = v_cov.stage_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: ревизия расчёта другого этапа' USING ERRCODE = '23514';
    END IF;
    IF NEW.external_position_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM calculation_revision r JOIN calculation_position p ON p.content_id = r.content_id
          WHERE r.id = NEW.calculation_revision_id AND p.external_position_id = NEW.external_position_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: позиции нет в содержимом ревизии расчёта' USING ERRCODE = '23514';
    END IF;
    IF NEW.external_item_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM calculation_revision r JOIN calculation_line l ON l.content_id = r.content_id
          WHERE r.id = NEW.calculation_revision_id AND l.external_item_id = NEW.external_item_id
            AND l.external_position_id = NEW.external_position_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: строки нет в этой позиции ревизии расчёта' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.object_type = 'decision' THEN
    IF NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.decision_id AND d.decision_type = 'requirement_decision' AND d.stage_id = v_cov.stage_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: решение — по требованию этого этапа' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.object_type = 'evidence_fragment' THEN
    IF NOT evidence_scope_has_fragment(
         (SELECT g.evidence_scope_id FROM requirement_revision v JOIN requirement_registry g ON g.id = v.registry_id WHERE v.id = v_cov.requirement_revision_id),
         NEW.fragment_id) THEN
      RAISE EXCEPTION 'requirement_coverage_object: фрагмент вне снимка реестра' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_coverage_object_guard BEFORE INSERT ON requirement_coverage_object
  FOR EACH ROW EXECUTE FUNCTION requirement_coverage_object_guard();
CREATE TRIGGER requirement_coverage_object_immutable BEFORE UPDATE OR DELETE ON requirement_coverage_object
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER requirement_coverage_object_no_truncate BEFORE TRUNCATE ON requirement_coverage_object
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- При фиксации: covered и partial — с объектами; прочие состояния — без объектов.
CREATE FUNCTION requirement_coverage_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM requirement_coverage_object WHERE coverage_id = NEW.id;
  IF (NEW.state IN ('covered', 'partial')) <> (v_n > 0) THEN
    RAISE EXCEPTION 'requirement_coverage: состояние % несовместимо с числом объектов %', NEW.state, v_n USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER requirement_coverage_commit_check AFTER INSERT ON requirement_coverage
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION requirement_coverage_commit_check();

-- Новая ревизия расчёта этапа: действующая оценка covered или partial текущей ревизии требования
-- активного реестра, опирающаяся на прежнюю ревизию расчёта, получает needs_review (система).
CREATE FUNCTION requirement_coverage_calculation_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO requirement_coverage (tender_id, stage_id, requirement_revision_id, seq, supersedes_coverage_id, state, reason, origin,
                                    trigger_calculation_revision_id)
  SELECT c.tender_id, c.stage_id, c.requirement_revision_id, c.seq + 1, c.id, 'needs_review',
         'Новая ревизия расчёта этапа: покрытие нужно проверить', 'system', NEW.id
    FROM requirement_coverage c
    JOIN requirement_revision v ON v.id = c.requirement_revision_id
    JOIN requirement q ON q.current_revision_id = v.id
   WHERE c.stage_id = NEW.stage_id AND c.state IN ('covered', 'partial')
     AND requirement_registry_is_active(v.registry_id)
     AND NOT EXISTS (SELECT 1 FROM requirement_coverage n WHERE n.supersedes_coverage_id = c.id)
     AND EXISTS (SELECT 1 FROM requirement_coverage_object o
                  WHERE o.coverage_id = c.id AND o.object_type = 'calculation_revision' AND o.calculation_revision_id <> NEW.id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER requirement_coverage_calculation_changed AFTER INSERT ON calculation_revision
  FOR EACH ROW EXECUTE FUNCTION requirement_coverage_calculation_changed();

-- ---------------------------------------------------------------- Вопрос заказчику (OD-08-6)

CREATE TABLE customer_question (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                  uuid NOT NULL,
  stage_id                   uuid NOT NULL,
  requirement_id             uuid,
  text                       text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  status                     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'answered', 'closed')),
  asked_at                   timestamptz,
  answered_at                timestamptz,
  answer_qa_item_revision_id uuid,
  answer_note                text CHECK (length(answer_note) BETWEEN 1 AND 4000),
  responsible_user_id        uuid REFERENCES app_user (id),
  created_by                 uuid NOT NULL REFERENCES app_user (id),
  updated_by                 uuid NOT NULL REFERENCES app_user (id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  row_version                bigint NOT NULL DEFAULT 1,
  CONSTRAINT customer_question_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT customer_question_requirement_fk FOREIGN KEY (requirement_id, stage_id) REFERENCES requirement (id, stage_id),
  CONSTRAINT customer_question_answer_fk FOREIGN KEY (answer_qa_item_revision_id, tender_id) REFERENCES qa_item_revision (id, tender_id),
  CONSTRAINT customer_question_status_shape CHECK (
    CASE status
      WHEN 'draft' THEN asked_at IS NULL AND answered_at IS NULL AND answer_qa_item_revision_id IS NULL AND answer_note IS NULL
      WHEN 'sent' THEN asked_at IS NOT NULL AND answered_at IS NULL AND answer_qa_item_revision_id IS NULL AND answer_note IS NULL
      WHEN 'answered' THEN asked_at IS NOT NULL AND answered_at IS NOT NULL AND num_nonnulls(answer_qa_item_revision_id, answer_note) >= 1
      ELSE true
    END)
);

-- Переходы: draft → sent | closed; sent → answered | closed; answered → closed. Текст — только в draft.
-- Действие — requirement.create; ответственный — участник тендера.
CREATE FUNCTION customer_question_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT has_stage_capability(NEW.updated_by, NEW.stage_id, 'requirement.create') THEN
    RAISE EXCEPTION 'customer_question: вопросы ведёт пользователь с requirement.create' USING ERRCODE = '42501';
  END IF;
  IF NEW.responsible_user_id IS NOT NULL AND NOT has_stage_capability(NEW.responsible_user_id, NEW.stage_id, 'requirement.read') THEN
    RAISE EXCEPTION 'customer_question: ответственный — участник тендера' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.row_version <> 1 OR NEW.created_by <> NEW.updated_by THEN
      RAISE EXCEPTION 'customer_question: вопрос создаётся черновиком' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.created_by, OLD.created_at)
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'customer_question: неизменяемые поля или row_version' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.text, NEW.requirement_id) IS DISTINCT FROM (OLD.text, OLD.requirement_id) THEN
    RAISE EXCEPTION 'customer_question: текст отправленного вопроса не меняется' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = NEW.status AND (OLD.status = 'draft' OR (NEW.asked_at, NEW.answered_at, NEW.answer_qa_item_revision_id, NEW.answer_note)
                                                                 IS NOT DISTINCT FROM (OLD.asked_at, OLD.answered_at, OLD.answer_qa_item_revision_id, OLD.answer_note)))
       OR (OLD.status = 'draft' AND NEW.status IN ('sent', 'closed'))
       OR (OLD.status = 'sent' AND NEW.status IN ('answered', 'closed'))
       OR (OLD.status = 'answered' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'customer_question: недопустимый переход % → %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'closed' AND (NEW.asked_at, NEW.answered_at, NEW.answer_qa_item_revision_id, NEW.answer_note)
                               IS DISTINCT FROM (OLD.asked_at, OLD.answered_at, OLD.answer_qa_item_revision_id, OLD.answer_note) THEN
    RAISE EXCEPTION 'customer_question: закрытие не меняет историю вопроса' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_question_guard BEFORE INSERT OR UPDATE ON customer_question
  FOR EACH ROW EXECUTE FUNCTION customer_question_guard();
CREATE TRIGGER customer_question_no_delete BEFORE DELETE ON customer_question
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('mutable');
CREATE TRIGGER customer_question_no_truncate BEFORE TRUNCATE ON customer_question
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('mutable');

-- ---------------------------------------------------------------- Пометка этапа (OD-08-6)

-- Неформальная заметка: в полноту, факты, требования и вход модели не попадает (связей с ними нет).
CREATE TABLE stage_note (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id          uuid NOT NULL,
  stage_id           uuid NOT NULL,
  text               text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  supersedes_note_id uuid REFERENCES stage_note (id),
  created_by         uuid NOT NULL REFERENCES app_user (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_note_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id)
);
CREATE UNIQUE INDEX stage_note_supersedes_key ON stage_note (supersedes_note_id) WHERE supersedes_note_id IS NOT NULL;
CREATE INDEX stage_note_stage_idx ON stage_note (stage_id, created_at DESC);

CREATE FUNCTION stage_note_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT has_stage_capability(NEW.created_by, NEW.stage_id, 'requirement.create') THEN
    RAISE EXCEPTION 'stage_note: пометку пишет пользователь с requirement.create' USING ERRCODE = '42501';
  END IF;
  IF NEW.supersedes_note_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stage_note n WHERE n.id = NEW.supersedes_note_id AND n.stage_id = NEW.stage_id) THEN
    RAISE EXCEPTION 'stage_note: заменяется пометка того же этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stage_note_insert_guard BEFORE INSERT ON stage_note
  FOR EACH ROW EXECUTE FUNCTION stage_note_insert_guard();
CREATE TRIGGER stage_note_immutable BEFORE UPDATE OR DELETE ON stage_note
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER stage_note_no_truncate BEFORE TRUNCATE ON stage_note
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Полнота (OD-08-7, Р-08-7)

-- Пакет отметок: селектор (страница, редакция, ревизия письма, вопрос, транскрипция или явный список)
-- детерминированно разворачивается в конкретные ID фрагментов, которые и хранятся.
CREATE TABLE registry_mark_batch (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id      uuid NOT NULL,
  registry_id    uuid NOT NULL,
  selector_kind  text NOT NULL CHECK (selector_kind IN ('fragments', 'page', 'document_revision', 'mail_message_revision', 'qa_item_revision', 'transcript_revision')),
  selector       jsonb NOT NULL CHECK (jsonb_typeof(selector) = 'object'),
  mark           text NOT NULL CHECK (mark IN ('not_requirement', 'cleared')),
  reason         text CHECK (length(reason) BETWEEN 1 AND 1000),
  fragment_count int NOT NULL CHECK (fragment_count > 0),
  marked_by      uuid NOT NULL REFERENCES app_user (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_xact   xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT registry_mark_batch_registry_fk FOREIGN KEY (registry_id, tender_id) REFERENCES requirement_registry (id, tender_id),
  CONSTRAINT registry_mark_batch_id_registry_key UNIQUE (id, registry_id)
);

CREATE TABLE registry_fragment_mark (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id   uuid NOT NULL,
  registry_id uuid NOT NULL,
  fragment_id uuid NOT NULL REFERENCES evidence_fragment (id),
  batch_id    uuid NOT NULL,
  seq         int NOT NULL CHECK (seq > 0),
  mark        text NOT NULL CHECK (mark IN ('not_requirement', 'cleared')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registry_fragment_mark_batch_fk FOREIGN KEY (batch_id, registry_id) REFERENCES registry_mark_batch (id, registry_id),
  CONSTRAINT registry_fragment_mark_registry_fk FOREIGN KEY (registry_id, tender_id) REFERENCES requirement_registry (id, tender_id),
  CONSTRAINT registry_fragment_mark_seq_key UNIQUE (registry_id, fragment_id, seq),
  CONSTRAINT registry_fragment_mark_batch_key UNIQUE (batch_id, fragment_id)
);

-- Пакет — только в активном реестре, автор — requirement.create; отметки и пакет — одной транзакцией.
CREATE FUNCTION registry_mark_batch_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'registry_mark_batch: отметки ставятся только в активном реестре' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.marked_by, (SELECT stage_id FROM requirement_registry WHERE id = NEW.registry_id), 'requirement.create') THEN
    RAISE EXCEPTION 'registry_mark_batch: отметки ставит пользователь с requirement.create' USING ERRCODE = '42501';
  END IF;
  IF NEW.mark = 'not_requirement' AND NEW.reason IS NULL THEN
    RAISE EXCEPTION 'registry_mark_batch: «не требование» — с причиной' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER registry_mark_batch_guard BEFORE INSERT ON registry_mark_batch
  FOR EACH ROW EXECUTE FUNCTION registry_mark_batch_guard();
CREATE TRIGGER registry_mark_batch_immutable BEFORE UPDATE OR DELETE ON registry_mark_batch
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER registry_mark_batch_no_truncate BEFORE TRUNCATE ON registry_mark_batch
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Отметка: транзакция пакета, отметка пакета, фрагмент снимка реестра допустимого происхождения;
-- история по фрагменту линейна под блокировкой реестра (та же, что у записи завершения).
CREATE FUNCTION registry_fragment_mark_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_batch registry_mark_batch%ROWTYPE;
  v_last  int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('requirement_registry_review'), hashtext(NEW.registry_id::text));
  SELECT * INTO v_batch FROM registry_mark_batch WHERE id = NEW.batch_id;
  IF v_batch.created_xact <> pg_current_xact_id() OR v_batch.mark <> NEW.mark THEN
    RAISE EXCEPTION 'registry_fragment_mark: отметки пишет транзакция пакета с его отметкой' USING ERRCODE = '55000';
  END IF;
  IF NOT evidence_scope_has_fragment((SELECT evidence_scope_id FROM requirement_registry WHERE id = NEW.registry_id), NEW.fragment_id)
     OR NOT evidence_origin_reviewable((SELECT origin FROM evidence_fragment WHERE id = NEW.fragment_id)) THEN
    RAISE EXCEPTION 'registry_fragment_mark: фрагмент не входит в проход полноты реестра' USING ERRCODE = '23514';
  END IF;
  SELECT max(seq) INTO v_last FROM registry_fragment_mark WHERE registry_id = NEW.registry_id AND fragment_id = NEW.fragment_id;
  IF NEW.seq <> coalesce(v_last, 0) + 1 THEN
    RAISE EXCEPTION 'registry_fragment_mark: отметка встаёт за последней отметкой фрагмента' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER registry_fragment_mark_guard BEFORE INSERT ON registry_fragment_mark
  FOR EACH ROW EXECUTE FUNCTION registry_fragment_mark_guard();
CREATE TRIGGER registry_fragment_mark_immutable BEFORE UPDATE OR DELETE ON registry_fragment_mark
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER registry_fragment_mark_no_truncate BEFORE TRUNCATE ON registry_fragment_mark
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

CREATE FUNCTION registry_mark_batch_commit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM registry_fragment_mark WHERE batch_id = NEW.id) <> NEW.fragment_count THEN
    RAISE EXCEPTION 'registry_mark_batch: число отметок не совпадает с развёрнутым набором фрагментов' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER registry_mark_batch_commit_check AFTER INSERT ON registry_mark_batch
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION registry_mark_batch_commit_check();

-- Состояние каждого допустимого фрагмента снимка реестра (Р-08-7): covered — основание кандидата или ревизии
-- требования реестра; reviewed — только основание факта; explicitly_not_requirement — действующая отметка
-- без связей; иначе unreviewed. Связь важнее отметки: отметка остаётся в истории.
CREATE FUNCTION registry_fragment_states(p_registry uuid) RETURNS TABLE (fragment_id uuid, scope_item_id uuid, state text)
LANGUAGE sql STABLE AS $$
  WITH frag AS (
    SELECT f.id AS fragment_id, i.id AS scope_item_id
      FROM requirement_registry g
      JOIN evidence_scope_item i ON i.scope_id = g.evidence_scope_id
      JOIN evidence_fragment f
        ON f.source_unit_id = coalesce(i.recognition_run_id, i.mail_message_revision_id, i.transcript_revision_id, i.qa_item_revision_id)
     WHERE g.id = p_registry AND evidence_origin_reviewable(f.origin)),
  req AS (
    SELECT l.fragment_id FROM evidence_link l JOIN requirement_candidate c ON c.id = l.requirement_candidate_id WHERE c.registry_id = p_registry
    UNION
    SELECT l.fragment_id FROM evidence_link l JOIN requirement_revision v ON v.id = l.requirement_revision_id WHERE v.registry_id = p_registry),
  fct AS (
    SELECT l.fragment_id FROM evidence_link l JOIN fact_candidate c ON c.id = l.fact_candidate_id WHERE c.registry_id = p_registry
    UNION
    SELECT l.fragment_id FROM evidence_link l JOIN fact_revision v ON v.id = l.fact_revision_id WHERE v.registry_id = p_registry),
  mk AS (
    SELECT DISTINCT ON (m.fragment_id) m.fragment_id, m.mark
      FROM registry_fragment_mark m WHERE m.registry_id = p_registry
     ORDER BY m.fragment_id, m.seq DESC)
  SELECT frag.fragment_id, frag.scope_item_id,
         CASE WHEN req.fragment_id IS NOT NULL THEN 'covered'
              WHEN fct.fragment_id IS NOT NULL THEN 'reviewed'
              WHEN mk.mark = 'not_requirement' THEN 'explicitly_not_requirement'
              ELSE 'unreviewed' END
    FROM frag
    LEFT JOIN req ON req.fragment_id = frag.fragment_id
    LEFT JOIN fct ON fct.fragment_id = frag.fragment_id
    LEFT JOIN mk ON mk.fragment_id = frag.fragment_id
$$;

-- Счётчики прохода: total = reviewed + explicit_not_requirement + unreviewed; covered ⊆ reviewed. Единица снимка
-- без допустимых фрагментов в счётчики фрагментов не входит и считается отдельно (И-08-15).
CREATE FUNCTION registry_completeness(p_registry uuid)
RETURNS TABLE (total_units int, reviewed_units int, covered_units int, explicit_not_requirement_units int, unreviewed_units int, empty_units int)
LANGUAGE sql STABLE AS $$
  SELECT count(*)::int,
         count(*) FILTER (WHERE s.state IN ('covered', 'reviewed'))::int,
         count(*) FILTER (WHERE s.state = 'covered')::int,
         count(*) FILTER (WHERE s.state = 'explicitly_not_requirement')::int,
         count(*) FILTER (WHERE s.state = 'unreviewed')::int,
         (SELECT count(*)::int FROM requirement_registry g JOIN evidence_scope_item i ON i.scope_id = g.evidence_scope_id
           WHERE g.id = p_registry
             AND NOT EXISTS (SELECT 1 FROM evidence_fragment f
                              WHERE f.source_unit_id = coalesce(i.recognition_run_id, i.mail_message_revision_id, i.transcript_revision_id, i.qa_item_revision_id)
                                AND evidence_origin_reviewable(f.origin)))
    FROM registry_fragment_states(p_registry) s
$$;

-- Запись завершения прохода: счётчики пересчитывает БД; при unreviewed > 0 завершения нет (инвариант 10).
CREATE TABLE requirement_registry_review (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                      uuid NOT NULL,
  registry_id                    uuid NOT NULL,
  seq                            int NOT NULL CHECK (seq > 0),
  total_units                    int NOT NULL CHECK (total_units >= 0),
  reviewed_units                 int NOT NULL CHECK (reviewed_units >= 0),
  covered_units                  int NOT NULL CHECK (covered_units >= 0),
  explicit_not_requirement_units int NOT NULL CHECK (explicit_not_requirement_units >= 0),
  unreviewed_units               int NOT NULL CHECK (unreviewed_units = 0),
  empty_units                    int NOT NULL CHECK (empty_units >= 0),
  completed_by                   uuid NOT NULL REFERENCES app_user (id),
  completed_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requirement_registry_review_registry_fk FOREIGN KEY (registry_id, tender_id) REFERENCES requirement_registry (id, tender_id),
  CONSTRAINT requirement_registry_review_seq_key UNIQUE (registry_id, seq),
  CONSTRAINT requirement_registry_review_sum CHECK (
    total_units = reviewed_units + explicit_not_requirement_units + unreviewed_units AND covered_units <= reviewed_units)
);

CREATE FUNCTION requirement_registry_review_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_c    record;
  v_last int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('requirement_registry_review'), hashtext(NEW.registry_id::text));
  IF NOT requirement_registry_is_active(NEW.registry_id) THEN
    RAISE EXCEPTION 'requirement_registry_review: проход завершается только в активном реестре' USING ERRCODE = '23514';
  END IF;
  IF NOT has_stage_capability(NEW.completed_by, (SELECT stage_id FROM requirement_registry WHERE id = NEW.registry_id), 'requirement.manage') THEN
    RAISE EXCEPTION 'requirement_registry_review: проход завершает пользователь с requirement.manage' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_c FROM registry_completeness(NEW.registry_id);
  IF v_c.unreviewed_units > 0 THEN
    RAISE EXCEPTION 'requirement_registry_review: % непросмотренных фрагментов — реестр не полон (инвариант 10)', v_c.unreviewed_units USING ERRCODE = '23514';
  END IF;
  IF (NEW.total_units, NEW.reviewed_units, NEW.covered_units, NEW.explicit_not_requirement_units, NEW.unreviewed_units, NEW.empty_units)
     IS DISTINCT FROM (v_c.total_units, v_c.reviewed_units, v_c.covered_units, v_c.explicit_not_requirement_units, v_c.unreviewed_units, v_c.empty_units) THEN
    RAISE EXCEPTION 'requirement_registry_review: счётчики не совпадают с состоянием фрагментов' USING ERRCODE = '23514';
  END IF;
  SELECT max(seq) INTO v_last FROM requirement_registry_review WHERE registry_id = NEW.registry_id;
  IF NEW.seq <> coalesce(v_last, 0) + 1 THEN
    RAISE EXCEPTION 'requirement_registry_review: номер — следующий по реестру' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_registry_review_guard BEFORE INSERT ON requirement_registry_review
  FOR EACH ROW EXECUTE FUNCTION requirement_registry_review_guard();
CREATE TRIGGER requirement_registry_review_immutable BEFORE UPDATE OR DELETE ON requirement_registry_review
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER requirement_registry_review_no_truncate BEFORE TRUNCATE ON requirement_registry_review
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Статус интеграции (OD-08-2)

-- Шлюз генеративной модели: контракт проверен поддельным провайдером и поддельным HTTP-сервером (VERIFIED_FIXTURE);
-- живой прогон — на целевом ПК с GPU (U-01/U-05), до него — NOT_RUN.
INSERT INTO integration_status (system, component, status, details)
VALUES ('model', 'ModelGateway', 'VERIFIED_FIXTURE', '{"live": "NOT_RUN", "blockedBy": "U-01"}'::jsonb)
ON CONFLICT (system, component) DO NOTHING;

-- ---------------------------------------------------------------- Права роли приложения

GRANT SELECT, INSERT, UPDATE ON requirement_registry_active, analysis_run, requirement_candidate, fact_candidate,
  requirement, fact, assumption, customer_question TO kontur_app;
GRANT SELECT, INSERT ON requirement_registry, analysis_run_input, requirement_revision, fact_revision, evidence_link,
  requirement_coverage, requirement_coverage_object, assumption_revision, stage_note, registry_mark_batch,
  registry_fragment_mark, requirement_registry_review TO kontur_app;
GRANT SELECT ON fact_kind TO kontur_app;
GRANT SELECT ON requirement_registry, requirement_registry_active, analysis_run, analysis_run_input, requirement_candidate,
  requirement, requirement_revision, fact_kind, fact, fact_revision, fact_candidate, evidence_link, requirement_coverage,
  requirement_coverage_object, assumption, assumption_revision, customer_question, stage_note, registry_mark_batch,
  registry_fragment_mark, requirement_registry_review TO kontur_backup;
