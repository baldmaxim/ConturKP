// Вопросы–ответы и переговоры тендера (этап 07, D-025: OD-07-6, Q-06). Источник — версионированный
// manifest-файл (kontur.qa.v1, kontur.negotiation.v1): сервис переговоров не подключён (BLOCKED_EXTERNAL),
// поэтому файловый импорт — штатный путь. Импорт — source.write по тендеру, чтение — tender.read.
// Повтор того же файла идемпотентен; изменённый ответ или исправленная транскрипция — новая ревизия.
import { ManifestError, parseNegotiationManifest, parseQaManifest } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import { ManifestImportQuery } from '@kontur/contracts';
import {
  getNegotiationSessionById,
  getStage,
  importNegotiationManifest,
  importQaManifest,
  insertBlob,
  listNegotiationSessions,
  listParticipants,
  listQaItemRevisions,
  listQaThreads,
  listTranscriptRevisions,
  listTranscriptSegments,
  type IAccessContext,
  type Pool,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import type { Request } from 'express';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { requireCtx } from '../http/context.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { receiveUpload, uploadName, uploadedBlob } from '../http/upload.ts';
import { toNegotiationSession, toParticipant, toQaItems, toQaThread, toTranscriptRevision, toTranscriptSegment } from '../mailMappers.ts';
import { hasTenderCap, requireTenderCapById } from './scope.ts';

// manifest — структурированный JSON: больше этого размера он не бывает, читается в память целиком.
const MANIFEST_MAX_BYTES = 20 * 1024 * 1024;

const readStored = async (store: BlobStore, sha256: string): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const chunk of store.openRead(sha256)) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
};

const requireTender = (ctx: IAccessContext, tenderId: string): void => {
  if (!hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
};

const requireStageOf = async (db: Queryable, ctx: IAccessContext, stageId: string | undefined, tenderId: string): Promise<string | null> => {
  if (!stageId) return null;
  const stage = await getStage(db, ctx, stageId);
  if (!stage || stage.tender_id !== tenderId) throw notFound({ entityType: 'tender_stage', entityId: stageId });
  return stage.id;
};

type ManifestKind = 'qa' | 'negotiation';

export const communicationsRouter = (pool: Pool, store: BlobStore, config: IAppConfig): Router => {
  const router = Router();

  const uploadAuthorize = async (req: Request): Promise<void> => {
    const ctx = requireCtx(req);
    const tenderId = uuidParam(req, 'id', 'tender');
    requireTender(ctx, tenderId);
    requireTenderCapById(ctx, tenderId, 'source.write', { entityType: 'tender', entityId: tenderId });
  };

  // Общий шаг двух импортов: файл принят хранилищем, в транзакции — права, разбор manifest (отказ —
  // 400 с причиной, без записи), blob и идемпотентная запись по SHA-256 файла в тендере.
  const manifestImport = (kind: ManifestKind) =>
    command(pool, {
      action: kind === 'qa' ? 'qa.import' : 'negotiation.import',
      entityType: 'tender',
      idempotent: true,
      requestKey: (req) => `${kind}-import ${req.params.id} ${uploadedBlob(req)?.sha256 ?? ''} ${JSON.stringify(req.query)}`,
      authorize: async (_client, ctx, req) => {
        const tenderId = uuidParam(req, 'id', 'tender');
        requireTender(ctx, tenderId);
        requireTenderCapById(ctx, tenderId, 'source.write', { entityType: 'tender', entityId: tenderId });
      },
      run: async (client, ctx, req) => {
        const tenderId = uuidParam(req, 'id', 'tender');
        const q = parseBody(ManifestImportQuery, req.query);
        const stored = uploadedBlob(req);
        if (!stored) throw new HttpError(400, 'VALIDATION_FAILED', 'файл не получен');
        uploadName(req);
        await client.query('SELECT 1 FROM tender WHERE id = $1 FOR UPDATE', [tenderId]);
        const stageId = await requireStageOf(client, ctx, q.stageId, tenderId);
        const target = { tenderId, entityType: 'tender', entityId: tenderId };
        if (stored.sizeBytes > MANIFEST_MAX_BYTES) throw new HttpError(413, 'VALIDATION_FAILED', 'manifest больше 20 МиБ', {}, target);
        const bytes = await readStored(store, stored.sha256);
        let parsed;
        try {
          parsed = kind === 'qa' ? parseQaManifest(bytes) : parseNegotiationManifest(bytes);
        } catch (err) {
          if (err instanceof ManifestError) throw new HttpError(400, 'VALIDATION_FAILED', err.message, { current: { reason: err.code } }, target);
          throw err;
        }
        await insertBlob(client, { sha256: stored.sha256, sizeBytes: stored.sizeBytes, mediaType: 'application/json', storageKey: stored.storageKey });
        if (kind === 'qa') {
          const r = await importQaManifest(client, {
            tenderId,
            stageId,
            manifestSha256: stored.sha256,
            manifest: parsed as Parameters<typeof importQaManifest>[1]['manifest'],
            userId: ctx.principal.userId,
          });
          return {
            status: r.reused ? 200 : 201,
            body: { importId: r.importId, reused: r.reused, threads: r.threads, newRevisions: r.newRevisions },
            audit: [
              {
                action: 'qa.import',
                entityType: 'qa_import',
                entityId: r.importId,
                tenderId,
                details: { sha256: stored.sha256, reused: r.reused, threads: r.threads, newRevisions: r.newRevisions },
              },
            ],
          };
        }
        const r = await importNegotiationManifest(client, {
          tenderId,
          stageId,
          manifestSha256: stored.sha256,
          manifest: parsed as Parameters<typeof importNegotiationManifest>[1]['manifest'],
          userId: ctx.principal.userId,
        });
        return {
          status: r.reused ? 200 : 201,
          body: { importId: r.importId, reused: r.reused, sessionId: r.sessionId, revisionId: r.revisionId, createdRevision: r.createdRevision },
          audit: [
            {
              action: 'negotiation.import',
              entityType: 'negotiation_import',
              entityId: r.importId,
              tenderId,
              details: { sha256: stored.sha256, reused: r.reused, sessionId: r.sessionId, createdRevision: r.createdRevision },
            },
          ],
        };
      },
    });

  router.post(
    '/tenders/:id/qa-imports',
    receiveUpload({ pool, store, config, action: 'qa.import', entityType: 'tender', authorize: uploadAuthorize }),
    manifestImport('qa'),
  );

  router.post(
    '/tenders/:id/negotiation-imports',
    receiveUpload({ pool, store, config, action: 'negotiation.import', entityType: 'tender', authorize: uploadAuthorize }),
    manifestImport('negotiation'),
  );

  // ---------------------------------------------------------------- Вопросы–ответы

  router.get(
    '/tenders/:id/qa-threads',
    query(pool, 'qa.thread.list', 'tender', async (ctx, req, res) => {
      const tenderId = uuidParam(req, 'id', 'tender');
      requireTender(ctx, tenderId);
      res.json({ items: (await listQaThreads(pool, tenderId)).map(toQaThread) });
    }),
  );

  router.get(
    '/qa-threads/:id',
    query(pool, 'qa.thread.read', 'qa_thread', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'qa_thread');
      const t = (await pool.query<{ tender_id: string }>('SELECT tender_id FROM qa_thread WHERE id = $1', [id])).rows[0];
      if (!t || !hasTenderCap(ctx, t.tender_id, 'tender.read')) throw notFound({ entityType: 'qa_thread', entityId: id });
      const thread = (await listQaThreads(pool, t.tender_id)).find((x) => x.id === id)!;
      res.json({ ...toQaThread(thread), questions: toQaItems(await listQaItemRevisions(pool, id)) });
    }),
  );

  // ---------------------------------------------------------------- Переговоры

  router.get(
    '/tenders/:id/negotiation-sessions',
    query(pool, 'negotiation.session.list', 'tender', async (ctx, req, res) => {
      const tenderId = uuidParam(req, 'id', 'tender');
      requireTender(ctx, tenderId);
      res.json({ items: (await listNegotiationSessions(pool, tenderId)).map(toNegotiationSession) });
    }),
  );

  // Сессия: участники, редакции транскрипции и сегменты выбранной редакции (по умолчанию последней).
  router.get(
    '/negotiation-sessions/:id',
    query(pool, 'negotiation.session.read', 'negotiation_session', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'negotiation_session');
      const s = await getNegotiationSessionById(pool, id);
      if (!s || !hasTenderCap(ctx, s.tender_id, 'tender.read')) throw notFound({ entityType: 'negotiation_session', entityId: id });
      const revisions = await listTranscriptRevisions(pool, id);
      const wanted = typeof req.query.revisionId === 'string' ? req.query.revisionId : s.latest_revision_id;
      const revision = revisions.find((r) => r.id === wanted);
      if (wanted && !revision) throw notFound({ entityType: 'transcript_revision', entityId: String(wanted) });
      res.json({
        ...toNegotiationSession(s),
        participants: (await listParticipants(pool, id)).map(toParticipant),
        revisionList: revisions.map(toTranscriptRevision),
        revision: revision ? toTranscriptRevision(revision) : null,
        segments: revision ? (await listTranscriptSegments(pool, revision.id)).map(toTranscriptSegment) : [],
      });
    }),
  );

  return router;
};
