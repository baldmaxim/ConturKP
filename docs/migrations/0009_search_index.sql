-- 0009 — собственный индекс поиска портала и снимок области доказательств (этап 05).
-- ADR-012 (индекс, эмбеддинги, прогон поиска), ADR-008 (область), ADR-002 §1 (версия и локаль),
-- data-model §4.3 (evidence_scope), §4.13 (индекс и поиск), state-machines §5.1, §20, §21; D-021.

-- ---------------------------------------------------------------- Предусловия среды

-- Вторая линия к db:setup: миграция не применяется на среде, где поиск сломался бы тихо.
DO $$
DECLARE
  provider "char";
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'PostgreSQL ниже 17: провайдер локали builtin недоступен (ADR-002 §1)' USING ERRCODE = '0A000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'нет расширения vector: базу готовит db:setup суперпользователем (ADR-002, ADR-012 §18)' USING ERRCODE = '0A000';
  END IF;
  IF (SELECT string_to_array(extversion, '.')::int[] FROM pg_extension WHERE extname = 'vector') < ARRAY[0, 8] THEN
    RAISE EXCEPTION 'расширение vector ниже 0.8 (ADR-002)' USING ERRCODE = '0A000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'нет расширения pg_trgm: базу готовит db:setup суперпользователем (ADR-002)' USING ERRCODE = '0A000';
  END IF;
  -- Гейт локали (ADR-002 §1): при libc-локали C регистр кириллицы не приводится.
  IF to_tsvector('russian', 'Договор') <> to_tsvector('russian', 'договор') OR lower('ДОГОВОР') <> 'договор' THEN
    SELECT datlocprovider INTO provider FROM pg_database WHERE datname = current_database();
    RAISE EXCEPTION 'локаль базы (провайдер %) не приводит регистр кириллицы: пересоздайте базу командой db:setup (ADR-002 §1)', provider
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

-- Подготовка текста к разбору (ADR-002 §1, находка этапа 05): парсер to_tsvector классифицирует
-- символы по LC_CTYPE базы, а не по провайдеру builtin. При LC_CTYPE = C он считает любой
-- не-ASCII символ буквой, и «Стромынка», 245 000 000 (неразрывный пробел), №15, тире склеиваются
-- с соседними словами: «Стромынка» не находит Стромынку. Знаки вне ASCII, не являющиеся буквой или
-- цифрой, заменяются пробелом; классы символов регулярного выражения при builtin — юникодные.
CREATE FUNCTION search_prepare(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN regexp_replace($1, '[^\x01-\x7f[:alnum:]]', ' ', 'g');

-- Термин запроса: основа от 5 символов ищется по префиксу — русский стеммер даёт разные основы
-- глаголу и существительному («приостановил» → приостанов, «приостановке» → приостановк).
CREATE FUNCTION search_term(text) RETURNS tsquery
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN (CASE WHEN length($1) >= 5 THEN quote_literal($1) || ':*' ELSE quote_literal($1) END)::tsquery;

DO $$
BEGIN
  IF NOT (to_tsvector('russian', search_prepare('ООО «Стромынка» — 245' || chr(160) || '000')) @@ 'стромынк'::tsquery) THEN
    RAISE EXCEPTION 'подготовка текста к поиску не отделяет кавычки и знаки от слов (ADR-002 §1)' USING ERRCODE = '0A000';
  END IF;
END;
$$;

-- Составные ключи для внешних ключей индекса: фрагмент чужой единицы или чужого тендера
-- непредставим в связях чанка (ADR-012 §3). Столбцы уже существуют, добавляется только уникальность.
ALTER TABLE evidence_fragment ADD CONSTRAINT evidence_fragment_unit_tender_key UNIQUE (id, source_unit_id, tender_id);
ALTER TABLE tender_stage ADD CONSTRAINT tender_stage_id_tender_key UNIQUE (id, tender_id);

-- ---------------------------------------------------------------- Снимок области доказательств

-- state-machines §5.1 (R01-01): неизменяемый состав единиц источника, на котором работают
-- исторический поиск, проверка и выпуск. Одинаковый состав этапа — та же строка.
CREATE TABLE evidence_scope (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id               uuid NOT NULL,
  tender_id              uuid NOT NULL REFERENCES tender (id),
  source_set_revision_id uuid NOT NULL REFERENCES source_set_revision (id),
  -- Для аудита: актуальность подтверждается составом, а не этим номером (state-machines §1.1).
  input_version          bigint NOT NULL CHECK (input_version >= 0),
  content_hash           text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by             uuid NOT NULL REFERENCES app_user (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_scope_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT evidence_scope_stage_hash_key UNIQUE (stage_id, content_hash),
  CONSTRAINT evidence_scope_id_tender_key UNIQUE (id, tender_id)
);

-- Основа снимка — замороженная ревизия набора источников этого же этапа.
CREATE FUNCTION evidence_scope_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM source_set_revision r JOIN source_set s ON s.id = r.source_set_id
        WHERE r.id = NEW.source_set_revision_id AND s.stage_id = NEW.stage_id AND r.status = 'frozen') THEN
    RAISE EXCEPTION 'evidence_scope: основа — замороженная ревизия набора источников того же этапа' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_scope_insert_guard BEFORE INSERT ON evidence_scope
  FOR EACH ROW EXECUTE FUNCTION evidence_scope_insert_guard();
CREATE TRIGGER evidence_scope_immutable BEFORE UPDATE OR DELETE ON evidence_scope
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER evidence_scope_no_truncate BEFORE TRUNCATE ON evidence_scope
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- Единицы снимка. На этапе 05 — только редакции документов с выбранным прогоном;
-- письма и редакции транскрипций добавляет этап 07 расширением CHECK.
CREATE TABLE evidence_scope_item (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id             uuid NOT NULL,
  tender_id            uuid NOT NULL,
  unit_type            text NOT NULL CHECK (unit_type IN ('document_recognition')),
  document_revision_id uuid NOT NULL,
  -- NULL явно означает «только оригинал без распознавания» (data-model §4.3).
  recognition_run_id   uuid,
  inclusion_reason     text NOT NULL CHECK (length(inclusion_reason) BETWEEN 1 AND 200),
  CONSTRAINT evidence_scope_item_scope_fk FOREIGN KEY (scope_id, tender_id) REFERENCES evidence_scope (id, tender_id),
  CONSTRAINT evidence_scope_item_revision_fk FOREIGN KEY (document_revision_id, tender_id) REFERENCES document_revision (id, tender_id),
  CONSTRAINT evidence_scope_item_run_fk
    FOREIGN KEY (recognition_run_id, document_revision_id, tender_id) REFERENCES recognition_run (id, document_revision_id, tender_id),
  CONSTRAINT evidence_scope_item_revision_key UNIQUE (scope_id, document_revision_id),
  CONSTRAINT evidence_scope_item_run_key UNIQUE (scope_id, recognition_run_id)
);
CREATE INDEX evidence_scope_item_run_idx ON evidence_scope_item (recognition_run_id);

-- Прогон снимка — завершённый (complete/partial), редакция — включена в основу снимка.
CREATE FUNCTION evidence_scope_item_insert_guard() RETURNS trigger
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_scope_item_insert_guard BEFORE INSERT ON evidence_scope_item
  FOR EACH ROW EXECUTE FUNCTION evidence_scope_item_insert_guard();
CREATE TRIGGER evidence_scope_item_immutable BEFORE UPDATE OR DELETE ON evidence_scope_item
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER evidence_scope_item_no_truncate BEFORE TRUNCATE ON evidence_scope_item
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Версия индекса (ADR-012 §5, state-machines §20)

CREATE TABLE search_index_version (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                         int NOT NULL CHECK (seq > 0),
  status                      text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'active', 'retired', 'failed')),
  chunker_version             text NOT NULL CHECK (length(chunker_version) BETWEEN 1 AND 40),
  fts_config                  text NOT NULL DEFAULT 'russian' CHECK (fts_config = 'russian'),
  -- Модель эмбеддингов: все четыре поля заданы или все NULL (версия без векторов).
  embedding_input_version     text CHECK (length(embedding_input_version) <= 40),
  embedding_model             text CHECK (length(embedding_model) <= 200),
  embedding_model_fingerprint text CHECK (embedding_model_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Предел 4000: при STORAGE PLAIN строка вектора обязана помещаться в страницу 8 КБ (ADR-012 §6).
  embedding_dim               int CHECK (embedding_dim BETWEEN 1 AND 4000),
  -- Пробный вектор фиксированной строки: ловит подмену весов под тем же именем (ADR-012 §25).
  probe_vector                halfvec,
  created_by                  uuid REFERENCES app_user (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  activated_at                timestamptz,
  retired_at                  timestamptz,
  purged_at                   timestamptz,
  failure_code                text CHECK (length(failure_code) <= 60),
  failure_detail              text CHECK (length(failure_detail) <= 2000),
  row_version                 bigint NOT NULL DEFAULT 1,
  CONSTRAINT search_index_version_seq_key UNIQUE (seq),
  CONSTRAINT search_index_version_id_dim_key UNIQUE (id, embedding_dim),
  CONSTRAINT search_index_version_model_shape CHECK (
    (embedding_model IS NULL) = (embedding_model_fingerprint IS NULL)
    AND (embedding_model IS NULL) = (embedding_dim IS NULL)
    AND (embedding_model IS NULL) = (embedding_input_version IS NULL)),
  CONSTRAINT search_index_version_probe_shape CHECK (
    probe_vector IS NULL OR (embedding_dim IS NOT NULL AND vector_dims(probe_vector) = embedding_dim)),
  CONSTRAINT search_index_version_active_shape CHECK ((status IN ('active', 'retired')) = (activated_at IS NOT NULL)),
  CONSTRAINT search_index_version_retired_shape CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT search_index_version_purged_shape CHECK (purged_at IS NULL OR status = 'retired'),
  CONSTRAINT search_index_version_failure_shape CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
ALTER TABLE search_index_version ALTER COLUMN probe_vector SET STORAGE PLAIN;
-- Не более одной активной и одной строящейся версии.
CREATE UNIQUE INDEX search_index_version_active_key ON search_index_version ((true)) WHERE status = 'active';
CREATE UNIQUE INDEX search_index_version_building_key ON search_index_version ((true)) WHERE status = 'building';

-- Параметры версии неизменны: смена модели, нарезки или входа модели — только новая версия.
-- Переходы: building → active | failed; active → retired; у retired однажды ставится purged_at.
CREATE FUNCTION search_index_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'search_index_version: версия не удаляется, на неё ссылаются прогоны поиска' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.seq <> OLD.seq
     OR NEW.chunker_version <> OLD.chunker_version OR NEW.fts_config <> OLD.fts_config
     OR NEW.embedding_input_version IS DISTINCT FROM OLD.embedding_input_version
     OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
     OR NEW.embedding_model_fingerprint IS DISTINCT FROM OLD.embedding_model_fingerprint
     OR NEW.embedding_dim IS DISTINCT FROM OLD.embedding_dim
     OR NEW.probe_vector IS DISTINCT FROM OLD.probe_vector
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'search_index_version: параметры версии неизменны (ADR-012 §5)' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'building' AND NEW.status IN ('building', 'active', 'failed'))
       OR (OLD.status = 'active' AND NEW.status IN ('active', 'retired'))
       OR (OLD.status = 'retired' AND NEW.status = 'retired' AND OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'search_index_version: недопустимый переход % → % (state-machines §20)', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'search_index_version: row_version увеличивается на 1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER search_index_version_guard BEFORE UPDATE OR DELETE ON search_index_version
  FOR EACH ROW EXECUTE FUNCTION search_index_version_guard();
CREATE TRIGGER search_index_version_no_truncate BEFORE TRUNCATE ON search_index_version
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('mutable');

-- ---------------------------------------------------------------- Чанки, связи, векторы (derived)

-- Чанк — страница прогона (часть длинной страницы); фрагменты без страницы — отдельный чанк.
-- Производные данные: удаляются и пересобираются, доказательства от этого не меняются (I15).
CREATE TABLE search_chunk (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  index_version_id     uuid NOT NULL REFERENCES search_index_version (id),
  tender_id            uuid NOT NULL,
  source_unit_type     text NOT NULL CHECK (source_unit_type IN ('recognition_run')),
  source_unit_id       uuid NOT NULL,
  document_revision_id uuid NOT NULL,
  page_index           int CHECK (page_index >= 0),
  part_no              int NOT NULL CHECK (part_no >= 0),
  chunk_key            text NOT NULL CHECK (length(chunk_key) BETWEEN 1 AND 200),
  -- Шапка листа (шифр, лист, наименование, отметки) повторяется в каждой части страницы.
  header_text          text NOT NULL DEFAULT '',
  body_text            text NOT NULL,
  text_sha256          text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  -- Шапка весит больше тела при полнотекстовом ранжировании (ADR-012 §1).
  fts                  tsvector GENERATED ALWAYS AS (
                         setweight(to_tsvector('russian'::regconfig, search_prepare(header_text)), 'A')
                         || setweight(to_tsvector('russian'::regconfig, search_prepare(body_text)), 'B')) STORED,
  -- Нормализованный текст для точного поиска обозначений: нижний регистр, ё → е и латинские
  -- двойники кириллицы → кириллица («B30» и «В30», «KЖ» и «КЖ» совпадают). Та же свёртка
  -- применяется к запросу (packages/core/src/search.ts, EXACT_FOLD_FROM/TO).
  search_text          text GENERATED ALWAYS AS (
                         translate(lower(header_text || E'\n' || body_text), 'ёabcehkmoptxy', 'еавсенкмортху')) STORED,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_chunk_key UNIQUE (index_version_id, chunk_key),
  CONSTRAINT search_chunk_unit_fk
    FOREIGN KEY (source_unit_id, document_revision_id, tender_id) REFERENCES recognition_run (id, document_revision_id, tender_id),
  CONSTRAINT search_chunk_scope_key UNIQUE (id, index_version_id, source_unit_id, tender_id)
);
CREATE INDEX search_chunk_unit_idx ON search_chunk (index_version_id, source_unit_id);
CREATE INDEX search_chunk_fts_idx ON search_chunk USING gin (fts);
CREATE INDEX search_chunk_trgm_idx ON search_chunk USING gin (search_text gin_trgm_ops);

-- Упорядоченная связь чанка с фрагментами и смещения фрагмента в тексте чанка (ADR-012 §2).
-- Составные ключи: фрагмент обязан принадлежать той же единице и тому же тендеру, что и чанк.
CREATE TABLE search_chunk_fragment (
  chunk_id         uuid NOT NULL,
  index_version_id uuid NOT NULL,
  source_unit_id   uuid NOT NULL,
  tender_id        uuid NOT NULL,
  fragment_id      uuid NOT NULL,
  ordinal          int NOT NULL CHECK (ordinal >= 0),
  role             text NOT NULL CHECK (role IN ('header', 'body')),
  char_start       int NOT NULL CHECK (char_start >= 0),
  char_end         int NOT NULL,
  PRIMARY KEY (chunk_id, ordinal),
  CONSTRAINT search_chunk_fragment_offsets CHECK (char_end >= char_start),
  CONSTRAINT search_chunk_fragment_chunk_fk
    FOREIGN KEY (chunk_id, index_version_id, source_unit_id, tender_id)
    REFERENCES search_chunk (id, index_version_id, source_unit_id, tender_id) ON DELETE CASCADE,
  CONSTRAINT search_chunk_fragment_fragment_fk
    FOREIGN KEY (fragment_id, source_unit_id, tender_id) REFERENCES evidence_fragment (id, source_unit_id, tender_id),
  CONSTRAINT search_chunk_fragment_fragment_key UNIQUE (chunk_id, fragment_id)
);
CREATE INDEX search_chunk_fragment_fragment_idx ON search_chunk_fragment (fragment_id);

-- I06 второй линией: в индекс попадает только доказательное происхождение (ADR-012 §21–22).
-- Описание модели и подсказка переговоров не могут стать результатом поиска.
CREATE FUNCTION search_chunk_fragment_origin_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM evidence_fragment f
        WHERE f.id = NEW.fragment_id AND f.origin IN ('document_text', 'recognized_text', 'email_body', 'attachment_text', 'negotiation_speech')) THEN
    RAISE EXCEPTION 'search_chunk_fragment: фрагмент недоказательного происхождения не индексируется (I06, ADR-012 §22)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER search_chunk_fragment_origin_guard BEFORE INSERT OR UPDATE ON search_chunk_fragment
  FOR EACH ROW EXECUTE FUNCTION search_chunk_fragment_origin_guard();

-- Векторы чанков: узкая таблица, чтобы точный перебор не читал тексты (ADR-012 §6).
-- Единица и тендер повторены здесь, поэтому фильтр области стоит в WHERE самой векторной ветки.
-- Размерность не зашита в тип колонки: она хранится явно и сверяется с версией индекса.
CREATE TABLE search_chunk_vector (
  chunk_id         uuid PRIMARY KEY,
  index_version_id uuid NOT NULL,
  source_unit_id   uuid NOT NULL,
  tender_id        uuid NOT NULL,
  dim              int NOT NULL CHECK (dim BETWEEN 1 AND 4000),
  embedding        halfvec NOT NULL,
  CONSTRAINT search_chunk_vector_chunk_fk
    FOREIGN KEY (chunk_id, index_version_id, source_unit_id, tender_id)
    REFERENCES search_chunk (id, index_version_id, source_unit_id, tender_id) ON DELETE CASCADE,
  CONSTRAINT search_chunk_vector_dim_fk FOREIGN KEY (index_version_id, dim) REFERENCES search_index_version (id, embedding_dim),
  CONSTRAINT search_chunk_vector_dim_shape CHECK (vector_dims(embedding) = dim)
);
-- В странице, а не в TOAST: иначе точный перебор выродился бы в случайный ввод-вывод (ADR-012 §6).
ALTER TABLE search_chunk_vector ALTER COLUMN embedding SET STORAGE PLAIN;
CREATE INDEX search_chunk_vector_scope_idx ON search_chunk_vector (index_version_id, source_unit_id);
-- ANN-индекс (hnsw, ivfflat) НЕ создаётся намеренно (ADR-012 §7, D-015): с ним планировщик
-- превращает ORDER BY … LIMIT в обход индекса и применяет WHERE к тому, что вернул обход, —
-- то есть после отбора. Это постфильтрация top-k, запрещённая ADR-008 §5 (A42). Точный перебор
-- по уже отфильтрованной области даёт требуемую семантику; тест плана запроса падает при появлении
-- индексного обхода. Возврат к вопросу — только по замерам и отдельным ADR (ADR-012 §8).
COMMENT ON TABLE search_chunk_vector IS
  'ANN-индекс не создаётся намеренно: фильтр области обязан стоять до ORDER BY … LIMIT (ADR-012 §7, ADR-008 §5, A42)';

-- Кеш эмбеддингов (ADR-012 §9, AR05-03): ключ — текст после шаблона входа, назначение, модель,
-- отпечаток, версия шаблона и размерность. Ключ по одному тексту вернул бы вектор другой модели.
CREATE TABLE embedding_cache (
  text_sha256                 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  purpose                     text NOT NULL CHECK (purpose IN ('index', 'query')),
  embedding_model             text NOT NULL CHECK (length(embedding_model) <= 200),
  embedding_model_fingerprint text NOT NULL CHECK (embedding_model_fingerprint ~ '^[0-9a-f]{64}$'),
  embedding_input_version     text NOT NULL CHECK (length(embedding_input_version) <= 40),
  dim                         int NOT NULL CHECK (dim BETWEEN 1 AND 4000),
  embedding                   halfvec NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  last_used_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (text_sha256, purpose, embedding_model, embedding_model_fingerprint, embedding_input_version, dim),
  CONSTRAINT embedding_cache_dim_shape CHECK (vector_dims(embedding) = dim)
);
ALTER TABLE embedding_cache ALTER COLUMN embedding SET STORAGE PLAIN;

-- Состояние индексации фрагментов по версии (полнотекстовая система): indexed — вошёл в чанк,
-- skipped — не индексируется с причиной (например, недоказательное происхождение).
CREATE TABLE fragment_index_state (
  index_version_id uuid NOT NULL REFERENCES search_index_version (id),
  index_system     text NOT NULL CHECK (index_system IN ('portal_fts', 'portal_vector')),
  fragment_id      uuid NOT NULL REFERENCES evidence_fragment (id),
  run_id           uuid NOT NULL,
  status           text NOT NULL CHECK (status IN ('indexed', 'skipped', 'failed')),
  skip_reason      text CHECK (skip_reason IN ('origin_not_evidence', 'empty_text')),
  indexed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_version_id, index_system, fragment_id),
  CONSTRAINT fragment_index_state_skip_shape CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
);
CREATE INDEX fragment_index_state_run_idx ON fragment_index_state (index_version_id, run_id);

-- Отметка «единица источника проиндексирована версией целиком»: основа проверки полноты при
-- активации и охвата в результате поиска. Единица индексируется одной транзакцией.
CREATE TABLE search_index_unit (
  index_version_id   uuid NOT NULL REFERENCES search_index_version (id),
  source_unit_type   text NOT NULL CHECK (source_unit_type IN ('recognition_run')),
  source_unit_id     uuid NOT NULL,
  tender_id          uuid NOT NULL,
  chunks             int NOT NULL CHECK (chunks >= 0),
  fragments_indexed  int NOT NULL CHECK (fragments_indexed >= 0),
  fragments_skipped  int NOT NULL CHECK (fragments_skipped >= 0),
  indexed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_version_id, source_unit_id),
  CONSTRAINT search_index_unit_run_fk FOREIGN KEY (source_unit_id, tender_id) REFERENCES recognition_run (id, tender_id)
);

-- ---------------------------------------------------------------- Прогон поиска (ADR-012 §14, state-machines §21)

CREATE TABLE search_run (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Контекст — расширяемое объединение (ADR-012 §24): вид contract добавляет этап 06a.
  context_kind                text NOT NULL CHECK (context_kind IN ('tender')),
  tender_id                   uuid NOT NULL REFERENCES tender (id),
  stage_id                    uuid,
  -- working — текущий состав этапа; review — сохранённый снимок области. release и comparison —
  -- с выпусками (этапы 13 и 15).
  mode                        text NOT NULL CHECK (mode IN ('working', 'review')),
  evidence_scope_id           uuid,
  requested_by                uuid NOT NULL REFERENCES app_user (id),
  principal_kind              text NOT NULL DEFAULT 'human' CHECK (principal_kind IN ('human', 'model_via_mcp')),
  on_behalf_of_user_id        uuid REFERENCES app_user (id),
  query_text                  text NOT NULL CHECK (length(query_text) BETWEEN 1 AND 1000),
  query_sha256                text NOT NULL CHECK (query_sha256 ~ '^[0-9a-f]{64}$'),
  query_normalization_version text NOT NULL CHECK (length(query_normalization_version) <= 20),
  result_limit                int NOT NULL CHECK (result_limit BETWEEN 1 AND 50),
  scope_hash                  text NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  -- Эффективный набор единиц после фильтра прав: смысловая ветка не пересчитывает область.
  allowed_source_unit_ids     uuid[] NOT NULL,
  scope_counts                jsonb NOT NULL DEFAULT '{}'::jsonb,
  index_version_id            uuid NOT NULL REFERENCES search_index_version (id),
  ranking_version             text NOT NULL CHECK (length(ranking_version) <= 20),
  embedding_model             text,
  embedding_model_fingerprint text,
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'degraded', 'failed')),
  semantic_status             text NOT NULL CHECK (semantic_status IN ('queued', 'running', 'complete', 'unavailable', 'failed', 'timeout', 'cancelled')),
  semantic_reason             text CHECK (length(semantic_reason) <= 60),
  job_id                      uuid REFERENCES job (id),
  deadline_at                 timestamptz NOT NULL,
  timings                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code                text CHECK (length(failure_code) <= 60),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  finished_at                 timestamptz,
  CONSTRAINT search_run_stage_fk FOREIGN KEY (stage_id, tender_id) REFERENCES tender_stage (id, tender_id),
  CONSTRAINT search_run_scope_fk FOREIGN KEY (evidence_scope_id, tender_id) REFERENCES evidence_scope (id, tender_id),
  CONSTRAINT search_run_mode_shape CHECK (
    (mode = 'working' AND stage_id IS NOT NULL AND evidence_scope_id IS NULL)
    OR (mode = 'review' AND evidence_scope_id IS NOT NULL)),
  CONSTRAINT search_run_pending_shape CHECK (status <> 'pending' OR semantic_status IN ('queued', 'running')),
  CONSTRAINT search_run_finished_shape CHECK ((status = 'pending') = (finished_at IS NULL)),
  CONSTRAINT search_run_failure_shape CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX search_run_pending_idx ON search_run (deadline_at) WHERE status = 'pending';
CREATE INDEX search_run_version_pending_idx ON search_run (index_version_id) WHERE status = 'pending';
CREATE INDEX search_run_author_idx ON search_run (requested_by, created_at DESC);

-- Прогон создаётся нетерминальным (G05-02): даже синхронный результат проходит через pending,
-- потому что результаты принимает только нетерминальный прогон. Все единицы области — прогоны
-- распознавания этого тендера: чужая единица непредставима и в самом прогоне.
CREATE FUNCTION search_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'search_run: прогон создаётся в состоянии pending (state-machines §21)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_source_unit_ids) AS u(id)
        WHERE NOT EXISTS (SELECT 1 FROM recognition_run r WHERE r.id = u.id AND r.tender_id = NEW.tender_id)) THEN
    RAISE EXCEPTION 'search_run: единица области не принадлежит тендеру прогона' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM search_index_version v WHERE v.id = NEW.index_version_id AND v.purged_at IS NULL) THEN
    RAISE EXCEPTION 'search_run: версия индекса удалена' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER search_run_insert_guard BEFORE INSERT ON search_run
  FOR EACH ROW EXECUTE FUNCTION search_run_insert_guard();

-- frozen-after: закреплённые поля не меняются никогда, терминальный прогон — целиком.
CREATE FUNCTION search_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'search_run: журнал поиска не удаляется' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'search_run (frozen-after): прогон завершён, изменение запрещено' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.context_kind <> OLD.context_kind OR NEW.tender_id <> OLD.tender_id
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
CREATE TRIGGER search_run_guard BEFORE UPDATE OR DELETE ON search_run
  FOR EACH ROW EXECUTE FUNCTION search_run_guard();
CREATE TRIGGER search_run_no_truncate BEFORE TRUNCATE ON search_run
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('frozen-after');

-- Ранги по веткам и итоговое слияние. Фрагмент в одной ветке занимает один ранг.
CREATE TABLE search_run_result (
  run_id      uuid NOT NULL REFERENCES search_run (id),
  branch      text NOT NULL CHECK (branch IN ('exact', 'fts', 'vector', 'fused')),
  rank        int NOT NULL CHECK (rank >= 1),
  fragment_id uuid NOT NULL REFERENCES evidence_fragment (id),
  origin      text NOT NULL,
  score       double precision NOT NULL,
  -- Для fused: ветки, нашедшие фрагмент (ADR-012 §23).
  matched_via text[] NOT NULL DEFAULT '{}',
  chunk_key   text CHECK (length(chunk_key) <= 200),
  PRIMARY KEY (run_id, branch, rank),
  CONSTRAINT search_run_result_fragment_key UNIQUE (run_id, branch, fragment_id)
);

-- Вставка — только в нетерминальный прогон (строка прогона блокируется: терминализация и вставка
-- сериализованы) и только фрагмента закреплённой области доказательного происхождения.
CREATE FUNCTION search_run_result_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run record;
BEGIN
  SELECT status, tender_id, allowed_source_unit_ids INTO run FROM search_run WHERE id = NEW.run_id FOR SHARE;
  IF run.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'search_run_result: результаты принимает только нетерминальный прогон' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM evidence_fragment f
        WHERE f.id = NEW.fragment_id AND f.tender_id = run.tender_id
          AND f.source_unit_id = ANY (run.allowed_source_unit_ids)
          AND f.origin = NEW.origin
          AND f.origin IN ('document_text', 'recognized_text', 'email_body', 'attachment_text', 'negotiation_speech')) THEN
    RAISE EXCEPTION 'search_run_result: фрагмент вне закреплённой области или недоказательного происхождения' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER search_run_result_insert_guard BEFORE INSERT ON search_run_result
  FOR EACH ROW EXECUTE FUNCTION search_run_result_insert_guard();
CREATE TRIGGER search_run_result_immutable BEFORE UPDATE OR DELETE ON search_run_result
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('immutable');
CREATE TRIGGER search_run_result_no_truncate BEFORE TRUNCATE ON search_run_result
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('immutable');

-- ---------------------------------------------------------------- Состояние интеграций (data-model §4.12)

-- Первый писатель — worker (модель эмбеддингов). Сервер во внешние системы не ходит (ADR-007),
-- поэтому доступность модели он узнаёт отсюда, а не проверкой на лету. status — уровень
-- проверки (state-machines §19): VERIFIED_LIVE ставится только с доказательством живой проверки.
CREATE TABLE integration_status (
  system          text NOT NULL CHECK (length(system) BETWEEN 1 AND 60),
  component       text NOT NULL CHECK (length(component) BETWEEN 1 AND 60),
  status          text NOT NULL CHECK (status IN ('NOT_IMPLEMENTED', 'VERIFIED_FIXTURE', 'VERIFIED_LIVE', 'BLOCKED_EXTERNAL')),
  evidence_ref    text CHECK (length(evidence_ref) <= 500),
  verified_at     timestamptz,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error_code text CHECK (length(last_error_code) <= 60),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system, component),
  CONSTRAINT integration_status_live_shape CHECK (status <> 'VERIFIED_LIVE' OR (evidence_ref IS NOT NULL AND verified_at IS NOT NULL))
);

-- ---------------------------------------------------------------- Права ролей

GRANT SELECT, INSERT ON evidence_scope, evidence_scope_item, search_run_result TO kontur_app;
-- mutable / frozen-after: без DELETE (удаление запрещают и триггеры).
GRANT SELECT, INSERT, UPDATE ON search_index_version, search_run, integration_status TO kontur_app;
GRANT SELECT ON integration_status TO kontur_backup;
-- derived: полный DML — индекс пересобирается (ADR-012 §4).
GRANT SELECT, INSERT, UPDATE, DELETE ON search_chunk, search_chunk_fragment, search_chunk_vector, embedding_cache,
  fragment_index_state, search_index_unit TO kontur_app;
GRANT SELECT ON evidence_scope, evidence_scope_item, search_index_version, search_chunk, search_chunk_fragment,
  search_chunk_vector, embedding_cache, fragment_index_state, search_index_unit, search_run, search_run_result TO kontur_backup;
