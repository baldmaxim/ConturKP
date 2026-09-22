// Импорт источников (portal-api §2.3; state-machines §1.1, §3, §3.1).
// Загрузка: тело запроса — сам файл (application/octet-stream), имя — параметр name.
// Поток пишется в хранилище до транзакции (содержимое адресуется хэшем, повтор безопасен);
// партия, событие import_accepted и задание разбора — в одной транзакции команды.
import type { IAppConfig } from '@kontur/config';
import { ResolveImportItemRequest } from '@kontur/contracts';
import { classifyFile, formatEtag } from '@kontur/core';
import {
  createBatch,
  emitStageEvents,
  enqueueJob,
  getBatch,
  getBatchSummary,
  getJob,
  getScopedItem,
  insertBlob,
  listBatches,
  listItems,
  lockTenderStages,
  requestCancel,
  resolveItemNotApplicable,
  resolveItemReimported,
  type IAccessContext,
  type Pool,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { cancelJobDomain } from '../jobs/cancelDomain.ts';
import { receiveUpload, uploadedBlob, uploadName } from '../http/upload.ts';
import { requireCtx } from '../http/context.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { toBatch, toItem } from '../sourceMappers.ts';
import { loadStage } from './stages.ts';
import { hasTenderCap, requireTenderCapById } from './scope.ts';

const batchBody = async (db: Queryable, ctx: IAccessContext, id: string) => {
  const b = await getBatchSummary(db, ctx, id);
  if (!b) throw notFound({ entityType: 'import_batch', entityId: id });
  const items = await listItems(db, id);
  const jobs = await db.query<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM job WHERE (payload->>'batchId' = $1 OR payload->>'itemId' = ANY($2::text[])) GROUP BY status",
    [id, items.map((i) => i.id)],
  );
  return { ...toBatch(b), items: items.map(toItem), jobs: Object.fromEntries(jobs.rows.map((r) => [r.status, r.n])) };
};

export const importsRouter = (pool: Pool, store: BlobStore, config: IAppConfig): Router => {
  const router = Router();

  router.post(
    '/stages/:id/imports',
    // Шаг 1 (права, имя, приём файла) пишет свои отказы в журнал сам; шаг 2 — команда.
    receiveUpload({
      pool,
      store,
      config,
      action: 'source.import.accept',
      entityType: 'import_batch',
      authorize: async (req) => {
        const ctx = requireCtx(req);
        const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
        requireTenderCapById(ctx, stage.tender_id, 'source.write', { entityType: 'tender_stage', entityId: stage.id });
      },
    }),
    command(pool, {
      action: 'source.import.accept',
      entityType: 'import_batch',
      idempotent: true,
      requestKey: (req) => `upload ${req.params.id} ${uploadName(req)} ${uploadedBlob(req)?.sha256 ?? ''}`,
      authorize: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        requireTenderCapById(ctx, stage.tender_id, 'source.write', { entityType: 'tender_stage', entityId: stage.id });
      },
      run: async (client, ctx, req) => {
        const stored = uploadedBlob(req);
        if (!stored) throw new HttpError(400, 'VALIDATION_FAILED', 'файл не получен');
        const name = uploadName(req);
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        const verdict = classifyFile(name, stored.head, stored.sizeBytes);
        await insertBlob(client, {
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          mediaType: verdict.kind === 'rejected' ? 'application/octet-stream' : verdict.mediaType,
          storageKey: stored.storageKey,
        });
        const batchId = await createBatch(client, {
          tenderId: stage.tender_id,
          stageId: stage.id,
          sourceKind: 'upload',
          channelId: null,
          uploadName: name,
          uploadSha: stored.sha256,
          createdBy: ctx.principal.userId,
        });
        // Граница «поступил»: принятие загрузки до разбора (state-machines §1.1).
        await emitStageEvents(client, { tenderId: stage.tender_id, stageIds: [stage.id], eventType: 'import_accepted', refType: 'import_batch', refId: batchId, actorUserId: ctx.principal.userId });
        await enqueueJob(client, { kind: 'import.expand', dedupeKey: `import:${batchId}`, payload: { batchId }, tenderId: stage.tender_id });
        return {
          status: 202,
          body: await batchBody(client, ctx, batchId),
          audit: [
            {
              action: 'source.import.accept',
              entityType: 'import_batch',
              entityId: batchId,
              tenderId: stage.tender_id,
              details: { name, sha256: stored.sha256, sizeBytes: stored.sizeBytes, stageId: stage.id },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/imports',
    query(pool, 'source.import.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      const rows = await listBatches(pool, ctx, stage.tender_id, 100);
      res.json({ items: rows.map(toBatch) });
    }),
  );

  router.get(
    '/imports/:id',
    query(pool, 'source.import.read', 'import_batch', async (ctx, req, res) => {
      res.json(await batchBody(pool, ctx, uuidParam(req, 'id', 'import_batch')));
    }),
  );

  router.post(
    '/import-items/:id/resolve',
    command(pool, {
      action: 'source.import_item.resolve',
      entityType: 'import_item',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'import_item');
        const item = await getScopedItem(client, ctx, id);
        if (!item) throw notFound({ entityType: 'import_item', entityId: id });
        const body = parseBody(ResolveImportItemRequest, req.body);
        // Повторный импорт связывает инженер; неприменимость — решение руководителя (R01-09).
        requireTenderCapById(ctx, item.tender_id, body.resolution === 'not_applicable' ? 'hold.resolve' : 'source.write', { entityType: 'import_item', entityId: id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'import_item');
        const body = parseBody(ResolveImportItemRequest, req.body);
        const probe = await getScopedItem(client, ctx, id);
        if (!probe) throw notFound({ entityType: 'import_item', entityId: id });
        // Блокировка этапов тендера (state-machines §3.1); событий барьера решение не порождает.
        await lockTenderStages(client, probe.tender_id, null);
        const item = (await getScopedItem(client, ctx, id, true))!;
        if (requireIfMatch(req, id) !== item.row_version) throw versionConflict(toItem(item));
        const batch = (await getBatch(client, item.batch_id))!;
        const target = { tenderId: item.tender_id, entityId: id };
        if (batch.status === 'running') throw new HttpError(409, 'STATE_CONFLICT', 'партия ещё обрабатывается', {}, target);
        if (item.status !== 'rejected' && item.status !== 'skipped_partial') {
          throw new HttpError(409, 'STATE_CONFLICT', 'исход задаётся только отклонённому элементу', {}, target);
        }
        if (item.resolution !== 'none') throw new HttpError(409, 'STATE_CONFLICT', 'исход уже задан', {}, target);
        let details: Record<string, unknown>;
        if (body.resolution === 'reimported') {
          const by = await getScopedItem(client, ctx, body.resolvedByItemId);
          if (!by || by.tender_id !== item.tender_id) throw notFound({ entityType: 'import_item', entityId: body.resolvedByItemId, tenderId: item.tender_id });
          if (by.batch_id === item.batch_id || (by.status !== 'registered' && by.status !== 'duplicate')) {
            throw new HttpError(409, 'STATE_CONFLICT', 'повторный импорт — зарегистрированный элемент другой партии', {}, target);
          }
          await resolveItemReimported(client, id, by.id, ctx.principal.userId);
          details = { resolution: 'reimported', resolvedByItemId: by.id, memberPath: item.member_path };
        } else {
          const decisionId = await resolveItemNotApplicable(client, item, { stageId: batch.stage_id, reason: body.reason, userId: ctx.principal.userId });
          details = { resolution: 'not_applicable', decisionId, reason: body.reason, memberPath: item.member_path };
        }
        const after = (await getScopedItem(client, ctx, id))!;
        return {
          status: 200,
          body: toItem(after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'source.import_item.resolve', entityType: 'import_item', entityId: id, tenderId: item.tender_id, details }],
        };
      },
    }),
  );

  router.post(
    '/jobs/:id/cancel',
    command(pool, {
      action: 'job.cancel',
      entityType: 'job',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'job');
        const job = await getJob(client, id);
        if (!job || !job.tender_id || !hasTenderCap(ctx, job.tender_id, 'tender.read')) throw notFound({ entityType: 'job', entityId: id });
        requireTenderCapById(ctx, job.tender_id, 'source.write', { entityType: 'job', entityId: id });
      },
      run: async (client, _ctx, req) => {
        const id = uuidParam(req, 'id', 'job');
        const job = (await getJob(client, id))!;
        const status = await requestCancel(client, id);
        if (!status) throw new HttpError(409, 'STATE_CONFLICT', `задание уже в статусе ${job.status}`, {}, { tenderId: job.tender_id, entityId: id });
        // Задание отменено, не начав выполняться: доменный объект терминализуется здесь же,
        // одной транзакцией, иначе он остался бы активным без задания (R04-02). У running
        // отмену подтверждает worker под действующей арендой.
        if (status === 'cancelled') await cancelJobDomain(client, job);
        return {
          status: 200,
          body: { id, status, cancelRequested: status === 'running' },
          audit: [{ action: 'job.cancel', entityType: 'job', entityId: id, tenderId: job.tender_id, details: { kind: job.kind, status } }],
        };
      },
    }),
  );

  return router;
};
