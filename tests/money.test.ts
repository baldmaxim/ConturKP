// Ядро экономики этапа 10 (D-030; проект §4, §5): десятичная арифметика и округление, сопоставимость (A18, A19, A21),
// формула строки и отклонения источника, отчёт ревизии, разложение цепными подстановками (A20, A22, проверки задания),
// предложения сопоставления и разбор гипотез причин. Эталонные значения заданы в тесте до запуска (test-plan.md:24).
import { describe, expect, it } from 'vitest';
import {
  buildRevisionEconomics,
  checkLine,
  comparable,
  compareRevisions,
  dec,
  MoneyArithmeticError,
  mul,
  parseReasons,
  planProposals,
  round2HalfAway,
  str,
  sub,
  sum,
  tenderHubApiComponents,
  type ICompareSide,
  type IComparePosition,
  type ILineInput,
  type IMoneyBasis,
  type IRates,
} from '../packages/core/src/index.ts';

const RATES: IRates = { USD: '90', EUR: '99', CNY: '12.5' };
const NO_RATES: IRates = { USD: null, EUR: null, CNY: null };

const line = (id: string, pos: string, o: Partial<ILineInput> = {}): ILineInput => ({
  externalItemId: id,
  externalPositionId: pos,
  itemType: 'раб',
  materialType: null,
  unitCode: 'м2',
  description: 'Штукатурка стен',
  workNameId: 'w-plaster',
  materialNameId: null,
  detailCostCategoryId: null,
  parentWorkExternalItemId: null,
  quantity: '1',
  consumptionCoefficient: null,
  conversionCoefficient: null,
  unitRate: '0',
  currency: 'RUB',
  deliveryPriceType: null,
  deliveryAmount: null,
  totalAmount: '0',
  commercialMarkup: '1',
  totalCommercialMaterial: '0',
  totalCommercialWork: '0',
  ...o,
});

// Работа: total = q × r; коммерческая колонка «работы» = total × k.
const work = (id: string, pos: string, q: string, r: string, k: string, o: Partial<ILineInput> = {}): ILineInput => {
  const total = str(mul(dec(q), dec(r)));
  return line(id, pos, { quantity: q, unitRate: r, totalAmount: total, commercialMarkup: k, totalCommercialWork: str(mul(dec(total), dec(k))), ...o });
};

const pos = (id: string, o: Partial<IComparePosition> = {}): IComparePosition => ({
  externalPositionId: id,
  positionNumber: '1',
  itemNo: '1',
  workName: 'Штукатурка стен',
  unitCode: 'м2',
  isAdditional: false,
  isSection: false,
  manualVolume: '100',
  ...o,
});

const side = (revisionId: string, positions: IComparePosition[], lines: ILineInput[], grandTotal: string | null, rates = NO_RATES): ICompareSide => ({
  revisionId,
  contentHash: `hash-${revisionId}`,
  grandTotal,
  rates,
  positions,
  lines,
});

const effectsOf = (r: ReturnType<typeof compareRevisions>, measure: 'cost' | 'commercial', unitNo: number | null = 1) =>
  Object.fromEntries(r.effects.filter((e) => e.measure === measure && e.unitNo === unitNo).map((e) => [e.component, str(e.amount)]));

describe('десятичная арифметика (ADR-005, D-030 В-10-3)', () => {
  it('округление money2_half_away — как cached_grand_total и ROUND(numeric, 2)', () => {
    expect(['1.005', '-1.005', '2.675', '100.555', '0.004', '-0.005'].map((s) => str(round2HalfAway(dec(s))))).toEqual(['1.01', '-1.01', '2.68', '100.56', '0', '-0.01']);
  });
  it('21 значащая цифра проходит без потерь; запись — как trim_scale(numeric)', () => {
    expect(str(mul(dec('123456789012345.678901'), dec('1e-7')))).toBe('12345678.9012345678901');
    expect(str(sub(dec('1.50'), dec('0.50')))).toBe('1');
    expect(str(sub(dec('0'), dec('0')))).toBe('0');
  });
  it('результат, требующий округления промежуточного значения, — ошибка, а не тихое округление', () => {
    const big = `1${'7'.repeat(209)}`;
    expect(() => mul(dec(big), dec(big))).toThrow(MoneyArithmeticError);
    expect(() => dec('NaN')).toThrow(MoneyArithmeticError);
  });
});

describe('сопоставимость (ADR-005 §5, D-030 В-10-2)', () => {
  const basis = (o: Partial<IMoneyBasis> = {}): IMoneyBasis => ({ currency: 'RUB', vat: 'unknown', priceKind: 'cost', unitBase: null, field: 'tenderhub.total_amount', semanticsVersion: 'v1', ...o });
  it('A19: себестоимость и коммерческая цена — разные виды цены, не расхождение', () => {
    const r = comparable(basis(), basis({ priceKind: 'commercial' }));
    expect(r).toMatchObject({ comparable: false, code: 'price_kind_differs' });
    expect(comparable(basis({ priceKind: 'supplier_quote', vat: 'excluded', field: null }), basis())).toMatchObject({ comparable: false, code: 'price_kind_differs' });
  });
  it('A21: неизвестная валюта — несопоставимо; при неизвестном НДС — только одно поле одного вида цены', () => {
    expect(comparable(basis({ currency: 'UNKNOWN' }), basis())).toMatchObject({ comparable: false, code: 'currency_unknown' });
    expect(comparable(basis(), basis({ field: 'tenderhub.commercial_columns' }))).toMatchObject({ comparable: false, code: 'vat_unknown' });
    expect(comparable(basis(), basis({ semanticsVersion: 'v2' }))).toMatchObject({ comparable: false, code: 'vat_unknown' });
    expect(comparable(basis(), basis())).toEqual({ comparable: true, basis: 'same_source_field' });
    expect(comparable(basis({ vat: 'excluded', field: null }), basis({ vat: 'included', field: null }))).toMatchObject({ comparable: false, code: 'vat_differs' });
    expect(comparable(basis({ vat: 'excluded', field: null }), basis({ vat: 'excluded', field: null }))).toEqual({ comparable: true, basis: 'same_attributes' });
  });
  it('A18: цены за разные базы единицы без явного пересчёта объёма несопоставимы', () => {
    expect(comparable(basis({ unitBase: 'шт' }), basis({ unitBase: '10 шт' }))).toMatchObject({ comparable: false, code: 'unit_base_differs' });
    expect(comparable(basis({ unitBase: 'шт' }), basis({ unitBase: 'шт' }))).toMatchObject({ comparable: true });
  });
});

describe('формула строки и отклонения источника (таблица семантики п. 4–7, 13; §5.9)', () => {
  it('материал «не в цене» в USD: Q × K × (R × F × 1,03)', () => {
    const l = line('m1', 'p1', { itemType: 'суб-мат', quantity: '10', consumptionCoefficient: '1.02', unitRate: '2', currency: 'USD', deliveryPriceType: 'не в цене', totalAmount: '1891.08' });
    const c = checkLine(l, RATES, undefined);
    expect(c.formula).toBe('material');
    // 10 × 1,02 × (2 × 90 × 1,03) = 1891,08.
    expect(str(c.recomputedCost!)).toBe('1891.08');
    expect(c.withinTolerance).toBe(true);
    expect(c.flags).toEqual([]);
  });
  it('доставка «суммой» — ₽ за единицу без курса; привязанный материал — расход 1 в формуле, вывод количества — диагностика', () => {
    const parent = line('w1', 'p1', { quantity: '50', unitRate: '10', totalAmount: '500' });
    const child = line('m1', 'p1', { itemType: 'мат', quantity: '100', unitRate: '100', deliveryPriceType: 'суммой', deliveryAmount: '5', consumptionCoefficient: '1.1', conversionCoefficient: '2', parentWorkExternalItemId: 'w1', totalAmount: '10500' });
    const c = checkLine(child, NO_RATES, parent);
    expect(str(c.recomputedCost!)).toBe('10500');
    expect(str(c.derivedQuantity!)).toBe('110');
    expect(c.flags).toEqual(['bound_quantity_mismatch']);
  });
  it('нулевое количество, отрицательная сумма, неизвестный тип, пустая коммерческая стоимость, нет курса, вне допуска — флаги, данные не исправляются', () => {
    expect(checkLine(line('a', 'p', { quantity: '0' }), NO_RATES, undefined).flags).toEqual(['quantity_nonpositive']);
    expect(checkLine(line('b', 'p', { quantity: '1', unitRate: '-500', totalAmount: '-500' }), NO_RATES, undefined).flags).toEqual(['negative_amount']);
    const other = checkLine(line('c', 'p', { itemType: 'прочее', totalAmount: '7' }), NO_RATES, undefined);
    expect(other).toMatchObject({ formula: 'not_applicable', recomputedCost: null, withinTolerance: null, flags: ['unknown_item_type'] });
    expect(checkLine(line('d', 'p', { totalCommercialMaterial: null, totalCommercialWork: null }), NO_RATES, undefined).flags).toEqual(['missing_commercial']);
    expect(checkLine(line('e', 'p', { currency: 'USD', unitRate: '1', totalAmount: '90' }), NO_RATES, undefined).flags).toEqual(['missing_fx_rate']);
    const off = checkLine(line('f', 'p', { quantity: '100', unitRate: '10', totalAmount: '1001' }), NO_RATES, undefined);
    expect(off.flags).toEqual(['recompute_outside_tolerance']);
    expect(str(off.deviation!)).toBe('1');
    // Хвост float64 источника — в допуске.
    expect(checkLine(line('g', 'p', { quantity: '3', unitRate: '0.1', totalAmount: '0.30000000000000004' }), NO_RATES, undefined).withinTolerance).toBe(true);
  });
});

describe('отчёт ревизии (§5.5; D-030 В-10-1, п. 11)', () => {
  const lines = [work('l1', 'p1', '100', '10', '1.2'), work('l2', 'p2', '3', '7.005', '1')];
  const base = { rates: NO_RATES, ratesObservedAt: '2026-10-05T10:00:00.000Z', positions: [{ externalPositionId: 'p1', isSection: false, manualVolume: '100', commercialTotal: '1200' }, { externalPositionId: 'p2', isSection: false, manualVolume: null, commercialTotal: '21.015' }], lines, components: tenderHubApiComponents('test') };
  it('остаток итога — отдельно и неподтверждённый; допуск записан; составляющие — «недоступно по ключу»', () => {
    const { report } = buildRevisionEconomics({ ...base, grandTotal: '1231.02' });
    expect(report.totals).toMatchObject({ cost: '1021.015', commercial: '1221.015', commercialWorkColumn: '1221.015' });
    expect(report.reconciliation).toMatchObject({ target: '1231.02', confirmedPartRounded: '1221.02', residual: '10', tolerance: '0.01', status: 'residual_unconfirmed', rounding: 'money2_half_away' });
    expect(report.reconciliation.note).toMatch(/не объясняется ни страхованием, ни округлением, ни задержкой пересчёта/u);
    expect(report.components.every((c) => c.status === 'unavailable_by_key')).toBe(true);
    expect(report.positionsUnitPriceUndefined).toBe(1);
    expect(report.rates.observedAt).toBe('2026-10-05T10:00:00.000Z');
  });
  it('итог в пределах допуска — сверено; итога нет — цели нет', () => {
    expect(buildRevisionEconomics({ ...base, grandTotal: '1221.02' }).report.reconciliation.status).toBe('reconciled');
    expect(buildRevisionEconomics({ ...base, grandTotal: null }).report.reconciliation).toMatchObject({ status: 'no_target', residual: null });
  });
});

describe('разложение цепными подстановками (§5.1; D-030 В-10-3)', () => {
  it('A20: объём и цена одновременно — вклады по методу сходятся с общей дельтой; остаток уровня тендера — отдельно', () => {
    // 100 м2 × 10 = 1000 → 110 м2 × 12 = 1320; коэффициент 1,2 → 1,25; итог 1210 → 1700.
    const r = compareRevisions(side('a', [pos('p1')], [work('l1', 'p1', '100', '10', '1.2')], '1210'), side('b', [pos('p2')], [work('l2', 'p2', '110', '12', '1.25')], '1700'), [
      { lineageId: 'x', from: 'p1', to: 'p2' },
    ]);
    expect(effectsOf(r, 'cost')).toEqual({ volume: '100', unit_rate: '220' });
    expect(effectsOf(r, 'commercial')).toEqual({ volume: '120', unit_rate: '264', coefficient: '66' });
    expect(effectsOf(r, 'commercial', null)).toEqual({ incomparable_units: '0', unexplained_remainder: '40' });
    expect(r.units[0]).toMatchObject({ kind: 'matched' });
  });
  it('валюта: изменился только курс — только вклад курса; смена валюты строки — один вклад', () => {
    const usd = (id: string, p: string, r: string) => work(id, p, '10', r, '1', { currency: 'USD', totalAmount: str(mul(mul(dec('10'), dec(r)), dec(r === '2' ? '90' : '100'))) });
    const a = side('a', [pos('p')], [line('l', 'p', { currency: 'USD', quantity: '10', unitRate: '2', totalAmount: '1800', totalCommercialWork: '1800' })], null, { ...RATES, USD: '90' });
    const b = side('b', [pos('p')], [line('l', 'p', { currency: 'USD', quantity: '10', unitRate: '2', totalAmount: '2000', totalCommercialWork: '2000' })], null, { ...RATES, USD: '100' });
    expect(effectsOf(compareRevisions(a, b, [{ lineageId: 'x', from: 'p', to: 'p' }]), 'cost')).toEqual({ fx_rate: '200' });
    void usd;
    const rub = side('c', [pos('p')], [line('l', 'p', { quantity: '10', unitRate: '180', totalAmount: '1800', totalCommercialWork: '1800' })], null, RATES);
    expect(effectsOf(compareRevisions(rub, b, [{ lineageId: 'x', from: 'p', to: 'p' }]), 'cost')).toEqual({ currency_change: '200' });
  });
  it('доставка: «в цене» → «не в цене» даёт вклад доставки 3 %', () => {
    const m = (delivery: string, total: string) => line('l', 'p', { itemType: 'мат', quantity: '10', unitRate: '100', deliveryPriceType: delivery, totalAmount: total, totalCommercialMaterial: total, totalCommercialWork: null });
    const r = compareRevisions(side('a', [pos('p')], [m('в цене', '1000')], null), side('b', [pos('p')], [m('не в цене', '1030')], null), [{ lineageId: 'x', from: 'p', to: 'p' }]);
    expect(effectsOf(r, 'cost')).toEqual({ delivery: '30' });
  });
  it('общий discount: −5 % коэффициента на всех строках — Σ вкладов «коэффициент» равна дельте', () => {
    const a = side('a', [pos('p1'), pos('p2', { itemNo: '2', workName: 'Окраска', positionNumber: '2' })], [work('l1', 'p1', '10', '100', '1.2'), work('l2', 'p2', '5', '40', '1.2', { description: 'Окраска', workNameId: 'w-paint' })], null);
    const b = side('b', [pos('p1'), pos('p2', { itemNo: '2', workName: 'Окраска', positionNumber: '2' })], [work('l1', 'p1', '10', '100', '1.14'), work('l2', 'p2', '5', '40', '1.14', { description: 'Окраска', workNameId: 'w-paint' })], null);
    const r = compareRevisions(a, b, [{ lineageId: 'x', from: 'p1', to: 'p1' }, { lineageId: 'y', from: 'p2', to: 'p2' }]);
    const coefficient = sum(r.effects.filter((e) => e.measure === 'commercial' && e.component === 'coefficient').map((e) => e.amount));
    expect(str(coefficient)).toBe('-72');
    expect(str(r.totals.commercial.delta)).toBe('-72');
  });
  it('quantity = 0 и отрицательная строка источника: без деления, знак не ограничен, Σ = Δ', () => {
    const a = side('a', [pos('p')], [work('l', 'p', '0', '100', '1')], null);
    const b = side('b', [pos('p')], [work('l', 'p', '10', '100', '1'), work('neg', 'p', '1', '-500', '1', { description: 'Согласованная корректировка', workNameId: 'w-adj' })], null);
    const r = compareRevisions(a, b, [{ lineageId: 'x', from: 'p', to: 'p' }]);
    expect(effectsOf(r, 'cost')).toEqual({ volume: '1000', composition_added: '-500' });
    expect(str(r.totals.cost.delta)).toBe('500');
  });
  it('A22: разделение позиции на две — одна единица, каждая строка учтена один раз', () => {
    const left = side('a', [pos('p', { workName: 'Кладка стен' })], [
      work('l1', 'p', '10', '100', '1', { description: 'Кладка наружная', workNameId: 'w-out' }),
      work('l2', 'p', '20', '100', '1', { description: 'Кладка внутренняя', workNameId: 'w-in' }),
    ], null);
    const right = side('b', [pos('q1', { workName: 'Кладка наружных стен', positionNumber: '1.1' }), pos('q2', { workName: 'Кладка внутренних стен', positionNumber: '1.2' })], [
      work('r1', 'q1', '12', '100', '1', { description: 'Кладка наружная', workNameId: 'w-out' }),
      work('r2', 'q2', '20', '110', '1', { description: 'Кладка внутренняя', workNameId: 'w-in' }),
    ], null);
    const r = compareRevisions(left, right, [{ lineageId: 'x', from: 'p', to: 'q1' }, { lineageId: 'y', from: 'p', to: 'q2' }]);
    expect(r.units).toHaveLength(1);
    expect(r.units[0]).toMatchObject({ kind: 'split_merge', left: ['p'], right: ['q1', 'q2'] });
    expect(effectsOf(r, 'cost')).toEqual({ volume: '200', unit_rate: '200' });
    expect(str(r.totals.cost.delta)).toBe('400');
  });
  it('без подтверждённой пары позиции — «удалено» и «добавлено»; пустая коммерческая стоимость — единица несопоставима по коммерческой мере', () => {
    const r = compareRevisions(side('a', [pos('p')], [work('l', 'p', '1', '10', '1')], null), side('b', [pos('q')], [work('m', 'q', '1', '12', '1', { totalCommercialMaterial: null, totalCommercialWork: null, commercialMarkup: null })], null), []);
    expect(r.units.map((u) => u.kind)).toEqual(['added', 'removed']);
    expect(r.units[0]!.commercial).toMatchObject({ comparable: false, reason: 'у строки пустая коммерческая стоимость (не 0)' });
    expect(effectsOf(r, 'commercial', null)).toEqual({ incomparable_units: '0', unexplained_remainder: '0' });
    expect(effectsOf(r, 'commercial', 2)).toEqual({ composition_removed: '-10' });
  });
  it('Σ вкладов = итоговая разница на детерминированных случайных парах; повтор даёт тот же хэш', () => {
    let seed = 20261005;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let c = 0; c < 40; c += 1) {
      const mk = (rev: string) => {
        const lines = Array.from({ length: 4 }, (_, i) =>
          rnd(3) === 0
            ? line(`m${i}`, 'p', { itemType: 'суб-мат', description: `Материал ${i}`, materialNameId: `m${i}`, workNameId: null, quantity: String(rnd(50)), consumptionCoefficient: rnd(2) ? '1.05' : null, unitRate: `${rnd(900)}.${rnd(100)}`, currency: rnd(2) ? 'USD' : 'RUB', deliveryPriceType: ['в цене', 'не в цене', 'суммой'][rnd(3)]!, deliveryAmount: String(rnd(9)), totalAmount: String(rnd(100000)), commercialMarkup: `1.${rnd(40)}`, totalCommercialMaterial: String(rnd(100000)), totalCommercialWork: String(rnd(9000)) })
            : work(`w${i}`, 'p', String(rnd(300)), `${rnd(500)}.${rnd(1000)}`, `1.${rnd(30)}`, { description: `Работа ${i}`, workNameId: `w${i}` }),
        );
        return side(rev, [pos('p')], rnd(4) === 0 ? lines.slice(1) : lines, String(rnd(200000)), { ...RATES, USD: String(80 + rnd(30)) });
      };
      const a = mk(`a${c}`);
      const b = mk(`b${c}`);
      const r = compareRevisions(a, b, [{ lineageId: 'x', from: 'p', to: 'p' }]);
      for (const m of ['cost', 'commercial'] as const) expect(str(sum(r.effects.filter((e) => e.measure === m).map((e) => e.amount)))).toBe(str(r.totals[m].delta));
      expect(compareRevisions(a, b, [{ lineageId: 'x', from: 'p', to: 'p' }]).resultSha256).toBe(r.resultSha256);
    }
  });
});

describe('предложения сопоставления (§5.3; D-030 В-10-5, «Дополнение»)', () => {
  const p = (id: string, n: string, name: string, itemNo: string | null = n, o: Partial<IComparePosition> = {}) => pos(id, { positionNumber: n, itemNo, workName: name, ...o });
  it('система подтверждает только тот же UUID одного экземпляра, тендера и версии; при неизвестном экземпляре — предложение', () => {
    expect(planProposals([p('u1', '1', 'А')], [p('u1', '1', 'А')], [], 'same')).toMatchObject({ systemConfirmed: [{ from: 'u1', to: 'u1' }], proposals: [] });
    expect(planProposals([p('u1', '1', 'А')], [p('u1', '1', 'А')], [], 'unknown')).toMatchObject({ systemConfirmed: [], proposals: [{ method: 'source_lineage' }] });
    expect(planProposals([p('u1', '1', 'А')], [p('u2', '1', 'А')], [], 'same').systemConfirmed).toEqual([]);
  });
  it('ключи change-impact и clone — только предложения; согласие ключей отмечается; расхождение — ручная проверка', () => {
    const agree = planProposals([p('a', '1', 'Кладка')], [p('b', '1', 'Кладка')], [], 'different');
    expect(agree.proposals).toEqual([{ from: 'a', to: 'b', method: 'exact_key', keysAgree: true }]);
    // item_no совпал у одной правой позиции, номер позиции — у другой.
    const dispute = planProposals([p('a', '1', 'Кладка', '7')], [p('b', '2', 'Кладка', '7'), p('c', '1', 'Кладка', '9')], [], 'different');
    expect(dispute.proposals).toEqual([]);
    expect(dispute.ambiguous).toEqual([{ reason: 'keys_disagree', left: ['a'], right: ['b', 'c'] }]);
  });
  it('повтор ключа (одна работа на разных этажах) — не склеивается; разделы не сопоставляются; отклонённое и решённое не предлагается снова', () => {
    const dup = planProposals([p('a1', '1', 'Стяжка', null), p('a2', '2', 'Стяжка', null)], [p('b1', '3', 'Стяжка', null), p('b2', '4', 'Стяжка', null)], [], 'different');
    expect(dup.proposals).toEqual([]);
    expect(dup.ambiguous).toEqual([{ reason: 'duplicate_key', left: ['a1', 'a2'], right: ['b1', 'b2'] }]);
    expect(planProposals([p('s', '1', 'Раздел', null, { isSection: true })], [p('t', '1', 'Раздел', null, { isSection: true })], [], 'different').proposals).toEqual([]);
    expect(planProposals([p('a', '1', 'Кладка')], [p('b', '1', 'Кладка')], [{ from: 'a', to: 'b', status: 'rejected' }], 'different').proposals).toEqual([]);
    expect(planProposals([p('a', '1', 'Кладка')], [p('b', '1', 'Кладка')], [{ from: 'a', to: 'z', status: 'confirmed' }], 'different').proposals).toEqual([]);
  });
});

describe('разбор гипотез причин (§5.8; I11, I12, ADR-009)', () => {
  const input = { units: [{ unitId: 'u1', title: 'Кладка', unitCode: 'м3', effects: {}, fragments: [{ fragmentId: 'f-doc', origin: 'document_text', text: 'кладка' }, { fragmentId: 'f-qa', origin: 'qa_answer', text: 'ответ' }] }] };
  it('только единицы пакета, виды модели, ссылки на фрагменты своей единицы подходящего происхождения', () => {
    const r = parseReasons(
      JSON.stringify({
        reasons: [
          { unitId: 'u1', reasonKind: 'answer', rationale: 'Ответ заказчика', fragmentIds: ['f-qa'] },
          { unitId: 'u2', reasonKind: 'document', rationale: 'нет такой единицы', fragmentIds: ['f-doc'] },
          { unitId: 'u1', reasonKind: 'internal_decision', rationale: 'только человек', fragmentIds: ['f-doc'] },
        ],
      }),
      input,
    );
    expect(r).toEqual({ ok: true, items: [{ unitId: 'u1', reasonKind: 'answer', rationale: 'Ответ заказчика', fragmentIds: ['f-qa'] }], dropped: 2 });
    expect(parseReasons(JSON.stringify({ reasons: [{ unitId: 'u1', reasonKind: 'answer', rationale: 'документ как ответ', fragmentIds: ['f-doc'] }] }), input)).toEqual({ ok: true, items: [], dropped: 1 });
    expect(parseReasons('не json', input)).toEqual({ ok: false });
  });
});
