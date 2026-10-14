// Этап 17 (проект §7.5, ADR-004 §7): портал держит у модели не больше одного своего запроса — при полной очереди
// обеих полос и пробе модели эмбеддингов; портал обращается только к /chat/completions и /embeddings (загрузкой и
// выгрузкой моделей LM Studio не управляет, ttl не передаёт).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiCompatibleChat, OpenAiCompatibleEmbeddings } from '../packages/adapters/src/index.ts';
import { enqueueJob } from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { WorkerRuntime, type IJobContext } from '../apps/worker/src/runtime.ts';
import { modelProbeHandler } from '../apps/worker/src/handlers/modelProbe.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';

let server: Server;
let base = '';
let inFlight = 0;
let maxInFlight = 0;
const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
let db: ITestDb;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ method: req.method ?? '', path: req.url ?? '', body });
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url?.endsWith('/embeddings')) {
          const n = Array.isArray(body.input) ? body.input.length : 1;
          res.end(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: Array.from({ length: 8 }, (_, k) => (k + 1) / 10) })) }));
        } else res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
      }, 120);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  db = await createTestDb();
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.drop();
});

describe('ограничение GPU-заданий портала', () => {
  it('обе полосы и проба: одновременно к модели не больше одного запроса; только два пути API', async () => {
    const config = testConfig({ search: { ...testConfig().search, maintenanceIntervalMs: 50, modelRetryIntervalMs: 50, modelCheckIntervalMs: 50 } });
    const chat = new OpenAiCompatibleChat({ baseUrl: base, model: 'chat-m', revision: 'r', apiKey: null, timeoutMs: 5000, maxInputChars: 4000, maxOutputTokens: 32, jsonMode: 'none' });
    const embeddings = new OpenAiCompatibleEmbeddings({ baseUrl: base, model: 'emb-m', revision: 'r', apiKey: null, timeoutMs: 5000, batchSize: 4, expectedDim: null });
    const callChat = async (ctx: IJobContext) => {
      const r = await ctx.chat!.complete({ task: 'answer_draft', system: 's', user: 'u', signal: ctx.signal });
      expect(r.ok).toBe(true);
    };
    const worker = new WorkerRuntime({
      pool: db.pool,
      store: new BlobStore(config.storageRoot),
      config,
      workerId: 'gpu-concurrency',
      chat,
      embeddings,
      // Интерактивная полоса берёт answer.generate и model.probe, фоновая — всё; все задания — класса gpu.
      handlers: { 'answer.generate': callChat, 'test.gpu.bg': callChat, 'model.probe': modelProbeHandler },
    });
    for (let i = 0; i < 4; i += 1) {
      await enqueueJob(db.pool, { kind: 'answer.generate', dedupeKey: `ans-${i}`, resourceClass: 'gpu', priority: 90 });
      await enqueueJob(db.pool, { kind: 'test.gpu.bg', dedupeKey: `bg-${i}`, resourceClass: 'gpu', priority: 20 });
    }
    const controller = new AbortController();
    const loop = worker.loop(controller.signal, 20);
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const left = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM job WHERE kind IN ('answer.generate', 'test.gpu.bg') AND status IN ('queued', 'running')");
      const probes = seen.filter((x) => x.path.endsWith('/embeddings')).length;
      if (left.rows[0]!.n === 0 && probes > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    controller.abort();
    await loop;
    expect(seen.filter((x) => x.path.endsWith('/chat/completions'))).toHaveLength(8);
    expect(seen.some((x) => x.path.endsWith('/embeddings'))).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(new Set(seen.map((x) => `${x.method} ${x.path}`))).toEqual(new Set(['POST /v1/chat/completions', 'POST /v1/embeddings']));
    // Портал не управляет моделью LM Studio: в теле запросов нет ttl и полей загрузки.
    expect(seen.every((x) => !('ttl' in x.body) && !('keep_alive' in x.body))).toBe(true);
  });
});
