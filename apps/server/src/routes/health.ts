// /health — процесс жив; /ready — БД, версия схемы, хранилище, heartbeat worker (ADR-011 §4).
// Ответ содержит только признаки готовности, без путей, адресов и значений конфигурации.
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IAppConfig } from '@kontur/config';
import { checkSchema, freshWorkerCount, type Pool } from '@kontur/db';
import { Router } from 'express';

interface ICheck {
  ok: boolean;
  detail: string;
}

const safe = async (fn: () => Promise<ICheck>, failure: string): Promise<ICheck> => {
  try {
    return await fn();
  } catch {
    return { ok: false, detail: failure };
  }
};

export const healthRouter = (config: IAppConfig, pool: Pool): Router => {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    const database = await safe(async () => {
      await pool.query('SELECT 1');
      return { ok: true, detail: 'доступна' };
    }, 'недоступна');
    const schema = database.ok
      ? await safe(async () => {
          const s = await checkSchema(pool);
          return { ok: s.ok, detail: s.ok ? `версия ${s.dbVersion}` : (s.problem ?? 'расхождение') };
        }, 'не удалось проверить')
      : { ok: false, detail: 'БД недоступна' };
    const storage = await safe(async () => {
      const dir = join(config.storageRoot, 'tmp');
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `ready-${randomUUID()}`);
      await writeFile(probe, 'ok');
      await rm(probe);
      return { ok: true, detail: 'доступно на запись' };
    }, 'недоступно на запись');
    const worker = database.ok
      ? await safe(async () => {
          const n = await freshWorkerCount(pool, config.workerStaleSeconds);
          return n > 0 ? { ok: true, detail: 'heartbeat свежий' } : { ok: false, detail: `нет heartbeat за ${config.workerStaleSeconds} с` };
        }, 'не удалось проверить')
      : { ok: false, detail: 'БД недоступна' };
    const checks = { database, schema, storage, worker };
    const ready = Object.values(checks).every((c) => c.ok);
    res.status(ready ? 200 : 503).json({ ready, checks });
  });

  return router;
};
