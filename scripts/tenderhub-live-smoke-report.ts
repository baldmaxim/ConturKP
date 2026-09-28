// Разделы журнала live-smoke TenderHub (этап 06, U-04; решение по ревью 06-pre-1): чистые функции над
// наблюдениями транспорта и сырыми ответами. Согласованность не пересчитывается — берётся отчёт рабочей
// PortalCaptureStrategy; значения тендера не печатаются, только счётчики, имена полей, коды и хэши.
import {
  NumLex,
  parseBoqItems,
  parsePositionsWithCosts,
  RowIssues,
  type IConsistencyReason,
  type IConsistencyReport,
  type IRawResponse,
  type ITenderHubError,
} from '../packages/adapters/src/index.ts';
import { canonicalDecimal, isDecimalLexeme } from '../packages/core/src/index.ts';
import {
  ADAPTER_PATHS,
  cursorTag,
  dataOf,
  fieldNames,
  firstRaw,
  formatSize,
  ln,
  maskUuid,
  OPENAPI_PATH,
  ROUTES,
  rowsOf,
  sha256,
  specFieldNames,
  specPathsMissing,
  TENDER_ROUTES,
  verdict,
  type ICallObs,
  type ILine,
  type ISpec,
  type Route,
} from './tenderhub-live-smoke-observe.ts';

// ---------------------------------------------------------------- 1–2. Доступ и методы

export const accessLines = (i: { baseUrl: string; tenderId: string; calls: readonly ICallObs[]; spec: ISpec }): ILine[] => {
  const tender = i.calls.filter((c) => TENDER_ROUTES.includes(c.route));
  const ok = tender.find((c) => c.status !== null && c.status >= 200 && c.status < 300);
  const denied = tender.find((c) => c.status === 401 || c.status === 403);
  const withKey = i.calls.filter((c) => c.apiKeyHeader).length;
  const bearer = i.calls.filter((c) => c.authorizationHeader).length;
  const cookies = i.calls.filter((c) => c.cookieHeader).length;
  const versions = [...new Set(i.calls.flatMap((c) => ['x-api-version', 'api-version'].filter((h) => c.headers[h]).map((h) => `${h}: ${c.headers[h]}`)))];
  const missing = specPathsMissing(i.spec);
  return [
    ln('INFO', 'tenderhub_url', i.baseUrl, 'TENDERHUB_URL без учётных данных и параметров'),
    ln('INFO', 'tender_id', maskUuid(i.tenderId), 'маскирован'),
    ok
      ? ln('PASS', 'auth_x_api_key', 'PASS', `${ok.route}: HTTP ${ok.status} по заголовку X-API-Key`)
      : denied
        ? ln('FAIL', 'auth_x_api_key', 'FAIL', `${denied.route}: HTTP ${denied.status}${denied.problem?.code ? ` ${denied.problem.code}` : ''}`)
        : ln('FAIL', 'auth_x_api_key', 'NOT_OBSERVED', 'успешного ответа маршрутов тендера нет'),
    ln(withKey === i.calls.length && withKey > 0 ? 'PASS' : 'FAIL', 'x_api_key_header', `${withKey}/${i.calls.length}`, 'ключ — только заголовком X-API-Key, значение не записывается'),
    ln(bearer === 0 ? 'PASS' : 'FAIL', 'authorization_header_requests', bearer, 'Bearer не отправляется'),
    ln(cookies === 0 ? 'PASS' : 'FAIL', 'cookie_header_requests', cookies),
    i.spec.available
      ? ln('INFO', 'api_contract', `OpenAPI ${i.spec.openapi ?? '?'}, info.version ${i.spec.version ?? 'не найдена'}`, `${OPENAPI_PATH}, SHA-256 ${i.spec.sha256}`)
      : ln('INFO', 'api_contract', 'NOT_AVAILABLE', `${OPENAPI_PATH}: ${i.spec.problem ?? 'нет ответа'}`),
    ...(i.spec.available
      ? [
          missing.length === 0
            ? ln('PASS', 'openapi_paths', `${ADAPTER_PATHS.length}/${ADAPTER_PATHS.length}`, 'маршруты адаптера описаны в спецификации сборки')
            : ln('INFO', 'openapi_paths', `${ADAPTER_PATHS.length - missing.length}/${ADAPTER_PATHS.length}`, `нет в спецификации: ${missing.join(', ')} — см. раздел 9`),
        ]
      : []),
    ln('INFO', 'api_version_headers', versions.length > 0 ? versions.join('; ') : 'нет'),
  ];
};

export const requestLines = (calls: readonly ICallObs[]): ILine[] => {
  const nonGet = calls.filter((c) => c.method !== 'GET');
  const gzip = calls.filter((c) => c.acceptGzip).length;
  const encodings = [...new Set(calls.filter((c) => c.status !== null).map((c) => `${c.route}: ${c.contentEncoding ?? 'без сжатия'}`))];
  const out = [
    ln(nonGet.length === 0 ? 'PASS' : 'FAIL', 'non_GET_requests', nonGet.length, nonGet.length === 0 ? 'все запросы — GET; запросов записи нет' : `методы: ${[...new Set(nonGet.map((c) => c.method))].join(', ')}`),
    ln('INFO', 'requests_total', calls.length),
    ln(gzip === calls.length && gzip > 0 ? 'PASS' : 'FAIL', 'accept_gzip_sent', `${gzip}/${calls.length}`),
    ln('INFO', 'content_encoding', encodings.join('; ') || 'нет ответов', 'крупные ответы TenderHub сжимает gzip, мелкие — не обязательно'),
  ];
  const groups = new Map<string, { n: number; statuses: Set<string> }>();
  for (const c of calls) {
    const key = `${c.phase}: ${c.method} ${c.path}`;
    const g = groups.get(key) ?? { n: 0, statuses: new Set<string>() };
    g.n += 1;
    g.statuses.add(c.status === null ? `сеть (${c.networkError ?? '—'})` : `HTTP ${c.status}`);
    groups.set(key, g);
  }
  for (const [key, g] of groups) out.push(ln('INFO', 'request', `${key} ×${g.n}`, [...g.statuses].join(', ')));
  return out;
};

// ---------------------------------------------------------------- 3. Пагинация positions

export interface IPagination {
  requests: number;
  perPage: (number | null)[];
  nextCursors: (string | null)[];
  repeated: number;
  followed: boolean;
  terminated: boolean;
  broken: number;
  rows: number;
  ids: Set<string>;
  duplicates: number;
}

export const paginationOf = (calls: readonly ICallObs[]): IPagination => {
  const pages = calls.filter((c) => c.route === 'positions');
  const seen = new Set<string>();
  const all: string[] = [];
  let repeated = 0;
  for (const c of pages) {
    const next = c.page?.nextCursor ?? null;
    if (next !== null) {
      if (seen.has(next)) repeated += 1;
      seen.add(next);
    }
    all.push(...(c.page?.ids ?? []));
  }
  const ids = new Set(all);
  const last = pages.at(-1);
  return {
    requests: pages.length,
    perPage: pages.map((c) => c.page?.rows ?? null),
    nextCursors: pages.map((c) => c.page?.nextCursor ?? null),
    repeated,
    // Каждая следующая страница запрошена ровно курсором, который вернула предыдущая.
    followed: pages.every((c, i) => (i === 0 ? c.cursor === null : c.cursor === (pages[i - 1]?.page?.nextCursor ?? undefined))),
    terminated: last?.page !== null && last?.page !== undefined && last.page.nextCursor === null,
    broken: pages.filter((c) => c.page === null).length,
    rows: all.length,
    ids,
    duplicates: all.length - ids.size,
  };
};

const cursorChain = (p: IPagination): string => p.nextCursors.map((c) => (c === null ? 'нет' : cursorTag(c))).join(' → ');

export const paginationLines = (p: IPagination, limit: number): ILine[] => {
  if (p.requests === 0) return [ln('INFO', 'pagination_multi_page', 'NOT_AVAILABLE', 'маршрут positions не вызывался')];
  const out = [
    ln('INFO', 'positions_pages', p.requests, `limit=${limit}; строк по страницам: ${p.perPage.map((n) => n ?? '—').join(', ')}`),
    ln('INFO', 'positions_next_cursor', cursorChain(p), 'next_cursor каждой страницы: хэш-метка или «нет»'),
    verdict(p.followed, 'cursor_followed', 'каждая страница запрошена курсором предыдущей'),
    ln(p.repeated === 0 ? 'PASS' : 'FAIL', 'cursor_repeated', p.repeated === 0 ? 0 : `DETECTED (${p.repeated})`),
    ln('INFO', 'positions_unique_ids', p.ids.size, `строк на страницах: ${p.rows}`),
    ln(p.duplicates === 0 ? 'PASS' : 'FAIL', 'positions_duplicates', p.duplicates),
  ];
  const problem =
    p.broken > 0
      ? `страниц без разбора: ${p.broken}`
      : p.repeated > 0
        ? 'повтор курсора'
        : p.duplicates > 0
          ? 'дубли позиций между страницами'
          : !p.followed
            ? 'страница запрошена не курсором предыдущей'
            : !p.terminated
              ? 'обход не завершён страницей без курсора'
              : null;
  if (problem) {
    out.push(ln('FAIL', 'pagination_multi_page', 'FAIL', problem));
  } else if (p.requests > 1) {
    out.push(ln('PASS', 'pagination_multi_page', 'PASS', `${p.requests} страниц: курсор сменялся, повторов и дублей нет`));
  } else {
    out.push(ln('INFO', 'pagination_multi_page', 'NOT_OBSERVED', `одна страница при limit=${limit}: многостраничный обход рабочей выгрузкой не наблюдался`));
  }
  return out;
};

export interface IProbePlan {
  status: 'RUN' | 'SKIPPED' | 'NOT_OBSERVED';
  note: string;
  limit: number;
  expected: number;
}

// Пробный обход малыми страницами — только диагностика курсора, когда рабочая выгрузка уместилась в одну страницу.
export const probeLines = (plan: IProbePlan, p: IPagination | null, error: string | null): ILine[] => {
  if (plan.status !== 'RUN' || !p) return [ln('INFO', 'pagination_probe', plan.status, plan.note)];
  const ok = !error && p.requests > 1 && p.followed && p.terminated && p.repeated === 0 && p.duplicates === 0 && p.broken === 0 && p.ids.size === plan.expected;
  return [
    ln(
      ok ? 'PASS' : 'FAIL',
      'pagination_probe',
      ok ? 'PASS' : 'FAIL',
      `limit=${plan.limit}: страниц ${p.requests} (${p.perPage.map((n) => n ?? '—').join(', ')}), курсор ${cursorChain(p)}; уникальных ${p.ids.size} из ${plan.expected}; повторов курсора ${p.repeated}, дублей ${p.duplicates}${error ? `; ошибка: ${error}` : ''}`,
    ),
  ];
};

// ---------------------------------------------------------------- 4–5. with-costs и BOQ

const httpLine = (key: string, c: ICallObs): ILine =>
  c.status !== null && c.status >= 200 && c.status < 300
    ? ln('PASS', key, 'PASS', `HTTP ${c.status}, ${c.contentType ?? 'без content-type'}`)
    : ln('FAIL', key, 'FAIL', c.status === null ? `сеть: ${c.networkError ?? '—'}` : `HTTP ${c.status}`);

const changedFields = (reasons: readonly IConsistencyReason[]): { positions: number; fields: string[] } => {
  const fields = new Set<string>();
  let positions = 0;
  for (const r of reasons) {
    if (r.code !== 'position_changed_between_routes') continue;
    positions += 1;
    for (const f of (/:\s*([a-z_, ]+)$/u.exec(r.detail)?.[1] ?? '').split(',')) if (f.trim()) fields.add(f.trim());
  }
  return { positions, fields: [...fields].sort() };
};

export const withCostsLines = (i: { calls: readonly ICallObs[]; raws: readonly IRawResponse[] | null; reasons: readonly IConsistencyReason[] | null; positionIds: Set<string> }): ILine[] => {
  const call = i.calls.find((c) => c.route === 'positions_with_costs');
  if (!call) return [ln('INFO', 'with_costs_available', 'NOT_AVAILABLE', 'маршрут не вызывался')];
  const cache = ['cache-control', 'age', 'x-cache', 'etag', 'last-modified', 'vary'].filter((h) => call.headers[h]).map((h) => `${h}: ${call.headers[h]}`);
  const out = [
    httpLine('with_costs_available', call),
    verdict(call.noCache, 'with_costs_no_cache_sent', 'запрос отправлен с Cache-Control: no-cache'),
    ln('INFO', 'with_costs_cache_headers', cache.join('; ') || 'нет', 'заголовки кэша в ответе'),
  ];
  const raw = firstRaw(i.raws, 'positions_with_costs');
  if (!raw) return out;
  const ids = new Set(parsePositionsWithCosts(dataOf(raw), new RowIssues()).map((r) => r.id));
  const onlyPaged = [...i.positionIds].filter((x) => !ids.has(x)).length;
  const onlyCosts = [...ids].filter((x) => !i.positionIds.has(x)).length;
  const changed = changedFields(i.reasons ?? []);
  out.push(
    ln('INFO', 'with_costs_items', ids.size),
    verdict(onlyPaged === 0 && onlyCosts === 0, 'with_costs_ids_match_positions', `только на страницах: ${onlyPaged}; только в with-costs: ${onlyCosts}`),
    ln(changed.positions === 0 ? 'PASS' : 'FAIL', 'common_fields_mismatch', changed.positions, changed.positions === 0 ? 'общие поля позиций совпали' : `поля: ${changed.fields.join(', ')}`),
  );
  return out;
};

export const boqLines = (i: { calls: readonly ICallObs[]; raws: readonly IRawResponse[] | null }): ILine[] => {
  const call = i.calls.find((c) => c.route === 'boq_items_full');
  if (!call) return [ln('INFO', 'boq_available', 'NOT_AVAILABLE', 'маршрут не вызывался')];
  const out = [httpLine('boq_available', call)];
  const raw = firstRaw(i.raws, 'boq_items_full');
  const costsRaw = firstRaw(i.raws, 'positions_with_costs');
  if (!raw || !costsRaw) return out;
  const lines = parseBoqItems(dataOf(raw), new RowIssues());
  const costs = parsePositionsWithCosts(dataOf(costsRaw), new RowIssues());
  const known = new Set(costs.map((c) => c.id));
  const perPosition = new Map<string, number>();
  for (const l of lines) perPosition.set(l.positionId, (perPosition.get(l.positionId) ?? 0) + 1);
  const unique = new Set(lines.map((l) => l.id)).size;
  const refs = lines.filter((l) => known.has(l.positionId)).length;
  const comparable = costs.filter((c) => c.itemsCount !== null);
  const mismatch = comparable.filter((c) => c.itemsCount !== (perPosition.get(c.id) ?? 0)).length;
  out.push(
    ln('INFO', 'boq_lines', lines.length),
    ln('INFO', 'boq_unique_ids', unique),
    ln(unique === lines.length ? 'PASS' : 'FAIL', 'boq_duplicates', lines.length - unique),
    ln('INFO', 'boq_known_position_refs', refs),
    ln(refs === lines.length ? 'PASS' : 'FAIL', 'orphan_lines', lines.length - refs, 'строки без известной позиции'),
    comparable.length === 0
      ? ln('INFO', 'items_count_check', 'NOT_AVAILABLE', 'items_count в ответе with-costs нет')
      : verdict(mismatch === 0, 'items_count_check', `поле есть у ${comparable.length} из ${costs.length} позиций; расхождений: ${mismatch}`),
  );
  return out;
};

// ---------------------------------------------------------------- 6. Согласованность

export const consistencyLines = (c: IConsistencyReport | null): ILine[] => {
  if (!c) return [ln('INFO', 'consistency', 'NOT_AVAILABLE', 'выгрузка не завершилась — см. capture')];
  const codes = new Set(c.reasons.map((r) => r.code));
  const has = (...k: IConsistencyReason['code'][]): string[] => k.filter((x) => codes.has(x));
  const markers = [...new Set(c.reasons.filter((r) => r.code === 'markers_changed').map((r) => /шапка: (\w+)/u.exec(r.detail)?.[1] ?? '?'))];
  const check = (key: string, bad: string[]): ILine => verdict(bad.length === 0, key, bad.join(', '));
  return [
    verdict(
      markers.length === 0,
      'before_after_stable',
      markers.length > 0 ? `различаются: ${markers.join(', ')}` : c.updatedAtIsSourceNow ? 'updated_at шапки равен времени источника в обоих чтениях — исключён из сравнения' : 'признаки шапки до и после совпали',
    ),
    check('positions_cross_check', has('positions_count_mismatch', 'position_sets_differ', 'position_changed_between_routes')),
    check('boq_count_check', has('items_count_mismatch')),
    check('duplicate_check', has('position_duplicated')),
    c.sourceStart === null ? ln('INFO', 'updated_at_check', 'NOT_AVAILABLE', 'источник не отдал заголовок Date') : check('updated_at_check', has('row_updated_during_capture')),
    ln('INFO', 'capture_counts', `страниц ${c.counts.pages}, позиций ${c.counts.positionsPaged}/${c.counts.positionsWithCosts}, строк ${c.counts.boqItems}`, 'позиции: постранично / with-costs'),
    ln(
      c.outcome === 'consistent' ? 'PASS' : 'FAIL',
      'consistency',
      c.outcome,
      c.outcome === 'consistent' ? 'контроль рабочей PortalCaptureStrategy' : `причины: ${[...codes].join(', ')}${c.reasons.length >= 20 ? ' (записаны первые 20)' : ''}`,
    ),
  ];
};

// ---------------------------------------------------------------- 7. Числовой контракт

export const numericLines = (raws: readonly IRawResponse[] | null): ILine[] => {
  if (!raws) return [ln('INFO', 'numeric_contract', 'NOT_AVAILABLE', 'выгрузка не завершилась — числовые поля не разобраны')];
  const invalid: string[] = [];
  const out: ILine[] = [];
  for (const route of TENDER_ROUTES) {
    const stats = new Map<string, { num: number; other: number; exponent: boolean; sig: number; scale: number }>();
    for (const raw of raws.filter((r) => r.route === route)) {
      for (const row of rowsOf(raw)) {
        for (const [k, v] of Object.entries(row)) {
          const s = stats.get(k) ?? { num: 0, other: 0, exponent: false, sig: 0, scale: 0 };
          if (v instanceof NumLex) {
            s.num += 1;
            if (/e/iu.test(v.lexeme)) s.exponent = true;
            if (!isDecimalLexeme(v.lexeme)) invalid.push(`${route}.${k}`);
            else {
              const c = canonicalDecimal(v.lexeme).replace(/^-/u, '');
              s.sig = Math.max(s.sig, c.replace('.', '').replace(/^0+/u, '').length);
              s.scale = Math.max(s.scale, c.split('.')[1]?.length ?? 0);
            }
          } else if (v !== null) s.other += 1;
          stats.set(k, s);
        }
      }
    }
    const numeric = [...stats].filter(([, s]) => s.num > 0);
    if (numeric.length === 0) continue;
    const exp = numeric.filter(([, s]) => s.exponent).map(([k]) => k);
    const mixed = numeric.filter(([, s]) => s.other > 0).map(([k]) => k);
    out.push(
      ln(
        'INFO',
        `numeric.${route}`,
        `числовых полей: ${numeric.length}`,
        `экспонентная запись: ${exp.join(', ') || 'нет'}; не только числом: ${mixed.join(', ') || 'нет'}; значащих цифр до ${Math.max(...numeric.map(([, s]) => s.sig))}, знаков после точки до ${Math.max(...numeric.map(([, s]) => s.scale))}`,
      ),
    );
  }
  const unique = [...new Set(invalid)];
  return [
    verdict(unique.length === 0, 'numeric_contract', unique.length === 0 ? 'числа получены лексемами источника без float и разобраны адаптером этапа 06' : `недопустимые лексемы: ${unique.join(', ')}`),
    ...out,
    ln('INFO', 'numeric_precision', 'fixture', '21 значащую цифру доказывает фикстурная регрессия; в живом тендере такое число не требуется'),
  ];
};

// ---------------------------------------------------------------- 8. Q-05: только форма

const FINANCIAL: [Route, string[]][] = [
  ['overview', ['cached_grand_total', 'usd_rate', 'eur_rate', 'cny_rate']],
  ['positions_with_costs', ['base_total', 'commercial_total', 'material_cost_total', 'work_cost_total', 'total_material', 'total_works', 'total_commercial_material', 'total_commercial_work', 'markup_percentage']],
  ['boq_items_full', ['total_amount', 'total_commercial_material_cost', 'total_commercial_work_cost', 'commercial_markup', 'delivery_amount', 'delivery_price_type', 'unit_rate', 'currency_type']],
];
const Q05_KEYWORDS: [string, RegExp][] = [
  ['insurance', /insur|страх/iu],
  ['reduction', /reduc|discount|сниж|скидк/iu],
  ['redistribution', /redistrib|перерасп/iu],
  ['vat', /(?:^|_)(?:vat|nds)(?:_|$)|ндс/iu],
];

export const q05Lines = (raws: readonly IRawResponse[] | null, spec: ISpec): ILine[] => {
  const got = (route: Route): Set<string> | null => (raws && raws.some((r) => r.route === route) ? fieldNames(raws, route) : null);
  const overview = got('overview');
  const out = [
    ln('INFO', 'q05.cached_grand_total', overview === null ? 'endpoint unavailable' : overview.has('cached_grand_total') ? 'present' : 'absent', 'overview; значение не выводится и итогом КП не объявляется'),
  ];
  for (const [route, fields] of FINANCIAL) {
    const names = got(route);
    if (!names) {
      out.push(ln('INFO', `q05.components.${route}`, 'endpoint unavailable'));
      continue;
    }
    const present = fields.filter((f) => names.has(f));
    const absent = fields.filter((f) => !names.has(f));
    out.push(ln('INFO', `q05.components.${route}`, `present ${present.length}/${fields.length}`, [present.length ? `есть: ${present.join(', ')}` : '', absent.length ? `нет: ${absent.join(', ')}` : ''].filter(Boolean).join('; ')));
  }
  const all = new Set(TENDER_ROUTES.flatMap((r) => [...(got(r) ?? [])]));
  const specNames = spec.available ? specFieldNames(spec) : new Set<string>();
  for (const [key, re] of Q05_KEYWORDS) {
    const inResponses = [...all].filter((n) => re.test(n));
    const inSpec = [...specNames].filter((n) => re.test(n));
    out.push(
      ln('INFO', `q05.${key}`, raws === null ? 'endpoint unavailable' : inResponses.length > 0 ? 'present' : 'absent', `в ответах: ${inResponses.join(', ') || 'нет'}; в OpenAPI: ${spec.available ? inSpec.join(', ') || 'нет' : 'недоступна'}`),
    );
  }
  out.push(ln('INFO', 'q05.kp_total', 'не определяется', 'правило итога КП не задано — Q-05 остаётся OPEN'));
  return out;
};

// ---------------------------------------------------------------- 9. Расхождения с контрактом

export interface IDiff {
  route: string;
  expected: string;
  actual: string;
  type: string;
}

const EXPECTED: Record<Route, string> = {
  openapi: 'HTTP 200, спецификация OpenAPI (README архива API)',
  brief: 'HTTP 200, {"data": [тендеры]}',
  overview: 'HTTP 200, {"data": {шапка тендера}}',
  positions: 'HTTP 200, {"data": [позиции], "next_cursor"}',
  positions_with_costs: 'HTTP 200, {"data": [позиции с суммами]}',
  boq_items_full: 'HTTP 200, {"data": [строки сметы]}',
  other: '—',
};
// Имена маршрутов в сообщениях адаптера и в отчёте отсутствующих полей → маршрут журнала.
const ROUTE_ALIASES: Record<string, Route> = {
  'positions/with-costs': 'positions_with_costs',
  with_costs: 'positions_with_costs',
  'boq-items-full': 'boq_items_full',
  boq_items: 'boq_items_full',
};
const routeName = (r: string): Route => ROUTE_ALIASES[r] ?? (ROUTES.some(([n]) => n === r) ? (r as Route) : 'other');

export const contractDiffs = (i: {
  calls: readonly ICallObs[];
  spec: ISpec;
  captureError: ITenderHubError | null;
  missing: Record<string, number> | null;
  raws: readonly IRawResponse[] | null;
}): IDiff[] => {
  const d: IDiff[] = [];
  if (!i.spec.available) d.push({ route: 'openapi', expected: EXPECTED.openapi, actual: i.spec.problem ?? 'нет ответа', type: 'spec_unavailable' });
  else for (const p of specPathsMissing(i.spec)) d.push({ route: p, expected: 'маршрут описан в OpenAPI сборки', actual: 'нет в спецификации', type: 'path_undocumented' });
  for (const c of i.calls) {
    if (c.status === null) d.push({ route: c.route, expected: EXPECTED[c.route], actual: `сеть: ${c.networkError ?? '—'}`, type: 'network' });
    else if (c.status < 200 || c.status >= 300) {
      const problem = c.problem ? `; поля ошибки: ${c.problem.keys.join(', ') || 'нет'}${c.problem.code ? `; code ${c.problem.code}` : ''}` : '';
      d.push({ route: c.route, expected: EXPECTED[c.route], actual: `HTTP ${c.status}, ${c.contentType ?? 'без content-type'}${problem}`, type: 'http_status' });
    } else if (c.route !== 'openapi' && !/json/iu.test(c.contentType ?? '')) {
      d.push({ route: c.route, expected: 'content-type application/json', actual: c.contentType ?? 'без content-type', type: 'content_type' });
    }
  }
  if (i.captureError) {
    const route = routeName(String(i.captureError.details?.route ?? ''));
    d.push({
      route: route === 'other' ? 'выгрузка' : route,
      expected: EXPECTED[route],
      actual: `${i.captureError.code}/${i.captureError.reason}: ${i.captureError.message}`,
      type: i.captureError.code === 'CONTRACT_MISMATCH' ? 'schema' : 'adapter_error',
    });
  }
  const absent = new Map<Route, string[]>();
  for (const [key, n] of Object.entries(i.missing ?? {})) {
    const [scope = '', field = ''] = key.split('.');
    const route = routeName(scope);
    absent.set(route, [...(absent.get(route) ?? []), `${field} ×${n}`]);
  }
  for (const [route, fields] of absent) d.push({ route, expected: 'документированные поля (архив API 2026-09-02)', actual: `нет в строках: ${fields.join(', ')}`, type: 'field_absent' });
  if (i.spec.available && i.raws) {
    const specNames = specFieldNames(i.spec);
    for (const route of TENDER_ROUTES) {
      const extra = [...fieldNames(i.raws, route)].filter((f) => !specNames.has(f)).sort();
      if (extra.length > 0) d.push({ route, expected: 'поля ответа описаны в OpenAPI сборки', actual: `нет в спецификации: ${extra.join(', ')}`, type: 'field_undocumented' });
    }
  }
  return d;
};

export const diffLines = (d: readonly IDiff[]): ILine[] => [
  ln('INFO', 'contract_discrepancies', d.length, d.length === 0 ? 'расхождений с контрактом 2026-09-02 и OpenAPI сборки нет' : 'каждое — ниже, без содержимого тендера'),
  ...d.map((x) => ln('INFO', 'diff', x.type, `route ${x.route}; ожидалось: ${x.expected}; фактически: ${x.actual}`)),
];

export const responseLines = (raws: readonly IRawResponse[]): ILine[] =>
  raws.map((r) => ln('INFO', 'response', `${r.route} HTTP ${r.status}`, `${formatSize(r.body.length)}, ${r.contentEncoding ?? 'без сжатия'}, SHA-256 ${sha256(r.body)}`));
