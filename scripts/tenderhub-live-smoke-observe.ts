// Наблюдение и маскирование для live-smoke TenderHub (этап 06, U-04; решение по ревью 06-pre-1). Сеть
// наблюдается обёрткой fetch — штатной опцией транспорта адаптера, production-код не меняется. Журнал
// строится только из счётчиков, имён полей, кодов, статусов и хэшей: названия, цены, количества, суммы и
// примечания тендера, значения заголовков авторизации и сырые ответы в него не попадают; uuid маскируются,
// курсоры заменяются хэш-метками. Разделы отчёта — scripts/tenderhub-live-smoke-report.ts.
import { createHash } from 'node:crypto';
import { NumLex, parseJsonWithLexemes, type IRawResponse } from '../packages/adapters/src/index.ts';
import { canonicalDecimal, isDecimalLexeme } from '../packages/core/src/index.ts';

export type Route = IRawResponse['route'] | 'other';
export type Mark = 'PASS' | 'FAIL' | 'INFO';

export interface ILine {
  mark: Mark;
  key: string;
  value: string;
  note: string;
}

export const ln = (mark: Mark, key: string, value: string | number, note = ''): ILine => ({ mark, key, value: String(value), note });
export const formatLine = (l: ILine): string => `${l.mark.padEnd(4)}  ${l.key} = ${l.value}${l.note ? ` — ${l.note}` : ''}`;
export const verdict = (ok: boolean, key: string, note = ''): ILine => ln(ok ? 'PASS' : 'FAIL', key, ok ? 'PASS' : 'FAIL', note);

export const OPENAPI_PATH = '/api/v1/archive/openapi.yaml';
export const TENDER_ROUTES: readonly Route[] = ['brief', 'overview', 'positions', 'positions_with_costs', 'boq_items_full'];

// ---------------------------------------------------------------- Маскирование

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
export const maskUuid = (u: string): string => `${u.slice(0, 8)}-…-${u.slice(-4)}`;
export const maskUuids = (text: string): string => text.replace(UUID_G, (m) => maskUuid(m));
export const cursorTag = (cursor: string): string => `#${createHash('sha256').update(cursor).digest('hex').slice(0, 8)}`;
export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
export const formatSize = (n: number): string => (n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(1).replace('.', ',')} КБ`);

export const ROUTES: [Route, RegExp][] = [
  ['openapi', /\/api\/v1\/archive\/openapi\.yaml$/u],
  ['brief', /\/api\/v1\/tenders\/brief$/u],
  ['overview', /\/api\/v1\/tenders\/[^/]+\/overview$/u],
  ['positions_with_costs', /\/api\/v1\/tenders\/[^/]+\/positions\/with-costs$/u],
  ['positions', /\/api\/v1\/tenders\/[^/]+\/positions$/u],
  ['boq_items_full', /\/api\/v1\/tenders\/[^/]+\/boq-items-full$/u],
];
export const routeOf = (pathname: string): Route => ROUTES.find(([, re]) => re.test(pathname))?.[0] ?? 'other';

// Путь без идентификаторов и значений параметров: остаются имена параметров и размер страницы.
export const pathTemplate = (url: URL): string => {
  const params = [...new Set(url.searchParams.keys())].map((k) => {
    const limit = url.searchParams.get('limit') ?? '';
    return k === 'limit' && /^\d{1,4}$/u.test(limit) ? `limit=${limit}` : `${k}=…`;
  });
  return `${url.pathname.replace(UUID_G, '{id}')}${params.length > 0 ? `?${params.join('&')}` : ''}`;
};

// ---------------------------------------------------------------- Значения, которых не должно быть в журнале

export interface ISensitive {
  strings: Set<string>;
  numbers: Set<string>;
}
export const newSensitive = (): ISensitive => ({ strings: new Set(), numbers: new Set() });

// Строки от 5 символов и числа от 5 цифр с дробной частью или от 7 цифр целых: короткие числа
// неотличимы от счётчиков журнала, и печать значений исключена построением отчёта.
export const collectSensitive = (v: unknown, s: ISensitive, depth = 0): void => {
  if (v === null || v === undefined || depth > 8) return;
  if (v instanceof NumLex) {
    const digits = (v.lexeme.match(/\d/gu) ?? []).length;
    const fractional = /[.e]/iu.test(v.lexeme);
    if ((fractional && digits >= 5) || (!fractional && digits >= 7)) {
      s.numbers.add(v.lexeme.toLowerCase());
      if (isDecimalLexeme(v.lexeme)) s.numbers.add(canonicalDecimal(v.lexeme));
    }
    return;
  }
  if (typeof v === 'string') {
    if (v.trim().length >= 5) s.strings.add(v.trim());
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectSensitive(x, s, depth + 1);
    return;
  }
  if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collectSensitive(x, s, depth + 1);
};

const NUM_TOKEN = /(?<![0-9a-f.])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?![0-9a-f])/giu;
export const leakKind = (line: string, s: ISensitive, secrets: readonly string[]): string | null => {
  for (const x of secrets) if (x.length > 0 && line.includes(x)) return 'секрет';
  for (const x of s.strings) if (line.includes(x)) return 'строка данных тендера';
  for (const m of line.matchAll(NUM_TOKEN)) if (s.numbers.has(m[0].toLowerCase())) return 'число данных тендера';
  return null;
};

// Строка журнала, совпавшая с секретом или значением тендера, заменяется отметкой — значение не пишется.
export const redactLines = (lines: readonly string[], s: ISensitive, secrets: readonly string[]): { lines: string[]; redacted: number; kinds: string[] } => {
  const kinds = new Set<string>();
  const out = lines.map((l) => {
    const kind = leakKind(l, s, secrets);
    if (!kind) return l;
    kinds.add(kind);
    return formatLine(ln('INFO', 'redacted', 'строка скрыта', `совпадение: ${kind}`));
  });
  return { lines: out, redacted: out.filter((l, i) => l !== lines[i]).length, kinds: [...kinds] };
};

// ---------------------------------------------------------------- Наблюдение транспорта

export interface IPageObs {
  rows: number;
  ids: string[];
  nextCursor: string | null;
}

export interface ICallObs {
  phase: string;
  method: string;
  route: Route;
  path: string;
  apiKeyHeader: boolean;
  authorizationHeader: boolean;
  cookieHeader: boolean;
  noCache: boolean;
  acceptGzip: boolean;
  cursor: string | null;
  status: number | null;
  networkError: string | null;
  contentType: string | null;
  contentEncoding: string | null;
  headers: Record<string, string>;
  page: IPageObs | null;
  problem: { keys: string[]; code: string | null } | null;
}

export interface IObserver {
  phase: string;
  readonly calls: ICallObs[];
  readonly sensitive: ISensitive;
  readonly fetch: typeof fetch;
}

// Значения этих заголовков ответа безопасны; у остальных из списка пишется только наличие.
const SAFE_HEADERS = ['cache-control', 'age', 'x-cache', 'vary', 'x-api-version', 'api-version', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'retry-after'];
const PRESENCE_HEADERS = ['etag', 'last-modified', 'set-cookie'];

const observePage = async (res: Response, call: ICallObs, s: ISensitive): Promise<void> => {
  try {
    const body = parseJsonWithLexemes(await res.text()) as { data?: unknown; next_cursor?: unknown } | null;
    collectSensitive(body, s);
    if (body === null || typeof body !== 'object' || !Array.isArray(body.data)) return;
    const ids = body.data.flatMap((r: unknown) => (r !== null && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' ? [(r as { id: string }).id] : []));
    const next = body.next_cursor;
    call.page = { rows: body.data.length, ids, nextCursor: typeof next === 'string' && next.length > 0 ? next : null };
  } catch {
    // тело не JSON: страница остаётся неразобранной, причину покажет адаптер
  }
};

// Тело ошибки: только имена полей и машинный code (RFC 7807), без detail и title.
const observeProblem = async (res: Response, call: ICallObs): Promise<void> => {
  call.problem = { keys: [], code: null };
  try {
    const body: unknown = JSON.parse((await res.text()).slice(0, 65_536));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
    const code = (body as { code?: unknown }).code;
    call.problem = { keys: Object.keys(body).sort(), code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null };
  } catch {
    // не JSON: остаются статус и content-type
  }
};

export const createObserver = (base: typeof fetch = fetch): IObserver => {
  const calls: ICallObs[] = [];
  const sensitive = newSensitive();
  const observer: IObserver = {
    phase: 'capture',
    calls,
    sensitive,
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const h = new Headers(init?.headers);
      const call: ICallObs = {
        phase: observer.phase,
        method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
        route: routeOf(url.pathname),
        path: pathTemplate(url),
        apiKeyHeader: h.has('x-api-key'),
        authorizationHeader: h.has('authorization'),
        cookieHeader: h.has('cookie'),
        noCache: /no-cache/iu.test(h.get('cache-control') ?? ''),
        acceptGzip: /gzip/iu.test(h.get('accept-encoding') ?? ''),
        cursor: url.searchParams.get('cursor'),
        status: null,
        networkError: null,
        contentType: null,
        contentEncoding: null,
        headers: {},
        page: null,
        problem: null,
      };
      calls.push(call);
      let res: Response;
      try {
        res = await base(input, init);
      } catch (err) {
        call.networkError = err instanceof Error ? err.name : 'error';
        throw err;
      }
      call.status = res.status;
      call.contentType = res.headers.get('content-type');
      call.contentEncoding = res.headers.get('content-encoding');
      for (const name of SAFE_HEADERS) {
        const v = res.headers.get(name);
        if (v !== null) call.headers[name] = v.replace(/[\r\n\t]+/gu, ' ').slice(0, 120);
      }
      for (const name of PRESENCE_HEADERS) if (res.headers.has(name)) call.headers[name] = 'есть';
      if (res.ok && call.route === 'positions') await observePage(res.clone(), call, sensitive);
      else if (!res.ok) await observeProblem(res.clone(), call);
      return res;
    },
  };
  return observer;
};

// ---------------------------------------------------------------- Сырые ответы и спецификация

export const dataOf = (raw: IRawResponse): unknown => (parseJsonWithLexemes(raw.body.toString('utf8')) as { data?: unknown }).data;
export const firstRaw = (raws: readonly IRawResponse[] | null, route: Route): IRawResponse | null => raws?.find((r) => r.route === route) ?? null;

export const rowsOf = (raw: IRawResponse): Record<string, unknown>[] => {
  const data = dataOf(raw);
  const list: unknown[] = Array.isArray(data) ? data : [data];
  return list.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r) && !(r instanceof NumLex));
};

export const fieldNames = (raws: readonly IRawResponse[], route: Route): Set<string> => {
  const names = new Set<string>();
  const walk = (o: unknown, depth: number): void => {
    if (o === null || typeof o !== 'object' || Array.isArray(o) || o instanceof NumLex || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      names.add(k);
      walk(v, depth + 1);
    }
  };
  for (const raw of raws.filter((r) => r.route === route)) for (const row of rowsOf(raw)) walk(row, 0);
  return names;
};
export const specFieldNames = (spec: ISpec): Set<string> => new Set([...spec.text.matchAll(/^\s+([A-Za-z_][\w-]*):/gmu)].map((m) => m[1] ?? ''));

export interface ISpec {
  available: boolean;
  text: string;
  sha256: string | null;
  openapi: string | null;
  version: string | null;
  problem: string | null;
}

export const specFrom = (raw: IRawResponse | null, problem: string | null): ISpec => {
  if (!raw) return { available: false, text: '', sha256: null, openapi: null, version: null, problem };
  const text = raw.body.toString('utf8');
  return {
    available: true,
    text,
    sha256: sha256(raw.body),
    openapi: /^openapi:\s*['"]?([^'"\s]+)/mu.exec(text)?.[1] ?? null,
    version: /^info:\s*\n(?:[ \t]+.*\n)*?[ \t]+version:\s*['"]?([^'"\n]+)/mu.exec(text)?.[1]?.trim() ?? null,
    problem: null,
  };
};

export const ADAPTER_PATHS: [string, RegExp][] = [
  ['/api/v1/tenders/brief', /^\s+\/api\/v1\/tenders\/brief:/mu],
  ['/api/v1/tenders/{id}/overview', /^\s+\/api\/v1\/tenders\/\{[^}]+\}\/overview:/mu],
  ['/api/v1/tenders/{id}/positions', /^\s+\/api\/v1\/tenders\/\{[^}]+\}\/positions:/mu],
  ['/api/v1/tenders/{id}/positions/with-costs', /^\s+\/api\/v1\/tenders\/\{[^}]+\}\/positions\/with-costs:/mu],
  ['/api/v1/tenders/{id}/boq-items-full', /^\s+\/api\/v1\/tenders\/\{[^}]+\}\/boq-items-full:/mu],
];
export const specPathsMissing = (spec: ISpec): string[] => ADAPTER_PATHS.filter(([, re]) => !re.test(spec.text)).map(([p]) => p);
