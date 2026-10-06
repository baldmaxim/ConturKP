-- Этап 10, Review 10-1: R10-01. Новая версия причины изменения не записывается по уже заменённому основанию. Отметка
-- «основание изменилось» ставится заданием инвалидации только существующим причинам; причина, записанная после
-- обработки события, его пропускала, а 0026 проверяла лишь принадлежность фрагмента любому снимку этапа.
-- Заменённое основание — то, что событие барьера сделало бы точной целью инвалидации (invalidation.ts analyzeEvent),
-- по текущему состоянию, а не по журналу событий: так отказ не зависит от того, обработано ли событие:
--   - фрагмент редакции документа, у которой есть следующая редакция;
--   - фрагмент прогона распознавания, заменённого завершённым прогоном той же редакции;
--   - фрагмент редакции письма или транскрипции, у которой есть следующая редакция;
--   - фрагмент редакции документа, исключённой из состава источников этапа (была включена в прежней ревизии состава,
--     в последней ревизии того же состава не включена);
--   - решение, заменённое следующим решением.
-- Код отвергает такую причину до записи (409 basis_superseded); здесь — вторая линия: при вставке основания и повторно
-- в конце транзакции (если замена зафиксирована параллельно). Принятые миграции не меняются (ADR-002).

-- Причина замены основания или NULL, если основание действующее.
CREATE FUNCTION change_basis_supersession(p_stage uuid, p_fragment uuid, p_decision uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_fragment IS NOT NULL THEN (
      SELECT CASE
        WHEN f.document_revision_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM document_revision n WHERE n.supersedes_revision_id = f.document_revision_id)
          THEN 'document_revision_superseded'
        WHEN f.source_unit_type = 'recognition_run'
             AND EXISTS (SELECT 1 FROM recognition_run n WHERE n.supersedes_run_id = f.source_unit_id AND n.status IN ('complete', 'partial'))
          THEN 'recognition_run_superseded'
        WHEN f.source_unit_type = 'mail_message_revision'
             AND EXISTS (SELECT 1 FROM mail_message_revision n WHERE n.supersedes_revision_id = f.source_unit_id)
          THEN 'mail_message_revision_superseded'
        WHEN f.source_unit_type = 'transcript_revision'
             AND EXISTS (SELECT 1 FROM transcript_revision n WHERE n.supersedes_revision_id = f.source_unit_id)
          THEN 'transcript_revision_superseded'
        WHEN f.document_revision_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM source_set s
                 JOIN LATERAL (SELECT r.id, r.seq FROM source_set_revision r WHERE r.source_set_id = s.id ORDER BY r.seq DESC LIMIT 1) last ON true
                WHERE s.stage_id = p_stage
                  AND EXISTS (SELECT 1 FROM source_set_revision r JOIN source_set_item i ON i.source_set_revision_id = r.id
                               WHERE r.source_set_id = s.id AND r.seq < last.seq AND i.document_revision_id = f.document_revision_id
                                 AND i.inclusion <> 'excluded_not_applicable')
                  AND NOT EXISTS (SELECT 1 FROM source_set_item i WHERE i.source_set_revision_id = last.id
                                   AND i.document_revision_id = f.document_revision_id AND i.inclusion <> 'excluded_not_applicable'))
          THEN 'excluded_from_source_set'
      END
      FROM evidence_fragment f WHERE f.id = p_fragment)
    WHEN p_decision IS NOT NULL AND EXISTS (SELECT 1 FROM decision n WHERE n.supersedes_decision_id = p_decision)
      THEN 'decision_superseded'
  END
$$;

-- Основание новой версии причины — только действующее.
CREATE FUNCTION change_explanation_basis_fresh() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage uuid;
  v_cause text;
BEGIN
  SELECT c.stage_id INTO v_stage FROM change_explanation e JOIN calculation_comparison c ON c.id = e.comparison_id WHERE e.id = NEW.explanation_id;
  v_cause := change_basis_supersession(v_stage, NEW.fragment_id, NEW.decision_id);
  IF v_cause IS NOT NULL THEN
    RAISE EXCEPTION 'change_explanation_basis: основание заменено (%): новая версия причины по нему не записывается', v_cause USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
-- При вставке (сразу) и в конце транзакции (замена, зафиксированная параллельно до фиксации причины).
CREATE TRIGGER change_explanation_basis_fresh AFTER INSERT ON change_explanation_basis
  FOR EACH ROW EXECUTE FUNCTION change_explanation_basis_fresh();
CREATE CONSTRAINT TRIGGER change_explanation_basis_fresh_at_commit AFTER INSERT ON change_explanation_basis
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION change_explanation_basis_fresh();
