// Эксплуатация (этап 17, проект §7.4 и §11): статусы интеграций для пользователей и состояние установки для
// администратора — процессы, очередь, слот GPU, хранилище и свободное место, последняя копия. Без адресов, ключей,
// путей и данных тендеров.
import { buildId, type IAppConfig } from '@kontur/config';
import { globalCapabilities } from '@kontur/core';
import { checkSchema, contentTenderIds, listIntegrationStatuses, officeSnapshot, operationsSnapshot, type IIntegrationRow, type Pool } from '@kontur/db';
import { latestCompleteBackup, readManifest, type BlobStore } from '@kontur/storage';
import { Router } from 'express';
import { basename } from 'node:path';
import { query } from '../http/command.ts';
import { forbidden } from '../http/errors.ts';

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
      if (!globalCapabilities(ctx.roles).includes('admin.audit')) throw forbidden('admin.audit', { entityType: 'operations' });
      const snapshot = await officeSnapshot(pool, contentTenderIds(ctx));
      res.json({
        at: snapshot.at.toISOString(),
        items: snapshot.items.map((i) => ({ ...i, lastFailedAt: iso(i.lastFailedAt) })),
        tenders: snapshot.tenders,
        workersAlive: snapshot.workersAlive,
      });
    }),
  );

  return router;
};
