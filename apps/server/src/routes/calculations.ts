// Расчёт TenderHub (portal-api §2.5, state-machines §6, ADR-007 §5–8). Сервер во внешние системы не
// ходит: команда ставит выгрузку и задание, читает TenderHub worker. Ревизии неизменяемы; итог КП не
// выводится (Q-05); боевой выпуск с provisional-ревизией блокируется (CALCULATION_PROVISIONAL).
import type { IAppConfig } from '@kontur/config';
import { formatEtag, parseIfMatch } from '@kontur/core';
import {
  AppendLineageRequest,
  CalculationLinesQuery,
  CalculationPositionsQuery,
  CreateCalculationCaptureRequest,
  PutCalculationSourceRequest,
} from '@kontur/contracts';
import {
  activeCapture,
  appendLineageDecisions,
  getCalculationRevision,
  getCaptureInScope,
  listCalculationRevisions,
  listCalculationSources,
  listCaptures,
  listLineage,
  lockTenderStages,
  primaryCalculationSource,
  requestCapture,
  revisionLines,
  revisionPositions,
  setPrimaryCalculationSource,
  tenderHubStatus,
  type IAccessContext,
  type Pool,
  type Queryable,
} from '@kontur/db';
import { Router, type Request } from 'express';
import {
  calculationSourcesEtag,
  toCalculationSource,
  toCapture,
  toIntegration,
  toLine,
  toLineage,
  toPosition,
  toRevision,
} from '../calculationMappers.ts';
import { command, parseBody, query, uuidParam, versionConflict } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { requireTenderCapById } from './scope.ts';
import { loadStage } from './stages.ts';

const CAPTURE_LIST_LIMIT = 50;

// If-Match для производной версии (набор связей этапа, lineage ревизии): формат "<id>:<n>".
const requireDerivedIfMatch = (req: Request, id: string): number => {
  const parsed = parseIfMatch(req.header('if-match'));
  if (parsed.kind === 'missing') throw new HttpError(428, 'PRECONDITION_REQUIRED', 'изменение требует заголовка If-Match');
  if (parsed.kind === 'invalid' || parsed.id !== id) throw new HttpError(412, 'VERSION_CONFLICT', 'If-Match не относится к этому объекту');
  return parsed.rowVersion;
};

const loadRevision = async (db: Queryable, ctx: IAccessContext, id: string) => {
  const r = await getCalculationRevision(db, ctx, id);
  if (!r) throw notFound({ entityType: 'calculation_revision', entityId: id });
  requireTenderCapById(ctx, r.tender_id, 'tender.read', { entityType: 'calculation_revision', entityId: id });
  return r;
};

const sourcesView = async (db: Queryable, stageId: string) => {
  const rows = await listCalculationSources(db, stageId);
  const primary = rows.find((r) => r.role === 'primary') ?? null;
  return {
    etag: calculationSourcesEtag(stageId, rows),
    body: {
      // Версия набора связей для If-Match: "<stageId>:<version>".
      version: rows.reduce((sum, r) => sum + r.row_version, 0),
      primary: primary ? toCalculationSource(primary) : null,
      references: rows.filter((r) => r.role === 'reference').map(toCalculationSource),
      integration: toIntegration(await tenderHubStatus(db)),
    },
  };
};

export const calculationsRouter = (pool: Pool, config: IAppConfig): Router => {
  const router = Router();

  router.get(
    '/stages/:id/calculation-source',
    query(pool, 'calculation.source.read', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      requireTenderCapById(ctx, stage.tender_id, 'tender.read', { entityType: 'tender_stage', entityId: stage.id });
      const v = await sourcesView(pool, stage.id);
      res.setHeader('ETag', v.etag);
      res.json(v.body);
    }),
  );

  // Связь этапа с тендером TenderHub (Q-03): прежняя основная связь с другим тендером остаётся справочной.
  router.put(
    '/stages/:id/calculation-source',
    command(pool, {
      action: 'calculation.source.set',
      entityType: 'tender_stage',
      authorize: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        requireTenderCapById(ctx, stage.tender_id, 'admin.tender', { entityType: 'tender_stage', entityId: stage.id });
      },
      run: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'), true);
        const target = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        const before = await listCalculationSources(client, stage.id);
        const version = requireDerivedIfMatch(req, stage.id);
        if (version !== before.reduce((sum, r) => sum + r.row_version, 0)) throw versionConflict((await sourcesView(client, stage.id)).body);
        const body = parseBody(PutCalculationSourceRequest, req.body);
        if (stage.status !== 'active') throw new HttpError(409, 'STATE_CONFLICT', 'этап в архиве', {}, target);
        const r = await setPrimaryCalculationSource(client, {
          stageId: stage.id,
          tenderId: stage.tender_id,
          externalTenderId: body.externalTenderId,
          externalVersion: body.externalVersion ?? null,
          userId: ctx.principal.userId,
        });
        const v = await sourcesView(client, stage.id);
        return {
          status: 200,
          body: v.body,
          etag: v.etag,
          audit: r.changed
            ? [
                {
                  action: 'calculation.source.set',
                  entityType: 'tender_stage',
                  entityId: stage.id,
                  tenderId: stage.tender_id,
                  details: { system: 'tenderhub', externalTenderId: body.externalTenderId.toLowerCase(), externalVersion: body.externalVersion ?? null },
                },
              ]
            : [],
        };
      },
    }),
  );

  // Запрос выгрузки: выгрузка и задание — одной транзакцией; читает TenderHub worker (state-machines §6).
  router.post(
    '/stages/:id/calculation-captures',
    command(pool, {
      action: 'calculation.capture.request',
      entityType: 'calculation_capture',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        requireTenderCapById(ctx, stage.tender_id, 'calculation.capture', { entityType: 'tender_stage', entityId: stage.id });
      },
      run: async (client, ctx, req) => {
        parseBody(CreateCalculationCaptureRequest, req.body);
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'), true);
        const target = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        if (stage.status !== 'active') throw new HttpError(409, 'STATE_CONFLICT', 'этап в архиве', {}, target);
        const source = await primaryCalculationSource(client, stage.id);
        if (!source) {
          throw new HttpError(409, 'STATE_CONFLICT', 'этап не связан с тендером TenderHub', { current: { reason: 'no_calculation_source' } }, target);
        }
        const active = await activeCapture(client, stage.id, source.external_tender_id);
        if (active) {
          throw new HttpError(409, 'STATE_CONFLICT', 'выгрузка уже идёт', { current: { reason: 'capture_in_progress', captureId: active.id } }, target);
        }
        const capture = await requestCapture(client, {
          stageId: stage.id,
          tenderId: stage.tender_id,
          source,
          trigger: 'manual',
          requestedBy: ctx.principal.userId,
          deadlineBasis: null,
          maxAttempts: config.tenderhub.captureAttempts,
        });
        return {
          status: 202,
          body: toCapture(capture),
          audit: [
            {
              action: 'calculation.capture.request',
              entityType: 'calculation_capture',
              entityId: capture.id,
              tenderId: stage.tender_id,
              details: { stageId: stage.id, externalTenderId: source.external_tender_id },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/calculation-captures',
    query(pool, 'calculation.capture.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      requireTenderCapById(ctx, stage.tender_id, 'tender.read', { entityType: 'tender_stage', entityId: stage.id });
      res.json({ items: (await listCaptures(pool, stage.id, CAPTURE_LIST_LIMIT)).map(toCapture) });
    }),
  );

  router.get(
    '/calculation-captures/:id',
    query(pool, 'calculation.capture.read', 'calculation_capture', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'calculation_capture');
      const c = await getCaptureInScope(pool, ctx, id);
      if (!c) throw notFound({ entityType: 'calculation_capture', entityId: id });
      requireTenderCapById(ctx, c.tender_id, 'tender.read', { entityType: 'calculation_capture', entityId: id });
      res.json(toCapture(c));
    }),
  );

  router.get(
    '/stages/:id/calculation-revisions',
    query(pool, 'calculation.revision.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      requireTenderCapById(ctx, stage.tender_id, 'tender.read', { entityType: 'tender_stage', entityId: stage.id });
      res.json({ items: (await listCalculationRevisions(pool, stage.id)).map(toRevision) });
    }),
  );

  router.get(
    '/calculation-revisions/:id',
    query(pool, 'calculation.revision.read', 'calculation_revision', async (ctx, req, res) => {
      res.json(toRevision(await loadRevision(pool, ctx, uuidParam(req, 'id', 'calculation_revision'))));
    }),
  );

  router.get(
    '/calculation-revisions/:id/positions',
    query(pool, 'calculation.revision.read', 'calculation_revision', async (ctx, req, res) => {
      const rev = await loadRevision(pool, ctx, uuidParam(req, 'id', 'calculation_revision'));
      const q = parseBody(CalculationPositionsQuery, req.query);
      const after = q.cursor ? { positionNumber: q.cursor.slice(0, q.cursor.lastIndexOf(':')), id: q.cursor.slice(q.cursor.lastIndexOf(':') + 1) } : null;
      const rows = await revisionPositions(pool, rev.content_id, { after, limit: q.limit + 1 });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const hasMore = rows.length > q.limit;
      res.json({
        items: page.map((p) => toPosition(rev.id, p)),
        hasMore,
        nextCursor: hasMore && last ? `${last.position_number}:${last.external_position_id}` : null,
      });
    }),
  );

  router.get(
    '/calculation-revisions/:id/lines',
    query(pool, 'calculation.revision.read', 'calculation_revision', async (ctx, req, res) => {
      const rev = await loadRevision(pool, ctx, uuidParam(req, 'id', 'calculation_revision'));
      const q = parseBody(CalculationLinesQuery, req.query);
      const parts = q.cursor?.split(':') ?? null;
      const after = parts ? { positionId: parts[0]!, order: Number(parts[1]), id: parts[2]! } : null;
      const rows = await revisionLines(pool, rev.content_id, { positionId: q.positionId ?? null, after, limit: q.limit + 1 });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const hasMore = rows.length > q.limit;
      res.json({
        items: page.map((l) => toLine(rev.id, l)),
        hasMore,
        nextCursor: hasMore && last ? `${last.external_position_id}:${last.order_key}:${last.external_item_id}` : null,
      });
    }),
  );

  router.get(
    '/calculation-revisions/:id/lineage',
    query(pool, 'calculation.lineage.read', 'calculation_revision', async (ctx, req, res) => {
      const rev = await loadRevision(pool, ctx, uuidParam(req, 'id', 'calculation_revision'));
      const rows = await listLineage(pool, rev.id);
      res.setHeader('ETag', formatEtag(rev.id, rows.length));
      res.json({ version: rows.length, items: rows.map(toLineage) });
    }),
  );

  // Решения человека по сопоставлению позиций (append-only). If-Match — число записей lineage ревизии:
  // параллельная запись другого пользователя даёт 412, а не молчаливое смешение решений (I13).
  router.post(
    '/calculation-revisions/:id/lineage',
    command(pool, {
      action: 'calculation.lineage.append',
      entityType: 'calculation_revision',
      authorize: async (client, ctx, req) => {
        const rev = await loadRevision(client, ctx, uuidParam(req, 'id', 'calculation_revision'));
        requireTenderCapById(ctx, rev.tender_id, 'calculation.capture', { entityType: 'calculation_revision', entityId: rev.id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'calculation_revision');
        const rev = await loadRevision(client, ctx, id);
        // Решения по ревизии сериализуются строкой этапа (ревизия неизменна и роли приложения не блокируется).
        await lockTenderStages(client, rev.tender_id, [rev.stage_id]);
        const current = await listLineage(client, id);
        if (requireDerivedIfMatch(req, id) !== current.length) throw versionConflict({ items: current.map(toLineage) });
        const body = parseBody(AppendLineageRequest, req.body);
        const from = await getCalculationRevision(client, ctx, body.fromRevisionId);
        if (!from || from.tender_id !== rev.tender_id || from.id === rev.id) {
          throw new HttpError(400, 'VALIDATION_FAILED', 'ревизия-источник должна быть другой ревизией того же тендера');
        }
        await appendLineageDecisions(client, {
          tenderId: rev.tender_id,
          fromRevisionId: from.id,
          toRevisionId: rev.id,
          userId: ctx.principal.userId,
          links: body.links,
        });
        const rows = await listLineage(client, id);
        return {
          status: 201,
          body: { version: rows.length, items: rows.map(toLineage) },
          etag: formatEtag(id, rows.length),
          audit: [
            {
              action: 'calculation.lineage.append',
              entityType: 'calculation_revision',
              entityId: id,
              tenderId: rev.tender_id,
              details: { fromRevisionId: from.id, links: body.links.length },
            },
          ],
        };
      },
    }),
  );

  return router;
};
