// Этап 17 (проект §13.1): каждый сценарий 05_ACCEPTANCE_CASES (A01–A46) и RT-01…RT-08 закреплён хотя бы в одном файле
// тестов своим идентификатором; список сценариев матрицы совпадает с пакетом; расчёт статуса сценария.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { caseResult, filesMentioning, idPattern } from '../scripts/ops/acceptance-lib.ts';
import { ACCEPTANCE_CASES } from './acceptance/cases.ts';

const ROOT = resolve(import.meta.dirname, '..');

describe('приёмочная матрица', () => {
  it('сценарии матрицы — ровно A01–A46 пакета и RT-01…RT-08 плана тестов', () => {
    const spec = readFileSync(join(ROOT, 'docs', 'spec', '05_ACCEPTANCE_CASES.md'), 'utf8');
    const fromSpec = [...spec.matchAll(/^\| (A\d{2}) \|/gmu)].map((m) => m[1]);
    const plan = readFileSync(join(ROOT, 'docs', 'architecture', 'test-plan.md'), 'utf8');
    const fromPlan = [...new Set([...plan.matchAll(/^\| (RT-0\d) \|/gmu)].map((m) => m[1]))].sort();
    expect(ACCEPTANCE_CASES.map((c) => c.id)).toEqual([...fromSpec, ...fromPlan]);
  });

  it('каждый сценарий закреплён в тестах своим идентификатором', () => {
    const missing = ACCEPTANCE_CASES.filter((c) => filesMentioning(join(ROOT, 'tests'), c.id).length === 0).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it('идентификатор не совпадает с соседними: A1 ≠ A10, RT-01 ≠ RT-010', () => {
    expect(idPattern('A01').test('A01: проверка')).toBe(true);
    expect(idPattern('A01').test('A010')).toBe(false);
    expect(idPattern('A01').test('XA01')).toBe(false);
    expect(idPattern('RT-01').test('RT-01 снимок')).toBe(true);
  });

  it('статус: тесты с меткой важнее файла; отказ любого — FAIL; нет тестов — NOT_RUN', () => {
    const results = [
      { name: '/x/tests/a.test.ts', assertionResults: [{ fullName: 'A07: новый документ', status: 'passed' }, { fullName: 'другое', status: 'failed' }] },
      { name: '/x/tests/b.test.ts', assertionResults: [{ fullName: 'без метки', status: 'passed' }] },
    ];
    expect(caseResult('A07', ['a.test.ts'], results)).toMatchObject({ status: 'PASS', basis: 'tests', passed: 1, total: 1 });
    expect(caseResult('A08', ['a.test.ts'], results)).toMatchObject({ status: 'FAIL', basis: 'files', passed: 1, total: 2 });
    expect(caseResult('A09', ['b.test.ts'], results)).toMatchObject({ status: 'PASS', basis: 'files' });
    expect(caseResult('A10', ['нет.test.ts'], results)).toMatchObject({ status: 'NOT_RUN' });
  });
});
