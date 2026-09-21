// Импорт результатов распознавания и чтение доказательств (portal-api §2.4).
// Архив принимается только к уже зарегистрированной редакции: соответствие PDF проверяется
// по SHA-256 в задании, чужой или старый результат не принимается (state-machines §4).
// Превью строит браузер поверх локального оригинала — сервер отдаёт координаты и ссылку
// на GET /document-revisions/{id}/content, а crop_url из экспорта никогда не загружает (A38).
import type { IAppConfig } from '@kontur/config';
import { RecognitionFragmentsQuery } from '@kontur/contracts';
import { classifyFile } from '@kontur/core';
import {
  createRun,
  enqueueJob,
  findRunByArtifact,
  getRevision,
  getRun,
  getScopedFragment,
  getScopedRun,
  insertBlob,
  latestFinishedRun,
  listFragments,
  listPages,
  listRunsForRevision,
  supersededBy,
  type Pool,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { requireCtx } from '../http/context.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { receiveUpload, uploadName, uploadedBlob } from '../http/upload.ts';
import { toEvidence, toFragment, toRun, toRunDetail } from '../recognitionMappers.ts';
import { requireTenderCapById } from './scope.ts';

export const recognitionRouter = (pool: Pool, store: BlobStore, config: IAppConfig): Router => {
  const router = Router();

  router.post(
    '/document-revisions/:id/recognition-imports',
    receiveUpload({
      pool,
      store,
      config,
      action: 'recognition.import.accept',
      entityType: 'recognition_run',
      authorize: async (req) => {
        const ctx = requireCtx(req);
        const id = uuidParam(req, 'id', 'document_revision');
        const rev = await getRevision(pool, ctx, id);
        if (!rev) throw notFound({ entityType: 'document_revision', entityId: id });
        requireTenderCapById(ctx, rev.tender_id, 'source.write', { entityType: 'document_revision', entityId: id });
      },
    }),
    command(pool, {
      action: 'recognition.import.accept',
      entityType: 'recognition_run',
      idempotent: true,
      requestKey: (req) => `recognition ${req.params.id} ${uploadedBlob(req)?.sha256 ?? ''}`,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'document_revision');
        const rev = await getRevision(client, ctx, id);
        if (!rev) throw notFound({ entityType: 'document_revision', entityId: id });
        requireTenderCapById(ctx, rev.tender_id, 'source.write', { entityType: 'document_revision', entityId: id });
      },
      run: async (client, ctx, req) => {
        const stored = uploadedBlob(req);
        if (!stored) throw new HttpError(400, 'VALIDATION_FAILED', 'файл не получен');
        const name = uploadName(req);
        const id = uuidParam(req, 'id', 'document_revision');
        const rev = (await getRevision(client, ctx, id))!;
        const target = { tenderId: rev.tender_id, entityId: id };
        const verdict = classifyFile(name, stored.head, stored.sizeBytes);
        if (verdict.kind !== 'archive') {
          throw new HttpError(400, 'VALIDATION_FAILED', 'экспорт RDWeb принимается ZIP-архивом', {}, target);
        }
        await insertBlob(client, {
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          mediaType: verdict.mediaType,
          storageKey: stored.storageKey,
        });
        // Пара «редакция + архив» уже импортируется или импортирована: второго прогона нет.
        const existing = await findRunByArtifact(client, id, stored.sha256);
        if (existing) {
          return {
            status: 200,
            body: { ...toRun(existing), reused: true },
            audit: [
              {
                action: 'recognition.import.accept',
                entityType: 'recognition_run',
                entityId: existing.id,
                tenderId: rev.tender_id,
                details: { reused: true, documentRevisionId: id, sha256: stored.sha256 },
              },
            ],
          };
        }
        // Новая версия распознавания того же PDF встаёт за прежним прогоном (A10).
        const previous = await latestFinishedRun(client, id);
        const runId = await createRun(client, {
          documentRevisionId: id,
          tenderId: rev.tender_id,
          engine: 'rdweb_export',
          sourceArtifactSha256: stored.sha256,
          sourceArtifactName: name,
          supersedesRunId: previous?.id ?? null,
          createdBy: ctx.principal.userId,
        });
        await enqueueJob(client, {
          kind: 'recognition.import',
          dedupeKey: `recognition:${id}:${stored.sha256}`,
          payload: { runId },
          tenderId: rev.tender_id,
        });
        const created = (await getRun(client, runId))!;
        return {
          status: 202,
          body: { ...toRun(created), reused: false },
          audit: [
            {
              action: 'recognition.import.accept',
              entityType: 'recognition_run',
              entityId: runId,
              tenderId: rev.tender_id,
              details: { documentRevisionId: id, name, sha256: stored.sha256, sizeBytes: stored.sizeBytes, supersedesRunId: previous?.id ?? null },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/document-revisions/:id/recognition-runs',
    query(pool, 'recognition.run.list', 'document_revision', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'document_revision');
      const rev = await getRevision(pool, ctx, id);
      if (!rev) throw notFound({ entityType: 'document_revision', entityId: id });
      res.json({ items: (await listRunsForRevision(pool, id)).map(toRun) });
    }),
  );

  router.get(
    '/recognition-runs/:id',
    query(pool, 'recognition.run.read', 'recognition_run', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'recognition_run');
      const run = await getScopedRun(pool, ctx, id);
      if (!run) throw notFound({ entityType: 'recognition_run', entityId: id });
      res.json(toRunDetail(run, await listPages(pool, id), await supersededBy(pool, id)));
    }),
  );

  router.get(
    '/recognition-runs/:id/fragments',
    query(pool, 'recognition.fragments.read', 'recognition_run', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'recognition_run');
      const run = await getScopedRun(pool, ctx, id);
      if (!run) throw notFound({ entityType: 'recognition_run', entityId: id });
      const q = parseBody(RecognitionFragmentsQuery, req.query);
      const page = await listFragments(pool, id, { pageIndex: q.pageIndex ?? null, cursor: q.cursor ?? null, limit: q.limit });
      res.json({ items: page.items.map(toFragment), nextCursor: page.nextCursor });
    }),
  );

  router.get(
    '/evidence/:id',
    query(pool, 'evidence.read', 'evidence_fragment', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'evidence_fragment');
      const fragment = await getScopedFragment(pool, ctx, id);
      if (!fragment) throw notFound({ entityType: 'evidence_fragment', entityId: id });
      res.json(toEvidence(fragment));
    }),
  );

  return router;
};
