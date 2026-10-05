// Сравнение двух ревизий расчёта (проект §5.1–5.4; D-030 В-10-3, В-10-4, п. 7, 11). Единица сравнения — компонента
// связности подтверждённых пар позиций; строки внутри единицы сопоставляются внешним id, затем ключом строки. Изменение
// пары строк раскладывается цепными подстановками в фиксированном порядке: количество → цена в валюте → курс →
// доставка → коэффициент; совместный эффект относится к более позднему фактору. Опора — полученные суммы: хвост
// между полученным и пересчитанным — отдельный вклад, исходные суммы не меняются. Σ вкладов единицы = её дельта;
// Σ по сравнению = дельта итога; остаток уровня тендера — отдельные строки, по единицам не распределяется.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../requirements.ts';
import { comparable, type IMoneyBasis } from './comparability.ts';
import { add, dec, decOrNull, mul, str, strOrNull, sub, sum, ZERO, type Dec } from './decimal.ts';
import { groupByKey, lineKey, type IPositionKeyInput } from './keys.ts';
import { lineFactors, quantityBase, unitCost, type ILineInput, type IRates } from './lineCost.ts';

export const COMPARISON_METHOD_VERSION = 'compare/10-1' as const;
export const DECOMPOSITION_METHOD = 'chain_substitution' as const;
export const FACTOR_ORDER = ['quantity', 'unit_rate', 'fx_rate', 'delivery', 'coefficient'] as const;
export const COLUMN_SHIFT_TOLERANCE = '0.01';
// Семантика полей источника, под которой суммы сравниваются при неизвестном НДС (D-030 В-10-2).
export const TENDERHUB_SEMANTICS_VERSION = 'tenderhub-semantics/D-030';

export const METHOD_DESCRIPTION = {
  decompositionMethod: DECOMPOSITION_METHOD,
  order: [...FACTOR_ORDER],
  jointEffectRule: 'совместный эффект относится к более позднему фактору порядка (метод цепных подстановок)',
  anchors: 'опора — полученные total_amount и коммерческие колонки; хвост между полученным и пересчитанным значением — отдельный вклад',
  rates: 'курсы — из содержимого своих ревизий (дата наблюдения при выгрузке)',
  coefficient: 'вклад «коэффициент строки (наценки, тактика, раскладка)»; изменением НДС не называется без подтверждённого основания',
  tenderLevel: 'остаток уровня тендера и несопоставимые единицы — отдельные строки, по единицам не распределяются',
} as const;

export type Measure = 'cost' | 'commercial';
export type EffectComponent =
  | 'volume'
  | 'unit_rate'
  | 'currency_change'
  | 'fx_rate'
  | 'delivery'
  | 'coefficient'
  | 'source_tail'
  | 'composition_added'
  | 'composition_removed'
  | 'composition_changed'
  | 'not_decomposable'
  | 'incomparable_units'
  | 'unexplained_remainder';

export const EFFECT_COMPONENTS: readonly EffectComponent[] = [
  'volume',
  'unit_rate',
  'currency_change',
  'fx_rate',
  'delivery',
  'coefficient',
  'source_tail',
  'composition_added',
  'composition_removed',
  'composition_changed',
  'not_decomposable',
  'incomparable_units',
  'unexplained_remainder',
];

export interface IComparePosition extends IPositionKeyInput {
  manualVolume: string | null;
}

export interface ICompareSide {
  revisionId: string;
  contentHash: string;
  grandTotal: string | null;
  rates: IRates;
  positions: readonly IComparePosition[];
  lines: readonly ILineInput[];
}

export interface IConfirmedPair {
  lineageId: string;
  from: string;
  to: string;
}

export interface IEffect {
  unitNo: number | null;
  measure: Measure;
  component: EffectComponent;
  amount: Dec;
  lineRefs: { left: string[]; right: string[] };
}

export interface IMeasureView {
  left: Dec | null;
  right: Dec | null;
  comparable: boolean;
  reason: string | null;
}

export interface IUnit {
  unitNo: number;
  kind: 'matched' | 'added' | 'removed' | 'split_merge';
  left: string[];
  right: string[];
  lineageIds: string[];
  title: string;
  unitCode: string | null;
  cost: IMeasureView;
  commercial: IMeasureView;
  columns: { materialDelta: Dec | null; workDelta: Dec | null; shift: boolean };
}

export interface IComparisonResult {
  methodVersion: typeof COMPARISON_METHOD_VERSION;
  units: IUnit[];
  effects: IEffect[];
  totals: Record<Measure, { targetKind: 'lines_sum' | 'cached_grand_total'; left: Dec; right: Dec; delta: Dec }>;
  resultSha256: string;
}

export class ComparisonInvariantError extends Error {}

const SOURCE_BASIS = (field: string): IMoneyBasis => ({ currency: 'RUB', vat: 'unknown', priceKind: field === 'total_amount' ? 'cost' : 'commercial', unitBase: null, field: `tenderhub.${field}`, semanticsVersion: TENDERHUB_SEMANTICS_VERSION });

const commercialOf = (l: ILineInput): Dec | null =>
  l.totalCommercialMaterial === null && l.totalCommercialWork === null ? null : add(decOrNull(l.totalCommercialMaterial) ?? ZERO, decOrNull(l.totalCommercialWork) ?? ZERO);

// ---------------------------------------------------------------- Единицы сравнения

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    while (p !== (this.parent.get(p) ?? p)) p = this.parent.get(p) ?? p;
    this.parent.set(x, p);
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

// Раздел без строк в сравнение не входит; раздел со строками — как позиция (строки не теряются).
const participates = (p: IComparePosition, lines: ReadonlyMap<string, ILineInput[]>): boolean => !p.isSection || (lines.get(p.externalPositionId)?.length ?? 0) > 0;

const byNumber = (a: IComparePosition, b: IComparePosition): number => {
  const c = dec(a.positionNumber).cmp(dec(b.positionNumber));
  return c !== 0 ? c : a.externalPositionId.localeCompare(b.externalPositionId);
};

interface ILinePlan {
  pairs: [ILineInput, ILineInput][];
  groups: { left: ILineInput[]; right: ILineInput[] }[];
  added: ILineInput[];
  removed: ILineInput[];
}

const planLines = (left: readonly ILineInput[], right: readonly ILineInput[], leftAll: ReadonlyMap<string, ILineInput>, rightAll: ReadonlyMap<string, ILineInput>): ILinePlan => {
  const plan: ILinePlan = { pairs: [], groups: [], added: [], removed: [] };
  const rightById = new Map(right.map((l) => [l.externalItemId, l]));
  const restLeft: ILineInput[] = [];
  const usedRight = new Set<string>();
  for (const l of left) {
    const r = rightById.get(l.externalItemId);
    if (r) {
      plan.pairs.push([l, r]);
      usedRight.add(r.externalItemId);
    } else restLeft.push(l);
  }
  const restRight = right.filter((r) => !usedRight.has(r.externalItemId));
  const lk = groupByKey(restLeft, (l) => lineKey(l, l.parentWorkExternalItemId ? leftAll.get(l.parentWorkExternalItemId) : undefined));
  const rk = groupByKey(restRight, (l) => lineKey(l, l.parentWorkExternalItemId ? rightAll.get(l.parentWorkExternalItemId) : undefined));
  for (const [k, ls] of lk) {
    const rs = rk.get(k);
    if (!rs) plan.removed.push(...ls);
    else if (ls.length === 1 && rs.length === 1) plan.pairs.push([ls[0]!, rs[0]!]);
    else plan.groups.push({ left: ls, right: rs });
  }
  for (const [k, rs] of rk) if (!lk.has(k)) plan.added.push(...rs);
  return plan;
};

// ---------------------------------------------------------------- Разложение пары строк

interface IPairEffects {
  cost: [EffectComponent, Dec][];
  commercial: [EffectComponent, Dec][] | null;
}

const decomposePair = (l0: ILineInput, l1: ILineInput, rates0: IRates, rates1: IRates): IPairEffects => {
  const c0 = dec(l0.totalAmount!);
  const c1 = dec(l1.totalAmount!);
  const m0 = commercialOf(l0);
  const m1 = commercialOf(l1);
  const x0 = lineFactors(l0, rates0);
  const x1 = lineFactors(l1, rates1);
  const commercialWhole = (): [EffectComponent, Dec][] | null => (m0 !== null && m1 !== null ? [['not_decomposable', sub(m1, m0)]] : null);
  // Формула разная или неприменима, нет курса ревизии — пара не раскладывается: вся дельта — «без разложения».
  if (x0.formula !== x1.formula || x0.formula === 'not_applicable' || x0.f === null || x1.f === null) {
    return { cost: [['not_decomposable', sub(c1, c0)]], commercial: commercialWhole() };
  }
  const f0 = x0.f;
  const f1 = x1.f;
  const qk0 = quantityBase(x0);
  const qk1 = quantityBase(x1);
  const model0 = mul(qk0, unitCost(x0.formula, x0.r, f0, x0.delivery, x0.deliveryAmount));
  const s1 = mul(qk1, unitCost(x0.formula, x0.r, f0, x0.delivery, x0.deliveryAmount));
  const cost: [EffectComponent, Dec][] = [['volume', sub(s1, model0)]];
  let s3: Dec;
  if (x0.currency !== x1.currency) {
    // Смена валюты строки: цена и курс несопоставимы по отдельности — один вклад.
    s3 = mul(qk1, unitCost(x0.formula, x1.r, f1, x0.delivery, x0.deliveryAmount));
    cost.push(['currency_change', sub(s3, s1)]);
  } else {
    const s2 = mul(qk1, unitCost(x0.formula, x1.r, f0, x0.delivery, x0.deliveryAmount));
    s3 = mul(qk1, unitCost(x0.formula, x1.r, f1, x0.delivery, x0.deliveryAmount));
    cost.push(['unit_rate', sub(s2, s1)], ['fx_rate', sub(s3, s2)]);
  }
  const s4 = mul(qk1, unitCost(x1.formula, x1.r, f1, x1.delivery, x1.deliveryAmount));
  cost.push(['delivery', sub(s4, s3)]);
  cost.push(['source_tail', sub(sub(c1, s4), sub(c0, model0))]);
  if (m0 === null || m1 === null) return { cost, commercial: null };
  const k0 = decOrNull(l0.commercialMarkup);
  const k1 = decOrNull(l1.commercialMarkup);
  if (k0 === null || k1 === null) return { cost, commercial: commercialWhole() };
  // Коммерческая мера M = C·k: вклады себестоимости по старому коэффициенту, затем вклад коэффициента и хвост.
  const commercial: [EffectComponent, Dec][] = cost.map(([c, a]) => [c, mul(a, k0)]);
  commercial.push(['coefficient', mul(c1, sub(k1, k0))]);
  commercial.push(['source_tail', sub(sub(m1, mul(c1, k1)), sub(m0, mul(c0, k0)))]);
  return { cost, commercial };
};

// ---------------------------------------------------------------- Сравнение

const totalOf = (xs: readonly (Dec | null)[]): Dec => sum(xs.filter((x): x is Dec => x !== null));

export const compareRevisions = (left: ICompareSide, right: ICompareSide, pairs: readonly IConfirmedPair[]): IComparisonResult => {
  const linesBy = (s: ICompareSide) => groupByKey(s.lines, (l) => l.externalPositionId);
  const leftLines = linesBy(left);
  const rightLines = linesBy(right);
  const leftAll = new Map(left.lines.map((l) => [l.externalItemId, l]));
  const rightAll = new Map(right.lines.map((l) => [l.externalItemId, l]));
  const leftPos = new Map(left.positions.filter((p) => participates(p, leftLines)).map((p) => [p.externalPositionId, p]));
  const rightPos = new Map(right.positions.filter((p) => participates(p, rightLines)).map((p) => [p.externalPositionId, p]));

  const uf = new UnionFind();
  const L = (id: string) => `L:${id}`;
  const R = (id: string) => `R:${id}`;
  const used = pairs.filter((p) => leftPos.has(p.from) && rightPos.has(p.to));
  for (const p of used) uf.union(L(p.from), R(p.to));
  const groups = new Map<string, { left: IComparePosition[]; right: IComparePosition[]; lineageIds: string[] }>();
  const groupOf = (key: string) => {
    const root = uf.find(key);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { left: [], right: [], lineageIds: [] }));
    return g;
  };
  for (const p of leftPos.values()) groupOf(L(p.externalPositionId)).left.push(p);
  for (const p of rightPos.values()) groupOf(R(p.externalPositionId)).right.push(p);
  for (const p of used) groupOf(L(p.from)).lineageIds.push(p.lineageId);

  const ordered = [...groups.values()]
    .map((g) => ({ ...g, left: [...g.left].sort(byNumber), right: [...g.right].sort(byNumber), lineageIds: [...g.lineageIds].sort() }))
    .sort((a, b) => {
      const ka = a.right[0] ?? a.left[0]!;
      const kb = b.right[0] ?? b.left[0]!;
      const side = Number(a.right.length === 0) - Number(b.right.length === 0);
      return side !== 0 ? side : byNumber(ka, kb);
    });

  const units: IUnit[] = [];
  const effects: IEffect[] = [];
  const costBasisCheck = comparable(SOURCE_BASIS('total_amount'), SOURCE_BASIS('total_amount'));
  const commercialBasisCheck = comparable(SOURCE_BASIS('commercial_columns'), SOURCE_BASIS('commercial_columns'));

  ordered.forEach((g, i) => {
    const unitNo = i + 1;
    const ll = g.left.flatMap((p) => leftLines.get(p.externalPositionId) ?? []);
    const rl = g.right.flatMap((p) => rightLines.get(p.externalPositionId) ?? []);
    const kind: IUnit['kind'] = g.left.length === 0 ? 'added' : g.right.length === 0 ? 'removed' : g.left.length === 1 && g.right.length === 1 ? 'matched' : 'split_merge';
    const head = g.right[0] ?? g.left[0]!;
    const costMissing = [...ll, ...rl].some((l) => l.totalAmount === null);
    const commercialMissing = [...ll, ...rl].some((l) => commercialOf(l) === null);
    const cost: IMeasureView = {
      left: totalOf(ll.map((l) => decOrNull(l.totalAmount))),
      right: totalOf(rl.map((l) => decOrNull(l.totalAmount))),
      comparable: !costMissing && costBasisCheck.comparable,
      reason: costMissing ? 'у строки нет total_amount' : costBasisCheck.comparable ? null : costBasisCheck.reason,
    };
    const commercial: IMeasureView = {
      left: totalOf(ll.map(commercialOf)),
      right: totalOf(rl.map(commercialOf)),
      comparable: !commercialMissing && commercialBasisCheck.comparable,
      reason: commercialMissing ? 'у строки пустая коммерческая стоимость (не 0)' : commercialBasisCheck.comparable ? null : commercialBasisCheck.reason,
    };
    const colSum = (ls: readonly ILineInput[], pick: (l: ILineInput) => string | null) => totalOf(ls.map((l) => decOrNull(pick(l))));
    const materialDelta = commercial.comparable ? sub(colSum(rl, (l) => l.totalCommercialMaterial), colSum(ll, (l) => l.totalCommercialMaterial)) : null;
    const workDelta = commercial.comparable ? sub(colSum(rl, (l) => l.totalCommercialWork), colSum(ll, (l) => l.totalCommercialWork)) : null;
    const tol = dec(COLUMN_SHIFT_TOLERANCE);
    const shift = materialDelta !== null && workDelta !== null && add(materialDelta, workDelta).abs().lte(tol) && materialDelta.abs().gt(tol);
    units.push({
      unitNo,
      kind,
      left: g.left.map((p) => p.externalPositionId),
      right: g.right.map((p) => p.externalPositionId),
      lineageIds: g.lineageIds,
      title: head.workName,
      unitCode: head.unitCode,
      cost,
      commercial,
      columns: { materialDelta, workDelta, shift },
    });

    const local: Record<Measure, Map<string, { amount: Dec; left: string[]; right: string[] }>> = { cost: new Map(), commercial: new Map() };
    const push = (measure: Measure, component: EffectComponent, amount: Dec, refs: { left: string[]; right: string[] }) => {
      const cur = local[measure].get(component);
      if (cur) {
        cur.amount = add(cur.amount, amount);
        cur.left.push(...refs.left);
        cur.right.push(...refs.right);
      } else local[measure].set(component, { amount, left: [...refs.left], right: [...refs.right] });
    };
    const plan = planLines(ll, rl, leftAll, rightAll);
    for (const [a, b] of plan.pairs) {
      const refs = { left: [a.externalItemId], right: [b.externalItemId] };
      if (cost.comparable || commercial.comparable) {
        const e = cost.comparable ? decomposePair(a, b, left.rates, right.rates) : null;
        if (e) for (const [c, amt] of e.cost) push('cost', c, amt, refs);
        if (commercial.comparable) {
          const ce = e ?? (a.totalAmount !== null && b.totalAmount !== null ? decomposePair(a, b, left.rates, right.rates) : null);
          const parts = ce?.commercial ?? [['not_decomposable', sub(commercialOf(b)!, commercialOf(a)!)] as [EffectComponent, Dec]];
          for (const [c, amt] of parts) push('commercial', c, amt, refs);
        }
      }
    }
    for (const gr of plan.groups) {
      const refs = { left: gr.left.map((l) => l.externalItemId), right: gr.right.map((l) => l.externalItemId) };
      if (cost.comparable) push('cost', 'composition_changed', sub(totalOf(gr.right.map((l) => decOrNull(l.totalAmount))), totalOf(gr.left.map((l) => decOrNull(l.totalAmount)))), refs);
      if (commercial.comparable) push('commercial', 'composition_changed', sub(totalOf(gr.right.map(commercialOf)), totalOf(gr.left.map(commercialOf))), refs);
    }
    for (const l of plan.added) {
      const refs = { left: [], right: [l.externalItemId] };
      if (cost.comparable) push('cost', 'composition_added', dec(l.totalAmount!), refs);
      if (commercial.comparable) push('commercial', 'composition_added', commercialOf(l)!, refs);
    }
    for (const l of plan.removed) {
      const refs = { left: [l.externalItemId], right: [] };
      if (cost.comparable) push('cost', 'composition_removed', dec(l.totalAmount!).neg(), refs);
      if (commercial.comparable) push('commercial', 'composition_removed', commercialOf(l)!.neg(), refs);
    }
    for (const measure of ['cost', 'commercial'] as const) {
      const view = measure === 'cost' ? cost : commercial;
      if (!view.comparable) continue;
      const parts = [...local[measure].entries()];
      const total = sum(parts.map(([, v]) => v.amount));
      if (!total.eq(sub(view.right!, view.left!))) throw new ComparisonInvariantError(`единица ${unitNo}: Σ вкладов ${measure} не равна дельте`);
      for (const c of EFFECT_COMPONENTS) {
        const v = local[measure].get(c);
        // Нулевой вклад не записывается: Σ от этого не меняется, а отчёт не засоряется.
        if (v && !v.amount.isZero()) effects.push({ unitNo, measure, component: c, amount: v.amount, lineRefs: { left: [...new Set(v.left)].sort(), right: [...new Set(v.right)].sort() } });
      }
    }
  });

  // Уровень тендера: дельта итога = Σ дельт сопоставимых единиц + несопоставимые единицы + остаток.
  const allCost = (s: ICompareSide) => totalOf(s.lines.map((l) => decOrNull(l.totalAmount)));
  const allCommercial = (s: ICompareSide) => totalOf(s.lines.map(commercialOf));
  const grand = left.grandTotal !== null && right.grandTotal !== null;
  const totals: IComparisonResult['totals'] = {
    cost: { targetKind: 'lines_sum', left: allCost(left), right: allCost(right), delta: sub(allCost(right), allCost(left)) },
    commercial: grand
      ? { targetKind: 'cached_grand_total', left: dec(left.grandTotal!), right: dec(right.grandTotal!), delta: sub(dec(right.grandTotal!), dec(left.grandTotal!)) }
      : { targetKind: 'lines_sum', left: allCommercial(left), right: allCommercial(right), delta: sub(allCommercial(right), allCommercial(left)) },
  };
  for (const measure of ['cost', 'commercial'] as const) {
    const view = (u: IUnit) => (measure === 'cost' ? u.cost : u.commercial);
    const comparableSum = sum(units.filter((u) => view(u).comparable).map((u) => sub(view(u).right!, view(u).left!)));
    const incomparable = sum(units.filter((u) => !view(u).comparable).map((u) => sub(view(u).right ?? ZERO, view(u).left ?? ZERO)));
    effects.push({ unitNo: null, measure, component: 'incomparable_units', amount: incomparable, lineRefs: { left: [], right: [] } });
    effects.push({ unitNo: null, measure, component: 'unexplained_remainder', amount: sub(sub(totals[measure].delta, comparableSum), incomparable), lineRefs: { left: [], right: [] } });
  }
  const resultSha256 = createHash('sha256')
    .update(
      canonicalJson({
        method: COMPARISON_METHOD_VERSION,
        description: METHOD_DESCRIPTION,
        left: left.contentHash,
        right: right.contentHash,
        pairs: used.map((p) => [p.from, p.to]).sort((a, b) => (a.join() < b.join() ? -1 : 1)),
        units: units.map((u) => ({
          ...u,
          lineageIds: undefined,
          cost: { ...u.cost, left: strOrNull(u.cost.left), right: strOrNull(u.cost.right) },
          commercial: { ...u.commercial, left: strOrNull(u.commercial.left), right: strOrNull(u.commercial.right) },
          columns: { materialDelta: strOrNull(u.columns.materialDelta), workDelta: strOrNull(u.columns.workDelta), shift: u.columns.shift },
        })),
        effects: effects.map((e) => ({ ...e, amount: str(e.amount) })),
        totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { targetKind: v.targetKind, left: str(v.left), right: str(v.right), delta: str(v.delta) }])),
      }),
    )
    .digest('hex');
  return { methodVersion: COMPARISON_METHOD_VERSION, units, effects, totals, resultSha256 };
};
