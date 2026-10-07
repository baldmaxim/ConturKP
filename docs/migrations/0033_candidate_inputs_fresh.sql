-- Этап 12, Review 12-1: R12-02 — вторая линия. Принятые 0001–0032 не меняются (ADR-002); функция заменяется целиком.
--
-- R12-02. Кандидат закреплял «заполненное» приложение и текущие версии его полей, проверяя только сохранённый статус
-- приложения: значение, основание которого заменено после «заполнено» (новая редакция документа, заменённая ревизия
-- требования под решением, источник подтверждённой копии), попадало в комплект, а событие замены лежало до базы
-- кандидата. Теперь вход-приложение — «заполнено» без проблемы заполненности (`draft_completion_problem`, 0031: обязательные
-- поля, перенос, обсуждение, основания всей цепочки текущих версий); вход-версия — текущая версия своего поля без
-- проблемы основания по цепочке копий (`field_version_basis_problem`) и без отметки инвалидации у неё и у версий-
-- источников неподтверждённой копии (`field_version_invalidated`). Первая линия — сервер под блокировкой этапа (та же,
-- что у записи событий входов), поэтому проверка и закрепление видят одно состояние входов.

CREATE OR REPLACE FUNCTION candidate_input_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c release_candidate%ROWTYPE;
  v_ok boolean;
  v_problem text;
BEGIN
  SELECT * INTO c FROM release_candidate WHERE id = NEW.candidate_id;
  IF c.created_xact <> pg_current_xact_id() OR c.status <> 'assembling' THEN
    RAISE EXCEPTION 'candidate_input: входы закрепляются в транзакции создания кандидата' USING ERRCODE = '55000';
  END IF;
  v_ok := CASE NEW.kind
    WHEN 'review_run' THEN EXISTS (SELECT 1 FROM review_run r WHERE r.id = NEW.ref_id AND r.stage_id = c.stage_id)
    WHEN 'decision' THEN EXISTS (SELECT 1 FROM decision d WHERE d.id = NEW.ref_id AND d.stage_id = c.stage_id)
    WHEN 'application_draft' THEN EXISTS (SELECT 1 FROM application_draft a WHERE a.id = NEW.ref_id AND a.stage_id = c.stage_id AND a.status = 'complete')
    WHEN 'field_version' THEN EXISTS (SELECT 1 FROM draft_field_version v JOIN application_draft a ON a.id = v.draft_id WHERE v.id = NEW.ref_id AND a.stage_id = c.stage_id)
    WHEN 'template_revision' THEN EXISTS (SELECT 1 FROM template_revision r WHERE r.id = NEW.ref_id AND r.status = 'approved' AND (r.tender_id IS NULL OR r.tender_id = c.tender_id)
                                           AND (r.markup ->> 'ok')::boolean)
    WHEN 'attachment_revision' THEN EXISTS (SELECT 1 FROM standard_attachment_revision r JOIN standard_attachment a ON a.id = r.attachment_id
                                             WHERE r.id = NEW.ref_id AND r.status = 'approved' AND (a.scope_tender_id IS NULL OR a.scope_tender_id = c.tender_id))
  END;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'candidate_input: вход % — не объект этапа и тендера кандидата или не в допустимом состоянии', NEW.kind USING ERRCODE = '23514';
  END IF;
  -- R12-02: заполненность приложения и свежесть закрепляемой версии — на момент закрепления.
  IF NEW.kind = 'application_draft' THEN
    v_problem := draft_completion_problem(NEW.ref_id);
  ELSIF NEW.kind = 'field_version' THEN
    v_problem := CASE
      WHEN EXISTS (SELECT 1 FROM draft_field_version v JOIN draft_field_version n ON n.field_id = v.field_id AND n.version > v.version WHERE v.id = NEW.ref_id) THEN 'not_latest'
      WHEN field_version_invalidated(NEW.ref_id) THEN 'invalidated'
      ELSE field_version_basis_problem(c.stage_id, NEW.ref_id)
    END;
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'candidate_input: вход % не закрепляется — %', NEW.kind, v_problem USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
