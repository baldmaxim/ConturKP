// Контракт конкретного провайдера эмбеддингов (ADR-012 §25, AR05-10) против поддельного
// HTTP-сервера OpenAI-совместимого /v1/embeddings: порядок векторов, проверка размерности до записи,
// классы отказов, таймаут, ключ только в заголовке, адрес только loopback/LAN.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeEmbeddings, isLocalModelUrl, OpenAiCompatibleEmbeddings } from '../packages/adapters/src/index.ts';
import { loadConfig } from '../packages/config/src/index.ts';
import { cosine, MAX_EMBEDDING_DIM, PROBE_TEXT } from '../packages/core/src/index.ts';

type Handler = (body: { model: string; input: string[] }, req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base = '';
let handler: Handler = () => undefined;
const seen: { auth: string | undefined; body: { model: string; input: string[] } }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model: string; input: string[] };
      seen.push({ auth: req.headers.authorization, body });
      handler(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const provider = (o: Partial<ConstructorParameters<typeof OpenAiCompatibleEmbeddings>[0]> = {}) =>
  new OpenAiCompatibleEmbeddings({ baseUrl: base, model: 'e5-test', revision: 'r1', apiKey: 'secret-key-value', timeoutMs: 500, batchSize: 8, expectedDim: 3, ...o });

describe('OpenAI-совместимый провайдер', () => {
  it('векторы — по полю index, а не по порядку ответа; ключ уходит только в заголовок', async () => {
    handler = (body, _req, res) =>
      json(res, 200, {
        model: body.model,
        data: body.input.map((_, i) => ({ index: i, embedding: [i, i + 0.5, i + 1] })).reverse(),
      });
    const r = await provider().embed({ texts: ['а', 'б'], purpose: 'index' });
    expect(r).toEqual({ ok: true, value: { vectors: [[0, 0.5, 1], [1, 1.5, 2]], dim: 3 } });
    const last = seen[seen.length - 1]!;
    expect(last.auth).toBe('Bearer secret-key-value');
    expect(last.body).toEqual({ model: 'e5-test', input: ['а', 'б'], encoding_format: 'float' });
  });

  it('размерность проверяется до записи: не та, что в настройке, — dimension_mismatch', async () => {
    handler = (body, _req, res) => json(res, 200, { data: body.input.map((_, i) => ({ index: i, embedding: [1, 2, 3, 4] })) });
    const r = await provider().embed({ texts: ['а'], purpose: 'query' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'CONTRACT_MISMATCH', reason: 'dimension_mismatch', retryable: false });
  });

  it('больше предела проекта — отказ даже без заданной размерности', async () => {
    handler = (body, _req, res) => json(res, 200, { data: body.input.map((_, i) => ({ index: i, embedding: new Array(MAX_EMBEDDING_DIM + 1).fill(0.1) })) });
    const r = await provider({ expectedDim: null }).embed({ texts: ['а'], purpose: 'index' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('dimension_mismatch');
  });

  it('число векторов не совпало, не числа, неверные индексы — отказ, а не частичная запись', async () => {
    handler = (_b, _req, res) => json(res, 200, { data: [{ index: 0, embedding: [1, 2, 3] }] });
    expect((await provider().embed({ texts: ['а', 'б'], purpose: 'index' })).ok).toBe(false);
    handler = (_b, _req, res) => json(res, 200, { data: [{ index: 0, embedding: [1, 'x', 3] }] });
    expect((await provider().embed({ texts: ['а'], purpose: 'index' })).ok).toBe(false);
    handler = (_b, _req, res) => json(res, 200, { data: [{ index: 5, embedding: [1, 2, 3] }] });
    expect((await provider().embed({ texts: ['а'], purpose: 'index' })).ok).toBe(false);
  });

  it('классы отказов: 401 — без повтора, 429 и 5xx — повторяемые, таймаут — неизвестный исход; секрет не в сообщении', async () => {
    for (const [status, code, retryable] of [
      [401, 'AUTH_FAILED', false],
      [429, 'RATE_LIMITED', true],
      [503, 'UNAVAILABLE', true],
    ] as const) {
      handler = (_b, _req, res) => json(res, status, { error: 'x' });
      const r = await provider().embed({ texts: ['а'], purpose: 'index' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatchObject({ code, retryable });
        expect(r.error.message).not.toContain('secret-key-value');
      }
    }
    handler = () => undefined; // сервер молчит
    const t = await provider({ timeoutMs: 100 }).embed({ texts: ['а'], purpose: 'index' });
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toMatchObject({ code: 'TIMEOUT_UNKNOWN_OUTCOME', reason: 'model_unavailable', retryable: true });
  });

  it('модель выключена (соединение отклонено) — model_unavailable', async () => {
    const r = await provider({ baseUrl: 'http://127.0.0.1:9/v1' }).embed({ texts: ['а'], purpose: 'index' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'UNAVAILABLE', reason: 'model_unavailable' });
  });

  it('пробный вектор — вектор фиксированной строки', async () => {
    handler = (body, _req, res) => json(res, 200, { data: body.input.map((t, i) => ({ index: i, embedding: [t.length, 1, 2] })) });
    const p = await provider().probe();
    expect(p).toEqual({ ok: true, value: { model: 'e5-test', dim: 3, probe: [PROBE_TEXT.length, 1, 2] } });
  });

  it('адрес модели — только loopback или LAN: облачного пути нет (D-013)', () => {
    for (const ok of ['http://127.0.0.1:1234/v1', 'http://localhost:8080/v1', 'http://192.168.1.20:1234/v1', 'http://10.0.0.5/v1', 'http://gpu-box:1234/v1', 'https://model.lan/v1']) {
      expect(isLocalModelUrl(ok), ok).toBe(true);
    }
    for (const bad of ['https://api.openai.com/v1', 'http://8.8.8.8/v1', 'ftp://127.0.0.1/v1', 'http://user:pass@127.0.0.1/v1', 'not a url']) {
      expect(isLocalModelUrl(bad), bad).toBe(false);
    }
    expect(() => provider({ baseUrl: 'https://api.openai.com/v1' })).toThrow(/loopback или LAN/u);
  });
});

describe('конфигурация модели эмбеддингов', () => {
  const base = { KONTUR_ENV: 'development', DATABASE_URL: 'postgresql://u@127.0.0.1/x', STORAGE_ROOT: '/data', ALLOWED_ORIGINS: 'http://127.0.0.1:3200' };
  it('по умолчанию модели нет; openai_compatible требует локальный адрес и имя; fake запрещён в production', () => {
    expect(loadConfig(base).embedding.provider).toBe('none');
    expect(() => loadConfig({ ...base, EMBEDDING_PROVIDER: 'openai_compatible' })).toThrow(/EMBEDDING_BASE_URL/u);
    expect(() => loadConfig({ ...base, EMBEDDING_PROVIDER: 'openai_compatible', EMBEDDING_BASE_URL: 'https://api.openai.com/v1', EMBEDDING_MODEL: 'm' })).toThrow(/loopback или LAN/u);
    const ok = loadConfig({ ...base, EMBEDDING_PROVIDER: 'openai_compatible', EMBEDDING_BASE_URL: 'http://127.0.0.1:1234/v1', EMBEDDING_MODEL: 'm', EMBEDDING_INPUT_TEMPLATE: 'e5' });
    expect(ok.embedding).toMatchObject({ provider: 'openai_compatible', model: 'm', template: 'e5' });
    expect(() => loadConfig({ ...base, KONTUR_ENV: 'production', TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k', EMBEDDING_PROVIDER: 'fake' })).toThrow(/fake в production/u);
    expect(() => loadConfig({ ...base, EMBEDDING_DIM: '5000' })).toThrow(/4000/u);
  });
});

describe('поддельный провайдер', () => {
  it('детерминирован; общие слова сближают векторы; поддельная модель названа как поддельная', async () => {
    const f = new FakeEmbeddings({ dim: 32 });
    expect(f.model).toBe('fake-hash-32');
    const a = await f.embed({ texts: ['гарантийный срок работ', 'гарантийный срок работ', 'бетон класса B30'], purpose: 'index' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.vectors[0]).toEqual(a.value.vectors[1]);
    const near = cosine(f.vectorOf('гарантийного срока'), f.vectorOf('гарантийный срок работ'));
    const far = cosine(f.vectorOf('гарантийного срока'), f.vectorOf('бетон класса B30'));
    expect(near).toBeGreaterThan(far);
  });
});
