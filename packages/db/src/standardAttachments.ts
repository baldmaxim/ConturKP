// Библиотека стандартных вложений (этап 12; D-032 В-12-4): файл «как есть» с ревизиями; компании (scope NULL) или
// тендера; ведёт тот, кто ведёт шаблоны этого владельца (can_manage_template). Утверждённая ревизия выбирается при
// сборке комплекта; новая утверждённая выводит прежнюю.
import type { Queryable } from './pool.ts';

export interface IStandardAttachmentRevisionRow {
  id: string;
  attachment_id: string;
  scope_tender_id: string | null;
  title: string;
  seq: number;
  blob_sha256: string;
  size_bytes: number;
  file_name: string;
  media_type: string;
  audience: 'customer' | 'internal';
  status: 'draft' | 'approved' | 'retired';
  created_at: Date;
  approved_at: Date | null;
  row_version: number;
}

const SELECT = `SELECT r.id, r.attachment_id, a.scope_tender_id, a.title, r.seq, r.blob_sha256, b.size_bytes, r.file_name, r.media_type, r.audience, r.status,
                       r.created_at, r.approved_at, r.row_version
                  FROM standard_attachment_revision r JOIN standard_attachment a ON a.id = r.attachment_id JOIN blob b ON b.sha256 = r.blob_sha256`;

const norm = (r: IStandardAttachmentRevisionRow): IStandardAttachmentRevisionRow => ({ ...r, size_bytes: Number(r.size_bytes) });

export const createStandardAttachment = async (db: Queryable, a: { scopeTenderId: string | null; title: string; userId: string }): Promise<string> =>
  (await db.query<{ id: string }>('INSERT INTO standard_attachment (scope_tender_id, title, created_by) VALUES ($1, $2, $3) RETURNING id', [a.scopeTenderId, a.title, a.userId])).rows[0]!.id;

export const getStandardAttachment = async (db: Queryable, id: string): Promise<{ id: string; scope_tender_id: string | null; title: string } | null> =>
  (await db.query<{ id: string; scope_tender_id: string | null; title: string }>('SELECT id, scope_tender_id, title FROM standard_attachment WHERE id = $1', [id])).rows[0] ?? null;

export const createStandardAttachmentRevision = async (
  db: Queryable,
  r: { attachmentId: string; blobSha256: string; fileName: string; mediaType: string; audience: 'customer' | 'internal'; userId: string },
): Promise<string> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('standard_attachment_revision'), hashtext($1::text))", [r.attachmentId]);
  return (
    await db.query<{ id: string }>(
      `INSERT INTO standard_attachment_revision (attachment_id, seq, blob_sha256, file_name, media_type, audience, created_by)
       VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM standard_attachment_revision WHERE attachment_id = $1), $2, $3, $4, $5, $6) RETURNING id`,
      [r.attachmentId, r.blobSha256, r.fileName, r.mediaType, r.audience, r.userId],
    )
  ).rows[0]!.id;
};

export const getStandardAttachmentRevision = async (db: Queryable, id: string, lock = false): Promise<IStandardAttachmentRevisionRow | null> => {
  const r = (await db.query<IStandardAttachmentRevisionRow>(`${SELECT} WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0];
  return r ? norm(r) : null;
};

export const approveStandardAttachmentRevision = async (db: Queryable, rev: IStandardAttachmentRevisionRow, userId: string): Promise<void> => {
  await db.query(
    "UPDATE standard_attachment_revision SET status = 'retired', retired_at = now(), row_version = row_version + 1 WHERE attachment_id = $1 AND status = 'approved' AND id <> $2",
    [rev.attachment_id, rev.id],
  );
  await db.query("UPDATE standard_attachment_revision SET status = 'approved', approved_by = $2, approved_at = now(), row_version = row_version + 1 WHERE id = $1", [rev.id, userId]);
};

// Вложения, видимые пользователю: компании и тендеров, где он участник (tenderIds).
export const listStandardAttachmentRevisions = async (db: Queryable, tenderIds: readonly string[]): Promise<IStandardAttachmentRevisionRow[]> =>
  (
    await db.query<IStandardAttachmentRevisionRow>(`${SELECT} WHERE a.scope_tender_id IS NULL OR a.scope_tender_id = ANY($1::uuid[]) ORDER BY a.title, a.id, r.seq DESC`, [[...tenderIds]])
  ).rows.map(norm);
