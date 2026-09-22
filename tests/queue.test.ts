// Очередь заданий (ADR-004, state-machines §2): RT-06 — ограждение аренды, отмена при перехвате,
// слот GPU; повторы с задержкой; дедупликация; восстановление после падения worker (A15).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimJob,
  confirmCancel,
  enqueueJob,
  failJob,
  getJob,
  heartbeatJob,
  lockOwnedJob,
  recoverExpiredJobs,
  requestCancel,
  succeedJob,
  withTransaction,
} from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { WorkerRuntime, type IJobContext } from '../apps/worker/src/runtime.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildZip, fakePdf } from './zip.ts';

let db: ITestDb;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LEASE = 500;
const claim = (workerId: string, gpuGraceMs = 0, kinds?: string[]) =>
  claimJob(db.pool, { workerId, leaseMs: LEASE, gpuGraceMs, ...(kinds ? { kinds } : {}) });

// «Доменный результат» теста: строка-маркер, которую обработчик пишет под арендой.
const writeMarker = (jobId: string, token: string, marker: string) =>
  withTransaction(db.pool, async (client) => {
    if (!(await lockOwnedJob(client, jobId, token))) return false;
    await client.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ($1, 'worker', 0, now(), now())", [marker]);
    return true;
  });
const markerExists = async (marker: string) => ((await db.pool.query('SELECT 1 FROM process_heartbeat WHERE process_id = $1', [marker])).rowCount ?? 0) > 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db.drop());

describe('RT-06: ограждение аренды', () => {
  it('A приостановлен дольше аренды, B перехватил: все условные записи A возвращают 0 строк, результат A не пишется', async () => {
    const { id } = await enqueueJob(db.pool, { kind: 'test.rt06', dedupeKey: 'rt06-1' });
    const a = (await claim('A', 0, ['test.rt06']))!;
    expect(a.id).toBe(id);
    await sleep(LEASE + 300);
    expect(await recoverExpiredJobs(db.pool)).toContain(id);
    const b = (await claim('B', 0, ['test.rt06']))!;
    expect(b.id).toBe(id);
    expect(b.lease_token).not.toBe(a.lease_token);
    expect(b.attempts).toBe(2);

    // A возобновился
    expect((await heartbeatJob(db.pool, id, a.lease_token!, LEASE)).ok).toBe(false);
    expect(await writeMarker(id, a.lease_token!, 'rt06-A')).toBe(false);
    expect(await succeedJob(db.pool, id, a.lease_token!)).toBe(false);
    expect((await failJob(db.pool, a, a.lease_token!, { retryable: true, code: 'x', message: 'x' })).ok).toBe(false);
    expect(await confirmCancel(db.pool, id, a.lease_token!)).toBe(false);
    expect(await markerExists('rt06-A')).toBe(false);

    // B завершает законно
    expect(await writeMarker(id, b.lease_token!, 'rt06-B')).toBe(true);
    expect(await succeedJob(db.pool, id, b.lease_token!)).toBe(true);
    expect((await getJob(db.pool, id))!.status).toBe('succeeded');
  });

  it('то же в среде worker: обработчик A после перехвата не записывает результат', async () => {
    const config = testConfig({ jobLeaseSeconds: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handlers = {
      'test.pause': async (ctx: IJobContext) => {
        if (ctx.job.attempts === 1) await gate; // первый захват «зависает»
        await ctx.complete(async (client) => {
          await client.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ($1, 'worker', 0, now(), now())", [`pause-${ctx.job.attempts}`]);
        });
      },
    };
    const store = new BlobStore(config.storageRoot);
    const workerA = new WorkerRuntime({ pool: db.pool, store, config, handlers, workerId: 'A' });
    const workerB = new WorkerRuntime({ pool: db.pool, store, config, handlers, workerId: 'B' });
    const { id } = await enqueueJob(db.pool, { kind: 'test.pause', dedupeKey: 'pause-1' });
    const running = workerA.runOnce(['test.pause']);
    await sleep(200);
    // Процесс A «заморожен»: аренда истекает (имитация остановки heartbeat).
    await db.pool.query("UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1", [id]);
    await recoverExpiredJobs(db.pool);
    expect(await workerB.runOnce(['test.pause'])).toBe(true);
    release();
    await running;
    expect(await markerExists('pause-2')).toBe(true);
    expect(await markerExists('pause-1')).toBe(false);
    expect((await getJob(db.pool, id))!.status).toBe('succeeded');
  });
});

describe('RT-06: отмена', () => {
  it('отмена во время перехвата: подтверждает только новый владелец, A не может', async () => {
    const { id } = await enqueueJob(db.pool, { kind: 'test.cancel', dedupeKey: 'cancel-1' });
    const a = (await claim('A', 0, ['test.cancel']))!;
    expect(await requestCancel(db.pool, id)).toBe('running');
    await sleep(LEASE + 300);
    await recoverExpiredJobs(db.pool);
    // Захват отменённого задания сам его не завершает: доменный объект (партия, прогон)
    // известен только обработчику, поэтому отмену проводит worker через onCancel (R04-02).
    const bJob = (await claim('B', 0, ['test.cancel']))!;
    expect(bJob.cancel_requested).toBe(true);
    expect(bJob.status).toBe('running');
    // Прежний владелец аренду потерял и подтвердить отмену не может.
    expect(await confirmCancel(db.pool, id, a.lease_token!)).toBe(false);
    expect(await confirmCancel(db.pool, id, bJob.lease_token!)).toBe(true);
    expect((await getJob(db.pool, id))!.status).toBe('cancelled');
  });

  // R04-02: задание, отменённое до захвата, проходит через тот же доменный путь.
  it('worker видит флаг сразу после захвата и завершает отмену вместе с доменным объектом', async () => {
    const config = testConfig({ jobLeaseSeconds: 1 });
    const cancelled: string[] = [];
    let ran = false;
    const w = new WorkerRuntime({
      pool: db.pool,
      store: new BlobStore(config.storageRoot),
      config,
      handlers: {
        'test.precancel': {
          run: async () => {
            ran = true;
          },
          onCancel: async (_client, ctx) => {
            cancelled.push(ctx.job.id);
          },
        },
      },
      workerId: 'P',
    });
    const { id } = await enqueueJob(db.pool, { kind: 'test.precancel' });
    const claimed = (await claim('A', 0, ['test.precancel']))!;
    expect(await requestCancel(db.pool, id)).toBe('running');
    await sleep(LEASE + 300);
    await recoverExpiredJobs(db.pool);
    expect(await w.runOnce(['test.precancel'])).toBe(true);
    expect(ran).toBe(false);
    expect(cancelled).toEqual([id]);
    expect((await getJob(db.pool, id))!.status).toBe('cancelled');
    expect(await confirmCancel(db.pool, id, claimed.lease_token!)).toBe(false);
  });

  it('действующий владелец видит флаг при heartbeat и подтверждает отмену', async () => {
    const config = testConfig({ jobLeaseSeconds: 1 });
    const handlers = {
      'test.loop': async (ctx: IJobContext) => {
        for (let i = 0; i < 100; i += 1) {
          ctx.throwIfStopped();
          await sleep(50);
        }
      },
    };
    const w = new WorkerRuntime({ pool: db.pool, store: new BlobStore(config.storageRoot), config, handlers, workerId: 'L' });
    const { id } = await enqueueJob(db.pool, { kind: 'test.loop' });
    const run = w.runOnce(['test.loop']);
    await sleep(150);
    expect(await requestCancel(db.pool, id)).toBe('running');
    await run;
    expect((await getJob(db.pool, id))!.status).toBe('cancelled');
  });

  it('queued отменяется сразу', async () => {
    const { id } = await enqueueJob(db.pool, { kind: 'test.never' });
    expect(await requestCancel(db.pool, id)).toBe('cancelled');
    expect(await requestCancel(db.pool, id)).toBeNull();
  });
});

describe('RT-06: слот GPU', () => {
  it('одно GPU-задание одновременно; после истечения аренды слот не выдаётся до конца защитного интервала', async () => {
    const GRACE = 1500;
    const g1 = await enqueueJob(db.pool, { kind: 'test.gpu', resourceClass: 'gpu', dedupeKey: 'gpu-1' });
    const g2 = await enqueueJob(db.pool, { kind: 'test.gpu', resourceClass: 'gpu', dedupeKey: 'gpu-2' });
    const a = (await claim('A', GRACE, ['test.gpu']))!;
    expect([g1.id, g2.id]).toContain(a.id);
    expect(await claim('B', GRACE, ['test.gpu'])).toBeNull(); // второе GPU-задание ждёт слот
    await sleep(LEASE + 200);
    await recoverExpiredJobs(db.pool);
    expect(await claim('B', GRACE, ['test.gpu'])).toBeNull(); // аренда истекла, но защитный интервал идёт
    await sleep(GRACE + 200);
    const b = (await claim('B', GRACE, ['test.gpu']))!;
    expect(b).not.toBeNull();
    const slot = (await db.pool.query('SELECT holder_job_id, lease_token FROM resource_slot WHERE slot_key = $1', ['gpu'])).rows[0];
    expect(slot).toEqual({ holder_job_id: b.id, lease_token: b.lease_token });
    expect(await succeedJob(db.pool, b.id, b.lease_token!)).toBe(true);
    const free = (await db.pool.query('SELECT holder_job_id FROM resource_slot WHERE slot_key = $1', ['gpu'])).rows[0];
    expect(free.holder_job_id).toBeNull();
  });
});

describe('повторы и дедупликация', () => {
  it('повторяемая ошибка — назад в очередь с экспоненциальной задержкой; исчерпание попыток — failed', async () => {
    const { id } = await enqueueJob(db.pool, { kind: 'test.retry', maxAttempts: 2 });
    const a = (await claim('A', 0, ['test.retry']))!;
    expect((await failJob(db.pool, a, a.lease_token!, { retryable: true, code: 'share_unavailable', message: 'нет доступа' })).status).toBe('queued');
    const j = (await getJob(db.pool, id))!;
    expect(j.run_after.getTime() - Date.now()).toBeGreaterThan(1000);
    expect(await claim('A', 0, ['test.retry'])).toBeNull(); // задержка ещё не прошла
    await db.pool.query('UPDATE job SET run_after = now() WHERE id = $1', [id]);
    const b = (await claim('B', 0, ['test.retry']))!;
    expect((await failJob(db.pool, b, b.lease_token!, { retryable: true, code: 'share_unavailable', message: 'нет доступа' })).status).toBe('failed');
    expect((await getJob(db.pool, id))!).toMatchObject({ status: 'failed', attempts: 2, last_error_code: 'share_unavailable' });
  });

  it('dedupe_key: одно активное задание; после завершения можно поставить новое', async () => {
    const a = await enqueueJob(db.pool, { kind: 'test.dedupe', dedupeKey: 'same' });
    const b = await enqueueJob(db.pool, { kind: 'test.dedupe', dedupeKey: 'same' });
    expect(b).toEqual({ id: a.id, created: false });
    const j = (await claim('A', 0, ['test.dedupe']))!;
    await succeedJob(db.pool, j.id, j.lease_token!);
    expect((await enqueueJob(db.pool, { kind: 'test.dedupe', dedupeKey: 'same' })).created).toBe(true);
  });
});

describe('падение worker во время импорта (A15, «restart worker»)', () => {
  let s: IScenario;
  it('задание разбора захвачено и брошено: после истечения аренды другой worker выполняет его один раз', async () => {
    const config = testConfig();
    const app = makeApp(db, undefined, config);
    s = await buildScenario(db, app);
    const r = await s.eng1.post(
      `/stages/${s.stageA}/imports?name=${encodeURIComponent('пакет.zip')}`,
      buildZip([
        { name: 'a.pdf', data: fakePdf('a') },
        { name: 'b.pdf', data: fakePdf('b') },
      ]),
      { headers: { 'Content-Type': 'application/octet-stream', ...idem() } },
    );
    expect(r.status).toBe(202);
    const dead = (await claim('dead-worker', 0, ['import.expand']))!; // «упал» сразу после захвата
    await sleep(LEASE + 300);
    expect(await recoverExpiredJobs(db.pool)).toContain(dead.id);
    await drain(makeWorker(db, config, 'restarted'));
    const b = (await s.eng1.get(`/imports/${r.body.id}`)).body;
    expect(b.status).toBe('completed');
    expect(b.counts).toMatchObject({ total: 2, registered: 2 });
    const occ = await db.pool.query('SELECT count(*)::int AS n FROM document_occurrence WHERE import_item_id = ANY($1::uuid[])', [b.items.map((i: { id: string }) => i.id)]);
    expect(occ.rows[0].n).toBe(2);
  });
});
