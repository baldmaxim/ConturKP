// Регрессии по ревью 03-3 (docs/reviews/03-review-3.md): R03-10 и R03-11 — протокол аренды GPU.
// Тесты детерминированы: конкуренция создаётся явными блокировками и ожиданием, не таймингом удачи.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimJob,
  enqueueJob,
  getJob,
  heartbeatJob,
  lockOwnedJob,
  recoverExpiredJobs,
  succeedJob,
} from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { WorkerRuntime, type IJobContext, type IJobHandlerSpec } from '../apps/worker/src/runtime.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';

let db: ITestDb;
const config = testConfig({ jobLeaseSeconds: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KIND = 'test.gpu.r03c';

const newClient = async (): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  return c;
};

const slotRow = async (): Promise<{ holder_job_id: string | null; lease_token: string | null; locked_until: Date | null }> =>
  (await db.pool.query("SELECT holder_job_id, lease_token, locked_until FROM resource_slot WHERE slot_key = 'gpu'")).rows[0];

const cleanup = async (): Promise<void> => {
  await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL, finished_at = now() WHERE kind = $1 AND status IN ('queued', 'running')", [KIND]);
  await db.pool.query("UPDATE resource_slot SET holder_job_id = NULL, lease_token = NULL, locked_until = NULL WHERE slot_key = 'gpu'");
};

const claimGpu = (workerId: string, leaseMs = 60_000) => claimJob(db.pool, { workerId, leaseMs, gpuGraceMs: 0, kinds: [KIND] });

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db.drop());

describe('R03-10: единый порядок блокировок GPU (resource_slot → job)', () => {
  it('доменная транзакция берёт слот раньше строки задания', async () => {
    await cleanup();
    await enqueueJob(db.pool, { kind: KIND, resourceClass: 'gpu', dedupeKey: `r03c-${randomUUID()}` });
    const owner = (await claimGpu('A'))!;

    // Третья транзакция держит слот: доменная транзакция обязана ждать именно на слоте,
    // не захватив до этого строку задания (иначе порядок job → slot даёт цикл ожидания с heartbeat).
    const holder = await newClient();
    await holder.query('BEGIN');
    await holder.query("SELECT 1 FROM resource_slot WHERE slot_key = 'gpu' FOR UPDATE");

    const domain = await newClient();
    await domain.query('BEGIN');
    const locking = lockOwnedJob(domain, owner.id, owner.lease_token!);
    await sleep(300);

    const probe = await newClient();
    let jobRowFree = false;
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM job WHERE id = $1 FOR UPDATE NOWAIT', [owner.id]);
      jobRowFree = true;
    } catch {
      jobRowFree = false;
    } finally {
      await probe.query('ROLLBACK').catch(() => undefined);
      await probe.end();
    }

    try {
      expect(jobRowFree, 'строка задания уже заблокирована до слота: порядок блокировок job → slot').toBe(true);
    } finally {
      await holder.query('COMMIT');
      await holder.end();
      await locking.catch(() => undefined);
      await domain.query('ROLLBACK').catch(() => undefined);
      await domain.end();
      await cleanup();
    }
  });

  it('heartbeat параллельно с доменной транзакцией не даёт взаимоблокировки и не теряет результат', async () => {
    await cleanup();
    const job = await enqueueJob(db.pool, { kind: KIND, resourceClass: 'gpu', dedupeKey: `r03c-${randomUUID()}` });
    const owner = (await claimGpu('A'))!;
    expect(owner.id).toBe(job.id);
    const marker = `r03c-domain-${randomUUID()}`;

    // Доменная транзакция владельца началась и держит блокировки.
    const domain = await newClient();
    await domain.query('BEGIN');
    expect(await lockOwnedJob(domain, owner.id, owner.lease_token!)).toBe(true);

    // Heartbeat того же задания идёт параллельно: он обязан дождаться, а не упасть с 40P01.
    let heartbeatError: unknown = null;
    const beating = heartbeatJob(db.pool, owner.id, owner.lease_token!, 60_000).catch((e: unknown) => {
      heartbeatError = e;
      return { ok: false, cancelRequested: false };
    });
    await sleep(400);

    await domain.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ($1, 'worker', 0, now(), now())", [marker]);
    expect(await succeedJob(domain, owner.id, owner.lease_token!)).toBe(true);
    await domain.query('COMMIT');
    await domain.end();

    const hb = await beating;
    try {
      expect(heartbeatError, `heartbeat завершился ошибкой: ${String(heartbeatError)}`).toBeNull();
      expect(hb.ok).toBe(false); // задание уже завершено владельцем
      const domainWritten = await db.pool.query('SELECT 1 FROM process_heartbeat WHERE process_id = $1', [marker]);
      expect(domainWritten.rowCount, 'доменный результат потерян').toBe(1);
      expect((await getJob(db.pool, owner.id))!.status).toBe('succeeded');
    } finally {
      await cleanup();
    }
  });

  it('обратный порядок: heartbeat держит блокировки, доменная транзакция ждёт и завершается успешно', async () => {
    await cleanup();
    const job = await enqueueJob(db.pool, { kind: KIND, resourceClass: 'gpu', dedupeKey: `r03c-${randomUUID()}` });
    const owner = (await claimGpu('A'))!;
    expect(owner.id).toBe(job.id);

    // Транзакция, удерживающая строку слота (как heartbeat в момент продления).
    const holder = await newClient();
    await holder.query('BEGIN');
    await holder.query("SELECT 1 FROM resource_slot WHERE slot_key = 'gpu' FOR UPDATE");

    const domain = await newClient();
    await domain.query('BEGIN');
    let locked: boolean | null = null;
    const locking = lockOwnedJob(domain, owner.id, owner.lease_token!).then((r) => {
      locked = r;
      return r;
    });
    await sleep(300);
    try {
      expect(locked, 'доменная транзакция не дождалась освобождения слота').toBeNull();
      await holder.query('COMMIT');
      await holder.end();
      expect(await locking).toBe(true);
      expect(await succeedJob(domain, owner.id, owner.lease_token!)).toBe(true);
      await domain.query('COMMIT');
    } finally {
      await holder.query('COMMIT').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await domain.query('ROLLBACK').catch(() => undefined);
      await domain.end().catch(() => undefined);
      await cleanup();
    }
  });
});

describe('R03-11: heartbeat не продлевает слот после потери аренды задания', () => {
  it('после recovery старый heartbeat возвращает потерю и не трогает слот', async () => {
    await cleanup();
    await enqueueJob(db.pool, { kind: KIND, resourceClass: 'gpu', dedupeKey: `r03c-${randomUUID()}` });
    const owner = (await claimGpu('A', 500))!;
    await db.pool.query("UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1", [owner.id]);
    await db.pool.query("UPDATE resource_slot SET locked_until = now() - interval '1 second' WHERE slot_key = 'gpu'");
    expect(await recoverExpiredJobs(db.pool)).toContain(owner.id);

    const before = await slotRow();
    const hb = await heartbeatJob(db.pool, owner.id, owner.lease_token!, 60_000);
    expect(hb.ok).toBe(false);
    const after = await slotRow();
    expect(after.locked_until?.getTime(), 'слот продлён обработчиком без аренды задания').toBe(before.locked_until?.getTime());
    expect(after.lease_token).toBe(before.lease_token);
    await cleanup();
  });

  it('после подтверждённой потери аренды worker не шлёт новые heartbeat', async () => {
    await cleanup();
    await enqueueJob(db.pool, { kind: KIND, resourceClass: 'gpu', dedupeKey: `r03c-${randomUUID()}` });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler: IJobHandlerSpec = {
      // Обработчик намеренно не реагирует на AbortSignal сразу.
      run: async (ctx: IJobContext) => {
        await gate;
        await ctx.complete();
      },
    };
    const runtime = new WorkerRuntime({
      pool: db.pool,
      store: new BlobStore(config.storageRoot),
      config,
      handlers: { [KIND]: handler },
      workerId: 'r03c-worker',
    });
    const running = runtime.runOnce([KIND]);
    await sleep(500);
    const job = (await db.pool.query<{ id: string }>("SELECT id FROM job WHERE kind = $1 AND status = 'running'", [KIND])).rows[0]!;
    await db.pool.query("UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1", [job.id]);
    await db.pool.query("UPDATE resource_slot SET locked_until = now() - interval '1 second' WHERE slot_key = 'gpu'");
    await recoverExpiredJobs(db.pool);

    await sleep(300); // worker успевает получить подтверждённую потерю аренды
    const afterLoss = await slotRow();
    const jobAfterLoss = (await getJob(db.pool, job.id))!;
    await sleep(1200); // несколько интервалов heartbeat
    const later = await slotRow();
    const jobLater = (await getJob(db.pool, job.id))!;
    expect(later.locked_until?.getTime(), 'слот изменён после подтверждённой потери аренды').toBe(afterLoss.locked_until?.getTime());
    expect(jobLater.locked_until?.getTime()).toBe(jobAfterLoss.locked_until?.getTime());

    release();
    await running;
    expect((await getJob(db.pool, job.id))!.status).not.toBe('succeeded');
    await cleanup();
  }, 20_000);
});
