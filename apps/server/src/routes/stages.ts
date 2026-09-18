// Этапы тендера (portal-api §2.2). Содержимое тендера — только участникам (ADR-006).
import { CreateStageRequest, PatchStageRequest } from '@kontur/contracts';
import { formatEtag, tenderCapabilities } from '@kontur/core';
import { getStage, insertStage, listStages, memberRoleOf, updateStage, type IAccessContext, type IStageRow, type Pool, type Queryable } from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, notFound } from '../http/errors.ts';
import { toStage } from '../mappers.ts';
import { loadTender, requireTenderCap } from './tenders.ts';

const loadStage = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IStageRow> => {
  const s = await getStage(db, ctx, id, lock);
  if (!s) throw notFound({ entityType: 'tender_stage', entityId: id });
  return s;
};

const requireStageWrite = (ctx: IAccessContext, s: IStageRow): void => {
  if (!tenderCapabilities(ctx.roles, memberRoleOf(ctx, s.tender_id)).includes('stage.write')) {
    throw forbidden('stage.write', { entityType: 'tender_stage', entityId: s.id, tenderId: s.tender_id });
  }
};

const toDate = (value: string | null | undefined): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(value);

export const stagesRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/tenders/:id/stages',
    query(pool, 'stage.list', 'tender', async (ctx, req, res) => {
      const t = await loadTender(pool, ctx, uuidParam(req, 'id', 'tender'));
      requireTenderCap(ctx, t, 'tender.read');
      const rows = await listStages(pool, ctx, t.id);
      res.json({ items: rows.map(toStage) });
    }),
  );

  router.post(
    '/tenders/:id/stages',
    command(pool, {
      action: 'stage.create',
      entityType: 'tender_stage',
      idempotent: true,
      authorize: async (client, ctx, req) => requireTenderCap(ctx, await loadTender(client, ctx, uuidParam(req, 'id', 'tender')), 'stage.manage'),
      run: async (client, ctx, req) => {
        // Порядок блокировок: тендер → этап (state-machines §1.2); номер этапа выдаётся под блокировкой тендера.
        const t = await loadTender(client, ctx, uuidParam(req, 'id', 'tender'), true);
        requireTenderCap(ctx, t, 'stage.manage');
        const body = parseBody(CreateStageRequest, req.body);
        const id = await insertStage(client, ctx, t.id, {
          title: body.title,
          submissionDeadline: toDate(body.submissionDeadline) ?? null,
        });
        const s = await loadStage(client, ctx, id);
        return {
          status: 201,
          body: toStage(s),
          etag: formatEtag(s.id, s.row_version),
          audit: [{ action: 'stage.create', entityType: 'tender_stage', entityId: s.id, tenderId: t.id, details: { seq: s.seq, title: s.title } }],
        };
      },
    }),
  );

  router.get(
    '/stages/:id',
    query(pool, 'stage.read', 'tender_stage', async (ctx, req, res) => {
      const s = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      res.setHeader('ETag', formatEtag(s.id, s.row_version));
      res.json(toStage(s));
    }),
  );

  router.patch(
    '/stages/:id',
    command(pool, {
      action: 'stage.update',
      entityType: 'tender_stage',
      authorize: async (client, ctx, req) => requireStageWrite(ctx, await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'))),
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'tender_stage');
        const s = await loadStage(client, ctx, id, true);
        requireStageWrite(ctx, s);
        if (requireIfMatch(req, id) !== s.row_version) throw versionConflict(toStage(s));
        const body = parseBody(PatchStageRequest, req.body);
        await updateStage(client, ctx, id, { title: body.title, submissionDeadline: toDate(body.submissionDeadline) });
        const after = await loadStage(client, ctx, id);
        const before = toStage(s);
        const next = toStage(after);
        const diff: Record<string, unknown> = {};
        for (const key of ['title', 'submissionDeadline'] as const) {
          if (before[key] !== next[key]) diff[key] = { from: before[key], to: next[key] };
        }
        return {
          status: 200,
          body: next,
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'stage.update', entityType: 'tender_stage', entityId: id, tenderId: s.tender_id, details: { changes: diff } }],
        };
      },
    }),
  );

  return router;
};
