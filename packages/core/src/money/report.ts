// Экономический отчёт ревизии расчёта (проект §5.5, §5.9; D-030 В-10-1, п. 7, 11): составляющие по видам цены, сверка
// с cached_grand_total как последним наблюдаемым значением, неподтверждённый остаток (отдельно, не распределяется и
// ничем не объясняется), десятичный пересчёт строк с явными методом и допуском, отклонения от ограничений источника.
import type { ICommercialComponent } from './components.ts';
import { add, dec, decOrNull, round2HalfAway, ROUNDING_POLICY, str, strOrNull, sub, sum, ZERO, type Dec } from './decimal.ts';
import { checkLine, formulaOf, LINE_FLAGS, LINE_RECOMPUTE_METHOD, LINE_TOLERANCE, normalizedCurrency, type ILineCheck, type ILineInput, type IRates, type LineFlag } from './lineCost.ts';

export const ECONOMICS_METHOD_VERSION = 'econ/10-1' as const;
// Допуск сверки итога — параметр проверки, пишется в результат (D-016).
export const RECONCILIATION_TOLERANCE = '0.01';

export interface IReportPosition {
  externalPositionId: string;
  isSection: boolean;
  manualVolume: string | null;
  commercialTotal: string | null;
}

export interface IReportInput {
  grandTotal: string | null;
  rates: IRates;
  ratesObservedAt: string | null;
  positions: readonly IReportPosition[];
  lines: readonly ILineInput[];
  components: readonly ICommercialComponent[];
}

export type ReconciliationStatus = 'reconciled' | 'residual_unconfirmed' | 'no_target';

export interface IRevisionEconomics {
  methodVersion: typeof ECONOMICS_METHOD_VERSION;
  totals: { cost: string; materialCost: string; workCost: string; otherCost: string; commercial: string; commercialMaterialColumn: string; commercialWorkColumn: string };
  linesWithoutCommercial: { lines: number; cost: string };
  foreignCurrency: { currency: string; lines: number; cost: string }[];
  delivery: { kind: string; lines: number; cost: string }[];
  positionsUnitPriceUndefined: number;
  lineCheck: { method: string; tolerance: { name: string; relative: string; absolute: string }; lines: number; within: number; outside: number; notApplicable: number };
  deviations: Record<LineFlag, number>;
  rates: { USD: string | null; EUR: string | null; CNY: string | null; observedAt: string | null; note: string };
  reconciliation: {
    targetKind: 'cached_grand_total';
    target: string | null;
    confirmedPart: string;
    confirmedPartRounded: string;
    rounding: typeof ROUNDING_POLICY;
    residual: string | null;
    tolerance: string;
    status: ReconciliationStatus;
    note: string;
  };
  components: ICommercialComponent[];
}

const RESIDUAL_NOTE =
  'cached_grand_total — последнее наблюдаемое материализованное значение источника. Остаток неподтверждённый: без доступных составляющих и статуса пересчёта он не объясняется ни страхованием, ни округлением, ни задержкой пересчёта, по позициям не распределяется и итогом КП не считается (D-030).';

const commercialOf = (l: ILineInput): Dec | null =>
  l.totalCommercialMaterial === null && l.totalCommercialWork === null ? null : add(decOrNull(l.totalCommercialMaterial) ?? ZERO, decOrNull(l.totalCommercialWork) ?? ZERO);

export const buildRevisionEconomics = (input: IReportInput): { report: IRevisionEconomics; lineChecks: ILineCheck[] } => {
  const byId = new Map(input.lines.map((l) => [l.externalItemId, l]));
  const lineChecks = input.lines.map((l) => checkLine(l, input.rates, l.parentWorkExternalItemId ? byId.get(l.parentWorkExternalItemId) : undefined));
  const costOf = (l: ILineInput): Dec => decOrNull(l.totalAmount) ?? ZERO;
  const material = input.lines.filter((l) => formulaOf(l.itemType) === 'material');
  const work = input.lines.filter((l) => formulaOf(l.itemType) === 'work');
  const other = input.lines.filter((l) => formulaOf(l.itemType) === 'not_applicable');
  const withCommercial = input.lines.filter((l) => commercialOf(l) !== null);
  const withoutCommercial = input.lines.filter((l) => commercialOf(l) === null);
  const confirmed = sum(withCommercial.map((l) => commercialOf(l)!));
  const rounded = round2HalfAway(confirmed);
  const target = decOrNull(input.grandTotal);
  const residual = target === null ? null : sub(target, rounded);
  const status: ReconciliationStatus = target === null ? 'no_target' : residual!.abs().lte(dec(RECONCILIATION_TOLERANCE)) ? 'reconciled' : 'residual_unconfirmed';

  const byCurrency = new Map<string, ILineInput[]>();
  for (const l of input.lines) {
    const c = normalizedCurrency(l.currency);
    if (c !== 'RUB') byCurrency.set(c, [...(byCurrency.get(c) ?? []), l]);
  }
  const byDelivery = new Map<string, ILineInput[]>();
  for (const l of material) {
    const k = l.deliveryPriceType ?? 'не указано';
    byDelivery.set(k, [...(byDelivery.get(k) ?? []), l]);
  }
  const linesPerPosition = new Map<string, number>();
  for (const l of input.lines) linesPerPosition.set(l.externalPositionId, (linesPerPosition.get(l.externalPositionId) ?? 0) + 1);
  const positionsUnitPriceUndefined = input.positions.filter((p) => {
    if (p.isSection || (linesPerPosition.get(p.externalPositionId) ?? 0) === 0) return false;
    const v = decOrNull(p.manualVolume);
    return v === null || v.isZero();
  }).length;

  const deviations = Object.fromEntries(LINE_FLAGS.map((f) => [f, lineChecks.filter((c) => c.flags.includes(f)).length])) as Record<LineFlag, number>;
  const report: IRevisionEconomics = {
    methodVersion: 'econ/10-1',
    totals: {
      cost: str(sum(input.lines.map(costOf))),
      materialCost: str(sum(material.map(costOf))),
      workCost: str(sum(work.map(costOf))),
      otherCost: str(sum(other.map(costOf))),
      commercial: str(confirmed),
      commercialMaterialColumn: str(sum(input.lines.map((l) => decOrNull(l.totalCommercialMaterial) ?? ZERO))),
      commercialWorkColumn: str(sum(input.lines.map((l) => decOrNull(l.totalCommercialWork) ?? ZERO))),
    },
    linesWithoutCommercial: { lines: withoutCommercial.length, cost: str(sum(withoutCommercial.map(costOf))) },
    foreignCurrency: [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, ls]) => ({ currency, lines: ls.length, cost: str(sum(ls.map(costOf))) })),
    delivery: [...byDelivery.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, ls]) => ({ kind, lines: ls.length, cost: str(sum(ls.map(costOf))) })),
    positionsUnitPriceUndefined,
    lineCheck: {
      method: LINE_RECOMPUTE_METHOD,
      tolerance: { ...LINE_TOLERANCE },
      lines: lineChecks.length,
      within: lineChecks.filter((c) => c.withinTolerance === true).length,
      outside: lineChecks.filter((c) => c.withinTolerance === false).length,
      notApplicable: lineChecks.filter((c) => c.withinTolerance === null).length,
    },
    deviations,
    rates: { ...input.rates, observedAt: input.ratesObservedAt, note: 'курс ревизии: дата наблюдения при выгрузке, не дата установления курса (D-030 В-10-6)' },
    reconciliation: {
      targetKind: 'cached_grand_total',
      target: strOrNull(target),
      confirmedPart: str(confirmed),
      confirmedPartRounded: str(rounded),
      rounding: ROUNDING_POLICY,
      residual: strOrNull(residual),
      tolerance: RECONCILIATION_TOLERANCE,
      status,
      note: RESIDUAL_NOTE,
    },
    components: [...input.components],
  };
  return { report, lineChecks };
};
