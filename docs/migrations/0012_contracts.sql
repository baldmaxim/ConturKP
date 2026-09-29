-- 0012 — этап 06a: договорной контур. D-017, D-022 (решения владельца), D-023 (AD-06a-1, вариант B).
-- Договор — самостоятельный объект доступа рядом с тендером; связь с тендером — отдельная сущность
-- «многие ко многим». Документы договора живут в общей модели document/document_revision с явным
-- contract_id. Колонка владельца ниже по цепочке добавлена только там, где без неё не сохранить
-- инвариант БД (FK, уникальность, безопасный запрос): обоснование каждой строки —
-- docs/architecture/06a-ownership-chain.md §7. Строка с двумя ветками владельца: tender_id и
-- contract_id допускают NULL, ровно один задан (CHECK), прежний составной FK по тендеру остаётся,
-- рядом — такой же по договору. Фиктивного тендера и пары owner_type + owner_id нет.
-- Физического удаления нет (D-022 OD-5): DELETE роли приложения не выдаётся, охранники его запрещают.

-- ---------------------------------------------------------------- Договор

CREATE TABLE contract (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       text NOT NULL CHECK (length(number) BETWEEN 1 AND 100),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  counterparty text CHECK (length(counterparty) BETWEEN 1 AND 500),
  signed_on    date,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at  timestamptz,
  archived_by  uuid REFERENCES app_user (id),
  created_by   uuid NOT NULL REFERENCES app_user (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  bigint NOT NULL DEFAULT 1,
  -- Цель FK строки доступа создателя: выдачу source = creator получает только настоящий создатель.
  CONSTRAINT contract_id_creator_key UNIQUE (id, created_by),
  CONSTRAINT contract_archive_shape CHECK (
    (status = 'archived') = (archived_at IS NOT NULL) AND (archived_at IS NULL) = (archived_by IS NULL))
);

CREATE FUNCTION contract_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contract: физического удаления нет — только архив (D-022 OD-5)' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'contract: идентичность и автор договора неизменны' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contract_guard BEFORE UPDATE OR DELETE ON contract
  FOR EACH ROW EXECUTE FUNCTION contract_guard();
CREATE TRIGGER contract_no_truncate BEFORE TRUNCATE ON contract
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

-- ---------------------------------------------------------------- Доступ к договору (образец mailbox_access)

-- Явная выдача (D-017, D-022 OD-2): contract.create — глобальная, без договора; contract.read, contract.link
-- и contract.manage — по договору. Строки создателя ставит команда создания договора (source = creator),
-- остальные — администратор (admin.contract). Выдача действует, пока у пользователя есть роль инженера
-- или руководителя (packages/core/src/capabilities.ts): одной системной роли для содержимого мало.
CREATE TABLE contract_access (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id         uuid REFERENCES contract (id),
  user_id             uuid NOT NULL REFERENCES app_user (id),
  capability          text NOT NULL CHECK (capability IN ('contract.create', 'contract.read', 'contract.link', 'contract.manage')),
  source              text NOT NULL CHECK (source IN ('admin', 'creator')),
  granted_by          uuid NOT NULL REFERENCES app_user (id),
  granted_at          timestamptz NOT NULL DEFAULT now(),
  revoked_by          uuid REFERENCES app_user (id),
  revoked_at          timestamptz,
  creator_contract_id uuid GENERATED ALWAYS AS (CASE WHEN source = 'creator' THEN contract_id END) STORED,
  CONSTRAINT contract_access_scope_shape CHECK ((capability = 'contract.create') = (contract_id IS NULL)),
  CONSTRAINT contract_access_creator_shape CHECK (source <> 'creator' OR granted_by = user_id),
  CONSTRAINT contract_access_creator_fk FOREIGN KEY (creator_contract_id, user_id) REFERENCES contract (id, created_by),
  CONSTRAINT contract_access_revoke_shape CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
-- Одна действующая выдача на тройку «договор, пользователь, возможность»; глобальная — с NULL договором.
CREATE UNIQUE INDEX contract_access_active_key ON contract_access (contract_id, user_id, capability) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;
CREATE INDEX contract_access_user_idx ON contract_access (user_id) WHERE revoked_at IS NULL;

CREATE FUNCTION contract_access_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contract_access: строка доступа не удаляется — только отзыв' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'contract_access: отозванная выдача неизменна' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.user_id <> OLD.user_id
     OR NEW.capability <> OLD.capability OR NEW.source <> OLD.source
     OR NEW.granted_by <> OLD.granted_by OR NEW.granted_at <> OLD.granted_at THEN
    RAISE EXCEPTION 'contract_access: у выдачи меняется только отметка отзыва' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contract_access_guard BEFORE UPDATE OR DELETE ON contract_access
  FOR EACH ROW EXECUTE FUNCTION contract_access_guard();
CREATE TRIGGER contract_access_no_truncate BEFORE TRUNCATE ON contract_access
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

-- ---------------------------------------------------------------- Связь договора с тендером (D-022 OD-1)

-- Многие ко многим: одна строка на пару, её история — статус и журнал аудита. Связь подтверждает
-- человек с contract.link; область поиска она не расширяет ни в одну сторону (D-017, ADR-008 §10).
-- Этап — необязательное уточнение (OD-1). Снимки ссылаются на пару, поэтому строку не удалить.
CREATE TABLE contract_tender (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    uuid NOT NULL REFERENCES contract (id),
  tender_id      uuid NOT NULL REFERENCES tender (id),
  stage_id       uuid,
  note           text CHECK (length(note) BETWEEN 1 AND 500),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  confirmed_by   uuid NOT NULL REFERENCES app_user (id),
  confirmed_at   timestamptz NOT NULL DEFAULT now(),
  archived_by    uuid REFERENCES app_user (id),
  archived_at    timestamptz,
  archive_reason text CHECK (length(archive_reason) BETWEEN 1 AND 500),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  row_version    bigint NOT NULL DEFAULT 1,
  CONSTRAINT contract_tender_pair_key UNIQUE (contract_id, tender_id),
  CONSTRAINT contract_tender_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT contract_tender_archive_shape CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
    AND (archived_at IS NULL) = (archived_by IS NULL)
    AND (archived_at IS NULL) = (archive_reason IS NULL))
);
CREATE INDEX contract_tender_tender_idx ON contract_tender (tender_id);

CREATE FUNCTION contract_tender_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contract_tender: связь не удаляется — только архив (D-022 OD-5)' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.contract_id <> OLD.contract_id OR NEW.tender_id <> OLD.tender_id THEN
    RAISE EXCEPTION 'contract_tender: договор и тендер связи неизменны' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contract_tender_guard BEFORE UPDATE OR DELETE ON contract_tender
  FOR EACH ROW EXECUTE FUNCTION contract_tender_guard();
CREATE TRIGGER contract_tender_no_truncate BEFORE TRUNCATE ON contract_tender
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('history');

-- ---------------------------------------------------------------- Документ (T06A-2, AD-06a-1 §5, §11)

-- Ровно один владелец — тендер или договор. У документа договора роль: основной договор, допсоглашение
-- или приложение; допсоглашение и приложение — самостоятельные документы того же договора со ссылкой
-- на его основной документ (роль проверяет FK через генерируемую main_document_role). Основной документ
-- у договора один; его новые версии — редакции того же документа.
ALTER TABLE document ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE document
  ADD COLUMN contract_id        uuid REFERENCES contract (id),
  ADD COLUMN contract_role      text CHECK (contract_role IN ('contract', 'addendum', 'appendix')),
  ADD COLUMN main_document_id   uuid,
  ADD COLUMN main_document_role text GENERATED ALWAYS AS (CASE WHEN main_document_id IS NOT NULL THEN 'contract' END) STORED;
ALTER TABLE document
  ADD CONSTRAINT document_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  ADD CONSTRAINT document_contract_role_shape CHECK ((contract_id IS NULL) = (contract_role IS NULL)),
  ADD CONSTRAINT document_main_shape CHECK (
    CASE WHEN contract_role IN ('addendum', 'appendix') THEN main_document_id IS NOT NULL ELSE main_document_id IS NULL END),
  ADD CONSTRAINT document_id_tender_key UNIQUE (id, tender_id),
  ADD CONSTRAINT document_id_contract_key UNIQUE (id, contract_id),
  ADD CONSTRAINT document_id_contract_role_key UNIQUE (id, contract_id, contract_role);
ALTER TABLE document ADD CONSTRAINT document_main_fk
  FOREIGN KEY (main_document_id, contract_id, main_document_role) REFERENCES document (id, contract_id, contract_role);
CREATE UNIQUE INDEX document_contract_main_key ON document (contract_id) WHERE contract_role = 'contract';
CREATE INDEX document_contract_idx ON document (contract_id) WHERE contract_id IS NOT NULL;

CREATE FUNCTION document_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tender_id IS DISTINCT FROM OLD.tender_id OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.contract_role IS DISTINCT FROM OLD.contract_role OR NEW.main_document_id IS DISTINCT FROM OLD.main_document_id THEN
    RAISE EXCEPTION 'document: владелец, роль и ссылка на основной документ неизменны (D-023)' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_owner_guard BEFORE UPDATE ON document
  FOR EACH ROW EXECUTE FUNCTION document_owner_guard();

-- ---------------------------------------------------------------- Редакция документа

-- Владелец редакции равен владельцу документа (FK по обеим веткам); редакция неизменяема (0002),
-- поэтому владелец задним числом не меняется. Одно содержимое в договоре — одна редакция, как в тендере (A14).
ALTER TABLE document_revision ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE document_revision ADD COLUMN contract_id uuid REFERENCES contract (id);
ALTER TABLE document_revision
  ADD CONSTRAINT document_revision_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  ADD CONSTRAINT document_revision_doc_tender_fk FOREIGN KEY (document_id, tender_id) REFERENCES document (id, tender_id),
  ADD CONSTRAINT document_revision_doc_contract_fk FOREIGN KEY (document_id, contract_id) REFERENCES document (id, contract_id),
  ADD CONSTRAINT document_revision_contract_blob_key UNIQUE (contract_id, blob_sha256),
  ADD CONSTRAINT document_revision_id_contract_key UNIQUE (id, contract_id);

-- ---------------------------------------------------------------- Распознавание и доказательства

-- Прогон — цель составных FK фрагментов, индекса и снимка: контрактная ветка нужна как цель.
-- Владельца прогона закрепляют CHECK и FK на неизменяемую редакцию, охранник 0007 не меняется.
ALTER TABLE recognition_run ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE recognition_run ADD COLUMN contract_id uuid REFERENCES contract (id);
ALTER TABLE recognition_run
  ADD CONSTRAINT recognition_run_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  ADD CONSTRAINT recognition_run_revision_contract_fk FOREIGN KEY (document_revision_id, contract_id) REFERENCES document_revision (id, contract_id),
  ADD CONSTRAINT recognition_run_id_contract_key UNIQUE (id, contract_id),
  ADD CONSTRAINT recognition_run_id_revision_contract_key UNIQUE (id, document_revision_id, contract_id);

ALTER TABLE evidence_fragment ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE evidence_fragment ADD COLUMN contract_id uuid REFERENCES contract (id);
ALTER TABLE evidence_fragment
  ADD CONSTRAINT evidence_fragment_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  ADD CONSTRAINT evidence_fragment_run_contract_fk FOREIGN KEY (run_id, contract_id) REFERENCES recognition_run (id, contract_id),
  ADD CONSTRAINT evidence_fragment_run_revision_contract_fk
    FOREIGN KEY (run_id, document_revision_id, contract_id) REFERENCES recognition_run (id, document_revision_id, contract_id),
  ADD CONSTRAINT evidence_fragment_unit_contract_key UNIQUE (id, source_unit_id, contract_id);

-- ---------------------------------------------------------------- Индекс поиска (AD-06a-1 §9)

-- contract_id строк индекса выводится из прогона и сверяется составным FK: клиент его не передаёт,
-- сменить владельца строки отдельно от редакции нельзя. Удаление версии индекса каскадно и для договора.
ALTER TABLE search_index_unit ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE search_index_unit ADD COLUMN contract_id uuid;
ALTER TABLE search_index_unit
  ADD CONSTRAINT search_index_unit_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  ADD CONSTRAINT search_index_unit_run_contract_fk FOREIGN KEY (source_unit_id, contract_id) REFERENCES recognition_run (id, contract_id);

ALTER TABLE search_chunk ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE search_chunk ADD COLUMN contract_id uuid;
ALTER TABLE search_chunk
  ADD CONSTRAINT search_chunk_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  ADD CONSTRAINT search_chunk_run_contract_fk
    FOREIGN KEY (source_unit_id, document_revision_id, contract_id) REFERENCES recognition_run (id, document_revision_id, contract_id),
  ADD CONSTRAINT search_chunk_scope_contract_key UNIQUE (id, index_version_id, source_unit_id, contract_id);

ALTER TABLE search_chunk_fragment ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE search_chunk_fragment ADD COLUMN contract_id uuid;
ALTER TABLE search_chunk_fragment
  ADD CONSTRAINT search_chunk_fragment_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  ADD CONSTRAINT search_chunk_fragment_chunk_contract_fk FOREIGN KEY (chunk_id, index_version_id, source_unit_id, contract_id)
    REFERENCES search_chunk (id, index_version_id, source_unit_id, contract_id) ON DELETE CASCADE,
  ADD CONSTRAINT search_chunk_fragment_fragment_contract_fk
    FOREIGN KEY (fragment_id, source_unit_id, contract_id) REFERENCES evidence_fragment (id, source_unit_id, contract_id);

ALTER TABLE search_chunk_vector ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE search_chunk_vector ADD COLUMN contract_id uuid;
ALTER TABLE search_chunk_vector
  ADD CONSTRAINT search_chunk_vector_owner_shape CHECK (num_nonnulls(tender_id, contract_id) = 1),
  ADD CONSTRAINT search_chunk_vector_chunk_contract_fk FOREIGN KEY (chunk_id, index_version_id, source_unit_id, contract_id)
    REFERENCES search_chunk (id, index_version_id, source_unit_id, contract_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------- Снимок области (AD-06a-1 §8)

-- tender_id единицы остаётся тендером снимка. Владелец единицы договора — contract_id; генерируемая
-- unit_tender_id равна tender_id у единицы тендера и NULL у единицы договора и заменяет tender_id в FK
-- на редакцию и прогон. Так единица тендера — только своего тендера, единица договора — только своего
-- договора и только связанного с тендером снимка. Хэш состава (0010) не меняется: владелец однозначно
-- выводится из редакции. Включение в снимок права чтения не даёт (D-022 OD-3).
ALTER TABLE evidence_scope_item
  ADD COLUMN contract_id    uuid REFERENCES contract (id),
  ADD COLUMN unit_tender_id uuid GENERATED ALWAYS AS (CASE WHEN contract_id IS NULL THEN tender_id END) STORED;
ALTER TABLE evidence_scope_item DROP CONSTRAINT evidence_scope_item_revision_fk, DROP CONSTRAINT evidence_scope_item_run_fk;
ALTER TABLE evidence_scope_item
  ADD CONSTRAINT evidence_scope_item_revision_fk FOREIGN KEY (document_revision_id, unit_tender_id) REFERENCES document_revision (id, tender_id),
  ADD CONSTRAINT evidence_scope_item_run_fk
    FOREIGN KEY (recognition_run_id, document_revision_id, unit_tender_id) REFERENCES recognition_run (id, document_revision_id, tender_id),
  ADD CONSTRAINT evidence_scope_item_revision_contract_fk FOREIGN KEY (document_revision_id, contract_id) REFERENCES document_revision (id, contract_id),
  ADD CONSTRAINT evidence_scope_item_run_contract_fk
    FOREIGN KEY (recognition_run_id, document_revision_id, contract_id) REFERENCES recognition_run (id, document_revision_id, contract_id),
  ADD CONSTRAINT evidence_scope_item_link_fk FOREIGN KEY (contract_id, tender_id) REFERENCES contract_tender (contract_id, tender_id);

CREATE OR REPLACE FUNCTION evidence_scope_item_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recognition_run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM recognition_run r WHERE r.id = NEW.recognition_run_id AND r.status IN ('complete', 'partial')) THEN
    RAISE EXCEPTION 'evidence_scope_item: в снимок входит только завершённый прогон распознавания' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM evidence_scope s
         JOIN source_set_item i ON i.source_set_revision_id = s.source_set_revision_id
        WHERE s.id = NEW.scope_id AND i.document_revision_id = NEW.document_revision_id
          AND i.inclusion <> 'excluded_not_applicable') THEN
    RAISE EXCEPTION 'evidence_scope_item: редакция не включена в основу снимка' USING ERRCODE = '23514';
  END IF;
  -- Единица договора входит в снимок тендера только при действующей подтверждённой связи (D-017, D-022 OD-1).
  IF NEW.contract_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM contract_tender l
        WHERE l.contract_id = NEW.contract_id AND l.tender_id = NEW.tender_id AND l.status = 'active') THEN
    RAISE EXCEPTION 'evidence_scope_item: договор не связан с тендером снимка действующей связью' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Прогон поиска: вид contract (ADR-012 §24)

-- Вид contract добавлен расширением CHECK и колонкой владельца; статусы, результаты и чтение прогона
-- не меняются. Прогон договора ищет по текущему корпусу договора: режим working без этапа и снимка.
ALTER TABLE search_run ALTER COLUMN tender_id DROP NOT NULL;
ALTER TABLE search_run ADD COLUMN contract_id uuid REFERENCES contract (id);
ALTER TABLE search_run DROP CONSTRAINT search_run_context_kind_check, DROP CONSTRAINT search_run_mode_shape;
ALTER TABLE search_run
  ADD CONSTRAINT search_run_context_kind_check CHECK (context_kind IN ('tender', 'contract')),
  ADD CONSTRAINT search_run_context_shape CHECK (
    (context_kind = 'tender' AND tender_id IS NOT NULL AND contract_id IS NULL)
    OR (context_kind = 'contract' AND contract_id IS NOT NULL AND tender_id IS NULL)),
  ADD CONSTRAINT search_run_mode_shape CHECK (
    (mode = 'working' AND evidence_scope_id IS NULL AND (stage_id IS NULL) = (context_kind = 'contract'))
    OR (mode = 'review' AND evidence_scope_id IS NOT NULL AND context_kind = 'tender'));

-- Единица области принадлежит владельцу контекста. Единица договора в тендерном прогоне допустима только
-- для договора, связанного с этим тендером: связь сама область не расширяет (единицы выбирает сервер из
-- состава этапа или снимка), но единицу несвязанного договора БД не примет.
CREATE OR REPLACE FUNCTION search_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'search_run: прогон создаётся в состоянии pending (state-machines §21)' USING ERRCODE = '55000';
  END IF;
  IF NEW.context_kind = 'tender' AND EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_source_unit_ids) AS u(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM recognition_run r
           WHERE r.id = u.id
             AND (r.tender_id = NEW.tender_id
                  OR (r.contract_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM contract_tender l WHERE l.contract_id = r.contract_id AND l.tender_id = NEW.tender_id))))) THEN
    RAISE EXCEPTION 'search_run: единица области не принадлежит тендеру прогона' USING ERRCODE = '23514';
  END IF;
  IF NEW.context_kind = 'contract' AND EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_source_unit_ids) AS u(id)
        WHERE NOT EXISTS (SELECT 1 FROM recognition_run r WHERE r.id = u.id AND r.contract_id = NEW.contract_id)) THEN
    RAISE EXCEPTION 'search_run: единица области не принадлежит договору прогона' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM search_index_version v WHERE v.id = NEW.index_version_id AND v.purged_at IS NULL) THEN
    RAISE EXCEPTION 'search_run: версия индекса удалена' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Закреплённые поля неизменны; владелец контекста сравнивается через IS DISTINCT FROM (NULL у второй ветки).
CREATE OR REPLACE FUNCTION search_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'search_run: журнал поиска не удаляется' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'search_run (frozen-after): прогон завершён, изменение запрещено' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.context_kind <> OLD.context_kind
     OR NEW.tender_id IS DISTINCT FROM OLD.tender_id OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.stage_id IS DISTINCT FROM OLD.stage_id OR NEW.mode <> OLD.mode
     OR NEW.evidence_scope_id IS DISTINCT FROM OLD.evidence_scope_id
     OR NEW.requested_by <> OLD.requested_by OR NEW.principal_kind <> OLD.principal_kind
     OR NEW.on_behalf_of_user_id IS DISTINCT FROM OLD.on_behalf_of_user_id
     OR NEW.query_text <> OLD.query_text OR NEW.query_sha256 <> OLD.query_sha256
     OR NEW.query_normalization_version <> OLD.query_normalization_version
     OR NEW.result_limit <> OLD.result_limit OR NEW.scope_hash <> OLD.scope_hash
     OR NEW.allowed_source_unit_ids <> OLD.allowed_source_unit_ids OR NEW.scope_counts <> OLD.scope_counts
     OR NEW.index_version_id <> OLD.index_version_id OR NEW.ranking_version <> OLD.ranking_version
     OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
     OR NEW.embedding_model_fingerprint IS DISTINCT FROM OLD.embedding_model_fingerprint
     OR NEW.deadline_at <> OLD.deadline_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'search_run: закреплённые поля прогона неизменны (ADR-012 §14)' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION search_run_result_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run record;
BEGIN
  SELECT status, context_kind, tender_id, contract_id, allowed_source_unit_ids INTO run FROM search_run WHERE id = NEW.run_id FOR SHARE;
  IF run.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'search_run_result: результаты принимает только нетерминальный прогон' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM evidence_fragment f
        WHERE f.id = NEW.fragment_id
          AND CASE run.context_kind
                WHEN 'tender' THEN f.tender_id = run.tender_id
                  OR (f.contract_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM contract_tender l WHERE l.contract_id = f.contract_id AND l.tender_id = run.tender_id))
                WHEN 'contract' THEN f.contract_id = run.contract_id
              END
          AND f.source_unit_id = ANY (run.allowed_source_unit_ids)
          AND f.origin = NEW.origin
          AND f.origin IN ('document_text', 'recognized_text', 'email_body', 'attachment_text', 'negotiation_speech')) THEN
    RAISE EXCEPTION 'search_run_result: фрагмент вне закреплённой области или недоказательного происхождения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Права ролей

GRANT SELECT, INSERT, UPDATE ON contract, contract_access, contract_tender TO kontur_app;
GRANT SELECT ON contract, contract_access, contract_tender TO kontur_backup;
