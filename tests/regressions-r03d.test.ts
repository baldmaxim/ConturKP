// Регрессия по ревью 03-4 (docs/reviews/03-review-4.md): R03-13 — устаревший обработчик
// не должен освобождать слот GPU после потери аренды задания.
// Инвариант: потеряна аренда задания — не меняются ни job, ни resource_slot.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimJob,
  confirmCancel,
  enqueueJob,
  failJob,
  getJob,
  recoverExpiredJobs,
  requeueJob,
  succeedJob,
  type IJobRow,
} from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { PermanentJobError, WorkerRuntime, type IJobContext, type IJobHandlerSpec } from '../apps/worker/src/runtime.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';

let db: ITestDb;
const config = testConfig({ jobLeaseSeconds: 1 });
const KIND = 'test.gpu.r03d';
const GRACE_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ISlot {
  holder_job_id: string | null;
  lease_token: string | null;
  locked_until: Date | null;
}

const slotRow = async (): Promise<ISlot> =>
  (await db.pool.query<ISlot>("SELECT holder_job_id, lease_token, locked_until FROM resource_slot WHERE slot_key = 'gpu'")).rows[0]!;

const sameSlot = (a: ISlot, b: ISlot): boolean =>
  a.holder_job_id === b.holder_job_id && a.lease_token === b.lease_token && a.locked_until?.getTime() === b.locked_until?.getTime();

const cleanup = async (): Promise<void> => {
  await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL, finished_at = now() WHERE kind = $1 AND status IN ('queued', 'running')", [KIND]);
  await db.pool.query("UPDATE resource_slot SET holder_job_id = NULL, lease_token = NULL, locked_until = NULL WHERE slot_key = 'gpu'");
};

// Захват GPU-задания, затем истечение аренды и recovery: job снова queued без токена,
// слот по замыслу остаётся за прежним владельцем до конца защитного интервала.
const staleOwner = async (): Promise<{ job: IJobRow; token: string; slot: ISlot }> => {
  await enqueueJob(db.pool, { kind: KIND, resourceClass: 'gpu', dedupeKey: `r03d-${randomUUID()}` });
  // Короткая аренда: истекают и задание, и слот — так выглядит остановка worker без heartbeat.
  const job = (await claimJob(db.pool, { workerId: 'stale', leaseMs: 400, gpuGraceMs: GRACE_MS, kinds: [KIND] }))!;
  const token = job.lease_token!;
  await sleep(500);
  expect(await recoverExpiredJobs(db.pool)).toContain(job.id);
  return { job, token, slot: await slotRow() };
};

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db.drop());

describe('R03-13: устаревший обработчик не освобождает слот GPU', () => {
  it('stale succeedJob: false и слот не изменён', async () => {
    await cleanup();
    const { job, token, slot } = await staleOwner();
    expect(await succeedJob(db.pool, job.id, token)).toBe(false);
    expect(sameSlot(await slotRow(), slot), 'слот освобождён без аренды задания').toBe(true);
    expect((await getJob(db.pool, job.id))!.status).toBe('queued');
    await cleanup();
  });

  it('stale confirmCancel: false и слот не изменён', async () => {
    await cleanup();
    const { job, token, slot } = await staleOwner();
    expect(await confirmCancel(db.pool, job.id, token)).toBe(false);
    expect(sameSlot(await slotRow(), slot), 'слот освобождён без аренды задания').toBe(true);
    await cleanup();
  });

  it('stale failJob с повтором: ok=false и слот не изменён', async () => {
    await cleanup();
    const { job, token, slot } = await staleOwner();
    const r = await failJob(db.pool, job, token, { retryable: true, code: 'test', message: 'устаревший обработчик' });
    expect(r.ok).toBe(false);
    expect(sameSlot(await slotRow(), slot), 'слот освобождён без аренды задания').toBe(true);
    await cleanup();
  });

  it('stale requeueJob: false и слот не изменён', async () => {
    await cleanup();
    const { job, token, slot } = await staleOwner();
    expect(await requeueJob(db.pool, job, token, { code: 'test', message: 'устаревший обработчик' })).toBe(false);
    expect(sameSlot(await slotRow(), slot), 'слот освобождён без аренды задания').toBe(true);
    await cleanup();
  });

  it('после устаревших вызовов защитный интервал GPU не обойдён', async () => {
    await cleanup();
    const { job, token } = await staleOwner();
    await succeedJob(db.pool, job.id, token);
    await confirmCancel(db.pool, job.id, token);
    await failJob(db.pool, job, token, { retryable: true, code: 'test', message: 'устаревший' });
    await requeueJob(db.pool, job, token, { code: 'test', message: 'устаревший' });

    await enqueueJob(db.pool, { kind: KIND, resourceClass: 'gpu', dedupeKey: `r03d-${randomUUID()}` });
    const early = await claimJob(db.pool, { workerId: 'B', leaseMs: 60_000, gpuGraceMs: GRACE_MS, kinds: [KIND] });
    expect(early, 'слот выдан до окончания защитного интервала').toBeNull();
    await sleep(GRACE_MS + 300);
    const late = await claimJob(db.pool, { workerId: 'B', leaseMs: 60_000, gpuGraceMs: GRACE_MS, kinds: [KIND] });
    expect(late).not.toBeNull();
    await cleanup();
  }, 20_000);

  it('обработчик, потерявший аренду, не освобождает слот через onError worker', async () => {
    await cleanup();
    await enqueueJob(db.pool, { kind: KIND, resourceClass: 'gpu', dedupeKey: `r03d-${randomUUID()}` });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler: IJobHandlerSpec = {
      run: async (_ctx: IJobContext) => {
        await gate;
        throw new PermanentJobError('handler_failed', 'обработчик завершился ошибкой после потери аренды');
      },
      onTerminalFailure: async (client) => {
        await client.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ($1, 'worker', 0, now(), now())", ['r03d-terminal']);
      },
    };
    const runtime = new WorkerRuntime({
      pool: db.pool,
      store: new BlobStore(config.storageRoot),
      config,
      handlers: { [KIND]: handler },
      workerId: 'r03d-worker',
    });
    const running = runtime.runOnce([KIND]);
    await sleep(300);
    const job = (await db.pool.query<{ id: string }>("SELECT id FROM job WHERE kind = $1 AND status = 'running'", [KIND])).rows[0]!;
    await db.pool.query("UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1", [job.id]);
    await recoverExpiredJobs(db.pool);
    const slot = await slotRow();

    release();
    await running;

    expect(sameSlot(await slotRow(), slot), 'устаревший обработчик освободил слот через onError').toBe(true);
    const domain = await db.pool.query('SELECT 1 FROM process_heartbeat WHERE process_id = $1', ['r03d-terminal']);
    expect(domain.rowCount, 'доменный отказ записан без аренды').toBe(0);
    expect((await getJob(db.pool, job.id))!.status).toBe('queued');
    await cleanup();
  }, 20_000);
});
