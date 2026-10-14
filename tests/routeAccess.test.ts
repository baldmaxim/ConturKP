// Этап 17 (проект §9, I13, A25): серверные права по всем маршрутам. Маршруты перечисляются из стека Express и
// сверяются с инвентарём в обе стороны; генерируемые проходы:
//   аноним и токен чат-клиента без cookie — 401 на всём, кроме открытых точек;
//   неназначенный инженер на объектах чужого тендера — только 400/401/403/404, никогда 2xx, 409 или 5xx;
//   инженер тендера на действиях руководителя — 403;
//   после всех проходов данные БД (кроме журнала отказов) и хранилище не изменились.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../apps/server/src/app.ts';
import { buildStage14, closeStage14, type IStage14 } from './deliveryFixtures.ts';
import { Clock, idem, ORIGIN, TestClient } from './helpers.ts';
import { ROUTE_INVENTORY } from './routeInventory.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 900_000 });

// Открытые точки: проверка готовности и вход.
const PUBLIC = new Set(['GET /api/v1/health', 'GET /api/v1/ready', 'POST /api/v1/auth/login']);
// Действия над собственной сессией — в проходах с сессией не участвуют (клиент разлогинился бы посреди прохода).
const OWN_SESSION = new Set(['POST /api/v1/auth/logout', 'POST /api/v1/me/password', 'POST /api/v1/me/api-tokens']);

// Объекты тендера: путь с таким сегментом перед первым параметром принадлежит тендеру.
const TENDER_SCOPED = new Set([
  'tenders', 'stages', 'requirement-registries', 'releases', 'release-candidates', 'calculation-revisions', 'application-drafts', 'comparisons',
  'deliveries', 'requirement-candidates', 'findings', 'fact-candidates', 'document-revisions', 'requirements', 'send-events', 'release-comparisons',
  'release-comparison-items', 'recognition-runs', 'model-suggestions', 'mcp-proposals', 'intake-channels', 'field-suggestions', 'facts', 'documents',
  'discrepancies', 'comparison-units', 'change-reason-suggestions', 'assumptions', 'source-set-revisions', 'search-runs', 'review-runs',
  'requirement-revisions', 'reason-runs', 'qa-threads', 'negotiation-sessions', 'jobs', 'imports', 'import-items', 'holds', 'field-suggestion-runs',
  'evidence', 'evidence-scopes', 'evidence-facts', 'customer-questions', 'compliance-incidents', 'candidate-files', 'calculation-captures',
  'approvals', 'answer-runs', 'analysis-runs', 'dialogs',
]);

// Сегмент пути → таблица (исключения из правила «множественное → единственное»).
const TABLE: Record<string, string> = {
  stages: 'tender_stage',
  evidence: 'evidence_fragment',
  imports: 'import_batch',
  holds: 'readiness_hold',
  comparisons: 'calculation_comparison',
  facts: 'evidence_fact',
  members: 'app_user',
  access: 'app_user',
  users: 'app_user',
  'contract-creators': 'app_user',
  dialogs: 'dialog',
  'tender-links': 'tender',
  assumptions: 'requirement',
};
const singular = (seg: string): string => {
  const base = seg.replace(/ies$/u, 'y').replace(/(ss|x|ch|sh)es$/u, '$1').replace(/s$/u, '');
  return base.replaceAll('-', '_');
};

// Действия руководителя тендера: инженер тендера получает 403 (I13, A25).
const MANAGER_ONLY = [
  'POST /api/v1/tenders/:id/stages',
  'POST /api/v1/stages/:id/requirement-registries',
  'POST /api/v1/requirement-registries/:id/reviews',
  'POST /api/v1/requirements/:id/supersede',
  'POST /api/v1/requirements/:id/decisions',
  'POST /api/v1/requirement-revisions/:id/coverage',
  'POST /api/v1/facts/:id/supersede',
  'POST /api/v1/discrepancies/:id/decisions',
  'POST /api/v1/release-candidates/:id/approve',
  'POST /api/v1/release-candidates/:id/return',
  'POST /api/v1/release-candidates/:id/risk-acceptances',
  'POST /api/v1/release-candidates/:id/holds/resolve',
  'POST /api/v1/approvals/:id/revoke',
  'POST /api/v1/holds/:id/resolve',
];

const enumerate = (app: unknown): string[] => {
  const out: string[] = [];
  const MOUNTS = ['/api/v1', '/mcp', '/api'];
  type Layer = { route?: { path: unknown; methods: Record<string, boolean> }; handle?: { stack?: Layer[] }; slash?: boolean; matchers?: Array<(p: string) => { path: string } | false> };
  const walk = (stack: Layer[], prefix: string): void => {
    for (const l of stack) {
      if (l.route) {
        // Запасной маршрут интерфейса (RegExp) — не API.
        if (typeof l.route.path !== 'string') continue;
        for (const m of Object.keys(l.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${l.route.path}`);
        continue;
      }
      if (Array.isArray(l.handle?.stack)) {
        const p = l.slash ? '' : MOUNTS.find((c) => (l.matchers ?? []).some((f) => { const x = f(`${c}/__probe__`); return x !== false && x.path === c; }));
        if (p === undefined) throw new Error('неизвестная точка монтирования роутера');
        walk(l.handle.stack, prefix + p);
      }
    }
  };
  walk((app as { router: { stack: Layer[] } }).router.stack, '');
  return out;
};

let s: IStage14;
let app: ReturnType<typeof createApp>;
let routes: string[] = [];
const ids = new Map<string, string | null>();
let tenderA = '';

// Объект тендера A для сегмента пути; null — объекта такого вида в данных нет (подставляется случайный UUID).
const idFor = async (seg: string): Promise<string | null> => {
  if (ids.has(seg)) return ids.get(seg)!;
  const table = TABLE[seg] ?? singular(seg);
  let id: string | null = null;
  const exists = await s.st.db.pool.query<{ t: string | null; tender: boolean }>(
    `SELECT to_regclass($1)::text AS t, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = $2 AND column_name = 'tender_id') AS tender`,
    [`public.${table}`, table],
  );
  if (table === 'app_user') id = s.st.e.s.ids.eng1;
  else if (table === 'tender') id = tenderA;
  else if (exists.rows[0]?.t) {
    const where = exists.rows[0].tender ? 'WHERE tender_id = $1' : 'WHERE $1::uuid IS NOT NULL';
    const r = await s.st.db.pool.query<{ id: string }>(`SELECT id::text FROM ${table} ${where} LIMIT 1`, [tenderA]).catch(() => ({ rows: [] as Array<{ id: string }> }));
    id = r.rows[0]?.id ?? null;
  }
  ids.set(seg, id);
  return id;
};

const fill = async (path: string): Promise<{ url: string; real: boolean }> => {
  const parts = path.split('/');
  let real = true;
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]!.startsWith(':')) continue;
    if (parts[i] === ':key') {
      parts[i] = 'kp_price';
      continue;
    }
    const id = await idFor(parts[i - 1]!);
    if (!id) real = false;
    parts[i] = id ?? randomUUID();
  }
  return { url: parts.join('/'), real };
};

const firstCollection = (path: string): string | null => {
  const parts = path.replace('/api/v1/', '').split('/');
  const i = parts.findIndex((p) => p.startsWith(':'));
  return i > 0 ? parts[i - 1]! : null;
};

const send = (client: TestClient | null, method: string, url: string, o: { body?: unknown; bearer?: string } = {}) => {
  const m = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const headers: Record<string, string> = { ...idem(), ...(o.bearer ? { Authorization: `Bearer ${o.bearer}` } : {}) };
  if (client) return client.req(m, url, { headers, ...(m === 'get' ? {} : { body: o.body ?? {} }) });
  let r = request(app)[m](url).set(headers);
  if (m !== 'get') r = r.set('Origin', ORIGIN).send((o.body ?? {}) as object);
  return r;
};

// Отпечаток данных: число строк каждой таблицы (кроме журнала событий и сессий) и файлов хранилища.
const digest = async (): Promise<string> => {
  const tables = (
    await s.st.db.pool.query<{ t: string }>(
      "SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT IN ('audit_event', 'session', 'process_heartbeat') ORDER BY 1",
    )
  ).rows.map((r) => r.t);
  const counts = await s.st.db.pool.query<{ t: string; n: number }>(tables.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '));
  const files = (dir: string): number => {
    let n = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? files(join(dir, e.name)) : 1;
    return n;
  };
  return JSON.stringify({ rows: counts.rows.sort((a, b) => a.t.localeCompare(b.t)), files: files(join(s.st.e.config.storageRoot, 'sha256')) });
};

beforeAll(async () => {
  s = await buildStage14();
  tenderA = s.st.e.s.tenderA;
  app = createApp({ config: s.st.e.config, pool: s.st.db.pool, clock: new Clock().read, logError: () => undefined });
  routes = enumerate(app);
});
afterAll(async () => closeStage14(s));

describe('инвентарь маршрутов', () => {
  it('перечисленные маршруты совпадают с инвентарём в обе стороны; перечисление видит все роутеры', () => {
    expect(routes.length).toBeGreaterThanOrEqual(260);
    expect(new Set(routes).size).toBe(routes.length);
    expect([...routes].filter((r) => !ROUTE_INVENTORY.includes(r))).toEqual([]);
    expect([...ROUTE_INVENTORY].filter((r) => !routes.includes(r))).toEqual([]);
    for (const known of ['GET /api/v1/ready', 'POST /api/v1/release-candidates/:id/approve', 'GET /api/v1/admin/operations', 'GET /api/v1/integrations/status']) expect(routes).toContain(known);
  });
});

describe('проходы прав по всем маршрутам', () => {
  let before = '';
  beforeAll(async () => {
    before = await digest();
  });

  it('аноним: 401 на всём, кроме открытых точек', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      if (PUBLIC.has(r)) continue;
      const [method, path] = r.split(' ') as [string, string];
      const { url } = await fill(path);
      const res = await send(null, method, url);
      if (res.status !== 401) wrong.push(`${r} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('токен чат-клиента без cookie: API портала его не принимает — 401', async () => {
    const issued = await s.st.e.s.eng1.post('/me/api-tokens', { name: 'route-access', clientKind: 'codex', propose: true, lifetimeDays: 7 });
    expect(issued.status, issued.text).toBe(201);
    const token = (issued.body.token ?? issued.body.value) as string;
    expect(typeof token).toBe('string');
    const wrong: string[] = [];
    for (const r of routes) {
      if (PUBLIC.has(r)) continue;
      const [method, path] = r.split(' ') as [string, string];
      const { url } = await fill(path);
      const res = await send(null, method, url, { bearer: token });
      if (res.status !== 401) wrong.push(`${r} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('неназначенный инженер на объектах чужого тендера: только 400/401/403/404', async () => {
    const outsider = new TestClient(app);
    expect((await outsider.login('eng3')).status).toBe(200);
    const allowed = new Set([400, 401, 403, 404]);
    const wrong: string[] = [];
    let real = 0;
    let fake = 0;
    for (const r of routes) {
      if (PUBLIC.has(r) || OWN_SESSION.has(r)) continue;
      const [method, path] = r.split(' ') as [string, string];
      const col = firstCollection(path);
      const bodyScoped = r === 'POST /api/v1/search' || r === 'POST /api/v1/dialogs';
      if (!bodyScoped && (!col || !TENDER_SCOPED.has(col))) continue;
      const f = await fill(path);
      if (f.real) real += 1;
      else fake += 1;
      const body = bodyScoped ? { context: { kind: 'tender', tenderId: tenderA, mode: 'working', stageId: s.st.e.s.stageA }, query: 'Штукатурка', question: 'Штукатурка?', limit: 5 } : {};
      const res = await send(outsider, method, f.url, { body });
      if (!allowed.has(res.status)) wrong.push(`${r} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
    if (process.env.ROUTE_ACCESS_DEBUG) console.log('real', real, 'fake', fake, [...ids].filter(([, v]) => v === null).map(([k]) => k).join(' '));
    // Покрытие настоящими объектами тендера (убывающий порог по факту этапа 17): у 50 маршрутов в данных этапа 14 нет
    // объекта своего вида (поиск, диалоги, размещения, сравнения выпусков и др.) — для них подставлен случайный UUID,
    // отказ без успеха проверяется, но доказывает меньше.
    expect(real).toBeGreaterThanOrEqual(140);
    expect(fake).toBeLessThanOrEqual(50);
  });

  it('прочие изменяющие маршруты неназначенному инженеру без ролей и выдач не дают успеха', async () => {
    const outsider = new TestClient(app);
    await outsider.login('eng3');
    const wrong: string[] = [];
    for (const r of routes) {
      const [method, path] = r.split(' ') as [string, string];
      if (method === 'GET' || PUBLIC.has(r) || OWN_SESSION.has(r)) continue;
      const col = firstCollection(path);
      if (col && TENDER_SCOPED.has(col)) continue;
      if (r === 'POST /api/v1/search' || r === 'POST /api/v1/dialogs') continue;
      // Создание своего тендера, договора и т. п. проверяют сценарии этапов; здесь — только объекты по идентификатору.
      if (!col) continue;
      const res = await send(outsider, method, (await fill(path)).url);
      if (res.status < 400 || res.status === 409 || res.status >= 500) wrong.push(`${r} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('A25: инженер тендера на действиях руководителя — 403', async () => {
    const wrong: string[] = [];
    let real = 0;
    for (const r of MANAGER_ONLY) {
      expect(routes, r).toContain(r);
      const [method, path] = r.split(' ') as [string, string];
      const f = await fill(path);
      const res = await send(s.st.e.s.eng1, method, f.url);
      if (f.real) {
        real += 1;
        if (res.status !== 403) wrong.push(`${r} → ${res.status}`);
      } else if (res.status !== 404 && res.status !== 403) wrong.push(`${r} (нет объекта) → ${res.status}`);
    }
    expect(wrong).toEqual([]);
    expect(real).toBeGreaterThanOrEqual(8);
  });

  it('после всех проходов данные и хранилище не изменились (кроме журнала отказов)', async () => {
    const after = await digest();
    const a = JSON.parse(before) as { rows: Array<{ t: string; n: number }>; files: number };
    const b = JSON.parse(after) as { rows: Array<{ t: string; n: number }>; files: number };
    const changed = b.rows.filter((x) => a.rows.find((y) => y.t === x.t)?.n !== x.n).map((x) => x.t);
    // Выпуск токена в проходе 2 — законная запись самого инженера.
    expect(changed.filter((t) => t !== 'api_token')).toEqual([]);
    expect(b.files).toBe(a.files);
  });
});
