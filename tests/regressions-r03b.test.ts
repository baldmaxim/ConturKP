// Регрессии по повторному ревью 03-2 (docs/reviews/03-review-2.md): R03-03, R03-04, R03-05.
// Каждый тест воспроизводит оставшийся обход: на коде коммита 97342f3 он падает.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimJob,
  emitStageEvents,
  enqueueJob,
  getJob,
  heartbeatJob,
  listStageEvents,
  lockOwnedJob,
  succeedJob,
  withTransaction,
} from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { PermanentJobError, WorkerRuntime, type IJobContext, type IJobHandlerSpec } from '../apps/worker/src/runtime.ts';
import { buildScenario, createTestDb, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig({ jobLeaseSeconds: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const newClient = async (): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  return c;
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
});
afterAll(async () => db.drop());

describe('R03-03: каждое повышение версии входов имеет своё событие', () => {
  const versionOf = async (): Promise<number> =>
    (await db.pool.query<{ input_version: number }>('SELECT input_version FROM tender_stage WHERE id = $1', [s.stageA])).rows[0]!.input_version;

  it('два повышения версии и одно событие финального номера — COMMIT отклоняется', async () => {
    const before = await versionOf();
    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query('UPDATE tender_stage SET input_version = input_version + 1 WHERE id = $1', [s.stageA]);
        await client.query('UPDATE tender_stage SET input_version = input_version + 1 WHERE id = $1', [s.stageA]);
        await client.query(
          `INSERT INTO stage_input_event (stage_id, seq, event_class, event_type, ref_type, ref_id, actor_kind)
           VALUES ($1, $2, 'source', 'document_revision_registered', 'document_revision', gen_random_uuid(), 'system')`,
          [s.stageA, before + 2],
        );
      }),
    ).rejects.toThrow();
    expect(await versionOf()).toBe(before);
    const events = await listStageEvents(db.pool, s.stageA, 1000);
    expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: before }, (_, i) => i + 1));
  });

  it('новый этап нельзя создать с ненулевой версией входов', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO tender_stage (tender_id, seq, title, input_version, created_by)
         VALUES ($1, 99, 'этап с подделанной версией', 1, $2)`,
        [s.tenderA, s.ids.admin],
      ),
    ).rejects.toThrow();
  });

  it('два штатных события в одной транзакции проходят и не дают пропусков', async () => {
    const before = await versionOf();
    await withTransaction(db.pool, async (client) => {
      for (let i = 0; i < 2; i += 1) {
        await emitStageEvents(client, {
          tenderId: s.tenderA,
          stageIds: [s.stageA],
          eventType: 'source_set_changed',
          refType: 'source_set_revision',
          refId: randomUUID(),
          actorUserId: s.ids.eng1,
        });
      }
    });
    expect(await versionOf()).toBe(before + 2);
    const events = await listStageEvents(db.pool, s.stageA, 1000);
    expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: before + 2 }, (_, i) => i + 1));
  });
});

describe('R03-04: перехват слота GPU сериализован с владельцем', () => {
  const claimGpu = (workerId: string, gpuGraceMs = 0) => claimJob(db.pool, { workerId, leaseMs: 60_000, gpuGraceMs, kinds: ['test.gpu.r03b'] });

  const cleanup = async (): Promise<void> => {
    await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL, finished_at = now() WHERE kind = 'test.gpu.r03b' AND status IN ('queued', 'running')");
    await db.pool.query("UPDATE resource_slot SET holder_job_id = NULL, lease_token = NULL, locked_until = NULL WHERE slot_key = 'gpu'");
  };

  it('перехват слота во время heartbeat: прежний владелец получает потерю аренды, а не ok', async () => {
    await cleanup();
    const a = await enqueueJob(db.pool, { kind: 'test.gpu.r03b', resourceClass: 'gpu', dedupeKey: `r03b-${randomUUID()}` });
    const other = await enqueueJob(db.pool, { kind: 'test.gpu.r03b', resourceClass: 'gpu', dedupeKey: `r03b-${randomUUID()}` });
    const owner = (await claimGpu('A'))!;
    expect(owner.id).toBe(a.id);

    // Конкурентный перехват: транзакция B держит строку слота и меняет владельца.
    const takeover = await newClient();
    await takeover.query('BEGIN');
    await takeover.query("SELECT 1 FROM resource_slot WHERE slot_key = 'gpu' FOR UPDATE");
    await takeover.query("UPDATE resource_slot SET holder_job_id = $1, lease_token = gen_random_uuid() WHERE slot_key = 'gpu'", [other.id]);

    // Heartbeat прежнего владельца начинается до фиксации перехвата и обязан дождаться её.
    const beating = heartbeatJob(db.pool, owner.id, owner.lease_token!, 60_000);
    await sleep(300);
    await takeover.query('COMMIT');
    await takeover.end();

    expect((await beating).ok).toBe(false);
    const job = (await getJob(db.pool, owner.id))!;
    expect(job.locked_until!.getTime()).toBeLessThan(Date.now() + 60_000);
    expect(await succeedJob(db.pool, owner.id, owner.lease_token!)).toBe(false);
    await cleanup();
  });

  it('доменная транзакция владельца слота блокирует перехват до своего завершения', async () => {
    await cleanup();
    const a = await enqueueJob(db.pool, { kind: 'test.gpu.r03b', resourceClass: 'gpu', dedupeKey: `r03b-${randomUUID()}` });
    await enqueueJob(db.pool, { kind: 'test.gpu.r03b', resourceClass: 'gpu', dedupeKey: `r03b-${randomUUID()}` });
    const owner = (await claimGpu('A'))!;
    expect(owner.id).toBe(a.id);
    // Аренда истекла (heartbeat прекратился — истекают и задание, и слот), но доменная
    // транзакция владельца уже началась.
    await db.pool.query("UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1", [owner.id]);
    await db.pool.query("UPDATE resource_slot SET locked_until = now() - interval '1 second' WHERE slot_key = 'gpu'");

    const domain = await newClient();
    await domain.query('BEGIN');
    const owned = await lockOwnedJob(domain, owner.id, owner.lease_token!);
    expect(owned).toBe(true);

    let takeoverDone = false;
    const takeover = claimGpu('B', 0).then((r) => {
      takeoverDone = true;
      return r;
    });
    await sleep(400);
    expect(takeoverDone, 'перехват слота не дождался доменной транзакции владельца').toBe(false);

    await domain.query('COMMIT');
    await domain.end();
    const claimed = await takeover;
    expect(claimed).not.toBeNull();
    await cleanup();
  });
});

describe('R03-05: неудачная фиксация терминальной ошибки не оставляет задание failed', () => {
  it('исключение в onTerminalFailure: задание не failed, доменного маркера нет, повтор возможен', async () => {
    const marker = `terminal-${randomUUID()}`;
    const handler: IJobHandlerSpec = {
      run: async () => {
        throw new PermanentJobError('permanent_test', 'неповторяемая ошибка обработчика');
      },
      onTerminalFailure: async (client: pg.PoolClient, _ctx: IJobContext) => {
        await client.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ($1, 'worker', 0, now(), now())", [marker]);
        throw new Error('фиксация доменного отказа не удалась');
      },
    };
    const runtime = new WorkerRuntime({
      pool: db.pool,
      store: new BlobStore(config.storageRoot),
      config,
      handlers: { 'test.terminal.r03b': handler },
      workerId: 'terminal-worker',
    });
    const { id } = await enqueueJob(db.pool, { kind: 'test.terminal.r03b', dedupeKey: `terminal-${randomUUID()}` });
    expect(await runtime.runOnce(['test.terminal.r03b'])).toBe(true);

    const job = (await getJob(db.pool, id))!;
    expect(job.status, 'задание объявлено failed без доменного отказа').not.toBe('failed');
    const domain = await db.pool.query('SELECT 1 FROM process_heartbeat WHERE process_id = $1', [marker]);
    expect(domain.rowCount, 'доменный маркер записан, хотя транзакция откатилась').toBe(0);
    // Повтор остаётся возможным: задание снова доступно для захвата.
    await db.pool.query('UPDATE job SET run_after = now(), max_attempts = 5 WHERE id = $1', [id]);
    const again = await claimJob(db.pool, { workerId: 'B', leaseMs: 1000, gpuGraceMs: 0, kinds: ['test.terminal.r03b'] });
    expect(again).not.toBeNull();
    await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL, finished_at = now() WHERE id = $1", [id]);
  });
});
