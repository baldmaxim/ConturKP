// Индекс поиска портала (ADR-012 §1–10, state-machines §20): версии, чанки, связи с фрагментами,
// векторы, кеш эмбеддингов и состояние модели. Индекс — производные данные: его потеря и
// пересборка не трогают доказательства и выпуски (I15).
import type { IBuiltChunk, ISkippedFragment } from '@kontur/core';
import { chunkKeyOf, chunkText, sha256Hex, vectorLiteral } from '@kontur/core';
import { inTransaction, type Queryable } from './pool.ts';

export type IndexVersionStatus = 'building' | 'active' | 'retired' | 'failed';

export interface ISearchIndexVersionRow {
  id: string;
  seq: number;
  status: IndexVersionStatus;
  chunker_version: string;
  fts_config: string;
  embedding_input_version: string | null;
  embedding_model: string | null;
  embedding_model_fingerprint: string | null;
  embedding_dim: number | null;
  probe_vector: string | null;
  created_at: Date;
  activated_at: Date | null;
  retired_at: Date | null;
  purged_at: Date | null;
  failure_code: string | null;
  failure_detail: string | null;
  row_version: number;
}

const SELECT_VERSION = `
  SELECT id, seq, status, chunker_version, fts_config, embedding_input_version, embedding_model,
         embedding_model_fingerprint, embedding_dim, probe_vector::text AS probe_vector, created_at, activated_at,
         retired_at, purged_at, failure_code, failure_detail, row_version
    FROM search_index_version`;

// Текстовое представление halfvec/vector «[x,y,…]» → числа.
export const parseVector = (text: string | null): number[] | null => {
  if (!text) return null;
  const inner = text.trim().replace(/^\[|\]$/gu, '');
  return inner.length === 0 ? [] : inner.split(',').map(Number);
};

type LockMode = 'update' | 'share' | null;
const lockClause = (lock: LockMode): string => (lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : '');

export const getVersion = async (db: Queryable, id: string, lock: LockMode = null): Promise<ISearchIndexVersionRow | null> => {
  const r = await db.query<ISearchIndexVersionRow>(`${SELECT_VERSION} WHERE id = $1${lockClause(lock)}`, [id]);
  return r.rows[0] ?? null;
};

// Активная версия. FOR SHARE — прогон поиска закрепляет версию: удаление её данных ждёт (§20).
export const getActiveVersion = async (db: Queryable, lock: LockMode = null): Promise<ISearchIndexVersionRow | null> => {
  const r = await db.query<ISearchIndexVersionRow>(`${SELECT_VERSION} WHERE status = 'active'${lockClause(lock)}`);
  return r.rows[0] ?? null;
};

export const getBuildingVersion = async (db: Queryable): Promise<ISearchIndexVersionRow | null> => {
  const r = await db.query<ISearchIndexVersionRow>(`${SELECT_VERSION} WHERE status = 'building'`);
  return r.rows[0] ?? null;
};

export const listVersions = async (db: Queryable): Promise<ISearchIndexVersionRow[]> => {
  const r = await db.query<ISearchIndexVersionRow>(`${SELECT_VERSION} ORDER BY seq DESC`);
  return r.rows;
};

export interface IVersionEmbedding {
  inputVersion: string;
  model: string;
  fingerprint: string;
  dim: number;
  probe: number[];
}

export interface INewVersion {
  chunkerVersion: string;
  embedding: IVersionEmbedding | null;
  createdBy: string | null;
}

// Новая версия строится рядом с активной (ADR-012 §5). Вторая building невозможна по
// частичному уникальному индексу: вызывающий получает 23505 и решает, что делать.
export const createVersion = async (db: Queryable, v: INewVersion): Promise<string> =>
  inTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('search_index_version'))");
    const r = await client.query<{ id: string }>(
      `INSERT INTO search_index_version (seq, chunker_version, embedding_input_version, embedding_model,
                                         embedding_model_fingerprint, embedding_dim, probe_vector, created_by)
       VALUES ((SELECT coalesce(max(seq), 0) + 1 FROM search_index_version), $1, $2, $3, $4, $5, $6::halfvec, $7)
       RETURNING id`,
      [
        v.chunkerVersion,
        v.embedding?.inputVersion ?? null,
        v.embedding?.model ?? null,
        v.embedding?.fingerprint ?? null,
        v.embedding?.dim ?? null,
        v.embedding ? vectorLiteral(v.embedding.probe) : null,
        v.createdBy,
      ],
    );
    return r.rows[0]!.id;
  });

export const failVersion = async (db: Queryable, id: string, code: string, detail: string): Promise<boolean> => {
  const r = await db.query(
    `UPDATE search_index_version SET status = 'failed', failure_code = $2, failure_detail = $3, row_version = row_version + 1
      WHERE id = $1 AND status = 'building'`,
    [id, code.slice(0, 60), detail.slice(0, 2000)],
  );
  return (r.rowCount ?? 0) > 0;
};

export interface ICompleteness {
  missingUnits: number;
  missingVectors: number;
}

// Полнота версии: каждая завершённая единица источника проиндексирована, у версии с моделью
// у каждого чанка есть вектор (G05-01: текстовый фронт завершён и хвост векторов пуст).
export const versionCompleteness = async (db: Queryable, v: Pick<ISearchIndexVersionRow, 'id' | 'embedding_model'>): Promise<ICompleteness> => {
  const units = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM recognition_run r
      WHERE r.status IN ('complete', 'partial')
        AND NOT EXISTS (SELECT 1 FROM search_index_unit u WHERE u.index_version_id = $1 AND u.source_unit_id = r.id)`,
    [v.id],
  );
  const vectors = v.embedding_model
    ? await db.query<{ n: number }>(
        `SELECT count(*) AS n FROM search_chunk c
          WHERE c.index_version_id = $1 AND NOT EXISTS (SELECT 1 FROM search_chunk_vector x WHERE x.chunk_id = c.id)`,
        [v.id],
      )
    : { rows: [{ n: 0 }] };
  return { missingUnits: units.rows[0]!.n, missingVectors: vectors.rows[0]!.n };
};

export interface IActivation extends ICompleteness {
  activated: boolean;
}

// building → active атомарно и только после полноты; прежняя active → retired в той же
// транзакции (state-machines §20). Неполная версия не активируется.
export const activateVersion = async (db: Queryable, id: string): Promise<IActivation> =>
  inTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('search_index_version'))");
    const v = await getVersion(client, id, 'update');
    if (!v || v.status !== 'building') return { activated: false, missingUnits: 0, missingVectors: 0 };
    const c = await versionCompleteness(client, v);
    if (c.missingUnits > 0 || c.missingVectors > 0) return { activated: false, ...c };
    await client.query(
      `UPDATE search_index_version SET status = 'retired', retired_at = now(), row_version = row_version + 1
        WHERE status = 'active'`,
    );
    await client.query(
      `UPDATE search_index_version SET status = 'active', activated_at = now(), row_version = row_version + 1
        WHERE id = $1 AND status = 'building'`,
      [id],
    );
    return { activated: true, ...c };
  });

export type PurgeOutcome = 'purged' | 'pending_runs' | 'not_retired';

// Данные выведенной версии удаляются, только когда за ней не закреплён ни один ожидающий прогон
// поиска (ADR-012 §5). Прогон и смысловое задание держат FOR SHARE строки версии, поэтому
// удаление не пересекается с их чтением. Строка версии остаётся: на неё ссылаются прогоны.
export const purgeVersion = async (db: Queryable, id: string): Promise<PurgeOutcome> =>
  inTransaction(db, async (client) => {
    const v = await getVersion(client, id, 'update');
    if (!v || v.status !== 'retired' || v.purged_at) return 'not_retired';
    const pending = await client.query("SELECT 1 FROM search_run WHERE index_version_id = $1 AND status = 'pending' LIMIT 1", [id]);
    if ((pending.rowCount ?? 0) > 0) return 'pending_runs';
    await client.query('DELETE FROM search_chunk WHERE index_version_id = $1', [id]);
    await client.query('DELETE FROM fragment_index_state WHERE index_version_id = $1', [id]);
    await client.query('DELETE FROM search_index_unit WHERE index_version_id = $1', [id]);
    await client.query('UPDATE search_index_version SET purged_at = now(), row_version = row_version + 1 WHERE id = $1', [id]);
    return 'purged';
  });

export const retiredVersionsToPurge = async (db: Queryable): Promise<string[]> => {
  const r = await db.query<{ id: string }>(
    `SELECT v.id FROM search_index_version v
      WHERE v.status = 'retired' AND v.purged_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM search_run s WHERE s.index_version_id = v.id AND s.status = 'pending')
      ORDER BY v.seq`,
  );
  return r.rows.map((x) => x.id);
};

// ---------------------------------------------------------------- Построение текстового индекса

export interface IIndexUnitRow {
  id: string;
  tender_id: string;
  document_revision_id: string;
}

// Завершённые единицы источника, ещё не проиндексированные версией (в порядке завершения).
export const unitsMissingInVersion = async (db: Queryable, versionId: string, limit: number): Promise<IIndexUnitRow[]> => {
  const r = await db.query<IIndexUnitRow>(
    `SELECT r.id, r.tender_id, r.document_revision_id FROM recognition_run r
      WHERE r.status IN ('complete', 'partial')
        AND NOT EXISTS (SELECT 1 FROM search_index_unit u WHERE u.index_version_id = $1 AND u.source_unit_id = r.id)
      ORDER BY r.finished_at, r.id
      LIMIT $2`,
    [versionId, limit],
  );
  return r.rows;
};

export interface IIndexFragmentRow {
  id: string;
  origin: string;
  fragment_kind: string;
  text: string;
  page_index: number | null;
}

export const fragmentsForIndex = async (db: Queryable, runId: string): Promise<IIndexFragmentRow[]> => {
  const r = await db.query<IIndexFragmentRow>(
    `SELECT id, origin, fragment_kind, text, page_index FROM evidence_fragment
      WHERE run_id = $1
      ORDER BY page_index NULLS LAST, coalesce(ordinal, -1), part_index, id`,
    [runId],
  );
  return r.rows;
};

export interface IUnitChunks {
  pageIndex: number | null;
  chunks: IBuiltChunk[];
}

// Единица источника индексируется целиком в одной транзакции вызывающего: чанки, связи,
// состояние фрагментов и отметка единицы. Повтор ничего не удваивает (ключи детерминированы).
export const indexUnit = async (
  db: Queryable,
  versionId: string,
  unit: IIndexUnitRow,
  pages: IUnitChunks[],
  indexed: string[],
  skipped: ISkippedFragment[],
): Promise<{ chunks: number; created: boolean }> => {
  const done = await db.query('SELECT 1 FROM search_index_unit WHERE index_version_id = $1 AND source_unit_id = $2', [versionId, unit.id]);
  if ((done.rowCount ?? 0) > 0) return { chunks: 0, created: false };
  const rows = pages.flatMap((p) => p.chunks.map((c) => ({ pageIndex: p.pageIndex, chunk: c, key: chunkKeyOf(unit.id, p.pageIndex, c.partNo) })));
  if (rows.length > 0) {
    await db.query(
      `INSERT INTO search_chunk (index_version_id, tender_id, source_unit_type, source_unit_id, document_revision_id,
                                 page_index, part_no, chunk_key, header_text, body_text, text_sha256)
       SELECT $1, $2, 'recognition_run', $3, $4, x.page_index, x.part_no, x.chunk_key, x.header_text, x.body_text, x.text_sha256
         FROM unnest($5::int[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[])
              AS x(page_index, part_no, chunk_key, header_text, body_text, text_sha256)
       ON CONFLICT (index_version_id, chunk_key) DO NOTHING`,
      [
        versionId,
        unit.tender_id,
        unit.id,
        unit.document_revision_id,
        rows.map((r) => r.pageIndex),
        rows.map((r) => r.chunk.partNo),
        rows.map((r) => r.key),
        rows.map((r) => r.chunk.headerText),
        rows.map((r) => r.chunk.bodyText),
        rows.map((r) => sha256Hex(chunkText(r.chunk))),
      ],
    );
    const ids = await db.query<{ id: string; chunk_key: string }>(
      'SELECT id, chunk_key FROM search_chunk WHERE index_version_id = $1 AND chunk_key = ANY($2::text[])',
      [versionId, rows.map((r) => r.key)],
    );
    const idOf = new Map(ids.rows.map((x) => [x.chunk_key, x.id]));
    const links = rows.flatMap((r) => r.chunk.links.map((l) => ({ chunkId: idOf.get(r.key)!, ...l })));
    await db.query(
      `INSERT INTO search_chunk_fragment (chunk_id, index_version_id, source_unit_id, tender_id, fragment_id, ordinal, role, char_start, char_end)
       SELECT x.chunk_id, $1, $2, $3, x.fragment_id, x.ordinal, x.role, x.char_start, x.char_end
         FROM unnest($4::uuid[], $5::uuid[], $6::int[], $7::text[], $8::int[], $9::int[])
              AS x(chunk_id, fragment_id, ordinal, role, char_start, char_end)
       ON CONFLICT DO NOTHING`,
      [
        versionId,
        unit.id,
        unit.tender_id,
        links.map((l) => l.chunkId),
        links.map((l) => l.fragmentId),
        links.map((l) => l.ordinal),
        links.map((l) => l.role),
        links.map((l) => l.charStart),
        links.map((l) => l.charEnd),
      ],
    );
  }
  const states = [
    ...indexed.map((id) => ({ id, status: 'indexed', reason: null as string | null })),
    ...skipped.map((s) => ({ id: s.fragmentId, status: 'skipped', reason: s.reason as string | null })),
  ];
  if (states.length > 0) {
    await db.query(
      `INSERT INTO fragment_index_state (index_version_id, index_system, fragment_id, run_id, status, skip_reason)
       SELECT $1, 'portal_fts', x.fragment_id, $2, x.status, x.skip_reason
         FROM unnest($3::uuid[], $4::text[], $5::text[]) AS x(fragment_id, status, skip_reason)
       ON CONFLICT DO NOTHING`,
      [versionId, unit.id, states.map((s) => s.id), states.map((s) => s.status), states.map((s) => s.reason)],
    );
  }
  await db.query(
    `INSERT INTO search_index_unit (index_version_id, source_unit_type, source_unit_id, tender_id, chunks, fragments_indexed, fragments_skipped)
     VALUES ($1, 'recognition_run', $2, $3, $4, $5, $6)`,
    [versionId, unit.id, unit.tender_id, rows.length, indexed.length, skipped.length],
  );
  return { chunks: rows.length, created: true };
};

// ---------------------------------------------------------------- Векторы и кеш

export interface IChunkForVector {
  id: string;
  source_unit_id: string;
  tender_id: string;
  header_text: string;
  body_text: string;
}

export const chunksWithoutVectors = async (db: Queryable, versionId: string, limit: number): Promise<IChunkForVector[]> => {
  const r = await db.query<IChunkForVector>(
    `SELECT c.id, c.source_unit_id, c.tender_id, c.header_text, c.body_text FROM search_chunk c
      WHERE c.index_version_id = $1 AND NOT EXISTS (SELECT 1 FROM search_chunk_vector v WHERE v.chunk_id = c.id)
      ORDER BY c.id
      LIMIT $2`,
    [versionId, limit],
  );
  return r.rows;
};

export const insertChunkVectors = async (
  db: Queryable,
  versionId: string,
  dim: number,
  rows: { chunkId: string; unitId: string; tenderId: string; vector: number[] }[],
): Promise<void> => {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO search_chunk_vector (chunk_id, index_version_id, source_unit_id, tender_id, dim, embedding)
     SELECT x.chunk_id, $1, x.unit_id, x.tender_id, $2, x.v::halfvec
       FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::text[]) AS x(chunk_id, unit_id, tender_id, v)
     ON CONFLICT (chunk_id) DO NOTHING`,
    [versionId, dim, rows.map((r) => r.chunkId), rows.map((r) => r.unitId), rows.map((r) => r.tenderId), rows.map((r) => vectorLiteral(r.vector))],
  );
};

export interface IEmbeddingKeyBase {
  purpose: 'index' | 'query';
  model: string;
  fingerprint: string;
  inputVersion: string;
  dim: number;
}

// Вектор берётся из кеша только при совпадении всего ключа (ADR-012 §9).
export const cacheLookup = async (db: Queryable, key: IEmbeddingKeyBase, textShas: string[]): Promise<Map<string, number[]>> => {
  if (textShas.length === 0) return new Map();
  const r = await db.query<{ text_sha256: string; embedding: string }>(
    `SELECT text_sha256, embedding::text AS embedding FROM embedding_cache
      WHERE purpose = $1 AND embedding_model = $2 AND embedding_model_fingerprint = $3
        AND embedding_input_version = $4 AND dim = $5 AND text_sha256 = ANY($6::text[])`,
    [key.purpose, key.model, key.fingerprint, key.inputVersion, key.dim, textShas],
  );
  return new Map(r.rows.map((x) => [x.text_sha256, parseVector(x.embedding)!]));
};

export const cacheStore = async (db: Queryable, key: IEmbeddingKeyBase, rows: { textSha256: string; vector: number[] }[]): Promise<void> => {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO embedding_cache (text_sha256, purpose, embedding_model, embedding_model_fingerprint, embedding_input_version, dim, embedding)
     SELECT x.sha, $1, $2, $3, $4, $5, x.v::halfvec FROM unnest($6::text[], $7::text[]) AS x(sha, v)
     ON CONFLICT DO NOTHING`,
    [key.purpose, key.model, key.fingerprint, key.inputVersion, key.dim, rows.map((r) => r.textSha256), rows.map((r) => vectorLiteral(r.vector))],
  );
};

export const versionVectorCounts = async (db: Queryable, versionId: string): Promise<{ chunks: number; vectors: number }> => {
  const r = await db.query<{ chunks: number; vectors: number }>(
    `SELECT (SELECT count(*) FROM search_chunk WHERE index_version_id = $1) AS chunks,
            (SELECT count(*) FROM search_chunk_vector WHERE index_version_id = $1) AS vectors`,
    [versionId],
  );
  return r.rows[0]!;
};

// ---------------------------------------------------------------- Состояние модели (integration_status)

export const MODEL_STATUS_KEY = { system: 'embedding_model', component: 'ModelGatewayEmbeddings' } as const;

export interface IModelStatusRow {
  status: string;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  last_error_code: string | null;
  details: Record<string, unknown>;
}

// Итог проверки модели пишет только worker: сервер во внешние системы не ходит (ADR-007).
export const recordModelStatus = async (
  db: Queryable,
  s: { ok: boolean; errorCode: string | null; verification: 'NOT_IMPLEMENTED' | 'VERIFIED_FIXTURE'; details: Record<string, unknown> },
): Promise<void> => {
  await db.query(
    `INSERT INTO integration_status (system, component, status, last_checked_at, last_success_at, last_error_code, details, updated_at)
     VALUES ($1, $2, $3, now(), CASE WHEN $4 THEN now() END, $5, $6::jsonb, now())
     ON CONFLICT (system, component) DO UPDATE SET
       status = CASE WHEN integration_status.status = 'VERIFIED_LIVE' THEN integration_status.status ELSE EXCLUDED.status END,
       last_checked_at = now(),
       last_success_at = CASE WHEN $4 THEN now() ELSE integration_status.last_success_at END,
       last_error_code = $5,
       details = $6::jsonb,
       updated_at = now()`,
    [MODEL_STATUS_KEY.system, MODEL_STATUS_KEY.component, s.verification, s.ok, s.ok ? null : s.errorCode, JSON.stringify(s.details)],
  );
};

// Успешный вызов модели снимает прежний отказ, чтобы сервер не держал смысловую ветку недоступной.
export const noteModelSuccess = async (db: Queryable): Promise<void> => {
  await db.query(
    `UPDATE integration_status SET last_success_at = now(), last_checked_at = now(), last_error_code = NULL, updated_at = now()
      WHERE system = $1 AND component = $2 AND last_error_code IS NOT NULL`,
    [MODEL_STATUS_KEY.system, MODEL_STATUS_KEY.component],
  );
};

export const getModelStatus = async (db: Queryable): Promise<IModelStatusRow | null> => {
  const r = await db.query<IModelStatusRow>(
    'SELECT status, last_checked_at, last_success_at, last_error_code, details FROM integration_status WHERE system = $1 AND component = $2',
    [MODEL_STATUS_KEY.system, MODEL_STATUS_KEY.component],
  );
  return r.rows[0] ?? null;
};
