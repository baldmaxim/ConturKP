-- Этап 16, Review 16-2 (R16-02): связи вопросов с требованиями, снятые до миграции 0041. Миграция 0041 начала вести
-- историю связей, но заполнила её только текущей связью: вопрос, созданный по закрытому требованию и отвязанный от
-- него прежней версией, остался с пустой историей и читался всеми участниками. Снятие связи не разрешает раскрыть
-- текст (I13, R08-02): прежние связи восстанавливаются из журнала команд, а где их установить нельзя, вопрос остаётся
-- закрытым по всем требованиям этапа.
--
-- Что известно о вопросе, созданном до 0041 (история с 0041 ведётся охранником):
--   связь при создании — в записи аудита команды `customer_question.create` (`details.requirementId`, этап 08); вопрос
--     из поля приложения («требует обсуждения») и из принятого предложения чата создаётся без связи;
--   связь меняет только правка черновика (охранник 0019); каждая правка — запись аудита `customer_question.update`
--     с `details.from`, но без значения связи;
--   связь после последней правки до 0041 — текущая на момент 0041 (её записала 0041).
-- Значит, история установлена полностью, если путь создания известен и правок черновика до 0041 было не больше одной:
-- это связь при создании и текущая. При двух и более правках промежуточные связи не записаны нигде; не записана связь
-- и у вопроса с неизвестным путём создания. Такой вопрос получает отметку `basis_unknown` и закрывается по всем
-- требованиям своего этапа: связать его можно было только с одним из них (внешний ключ на требование того же этапа).

ALTER TABLE customer_question ADD COLUMN basis_unknown boolean NOT NULL DEFAULT false;

-- Версия строк вопросов не меняется (содержимое прежнее): охранник снимается только на время заполнения.
ALTER TABLE customer_question DISABLE TRIGGER customer_question_guard;
WITH tracked_since AS (
  SELECT applied_at AS t FROM schema_migration WHERE version = 41
), created AS (
  SELECT DISTINCT ON (a.entity_id) a.entity_id AS question_id,
         CASE WHEN a.details ->> 'requirementId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              THEN (a.details ->> 'requirementId')::uuid END AS requirement_id
    FROM audit_event a
   WHERE a.entity_type = 'customer_question' AND a.action = 'customer_question.create' AND a.outcome = 'allowed' AND a.entity_id IS NOT NULL
   ORDER BY a.entity_id, a.seq
), draft_edits AS (
  SELECT a.entity_id AS question_id, count(*) AS n
    FROM audit_event a CROSS JOIN tracked_since s
   WHERE a.entity_type = 'customer_question' AND a.action = 'customer_question.update' AND a.outcome = 'allowed'
     AND a.details ->> 'from' = 'draft' AND a.occurred_at < s.t
   GROUP BY a.entity_id
), legacy AS (
  SELECT q.id,
         c.requirement_id AS initial_requirement_id,
         (c.question_id IS NULL AND q.source_proposal_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM draft_field_version v WHERE v.customer_question_id = q.id))
           OR coalesce(e.n, 0) >= 2 AS unknown
    FROM customer_question q
    CROSS JOIN tracked_since s
    LEFT JOIN created c ON c.question_id = q.id
    LEFT JOIN draft_edits e ON e.question_id = q.id
   WHERE q.created_at < s.t
)
UPDATE customer_question q
   SET basis_unknown = l.unknown,
       basis_requirement_ids = ARRAY(
         SELECT DISTINCT r
           FROM unnest(q.basis_requirement_ids || l.initial_requirement_id
                       || CASE WHEN l.unknown THEN ARRAY(SELECT x.id FROM requirement x WHERE x.stage_id = q.stage_id) ELSE '{}'::uuid[] END) AS r
          WHERE r IS NOT NULL ORDER BY r)
  FROM legacy l
 WHERE l.id = q.id;
ALTER TABLE customer_question ENABLE TRIGGER customer_question_guard;

-- Охранник вопроса (0041) с отметкой: её ставит только эта миграция, дальше она неизменна; у нового вопроса её нет.
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
    -- У нового вопроса история связей ведётся с создания: неизвестного прошлого у него нет.
    NEW.basis_unknown := false;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tender_id, NEW.stage_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tender_id, OLD.stage_id, OLD.created_by, OLD.created_at)
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'customer_question: неизменяемые поля или row_version' USING ERRCODE = '55000';
  END IF;
  IF NEW.source_proposal_id IS DISTINCT FROM OLD.source_proposal_id THEN
    RAISE EXCEPTION 'customer_question: происхождение вопроса неизменно' USING ERRCODE = '55000';
  END IF;
  IF NEW.basis_unknown IS DISTINCT FROM OLD.basis_unknown THEN
    RAISE EXCEPTION 'customer_question: отметка неустановленной истории связей неизменна' USING ERRCODE = '55000';
  END IF;
  -- Связь с требованием можно снять или заменить, но прежние связи остаются в истории. Значение клиента не учитывается;
  -- прежняя связь берётся и из самой строки.
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
