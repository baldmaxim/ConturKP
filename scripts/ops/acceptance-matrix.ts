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
  ].join('\n');
  writeFileSync(resolve(out), text);
  console.log(`матрица: ${out}; PASS ${counts.PASS}, FAIL ${counts.FAIL}, NOT_RUN ${counts.NOT_RUN}`);
  return counts.FAIL > 0 ? 1 : 0;
};

process.exitCode = main();
