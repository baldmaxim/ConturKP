// Регрессии по ревью 03-1 (docs/reviews/03-review-1.md): R03-01…R03-09.
// Каждый тест воспроизводит дефект: на коде до исправления он падает.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimJob,
  createDraftRevision,
  emitStageEvents,
  enqueueJob,
  ensureWorkingSet,
  getBatch,
  getJob,
  heartbeatJob,
  insertBlob,
  listStageEvents,
  lockOwnedJob,
  succeedJob,
  withTransaction,
  type IJobRow,
} from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { handleIntakeScan } from '../apps/worker/src/handlers/intake.ts';
import { LeaseLostError, type IJobContext } from '../apps/worker/src/runtime.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
const INTAKE = mkdtempSync(join(tmpdir(), 'kontur-r03-intake-'));
const config = testConfig({ intakeRoots: [INTAKE], intakeStabilitySeconds: 1 });
let worker: ReturnType<typeof makeWorker>;
const store = new BlobStore(config.storageRoot);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const asOwner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: db.migratorUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

const upload = (stageId: string, name: string, data: Buffer) =>
  s.eng1.post(`/stages/${stageId}/imports?name=${encodeURIComponent(name)}`, data, {
    headers: { 'Content-Type': 'application/octet-stream', ...idem() },
  });

const createChannel = async (locator: string) => {
  const r = await s.admin.post(`/tenders/${s.tenderA}/intake-channels`, { origin: 'local', locator, scanIntervalSeconds: 3600 }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string };
};
const channelView = async (id: string) =>
  (await s.eng1.get(`/tenders/${s.tenderA}/intake-channels`)).body.items.find((c: { id: string }) => c.id === id);

beforeAll(async () => {
  db = await createTestDb();
  await store.init();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
});
afterAll(async () => {
  await db.drop();
  rmSync(INTAKE, { recursive: true, force: true });
});

describe('R03-01: состав замороженной ревизии набора источников', () => {
  it('строку замороженной ревизии нельзя перенести в черновик', async () => {
    const setId = await ensureWorkingSet(db.pool, s.stageA);
    const frozen = await createDraftRevision(db.pool, setId, s.ids.eng1);
    const up = await upload(s.stageA, 'ТЗ-r0301.pdf', fakePdf('r0301'));
    await drain(worker);
    const revisionId = (await s.eng1.get(`/imports/${up.body.id}`)).body.items[0].documentRevisionId;
    await db.pool.query(
      "INSERT INTO source_set_item (source_set_revision_id, document_revision_id, inclusion, decided_by) VALUES ($1, $2, 'included', $3)",
      [frozen, revisionId, s.ids.eng1],
    );
    await asOwner((c) => c.query("UPDATE source_set_revision SET status = 'frozen', frozen_at = now(), content_hash = 'r0301' WHERE id = $1", [frozen]));
    const draft = await createDraftRevision(db.pool, setId, s.ids.eng1);
    // Черновик создаётся копией состава базовой ревизии: убираем копию, чтобы перенос строки
    // не отклонялся уникальным индексом, а проверялся именно guard замороженной ревизии.
    await db.pool.query('DELETE FROM source_set_item WHERE source_set_revision_id = $1', [draft]);

    await expect(
      db.pool.query('UPDATE source_set_item SET source_set_revision_id = $2 WHERE source_set_revision_id = $1', [frozen, draft]),
    ).rejects.toThrow();
    const kept = await db.pool.query('SELECT count(*)::int AS n FROM source_set_item WHERE source_set_revision_id = $1', [frozen]);
    expect(kept.rows[0].n).toBe(1);
  });
});

describe('R03-02: неизменяемость элемента завершённой партии', () => {
  let itemId = '';
  let batchId = '';

  beforeAll(async () => {
    const up = await upload(s.stageA, 'битый-r0302.pdf', Buffer.from('не pdf'));
    await drain(worker);
    batchId = up.body.id;
    const b = (await s.eng1.get(`/imports/${batchId}`)).body;
    expect(b.status).toBe('completed_with_errors');
    itemId = b.items[0].id;
  });

  it('поля доказательства и идентичности не меняются после завершения партии', async () => {
    const cases: [string, unknown[]][] = [
      ['UPDATE import_item SET observed_name = $2 WHERE id = $1', [itemId, 'подменено.pdf']],
      ['UPDATE import_item SET reject_detail = $2 WHERE id = $1', [itemId, 'подменённая причина']],
      ['UPDATE import_item SET size_bytes = $2 WHERE id = $1', [itemId, 1]],
      ['UPDATE import_item SET tender_id = $2 WHERE id = $1', [itemId, s.tenderB]],
      ['UPDATE import_item SET created_at = now() - interval $2 WHERE id = $1', [itemId, '1 day']],
      ['UPDATE import_item SET resolved_by = $2, resolved_at = now() WHERE id = $1', [itemId, s.ids.eng1]],
    ];
    for (const [sql, params] of cases) {
      await expect(db.pool.query(sql, params), sql).rejects.toThrow();
    }
    const row = await db.pool.query('SELECT observed_name, reject_detail, resolution, resolved_by FROM import_item WHERE id = $1', [itemId]);
    expect(row.rows[0]).toMatchObject({ observed_name: 'битый-r0302.pdf', resolution: 'none', resolved_by: null });
  });

  it('исход задаётся один раз и не переписывает другие поля', async () => {
    const item = (await s.eng1.get(`/imports/${batchId}`)).body.items[0];
    const ok = await s.manager.post(
      `/import-items/${itemId}/resolve`,
      { resolution: 'not_applicable', reason: 'черновик, не документ заказчика' },
      { headers: { 'If-Match': `"${itemId}:${item.rowVersion}"`, ...idem() } },
    );
    expect(ok.status, ok.text).toBe(200);
    await expect(db.pool.query("UPDATE import_item SET resolution = 'none', resolution_decision_id = NULL WHERE id = $1", [itemId])).rejects.toThrow();
    await expect(
      db.pool.query("UPDATE import_item SET resolution = 'reimported', resolved_by_item_id = $2 WHERE id = $1", [itemId, itemId]),
    ).rejects.toThrow();
  });
});

describe('R03-03: версия входов этапа и событие барьера — одна операция', () => {
  it('повышение input_version без события отклоняется', async () => {
    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query('UPDATE tender_stage SET input_version = input_version + 1 WHERE id = $1', [s.stageA]);
      }),
    ).rejects.toThrow();
    const check = await db.pool.query<{ input_version: number; events: number }>(
      'SELECT t.input_version, (SELECT count(*)::int FROM stage_input_event e WHERE e.stage_id = t.id) AS events FROM tender_stage t WHERE t.id = $1',
      [s.stageA],
    );
    expect(check.rows[0]!.input_version).toBe(check.rows[0]!.events);
  });

  it('событие без соответствующей версии отклоняется', async () => {
    const v = (await db.pool.query<{ input_version: number }>('SELECT input_version FROM tender_stage WHERE id = $1', [s.stageA])).rows[0]!.input_version;
    for (const seq of [v, v + 1]) {
      await expect(
        db.pool.query(
          `INSERT INTO stage_input_event (stage_id, seq, event_class, event_type, ref_type, ref_id, actor_kind)
           VALUES ($1, $2, 'source', 'document_revision_registered', 'document_revision', gen_random_uuid(), 'system')`,
          [s.stageA, seq],
        ),
      ).rejects.toThrow();
    }
  });

  it('штатная выдача событий работает и не оставляет пропусков seq', async () => {
    for (let i = 0; i < 3; i += 1) {
      await withTransaction(db.pool, (client) =>
        emitStageEvents(client, {
          tenderId: s.tenderA,
          stageIds: [s.stageA],
          eventType: 'source_set_changed',
          refType: 'source_set_revision',
          refId: randomUUID(),
          actorUserId: s.ids.eng1,
        }),
      );
    }
    const events = await listStageEvents(db.pool, s.stageA, 1000);
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    const version = (await db.pool.query<{ input_version: number }>('SELECT input_version FROM tender_stage WHERE id = $1', [s.stageA])).rows[0]!.input_version;
    expect(version).toBe(seqs.length);
  });
});

describe('R03-04: ограждение слота GPU', () => {
  const claim = (workerId: string, gpuGraceMs = 0) => claimJob(db.pool, { workerId, leaseMs: 500, gpuGraceMs, kinds: ['test.gpu.r0304'] });

  it('слот занят другим владельцем: heartbeat, блокировка и завершение прежнего владельца невозможны', async () => {
    const a = await enqueueJob(db.pool, { kind: 'test.gpu.r0304', resourceClass: 'gpu', dedupeKey: 'r0304-a' });
    const other = await enqueueJob(db.pool, { kind: 'test.gpu.r0304', resourceClass: 'gpu', dedupeKey: 'r0304-b' });
    const owner = (await claim('A'))!;
    expect(owner.id).toBe(a.id);
    // Слот перешёл другому заданию (перехват или рассинхронизация), аренда задания ещё «жива».
    await db.pool.query("UPDATE resource_slot SET holder_job_id = $1, lease_token = gen_random_uuid() WHERE slot_key = 'gpu'", [other.id]);
    await db.pool.query("UPDATE job SET locked_until = now() + interval '1 hour' WHERE id = $1", [owner.id]);

    expect((await heartbeatJob(db.pool, owner.id, owner.lease_token!, 500)).ok).toBe(false);
    const wrote = await withTransaction(db.pool, async (client) => lockOwnedJob(client, owner.id, owner.lease_token!));
    expect(wrote).toBe(false);
    expect(await succeedJob(db.pool, owner.id, owner.lease_token!)).toBe(false);
    await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL, finished_at = now() WHERE id = ANY($1::uuid[])", [[a.id, other.id]]);
    await db.pool.query("UPDATE resource_slot SET holder_job_id = NULL, lease_token = NULL, locked_until = NULL WHERE slot_key = 'gpu'");
  });

  it('после перехвата слота прежний владелец не завершает задание, новый — единственный', async () => {
    const GRACE = 800;
    const j1 = await enqueueJob(db.pool, { kind: 'test.gpu.r0304', resourceClass: 'gpu', dedupeKey: 'r0304-c' });
    await enqueueJob(db.pool, { kind: 'test.gpu.r0304', resourceClass: 'gpu', dedupeKey: 'r0304-d' });
    const a = (await claim('A', GRACE))!;
    await sleep(700);
    await db.pool.query("UPDATE job SET status = 'queued', lease_token = NULL WHERE id = $1", [a.id]);
    await sleep(GRACE + 200);
    const b = (await claim('B', GRACE))!;
    expect(b.lease_token).not.toBe(a.lease_token);
    expect((await heartbeatJob(db.pool, a.id, a.lease_token!, 500)).ok).toBe(false);
    expect(await succeedJob(db.pool, a.id, a.lease_token!)).toBe(false);
    const slot = (await db.pool.query('SELECT holder_job_id, lease_token FROM resource_slot WHERE slot_key = $1', ['gpu'])).rows[0];
    expect(slot).toEqual({ holder_job_id: b.id, lease_token: b.lease_token });
    expect(await succeedJob(db.pool, b.id, b.lease_token!)).toBe(true);
    await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL, finished_at = now() WHERE status IN ('queued', 'running') AND kind = 'test.gpu.r0304'");
    void j1;
  });
});

describe('R03-05: терминальная ошибка импорта переводит партию в failed', () => {
  it('исчерпание попыток разбора: задание failed и партия failed с кодом', async () => {
    const up = await upload(s.stageA, 'терминальный-r0305.pdf', fakePdf('r0305'));
    const batchId = up.body.id as string;
    // Содержимое партии недоступно: строка blob есть, файла в хранилище нет — ошибка повторяется до исчерпания попыток.
    const ghost = createHash('sha256').update(`ghost-${randomUUID()}`).digest('hex');
    await insertBlob(db.pool, { sha256: ghost, sizeBytes: 10, mediaType: 'application/pdf', storageKey: `sha256/${ghost.slice(0, 2)}/${ghost.slice(2, 4)}/${ghost}` });
    await db.pool.query('UPDATE import_batch SET upload_blob_sha256 = $2 WHERE id = $1', [batchId, ghost]);
    await db.pool.query("UPDATE job SET max_attempts = 1 WHERE dedupe_key = $1", [`import:${batchId}`]);

    await drain(worker);
    const job = await db.pool.query<{ status: string }>('SELECT status FROM job WHERE dedupe_key = $1', [`import:${batchId}`]);
    expect(job.rows[0]!.status).toBe('failed');
    const batch = (await getBatch(db.pool, batchId))!;
    expect(batch.status).toBe('failed');
    expect(batch.failure_code).toBeTruthy();
    const view = (await s.eng1.get(`/imports/${batchId}`)).body;
    expect(view.status).toBe('failed');
  });
});

describe('R03-06: физический корень хранилища и alias', () => {
  it('хранилище через junction внутри наблюдаемой папки не сканируется', async () => {
    const watch = join(INTAKE, 'r0306-watch');
    const physicalStore = join(watch, 'store');
    mkdirSync(physicalStore, { recursive: true });
    const aliasBase = mkdtempSync(join(tmpdir(), 'kontur-r0306-alias-'));
    const alias = join(aliasBase, 'store-alias');
    symlinkSync(physicalStore, alias, 'junction');
    writeFileSync(join(watch, 'документ.pdf'), fakePdf('r0306'));

    const aliasConfig = testConfig({ intakeRoots: [INTAKE], intakeStabilitySeconds: 1, storageRoot: alias });
    const aliasWorker = makeWorker(db, aliasConfig, 'alias-worker');
    const channel = await createChannel(watch);
    await s.eng1.post(`/intake-channels/${channel.id}/scan`);
    await drain(aliasWorker);
    await sleep(1200);
    await s.eng1.post(`/intake-channels/${channel.id}/scan`);
    await drain(aliasWorker);

    const view = await channelView(channel.id);
    const scannedOwnStore = readdirSync(physicalStore).includes('sha256')
      ? (await db.pool.query("SELECT 1 FROM import_item WHERE member_path LIKE 'store/%'")).rowCount
      : 0;
    expect(scannedOwnStore).toBe(0);
    expect(view.lastErrorCode).toBe('overlaps_storage');
    rmSync(aliasBase, { recursive: true, force: true });
  });
});

describe('R03-07: подмена файла между обходом и чтением', () => {
  it('замена каталога ссылкой во время скана не приводит к импорту файла вне корня', async () => {
    const watch = join(INTAKE, 'r0307-watch');
    const sub = join(watch, 'sub');
    mkdirSync(sub, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'kontur-r0307-outside-'));
    const inner = fakePdf('внутренний документ');
    // Тот же размер и время изменения, что у подменяемого файла: проверки «файл не менялся»
    // проходят, поэтому защищать должен только контроль физического пути.
    const secret = Buffer.concat([fakePdf('секрет вне корня'), Buffer.alloc(Math.max(0, inner.length - fakePdf('секрет вне корня').length), 0x20)]);
    writeFileSync(join(outside, 'doc.pdf'), secret.subarray(0, inner.length));
    // Первый файл большой: его копирование даёт окно между обходом и чтением второго файла.
    writeFileSync(join(watch, '01-big.pdf'), Buffer.concat([fakePdf('big'), Buffer.alloc(24 * 1024 * 1024, 0x20)]));
    writeFileSync(join(sub, 'doc.pdf'), inner);
    const innerStat = statSync(join(sub, 'doc.pdf'));
    utimesSync(join(outside, 'doc.pdf'), innerStat.atime, innerStat.mtime);

    const channel = await createChannel(watch);
    await s.eng1.post(`/intake-channels/${channel.id}/scan`);
    await drain(worker);
    await sleep(1200);
    await s.eng1.post(`/intake-channels/${channel.id}/scan`);
    const scanning = drain(worker);
    // Ждём начала копирования (временный файл в хранилище) и подменяем каталог ссылкой наружу.
    const tmpDir = join(config.storageRoot, 'tmp');
    for (let i = 0; i < 200; i += 1) {
      if (existsSync(tmpDir) && readdirSync(tmpDir).some((f) => f.endsWith('.part'))) break;
      await sleep(10);
    }
    rmSync(sub, { recursive: true, force: true });
    symlinkSync(outside, sub, 'junction');
    await scanning;

    const secretSha = createHash('sha256').update(secret.subarray(0, inner.length)).digest('hex');
    const leaked = await db.pool.query('SELECT 1 FROM blob WHERE sha256 = $1', [secretSha]);
    expect(leaked.rowCount, 'файл вне разрешённого корня попал в хранилище').toBe(0);
    rmSync(sub, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }, 60_000);
});

describe('R03-08: проверка существующего объекта хранилища', () => {
  it('повреждённый объект того же размера обнаруживается, а не считается дубликатом', async () => {
    const local = new BlobStore(mkdtempSync(join(tmpdir(), 'kontur-r0308-')));
    await local.init();
    const data = Buffer.from('корректное содержимое');
    const { Readable } = await import('node:stream');
    const first = await local.putStream(Readable.from([data]), 1024);
    const target = local.pathOf(first.sha256);
    await chmod(target, 0o644);
    await writeFile(target, Buffer.alloc(data.length, 0x58));
    await expect(local.putStream(Readable.from([data]), 1024)).rejects.toThrow(/поврежд/i);
    await chmod(target, 0o644);
    await rm(target, { force: true });
  });
});

describe('R03-09: запись метаданных blob под действующей арендой', () => {
  it('после потери аренды обработчик скана не создаёт строку blob и партию', async () => {
    const watch = join(INTAKE, 'r0309-watch');
    mkdirSync(watch, { recursive: true });
    writeFileSync(join(watch, 'под-арендой.pdf'), fakePdf('r0309 под арендой'));
    const channel = await createChannel(watch);
    await s.eng1.post(`/intake-channels/${channel.id}/scan`);
    await drain(worker);
    await sleep(1200);

    const before = await db.pool.query<{ blobs: number; batches: number }>(
      'SELECT (SELECT count(*)::int FROM blob) AS blobs, (SELECT count(*)::int FROM import_batch) AS batches',
    );
    const job: IJobRow = (await getJob(db.pool, (await enqueueJob(db.pool, { kind: 'intake.scan', payload: { channelId: channel.id } })).id))!;
    const lost = (): never => {
      throw new LeaseLostError();
    };
    const ctx = {
      job,
      token: job.id,
      pool: db.pool,
      store,
      config,
      signal: new AbortController().signal,
      withLease: async () => lost(),
      complete: async () => lost(),
      throwIfStopped: () => undefined,
    } as unknown as IJobContext;
    await expect(handleIntakeScan(ctx)).rejects.toBeInstanceOf(LeaseLostError);

    const after = await db.pool.query<{ blobs: number; batches: number }>(
      'SELECT (SELECT count(*)::int FROM blob) AS blobs, (SELECT count(*)::int FROM import_batch) AS batches',
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const stat = statSync(config.storageRoot);
    expect(stat.isDirectory()).toBe(true);
  });
});
