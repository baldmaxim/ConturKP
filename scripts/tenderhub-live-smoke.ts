// Live-smoke TenderHub (этап 06, U-04; дополнен по решению после ревью 06-pre-1): разрешённый тендер
// читается официальным API по X-API-Key тем же адаптером и той же стратегией выгрузки, что у worker, без
// БД портала. Транспорт наблюдается подменой fetch (штатная опция клиента) — production-код не меняется.
// Запускается только после выдачи ключа владельцем:
//   npm run tenderhub:live-smoke -- --tender <uuid разрешённого тендера> [--out <файл журнала>]
// Адрес и ключ — только TENDERHUB_URL и TENDERHUB_API_KEY из окружения или .env. Только GET. В журнал —
// счётчики, имена полей, коды, статусы и хэши; ключ, данные тендера и сырые ответы не записываются, uuid
// маскируются. Статус интеграции скрипт не меняет.
// Код выхода: 0 — PASS, 1 — FAIL, 2 — неверный запуск, 3 — NOT_RUN (TenderHub не настроен).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  envelopeData,
  parseJsonWithLexemes,
  POSITIONS_PAGE_LIMIT,
  runPortalCapture,
  TENDERHUB_CONTRACT_VERSION,
  TenderHubApiSource,
  TenderHubError,
  TenderHubHttpClient,
  type IPortalCaptureResult,
  type IRawResponse,
  type ITenderHubError,
} from '../packages/adapters/src/index.ts';
import { loadTenderHubConfig } from '../packages/config/src/index.ts';
import { argValue, fail } from './cli.ts';
import {
  collectSensitive,
  createObserver,
  formatLine,
  ln,
  maskUuids,
  newSensitive,
  OPENAPI_PATH,
  redactLines,
  specFrom,
  type ILine,
  type ISensitive,
} from './tenderhub-live-smoke-observe.ts';
import {
  accessLines,
  boqLines,
  consistencyLines,
  contractDiffs,
  diffLines,
  numericLines,
  paginationLines,
  paginationOf,
  probeLines,
  q05Lines,
  requestLines,
  responseLines,
  withCostsLines,
  type IProbePlan,
} from './tenderhub-live-smoke-report.ts';

const ROOT = resolve(import.meta.dirname, '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Пробный обход: не больше страниц, чем нужно для трёх-четырёх страниц малого размера.
const PROBE_MAX_PAGES = 10;

const tenderId = argValue('tender')?.toLowerCase() ?? '';
if (!UUID.test(tenderId)) fail('нужен --tender <uuid разрешённого владельцем тендера TenderHub>', 2);
const outFile = resolve(argValue('out') ?? join(ROOT, 'artifacts', 'stage-06', 'live-smoke.log'));
const { tenderhub: th, problems } = loadTenderHubConfig();

const errorText = (err: unknown): string =>
  err instanceof TenderHubError ? `${err.error.code}/${err.error.reason}: ${err.error.message}` : err instanceof Error ? `${err.name}: ${err.message}` : 'ошибка';

type Section = [title: string, lines: ILine[]];

// Журнал: маскирование uuid, затем скрытие строк, совпавших с ключом или значениями тендера; ключ
// дополнительно проверяется в готовом тексте.
const finish = (sections: Section[], status: 'PASS' | 'FAIL' | 'NOT_RUN', sensitive: ISensitive): never => {
  const body = sections.flatMap(([title, lines]) => [`## ${title}`, ...lines.map(formatLine)]).map(maskUuids);
  const safe = redactLines(body, sensitive, th.apiKey ? [th.apiKey] : []);
  const redaction =
    safe.redacted === 0
      ? ln('PASS', 'log_redaction', 'PASS', 'ключа, значений тендера и сырых ответов нет; uuid маскированы, курсоры — хэш-метками')
      : ln('FAIL', 'log_redaction', 'FAIL', `скрыто строк: ${safe.redacted} (${safe.kinds.join(', ')})`);
  const final = safe.redacted > 0 && status === 'PASS' ? 'FAIL' : status;
  const text = [
    `# tenderhub live-smoke — ${new Date().toISOString()}`,
    `# адаптер ${TENDERHUB_CONTRACT_VERSION}; только GET; ключ, данные тендера и сырые ответы не записываются`,
    ...safe.lines,
    '## 10. Безопасность журнала',
    formatLine(redaction),
    `Итог: ${final}`,
    '',
  ].join('\n');
  if (th.apiKey && text.includes(th.apiKey)) fail('журнал содержит ключ — не записан', 1);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  process.stdout.write(`${text}журнал — ${outFile}\n`);
  process.exit(final === 'PASS' ? 0 : final === 'NOT_RUN' ? 3 : 1);
};

if (problems.length > 0) finish([['1. Origin и доступ', problems.map((p) => ln('FAIL', 'config', 'FAIL', p))]], 'FAIL', newSensitive());
if (!th.baseUrl || !th.apiKey) {
  const note = `TENDERHUB_URL ${th.baseUrl ? 'задан' : 'не задан'}, TENDERHUB_API_KEY ${th.apiKey ? 'задан' : 'не задан'} (U-04)`;
  finish([['1. Origin и доступ', [ln('INFO', 'tenderhub', 'NOT_RUN', note)]]], 'NOT_RUN', newSensitive());
}

const observer = createObserver();
const http = new TenderHubHttpClient({
  baseUrl: th.baseUrl!,
  apiKey: th.apiKey!,
  timeoutMs: th.timeoutMs,
  rateLimitPerMinute: th.rateLimitPerMinute,
  windowMs: th.rateLimitWindowMs,
  maxResponseBytes: th.maxResponseBytes,
  rateLimitWaits: 2,
  fetchImpl: observer.fetch,
});

// 1. Живая спецификация сборки.
observer.phase = 'spec';
let specRaw: IRawResponse | null = null;
let specProblem: string | null = null;
try {
  specRaw = await http.get('openapi', OPENAPI_PATH);
} catch (err) {
  specProblem = errorText(err);
}
const spec = specFrom(specRaw, specProblem);

// 2. Выгрузка той же стратегией, что у worker.
observer.phase = 'capture';
const started = Date.now();
let result: IPortalCaptureResult | null = null;
let captureError: ITenderHubError | null = null;
let internalError: string | null = null;
try {
  result = await runPortalCapture(new TenderHubApiSource(http), tenderId);
} catch (err) {
  if (err instanceof TenderHubError) captureError = err.error;
  else internalError = errorText(err);
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1).replace('.', ',');
const sensitive = observer.sensitive;
for (const raw of result?.raws ?? []) {
  try {
    collectSensitive(parseJsonWithLexemes(raw.body.toString('utf8')), sensitive);
  } catch {
    // ответ уже разобран адаптером; не JSON здесь быть не может
  }
}
const capture = observer.calls.filter((c) => c.phase === 'capture');
const main = paginationOf(capture);

// 3. Пробный обход малыми страницами — только если рабочая выгрузка уместилась в одну страницу.
const total = result?.consistency.before.positionCount ?? 0;
const plan: IProbePlan = !result
  ? { status: 'SKIPPED', note: 'выгрузка не завершилась', limit: 0, expected: 0 }
  : main.requests > 1
    ? { status: 'SKIPPED', note: 'рабочая выгрузка уже многостраничная', limit: 0, expected: total }
    : total < 2
      ? { status: 'NOT_OBSERVED', note: 'позиций меньше двух: многостраничный обход невозможен', limit: 0, expected: total }
      : { status: 'RUN', note: '', limit: Math.min(POSITIONS_PAGE_LIMIT, Math.max(1, Math.ceil(total / 3))), expected: total };
let probeError: string | null = null;
if (plan.status === 'RUN') {
  observer.phase = 'probe';
  try {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < PROBE_MAX_PAGES; page += 1) {
      const path = `/api/v1/tenders/${encodeURIComponent(tenderId)}/positions?limit=${plan.limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const raw = await http.get('positions', path);
      const next: string | null = envelopeData(parseJsonWithLexemes(raw.body.toString('utf8')), 'positions').nextCursor;
      if (next === null || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
  } catch (err) {
    probeError = errorText(err);
  }
}
const probe = plan.status === 'RUN' ? paginationOf(observer.calls.filter((c) => c.phase === 'probe')) : null;

const captureLine = result
  ? ln('PASS', 'capture', 'completed', `ответов ${result.raws.length}, ${elapsed} с; итог сверки — раздел 6`)
  : ln('FAIL', 'capture', 'FAIL', captureError ? `${captureError.code}/${captureError.reason}: ${captureError.message}` : `внутренняя ошибка: ${internalError ?? '—'}`);
const raws = result?.raws ?? null;
const sections: Section[] = [
  ['1. Origin и доступ', accessLines({ baseUrl: th.baseUrl!, tenderId, calls: observer.calls, spec })],
  ['2. Только GET', requestLines(observer.calls)],
  ['3. Выгрузка и пагинация positions', [captureLine, ...paginationLines(main, POSITIONS_PAGE_LIMIT), ...probeLines(plan, probe, probeError)]],
  ['4. with-costs / no-cache', withCostsLines({ calls: capture, raws, reasons: result?.consistency.reasons ?? null, positionIds: main.ids })],
  ['5. BOQ (boq-items-full)', boqLines({ calls: capture, raws })],
  ['6. Согласованность (рабочая PortalCaptureStrategy)', consistencyLines(result?.consistency ?? null)],
  ['7. Числовой контракт', numericLines(raws)],
  ['8. Q-05 — только наличие полей', q05Lines(raws, spec)],
  ['9. Расхождения с контрактом', diffLines(contractDiffs({ calls: observer.calls, spec, captureError, missing: result?.consistency.missingFields ?? null, raws }))],
  ['Ответы', responseLines([...(specRaw ? [specRaw] : []), ...(raws ?? [])])],
];
const failed = sections.some(([, lines]) => lines.some((l) => l.mark === 'FAIL'));
sections.push([
  'Статус интеграции',
  [ln('INFO', 'integration_status', failed ? 'VERIFIED_FIXTURE' : 'VERIFIED_FIXTURE → кандидат VERIFIED_LIVE', 'скрипт статус не меняет: запись — после ревью журнала')],
]);
finish(sections, failed ? 'FAIL' : 'PASS', sensitive);
