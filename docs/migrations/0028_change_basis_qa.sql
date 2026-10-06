-- Этап 10, Review 10-2: R10-03. Функция актуальности основания причины (0027) не проверяла тип источника фрагмента
-- qa_item_revision (ответ заказчика, 0019): заменённая редакция ответа принималась основанием новой причины
-- «подтверждено» — и в API, и обоими триггерами 0027, которые пользуются этой функцией. Функция заменяется целиком;
-- ветка есть у каждого типа источника фрагмента из evidence_fragment_source_unit_type_check (recognition_run,
-- mail_message_revision, transcript_revision, qa_item_revision) — это проверяет тест. Событие qa_form_added уже
-- инвалидирует зависимости от прежней редакции ответа точно (invalidation.ts), здесь — тот же объект по текущему
-- состоянию. Принятые миграции 0001–0027 не меняются (ADR-002).

CREATE OR REPLACE FUNCTION change_basis_supersession(p_stage uuid, p_fragment uuid, p_decision uuid) RETURNS text
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
        WHEN f.source_unit_type = 'qa_item_revision'
             AND EXISTS (SELECT 1 FROM qa_item_revision n WHERE n.supersedes_revision_id = f.source_unit_id)
          THEN 'qa_item_revision_superseded'
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
