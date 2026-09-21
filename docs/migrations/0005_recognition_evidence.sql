-- 0005 — распознавание и доказательства (data-model §4.4, state-machines §4; ADR-007 §9,
-- ADR-008 §1). Этап 04: импорт экспортного архива RDWeb (PDF + _blocks.json + _results.md).
-- Автоматическая постановка задач в RDWeb (X-05) не реализуется и таблиц здесь не имеет.
-- fragment_index_state не заводится: до этапа 05 у неё нет ни писателя, ни читателя.

-- Составной ключ для FK «прогон и фрагмент принадлежат тендеру своей редакции»:
-- вторая линия области видимости, независимая от кода приложения.
ALTER TABLE document_revision ADD CONSTRAINT document_revision_id_tender_key UNIQUE (id, tender_id);

-- ---------------------------------------------------------------- Прогон распознавания

CREATE TABLE recognition_run (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_revision_id   uuid NOT NULL REFERENCES document_revision (id),
  tender_id              uuid NOT NULL REFERENCES tender (id),
  engine                 text NOT NULL CHECK (engine IN ('rdweb_export', 'rdweb_api', 'text_layer', 'local_ocr')),
  engine_schema_version  text CHECK (length(engine_schema_version) <= 40),
  -- Архив-источник: ровно тот файл, из которого получены страницы и фрагменты (доказуемость).
  source_artifact_sha256 text NOT NULL REFERENCES blob (sha256),
  source_artifact_name   text CHECK (length(source_artifact_name) <= 255),
  status                 text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'complete', 'partial', 'failed')),
  pages_total            int CHECK (pages_total >= 0),
  pages_recognized       int NOT NULL DEFAULT 0 CHECK (pages_recognized >= 0),
  -- Счётчики и предупреждения разбора: чем именно подтверждается полнота (I18).
  quality                jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code           text CHECK (length(failure_code) <= 60),
  failure_detail         text CHECK (length(failure_detail) <= 2000),
  supersedes_run_id      uuid REFERENCES recognition_run (id),
  created_by             uuid REFERENCES app_user (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  started_at             timestamptz,
  finished_at            timestamptz,
  row_version            bigint NOT NULL DEFAULT 1,
  CONSTRAINT recognition_run_id_tender_key UNIQUE (id, tender_id),
  CONSTRAINT recognition_run_revision_tender_fk
    FOREIGN KEY (document_revision_id, tender_id) REFERENCES document_revision (id, tender_id),
  CONSTRAINT recognition_run_finished_shape CHECK ((status IN ('complete', 'partial', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT recognition_run_failure_shape CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT recognition_run_pages_shape CHECK (pages_total IS NULL OR pages_recognized <= pages_total),
  -- «Полностью распознано» нельзя записать, не имея всех страниц (I18).
  CONSTRAINT recognition_run_complete_shape CHECK (
    status <> 'complete' OR (pages_total IS NOT NULL AND pages_total > 0 AND pages_recognized = pages_total)),
  CONSTRAINT recognition_run_partial_shape CHECK (
    status <> 'partial' OR (pages_total IS NOT NULL AND pages_recognized < pages_total)),
  CONSTRAINT recognition_run_self_supersede CHECK (id <> supersedes_run_id)
);

-- Одна пара «редакция + архив» — один прогон. После failed тот же архив можно импортировать
-- заново (сбой мог быть техническим); успешный и активный повторно не создаются.
CREATE UNIQUE INDEX recognition_run_artifact_key
  ON recognition_run (document_revision_id, source_artifact_sha256) WHERE status <> 'failed';
CREATE INDEX recognition_run_revision_idx ON recognition_run (document_revision_id, created_at DESC);
CREATE INDEX recognition_run_tender_idx ON recognition_run (tender_id);

-- Предшественник — завершённый прогон той же редакции (A10): новая версия OCR не подменяет
-- прежние фрагменты, а встаёт за ними цепочкой. Прогон всегда начинается в queued.
CREATE FUNCTION recognition_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'recognition_run: прогон создаётся в состоянии queued' USING ERRCODE = '55000';
  END IF;
  IF NEW.supersedes_run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM recognition_run p
        WHERE p.id = NEW.supersedes_run_id
          AND p.document_revision_id = NEW.document_revision_id
          AND p.status IN ('complete', 'partial')
     ) THEN
    RAISE EXCEPTION 'recognition_run: предшественник — завершённый прогон той же редакции' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER recognition_run_insert_guard BEFORE INSERT ON recognition_run
  FOR EACH ROW EXECUTE FUNCTION recognition_run_insert_guard();

-- frozen-after: после терминального статуса строка неизменна. До него меняются только
-- ход выполнения и итоги; поля идентичности и доказательства неизменяемы всегда.
CREATE FUNCTION recognition_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recognition_run: удаление запрещено (I15)' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('complete', 'partial', 'failed') THEN
    RAISE EXCEPTION 'recognition_run (frozen-after): прогон завершён, изменение запрещено' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.document_revision_id <> OLD.document_revision_id
     OR NEW.tender_id <> OLD.tender_id
     OR NEW.engine <> OLD.engine
     OR NEW.source_artifact_sha256 <> OLD.source_artifact_sha256
     OR NEW.source_artifact_name IS DISTINCT FROM OLD.source_artifact_name
     OR NEW.supersedes_run_id IS DISTINCT FROM OLD.supersedes_run_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'recognition_run: поля идентичности и источника неизменяемы' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'queued' AND NEW.status IN ('queued', 'running', 'failed'))
       OR (OLD.status = 'running' AND NEW.status IN ('running', 'complete', 'partial', 'failed'))) THEN
    RAISE EXCEPTION 'recognition_run: недопустимый переход % → % (state-machines §4)', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'recognition_run: row_version увеличивается на 1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER recognition_run_guard BEFORE UPDATE OR DELETE ON recognition_run
  FOR EACH ROW EXECUTE FUNCTION recognition_run_guard();
CREATE TRIGGER recognition_run_no_truncate BEFORE TRUNCATE ON recognition_run
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- ---------------------------------------------------------------- Страницы прогона

CREATE TABLE recognition_page (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES recognition_run (id),
  page_index  int NOT NULL CHECK (page_index >= 0),
  -- Номер страницы файла из экспорта. Номер листа в штампе — отдельное поле (discovery §7.1).
  page_label  text CHECK (length(page_label) <= 60),
  sheet_label text CHECK (length(sheet_label) <= 120),
  width_px    int CHECK (width_px > 0),
  height_px   int CHECK (height_px > 0),
  rotation    int NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),
  status      text NOT NULL CHECK (status IN ('recognized', 'missing', 'failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recognition_page_key UNIQUE (run_id, page_index),
  CONSTRAINT recognition_page_size_shape CHECK (status <> 'recognized' OR (width_px IS NOT NULL AND height_px IS NOT NULL))
);
CREATE TRIGGER recognition_page_immutable BEFORE UPDATE OR DELETE ON recognition_page
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER recognition_page_no_truncate BEFORE TRUNCATE ON recognition_page
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Фрагменты-доказательства

CREATE TABLE evidence_fragment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id            uuid NOT NULL REFERENCES tender (id),
  -- Единица источника — основа фильтра области поиска (ADR-008 §1).
  source_unit_type     text NOT NULL CHECK (source_unit_type IN ('recognition_run', 'communication', 'transcript_revision')),
  source_unit_id       uuid NOT NULL,
  run_id               uuid REFERENCES recognition_run (id),
  document_revision_id uuid REFERENCES document_revision (id),
  -- I06: проектный текст, распознанный текст и описание модели не смешиваются.
  origin               text NOT NULL CHECK (origin IN ('document_text', 'recognized_text', 'model_description',
                                                       'negotiation_speech', 'negotiation_hint', 'email_body', 'attachment_text')),
  fragment_kind        text NOT NULL CHECK (fragment_kind IN ('text_block', 'image_block', 'stamp_block', 'unknown_block',
                                                              'summary', 'description', 'entities', 'verification', 'unknown_section')),
  -- Ключ идемпотентности разбора: строится парсером детерминированно. Нужен потому, что
  -- у части фрагментов (штампы из _results.md) внешнего block_id нет.
  fragment_key         text NOT NULL CHECK (length(fragment_key) BETWEEN 1 AND 300),
  external_block_id    text CHECK (length(external_block_id) <= 200),
  ordinal              int,
  page_index           int CHECK (page_index >= 0),
  bbox_norm            numeric[] CHECK (bbox_norm IS NULL OR array_length(bbox_norm, 1) = 4),
  -- В каком пространстве заданы координаты. Экспорт RDWeb даёт растровое (уже повёрнутое)
  -- пространство; PDF-парсера в портале нет, поэтому пространство фиксируется явно,
  -- а не «нормализуется» по догадке (I18).
  bbox_space           text CHECK (bbox_space IN ('page_unrotated', 'page_rotated')),
  shape_type           text CHECK (shape_type IN ('rectangle', 'polygon')),
  polygon_norm         numeric[] CHECK (polygon_norm IS NULL OR (array_length(polygon_norm, 1) >= 6 AND array_length(polygon_norm, 1) % 2 = 0)),
  rotation             int CHECK (rotation IN (0, 90, 180, 270)),
  text                 text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000000),
  text_sha256          text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  derived_model_ref    text CHECK (length(derived_model_ref) <= 200),
  -- Справочная ссылка экспорта. Портал её никогда не загружает (A38, SSRF): хранится как текст.
  external_crop_url    text CHECK (length(external_crop_url) <= 2000),
  warnings             jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_fragment_key UNIQUE (run_id, fragment_key),
  CONSTRAINT evidence_fragment_run_tender_fk
    FOREIGN KEY (run_id, tender_id) REFERENCES recognition_run (id, tender_id),
  CONSTRAINT evidence_fragment_unit_shape CHECK ((source_unit_type = 'recognition_run') = (run_id IS NOT NULL)),
  CONSTRAINT evidence_fragment_unit_id_shape CHECK (run_id IS NULL OR source_unit_id = run_id),
  CONSTRAINT evidence_fragment_bbox_shape CHECK (bbox_norm IS NULL OR bbox_space IS NOT NULL),
  CONSTRAINT evidence_fragment_polygon_shape CHECK (polygon_norm IS NULL OR shape_type = 'polygon'),
  -- Производное описание обязано называть свой источник: иначе его не отличить от текста (I06).
  CONSTRAINT evidence_fragment_derived_shape CHECK (origin <> 'model_description' OR derived_model_ref IS NOT NULL)
);
CREATE INDEX evidence_fragment_unit_idx ON evidence_fragment (source_unit_type, source_unit_id);
CREATE INDEX evidence_fragment_page_idx ON evidence_fragment (run_id, page_index, ordinal, id);
CREATE INDEX evidence_fragment_revision_idx ON evidence_fragment (document_revision_id);
CREATE TRIGGER evidence_fragment_immutable BEFORE UPDATE OR DELETE ON evidence_fragment
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER evidence_fragment_no_truncate BEFORE TRUNCATE ON evidence_fragment
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Заморозка набора источников

-- state-machines §5: заморозить состав можно, только если у каждой включённой редакции есть
-- завершённое (complete) или явно неполное (partial) распознавание. queued/running/failed
-- и отсутствие прогона заморозку не дают: иначе проверка получила бы вход без доказательств.
CREATE FUNCTION source_set_freeze_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  blocking int;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'frozen' THEN
    IF NEW.frozen_by IS NULL THEN
      RAISE EXCEPTION 'source_set_revision: заморозка требует автора' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO blocking
      FROM source_set_item i
     WHERE i.source_set_revision_id = NEW.id
       AND i.inclusion <> 'excluded_not_applicable'
       AND NOT EXISTS (
             SELECT 1 FROM recognition_run r
              WHERE r.document_revision_id = i.document_revision_id
                AND r.status IN ('complete', 'partial'));
    IF blocking > 0 THEN
      RAISE EXCEPTION 'source_set_revision: у % включённых редакций нет завершённого или частичного распознавания', blocking
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_set_freeze_guard BEFORE UPDATE ON source_set_revision
  FOR EACH ROW EXECUTE FUNCTION source_set_freeze_guard();

-- ---------------------------------------------------------------- Права роли приложения

-- recognition_run — frozen-after: приложению нужен UPDATE до терминального статуса.
GRANT SELECT, INSERT, UPDATE ON recognition_run TO kontur_app;
-- immutable: ни UPDATE, ни DELETE (первая линия — отсутствие права, вторая — триггер).
GRANT SELECT, INSERT ON recognition_page, evidence_fragment TO kontur_app;
GRANT SELECT ON recognition_run, recognition_page, evidence_fragment TO kontur_backup;
