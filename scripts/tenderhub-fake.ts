// Поддельный TenderHub по контракту архива ApiTenderHub (2026-09-02) и OpenAPI archive.yaml: конверт
// {"data": …}, курсор next_cursor у позиций (порядок updated_at DESC), gzip по Accept-Encoding, ошибки
// RFC 7807 с code, заголовок X-API-Key. Числа в ответах — сырые лексемы (как у Go float64 и длиннее),
// чтобы проверять точность разбора. Только для тестов, smoke и ui-check: рабочей интеграцией не является.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { isNum, n, toJson, type FakeRow, type IFakeTender, type Json } from './tenderhub-fake-data.ts';

export * from './tenderhub-fake-data.ts';

export interface IFakeRequest {
  method: string;
  path: string;
  apiKey: string | undefined;
  authorization: string | undefined;
  acceptEncoding: string | undefined;
  cacheControl: string | undefined;
}

// Вмешательство в ответ: статус с кодом RFC 7807, обрыв соединения, «прокси» с HTML, задержка.
export type FakeFault =
  | { kind: 'status'; status: number; code?: string; detail?: string }
  | { kind: 'drop' }
  | { kind: 'html' }
  | { kind: 'delay'; ms: number };

export interface IFakeTenderHub {
  url: string;
  apiKey: string;
  tenders: Map<string, IFakeTender>;
  requests: IFakeRequest[];
  // Страница позиций не больше этого числа строк, даже если клиент просит 200.
  pageSize: number;
  gzip: boolean;
  scope: 'tenders:read' | 'none';
  allowedTenders: string[] | null;
  // Поля, которых нет в живой спецификации OpenAPI (сверка сборки с документацией, R-06).
  specOmitFields: string[];
  // Вызывается перед ответом: тест меняет данные посреди выгрузки или назначает отказ.
  beforeResponse: ((route: string, req: IFakeRequest, callNo: number) => FakeFault | void) | null;
  close: () => Promise<void>;
}

const ROUTES: [string, RegExp][] = [
  ['openapi', /^\/api\/v1\/archive\/openapi\.yaml$/u],
  ['brief', /^\/api\/v1\/tenders\/brief$/u],
  ['overview', /^\/api\/v1\/tenders\/([0-9a-f-]{36})\/overview$/u],
  ['positions_with_costs', /^\/api\/v1\/tenders\/([0-9a-f-]{36})\/positions\/with-costs$/u],
  ['positions', /^\/api\/v1\/tenders\/([0-9a-f-]{36})\/positions$/u],
  ['boq_items_full', /^\/api\/v1\/tenders\/([0-9a-f-]{36})\/boq-items-full$/u],
];

const briefRow = (t: IFakeTender): FakeRow => ({
  id: t.id,
  tender_number: t.tender_number,
  title: t.title,
  client_name: t.client_name,
  version: t.version === null ? null : n(String(t.version)),
  is_archived: t.is_archived,
  housing_class: t.housing_class,
  construction_scope: t.construction_scope,
  submission_deadline: t.submission_deadline,
  updated_at: t.updated_at,
});

const overviewRow = (t: IFakeTender): FakeRow => ({
  id: t.id,
  tender_number: t.tender_number,
  title: t.title,
  client_name: t.client_name,
  housing_class: t.housing_class,
  construction_scope: t.construction_scope,
  is_archived: t.is_archived,
  cached_grand_total: t.cached_grand_total,
  usd_rate: t.usd_rate,
  eur_rate: t.eur_rate,
  cny_rate: t.cny_rate,
  position_count: n(String(t.positions.length)),
  boq_item_count: n(String(t.items.length)),
  created_at: t.created_at,
  updated_at: t.updated_at,
});

// Поля позиции постраничного маршрута: общие плюс признаки раздела и категория затрат.
const PAGED_ONLY = ['section_number', 'position_name', 'is_section', 'cost_category_id', 'cost_category_name'];
const COSTS_ONLY = [
  'material_cost_per_unit',
  'work_cost_per_unit',
  'total_commercial_material',
  'total_commercial_work',
  'total_commercial_material_per_unit',
  'total_commercial_work_per_unit',
  'rich_runs',
  'base_total',
  'commercial_total',
  'material_cost_total',
  'work_cost_total',
  'markup_percentage',
  'items_count',
];

const pick = (row: FakeRow, drop: string[]): FakeRow => Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)));

// Живая спецификация (README: GET /api/v1/archive/openapi.yaml): пути маршрутов чтения и имена полей строк.
const openApiYaml = (tenders: IFakeTender[], omit: string[]): string => {
  const fields = new Set<string>();
  const walk = (o: FakeRow, depth: number): void => {
    for (const [k, v] of Object.entries(o)) {
      fields.add(k);
      if (v && typeof v === 'object' && !isNum(v) && !Array.isArray(v) && depth < 2) walk(v, depth + 1);
    }
  };
  for (const t of tenders) {
    walk(briefRow(t), 0);
    walk(overviewRow(t), 0);
    for (const row of [...t.positions, ...t.items]) walk(row, 0);
  }
  const paths = ['/api/v1/tenders/brief', ...['overview', 'positions', 'positions/with-costs', 'boq-items-full'].map((r) => `/api/v1/tenders/{id}/${r}`)];
  return [
    'openapi: 3.1.0',
    'info:',
    '  title: TenderHUB machine API (поддельная сборка)',
    '  version: 1.0.0-fake',
    'paths:',
    ...paths.flatMap((p) => [`  ${p}:`, '    get: {}']),
    'components:',
    '  schemas:',
    '    Row:',
    '      type: object',
    '      properties:',
    ...[...fields].filter((f) => !omit.includes(f)).sort().flatMap((f) => [`        ${f}:`, '          type: string']),
    '',
  ].join('\n');
};

const numText = (v: Json): string => (isNum(v) ? v.__num : typeof v === 'string' ? v : '0');

export const startFakeTenderHub = async (o: { apiKey: string }): Promise<IFakeTenderHub> => {
  const state: Omit<IFakeTenderHub, 'url' | 'close'> = {
    apiKey: o.apiKey,
    tenders: new Map(),
    requests: [],
    pageSize: 200,
    gzip: true,
    scope: 'tenders:read',
    allowedTenders: null,
    specOmitFields: [],
    beforeResponse: null,
  };
  let callNo = 0;

  const send = (req: IncomingMessage, res: ServerResponse, status: number, body: string, contentType = 'application/json'): void => {
    const buf = Buffer.from(body, 'utf8');
    const gz = state.gzip && /gzip/u.test(req.headers['accept-encoding'] ?? '');
    const out = gz ? gzipSync(buf) : buf;
    res.writeHead(status, { 'Content-Type': contentType, ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': out.length });
    res.end(out);
  };
  const problem = (req: IncomingMessage, res: ServerResponse, status: number, title: string, code?: string, detail?: string): void =>
    send(req, res, status, JSON.stringify({ type: 'about:blank', title, status, ...(code ? { code } : {}), ...(detail ? { detail } : {}) }), 'application/problem+json');

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const r: IFakeRequest = {
        method: req.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        apiKey: req.headers['x-api-key'] as string | undefined,
        authorization: req.headers.authorization,
        acceptEncoding: req.headers['accept-encoding'],
        cacheControl: req.headers['cache-control'] as string | undefined,
      };
      state.requests.push(r);
      callNo += 1;
      const match = ROUTES.map(([name, re]) => ({ name, m: re.exec(url.pathname) })).find((x) => x.m);
      // Порядок проверок как у TenderHub: заголовок ключа → ключ → область → тендер → маршрут.
      if (!r.apiKey) {
        problem(req, res, 401, 'Unauthorized', undefined, 'invalid or expired token');
        return;
      }
      if (r.apiKey !== state.apiKey) {
        problem(req, res, 401, 'Unauthorized', undefined, 'invalid API key');
        return;
      }
      if (req.method !== 'GET' || !match) {
        problem(req, res, 404, 'Not Found');
        return;
      }
      const fault = state.beforeResponse?.(match.name, r, callNo);
      if (fault?.kind === 'drop') {
        req.socket.destroy();
        return;
      }
      if (fault?.kind === 'html') {
        send(req, res, 200, '<html><body>Bad Gateway</body></html>', 'text/html');
        return;
      }
      if (fault?.kind === 'delay') await new Promise((w) => setTimeout(w, fault.ms));
      if (fault?.kind === 'status') {
        problem(req, res, fault.status, 'Error', fault.code, fault.detail);
        return;
      }
      if (match.name === 'openapi') {
        send(req, res, 200, openApiYaml([...state.tenders.values()], state.specOmitFields), 'application/yaml');
        return;
      }
      if (state.scope !== 'tenders:read') {
        problem(req, res, 403, 'Forbidden', 'API_KEY_SCOPE_DENIED', 'tenders:read');
        return;
      }
      const tenderId = match.m![1];
      if (tenderId && state.allowedTenders && !state.allowedTenders.includes(tenderId)) {
        problem(req, res, 403, 'Forbidden', 'API_KEY_TENDER_DENIED');
        return;
      }
      if (match.name === 'brief') {
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const rows = [...state.tenders.values()]
          .filter((t) => !state.allowedTenders || state.allowedTenders.includes(t.id))
          .filter((t) => !search || [t.title, t.client_name, t.tender_number].some((s) => s.toLowerCase().includes(search)))
          .map(briefRow);
        send(req, res, 200, toJson({ data: rows }));
        return;
      }
      const t = state.tenders.get(tenderId!);
      if (!t) {
        problem(req, res, 404, 'Not Found', 'NOT_FOUND', 'tender not found');
        return;
      }
      if (match.name === 'overview') {
        send(req, res, 200, toJson({ data: overviewRow(t) }));
        return;
      }
      if (match.name === 'positions_with_costs') {
        const rows = [...t.positions].sort((a, b) => Number(numText(a.position_number!)) - Number(numText(b.position_number!))).map((p) => pick(p, PAGED_ONLY));
        send(req, res, 200, toJson({ data: rows }));
        return;
      }
      if (match.name === 'positions') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200, state.pageSize);
        const offset = url.searchParams.get('cursor') ? Number(Buffer.from(url.searchParams.get('cursor')!, 'base64url').toString('utf8')) : 0;
        const ordered = [...t.positions].sort((a, b) => {
          const ua = String(a.updated_at);
          const ub = String(b.updated_at);
          return ua < ub ? 1 : ua > ub ? -1 : String(a.id) < String(b.id) ? 1 : -1;
        });
        const page = ordered.slice(offset, offset + limit).map((p) => pick(p, COSTS_ONLY));
        const next = offset + limit < ordered.length ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : undefined;
        send(req, res, 200, toJson({ data: page, next_cursor: next }));
        return;
      }
      const items = [...t.items].sort((a, b) => Number(numText(a.sort_number ?? n('0'))) - Number(numText(b.sort_number ?? n('0'))));
      send(req, res, 200, toJson({ data: items }));
    })().catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const hub = state as IFakeTenderHub;
  hub.url = `http://127.0.0.1:${port}`;
  hub.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return hub;
};
