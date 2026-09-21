// Источники: blob, документы, редакции, происхождения, партии и элементы импорта
// (data-model §4.3, state-machines §3). Путь — история происхождения, не идентичность.
import { nameKeyOf } from '@kontur/core';
import { contentTenderIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';
import { emitStageEvents, lockTenderStages } from './stageEvents.ts';

export type ItemStatus = 'pending' | 'skipped_partial' | 'rejected' | 'registered' | 'duplicate';
export type RejectReason = 'path_traversal' | 'size_limit' | 'type_not_allowed' | 'unstable_file' | 'corrupt';
export type OccurrenceKind = 'upload' | 'watched_folder' | 'archive_member' | 'yandex_disk' | 'smb' | 'rdweb_export';

export const insertBlob = async (
  db: Queryable,
  b: { sha256: string; sizeBytes: number; mediaType: string; storageKey: string },
): Promise<void> => {
  await db.query(
    'INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING',
    [b.sha256, b.sizeBytes, b.mediaType, b.storageKey],
  );
};

export interface IBatchRow {
  id: string;
  tender_id: string;
  stage_id: string | null;
  source_kind: 'upload' | 'watched_folder';
  intake_channel_id: string | null;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  upload_name: string | null;
  upload_blob_sha256: string | null;
  failure_code: string | null;
  expanded_at: Date | null;
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export const createBatch = async (
  db: Queryable,
  b: {
    tenderId: string;
    stageId: string | null;
    sourceKind: 'upload' | 'watched_folder';
    channelId: string | null;
    uploadName: string | null;
    uploadSha: string | null;
    createdBy: string | null;
  },
): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO import_batch (tender_id, stage_id, source_kind, intake_channel_id, upload_name, upload_blob_sha256, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [b.tenderId, b.stageId, b.sourceKind, b.channelId, b.uploadName, b.uploadSha, b.createdBy],
  );
  return r.rows[0]!.id;
};

export const getBatch = async (db: Queryable, id: string, lock = false): Promise<IBatchRow | null> => {
  const r = await db.query<IBatchRow>(`SELECT * FROM import_batch WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ?? null;
};

export const markExpanded = async (db: Queryable, batchId: string): Promise<void> => {
  await db.query("UPDATE import_batch SET expanded_at = coalesce(expanded_at, now()) WHERE id = $1 AND status = 'running'", [batchId]);
};

export interface IItemRow {
  id: string;
  batch_id: string;
  tender_id: string;
  member_path: string;
  observed_name: string;
  status: ItemStatus;
  reject_reason: RejectReason | null;
  reject_detail: string | null;
  size_bytes: number | null;
  blob_sha256: string | null;
  document_revision_id: string | null;
  resolution: 'none' | 'reimported' | 'not_applicable';
  resolved_by_item_id: string | null;
  resolution_decision_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  row_version: number;
  created_at: Date;
}

export interface INewItem {
  batchId: string;
  tenderId: string;
  memberPath: string;
  observedName: string;
  status: 'pending' | 'rejected' | 'skipped_partial';
  rejectReason?: RejectReason | null;
  rejectDetail?: string | null;
  sizeBytes?: number | null;
  blobSha?: string | null;
}

// Повтор (перехват задания разбора) не создаёт второй элемент: (batch_id, member_path) уникальны.
export const insertItem = async (db: Queryable, i: INewItem): Promise<{ id: string; created: boolean }> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO import_item (batch_id, tender_id, member_path, observed_name, status, reject_reason, reject_detail, size_bytes, blob_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (batch_id, member_path) DO NOTHING RETURNING id`,
    [i.batchId, i.tenderId, i.memberPath, i.observedName, i.status, i.rejectReason ?? null, i.rejectDetail ?? null, i.sizeBytes ?? null, i.blobSha ?? null],
  );
  if (r.rows[0]) return { id: r.rows[0].id, created: true };
  const e = await db.query<{ id: string }>('SELECT id FROM import_item WHERE batch_id = $1 AND member_path = $2', [i.batchId, i.memberPath]);
  return { id: e.rows[0]!.id, created: false };
};

export const getItem = async (db: Queryable, id: string, lock = false): Promise<IItemRow | null> => {
  const r = await db.query<IItemRow>(`SELECT * FROM import_item WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ?? null;
};

export const listItems = async (db: Queryable, batchId: string): Promise<IItemRow[]> => {
  const r = await db.query<IItemRow>('SELECT * FROM import_item WHERE batch_id = $1 ORDER BY member_path', [batchId]);
  return r.rows;
};

export interface IRegistration {
  status: 'registered' | 'duplicate';
  revisionId: string;
  documentId: string;
  newDocument: boolean;
}

// Регистрация элемента (state-machines §3): блокировки этапов тендера и строки тендера,
// редакция по (tender_id, blob_sha256) — существующая даёт duplicate (A14); иначе новая
// редакция документа с тем же именем (A13) или новый документ. Происхождение — всегда.
// Событие document_revision_registered — только для новой редакции.
export const registerItem = async (
  db: Queryable,
  item: IItemRow,
  o: { sourceKind: OccurrenceKind; locator: string; channelId: string | null; actorUserId: string | null },
): Promise<IRegistration> => {
  if (!item.blob_sha256) throw new Error('элемент без содержимого');
  await lockTenderStages(db, item.tender_id, null);
  await db.query('SELECT 1 FROM tender WHERE id = $1 FOR UPDATE', [item.tender_id]);
  const existing = await db.query<{ id: string; document_id: string }>(
    'SELECT id, document_id FROM document_revision WHERE tender_id = $1 AND blob_sha256 = $2',
    [item.tender_id, item.blob_sha256],
  );
  let result: IRegistration;
  if (existing.rows[0]) {
    result = { status: 'duplicate', revisionId: existing.rows[0].id, documentId: existing.rows[0].document_id, newDocument: false };
  } else {
    const key = nameKeyOf(item.member_path);
    const doc = await db.query<{ id: string }>(
      'SELECT id FROM document WHERE tender_id = $1 AND name_key = $2 ORDER BY created_at LIMIT 1',
      [item.tender_id, key],
    );
    let documentId = doc.rows[0]?.id;
    const newDocument = !documentId;
    if (!documentId) {
      const d = await db.query<{ id: string }>(
        'INSERT INTO document (tender_id, title, name_key) VALUES ($1, $2, $3) RETURNING id',
        [item.tender_id, item.observed_name.slice(0, 500), key],
      );
      documentId = d.rows[0]!.id;
    }
    const prev = await db.query<{ id: string; revision_seq: number }>(
      'SELECT id, revision_seq FROM document_revision WHERE document_id = $1 ORDER BY revision_seq DESC LIMIT 1',
      [documentId],
    );
    const rev = await db.query<{ id: string }>(
      `INSERT INTO document_revision (document_id, tender_id, blob_sha256, revision_seq, supersedes_revision_id, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [documentId, item.tender_id, item.blob_sha256, (prev.rows[0]?.revision_seq ?? 0) + 1, prev.rows[0]?.id ?? null, o.actorUserId],
    );
    result = { status: 'registered', revisionId: rev.rows[0]!.id, documentId, newDocument };
    await emitStageEvents(db, {
      tenderId: item.tender_id,
      stageIds: null,
      eventType: 'document_revision_registered',
      refType: 'document_revision',
      refId: result.revisionId,
      actorUserId: o.actorUserId,
    });
  }
  await insertOccurrence(db, {
    documentRevisionId: result.revisionId,
    tenderId: item.tender_id,
    sourceKind: o.sourceKind,
    locator: o.locator,
    observedName: item.observed_name,
    importItemId: item.id,
    channelId: o.channelId,
  });
  await db.query(
    "UPDATE import_item SET status = $2, document_revision_id = $3, updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'pending'",
    [item.id, result.status, result.revisionId],
  );
  return result;
};

export const rejectPendingItem = async (db: Queryable, itemId: string, reason: RejectReason, detail: string): Promise<void> => {
  await db.query(
    `UPDATE import_item SET status = 'rejected', reject_reason = $2, reject_detail = $3, updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status = 'pending'`,
    [itemId, reason, detail.slice(0, 500)],
  );
};

// Партия завершается, когда состав известен и не осталось pending: completed или completed_with_errors.
export const finalizeBatchIfDone = async (db: Queryable, batchId: string): Promise<IBatchRow['status'] | null> => {
  const b = await getBatch(db, batchId, true);
  if (!b || b.status !== 'running' || !b.expanded_at) return b?.status ?? null;
  const c = await db.query<{ pending: number; errors: number }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status IN ('rejected', 'skipped_partial'))::int AS errors
       FROM import_item WHERE batch_id = $1`,
    [batchId],
  );
  const { pending, errors } = c.rows[0]!;
  if (pending > 0) return 'running';
  const status = errors > 0 ? 'completed_with_errors' : 'completed';
  await db.query('UPDATE import_batch SET status = $2, completed_at = now() WHERE id = $1', [batchId, status]);
  return status;
};

// Внутренний сбой после исчерпания попыток: партия failed, незавершённые элементы остаются pending
// (в истории видно, что именно не обработано); событие import_accepted остаётся непокрытым.
export const failBatch = async (db: Queryable, batchId: string, code: string): Promise<void> => {
  await db.query("UPDATE import_batch SET status = 'failed', failure_code = $2, completed_at = now() WHERE id = $1 AND status = 'running'", [batchId, code]);
};

// ---- чтение в области тендеров пользователя

export interface IBatchSummary extends IBatchRow {
  items_total: number;
  items_pending: number;
  items_registered: number;
  items_duplicate: number;
  items_rejected: number;
  items_unresolved: number;
}

const SUMMARY = `
  SELECT b.*,
         count(i.id)::int AS items_total,
         count(i.id) FILTER (WHERE i.status = 'pending')::int AS items_pending,
         count(i.id) FILTER (WHERE i.status = 'registered')::int AS items_registered,
         count(i.id) FILTER (WHERE i.status = 'duplicate')::int AS items_duplicate,
         count(i.id) FILTER (WHERE i.status IN ('rejected', 'skipped_partial'))::int AS items_rejected,
         count(i.id) FILTER (WHERE i.status IN ('rejected', 'skipped_partial') AND i.resolution = 'none')::int AS items_unresolved
    FROM import_batch b LEFT JOIN import_item i ON i.batch_id = b.id`;

export const listBatches = async (db: Queryable, ctx: IAccessContext, tenderId: string, limit: number): Promise<IBatchSummary[]> => {
  const r = await db.query<IBatchSummary>(
    `${SUMMARY} WHERE b.tender_id = $1 AND b.tender_id = ANY($2::uuid[]) GROUP BY b.id ORDER BY b.created_at DESC LIMIT $3`,
    [tenderId, contentTenderIds(ctx), limit],
  );
  return r.rows;
};

export const getBatchSummary = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IBatchSummary | null> => {
  const r = await db.query<IBatchSummary>(`${SUMMARY} WHERE b.id = $1 AND b.tender_id = ANY($2::uuid[]) GROUP BY b.id`, [id, contentTenderIds(ctx)]);
  return r.rows[0] ?? null;
};

export const getScopedItem = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IItemRow | null> => {
  const r = await db.query<IItemRow>(`SELECT * FROM import_item WHERE id = $1 AND tender_id = ANY($2::uuid[])${lock ? ' FOR UPDATE' : ''}`, [
    id,
    contentTenderIds(ctx),
  ]);
  return r.rows[0] ?? null;
};

export interface IDocumentRow {
  id: string;
  tender_id: string;
  title: string;
  doc_type: string;
  doc_code: string | null;
  scope_note: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  revisions: number;
  latest_revision_id: string | null;
  latest_received_at: Date | null;
}

const SELECT_DOCUMENT = `
  SELECT d.id, d.tender_id, d.title, d.doc_type, d.doc_code, d.scope_note, d.row_version, d.created_at, d.updated_at,
         count(r.id)::int AS revisions,
         (array_agg(r.id ORDER BY r.revision_seq DESC))[1] AS latest_revision_id,
         max(r.received_at) AS latest_received_at
    FROM document d LEFT JOIN document_revision r ON r.document_id = d.id`;

export const listDocuments = async (db: Queryable, ctx: IAccessContext, tenderId: string): Promise<IDocumentRow[]> => {
  const r = await db.query<IDocumentRow>(
    `${SELECT_DOCUMENT} WHERE d.tender_id = $1 AND d.tender_id = ANY($2::uuid[]) GROUP BY d.id ORDER BY d.title`,
    [tenderId, contentTenderIds(ctx)],
  );
  return r.rows;
};

export const getDocument = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IDocumentRow | null> => {
  if (lock) await db.query('SELECT 1 FROM document WHERE id = $1 AND tender_id = ANY($2::uuid[]) FOR UPDATE', [id, contentTenderIds(ctx)]);
  const r = await db.query<IDocumentRow>(`${SELECT_DOCUMENT} WHERE d.id = $1 AND d.tender_id = ANY($2::uuid[]) GROUP BY d.id`, [
    id,
    contentTenderIds(ctx),
  ]);
  return r.rows[0] ?? null;
};

export const updateDocument = async (
  db: Queryable,
  id: string,
  p: { title?: string | undefined; docType?: string | undefined; docCode?: string | null | undefined; scopeNote?: string | null | undefined },
): Promise<void> => {
  await db.query(
    `UPDATE document SET
        title = CASE WHEN $2 THEN $3 ELSE title END,
        doc_type = CASE WHEN $4 THEN $5 ELSE doc_type END,
        doc_code = CASE WHEN $6 THEN $7 ELSE doc_code END,
        scope_note = CASE WHEN $8 THEN $9 ELSE scope_note END,
        updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [
      id,
      p.title !== undefined, p.title ?? null,
      p.docType !== undefined, p.docType ?? null,
      p.docCode !== undefined, p.docCode ?? null,
      p.scopeNote !== undefined, p.scopeNote ?? null,
    ],
  );
};

export interface IRevisionRow {
  id: string;
  document_id: string;
  tender_id: string;
  blob_sha256: string;
  revision_seq: number;
  supersedes_revision_id: string | null;
  received_at: Date;
  registered_by: string | null;
  size_bytes: number;
  media_type: string;
}

const SELECT_REVISION = `
  SELECT r.id, r.document_id, r.tender_id, r.blob_sha256, r.revision_seq, r.supersedes_revision_id, r.received_at,
         r.registered_by, b.size_bytes, b.media_type
    FROM document_revision r JOIN blob b ON b.sha256 = r.blob_sha256`;

export const listRevisions = async (db: Queryable, documentId: string): Promise<IRevisionRow[]> => {
  const r = await db.query<IRevisionRow>(`${SELECT_REVISION} WHERE r.document_id = $1 ORDER BY r.revision_seq DESC`, [documentId]);
  return r.rows;
};

export const getRevision = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IRevisionRow | null> => {
  const r = await db.query<IRevisionRow>(`${SELECT_REVISION} WHERE r.id = $1 AND r.tender_id = ANY($2::uuid[])`, [id, contentTenderIds(ctx)]);
  return r.rows[0] ?? null;
};

// Происхождение редакции: где именно этот же байт-в-байт файл наблюдался (путь — история,
// не идентичность). Экспорт RDWeb регистрирует происхождение rdweb_export (этап 04).
export const insertOccurrence = async (
  db: Queryable,
  o: {
    documentRevisionId: string;
    tenderId: string;
    sourceKind: OccurrenceKind;
    locator: string;
    observedName: string;
    importItemId?: string | null;
    channelId?: string | null;
  },
): Promise<void> => {
  await db.query(
    `INSERT INTO document_occurrence (document_revision_id, tender_id, source_kind, source_locator, observed_name, import_item_id, intake_channel_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [o.documentRevisionId, o.tenderId, o.sourceKind, o.locator, o.observedName, o.importItemId ?? null, o.channelId ?? null],
  );
};

export interface IOccurrenceRow {
  id: string;
  document_revision_id: string;
  source_kind: OccurrenceKind;
  source_locator: string;
  observed_name: string;
  observed_at: Date;
  import_item_id: string | null;
  intake_channel_id: string | null;
}

export const listOccurrences = async (db: Queryable, revisionIds: string[]): Promise<IOccurrenceRow[]> => {
  const r = await db.query<IOccurrenceRow>(
    'SELECT * FROM document_occurrence WHERE document_revision_id = ANY($1::uuid[]) ORDER BY observed_at',
    [revisionIds],
  );
  return r.rows;
};

// ---- исход элемента партии (state-machines §3.1)

export const resolveItemReimported = async (db: Queryable, itemId: string, byItemId: string, userId: string): Promise<void> => {
  await db.query(
    `UPDATE import_item SET resolution = 'reimported', resolved_by_item_id = $2, resolved_by = $3, resolved_at = now(),
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND resolution = 'none'`,
    [itemId, byItemId, userId],
  );
};

export const resolveItemNotApplicable = async (
  db: Queryable,
  item: IItemRow,
  d: { stageId: string | null; reason: string; userId: string },
): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
     VALUES ($1, $2, 'import_item', $3, 'import_item_disposition', $4, $5, $6) RETURNING id`,
    [item.tender_id, d.stageId, item.id, `Элемент «${item.member_path}» неприменим`, d.reason, d.userId],
  );
  const decisionId = r.rows[0]!.id;
  await db.query(
    `UPDATE import_item SET resolution = 'not_applicable', resolution_decision_id = $2, resolved_by = $3, resolved_at = now(),
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND resolution = 'none'`,
    [item.id, decisionId, d.userId],
  );
  return decisionId;
};
