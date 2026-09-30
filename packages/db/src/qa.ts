// Вопросы–ответы (этап 07, D-025: OD-07-6): структурированная сущность тендера — тред → вопрос с
// устойчивым номером → неизменяемые ревизии. Импорт версионированного manifest: повтор того же файла
// подряд идемпотентен, неизменённый вопрос ревизии не получает, возврат к прежнему содержанию
// (A → B → A, в том числе тем же файлом) — новая ревизия. Новые ревизии — событие барьера qa_form_added (state-machines §1.1).
import { sha256Hex } from '@kontur/core';
import type { Queryable } from './pool.ts';
import { emitStageEvents } from './stageEvents.ts';

export interface IQaItemInput {
  no: string;
  question: string;
  answer: string | null;
  status: 'open' | 'answered' | 'withdrawn';
  askedAt: string | null;
  answeredAt: string | null;
  externalRef: string | null;
}

export interface IQaManifestInput {
  format: string;
  threads: { externalRef: string; title: string | null; items: IQaItemInput[] }[];
}

// Содержание ревизии — канонический JSON значимых полей (порядок ключей фиксирован).
const contentHash = (i: IQaItemInput): string =>
  sha256Hex(JSON.stringify([i.question, i.answer, i.status, i.askedAt, i.answeredAt, i.externalRef]));

export interface IQaImportResult {
  importId: string;
  reused: boolean;
  threads: number;
  newRevisions: number;
}

export const importQaManifest = async (
  db: Queryable,
  q: { tenderId: string; stageId: string | null; manifestSha256: string; manifest: IQaManifestInput; userId: string },
): Promise<IQaImportResult> => {
  // Номер импорта и сравнение с последним — под блокировкой тендера для импортов этого вида.
  await db.query("SELECT pg_advisory_xact_lock(hashtext('qa_import'), hashtext($1::text))", [q.tenderId]);
  const last = await db.query<{ id: string; seq: number; manifest_blob_sha256: string }>(
    'SELECT id, seq, manifest_blob_sha256 FROM qa_import WHERE tender_id = $1 ORDER BY seq DESC LIMIT 1',
    [q.tenderId],
  );
  if (last.rows[0]?.manifest_blob_sha256 === q.manifestSha256) {
    return { importId: last.rows[0].id, reused: true, threads: q.manifest.threads.length, newRevisions: 0 };
  }
  const ins = await db.query<{ id: string }>(
    `INSERT INTO qa_import (tender_id, seq, manifest_blob_sha256, format_version, imported_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [q.tenderId, (last.rows[0]?.seq ?? 0) + 1, q.manifestSha256, q.manifest.format, q.userId],
  );
  const importId = ins.rows[0]!.id;
  let newRevisions = 0;
  for (const t of q.manifest.threads) {
    await db.query(
      `INSERT INTO qa_thread (tender_id, stage_id, external_ref, title, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tender_id, external_ref) DO NOTHING`,
      [q.tenderId, q.stageId, t.externalRef, t.title, q.userId],
    );
    const thread = await db.query<{ id: string }>('SELECT id FROM qa_thread WHERE tender_id = $1 AND external_ref = $2', [q.tenderId, t.externalRef]);
    const threadId = thread.rows[0]!.id;
    for (const i of t.items) {
      await db.query('INSERT INTO qa_item (thread_id, tender_id, item_no) VALUES ($1, $2, $3) ON CONFLICT (thread_id, item_no) DO NOTHING', [
        threadId,
        q.tenderId,
        i.no,
      ]);
      const item = await db.query<{ id: string }>('SELECT id FROM qa_item WHERE thread_id = $1 AND item_no = $2', [threadId, i.no]);
      const itemId = item.rows[0]!.id;
      // История вопроса сериализуется той же advisory-блокировкой, что берёт охранник ревизии (0017).
      await db.query("SELECT pg_advisory_xact_lock(hashtext('qa_item_revision'), hashtext($1::text))", [itemId]);
      const last = await db.query<{ id: string; seq: number; content_sha256: string }>(
        'SELECT id, seq, content_sha256 FROM qa_item_revision WHERE item_id = $1 ORDER BY seq DESC LIMIT 1',
        [itemId],
      );
      const hash = contentHash(i);
      if (last.rows[0]?.content_sha256 === hash) continue;
      await db.query(
        `INSERT INTO qa_item_revision (item_id, tender_id, seq, question, answer, status, asked_at, answered_at, external_ref, import_id,
                                       content_sha256, supersedes_revision_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          itemId,
          q.tenderId,
          (last.rows[0]?.seq ?? 0) + 1,
          i.question,
          i.answer,
          i.status,
          i.askedAt,
          i.answeredAt,
          i.externalRef,
          importId,
          hash,
          last.rows[0]?.id ?? null,
        ],
      );
      newRevisions += 1;
    }
  }
  if (newRevisions > 0) {
    await emitStageEvents(db, {
      tenderId: q.tenderId,
      stageIds: q.stageId ? [q.stageId] : null,
      eventType: 'qa_form_added',
      refType: 'qa_import',
      refId: importId,
      actorUserId: q.userId,
    });
  }
  return { importId, reused: false, threads: q.manifest.threads.length, newRevisions };
};

export interface IQaThreadRow {
  id: string;
  tender_id: string;
  stage_id: string | null;
  external_ref: string;
  title: string | null;
  created_at: Date;
  items: number;
  open_items: number;
}

export const listQaThreads = async (db: Queryable, tenderId: string): Promise<IQaThreadRow[]> => {
  const r = await db.query<IQaThreadRow>(
    `SELECT t.*, (SELECT count(*)::int FROM qa_item i WHERE i.thread_id = t.id) AS items,
            (SELECT count(*)::int FROM qa_item i
               JOIN LATERAL (SELECT r.status FROM qa_item_revision r WHERE r.item_id = i.id ORDER BY r.seq DESC LIMIT 1) lr ON true
              WHERE i.thread_id = t.id AND lr.status = 'open') AS open_items
       FROM qa_thread t WHERE t.tender_id = $1 ORDER BY t.created_at, t.id`,
    [tenderId],
  );
  return r.rows;
};

export const getQaThread = async (db: Queryable, tenderId: string, id: string): Promise<IQaThreadRow | null> => {
  const r = await db.query<IQaThreadRow>(
    `SELECT t.*, 0 AS items, 0 AS open_items FROM qa_thread t WHERE t.id = $1 AND t.tender_id = $2`,
    [id, tenderId],
  );
  return r.rows[0] ?? null;
};

export interface IQaItemRevisionRow {
  id: string;
  item_id: string;
  item_no: string;
  seq: number;
  question: string;
  answer: string | null;
  status: 'open' | 'answered' | 'withdrawn';
  asked_at: Date | null;
  answered_at: Date | null;
  external_ref: string | null;
  import_id: string;
  created_at: Date;
}

// Все ревизии вопросов треда, новые сверху внутри вопроса; вопросы — в порядке номеров.
export const listQaItemRevisions = async (db: Queryable, threadId: string): Promise<IQaItemRevisionRow[]> => {
  const r = await db.query<IQaItemRevisionRow>(
    `SELECT r.id, r.item_id, i.item_no, r.seq, r.question, r.answer, r.status, r.asked_at, r.answered_at, r.external_ref, r.import_id, r.created_at
       FROM qa_item i JOIN qa_item_revision r ON r.item_id = i.id
      WHERE i.thread_id = $1
      ORDER BY i.item_no COLLATE "C", r.seq DESC`,
    [threadId],
  );
  return r.rows;
};
