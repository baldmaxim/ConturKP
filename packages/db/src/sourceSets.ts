// Состав источников этапа (state-machines §5): набор working, draft-ревизия с включением
// или исключением каждой редакции с причиной. Заморозка требует распознавания (этап 04):
// у каждой включённой редакции есть завершённый или явно неполный прогон.
import type { Queryable } from './pool.ts';

export interface ISourceSetRevisionRow {
  id: string;
  source_set_id: string;
  stage_id: string;
  seq: number;
  status: 'draft' | 'frozen';
  base_revision_id: string | null;
  content_hash: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ISourceSetItemRow {
  document_revision_id: string;
  blob_sha256: string;
  inclusion: 'included' | 'excluded_not_applicable' | 'inherited';
  reason: string | null;
  decided_by: string | null;
  document_id: string;
  document_title: string;
  revision_seq: number;
}

export const ensureWorkingSet = async (db: Queryable, stageId: string): Promise<string> => {
  await db.query("INSERT INTO source_set (stage_id, purpose) VALUES ($1, 'working') ON CONFLICT (stage_id, purpose) DO NOTHING", [stageId]);
  const r = await db.query<{ id: string }>("SELECT id FROM source_set WHERE stage_id = $1 AND purpose = 'working'", [stageId]);
  return r.rows[0]!.id;
};

const SELECT_REVISION = `
  SELECT r.id, r.source_set_id, s.stage_id, r.seq, r.status, r.base_revision_id, r.content_hash, r.row_version, r.created_at, r.updated_at
    FROM source_set_revision r JOIN source_set s ON s.id = r.source_set_id`;

export const listSetRevisions = async (db: Queryable, setId: string): Promise<ISourceSetRevisionRow[]> => {
  const r = await db.query<ISourceSetRevisionRow>(`${SELECT_REVISION} WHERE r.source_set_id = $1 ORDER BY r.seq DESC`, [setId]);
  return r.rows;
};

export const getSetRevision = async (db: Queryable, id: string, lock = false): Promise<ISourceSetRevisionRow | null> => {
  if (lock) await db.query('SELECT 1 FROM source_set_revision WHERE id = $1 FOR UPDATE', [id]);
  const r = await db.query<ISourceSetRevisionRow>(`${SELECT_REVISION} WHERE r.id = $1`, [id]);
  return r.rows[0] ?? null;
};

// Новая draft-ревизия — копия состава последней ревизии (base); одна draft на набор (уникальный индекс).
export const createDraftRevision = async (db: Queryable, setId: string, userId: string): Promise<string> => {
  const last = await db.query<{ id: string; seq: number }>(
    'SELECT id, seq FROM source_set_revision WHERE source_set_id = $1 ORDER BY seq DESC LIMIT 1',
    [setId],
  );
  const base = last.rows[0] ?? null;
  const r = await db.query<{ id: string }>(
    'INSERT INTO source_set_revision (source_set_id, seq, base_revision_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [setId, (base?.seq ?? 0) + 1, base?.id ?? null, userId],
  );
  const id = r.rows[0]!.id;
  if (base) {
    await db.query(
      `INSERT INTO source_set_item (source_set_revision_id, document_revision_id, inclusion, decided_by, reason)
       SELECT $1, document_revision_id, inclusion, decided_by, reason FROM source_set_item WHERE source_set_revision_id = $2`,
      [id, base.id],
    );
  }
  return id;
};

export const listSetItems = async (db: Queryable, revisionId: string): Promise<ISourceSetItemRow[]> => {
  const r = await db.query<ISourceSetItemRow>(
    `SELECT i.document_revision_id, i.inclusion, i.reason, i.decided_by, dr.blob_sha256,
            d.id AS document_id, d.title AS document_title, dr.revision_seq
       FROM source_set_item i
       JOIN document_revision dr ON dr.id = i.document_revision_id
       JOIN document d ON d.id = dr.document_id
      WHERE i.source_set_revision_id = $1
      ORDER BY d.title, dr.revision_seq`,
    [revisionId],
  );
  return r.rows;
};

// Полная замена состава draft-ревизии; триггер запрещает изменение замороженной.
export const replaceSetItems = async (
  db: Queryable,
  revisionId: string,
  items: { documentRevisionId: string; inclusion: 'included' | 'excluded_not_applicable'; reason: string | null }[],
  userId: string,
): Promise<void> => {
  await db.query('DELETE FROM source_set_item WHERE source_set_revision_id = $1', [revisionId]);
  for (const it of items) {
    await db.query(
      `INSERT INTO source_set_item (source_set_revision_id, document_revision_id, inclusion, decided_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [revisionId, it.documentRevisionId, it.inclusion, userId, it.reason],
    );
  }
  await db.query('UPDATE source_set_revision SET updated_at = now(), row_version = row_version + 1 WHERE id = $1', [revisionId]);
};

// draft → frozen. Охранное условие проверяет вызывающий (blockingFreezeItems); триггер
// миграции 0005 повторяет проверку второй линией. 0 строк — ревизия уже не черновик.
export const freezeSetRevision = async (db: Queryable, id: string, f: { contentHash: string; userId: string }): Promise<boolean> => {
  const r = await db.query(
    `UPDATE source_set_revision
        SET status = 'frozen', frozen_at = now(), frozen_by = $3, content_hash = $2,
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status = 'draft'`,
    [id, f.contentHash, f.userId],
  );
  return (r.rowCount ?? 0) > 0;
};
