-- Этап 13, Review 13-1: R13-01 — вторая линия. Принятые 0001–0034 не меняются (ADR-002); функция неснимаемых блокеров
-- заменяется целиком.
--
-- R13-01. Согласование и выпуск допускались по прогону проверок, вход которого устарел: после прогона в реестр добавлено
-- и подтверждено требование (без нового документа, снимка и расчёта). Матрица и `candidate_gate_problem` сверяли только
-- снимок, ревизию расчёта и наличие завершённого прогона, а не закреплённый отпечаток содержимого этапа
-- (`review_run_input.content_fingerprint`, 0025). Изменение реестра не событие источника, поэтому удержания его не ловят.
-- Теперь прогон с отпечатком, не совпадающим с текущим, — неснимаемый `REVIEW_OUTDATED` (D-033 ут. 1: техническая
-- неполнота, не бизнес-риск покрытия). Первая линия — сервер под блокировкой этапа, тем же отпечатком.

-- ---------------------------------------------------------------- Отпечаток содержимого этапа

-- Повторяет stageContentFingerprint (packages/db/src/reviewRuns.ts) байт в байт: те же части через «|», та же
-- текстовая запись времени (сессия приложения), SHA-256 строки «kontur.stage_content.v1\n…» в UTF-8. Совпадение
-- реализаций проверяет tests/reviewRegressions13.test.ts. Правки полей приложения (S12-01) в отпечаток не входят.
CREATE FUNCTION stage_content_fingerprint(p_stage uuid, p_registry uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to('kontur.stage_content.v1' || chr(10) || concat_ws('|',
    (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM requirement_revision WHERE registry_id = p_registry),
    (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM requirement_coverage WHERE stage_id = p_stage),
    (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM registry_fragment_mark WHERE registry_id = p_registry),
    (SELECT count(*) || ':' || coalesce(max(completed_at)::text, '') FROM requirement_registry_review WHERE registry_id = p_registry),
    (SELECT count(*) || ':' || coalesce(max(v.created_at)::text, '') FROM assumption_revision v WHERE v.stage_id = p_stage),
    (SELECT count(*) || ':' || coalesce(max(row_version + extract(epoch FROM updated_at))::text, '') FROM customer_question WHERE stage_id = p_stage),
    (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM decision WHERE stage_id = p_stage AND decision_type = 'requirement_decision')),
    'UTF8')), 'hex');
$$;

-- ---------------------------------------------------------------- Неснимаемые блокеры (0034 + R13-01)

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
  -- R13-01: вход прогона закреплён при запуске вместе с отпечатком содержимого этапа (R09-02); после прогона изменились
  -- реестр, покрытие, отметки, допущения, вопросы или решения по требованиям — прогон устарел. Прогон без закреплённого
  -- входа (до 0025) проверить нельзя — тоже устарел.
  IF EXISTS (SELECT 1 FROM candidate_input ci JOIN review_run r ON r.id = ci.ref_id LEFT JOIN review_run_input i ON i.run_id = r.id
              WHERE ci.candidate_id = c.id AND ci.kind = 'review_run' AND r.status IN ('completed', 'completed_with_gaps')
                AND (i.run_id IS NULL OR i.content_fingerprint <> stage_content_fingerprint(r.stage_id, r.registry_id))) THEN
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
