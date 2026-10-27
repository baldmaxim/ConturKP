// Эксплуатация (этап 17, проект §7.4 и §11): статусы интеграций для пользователей и состояние установки для
// администратора — процессы, очередь, слот GPU, хранилище и свободное место, последняя копия. Без адресов, ключей,
// путей и данных тендеров.
import { buildId, type IAppConfig } from '@kontur/config';
import { globalCapabilities } from '@kontur/core';
import { checkSchema, contentTenderIds, listIntegrationStatuses, officeDiagnostics, officeSnapshot, officeTask, officeTasks, operationsSnapshot, type IIntegrationRow, type IOfficeJobQuery, type Pool } from '@kontur/db';
import { latestCompleteBackup, readManifest, type BlobStore } from '@kontur/storage';
import { Router } from 'express';
import { basename } from 'node:path';
import { query, uuidParam } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const integrationView = (r: IIntegrationRow) => ({
  system: r.system,
  component: r.component,
  status: r.status,
  evidenceRef: r.evidence_ref,
  verifiedAt: iso(r.verified_at),
  lastCheckedAt: iso(r.last_checked_at),
  lastSuccessAt: iso(r.last_success_at),
  lastErrorCode: r.last_error_code,
});

// Сведения о последней копии кешируются: манифест большой установки — мегабайты JSON.
let backupCache: { at: number; root: string; value: unknown } | null = null;

const lastBackup = async (root: string | null): Promise<unknown> => {
  if (!root) return { configured: false, last: null };
  if (backupCache && backupCache.root === root && Date.now() - backupCache.at < 60_000) return backupCache.value;
  let value: unknown;
  try {
    const dir = await latestCompleteBackup(root);
    if (!dir) value = { configured: true, last: null };
    else {
      const m = await readManifest(dir);
      value = {
        configured: true,
        last: {
          name: basename(dir),
          finishedAt: m.finishedAt,
          schemaVersion: m.schema.version,
          files: m.files.count,
          filesBytes: m.files.totalBytes,
          dumpBytes: m.dump.sizeBytes,
          role: m.role,
        },
      };
    }
  } catch (err) {
    value = { configured: true, last: null, problem: err instanceof Error ? err.message : 'копия не читается' };
  }
  backupCache = { at: Date.now(), root, value };
  return value;
};

export const operationsRouter = (pool: Pool, config: IAppConfig, store: BlobStore): Router => {
  const router = Router();

  // Статусы интеграций (portal-api §2): любой вошедший пользователь — статусы не несут данных тендеров и секретов.
  router.get(
    '/integrations/status',
    query(pool, 'integrations.status', 'integration_status', async (_ctx, _req, res) => {
      res.json({ items: (await listIntegrationStatuses(pool)).map(integrationView) });
    }),
  );

  router.get(
    '/admin/operations',
    query(pool, 'admin.operations', 'operations', async (ctx, _req, res) => {
      if (!globalCapabilities(ctx.roles).includes('admin.audit')) throw forbidden('admin.audit', { entityType: 'operations' });
      const [snapshot, schema, space, integrations, backup] = await Promise.all([
        operationsSnapshot(pool),
        checkSchema(pool),
        store.space.level(0, true),
        listIntegrationStatuses(pool),
        lastBackup(config.backupRoot),
      ]);
      res.json({
        build: buildId(),
        env: config.env,
        workerMode: config.workerMode,
        schema: { ...snapshot.schema, ok: schema.ok, problem: schema.ok ? null : schema.problem },
        processes: snapshot.processes.map((p) => ({ kind: p.kind, pid: p.pid, startedAt: p.startedAt.toISOString(), lastSeenAt: p.lastSeenAt.toISOString() })),
        queue: {
          byKind: snapshot.queue,
          oldestQueuedSeconds: snapshot.oldestQueuedSeconds,
          overdueRunning: snapshot.overdueRunning,
          failed24h: snapshot.failed24h,
          gpu: { holderKind: snapshot.gpu.holderKind, lockedUntil: iso(snapshot.gpu.lockedUntil) },
        },
        storage: {
          level: space.level,
          freeBytes: space.freeBytes,
          warnFreeBytes: config.storageSpace.warnFreeBytes,
          stopFreeBytes: config.storageSpace.stopFreeBytes,
          blobs: snapshot.blobs,
        },
        backup,
        integrations: integrations.map(integrationView),
      });
    }),
  );

  // «Офис» (вкладка администрирования): задания worker'а без полезной нагрузки и текстов ошибок; тендеры, к которым
  // у смотрящего нет содержимого, не раскрываются ни идентификатором, ни названием.
  router.get(
    '/admin/office',
    query(pool, 'admin.office', 'operations', async (ctx, _req, res) => {
      if (!globalCapabilities(ctx.roles).includes('office.read')) throw forbidden('office.read', { entityType: 'operations' });
      const snapshot = await officeSnapshot(pool, contentTenderIds(ctx));
      res.json({
        at: snapshot.at.toISOString(),
        items: snapshot.items.map((i) => ({ ...i, lastFailedAt: iso(i.lastFailedAt) })),
        tenders: snapshot.tenders,
        workersAlive: snapshot.workersAlive,
          tasks: snapshot.tasks,
      });
    }),
  );

  router.get(
    '/admin/office/diagnostics',
    query(pool, 'admin.office.diagnostics', 'operations', async (ctx, req, res) => {
      if (!globalCapabilities(ctx.roles).includes('office.read')) throw forbidden('office.read', { entityType: 'operations' });
      const value = req.query.kinds;
      if (Object.keys(req.query).some((key) => key !== 'kinds')) throw new HttpError(400, 'VALIDATION_FAILED', 'Неизвестный фильтр заданий');
      if (value !== undefined && (typeof value !== 'string' || value.length > 1500)) throw new HttpError(400, 'VALIDATION_FAILED', 'Некорректный фильтр заданий');
      const kinds = typeof value === 'string' ? [...new Set(value.split(','))] : null;
      if (kinds && (kinds.length > 20 || kinds.some((kind) => !/^[a-z][a-z0-9_.-]{0,79}$/i.test(kind)))) throw new HttpError(400, 'VALIDATION_FAILED', 'Некорректный фильтр заданий');
      const details = await officeDiagnostics(pool, contentTenderIds(ctx), kinds);
      res.json({ ...details, at: details.at.toISOString(), build: buildId() });
    }),
  );

  router.get('/admin/office/tasks', query(pool, 'admin.office.tasks', 'operations', async (ctx, req, res) => {
    if (!globalCapabilities(ctx.roles).includes('office.read')) throw forbidden('office.read', { entityType: 'operations' });
    function invalid(): never { throw new HttpError(400, 'VALIDATION_FAILED', 'Некорректный фильтр задач'); }
    if (Object.keys(req.query).some(key => !['kinds', 'tender', 'status', 'offset'].includes(key))) invalid();
    const { kinds: value, tender = 'all', status = 'active', offset = '0' } = req.query;
    if (typeof value !== 'undefined' && (typeof value !== 'string' || value.length > 4500)) invalid();
    const kinds = typeof value === 'string' ? [...new Set(value.split(','))] : null;
    if (kinds && (kinds.length > 50 || kinds.some(kind => !/^[a-z][a-z0-9_.-]{0,79}$/i.test(kind)))) invalid();
    if (typeof tender !== 'string' || !/^(all|none|hidden|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(tender)) invalid();
    if (typeof status !== 'string' || !['active', 'running', 'queued', 'failed', 'succeeded', 'cancelled'].includes(status)) invalid();
    if (typeof offset !== 'string' || !/^\d{1,7}$/.test(offset)) invalid();
    const visible = contentTenderIds(ctx);
    if (!['all', 'none', 'hidden'].includes(tender) && !visible.includes(tender)) throw notFound();
    const tasks = await officeTasks(pool, visible, { kinds, tender, status: status as IOfficeJobQuery['status'], offset: Number(offset) });
    res.json(tasks);
  }));

  router.get('/admin/office/tasks/:id', query(pool, 'admin.office.task', 'operations', async (ctx, req, res) => {
    if (!globalCapabilities(ctx.roles).includes('office.read')) throw forbidden('office.read', { entityType: 'operations' });
    const task = await officeTask(pool, contentTenderIds(ctx), uuidParam(req, 'id', 'job'));
    if (!task) throw notFound();
    res.json({ at: new Date().toISOString(), task });
  }));

  return router;
};
