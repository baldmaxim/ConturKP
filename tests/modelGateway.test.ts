// Этап 08: контракт шлюза генеративной модели (OD-08-2, adapters.md §8, ADR-009) против поддельного HTTP-сервера
// OpenAI-совместимого /chat/completions; разбор ответа модели до записи (схема, ложная цитата, вид факта, основание
// факта), хэши входа и настроек, деление на пачки; конфигурация. Живой сервер модели здесь не вызывается.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitBatches } from '../apps/worker/src/handlers/analysis.ts';
import { createChatModel, FakeChat, OpenAiCompatibleChat } from '../packages/adapters/src/index.ts';
import { loadConfig } from '../packages/config/src/index.ts';
import { analysisInputHash, canonicalJson, configHash, modelUserContent, parseFactOutput, parseRequirementOutput, systemPrompt } from '../packages/core/src/index.ts';

type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base = '';
let handler: Handler = () => undefined;
const seen: { auth: string | undefined; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
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
const chat = (o: Partial<ConstructorParameters<typeof OpenAiCompatibleChat>[0]> = {}) =>
  new OpenAiCompatibleChat({ baseUrl: base, model: 'qwen-test', revision: 'q4', apiKey: 'secret-model-key', timeoutMs: 500, maxInputChars: 4000, maxOutputTokens: 512, jsonMode: 'none', ...o });
const input = { task: 'requirement_extraction' as const, system: systemPrompt('requirement_extraction'), user: modelUserContent([{ id: 'f1', origin: 'document_text', text: 'Фасад должен быть кирпичным.' }]) };

describe('OpenAI-совместимый провайдер /chat/completions', () => {
  it('инструкции — системным сообщением, фрагменты — данными; температура 0; ключ только в заголовке', async () => {
    handler = (_b, _r, res) => json(res, 200, { choices: [{ message: { content: '{"candidates":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    const r = await chat().complete(input);
    expect(r).toMatchObject({ ok: true, value: { content: '{"candidates":[]}', promptTokens: 10, completionTokens: 3 } });
    const last = seen[seen.length - 1]!;
    expect(last.auth).toBe('Bearer secret-model-key');
    expect(last.body).toMatchObject({ model: 'qwen-test', temperature: 0, stream: false, max_tokens: 512 });
    expect(last.body.messages).toEqual([
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ]);
    expect(last.body.response_format).toBeUndefined();
    await chat({ jsonMode: 'json_object' }).complete(input);
    expect(seen[seen.length - 1]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('классы отказов: 401/403 — без повтора; 429 и 5xx — повторяемы; таймаут — повторяем; нарушение протокола — нет', async () => {
    const codes: [number, string, boolean][] = [
      [401, 'AUTH_FAILED', false],
      [403, 'AUTH_FAILED', false],
      [429, 'RATE_LIMITED', true],
      [503, 'UNAVAILABLE', true],
      [400, 'CONTRACT_MISMATCH', false],
    ];
    for (const [status, code, retryable] of codes) {
      handler = (_b, _r, res) => json(res, status, { error: 'x' });
      const r = await chat().complete(input);
      expect(r, String(status)).toMatchObject({ ok: false, error: { code, retryable } });
    }
    handler = (_b, _r, res) => json(res, 200, { choices: [] });
    expect(await chat().complete(input)).toMatchObject({ ok: false, error: { code: 'CONTRACT_MISMATCH', retryable: false } });
    handler = () => undefined;
    const t = await chat({ timeoutMs: 100 }).complete(input);
    expect(t).toMatchObject({ ok: false, error: { code: 'TIMEOUT_UNKNOWN_OUTCOME', retryable: true } });
    expect(JSON.stringify(t)).not.toContain('secret-model-key');
  });

  it('адрес модели — только loopback или LAN (D-013); конфигурация: fake запрещён в production', () => {
    expect(() => chat({ baseUrl: 'https://api.example.com/v1' })).toThrow();
    const env = { KONTUR_ENV: 'production', DATABASE_URL: 'x', STORAGE_ROOT: '/tmp/x', ALLOWED_ORIGINS: 'https://kp.local' };
    expect(() => loadConfig({ ...env, MODEL_PROVIDER: 'fake' })).toThrow(/MODEL_PROVIDER=fake/u);
    expect(() => loadConfig({ ...env, MODEL_PROVIDER: 'openai_compatible', MODEL_BASE_URL: 'https://cloud.example.com/v1', MODEL_NAME: 'm' })).toThrow(/MODEL_BASE_URL/u);
    expect(createChatModel({ provider: 'none', baseUrl: null, model: null, revision: 'r', apiKey: null, timeoutMs: 1, maxInputChars: 500, maxOutputTokens: 1, jsonMode: 'none' })).toBeNull();
  });
});

describe('разбор ответа модели до записи (ADR-009 §2, A37)', () => {
  const allowed = new Set(['f1', 'f2']);
  it('невалидный JSON и нарушение схемы — отказ пачки; блок ```json допускается', () => {
    expect(parseRequirementOutput('это не JSON', allowed)).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseRequirementOutput('{"items":[]}', allowed)).toEqual({ ok: false, reason: 'schema_mismatch' });
    const fenced = parseRequirementOutput('```json\n{"candidates":[{"statement":"А","evidence":[{"fragmentId":"f1","role":"supports"}]}]}\n```', allowed);
    expect(fenced).toMatchObject({ ok: true, items: [{ statement: 'А' }] });
  });

  it('ложная цитата, нет supports, неверная форма — кандидат отбрасывается, остальные проходят', () => {
    const r = parseRequirementOutput(
      JSON.stringify({
        candidates: [
          { statement: 'Ложная', evidence: [{ fragmentId: 'f9', role: 'supports' }] },
          { statement: 'Без основания', evidence: [{ fragmentId: 'f1', role: 'clarifies' }] },
          { statement: '', evidence: [{ fragmentId: 'f1', role: 'supports' }] },
          { statement: 'Уверенность вне диапазона', confidence: 2, evidence: [{ fragmentId: 'f1', role: 'supports' }] },
          { statement: 'Настоящее', parameters: [{ name: 'класс', value: 'B30', unit: null }], objectScope: { floor: '2' }, evidence: [{ fragmentId: 'f2', role: 'supports' }] },
        ],
      }),
      allowed,
    );
    expect(r.ok && r.dropped.map((d) => d.reason)).toEqual(['unknown_fragment', 'no_supports', 'invalid_shape', 'invalid_shape']);
    expect(r.ok && r.items).toEqual([expect.objectContaining({ statement: 'Настоящее', objectScope: { floor: '2' } })]);
  });

  it('факты: вид только из справочника; основание — письменный текст (D-018)', () => {
    const r = parseFactOutput(
      JSON.stringify({
        facts: [
          { factKind: 'advance_payment', displayValue: '30 %', normalizedValue: { value: 30 }, evidence: [{ fragmentId: 'f1', role: 'supports' }] },
          { factKind: 'warranty_period', displayValue: '5 лет', normalizedValue: {}, evidence: [{ fragmentId: 'f1', role: 'supports' }] },
          { factKind: 'advance_payment', displayValue: '40 %', normalizedValue: { value: 40 }, evidence: [{ fragmentId: 'f2', role: 'supports' }] },
        ],
      }),
      allowed,
      new Set(['advance_payment']),
      (id) => id === 'f1',
    );
    expect(r.ok && r.dropped.map((d) => d.reason)).toEqual(['unknown_fact_kind', 'fact_basis_origin']);
    expect(r.ok && r.items.map((i) => i.displayValue)).toEqual(['30 %']);
  });
});

describe('ключ повтора и пачки', () => {
  it('хэш входа не зависит от порядка; хэш настроек — от порядка полей', () => {
    const a = analysisInputHash([{ id: 'b', textSha256: '2' }, { id: 'a', textSha256: '1' }]);
    expect(a).toBe(analysisInputHash([{ id: 'a', textSha256: '1' }, { id: 'b', textSha256: '2' }]));
    expect(a).not.toBe(analysisInputHash([{ id: 'a', textSha256: '1' }, { id: 'b', textSha256: '3' }]));
    expect(configHash({ temperature: 0, max: 1 })).toBe(configHash({ max: 1, temperature: 0 }));
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
  });

  it('пачки по пределу символов; фрагмент длиннее предела — отдельной пачкой, усечённым и учтённым', () => {
    const f = (id: string, n: number) => ({ id, origin: 'document_text', text: 'х'.repeat(n) });
    const b = splitBatches([f('1', 40), f('2', 50), f('3', 30), f('4', 250), f('5', 10)], 100);
    expect(b.map((x) => [x.fragments.map((y) => y.id), x.truncated])).toEqual([
      [['1', '2'], 0],
      [['3'], 0],
      [['4'], 1],
      [['5'], 0],
    ]);
    expect(b[2]!.fragments[0]!.text).toHaveLength(100);
  });

  it('поддельная модель детерминирована: тот же вход — тот же ответ', async () => {
    const m = new FakeChat();
    const a = await m.complete(input);
    const b = await m.complete(input);
    expect(a.ok && b.ok && a.value.content === b.value.content).toBe(true);
  });
});
