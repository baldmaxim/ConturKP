-- Этап 16, Review 16-1 (R16-01): происхождение вопроса заказчику. Вопрос, созданный принятием предложения из чата,
-- копировал текст предложения без его цитат: предложение оставалось закрытым по цитате письма, а вопрос читал любой
-- участник тендера. Принятие человеком не снимает прав на источник (I13, R08-02): вопрос хранит ссылку на
-- предложение, из которого создан, и наследует закрытость его цитат. Ссылка неизменна — правкой текста или статуса
-- ограничение не снять.
-- Тем же правилом закрыта отвязка требования (S16-12): вопрос мог повторить текст требования, с которым был связан,
-- поэтому связи копятся в `basis_requirement_ids` и наследование закрытости отвязкой не снимается.
-- Вторая линия: принятое предложение любого вида обязано создать запись своего вида, которая несёт все его цитаты.

ALTER TABLE customer_question
  ADD COLUMN source_proposal_id    uuid REFERENCES mcp_proposal (id),
  ADD COLUMN basis_requirement_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
CREATE UNIQUE INDEX customer_question_source_proposal_key ON customer_question (source_proposal_id) WHERE source_proposal_id IS NOT NULL;

-- Существующие вопросы: текущая связь с требованием — в историю связей; вопросы из уже принятых предложений получают
-- происхождение по записи результата предложения. Строка вопроса при этом не меняет версию (содержимое прежнее):
-- охранник снимается только на время этого заполнения в транзакции миграции.
ALTER TABLE customer_question DISABLE TRIGGER customer_question_guard;
UPDATE customer_question SET basis_requirement_ids = ARRAY[requirement_id] WHERE requirement_id IS NOT NULL;
UPDATE customer_question q
   SET source_proposal_id = p.id
  FROM mcp_proposal p
 WHERE p.kind = 'question' AND p.status = 'accepted' AND p.result_type = 'customer_question' AND p.result_id = q.id;
ALTER TABLE customer_question ENABLE TRIGGER customer_question_guard;

-- Охранник вопроса (0019) с происхождением: ссылка на предложение ставится только при создании и только на открытое
-- предложение-вопрос этого этапа; дальше неизменна. Историю связей с требованиями ведёт сам охранник.
CREATE OR REPLACE FUNCTION customer_question_guard() RETURNS trigger
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
    IF NEW.source_proposal_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM mcp_proposal p
          WHERE p.id = NEW.source_proposal_id AND p.kind = 'question' AND p.status = 'open' AND p.stage_id = NEW.stage_id AND p.tender_id = NEW.tender_id) THEN
      RAISE EXCEPTION 'customer_question: происхождение — открытое предложение вопроса этого этапа' USING ERRCODE = '23514';
    END IF;
    NEW.basis_requirement_ids := CASE WHEN NEW.requirement_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[NEW.requirement_id] END;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.created_by, OLD.created_at)
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'customer_question: неизменяемые поля или row_version' USING ERRCODE = '55000';
  END IF;
  IF NEW.source_proposal_id IS DISTINCT FROM OLD.source_proposal_id THEN
    RAISE EXCEPTION 'customer_question: происхождение вопроса неизменно' USING ERRCODE = '55000';
  END IF;
  -- Связь с требованием можно снять или заменить, но прежние связи остаются в истории. Значение клиента не учитывается;
  -- прежняя связь берётся и из самой строки, так что история не зависит от заполнения выше.
  NEW.basis_requirement_ids := ARRAY(SELECT DISTINCT r FROM unnest(OLD.basis_requirement_ids || OLD.requirement_id || NEW.requirement_id) AS r
                                      WHERE r IS NOT NULL ORDER BY r);
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

-- К фиксации транзакции вопрос с происхождением — результат именно этого принятого предложения: ссылку нельзя
-- поставить на предложение, которое осталось открытым или дало другую запись.
CREATE FUNCTION customer_question_origin_settled() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mcp_proposal p
                  WHERE p.id = NEW.source_proposal_id AND p.status = 'accepted' AND p.result_type = 'customer_question' AND p.result_id = NEW.id) THEN
    RAISE EXCEPTION 'customer_question: вопрос с происхождением создаётся принятием своего предложения' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER customer_question_origin_settled AFTER INSERT ON customer_question
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_proposal_id IS NOT NULL) EXECUTE FUNCTION customer_question_origin_settled();

-- Охранник предложения (0040) с результатом: принятое предложение создаёт запись своего вида, и она несёт все его
-- цитаты — основаниями замечания, основаниями причины либо ссылкой вопроса на само предложение. Текст условия записи
-- не создаёт. Так ограничение чтения источника не теряется копированием текста ни у одного вида предложения.
CREATE OR REPLACE FUNCTION mcp_proposal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cap text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM tender_stage s WHERE s.id = NEW.stage_id AND s.tender_id = NEW.tender_id) THEN
      RAISE EXCEPTION 'mcp_proposal: этап не принадлежит тендеру' USING ERRCODE = '23514';
    END IF;
    -- Токен — действующий, этого пользователя, с областью propose; пользователь вправе предлагать в этом тендере.
    IF NOT EXISTS (SELECT 1 FROM api_token t
                    WHERE t.id = NEW.api_token_id AND t.user_id = NEW.on_behalf_of_user_id AND t.revoked_at IS NULL AND t.expires_at > now()
                      AND 'propose' = ANY (t.scopes)) THEN
      RAISE EXCEPTION 'mcp_proposal: нужен действующий токен пользователя с областью propose' USING ERRCODE = '42501';
    END IF;
    IF NOT coalesce('mcp.propose' = ANY (tender_capabilities(NEW.on_behalf_of_user_id, NEW.tender_id)), false) THEN
      RAISE EXCEPTION 'mcp_proposal: предлагает инженер или руководитель тендера (mcp.propose)' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'open' OR NEW.decided_by IS NOT NULL OR NEW.result_id IS NOT NULL OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'mcp_proposal: предложение создаётся открытым' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- Содержимое неизменно; открытое предложение один раз становится принятым или отклонённым решением человека.
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.kind, NEW.title, NEW.body, NEW.detail, NEW.request_id, NEW.request_sha256, NEW.api_token_id,
      NEW.on_behalf_of_user_id, NEW.created_at, NEW.created_xact)
     IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.kind, OLD.title, OLD.body, OLD.detail, OLD.request_id, OLD.request_sha256, OLD.api_token_id,
      OLD.on_behalf_of_user_id, OLD.created_at, OLD.created_xact) THEN
    RAISE EXCEPTION 'mcp_proposal: содержимое предложения неизменно' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'open' OR NEW.status NOT IN ('accepted', 'rejected') OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'mcp_proposal: решение принимается один раз по открытому предложению' USING ERRCODE = '55000';
  END IF;
  -- Решает человек тендера с возможностью, которая нужна для такой записи в портале; модель решить не может (I12).
  v_cap := CASE OLD.kind WHEN 'finding' THEN 'finding.write' WHEN 'question' THEN 'requirement.create'
                         WHEN 'condition_text' THEN 'application.fill' ELSE 'change_reason.confirm' END;
  IF NEW.decided_by IS NULL OR NOT coalesce(v_cap = ANY (tender_capabilities(NEW.decided_by, OLD.tender_id)), false) THEN
    RAISE EXCEPTION 'mcp_proposal: решение принимает человек тендера с возможностью %', v_cap USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'accepted' THEN
    IF NEW.result_type IS DISTINCT FROM (CASE OLD.kind WHEN 'finding' THEN 'finding' WHEN 'question' THEN 'customer_question'
                                                       WHEN 'change_reason' THEN 'release_comparison_reason' END) THEN
      RAISE EXCEPTION 'mcp_proposal: принятое предложение создаёт запись своего вида' USING ERRCODE = '23514';
    END IF;
    IF (OLD.kind = 'question' AND NOT EXISTS (SELECT 1 FROM customer_question q WHERE q.id = NEW.result_id AND q.source_proposal_id = OLD.id))
       OR (OLD.kind = 'finding' AND (NOT EXISTS (SELECT 1 FROM finding f WHERE f.id = NEW.result_id AND f.stage_id = OLD.stage_id)
                                     OR EXISTS (SELECT 1 FROM mcp_proposal_fragment pf
                                                 WHERE pf.proposal_id = OLD.id
                                                   AND NOT EXISTS (SELECT 1 FROM finding_evidence e WHERE e.finding_id = NEW.result_id AND e.fragment_id = pf.fragment_id))))
       OR (OLD.kind = 'change_reason' AND (NOT EXISTS (SELECT 1 FROM release_comparison_reason r WHERE r.id = NEW.result_id AND r.tender_id = OLD.tender_id)
                                           OR EXISTS (SELECT 1 FROM mcp_proposal_fragment pf
                                                       WHERE pf.proposal_id = OLD.id
                                                         AND NOT EXISTS (SELECT 1 FROM release_comparison_reason_basis b WHERE b.reason_id = NEW.result_id AND b.fragment_id = pf.fragment_id)))) THEN
      RAISE EXCEPTION 'mcp_proposal: запись, созданная принятием, несёт все цитаты предложения' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
