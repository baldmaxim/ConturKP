// Регрессии Review 17-1 (docs/reviews/17-review-1.md). Каждый сценарий проверяет требуемое поведение; на коде передачи
// 17-1 (aa390ae) требуемые проверки падают, контроли проходят.
//   R17-01 — тайм-аут и отмена запроса модели действуют и после HTTP-заголовков, пока тело не дописано;
//   R17-02 — остановка worker прерывает уже выполняющуюся пробу модели (задание model.probe);
//   R17-03 — pg_restore идёт в тот же кластер, что проверили охранники: иначе отказ до записи.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleChat, OpenAiCompatibleEmbeddings } from '../packages/adapters/src/index.ts';
import { dropDatabase, enqueueJob, getJob, getModelStatus } from '../packages/db/src/index.ts';
import { runBackup } from '../scripts/ops/backup-lib.ts';
import { findPgTools, type IPgTool } from '../scripts/ops/pgTools.ts';
import { restoreRouteProblems, runRestoreCheck } from '../scripts/ops/restore-lib.ts';
import { MODEL_PROBE_KIND, MODEL_PROBE_PRIORITY } from '../apps/worker/src/handlers/modelProbe.ts';
import { ADMIN_URL, createTestDb, makeWorker, testConfig, type ITestDb } from './helpers.ts';
import { execFile } from 'node:child_process';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

// Настоящий HTTP-сервер: handler решает, что и когда отдать. Все соединения закрываются в конце сценария.
const serve = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> => {
  let n = 0;
  const server: Server = createServer((req, res) => {
    n += 1;
    req.resume();
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests: () => n,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

// Заголовки и начало JSON сразу, тело не заканчивается.
const headersThenStall = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('{');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const elapsed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
};
// Вызов либо завершился за limitMs, либо всё ещё ждёт (тогда — null).
const within = async <T>(p: Promise<T>, limitMs: number): Promise<T | null> => Promise.race([p, sleep(limitMs).then(() => null)]);

const chatOf = (url: string, timeoutMs: number) =>
  new OpenAiCompatibleChat({ baseUrl: url, model: 'm', revision: 'r', apiKey: null, timeoutMs, maxInputChars: 10_000, maxOutputTokens: 100, jsonMode: 'none' });
const embOf = (url: string, timeoutMs: number) => new OpenAiCompatibleEmbeddings({ baseUrl: url, model: 'e', revision: 'r', apiKey: null, timeoutMs, batchSize: 4, expectedDim: 3 });
const chatInput = { task: 'answer_draft' as const, system: 's', user: 'u' };

describe('R17-01: тайм-аут и отмена модели после заголовков', () => {
  it('генеративная модель: тело не дописано — тайм-аут 150 мс срабатывает (TIMEOUT_UNKNOWN_OUTCOME)', async () => {
    const srv = await serve(headersThenStall);
    try {
      const r = await within(chatOf(srv.url, 150).complete(chatInput), 700);
      expect(r, 'вызов всё ещё ждёт через 700 мс').not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(!r!.ok && r!.error.code).toBe('TIMEOUT_UNKNOWN_OUTCOME');
    } finally {
      await srv.close();
    }
  });

  it('генеративная модель: отмена после заголовков прерывает чтение тела, это не тайм-аут', async () => {
    const srv = await serve(headersThenStall);
    try {
      const ac = new AbortController();
      const call = chatOf(srv.url, 30_000).complete({ ...chatInput, signal: ac.signal });
      await sleep(200);
      ac.abort();
      const r = await within(call, 700);
      expect(r, 'вызов всё ещё ждёт через 700 мс после отмены').not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(!r!.ok && r!.error.code).not.toBe('TIMEOUT_UNKNOWN_OUTCOME');
    } finally {
      await srv.close();
    }
  });

  it('эмбеддинги: тело не дописано — тайм-аут 150 мс срабатывает (TIMEOUT_UNKNOWN_OUTCOME)', async () => {
    const srv = await serve(headersThenStall);
    try {
      const r = await within(embOf(srv.url, 150).embed({ texts: ['a'], purpose: 'query' }), 700);
      expect(r, 'вызов всё ещё ждёт через 700 мс').not.toBeNull();
      expect(!r!.ok && r!.error.code).toBe('TIMEOUT_UNKNOWN_OUTCOME');
    } finally {
      await srv.close();
    }
  });

  it('эмбеддинги: отмена после заголовков прерывает чтение тела, это не тайм-аут', async () => {
    const srv = await serve(headersThenStall);
    try {
      const ac = new AbortController();
      const call = embOf(srv.url, 30_000).embed({ texts: ['a'], purpose: 'query', signal: ac.signal });
      await sleep(200);
      ac.abort();
      const r = await within(call, 700);
      expect(r, 'вызов всё ещё ждёт через 700 мс после отмены').not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(!r!.ok && r!.error.code).not.toBe('TIMEOUT_UNKNOWN_OUTCOME');
    } finally {
      await srv.close();
    }
  });

  it('контроль: полный ответ в пределах тайм-аута принимается, таймер после ответа не мешает', async () => {
    const srv = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const body =
        req.url?.endsWith('/embeddings')
          ? { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }
          : { choices: [{ message: { content: '{"answer":"7"}' }, finish_reason: 'stop' }] };
      // Тело — двумя частями с паузой короче тайм-аута.
      const text = JSON.stringify(body);
      res.write(text.slice(0, 5));
      setTimeout(() => res.end(text.slice(5)), 50);
    });
    try {
      const chat = await elapsed(() => chatOf(srv.url, 1000).complete(chatInput));
      expect(chat.value.ok).toBe(true);
      const emb = await elapsed(() => embOf(srv.url, 1000).embed({ texts: ['a'], purpose: 'query' }));
      expect(emb.value.ok).toBe(true);
      // Таймер операции снят: ответ после его срока ничего не портит.
      await sleep(1100);
    } finally {
      await srv.close();
    }
  });
});

describe('R17-02 и R17-03: worker и восстановление', () => {
  let db: ITestDb;
  const runCmd = (file: string, args: string[]) =>
    new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout) }));
    });

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('R17-02: остановка worker прерывает пробу модели, которая ещё не получила заголовков', async () => {
    let arrived = 0;
    const srv = await serve(() => {
      arrived += 1; // ответа нет вовсе
    });
    try {
      const config = testConfig();
      const embeddings = new OpenAiCompatibleEmbeddings({ baseUrl: srv.url, model: 'e', revision: 'r', apiKey: null, timeoutMs: 30_000, batchSize: 4, expectedDim: 3 });
      const worker = makeWorker(db, config, 'w-r1702', embeddings);
      const statusBefore = JSON.stringify(await getModelStatus(db.pool));
      const job = await enqueueJob(db.pool, { kind: MODEL_PROBE_KIND, dedupeKey: 'model-probe', resourceClass: 'gpu', priority: MODEL_PROBE_PRIORITY, maxAttempts: 1 });
      const run = worker.runOnce([MODEL_PROBE_KIND]);
      for (let i = 0; i < 100 && arrived === 0; i += 1) await sleep(20);
      expect(arrived, 'проба дошла до сервера модели').toBe(1);
      const stop = await elapsed(() => worker.shutdown({ deadlineMs: 5000, refundAttempt: true }));
      await run;
      expect(stop.value).toEqual({ released: 1, abandoned: 0 });
      expect(stop.ms, 'остановка дождалась пробы').toBeLessThan(2000);
      const after = (await getJob(db.pool, job.id))!;
      expect(after).toMatchObject({ status: 'queued', attempts: 0, last_error_code: 'worker_stopped' });
      // Прерванная проба не записана как отказ модели.
      expect(JSON.stringify(await getModelStatus(db.pool))).toBe(statusBefore);
    } finally {
      await srv.close();
    }
  });

  it('R17-03: инструмент восстановления подключится к другому кластеру — отказ до записи: базы нет, pg_restore не запускался', async () => {
    const found = await findPgTools({ platform: process.platform, env: process.env, run: runCmd });
    if ('error' in found) throw new Error(`среда теста: ${found.error}`);
    const real: IPgTool = found;
    const backupUrl = (() => {
      const u = new URL(db.appUrl);
      u.username = 'kontur_backup';
      return u.toString();
    })();
    const storageRoot = mkdtempSync(join(tmpdir(), 'kontur-r1703-store-'));
    const backupRoot = mkdtempSync(join(tmpdir(), 'kontur-r1703-backup-'));
    const backup = await runBackup({ backupUrl, storageRoot, backupRoot, tool: real, host: 'test', build: null, log: () => undefined });

    // Подставной инструмент: psql «другого кластера» отвечает чужим идентификатором; pg_restore и pg_dump только
    // оставляют отметку, что их запустили.
    const dir = mkdtempSync(join(tmpdir(), 'kontur-r1703-tool-'));
    const script = join(dir, 'fake-pg.mjs');
    const marker = join(dir, 'called.txt');
    writeFileSync(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        'const [, , program] = process.argv;',
        "if (program === 'psql') { process.stdout.write('1\\n'); process.exit(0); }",
        "appendFileSync(process.env.KONTUR_FAKE_PG_MARKER, program + '\\n');",
        'process.exit(0);',
      ].join('\n'),
    );
    const wrong: IPgTool = { mode: 'docker', prefix: [process.execPath, script], dump: 'pg_dump', restore: 'pg_restore', psql: 'psql', version: 'fake 18', major: 18, container: 'другой-кластер' };
    const dbName = `kontur_restore_test_${randomBytes(4).toString('hex')}`;
    process.env.KONTUR_FAKE_PG_MARKER = marker;
    try {
      // Контроль: настоящий инструмент смотрит в тот же кластер.
      expect(await restoreRouteProblems({ tool: real, adminUrl: ADMIN_URL, dbName })).toEqual([]);
      const r = await runRestoreCheck({
        backupDir: backup.dir,
        adminUrl: ADMIN_URL,
        dbName,
        storageRoot: mkdtempSync(join(tmpdir(), 'kontur-r1703-restore-')),
        production: {},
        tool: wrong,
        log: () => undefined,
      });
      expect(r.ok).toBe(false);
      const last = r.steps.at(-1)!;
      expect(last.name).toMatch(/тот же кластер/u);
      expect(last.ok).toBe(false);
      expect(last.detail).toMatch(/другому кластеру/u);
      expect(r.steps.some((x) => /пустая база создана/u.test(x.name))).toBe(false);
      const exists = await db.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      expect(exists.rowCount, 'база проверки не создана').toBe(0);
      expect(existsSync(marker), 'pg_restore не запускался').toBe(false);
    } finally {
      delete process.env.KONTUR_FAKE_PG_MARKER;
      await dropDatabase(ADMIN_URL, dbName).catch(() => undefined);
    }
  });
});
