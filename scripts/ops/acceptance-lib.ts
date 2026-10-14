// Матрица приёмочных сценариев (этап 17, проект §13.1): тесты сценария находятся по идентификатору в файлах tests/
// (в названии теста или в тексте файла); статус — по JSON-отчёту vitest: сценарий PASS, если прошли все тесты с его
// идентификатором в названии, а если таких нет — все тесты файлов, где он закреплён.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const idPattern = (id: string): RegExp => new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`, 'u');

export const filesMentioning = (testsDir: string, id: string): string[] => {
  const re = idPattern(id);
  return readdirSync(testsDir)
    // Сторож матрицы сам перечисляет идентификаторы — закреплением сценария он не считается.
    .filter((f) => f.endsWith('.test.ts') && f !== 'acceptanceCases.test.ts')
    .filter((f) => re.test(readFileSync(join(testsDir, f), 'utf8')))
    .sort();
};

export interface IVitestAssertion {
  fullName: string;
  status: string;
}

export interface IVitestFile {
  name: string;
  assertionResults: IVitestAssertion[];
}

export type CaseStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

export interface ICaseResult {
  status: CaseStatus;
  basis: 'tests' | 'files';
  passed: number;
  total: number;
  files: string[];
}

export const caseResult = (id: string, files: string[], results: IVitestFile[]): ICaseResult => {
  const re = idPattern(id);
  const byFile = new Map(results.map((r) => [basename(r.name), r.assertionResults]));
  const named = results.flatMap((r) => r.assertionResults.filter((a) => re.test(a.fullName)));
  const pool = named.length > 0 ? named : files.flatMap((f) => byFile.get(f) ?? []);
  const passed = pool.filter((a) => a.status === 'passed').length;
  const failed = pool.filter((a) => a.status === 'failed').length;
  const status: CaseStatus = pool.length === 0 ? 'NOT_RUN' : failed > 0 || passed < pool.length ? 'FAIL' : 'PASS';
  return { status, basis: named.length > 0 ? 'tests' : 'files', passed, total: pool.length, files };
};
