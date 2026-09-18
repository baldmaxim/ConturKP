// Каналы поступления — наблюдаемые папки (portal-api §2.1; state-machines §1.1).
// Создаёт и настраивает администратор; отключить с причиной может и руководитель тендера.
// Папка допускается только внутри INTAKE_ROOTS; при каждом скане это же проверяется по realpath.
import { isAbsolute, resolve, sep } from 'node:path';
import type { IAppConfig } from '@kontur/config';
import { CreateChannelRequest, PatchChannelRequest } from '@kontur/contracts';
import { formatEtag, globalCapabilities } from '@kontur/core';
import { enqueueJob, getChannel, insertChannel, listChannels, markScanStarted, updateChannel, type IAccessContext, type Pool } from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { toChannel } from '../sourceMappers.ts';
import { hasTenderCap } from './scope.ts';
import { loadTender } from './tenders.ts';

const insideRoots = (locator: string, roots: string[]): boolean => {
  if (!isAbsolute(locator)) return false;
  const p = resolve(locator).toLowerCase();
  return roots.some((r) => {
    const root = resolve(r).toLowerCase();
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
};

const isAdmin = (ctx: IAccessContext): boolean => globalCapabilities(ctx.roles).includes('admin.intake');

export const intakeRouter = (pool: Pool, config: IAppConfig, clock: () => Date): Router => {
  const router = Router();

  const checkLocator = (locator: string): void => {
    if (!insideRoots(locator, config.intakeRoots)) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'папка должна быть абсолютным путём внутри разрешённых корней INTAKE_ROOTS');
    }
  };

  router.get(
    '/tenders/:id/intake-channels',
    query(pool, 'intake.channel.list', 'tender', async (ctx, req, res) => {
      const t = await loadTender(pool, ctx, uuidParam(req, 'id', 'tender'));
      const now = clock();
      res.json({ items: (await listChannels(pool, t.id)).map((c) => toChannel(c, now)) });
    }),
  );

  router.post(
    '/tenders/:id/intake-channels',
    command(pool, {
      action: 'intake.channel.create',
      entityType: 'intake_channel',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        await loadTender(client, ctx, uuidParam(req, 'id', 'tender'));
        if (!isAdmin(ctx)) throw forbidden('admin.intake', { entityType: 'intake_channel' });
      },
      run: async (client, ctx, req) => {
        const t = await loadTender(client, ctx, uuidParam(req, 'id', 'tender'));
        const body = parseBody(CreateChannelRequest, req.body);
        checkLocator(body.locator);
        const id = await insertChannel(client, {
          tenderId: t.id,
          origin: body.origin,
          locator: resolve(body.locator),
          freshnessSeconds: body.freshnessSeconds,
          scanIntervalSeconds: body.scanIntervalSeconds,
          createdBy: ctx.principal.userId,
        });
        const c = (await getChannel(client, id))!;
        return {
          status: 201,
          body: toChannel(c, clock()),
          etag: formatEtag(id, c.row_version),
          audit: [{ action: 'intake.channel.create', entityType: 'intake_channel', entityId: id, tenderId: t.id, details: { origin: c.origin, locator: c.locator } }],
        };
      },
    }),
  );

  router.patch(
    '/intake-channels/:id',
    command(pool, {
      action: 'intake.channel.update',
      entityType: 'intake_channel',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'intake_channel');
        const c = await getChannel(client, id);
        if (!c || !(hasTenderCap(ctx, c.tender_id, 'tender.read') || isAdmin(ctx))) throw notFound({ entityType: 'intake_channel', entityId: id });
        const body = parseBody(PatchChannelRequest, req.body);
        const onlyDisable = Object.keys(body).every((k) => k === 'active' || k === 'disabledReason') && body.active === false;
        if (!isAdmin(ctx) && !(onlyDisable && hasTenderCap(ctx, c.tender_id, 'hold.resolve'))) {
          throw forbidden('admin.intake', { entityType: 'intake_channel', entityId: id, tenderId: c.tender_id });
        }
      },
      run: async (client, _ctx, req) => {
        const id = uuidParam(req, 'id', 'intake_channel');
        const c = (await getChannel(client, id, true))!;
        if (requireIfMatch(req, id) !== c.row_version) throw versionConflict(toChannel(c, clock()));
        const body = parseBody(PatchChannelRequest, req.body);
        if (body.active === false && !body.disabledReason) {
          throw new HttpError(400, 'VALIDATION_FAILED', 'отключение канала требует причины (disabledReason)');
        }
        if (body.locator !== undefined) checkLocator(body.locator);
        await updateChannel(client, id, { ...body, locator: body.locator === undefined ? undefined : resolve(body.locator) });
        const after = (await getChannel(client, id))!;
        const changes: Record<string, unknown> = {};
        for (const k of ['origin', 'locator', 'active', 'disabled_reason', 'scan_interval_seconds', 'freshness_seconds'] as const) {
          if (c[k] !== after[k]) changes[k] = { from: c[k], to: after[k] };
        }
        return {
          status: 200,
          body: toChannel(after, clock()),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'intake.channel.update', entityType: 'intake_channel', entityId: id, tenderId: c.tender_id, details: { changes } }],
        };
      },
    }),
  );

  // «Сканировать сейчас»: ставит задание скана (одно активное на канал).
  router.post(
    '/intake-channels/:id/scan',
    command(pool, {
      action: 'intake.channel.scan',
      entityType: 'intake_channel',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'intake_channel');
        const c = await getChannel(client, id);
        if (!c || !hasTenderCap(ctx, c.tender_id, 'tender.read')) throw notFound({ entityType: 'intake_channel', entityId: id });
        if (!hasTenderCap(ctx, c.tender_id, 'source.write')) throw forbidden('source.write', { entityType: 'intake_channel', entityId: id, tenderId: c.tender_id });
      },
      run: async (client, _ctx, req) => {
        const id = uuidParam(req, 'id', 'intake_channel');
        const c = (await getChannel(client, id))!;
        if (!c.active) throw new HttpError(409, 'STATE_CONFLICT', 'канал отключён', {}, { tenderId: c.tender_id, entityId: id });
        const job = await enqueueJob(client, { kind: 'intake.scan', dedupeKey: `scan:${id}`, payload: { channelId: id }, tenderId: c.tender_id, resourceClass: 'network' });
        await markScanStarted(client, id);
        return { status: 202, body: { jobId: job.id, created: job.created }, audit: [{ action: 'intake.channel.scan', entityType: 'intake_channel', entityId: id, tenderId: c.tender_id }] };
      },
    }),
  );

  return router;
};
