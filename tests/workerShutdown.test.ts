// Этап 17, проект §3: штатная остановка worker с возвратом задания без потери попытки, слот GPU сразу свободен,
// устаревший владелец ничего не меняет, прерванный вызов модели не пишется как отказ модели, обслуживание очереди
// не зависит от занятой полосы, живость циклов, обрыв соединений БД, модуль жизненного цикла процессов.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chatError, FakeEmbeddings, type IModelGatewayChat } from '../packages/adapters/src/index.ts';
import { EXIT_FATAL, EXIT_FORCED, installShutdown, loadConfig, type ILifecycleProcess } from '../packages/config/src/index.ts';
import {
  claimJob,
  createPool,
  enqueueJob,
  freshWorkerCount,
  beat,
  getJob,
  gpuSlotBusy,
  releaseJob,
  requestCancel,
  retireHeartbeat,
  withTransaction,
} from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { WorkerRuntime, WorkerStoppingError, type IJobContext, type JobHandler } from '../apps/worker/src/runtime.ts';
import { ADMIN_URL, createTestDb, makeApp, testConfig, type ITestDb } from './helpers.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let db: ITestDb;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('условие не наступило');
    await sleep(25);
  }
};

const marker = (client: pg.PoolClient | pg.Pool, name: string) =>
  client.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ($1, 'worker', 0, now(), now())", [name]);
const markerExists = async (name: string) => ((await db.pool.query('SELECT 1 FROM process_heartbeat WHERE process_id = $1', [name])).rowCount ?? 0) > 0;
const slot = async () => (await db.pool.query<{ holder_job_id: string | null }>("SELECT holder_job_id FROM resource_slot WHERE slot_key = 'gpu'")).rows[0]!.holder_job_id;

const worker = (handlers: Record<string, JobHandler>, over: Partial<ConstructorParameters<typeof WorkerRuntime>[0]> = {}, config = testConfig()) =>
  new WorkerRuntime({ pool: db.pool, store: new BlobStore(config.storageRoot), config, handlers, workerId: `w-${Math.random()}`, ...over });

// Обработчик ждёт сигнала задания, затем пытается записать результат — после остановки запись закрыта.
const waitThenWrite = (started: () => void, name: string) => async (ctx: IJobContext) => {
  started();
  await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
  await ctx.withLease((client) => marker(client, name));
};

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db.drop());

describe('releaseJob: возврат задания владельцем', () => {
  it('обычное задание — queued, попытка возвращена, аренда снята', async () => {
    const { id } = await enqueueJob(db.pool, { kind: 'test.rel', dedupeKey: 'rel-1', maxAttempts: 3 });
    const j = (await claimJob(db.pool, { workerId: 'A', leaseMs: 60_000, gpuGraceMs: 0, kinds: ['test.rel'] }))!;
    expect(j.attempts).toBe(1);
    expect(await releaseJob(db.pool, j, j.lease_token!, { code: 'worker_stopped', message: 'стоп', delayMs: 0, refundAttempt: true })).toBe(true);
    const after = (await getJob(db.pool, id))!;
    expect(after).toMatchObject({ status: 'queued', attempts: 0, lease_token: null, locked_until: null, last_error_code: 'worker_stopped' });
  });

  it('GPU-задание — слот освобождён сразу: второй worker берёт GPU без защитного интервала', async () => {
    const { id } = await enqueueJob(db.pool, { kind: 'test.gpu', dedupeKey: 'gpu-rel', resourceClass: 'gpu' });
    const a = (await claimJob(db.pool, { workerId: 'A', leaseMs: 60_000, gpuGraceMs: 120_000, kinds: ['test.gpu'] }))!;
    expect(await slot()).toBe(id);
    expect(await gpuSlotBusy(db.pool)).toBe(true);
    expect(await releaseJob(db.pool, a, a.lease_token!, { code: 'worker_stopped', message: 'стоп', delayMs: 0, refundAttempt: true })).toBe(true);
    expect(await slot()).toBeNull();
    const b = (await claimJob(db.pool, { workerId: 'B', leaseMs: 60_000, gpuGraceMs: 120_000, kinds: ['test.gpu'] }))!;
    expect(b.id).toBe(id);
    expect(b.attempts).toBe(1);
    await releaseJob(db.pool, b, b.lease_token!, { code: 'x', message: 'x', delayMs: 0, refundAttempt: false });
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
  });

  it('устаревший владелец получает false и не трогает задание и слот (R03-13)', async () => {
    const { id } = await enqueueJob(db.pool, { kind: 'test.gpu', dedupeKey: 'gpu-stale', resourceClass: 'gpu' });
    const a = (await claimJob(db.pool, { workerId: 'A', leaseMs: 300, gpuGraceMs: 0, kinds: ['test.gpu'] }))!;
    await sleep(400);
    await db.pool.query("UPDATE job SET status = 'queued', lease_token = NULL, locked_until = NULL WHERE id = $1", [id]);
    const b = (await claimJob(db.pool, { workerId: 'B', leaseMs: 60_000, gpuGraceMs: 0, kinds: ['test.gpu'] }))!;
    expect(await releaseJob(db.pool, a, a.lease_token!, { code: 'worker_stopped', message: 'стоп', delayMs: 0, refundAttempt: true })).toBe(false);
    const row = (await getJob(db.pool, id))!;
    expect(row.status).toBe('running');
    expect(row.lease_token).toBe(b.lease_token);
    expect(await slot()).toBe(id);
    await releaseJob(db.pool, b, b.lease_token!, { code: 'x', message: 'x', delayMs: 0, refundAttempt: false });
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
  });
});

describe('WorkerRuntime.shutdown', () => {
  it('прерывает задание: доменная запись после остановки закрыта, задание вернулось с той же попыткой', async () => {
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    const w = worker({ 'test.stop': waitThenWrite(() => started(), 'stop-written') });
    const { id } = await enqueueJob(db.pool, { kind: 'test.stop', dedupeKey: 'stop-1', maxAttempts: 3 });
    const run = w.runOnce(['test.stop']);
    await go;
    const r = await w.shutdown({ deadlineMs: 5000, refundAttempt: true });
    await run;
    expect(r).toEqual({ released: 1, abandoned: 0 });
    expect(await markerExists('stop-written')).toBe(false);
    expect((await getJob(db.pool, id))!).toMatchObject({ status: 'queued', attempts: 0, last_error_code: 'worker_stopped' });
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
  });

  it('фатальная остановка списывает попытку', async () => {
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    const w = worker({ 'test.stop': waitThenWrite(() => started(), 'stop-fatal') });
    const { id } = await enqueueJob(db.pool, { kind: 'test.stop', dedupeKey: 'stop-2' });
    const run = w.runOnce(['test.stop']);
    await go;
    await w.shutdown({ deadlineMs: 5000, refundAttempt: false });
    await run;
    expect((await getJob(db.pool, id))!).toMatchObject({ status: 'queued', attempts: 1 });
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
  });

  it('обработчик не реагирует на прерывание — задание остаётся running до аренды (abandoned)', async () => {
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const w = worker({
      'test.deaf': async () => {
        started();
        await gate;
      },
    });
    const { id } = await enqueueJob(db.pool, { kind: 'test.deaf', dedupeKey: 'deaf-1' });
    const run = w.runOnce(['test.deaf']);
    await go;
    const r = await w.shutdown({ deadlineMs: 300, refundAttempt: true });
    expect(r).toEqual({ released: 0, abandoned: 1 });
    expect((await getJob(db.pool, id))!.status).toBe('running');
    // Обработчик вернулся позже: complete закрыт, задание всё равно возвращается владельцем.
    finish();
    await run;
    expect((await getJob(db.pool, id))!.status).toBe('queued');
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
  });

  it('задание, захваченное после начала остановки, не выполняется и сразу возвращается', async () => {
    const ran = vi.fn();
    const w = worker({ 'test.late': ran });
    await w.shutdown({ deadlineMs: 100, refundAttempt: true });
    const { id } = await enqueueJob(db.pool, { kind: 'test.late', dedupeKey: 'late-1' });
    expect(await w.runOnce(['test.late'])).toBe(true);
    expect(ran).not.toHaveBeenCalled();
    expect((await getJob(db.pool, id))!).toMatchObject({ status: 'queued', attempts: 0 });
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
  });

  it('гонка остановки и выполнения: в обоих порядках не остаётся running с токеном этого worker', async () => {
    for (const order of ['shutdown-first', 'run-first'] as const) {
      const w = worker({
        'test.race': async (ctx) => {
          await sleep(30);
          ctx.throwIfStopped();
          await ctx.complete();
        },
      });
      const { id } = await enqueueJob(db.pool, { kind: 'test.race', dedupeKey: `race-${order}` });
      if (order === 'shutdown-first') {
        const stop = w.shutdown({ deadlineMs: 2000, refundAttempt: true });
        await Promise.all([stop, w.runOnce(['test.race'])]);
      } else {
        const run = w.runOnce(['test.race']);
        await sleep(5);
        await Promise.all([w.shutdown({ deadlineMs: 2000, refundAttempt: true }), run]);
      }
      const row = (await getJob(db.pool, id))!;
      expect(['queued', 'succeeded']).toContain(row.status);
      expect(row.lease_token).toBeNull();
      await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1 AND status = 'queued'", [id]);
    }
  });

  it('отмена, пришедшая до остановки, проходит доменной отменой, а не возвратом', async () => {
    const config = testConfig({ jobLeaseSeconds: 1 });
    const onCancel = vi.fn(async () => undefined);
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    const w = worker(
      {
        'test.cancel17': {
          run: async (ctx) => {
            started();
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
            ctx.throwIfStopped();
          },
          onCancel,
        },
      },
      {},
      config,
    );
    const { id } = await enqueueJob(db.pool, { kind: 'test.cancel17', dedupeKey: 'cancel17' });
    const run = w.runOnce(['test.cancel17']);
    await go;
    await requestCancel(db.pool, id);
    await until(async () => (await getJob(db.pool, id))!.status !== 'running' || onCancel.mock.calls.length > 0, 5000).catch(() => undefined);
    await w.shutdown({ deadlineMs: 3000, refundAttempt: true });
    await run;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect((await getJob(db.pool, id))!.status).toBe('cancelled');
  });

  it('прерванный вызов модели не записывается как отказ модели (S17-04)', async () => {
    // Поддельная модель отвечает «недоступна», когда её прерывают, — как настоящий шлюз.
    const chat: IModelGatewayChat = {
      providerId: 'fake',
      model: 'm',
      version: 'v',
      maxInputChars: 1000,
      inferenceConfig: {},
      complete: (input) =>
        new Promise((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(chatError('UNAVAILABLE', 'прервано', true)), { once: true });
        }),
    };
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    const w = worker(
      {
        'test.model': async (ctx) => {
          started();
          const r = await ctx.chat!.complete({ task: 'answer_draft', system: 's', user: 'u', signal: ctx.signal });
          if (!r.ok) await marker(db.pool, 'model-marked-unavailable');
        },
      },
      { chat },
    );
    const { id } = await enqueueJob(db.pool, { kind: 'test.model', dedupeKey: 'model-1', resourceClass: 'gpu' });
    const run = w.runOnce(['test.model']);
    await go;
    await w.shutdown({ deadlineMs: 3000, refundAttempt: true });
    await run;
    expect(await markerExists('model-marked-unavailable')).toBe(false);
    expect((await getJob(db.pool, id))!.status).toBe('queued');
    expect(await slot()).toBeNull();
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
  });

  it('WorkerStoppingError — остановка, а не ошибка задания', () => {
    expect(new WorkerStoppingError()).toBeInstanceOf(Error);
  });
});

describe('циклы worker и живость', () => {
  it('обслуживание очереди не ждёт занятую фоновую полосу; своё активное задание recovery не трогает', async () => {
    const config = testConfig({ search: { ...testConfig().search, maintenanceIntervalMs: 100 } });
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const w = worker(
      {
        'test.long': async (ctx) => {
          started();
          await gate;
          await ctx.complete();
        },
      },
      {},
      config,
    );
    const own = await enqueueJob(db.pool, { kind: 'test.long', dedupeKey: 'long-own' });
    // Чужое зависшее задание с давно истёкшей арендой.
    const foreign = await enqueueJob(db.pool, { kind: 'test.foreign', dedupeKey: 'foreign-1' });
    await db.pool.query(
      "UPDATE job SET status = 'running', lease_token = gen_random_uuid(), locked_by = 'dead', locked_until = now() - interval '1 hour' WHERE id = $1",
      [foreign.id],
    );
    const controller = new AbortController();
    const loop = w.loop(controller.signal, 50);
    await go;
    // Своё активное задание тоже «просрочено» — recovery этого экземпляра его не отбирает.
    await db.pool.query("UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1", [own.id]);
    await until(async () => (await getJob(db.pool, foreign.id))!.status === 'queued');
    expect((await getJob(db.pool, own.id))!.status).toBe('running');
    expect(w.liveness(5000).ok).toBe(true);
    finish();
    await until(async () => (await getJob(db.pool, own.id))!.status === 'succeeded');
    controller.abort();
    await loop;
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1 AND status = 'queued'", [foreign.id]);
  });

  it('заблокированная очередь останавливает ход обслуживания — живость падает, heartbeat не пишется', async () => {
    const config = testConfig({ search: { ...testConfig().search, maintenanceIntervalMs: 50 } });
    const w = worker({}, {}, config);
    const controller = new AbortController();
    const loop = w.loop(controller.signal, 50);
    await sleep(200);
    expect(w.liveness(1000).ok).toBe(true);
    const admin = new pg.Client({ connectionString: db.appUrl.replace('kontur_app', 'kontur_migrator') });
    await admin.connect();
    await admin.query('BEGIN');
    await admin.query('LOCK TABLE job IN ACCESS EXCLUSIVE MODE');
    await until(() => !w.liveness(400).ok, 5000);
    expect(w.liveness(400).stale).toContain('queue');
    await admin.query('ROLLBACK');
    await admin.end();
    await until(() => w.liveness(400).ok, 5000);
    controller.abort();
    await loop;
  });

  it('retireHeartbeat: строка остановленного экземпляра перестаёт быть свежей', async () => {
    await db.pool.query("DELETE FROM process_heartbeat WHERE kind = 'worker'").catch(() => undefined);
    const before = await freshWorkerCount(db.pool, 60);
    await beat(db.pool, { processId: 'retire-me', kind: 'worker', pid: 1, startedAt: new Date() });
    expect(await freshWorkerCount(db.pool, 60)).toBe(before + 1);
    await retireHeartbeat(db.pool, 'retire-me');
    expect(await freshWorkerCount(db.pool, 60)).toBe(before);
  });

  it('/ready: задание с давно истёкшей арендой — очередь не готова', async () => {
    const app = makeApp(db);
    const { default: request } = await import('supertest');
    const j = await enqueueJob(db.pool, { kind: 'test.stuck', dedupeKey: 'stuck-1' });
    await db.pool.query("UPDATE job SET status = 'running', lease_token = gen_random_uuid(), locked_until = now() - interval '1 hour' WHERE id = $1", [j.id]);
    const r = await request(app).get('/api/v1/ready');
    expect(r.status).toBe(503);
    expect(r.body.checks.queue.ok).toBe(false);
    await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL WHERE id = $1", [j.id]);
    const r2 = await request(app).get('/api/v1/ready');
    expect(r2.body.checks.queue.ok).toBe(true);
  });
});

describe('проба модели эмбеддингов (S17-07)', () => {
  it('проба — задание model.probe класса gpu: ждёт слот, как любое GPU-задание; пока модель отвечает — не чаще интервала', async () => {
    const fake = new FakeEmbeddings({ dim: 16, batchSize: 8 });
    let probes = 0;
    const embeddings = new Proxy(fake, {
      get: (t, p, r) => {
        const v: unknown = Reflect.get(t, p, r);
        if (p === 'probe') return async (...a: unknown[]) => ((probes += 1), (v as (...x: unknown[]) => unknown).apply(t, a));
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const { HANDLERS } = await import('../apps/worker/src/handlers/index.ts');
    const w = worker(HANDLERS, { embeddings });
    // Слот занят чужим GPU-заданием: проба ставится в очередь, но к модели не идёт.
    const { id } = await enqueueJob(db.pool, { kind: 'test.gpuhold', dedupeKey: 'gpuhold', resourceClass: 'gpu' });
    const j = (await claimJob(db.pool, { workerId: 'holder', leaseMs: 60_000, gpuGraceMs: 0, kinds: ['test.gpuhold'] }))!;
    await w.maintainSearch();
    expect(probes).toBe(0);
    const probeJob = await db.pool.query<{ id: string; resource_class: string }>("SELECT id, resource_class FROM job WHERE kind = 'model.probe' AND status = 'queued'");
    expect(probeJob.rows).toHaveLength(1);
    expect(probeJob.rows[0]!.resource_class).toBe('gpu');
    expect(await w.runOnce(['model.probe'])).toBe(false);
    await releaseJob(db.pool, j, j.lease_token!, { code: 'x', message: 'x', delayMs: 0, refundAttempt: true });
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
    expect(await w.runOnce(['model.probe'])).toBe(true);
    expect(probes).toBe(1);
    // Модель ответила — следующая проба только через интервал.
    await w.maintainSearch();
    expect((await db.pool.query("SELECT 1 FROM job WHERE kind = 'model.probe' AND status = 'queued'")).rowCount).toBe(0);
    // Явная проверка (тесты, команда) пробует сразу.
    await w.maintainSearch({ checkModel: true });
    expect(probes).toBe(2);
  });
});

describe('обрыв соединений БД (S17-02)', () => {
  it('простаивающий и выданный клиенты: ошибка не роняет процесс, следующий запрос проходит', async () => {
    const errors: string[] = [];
    const pool = createPool(db.appUrl, 2, (m) => errors.push(m));
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const terminateAll = () => admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'kontur-kp' AND datname = $1 AND pid <> pg_backend_pid()", [db.name]);
    try {
      await pool.query('SELECT 1');
      // Простаивающий клиент.
      await terminateAll();
      await until(() => errors.length > 0, 5000);
      expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
      // Выданный клиент внутри транзакции.
      const client = await pool.connect();
      await client.query('BEGIN');
      await terminateAll();
      await expect(client.query('SELECT 1')).rejects.toThrow();
      client.release(true);
      // Обычная транзакция после обрыва — проходит.
      expect(await withTransaction(pool, async (c) => (await c.query<{ two: number }>('SELECT 2 AS two')).rows[0]!.two)).toBe(2);
    } finally {
      await admin.end();
      await pool.end();
    }
    expect(errors.every((e) => !/password|kontur_app:/u.test(e))).toBe(true);
  });
});

describe('жизненный цикл процесса (installShutdown)', () => {
  const fakeProc = () => {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    const proc: ILifecycleProcess & { emit: (e: string, ...a: unknown[]) => void } = {
      exitCode: undefined,
      on: (e, l) => {
        listeners.set(e, [...(listeners.get(e) ?? []), l]);
        return proc;
      },
      emit: (e, ...a) => {
        for (const l of listeners.get(e) ?? []) l(...a);
      },
    };
    return proc;
  };
  const timers: Array<() => void> = [];
  const setup = (stop: (reason: string, fatal: boolean) => Promise<boolean>) => {
    const proc = fakeProc();
    const exits: number[] = [];
    const lines: string[] = [];
    const h = installShutdown({ name: 't', graceMs: 1000, log: (l) => lines.push(l), stop, proc, exit: (c) => exits.push(c), setTimer: (fn) => (timers.push(fn), {}) });
    return { proc, exits, lines, h };
  };

  it('SIGINT, SIGTERM, SIGBREAK, SIGHUP и IPC запускают одну штатную остановку с кодом 0', async () => {
    for (const trigger of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP', 'ipc'] as const) {
      const stop = vi.fn(async () => true);
      const { proc, exits, h } = setup(stop);
      if (trigger === 'ipc') proc.emit('message', { type: 'shutdown' });
      else proc.emit(trigger);
      await h.shutdown('повтор');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith(expect.any(String), false);
      expect(proc.exitCode).toBe(0);
      expect(exits).toEqual([]);
    }
  });

  it('повторный сигнал — немедленный выход 4; незавершённая остановка — код 4; срок — выход 4', async () => {
    const pending = setup(() => new Promise<boolean>(() => undefined));
    pending.proc.emit('SIGINT');
    pending.proc.emit('SIGINT');
    expect(pending.exits).toEqual([EXIT_FORCED]);
    timers.at(-1)!();
    expect(pending.exits).toEqual([EXIT_FORCED, EXIT_FORCED]);

    const unclean = setup(async () => false);
    unclean.proc.emit('SIGTERM');
    await unclean.h.shutdown('');
    expect(unclean.proc.exitCode).toBe(EXIT_FORCED);
  });

  it('необработанная ошибка — остановка с признаком fatal и код 1', async () => {
    const stop = vi.fn(async () => true);
    const { proc, h, lines } = setup(stop);
    proc.emit('uncaughtException', new Error('сбой'));
    await h.shutdown('');
    expect(stop).toHaveBeenCalledWith(expect.any(String), true);
    expect(proc.exitCode).toBe(EXIT_FATAL);
    expect(lines.some((l) => l.includes('сбой'))).toBe(true);
  });
});

describe('конфигурация остановки и слота GPU (S17-08)', () => {
  const base = { KONTUR_ENV: 'test', DATABASE_URL: 'postgres://x', STORAGE_ROOT: '/tmp/x', ALLOWED_ORIGINS: 'http://127.0.0.1:5273' };
  it('защитный интервал меньше таймаута модели + 30 с — ошибка конфигурации', () => {
    expect(loadConfig(base).gpuTakeoverGraceSeconds).toBe(180);
    expect(() => loadConfig({ ...base, MODEL_TIMEOUT_SECONDS: '300' })).toThrow(/GPU_TAKEOVER_GRACE_SECONDS не меньше 330/u);
    expect(loadConfig({ ...base, MODEL_TIMEOUT_SECONDS: '300', GPU_TAKEOVER_GRACE_SECONDS: '330' }).gpuTakeoverGraceSeconds).toBe(330);
    expect(() => loadConfig({ ...base, SHUTDOWN_GRACE_SECONDS: '2' })).toThrow(/SHUTDOWN_GRACE_SECONDS/u);
  });
});
