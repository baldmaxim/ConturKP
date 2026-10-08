-- Этап 13, Review 13-2: R13-05 — полный отпечаток содержимого этапа. Принятые 0001–0035 не меняются (ADR-002);
-- функция неснимаемых блокеров заменяется целиком.
--
-- R13-05. Отпечаток 0035 (`stage_content_fingerprint`) собирал части как «количество и максимум»: у вопросов заказчику —
-- `max(row_version + epoch(updated_at))`. Изменение вопроса, который не стал максимумом (второй вопрос отправлен после
-- прогона, а у первого ревизия 33), отпечаток не меняло: прогон считался актуальным, согласование и выпуск проходили.
-- Кроме того, вход прогона читает и то, чего в 0035 не было: кандидатов требований и фактов (полнота реестра), ревизии
-- фактов, решения человека по парам фактов единиц снимка, роли документов снимка в графе договора. Извлечения фактов не
-- входят: извлечение единицы при одной версии правил одно (UNIQUE), а прогон, начатый до его завершения, неполон по
-- обработке — неснимаемый REVIEW_PROCESSING_INCOMPLETE.
--
-- Отпечаток v2 — полные упорядоченные наборы ID этих записей; у изменяемых строк — ID@row_version (их охранники требуют
-- row_version + 1 при каждом изменении), у документа — поля графа (охранника версии у него нет). Времени в отпечатке нет:
-- он не зависит от часового пояса сессии. Прежняя функция v1 остаётся: по ней сервер называет причину устаревания
-- прогона, закреплённого до 0036 (такой вход тоже устарел — v1 полноту изменений не доказывает).

-- ---------------------------------------------------------------- Отпечаток содержимого этапа v2

-- Повторяет stageContentFingerprint (packages/db/src/reviewRuns.ts) байт в байт: те же части через перевод строки,
-- SHA-256 строки «kontur.stage_content.v2\n…» в UTF-8. Совпадение реализаций и чувствительность каждой части проверяет
-- tests/approvalSchema.test.ts. Правки полей приложений (S12-01) в отпечаток не входят.
CREATE FUNCTION stage_content_fingerprint_v2(p_stage uuid, p_registry uuid, p_scope uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to('kontur.stage_content.v2' || chr(10) || fp.v, 'UTF8')), 'hex') FROM (
SELECT concat_ws(chr(10),
  'requirement:' || coalesce((SELECT string_agg(q.id::text || '@' || q.row_version, ',' ORDER BY q.id) FROM requirement q
                               WHERE q.id IN (SELECT v.requirement_id FROM requirement_revision v WHERE v.registry_id = p_registry)), ''),
  'requirement_revision:' || coalesce((SELECT string_agg(v.id::text, ',' ORDER BY v.id) FROM requirement_revision v WHERE v.registry_id = p_registry), ''),
  'requirement_candidate:' || coalesce((SELECT string_agg(c.id::text || '@' || c.row_version, ',' ORDER BY c.id) FROM requirement_candidate c WHERE c.registry_id = p_registry), ''),
  'fact_candidate:' || coalesce((SELECT string_agg(c.id::text || '@' || c.row_version, ',' ORDER BY c.id) FROM fact_candidate c WHERE c.registry_id = p_registry), ''),
  'fact_revision:' || coalesce((SELECT string_agg(v.id::text, ',' ORDER BY v.id) FROM fact_revision v WHERE v.registry_id = p_registry), ''),
  'registry_fragment_mark:' || coalesce((SELECT string_agg(m.id::text, ',' ORDER BY m.id) FROM registry_fragment_mark m WHERE m.registry_id = p_registry), ''),
  'requirement_registry_review:' || coalesce((SELECT string_agg(w.id::text, ',' ORDER BY w.id) FROM requirement_registry_review w WHERE w.registry_id = p_registry), ''),
  'requirement_coverage:' || coalesce((SELECT string_agg(c.id::text, ',' ORDER BY c.id) FROM requirement_coverage c WHERE c.stage_id = p_stage), ''),
  'assumption:' || coalesce((SELECT string_agg(a.id::text || '@' || a.row_version, ',' ORDER BY a.id) FROM assumption a WHERE a.stage_id = p_stage), ''),
  'assumption_revision:' || coalesce((SELECT string_agg(v.id::text, ',' ORDER BY v.id) FROM assumption_revision v WHERE v.stage_id = p_stage), ''),
  'customer_question:' || coalesce((SELECT string_agg(q.id::text || '@' || q.row_version, ',' ORDER BY q.id) FROM customer_question q WHERE q.stage_id = p_stage), ''),
  'requirement_decision:' || coalesce((SELECT string_agg(d.id::text, ',' ORDER BY d.id) FROM decision d WHERE d.stage_id = p_stage AND d.decision_type = 'requirement_decision'), ''),
  'fact_decision:' || coalesce((SELECT string_agg(fd.id::text, ',' ORDER BY fd.id) FROM fact_decision fd
                                 WHERE fd.fact_id IN (SELECT f.id FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id
                                                       WHERE x.recognition_run_id IN (SELECT i.recognition_run_id FROM evidence_scope_item i WHERE i.scope_id = p_scope))), ''),
  'document:' || coalesce((SELECT string_agg(concat_ws('/', d.id::text, coalesce(d.contract_role, ''), coalesce(d.main_document_id::text, ''), coalesce(d.main_document_role, '')), ',' ORDER BY d.id)
                            FROM document d WHERE d.id IN (SELECT v.document_id FROM document_revision v JOIN evidence_scope_item i ON i.document_revision_id = v.id WHERE i.scope_id = p_scope)), '')) AS v
  ) AS fp
$$;

-- ---------------------------------------------------------------- Неснимаемые блокеры (0035 + R13-05)

CREATE OR REPLACE FUNCTION candidate_gate_problem(p_candidate uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c release_candidate%ROWTYPE;
  v_run_ok boolean := false;
BEGIN
  SELECT * INTO c FROM release_candidate WHERE id = p_candidate;
  IF NOT FOUND THEN
    RETURN 'CANDIDATE_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_uncovered_events(c.id)) THEN
    RETURN 'INPUTS_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM intake_channel ch WHERE ch.tender_id = c.tender_id AND ch.active
                AND (ch.last_successful_scan_at IS NULL OR ch.last_successful_scan_at < now() - ch.freshness_window)) THEN
    RETURN 'INTAKE_NOT_CURRENT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM candidate_input ci JOIN review_run r ON r.id = ci.ref_id
                  WHERE ci.candidate_id = c.id AND ci.kind = 'review_run' AND r.status IN ('completed', 'completed_with_gaps')) THEN
    RETURN 'REVIEW_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_input ci JOIN review_run r ON r.id = ci.ref_id
              WHERE ci.candidate_id = c.id AND ci.kind = 'review_run'
                AND (r.evidence_scope_id <> c.evidence_scope_id OR r.calculation_revision_id IS DISTINCT FROM c.calculation_revision_id)) THEN
    RETURN 'REVIEW_SCOPE_MISMATCH';
  END IF;
  -- R13-01, R13-05: вход прогона закреплён при запуске вместе с отпечатком содержимого этапа (R09-02); отпечаток v2
  -- (полные наборы записей, которые читает вход прогона) не совпадает с текущим — прогон устарел. Прогон без закреплённого
  -- входа (до 0025) и вход, закреплённый прежним отпечатком v1 (до 0036), полноту изменений не доказывают — тоже устарел.
  IF EXISTS (SELECT 1 FROM candidate_input ci JOIN review_run r ON r.id = ci.ref_id LEFT JOIN review_run_input i ON i.run_id = r.id
              WHERE ci.candidate_id = c.id AND ci.kind = 'review_run' AND r.status IN ('completed', 'completed_with_gaps')
                AND (i.run_id IS NULL OR i.content_fingerprint <> stage_content_fingerprint_v2(r.stage_id, r.registry_id, r.evidence_scope_id))) THEN
    RETURN 'REVIEW_OUTDATED';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_input ci JOIN review_check_result x ON x.run_id = ci.ref_id
              WHERE ci.candidate_id = c.id AND ci.kind = 'review_run'
                AND (x.outcome = 'error' OR (x.outcome = 'incomplete' AND x.check_code <> 'coverage'))) THEN
    RETURN 'REVIEW_PROCESSING_INCOMPLETE';
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_input ci WHERE ci.candidate_id = c.id AND ci.kind = 'field_version'
                AND (field_version_basis_problem(c.stage_id, ci.ref_id) IS NOT NULL OR field_version_invalidated(ci.ref_id))) THEN
    RETURN 'FIELDS_STALE';
  END IF;
  IF c.mode = 'production' THEN
    IF EXISTS (SELECT 1 FROM calculation_revision r WHERE r.id = c.calculation_revision_id AND r.kind = 'provisional') THEN
      RETURN 'CALCULATION_PROVISIONAL';
    END IF;
    IF EXISTS (SELECT 1 FROM candidate_input ci JOIN template_revision r ON r.id = ci.ref_id JOIN application_template t ON t.id = r.template_id
                WHERE ci.candidate_id = c.id AND ci.kind = 'template_revision' AND t.is_demo) THEN
      RETURN 'TEMPLATE_DEMO';
    END IF;
    IF EXISTS (SELECT 1 FROM calculation_revision r JOIN calculation_content cc ON cc.id = r.content_id
                WHERE r.id = c.calculation_revision_id AND cc.kp_total_rule IS NULL) THEN
      RETURN 'KP_TOTAL_NOT_APPROVED';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
