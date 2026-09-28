// Этап 06: сценарий live-smoke TenderHub (U-04, дополнен по решению после ревью 06-pre-1) проверен против
// поддельного сервера — чтобы после выдачи ключа один запуск собрал доказательства для Review 06-1.
// Живым прогоном это не является: статус остаётся VERIFIED_FIXTURE, live-smoke — NOT_RUN до U-04.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeItem, n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { maskUuids, newSensitive, pathTemplate, redactLines, type ICallObs } from '../scripts/tenderhub-live-smoke-observe.ts';
import { paginationOf, requestLines } from '../scripts/tenderhub-live-smoke-report.ts';
import { PRECISE_RATE, standardTender, TH, TH_KEY } from './calculationFixtures.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OTHER_TENDER = '7d1f0c8e-1111-4a6b-9c1d-0000000000ff';
let hub: IFakeTenderHub;
let dir: string;

beforeAll(async () => {
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  dir = mkdtempSync(join(tmpdir(), 'kontur-th-live-'));
});
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  hub.tenders.clear();
  hub.tenders.set(TH.tender, standardTender());
  hub.tenders.set(OTHER_TENDER, standardTender(OTHER_TENDER, 'TH-2026-099'));
  hub.pageSize = 200;
  hub.repeatCursor = false;
  hub.allowedTenders = null;
  hub.specOmitFields = [];
  hub.beforeResponse = null;
  hub.requests.length = 0;
});

// Окружение процесса — только переменные TenderHub: без БД, без .env и прочей конфигурации портала.
const run = (env: Record<string, string>, tender: string, name: string): Promise<{ code: number | null; out: string; log: string }> =>
  new Promise((done) => {
    const out = join(dir, `${name}.log`);
    const p = spawn(process.execPath, ['scripts/tenderhub-live-smoke.ts', '--tender', tender, '--out', out], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env } });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('close', (code) => {
      let log = '';
      try {
        log = readFileSync(out, 'utf8');
      } catch {
        // журнал не записан
      }
      done({ code, out: text, log });
    });
  });
const live = (name: string, tender = TH.tender) => run({ TENDERHUB_URL: hub.url, TENDERHUB_API_KEY: TH_KEY }, tender, name);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// Строка журнала: отметка, ключ и начало значения (или заметки) — без привязки к остальному тексту.
const expectLine = (log: string, mark: string, key: string, rest: string): void => {
  expect(log).toMatch(new RegExp(`^${mark} +${esc(key)} = ${esc(rest)}`, 'mu'));
};

// Значения эталонного тендера, которых не должно быть ни в журнале, ни в выводе.
const TENDER_VALUES = ['ЖК «Северный»', 'ООО «Заказчик»', 'TH-2026-001', 'Бетонирование', 'Устройство гидроизоляции', 'класс бетона по проекту', 'по факту вывоза', 'Бетон B30', '1500.75', '1860.9', '1800.9', PRECISE_RATE, '7.97211155378486', TH.tender, TH.p1, TH.l1];

describe('live-smoke TenderHub (U-04) — сценарии на поддельном сервере', () => {
  it('без адреса и ключа — NOT_RUN с кодом 3, запросов нет', async () => {
    const r = await run({}, TH.tender, 'not-run');
    expect(r.code, r.out).toBe(3);
    expectLine(r.log, 'INFO', 'tenderhub', 'NOT_RUN');
    expect(r.log).toMatch(/TENDERHUB_API_KEY не задан/u);
    expect(r.log).toMatch(/^Итог: NOT_RUN$/mu);
    expect(hub.requests).toHaveLength(0);
  });

  it('обычный тендер на одну страницу: доступ, только GET, пробный обход, with-costs, BOQ, согласованность, числа, Q-05; журнал без ключа и данных', async () => {
    const r = await live('pass');
    expect(r.code, r.out).toBe(0);
    expectLine(r.log, 'PASS', 'auth_x_api_key', 'PASS — overview: HTTP 200 по заголовку X-API-Key');
    expectLine(r.log, 'PASS', 'authorization_header_requests', '0');
    expectLine(r.log, 'PASS', 'x_api_key_header', '9/9');
    expectLine(r.log, 'INFO', 'api_contract', 'OpenAPI 3.1.0, info.version 1.0.0-fake');
    expectLine(r.log, 'PASS', 'openapi_paths', '5/5');
    // Только GET: счёт по наблюдению транспорта и сверка с журналом сервера.
    expectLine(r.log, 'PASS', 'non_GET_requests', '0');
    expect(r.log).toMatch(/^INFO +request = capture: GET \/api\/v1\/tenders\/\{id\}\/positions\/with-costs ×1 — HTTP 200$/mu);
    expect(hub.requests.every((q) => q.method === 'GET' && q.apiKey === TH_KEY && q.authorization === undefined)).toBe(true);
    // Одна страница рабочей выгрузки — честно NOT_OBSERVED; курсор проверяется пробным обходом.
    expectLine(r.log, 'INFO', 'positions_pages', '1');
    expectLine(r.log, 'INFO', 'pagination_multi_page', 'NOT_OBSERVED');
    expect(r.log).toMatch(/^PASS +pagination_probe = PASS — limit=2: страниц 2 \(2, 2\), курсор #[0-9a-f]{8} → нет; уникальных 4 из 4/mu);
    expectLine(r.log, 'PASS', 'with_costs_no_cache_sent', 'PASS');
    expectLine(r.log, 'INFO', 'with_costs_items', '4');
    expectLine(r.log, 'PASS', 'with_costs_ids_match_positions', 'PASS');
    expectLine(r.log, 'PASS', 'common_fields_mismatch', '0');
    expectLine(r.log, 'INFO', 'boq_lines', '3');
    expectLine(r.log, 'PASS', 'orphan_lines', '0');
    expectLine(r.log, 'PASS', 'items_count_check', 'PASS');
    for (const key of ['before_after_stable', 'positions_cross_check', 'boq_count_check', 'duplicate_check', 'updated_at_check']) expectLine(r.log, 'PASS', key, 'PASS');
    expectLine(r.log, 'PASS', 'consistency', 'consistent');
    expectLine(r.log, 'PASS', 'numeric_contract', 'PASS');
    expect(r.log).toMatch(/^INFO +numeric\.boq_items_full = числовых полей: \d+ — экспонентная запись: quantity;/mu);
    expectLine(r.log, 'INFO', 'q05.cached_grand_total', 'present');
    for (const key of ['q05.insurance', 'q05.reduction', 'q05.redistribution']) expectLine(r.log, 'INFO', key, 'absent');
    expectLine(r.log, 'INFO', 'q05.kp_total', 'не определяется');
    expectLine(r.log, 'INFO', 'contract_discrepancies', '0');
    expectLine(r.log, 'INFO', 'integration_status', 'VERIFIED_FIXTURE → кандидат VERIFIED_LIVE');
    expectLine(r.log, 'PASS', 'log_redaction', 'PASS');
    expect(r.log).toMatch(/^Итог: PASS$/mu);
    // Маскирование: ключа, значений и полных uuid тендера нет ни в журнале, ни в выводе.
    for (const text of [r.log, r.out]) {
      expect(text).not.toContain(TH_KEY);
      for (const v of TENDER_VALUES) expect(text, v).not.toContain(v);
    }
    expect(r.log).toContain('tender_id = 7d1f0c8e-…-0001');
  });

  it('несколько страниц: курсор сменяется и выдан следующей странице, повторов и дублей нет — pagination_multi_page = PASS', async () => {
    hub.pageSize = 2;
    const r = await live('pages');
    expect(r.code, r.out).toBe(0);
    expectLine(r.log, 'INFO', 'positions_pages', '2 — limit=200; строк по страницам: 2, 2');
    expect(r.log).toMatch(/^INFO +positions_next_cursor = #[0-9a-f]{8} → нет/mu);
    expectLine(r.log, 'PASS', 'cursor_followed', 'PASS');
    expectLine(r.log, 'PASS', 'cursor_repeated', '0');
    expectLine(r.log, 'INFO', 'positions_unique_ids', '4');
    expectLine(r.log, 'PASS', 'pagination_multi_page', 'PASS');
    expectLine(r.log, 'INFO', 'pagination_probe', 'SKIPPED — рабочая выгрузка уже многостраничная');
    // Курсор — только хэш-меткой: значение (base64 смещения) в журнал не попадает.
    expect(r.log).not.toContain(Buffer.from('2', 'utf8').toString('base64url') + ' ');
  });

  it('несоответствие positions и with-costs: общее поле изменилось между маршрутами — FAIL с именем поля, без значения', async () => {
    let changed = false;
    hub.beforeResponse = (route) => {
      if (route !== 'positions_with_costs' || changed) return;
      changed = true;
      hub.tenders.get(TH.tender)!.positions.find((p) => p.id === TH.p1)!.work_name = 'Изменённое наименование работы';
    };
    const r = await live('mismatch');
    expect(r.code, r.out).toBe(1);
    expectLine(r.log, 'PASS', 'with_costs_ids_match_positions', 'PASS');
    expectLine(r.log, 'FAIL', 'common_fields_mismatch', '1 — поля: work_name');
    expectLine(r.log, 'FAIL', 'positions_cross_check', 'FAIL — position_changed_between_routes');
    expectLine(r.log, 'FAIL', 'consistency', 'inconsistent');
    expect(r.log).not.toContain('Изменённое наименование работы');
    expect(r.log).toMatch(/^Итог: FAIL$/mu);
  });

  it('строка BOQ без известной позиции — orphan_lines = 1, согласованность inconsistent', async () => {
    hub.tenders.get(TH.tender)!.items.push(fakeItem(TH.tender, '7d1f0c8e-2222-4a6b-9c1d-0000000000ee', '7d1f0c8e-3333-4a6b-9c1d-0000000000ee', { boq_item_type: 'мат' }));
    const r = await live('orphan');
    expect(r.code, r.out).toBe(1);
    expectLine(r.log, 'INFO', 'boq_lines', '4');
    expectLine(r.log, 'INFO', 'boq_known_position_refs', '3');
    expectLine(r.log, 'FAIL', 'orphan_lines', '1');
    expectLine(r.log, 'FAIL', 'consistency', 'inconsistent — причины: item_without_position');
  });

  it('повтор курсора: адаптер останавливает обход — cursor_repeated = DETECTED, выгрузка FAIL, расхождение схемы по positions', async () => {
    hub.pageSize = 2;
    hub.repeatCursor = true;
    const r = await live('repeat');
    expect(r.code, r.out).toBe(1);
    expectLine(r.log, 'FAIL', 'capture', 'FAIL — CONTRACT_MISMATCH/contract_mismatch: positions: курсор повторился');
    expectLine(r.log, 'FAIL', 'cursor_repeated', 'DETECTED (1)');
    expectLine(r.log, 'FAIL', 'pagination_multi_page', 'FAIL — повтор курсора');
    expectLine(r.log, 'INFO', 'pagination_probe', 'SKIPPED — выгрузка не завершилась');
    expect(r.log).toMatch(/^INFO +diff = schema — route positions; .*фактически: CONTRACT_MISMATCH\/contract_mismatch: positions: курсор повторился/mu);
    expectLine(r.log, 'INFO', 'consistency', 'NOT_AVAILABLE');
    expectLine(r.log, 'INFO', 'numeric_contract', 'NOT_AVAILABLE');
  });

  it('шапка изменилась во время выгрузки — before_after_stable = FAIL с именем признака, без значения', async () => {
    let overviews = 0;
    hub.beforeResponse = (route) => {
      if (route !== 'overview') return;
      overviews += 1;
      if (overviews === 2) hub.tenders.get(TH.tender)!.cached_grand_total = n('1999.99');
    };
    const r = await live('overview-change');
    expect(r.code, r.out).toBe(1);
    expectLine(r.log, 'FAIL', 'before_after_stable', 'FAIL — различаются: cachedGrandTotal');
    expectLine(r.log, 'FAIL', 'consistency', 'inconsistent — причины: markers_changed');
    expect(r.log).not.toContain('1999.99');
  });

  it('отсутствующее необязательное поле — расхождение field_absent по обоим маршрутам, итог PASS', async () => {
    for (const p of hub.tenders.get(TH.tender)!.positions) delete p.client_note;
    const r = await live('absent-field');
    expect(r.code, r.out).toBe(0);
    expectLine(r.log, 'INFO', 'contract_discrepancies', '2');
    expect(r.log).toMatch(/^INFO +diff = field_absent — route positions; .*нет в строках: client_note ×4$/mu);
    expect(r.log).toMatch(/^INFO +diff = field_absent — route positions_with_costs; .*нет в строках: client_note ×4$/mu);
    expect(r.log).toMatch(/^Итог: PASS$/mu);
  });

  it('неожиданная форма ответа: overview без конверта data — FAIL, класс схемы и маршрут в расхождениях, доступ по ключу подтверждён', async () => {
    hub.beforeResponse = (route) => (route === 'overview' ? { kind: 'json', body: '{"items":{}}' } : undefined);
    const r = await live('schema');
    expect(r.code, r.out).toBe(1);
    expectLine(r.log, 'PASS', 'auth_x_api_key', 'PASS');
    expectLine(r.log, 'FAIL', 'capture', 'FAIL — CONTRACT_MISMATCH/contract_mismatch: ответ overview без конверта');
    expect(r.log).toMatch(/^INFO +diff = schema — route overview; ожидалось: HTTP 200, \{"data": \{шапка тендера\}\}; фактически: CONTRACT_MISMATCH/mu);
    expectLine(r.log, 'INFO', 'q05.cached_grand_total', 'endpoint unavailable');
    expectLine(r.log, 'INFO', 'with_costs_available', 'NOT_AVAILABLE');
  });

  it('тендер вне списка ключа — FAIL: 403 с машинным кодом ошибки и именами полей RFC 7807', async () => {
    hub.allowedTenders = [TH.tender];
    const r = await live('forbidden', OTHER_TENDER);
    expect(r.code, r.out).toBe(1);
    expectLine(r.log, 'FAIL', 'auth_x_api_key', 'FAIL — overview: HTTP 403 API_KEY_TENDER_DENIED');
    expect(r.log).toMatch(/^INFO +diff = http_status — route overview; .*фактически: HTTP 403, application\/problem\+json; поля ошибки: code, status, title, type; code API_KEY_TENDER_DENIED$/mu);
    expectLine(r.log, 'FAIL', 'capture', 'FAIL — FORBIDDEN/forbidden_tender');
    expect(r.log).not.toContain(TH_KEY);
  });

  it('неверный ключ — FAIL с HTTP 401; ключ не печатается', async () => {
    const wrong = 'thk_wrong_0000000000000000';
    const r = await run({ TENDERHUB_URL: hub.url, TENDERHUB_API_KEY: wrong }, TH.tender, 'auth');
    expect(r.code, r.out).toBe(1);
    expectLine(r.log, 'FAIL', 'auth_x_api_key', 'FAIL — overview: HTTP 401');
    expectLine(r.log, 'FAIL', 'capture', 'FAIL — AUTH_FAILED/auth_failed');
    expect(`${r.log}${r.out}`).not.toContain(wrong);
  });
});

describe('live-smoke: маскирование и разбор наблюдений', () => {
  it('строка, совпавшая с ключом, строкой или числом тендера, скрывается; счётчики и хэши остаются', () => {
    const s = newSensitive();
    s.strings.add('Бетон B30');
    s.numbers.add('1500.75');
    const lines = ['INFO  a = 3 — строк 3', 'INFO  b = Бетон B30', 'INFO  c = 1500.75', 'INFO  d = ключ thk_secret_123456', 'INFO  e = SHA-256 abc1500.75def'];
    const r = redactLines(lines, s, ['thk_secret_123456']);
    expect(r.redacted).toBe(3);
    expect(r.kinds.sort()).toEqual(['секрет', 'строка данных тендера', 'число данных тендера']);
    expect(r.lines[0]).toBe(lines[0]);
    expect(r.lines[4]).toBe(lines[4]);
    expect(r.lines.join('\n')).not.toMatch(/Бетон B30|1500\.75 |thk_secret/u);
  });

  it('uuid маскируются, путь — без идентификаторов, курсора и поискового значения', () => {
    expect(maskUuids(`тендер ${TH.tender}, позиция ${TH.p1}`)).toBe('тендер 7d1f0c8e-…-0001, позиция 7d1f0c8e-…-0001');
    expect(pathTemplate(new URL(`http://h/api/v1/tenders/${TH.tender}/positions?limit=200&cursor=MjAw`))).toBe('/api/v1/tenders/{id}/positions?limit=200&cursor=…');
    expect(pathTemplate(new URL('http://h/api/v1/tenders/brief?search=TH-2026-001'))).toBe('/api/v1/tenders/brief?search=…');
  });

  const call = (o: Partial<ICallObs>): ICallObs => ({
    phase: 'capture',
    method: 'GET',
    route: 'positions',
    path: '/p',
    apiKeyHeader: true,
    authorizationHeader: false,
    cookieHeader: false,
    noCache: false,
    acceptGzip: true,
    cursor: null,
    status: 200,
    networkError: null,
    contentType: 'application/json',
    contentEncoding: null,
    headers: {},
    page: null,
    problem: null,
    ...o,
  });

  it('запрос не-GET в наблюдении даёт non_GET_requests = 1 и FAIL', () => {
    const lines = requestLines([call({}), call({ method: 'POST', route: 'other' })]);
    expect(lines[0]).toMatchObject({ mark: 'FAIL', key: 'non_GET_requests', value: '1', note: 'методы: POST' });
  });

  it('разбор страниц: повтор курсора, дубли и обход не по курсору обнаруживаются', () => {
    const p = paginationOf([
      call({ page: { rows: 2, ids: ['a', 'b'], nextCursor: 'X' } }),
      call({ cursor: 'X', page: { rows: 2, ids: ['b', 'c'], nextCursor: 'X' } }),
    ]);
    expect(p).toMatchObject({ requests: 2, repeated: 1, duplicates: 1, followed: true, terminated: false });
    expect(paginationOf([call({ page: { rows: 1, ids: ['a'], nextCursor: 'X' } }), call({ cursor: 'Y', page: { rows: 1, ids: ['b'], nextCursor: null } })]).followed).toBe(false);
  });
});
