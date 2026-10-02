// R08-03 (Review 08-2): значение параметра при поиске конфликта требований (И-08-16, миграция 0021). Число —
// каноническим `numeric` (`100` = `100.0` = `100,00`, `100` ≠ `100.1`); смешанные обозначения (`B30`, `IP54`, `5x10`)
// — текстом: trim, нижний регистр, внутренние пробелы сведены к одному; единица — часть ключа после `unit_normalize`.
// Случаи 1–6 ревью проверяются API и второй линией БД (охранник ревизии требования — подтверждение в обход API).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmRequirementCandidate, getRequirementCandidate } from '../packages/db/src/index.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';
import { buildStage08, confirm, propose, supports, type IStage08 } from './requirementFixtures.ts';

let db: ITestDb;
let st: IStage08;

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage08(db, testConfig());
});
afterAll(async () => {
  await db.drop();
});

interface IParam {
  value: string;
  unit: string | null;
}

const valueKey = async (value: string, unit: string | null = null): Promise<string> =>
  (await db.pool.query<{ k: string }>('SELECT requirement_param_value(jsonb_build_object($1::text, $2::text, $3::text, $4::text)) AS k', ['value', value, 'unit', unit])).rows[0]!.k;

// Транзакция под ролью приложения: итог — код ошибки или ok (при отказе — откат).
const tx = async (fn: (c: pg.PoolClient) => Promise<void>): Promise<string> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return (e as { code?: string }).code ?? String(e);
  } finally {
    c.release();
  }
};

// Действующее требование A и предложение B с одним параметром; имя параметра у каждого случая своё.
const pair = async (n: number, a: IParam, b: IParam) => {
  const name = `Параметр R08-03 № ${n}`;
  const ca = await propose(st.s.eng1, st.registryId, `Требование A, случай ${n}`, supports(st.frag.facade), { parameters: [{ name, ...a }] });
  const ra = await confirm(st.s.manager, ca.id);
  expect(ra.status, ra.text).toBe(200);
  const cb = await propose(st.s.eng1, st.registryId, `Требование B, случай ${n}`, supports(st.frag.waterproofing), { parameters: [{ name, ...b }] });
  const codeA = (await st.s.manager.get(`/requirements/${ra.body.requirementId}`)).body.code as string;
  return { requirementA: ra.body.requirementId as string, codeA, candidateB: cb.id, key: name.toLowerCase() };
};

// Вторая линия: подтверждение B слоем БД в обход API; ожидается отказ охранника (транзакция откатывается).
const confirmDirect = async (candidateId: string, conflictNote: string | null): Promise<string> => {
  const row = (await getRequirementCandidate(db.pool, candidateId))!;
  return tx(async (c) => {
    await confirmRequirementCandidate(c, row, row.row_version, st.s.ids.manager, { statement: row.statement, parameters: row.parameters, objectScope: row.object_scope, conflictNote });
  });
};

describe('ключ значения параметра (функция БД, 0021)', () => {
  it('число — каноническим numeric: без незначащих нулей, десятичная запятая, группы разрядов, знак', async () => {
    const hundred = await valueKey('100', 'мм');
    expect(hundred).toBe('n:100|мм');
    for (const v of ['100.0', '100,00', ' 100 ', '+100', '100.000']) expect(await valueKey(v, 'мм'), v).toBe(hundred);
    expect(await valueKey('100', 'ММ')).toBe(hundred);
    expect(await valueKey('100.1', 'мм')).toBe('n:100.1|мм');
    expect(await valueKey('100,10', 'мм')).toBe('n:100.1|мм');
    expect(await valueKey('1 000', 'мм')).toBe('n:1000|мм');
    expect(await valueKey('1 000,50', 'мм')).toBe('n:1000.5|мм');
    expect(await valueKey('-0')).toBe('n:0|');
    expect(await valueKey('0,5')).toBe(await valueKey('0.50'));
  });

  it('смешанные и нечисловые записи — текст: trim, нижний регистр, пробелы сведены, не удалены', async () => {
    expect(await valueKey('B30')).toBe('t:b30|');
    expect(await valueKey('IP54')).toBe('t:ip54|');
    expect(await valueKey('5x10')).toBe('t:5x10|');
    expect(await valueKey(' Класс  B30 ')).toBe('t:класс b30|');
    expect(await valueKey(' b30 ')).toBe(await valueKey('B30'));
    // Внутренние пробелы различают текст: правило не удаляет их.
    expect(await valueKey('5  x 10')).toBe('t:5 x 10|');
    expect(await valueKey('5 x 10')).not.toBe(await valueKey('5x10'));
    expect(await valueKey('IP 54')).not.toBe(await valueKey('IP54'));
    // Не число по грамматике: экспонента, две точки, неверная группа разрядов, дробь без целой части.
    for (const v of ['1e3', '1.2.3', '10 00', '.5']) expect(await valueKey(v), v).toBe(`t:${v}|`);
    // Обозначение с числовым хвостом числом не становится: B30 ≠ B30.0.
    expect(await valueKey('B30.0')).toBe('t:b30.0|');
  });

  it('единица — часть ключа после unit_normalize', async () => {
    expect(await valueKey('100', 'мм')).not.toBe(await valueKey('100', 'см'));
    expect(await valueKey('12', 'куб.м')).toBe(await valueKey('12,0', 'м³'));
    expect(await valueKey('12', null)).not.toBe(await valueKey('12', 'м3'));
  });
});

const NO_CONFLICT: [string, number, IParam, IParam][] = [
  ['1. 100 мм против 100.0 мм', 1, { value: '100', unit: 'мм' }, { value: '100.0', unit: 'мм' }],
  ['2. 100,00 мм против 100 мм', 2, { value: '100,00', unit: 'мм' }, { value: '100', unit: 'мм' }],
  ['текст: B30 против « b30 » (регистр и крайние пробелы)', 7, { value: 'B30', unit: null }, { value: ' b30 ', unit: null }],
];

const CONFLICT: [string, number, IParam, IParam][] = [
  ['3. 100 мм против 100.1 мм', 3, { value: '100', unit: 'мм' }, { value: '100.1', unit: 'мм' }],
  ['4. одинаковое число, разные единицы: 100 мм против 100 см', 4, { value: '100', unit: 'мм' }, { value: '100', unit: 'см' }],
  ['5. B30 против B30.0: смешанное обозначение — текст, не число', 5, { value: 'B30', unit: null }, { value: 'B30.0', unit: null }],
];

describe('конфликта нет (R08-03): API и вторая линия БД', () => {
  it.each(NO_CONFLICT)('%s; 6. пояснение к конфликту отклоняется — conflict_note_unexpected / 23514', async (_title, n, a, b) => {
    const p = await pair(n, a, b);
    expect((await st.s.manager.get(`/requirement-candidates/${p.candidateB}`)).body).toMatchObject({ contradicted: false, conflicts: [] });
    const noted = await confirm(st.s.manager, p.candidateB, { conflictNote: 'Значения расходятся' });
    expect(noted.status, noted.text).toBe(409);
    expect(noted.body.current.reason).toBe('conflict_note_unexpected');
    expect(await confirmDirect(p.candidateB, 'Значения расходятся')).toBe('23514');
    const ok = await confirm(st.s.manager, p.candidateB);
    expect(ok.status, ok.text).toBe(200);
    expect((await st.s.manager.get(`/requirements/${ok.body.requirementId}`)).body).toMatchObject({ conflicts: [], conflictNote: null });
    expect((await st.s.manager.get(`/requirements/${p.requirementA}`)).body.conflicts).toEqual([]);
  });
});

describe('конфликт (R08-03): API и вторая линия БД', () => {
  it.each(CONFLICT)('%s — без пояснения 409 / 23514, с пояснением подтверждается, конфликт виден у обоих', async (_title, n, a, b) => {
    const p = await pair(n, a, b);
    const expected = [{ requirementId: p.requirementA, code: p.codeA, parameter: p.key }];
    expect((await st.s.manager.get(`/requirement-candidates/${p.candidateB}`)).body.conflicts).toEqual(expected);
    expect(await confirmDirect(p.candidateB, null)).toBe('23514');
    const bad = await confirm(st.s.manager, p.candidateB);
    expect(bad.status, bad.text).toBe(409);
    expect(bad.body.current).toMatchObject({ reason: 'requirement_conflict', contradicted: false, conflicts: [{ requirementId: p.requirementA, code: p.codeA }] });
    const ok = await confirm(st.s.manager, p.candidateB, { conflictNote: `Значение расходится с ${p.codeA}` });
    expect(ok.status, ok.text).toBe(200);
    const cardB = (await st.s.manager.get(`/requirements/${ok.body.requirementId}`)).body;
    expect(cardB).toMatchObject({ conflicts: expected, conflictNote: `Значение расходится с ${p.codeA}` });
    expect((await st.s.manager.get(`/requirements/${p.requirementA}`)).body.conflicts).toEqual([{ requirementId: cardB.id, code: cardB.code, parameter: p.key }]);
  });
});
