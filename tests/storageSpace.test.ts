// Этап 17 (ADR-011 §10, проект §6): свободное место хранилища — предупреждение и остановка записи с явной ошибкой:
// загрузка получает 507 STORAGE_FULL, задание ждёт в очереди без списания попытки, /ready сообщает уровень без чисел.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, getJob } from '../packages/db/src/index.ts';
import { BlobStore, FreeSpaceGuard, isStorageFull, StorageFullError } from '../packages/storage/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { STORAGE_FULL_DELAY_MS, WorkerRuntime, type IJobContext } from '../apps/worker/src/runtime.ts';
import { buildScenario, Clock, createTestDb, idem, testConfig, TestClient, type IScenario, type ITestDb } from './helpers.ts';

const MB = 1024 * 1024;
let db: ITestDb;
let s: IScenario;
let free = 100 * MB;
const statfs = async () => ({ freeBytes: free, totalBytes: 1000 * MB });
const policy = { warnFreeBytes: 50 * MB, stopFreeBytes: 20 * MB, statfs };

beforeAll(async () => {
  db = await createTestDb();
  const app = createApp({ config: testConfig(), pool: db.pool, clock: new Clock().read, logError: () => undefined });
  s = await buildScenario(db, app);
});
afterAll(async () => db.drop());

describe('пороги свободного места', () => {
  it('ok / warn / stop / unknown; без политики проверки нет', async () => {
    const g = new FreeSpaceGuard(() => '/', policy);
    free = 100 * MB;
    expect((await g.level(0, true)).level).toBe('ok');
    expect((await g.level(60 * MB, true)).level).toBe('warn');
    free = 30 * MB;
    expect((await g.level(0, true)).level).toBe('warn');
    free = 10 * MB;
    expect((await g.level(0, true)).level).toBe('stop');
    await expect(g.assertWritable(0, true)).rejects.toBeInstanceOf(StorageFullError);
    expect((await new FreeSpaceGuard(() => '/', { ...policy, statfs: async () => null }).level()).level).toBe('unknown');
    expect((await new FreeSpaceGuard(() => '/', { warnFreeBytes: 0, stopFreeBytes: 0 }).level()).level).toBe('ok');
    expect(isStorageFull(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(true);
    expect(isStorageFull(Object.assign(new Error('x'), { code: 'EDQUOT' }))).toBe(true);
    expect(isStorageFull(new Error('x'))).toBe(false);
  });

  it('BlobStore: отказ до записи и посреди потока — временного файла не остаётся', async () => {
    const store = new BlobStore(mkdtempSync(join(tmpdir(), 'kontur-space-')), policy);
    await store.ensureDirs();
    free = 10 * MB;
    await expect(store.putStream(Readable.from([Buffer.from('x')]), MB)).rejects.toBeInstanceOf(StorageFullError);
    free = 100 * MB;
    // Место кончается во время записи: проверка каждые 32 МиБ видит остановку.
    const chunk = Buffer.alloc(8 * MB, 1);
    let sent = 0;
    const source = new Readable({
      read() {
        sent += 1;
        if (sent === 3) free = 10 * MB;
        this.push(sent <= 8 ? chunk : null);
      },
    });
    await expect(store.putStream(source, 512 * MB)).rejects.toBeInstanceOf(StorageFullError);
    expect(readdirSync(join(store.canonicalRoot(), 'tmp'))).toEqual([]);
    expect(readdirSync(join(store.canonicalRoot(), 'sha256'))).toEqual([]);
  });
});

describe('сервер и worker при нехватке места', () => {
  it('загрузка — 507 STORAGE_FULL с понятным текстом и аудитом отказа; /ready — запись остановлена', async () => {
    const config = testConfig();
    const store = new BlobStore(config.storageRoot, policy);
    const app = createApp({ config, pool: db.pool, clock: new Clock().read, store, logError: () => undefined });
    const eng = new TestClient(app);
    await eng.login('eng1');
    free = 10 * MB;
    const r = await eng.req('post', `/api/v1/stages/${s.stageA}/imports?name=a.pdf`, { body: Buffer.from('%PDF-1.4 x'), headers: { 'Content-Type': 'application/octet-stream', ...idem() } });
    expect(r.status, r.text).toBe(507);
    expect(r.body.code).toBe('STORAGE_FULL');
    expect(r.body.detail).toMatch(/ниже порога остановки записи/u);
    const ready = await request(app).get('/api/v1/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.checks.storage).toEqual({ ok: false, detail: 'мало места: запись остановлена' });
    expect(JSON.stringify(ready.body)).not.toMatch(/МБ|bytes/u);
    free = 30 * MB;
    const warn = await request(app).get('/api/v1/ready');
    expect(warn.body.checks.storage.detail).toMatch(/предупреждение/u);
    free = 100 * MB;
  });

  it('задание при нехватке места ждёт с кодом storage_full, попытка не списана, доменный отказ не записан', async () => {
    const config = testConfig();
    const store = new BlobStore(config.storageRoot, policy);
    const terminal: string[] = [];
    const worker = new WorkerRuntime({
      pool: db.pool,
      store,
      config,
      workerId: 'space',
      handlers: {
        'test.write': {
          run: async (ctx: IJobContext) => {
            await ctx.store.putStream(Readable.from([Buffer.from('data')]), MB);
          },
          onTerminalFailure: async () => {
            terminal.push('failed');
          },
        },
      },
    });
    free = 10 * MB;
    const { id } = await enqueueJob(db.pool, { kind: 'test.write', dedupeKey: 'space-1', maxAttempts: 1 });
    const t0 = Date.now();
    expect(await worker.runOnce(['test.write'])).toBe(true);
    const row = (await getJob(db.pool, id))!;
    expect(row).toMatchObject({ status: 'queued', attempts: 0, last_error_code: 'storage_full' });
    expect(row.run_after.getTime() - t0).toBeGreaterThan(STORAGE_FULL_DELAY_MS - 60_000);
    expect(terminal).toEqual([]);
    free = 100 * MB;
    await db.pool.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [id]);
  });
});
