// Live-smoke TenderHub (этап 06, U-04): разрешённый тендер читается официальным API по X-API-Key тем же
// адаптером и той же стратегией выгрузки, что у worker, но без БД портала. Запускается только после
// выдачи ключа владельцем; без ключа — NOT_RUN.
//   npm run tenderhub:live-smoke -- --tender <uuid разрешённого тендера> [--out <файл журнала>]
// Адрес и ключ — только TENDERHUB_URL и TENDERHUB_API_KEY из окружения или .env. Только GET: записи в
// TenderHub нет. Ключ не выводится и не пишется; в журнал попадают коды, счётчики, имена полей и
// SHA-256 ответов, но не данные тендера (названия, цены, объёмы).
// Код выхода: 0 — PASS, 1 — FAIL, 2 — неверный запуск, 3 — NOT_RUN (TenderHub не настроен).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  NumLex,
  parseJsonWithLexemes,
  runPortalCapture,
  TENDERHUB_CONTRACT_VERSION,
  TenderHubApiSource,
  TenderHubError,
  TenderHubHttpClient,
  type IRawResponse,
} from '../packages/adapters/src/index.ts';
import { loadTenderHubConfig } from '../packages/config/src/index.ts';
import { argValue, fail } from './cli.ts';

const ROOT = resolve(import.meta.dirname, '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const OPENAPI_PATH = '/api/v1/archive/openapi.yaml';
// Маршруты, которые читает адаптер: каждый должен быть описан в спецификации развёрнутой сборки.
const ADAPTER_PATHS: [string, RegExp][] = [
  ['/api/v1/tenders/brief', /^\s+\/api\/v1\/tenders\/brief:/mu],
  ['/api/v1/tenders/{id}/overview', /^\s+\/api\/v1\/tenders\/\{[^}]+\}\/overview:/mu],
  ['/api/v1/tenders/{id}/positions', /^\s+\/api\/v1\/tenders\/\{[^}]+\}\/positions:/mu],
  ['/api/v1/tenders/{id}/positions/with-costs', /^\s+\/api\/v1\/tenders\/\{[^}]+\}\/positions\/with-costs:/mu],
  ['/api/v1/tenders/{id}/boq-items-full', /^\s+\/api\/v1\/tenders\/\{[^}]+\}\/boq-items-full:/mu],
];

const tenderId = argValue('tender')?.toLowerCase();
if (!tenderId || !UUID.test(tenderId)) fail('нужен --tender <uuid разрешённого владельцем тендера TenderHub>', 2);
const outFile = resolve(argValue('out') ?? join(ROOT, 'artifacts', 'stage-06', 'live-smoke.log'));

const { tenderhub: th, problems } = loadTenderHubConfig();
const lines: string[] = [];
let failed = false;
const record = (step: string, ok: boolean | null, note = ''): void => {
  const mark = ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL';
  const line = `${mark}  ${step}${note ? ` — ${note}` : ''}`;
  lines.push(line);
  console.log(line);
  if (ok === false) failed = true;
};
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// Имена полей строк ответа (верхний уровень и вложенные справочники) — без значений.
const fieldsOf = (raw: IRawResponse): Set<string> => {
  const out = new Set<string>();
  const data = (parseJsonWithLexemes(raw.body.toString('utf8')) as { data?: unknown }).data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const walk = (o: unknown, depth: number): void => {
    if (o === null || typeof o !== 'object' || Array.isArray(o) || o instanceof NumLex || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      out.add(k);
      walk(v, depth + 1);
    }
  };
  for (const r of rows) walk(r, 0);
  return out;
};

const finish = (status: 'PASS' | 'FAIL' | 'NOT_RUN'): never => {
  const text = `# tenderhub live-smoke — ${new Date().toISOString()}\n# адаптер ${TENDERHUB_CONTRACT_VERSION}, Node ${process.version}; только GET, ключ не записывается\n${lines.join('\n')}\nИтог: ${status}\n`;
  // Вторая линия: ключ не должен попасть в журнал ни при какой ошибке.
  if (th.apiKey && text.includes(th.apiKey)) fail('журнал содержит ключ — не записан', 1);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  console.log(`Итог: ${status}; журнал — ${outFile}`);
  process.exit(status === 'PASS' ? 0 : status === 'NOT_RUN' ? 3 : 1);
};

if (problems.length > 0) {
  for (const p of problems) record('конфигурация TenderHub', false, p);
  finish('FAIL');
}
if (!th.baseUrl || !th.apiKey) {
  record('TenderHub не настроен', null, `TENDERHUB_URL ${th.baseUrl ? 'задан' : 'не задан'}, TENDERHUB_API_KEY ${th.apiKey ? 'задан' : 'не задан'} (U-04)`);
  finish('NOT_RUN');
}
const baseUrl = th.baseUrl!;
record('адрес и ключ заданы', true, `${new URL(baseUrl).origin}; ключ — только заголовок X-API-Key, значение не выводится`);
record('тендер для проверки', null, tenderId!);

const http = new TenderHubHttpClient({
  baseUrl,
  apiKey: th.apiKey!,
  timeoutMs: th.timeoutMs,
  rateLimitPerMinute: th.rateLimitPerMinute,
  windowMs: th.rateLimitWindowMs,
  maxResponseBytes: th.maxResponseBytes,
  rateLimitWaits: 2,
});

// 1. Спецификация развёрнутой сборки (R-06): маршруты адаптера в ней описаны.
let spec: string | null = null;
try {
  const raw = await http.get('openapi', OPENAPI_PATH);
  spec = raw.body.toString('utf8');
  const version = /^info:\s*\n(?:[ \t]+.*\n)*?[ \t]+version:\s*['"]?([^'"\n]+)/mu.exec(spec)?.[1]?.trim() ?? 'не найдена';
  record('OpenAPI развёрнутой сборки получена', true, `${OPENAPI_PATH}, SHA-256 ${sha256(raw.body)}, версия ${version}`);
  const missing = ADAPTER_PATHS.filter(([, re]) => !re.test(spec!)).map(([p]) => p);
  record('маршруты адаптера описаны в OpenAPI', missing.length === 0, missing.length ? `нет: ${missing.join(', ')}` : `${ADAPTER_PATHS.length} из ${ADAPTER_PATHS.length}`);
} catch (err) {
  const e = err instanceof TenderHubError ? err.error : null;
  record('OpenAPI развёрнутой сборки получена', false, e ? `${e.code}/${e.reason}: ${e.message}` : 'ошибка запроса');
}

// 2. Выгрузка разрешённого тендера той же стратегией, что у worker.
try {
  const started = Date.now();
  const r = await runPortalCapture(new TenderHubApiSource(http), tenderId!);
  const c = r.consistency;
  record(
    'выгрузка тендера по X-API-Key',
    true,
    `${Date.now() - started} мс, ответов ${r.raws.length}, страниц позиций ${c.counts.pages}, позиций ${c.counts.positionsWithCosts}, строк ${c.counts.boqItems}`,
  );
  record('gzip в ответах', r.raws.some((x) => x.contentEncoding === 'gzip'), [...new Set(r.raws.map((x) => `${x.route}:${x.contentEncoding ?? 'identity'}`))].join(', '));
  record(
    'сверка до/после и между маршрутами',
    c.outcome === 'consistent',
    c.outcome === 'consistent' ? `consistent${c.updatedAtIsSourceNow ? '; updated_at шапки = время источника, исключён из сравнения' : ''}` : c.reasons.map((x) => x.code).join(', '),
  );
  record('номер тендера найден в brief (версия и срок подачи)', r.observed.briefFound, `версия ${r.observed.version ?? '—'}, срок ${r.observed.submissionDeadline ? 'есть' : 'нет'}`);
  const missingFields = Object.keys(c.missingFields);
  record('документированные поля есть в ответах сборки', null, missingFields.length ? `отсутствуют (R-06): ${missingFields.join(', ')}` : 'все');
  if (spec) {
    const seen = new Set<string>();
    for (const raw of r.raws) for (const f of fieldsOf(raw)) seen.add(f);
    const undocumented = [...seen].filter((f) => !new RegExp(`^\\s+${f.replace(/[^a-z0-9_]/giu, '')}:`, 'mu').test(spec!)).sort();
    record('поля ответов описаны в OpenAPI', null, undocumented.length ? `не найдены в спецификации: ${undocumented.join(', ')}` : `все ${seen.size}`);
  }
  if (r.content) record('нормализация', true, `позиций ${r.content.positions.length}, строк ${r.content.lines.length}, итог КП не выводится (Q-05)`);
  for (const raw of r.raws) record('ответ', null, `${raw.route} HTTP ${raw.status}, ${raw.body.length} байт, SHA-256 ${sha256(raw.body)}`);
} catch (err) {
  const e = err instanceof TenderHubError ? err.error : null;
  record('выгрузка тендера по X-API-Key', false, e ? `${e.code}/${e.reason}: ${e.message}` : err instanceof Error ? err.message : 'ошибка');
}

finish(failed ? 'FAIL' : 'PASS');
