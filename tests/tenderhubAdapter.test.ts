// Этап 06: контракт адаптера TenderHub (docs/contracts/adapters.md §2) против поддельного сервера и
// подменённого fetch: заголовки, gzip, ограничения, классы ошибок, разбор строк. Статус — VERIFIED_FIXTURE.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenderHubApiSource, TenderHubError, TenderHubHttpClient, tenderHubBaseUrlProblem, type ITenderHubHttpOptions } from '../packages/adapters/src/index.ts';
import { loadConfig } from '../packages/config/src/index.ts';
import { startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { standardTender, TH, TH_KEY } from './calculationFixtures.ts';

let hub: IFakeTenderHub;
beforeAll(async () => {
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.tenders.set(TH.tender, standardTender());
});
afterAll(async () => hub.close());

const client = (o: Partial<ITenderHubHttpOptions> = {}) =>
  new TenderHubHttpClient({ baseUrl: hub.url, apiKey: TH_KEY, timeoutMs: 2000, rateLimitPerMinute: 1000, maxResponseBytes: 8 * 1024 * 1024, rateLimitWaits: 2, windowMs: 50, ...o });

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof TenderHubError) return err.error;
    throw err;
  }
  throw new Error('ожидалась ошибка адаптера');
};

// fetch, отвечающий заранее заданными ответами (для случаев, которые сервер сымитировать не может).
const scripted = (responses: (() => Response)[]): typeof fetch => {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]!()) as typeof fetch;
};
const jsonResponse = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

describe('HTTP-транспорт', () => {
  it('ключ — только в X-API-Key, без Authorization; gzip запрашивается и распаковывается; кэш with-costs сбрасывается', async () => {
    hub.requests.length = 0;
    const src = new TenderHubApiSource(client());
    const ov = await src.overview(TH.tender);
    expect(ov.value).toMatchObject({ tenderNumber: 'TH-2026-001', positionCount: 4, boqItemCount: 3 });
    expect(ov.raws[0]!.contentEncoding).toBe('gzip');
    expect(ov.raws[0]!.body.toString('utf8')).toContain('"cached_grand_total":1860.9');
    await src.positionsWithCosts(TH.tender);
    expect(hub.requests.map((r) => [r.apiKey, r.authorization, r.acceptEncoding])).toEqual([
      [TH_KEY, undefined, 'gzip'],
      [TH_KEY, undefined, 'gzip'],
    ]);
    expect(hub.requests.map((r) => r.cacheControl)).toEqual([undefined, 'no-cache']);
  });

  it('адрес: https, http только loopback, без учётных данных и параметров — и в адаптере, и в конфигурации', () => {
    expect(tenderHubBaseUrlProblem('https://tender.su10.ru')).toBeNull();
    expect(tenderHubBaseUrlProblem('http://127.0.0.1:3005')).toBeNull();
    expect(tenderHubBaseUrlProblem('http://tender.su10.ru')).toMatch(/https/u);
    expect(tenderHubBaseUrlProblem('https://user:pass@tender.su10.ru')).toMatch(/учётные данные/u);
    expect(tenderHubBaseUrlProblem('https://tender.su10.ru/?key=1')).toMatch(/параметров/u);
    const env = { KONTUR_ENV: 'test', DATABASE_URL: 'x', STORAGE_ROOT: '/tmp', ALLOWED_ORIGINS: 'http://127.0.0.1:5273' };
    // Неполная настройка необязательной интеграции запуск не останавливает: выгрузка ответит integration_not_configured.
    expect(loadConfig({ ...env, TENDERHUB_URL: 'https://tender.su10.ru' }).tenderhub).toMatchObject({ baseUrl: 'https://tender.su10.ru', apiKey: null });
    expect(() => loadConfig({ ...env, TENDERHUB_URL: 'http://tender.su10.ru', TENDERHUB_API_KEY: 'thk_x' })).toThrow(/https/u);
    expect(loadConfig({ ...env, TENDERHUB_URL: 'https://tender.su10.ru', TENDERHUB_API_KEY: 'thk_x' }).tenderhub).toMatchObject({ rateLimitPerMinute: 100, captureAttempts: 3 });
  });

  it('редирект не выполняется: ключ не уходит на другой адрес', async () => {
    const seen: string[] = [];
    const target: Server = createServer((req, res) => {
      seen.push(String(req.headers['x-api-key']));
      res.end('{}');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const redirector: Server = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/steal` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
    const c = new TenderHubHttpClient({ baseUrl: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`, apiKey: TH_KEY, timeoutMs: 2000, rateLimitPerMinute: 100, maxResponseBytes: 1024, rateLimitWaits: 0 });
    const e = await failure(c.get('overview', '/api/v1/tenders/x/overview'));
    expect(e).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(seen).toEqual([]);
    await new Promise<void>((r) => redirector.close(() => r()));
    await new Promise<void>((r) => target.close(() => r()));
  });

  it('предел распакованного ответа, таймаут и обрыв — классы ошибок без ключа в тексте', async () => {
    const big = await failure(new TenderHubApiSource(client({ maxResponseBytes: 200 })).boqItems(TH.tender));
    expect(big).toMatchObject({ code: 'CONTRACT_MISMATCH', reason: 'response_too_large', retryable: false });
    hub.beforeResponse = () => ({ kind: 'delay', ms: 300 });
    const slow = await failure(new TenderHubApiSource(client({ timeoutMs: 100 })).overview(TH.tender));
    expect(slow).toMatchObject({ code: 'TIMEOUT_UNKNOWN_OUTCOME', retryable: true });
    hub.beforeResponse = () => ({ kind: 'drop' });
    const dropped = await failure(new TenderHubApiSource(client()).overview(TH.tender));
    expect(dropped).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    hub.beforeResponse = null;
    for (const e of [big, slow, dropped]) expect(JSON.stringify(e)).not.toContain(TH_KEY);
  });

  it('собственный лимит запросов в минуту: третий запрос ждёт окно', async () => {
    const c = client({ rateLimitPerMinute: 2, windowMs: 200 });
    const t0 = Date.now();
    for (let i = 0; i < 3; i += 1) await c.get('overview', `/api/v1/tenders/${TH.tender}/overview`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });

  it('429 без Retry-After: ожидание окна; держится дольше предела — RATE_LIMITED (повторяемая)', async () => {
    let n429 = 0;
    hub.beforeResponse = () => (n429++ < 1 ? { kind: 'status', status: 429 } : undefined);
    expect((await new TenderHubApiSource(client()).overview(TH.tender)).value.tenderNumber).toBe('TH-2026-001');
    hub.beforeResponse = () => ({ kind: 'status', status: 429 });
    expect(await failure(new TenderHubApiSource(client()).overview(TH.tender))).toMatchObject({ code: 'RATE_LIMITED', reason: 'rate_limited', retryable: true });
    hub.beforeResponse = null;
  });
});

describe('разбор ответов по контракту', () => {
  const source = (bodies: string[]) =>
    new TenderHubApiSource(
      new TenderHubHttpClient({
        baseUrl: 'http://127.0.0.1:1',
        apiKey: TH_KEY,
        timeoutMs: 1000,
        rateLimitPerMinute: 1000,
        maxResponseBytes: 1024 * 1024,
        rateLimitWaits: 0,
        fetchImpl: scripted(bodies.map((b) => () => jsonResponse(b))),
      }),
    );

  it('без конверта {"data": …} и с неверными типами — CONTRACT_MISMATCH с путём, без данных ответа', async () => {
    expect(await failure(source(['[]']).overview(TH.tender))).toMatchObject({ code: 'CONTRACT_MISMATCH', retryable: false });
    const e = await failure(source([`{"data":{"id":"${TH.tender}","tender_number":"T","position_count":"много","boq_item_count":1}}`]).overview(TH.tender));
    expect(e.message).toMatch(/data\.position_count: ожидалось число/u);
    const cur = await failure(
      source([`{"data":[{"id":"${TH.l1}","tender_id":"${TH.tender}","client_position_id":"${TH.p1}","boq_item_type":"раб","currency_type":"KZT"}]}`]).boqItems(TH.tender),
    );
    expect(cur.message).toMatch(/валюта вне контракта/u);
  });

  it('отсутствующие документированные поля — null с учётом в отчёте (сверка со сборкой, R-06)', async () => {
    const src = source([`{"data":{"id":"${TH.tender}","tender_number":"T","position_count":0,"boq_item_count":0}}`]);
    const ov = await src.overview(TH.tender);
    expect(ov.value.cachedGrandTotal).toBeNull();
    expect(src.missingFields()).toMatchObject({ 'overview.cached_grand_total': 1, 'overview.usd_rate': 1 });
  });

  it('зацикленный курсор постраничного маршрута — CONTRACT_MISMATCH, а не бесконечная выгрузка', async () => {
    const page = `{"data":[],"next_cursor":"abc"}`;
    expect(await failure(source([page, page, page]).positions(TH.tender))).toMatchObject({ code: 'CONTRACT_MISMATCH', message: expect.stringMatching(/зациклены/u) });
  });
});
