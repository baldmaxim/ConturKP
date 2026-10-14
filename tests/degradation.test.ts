// Этап 17 (проект §7): деградация зависимостей — причина сетевого сбоя (DNS, отказ соединения, TLS) видна в
// сообщении; усечённый и слишком большой ответ модели называются прямо; A39 — отказ ключа модели виден в статусе
// интеграций, ключ не печатается и ложного успеха нет; маршруты статусов интеграций и состояния установки.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeNetworkError, networkCause, OpenAiCompatibleChat, OpenAiCompatibleEmbeddings } from '../packages/adapters/src/index.ts';
import { enqueueJob, getJob } from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { WorkerRuntime, type IJobContext } from '../apps/worker/src/runtime.ts';
import { buildScenario, Clock, createTestDb, testConfig, type IScenario, type ITestDb } from './helpers.ts';

const SECRET = 'model-key-s3cret-a39';
let server: Server;
let base = '';
let reply: (res: import('node:http').ServerResponse) => void = (res) => res.end();
let db: ITestDb;
let s: IScenario;
const config = testConfig();

const closedPort = async (): Promise<number> => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => reply(res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  db = await createTestDb();
  s = await buildScenario(db, createApp({ config, pool: db.pool, clock: new Clock().read, logError: () => undefined }));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.drop();
});

const chat = (o: Partial<ConstructorParameters<typeof OpenAiCompatibleChat>[0]> = {}) =>
  new OpenAiCompatibleChat({ baseUrl: base, model: 'm', revision: 'r', apiKey: SECRET, timeoutMs: 3000, maxInputChars: 4000, maxOutputTokens: 64, jsonMode: 'none', ...o });
const input = { task: 'answer_draft' as const, system: 's', user: 'u' };

describe('причина сетевого сбоя', () => {
  it('DNS, отказ соединения и сертификат различаются; кода ОС достаточно, адреса в тексте нет', async () => {
    const dns = await fetch('http://kontur-stage17-nonexistent.invalid/').catch((e: unknown) => e);
    expect(networkCause(dns)).toBe('dns');
    expect(describeNetworkError(dns)).toMatch(/^имя сервера не разрешается \(DNS\), (ENOTFOUND|EAI_AGAIN)$/u);
    const refused = await fetch(`http://127.0.0.1:${await closedPort()}/`).catch((e: unknown) => e);
    expect(networkCause(refused)).toBe('refused');
    expect(describeNetworkError(refused)).not.toMatch(/127\.0\.0\.1/u);
    expect(networkCause({ cause: { code: 'CERT_HAS_EXPIRED' } })).toBe('tls');
    expect(networkCause({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toBe('timeout');
    expect(networkCause(new Error('x'))).toBe('network');
  });

  it('шлюзы модели и эмбеддингов называют причину отказа сети', async () => {
    const port = await closedPort();
    const r = await chat({ baseUrl: `http://127.0.0.1:${port}/v1` }).complete(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'UNAVAILABLE', retryable: true, message: expect.stringMatching(/соединение отклонено/u) });
    const e = new OpenAiCompatibleEmbeddings({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'e', revision: 'r', apiKey: null, timeoutMs: 3000, batchSize: 4, expectedDim: null });
    const er = await e.embed({ texts: ['x'], purpose: 'query' });
    expect(er.ok).toBe(false);
    if (!er.ok) expect(er.error.message).toMatch(/соединение отклонено/u);
  });
});

describe('большие и усечённые ответы модели', () => {
  it('finish_reason=length — TRUNCATED с подсказкой, а не «невалидный JSON»', async () => {
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"items": [' }, finish_reason: 'length' }] }));
    };
    const r = await chat().complete(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'TRUNCATED', retryable: false, message: expect.stringMatching(/MODEL_MAX_OUTPUT_TOKENS/u) });
  });

  it('ответ больше предела не читается в память целиком', async () => {
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(200_000) }, finish_reason: 'stop' }] }));
    };
    const r = await chat({ maxResponseBytes: 64 * 1024 }).complete(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TRUNCATED');
    const ok = await chat({ maxResponseBytes: 1024 * 1024 }).complete(input);
    expect(ok.ok).toBe(true);
  });
});

describe('A39: истёк или отозван ключ модели', () => {
  it('статус генеративной модели показывает отказ, ключ нигде не печатается, задание не объявлено успешным', async () => {
    reply = (res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid api key' }));
    };
    const lines: string[] = [];
    const worker = new WorkerRuntime({
      pool: db.pool,
      store: new BlobStore(config.storageRoot),
      config,
      workerId: 'a39',
      chat: chat(),
      log: (l) => lines.push(l),
      handlers: {
        'test.model': async (ctx: IJobContext) => {
          const r = await ctx.chat!.complete({ ...input, signal: ctx.signal });
          if (!r.ok) throw new Error(`модель отказала: ${r.error.code}`);
        },
      },
    });
    const { id } = await enqueueJob(db.pool, { kind: 'test.model', dedupeKey: 'a39-model', maxAttempts: 1 });
    expect(await worker.runOnce(['test.model'])).toBe(true);
    expect((await getJob(db.pool, id))!.status).toBe('failed');
    const app = createApp({ config, pool: db.pool, clock: new Clock().read, logError: () => undefined });
    const { TestClient } = await import('./helpers.ts');
    const eng = new TestClient(app);
    await eng.login('eng1');
    const st = await eng.get('/integrations/status');
    expect(st.status).toBe(200);
    expect(st.body.items).toContainEqual(expect.objectContaining({ system: 'model', component: 'ModelGateway', status: 'VERIFIED_FIXTURE', lastErrorCode: 'AUTH_FAILED' }));
    const everything = JSON.stringify([st.body, lines, await db.pool.query('SELECT * FROM job WHERE id = $1', [id]), await db.pool.query('SELECT * FROM integration_status')]);
    expect(everything).not.toContain(SECRET);
    // Успешный вызов снимает отказ.
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    };
    await enqueueJob(db.pool, { kind: 'test.model', dedupeKey: 'a39-model-2', maxAttempts: 1 });
    await worker.runOnce(['test.model']);
    const after = (await eng.get('/integrations/status')).body.items.find((x: { system: string }) => x.system === 'model');
    expect(after).toMatchObject({ lastErrorCode: null });
    expect(after.lastSuccessAt).not.toBeNull();
  });
});

describe('маршруты состояния', () => {
  it('статусы интеграций — только после входа; состояние установки — только администратору', async () => {
    const app = createApp({ config, pool: db.pool, clock: new Clock().read, logError: () => undefined });
    expect((await request(app).get('/api/v1/integrations/status')).status).toBe(401);
    const { TestClient } = await import('./helpers.ts');
    const admin = new TestClient(app);
    await admin.login('admin');
    const eng = new TestClient(app);
    await eng.login('eng1');
    expect((await eng.get('/admin/operations')).status).toBe(403);
    const ops = await admin.get('/admin/operations');
    expect(ops.status, ops.text).toBe(200);
    expect(ops.body).toMatchObject({ schema: { ok: true }, storage: { level: 'ok' }, backup: { configured: false, last: null } });
    expect(ops.body.schema.version).toBeGreaterThanOrEqual(43);
    expect(Array.isArray(ops.body.queue.byKind)).toBe(true);
    expect(JSON.stringify(ops.body)).not.toMatch(/postgres(ql)?:\/\/|kontur-storage-/u);
    void s;
  });
});
