// node scripts/ops/acceptance-matrix.ts --results <vitest JSON> --out docs/stages/17-acceptance-matrix.md [--env "<среда>"]
// Матрица passed / failed / blocked сценариев 05_ACCEPTANCE_CASES и RT-01…RT-08 (этап 17, проект §13.1). Первая колонка
// результата — тесты на поддельных данных (JSON-отчёт vitest полного набора), вторая — что нужно живьём и чем это
// блокируется. Отчёт vitest: npx vitest run --reporter=default --reporter=json --outputFile.json=<файл>.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACCEPTANCE_CASES, type LiveNeed } from '../../tests/acceptance/cases.ts';
import { argValue } from '../cli.ts';
import { caseResult, filesMentioning, type IVitestFile } from './acceptance-lib.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const LIVE: Record<LiveNeed, string> = {
  none: 'не требуется — поведение портала',
  target: 'BLOCKED до живой проверки на целевом ПК',
  external: 'BLOCKED_EXTERNAL',
  owner: 'BLOCKED до данных владельца',
};

// Эксплуатационные пункты задания этапа 17 (проект §13.2, §14): у разработчика проверяется код и сценарий, итог для
// ввода в эксплуатацию — только на целевом ПК. Статус здесь — состояние передачи 17-1, условие снятия — в последней колонке.
const OPERATIONS: ReadonlyArray<[string, string, string, string]> = [
  ['установка на Windows по runbook', 'генерация описаний служб, разбор осмотра Windows (`opsService`, `opsPreflight`)', 'BLOCKED', 'Review 17-1: тестовая установка служб на целевом ПК выполнена; окончательное размещение PostgreSQL, запуск после перезагрузки и ежедневная задача копии — не завершены'],
  ['размещение PostgreSQL (U-03)', '—', 'BLOCKED', '`ops:preflight` на целевом ПК → решение'],
  ['службы без окон: старт, стоп, перезапуск, выключение ПК, сбой', 'IPC-остановка, kill -9, перезапуск PostgreSQL — репетиция; модуль жизненного цикла — `workerShutdown`', 'BLOCKED', 'Review 17-1: службы WinSW running/auto, остановка службы worker — SIGINT, 565 мс, kill -9 во время OCR — PASS; выключение ПК — не проверялось'],
  ['обновление установки', 'репетиция: код `8964017` → копия `--pre-update` → `db:migrate` → проверки', 'PASS у разработчика; Review 17-1 — PASS', 'обновление 16 → 17 в репетиции на Windows: 42 → 43, данные и вход сохранены'],
  ['копия БД и файлов, восстановление на чистой среде, сверка манифеста (A40)', '`backupGrants`, `backupRestore`; репетиция', 'PASS у разработчика; Review 17-2 — репетиция на Windows PASS (восстановление, отказ на неверной стороне); копия без psql — R17-05, исправлено в 17-3', 'копия по расписанию и учебное восстановление установки на целевом ПК'],
  ['восстановление поверх рабочей системы невозможно', '`backupRestore` (охранники)', 'PASS', '—'],
  ['TenderHub — чтение расчёта', 'контракт на поддельном сервере; `VERIFIED_LIVE` (Review 06-1)', 'BLOCKED', 'Review 17-1: LIVE PASS, GET-only по архивному тендеру (1197 позиций); запись в базу установки и решение владельца — не выполнены'],
  ['ручной импорт EML', 'тесты почты; `VERIFIED_LIVE` (Review 07-2)', 'BLOCKED', '`real-eml-check` на сборке 17 + `ops:integration-verify`'],
  ['Яндекс Диск и сетевая папка', 'тесты размещения; тестовые папки — `VERIFIED_LIVE` (Review 14-2)', 'BLOCKED', '`delivery:live-smoke` под учётной записью службы worker на рабочих назначениях; В-17-4'],
  ['локальное распознавание на Windows (U-08)', 'тесты распознавания на Linux', 'BLOCKED', 'Review 17-1: скан фикстуры обработан службой worker — complete; длинный документ и память — не проверены'],
  ['LibreOffice и шрифты под службой', 'превью и сборка комплекта на Linux', 'BLOCKED', 'Review 17-1: конвертации и page-review — под интерактивной учётной записью; сборка службой — не подтверждена'],
  ['генеративная модель и эмбеддинги (LM Studio, GPU)', 'одновременность GPU = 1 (`gpuConcurrency`), пределы ответов (`degradation`)', 'BLOCKED', 'Review 17-1 и 17-2: механизмы LIVE PASS, в 17-2 — новым кодом (чат p50 126 мс, эмбеддинги p50 49 мс); через службу, рядом с агентом MailHub и качество — не проверены'],
  ['MCP по HTTPS: Codex CLI, Cursor CLI', 'HTTPS в тесте (`tls`); CLI по HTTP — `VERIFIED_LIVE` (Review 16-2)', 'BLOCKED', 'Review 17-1: CLI по HTTPS к службе — чтение, отказы области, отзыв токена; предложения и поиск клиента — не повторены'],
  ['телефоны руководителя: корень mkcert, вход, PWA', '—', 'BLOCKED', 'Review 17-1: владелец сообщил — оба телефона открывают портал по HTTPS, вход прошёл; PWA и согласование не проверялись'],
  ['MailHub, ревизия TenderHub, API RDWeb, переговоры', 'ручные пути', 'BLOCKED_EXTERNAL', 'X-03, X-01, X-05, Q-06 — ввод пилота не блокируют'],
  ['замеры на размере тендера', '`ops:measure` — проверка скрипта на машине разработки', 'BLOCKED', 'числа владельца — D-040: 10 000 позиций, ~30 000 строк, до 1 ГБ Markdown; Review 17-1 замерил 10 000 позиций с небольшими документами — профиль 1 ГБ не замерен'],
  ['SLO', '—', 'BLOCKED', 'предложение по замеру → решение владельца (В-17-5)'],
  ['список обязательных живых интеграций', 'предложение — проект §13.2', 'РЕШЕНО (D-040)', 'весь перечисленный набор обязателен; каждая строка выше блокирует ввод до живой проверки'],
];

const main = (): number => {
  const resultsPath = argValue('results');
  const out = argValue('out');
  if (!resultsPath || !out) {
    console.error('нужны --results <vitest JSON> и --out <файл матрицы>');
    return 2;
  }
  const report = JSON.parse(readFileSync(resultsPath, 'utf8')) as { testResults: IVitestFile[]; numTotalTests: number; numPassedTests: number; numFailedTests: number; startTime: number };
  const rows: string[] = [];
  const counts = { PASS: 0, FAIL: 0, NOT_RUN: 0 };
  const live = { none: 0, target: 0, external: 0, owner: 0 };
  for (const c of ACCEPTANCE_CASES) {
    const files = filesMentioning(resolve(ROOT, 'tests'), c.id);
    const r = caseResult(c.id, files, report.testResults);
    counts[r.status] += 1;
    live[c.live] += 1;
    const basis = r.basis === 'tests' ? `${r.passed} / ${r.total} тестов с меткой` : `${r.passed} / ${r.total} тестов файлов`;
    rows.push(`| ${c.id} | ${c.title} | ${r.status} | ${basis} | ${files.map((f) => `\`${f.replace('.test.ts', '')}\``).join(', ') || '—'} | ${LIVE[c.live]}${c.liveNote ? `: ${c.liveNote}` : ''} |`);
  }
  const env = argValue('env') ?? 'не указана';
  const text = [
    '# Этап 17 — матрица приёмочных сценариев',
    '',
    `Сформирована командой \`node scripts/ops/acceptance-matrix.ts\` по JSON-отчёту vitest (\`${resultsPath.replace(`${ROOT}/`, '')}\`). Среда прогона: ${env}. Полный набор: ${report.numPassedTests} / ${report.numTotalTests} пройдено, отказов ${report.numFailedTests}.`,
    '',
    'Колонка «Поддельные данные» — тесты с идентификатором сценария в названии, а если таких нет — все тесты файлов, где сценарий закреплён. Это доказательство поведения портала на синтетике, а не работающей интеграции. Колонка «Живьём» — что ещё нужно и чем это блокируется; статусы интеграций — `docs/integrations/status.md`.',
    '',
    `Итог по поддельным данным: PASS ${counts.PASS}, FAIL ${counts.FAIL}, NOT_RUN ${counts.NOT_RUN}. Живьём: не требуется ${live.none}; до проверки на целевом ПК ${live.target}; внешняя доработка ${live.external}; данные владельца ${live.owner}.`,
    '',
    '| ID | Сценарий | Поддельные данные | Основание | Файлы тестов | Живьём |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Эксплуатация и живые интеграции',
    '',
    'Пункты задания этапа 17 вне сценариев. У разработчика проверяются код и сценарий; итог для ввода в эксплуатацию — только на целевом ПК. Обязательный живой набор утверждён владельцем (D-040): каждая его интеграция блокирует ввод до живой проверки на установке.',
    '',
    '| Пункт | У разработчика | Статус | Условие снятия |',
    '|---|---|---|---|',
    ...OPERATIONS.map(([item, dev, status, cond]) => `| ${item} | ${dev} | ${status} | ${cond} |`),
    '',
  ].join('\n');
  writeFileSync(resolve(out), text);
  console.log(`матрица: ${out}; PASS ${counts.PASS}, FAIL ${counts.FAIL}, NOT_RUN ${counts.NOT_RUN}`);
  return counts.FAIL > 0 ? 1 : 0;
};

process.exitCode = main();
