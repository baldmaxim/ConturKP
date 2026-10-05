// Представление экономики для API (этап 10; ADR-005 §4; D-030). Суммы — объект денег: себестоимость TenderHub — RUB
// (таблица семантики п. 7, 12, 13), коммерческие суммы — RUB как вывод из принятой формулы (D-030 «Дополнение»), НДС —
// неизвестен (Т-10-1), дата — дата наблюдения при выгрузке, не дата установления курса. Производный текст (обоснование
// причины, цитаты, гипотезы модели) показывается целиком, только если пользователь читает все его основания (R08-02).
import type {
  IComparisonRow,
  IComparisonUnitRow,
  IEconomicsRevision,
  IEffectSummaryRow,
  IExplanationRow,
  ILineageCurrentRow,
  ILineCheckRow,
  IPositionBrief,
  IReasonRunRow,
  IReasonSuggestionRow,
  IRevisionEconomicsRow,
} from '@kontur/db';

type PriceKind = 'cost' | 'commercial';

export interface IEconomicsMoney {
  amount: string;
  currency: 'RUB';
  vat: 'unknown';
  priceKind: PriceKind;
  unit: string | null;
  asOf: string | null;
  source: { type: string; revisionId: string | null; field: string; derivation: 'source_field' | 'derived_from_formula' | 'portal_sum' };
}

const money = (amount: string | null, priceKind: PriceKind, source: IEconomicsMoney['source'], asOf: string | null): IEconomicsMoney | null =>
  amount === null ? null : { amount, currency: 'RUB', vat: 'unknown', priceKind, unit: null, asOf, source };

export const toRevisionEconomics = (rev: IEconomicsRevision, row: IRevisionEconomicsRow) => {
  const r = row.report;
  const asOf = r.rates.observedAt;
  const src = (field: string, derivation: IEconomicsMoney['source']['derivation'] = 'portal_sum'): IEconomicsMoney['source'] => ({ type: 'revision_economics', revisionId: rev.id, field, derivation });
  return {
    revisionId: rev.id,
    revisionSeq: rev.seq,
    methodVersion: r.methodVersion,
    computedAt: row.created_at.toISOString(),
    totals: {
      cost: money(r.totals.cost, 'cost', src('Σ total_amount'), asOf),
      materialCost: money(r.totals.materialCost, 'cost', src('Σ total_amount: мат, суб-мат, мат-комп.'), asOf),
      workCost: money(r.totals.workCost, 'cost', src('Σ total_amount: раб, суб-раб, раб-комп.'), asOf),
      otherCost: money(r.totals.otherCost, 'cost', src('Σ total_amount: тип вне перечня'), asOf),
      commercial: money(r.totals.commercial, 'commercial', src('Σ коммерческих колонок строк', 'derived_from_formula'), asOf),
      commercialMaterialColumn: money(r.totals.commercialMaterialColumn, 'commercial', src('Σ колонки КП «Материалы»', 'derived_from_formula'), asOf),
      commercialWorkColumn: money(r.totals.commercialWorkColumn, 'commercial', src('Σ колонки КП «Работы»', 'derived_from_formula'), asOf),
    },
    linesWithoutCommercial: { lines: r.linesWithoutCommercial.lines, cost: money(r.linesWithoutCommercial.cost, 'cost', src('Σ total_amount строк без коммерческой стоимости'), asOf) },
    foreignCurrency: r.foreignCurrency.map((x) => ({ currency: x.currency, lines: x.lines, cost: money(x.cost, 'cost', src(`Σ total_amount строк в ${x.currency}`), asOf) })),
    delivery: r.delivery.map((x) => ({ kind: x.kind, lines: x.lines, cost: money(x.cost, 'cost', src(`Σ total_amount материалов: доставка «${x.kind}»`), asOf) })),
    positionsUnitPriceUndefined: r.positionsUnitPriceUndefined,
    lineCheck: r.lineCheck,
    deviations: r.deviations,
    rates: r.rates,
    reconciliation: {
      ...r.reconciliation,
      target: money(r.reconciliation.target, 'commercial', { type: 'calculation_revision', revisionId: rev.id, field: 'cached_grand_total', derivation: 'source_field' }, asOf),
      confirmedPart: money(r.reconciliation.confirmedPart, 'commercial', src('Σ коммерческих колонок строк', 'derived_from_formula'), asOf),
      confirmedPartRounded: money(r.reconciliation.confirmedPartRounded, 'commercial', src('ROUND(Σ, 2) — money2_half_away', 'derived_from_formula'), asOf),
      residual: money(r.reconciliation.residual, 'commercial', src('cached_grand_total − ROUND(Σ, 2)'), asOf),
      // Остаток — не итог КП и ничем не объясняется (D-030 В-10-1, п. 11).
      isKpTotal: false,
    },
    components: r.components,
  };
};

export const toDeviationLine = (l: ILineCheckRow) => ({
  externalItemId: l.external_item_id,
  externalPositionId: l.external_position_id,
  itemType: l.item_type,
  description: l.description,
  quantity: l.quantity,
  totalAmount: l.total_amount,
  formula: l.formula,
  recomputedCost: l.recomputed_cost,
  deviation: l.deviation,
  withinTolerance: l.within_tolerance,
  derivedQuantity: l.derived_quantity,
  flags: l.flags,
});

export const toComparisonBrief = (c: IComparisonRow) => ({
  id: c.id,
  stageId: c.stage_id,
  leftRevisionId: c.left_revision_id,
  rightRevisionId: c.right_revision_id,
  status: c.status,
  failureReason: c.failure_reason,
  methodVersion: c.method_version,
  createdAt: c.created_at.toISOString(),
  totals: c.totals,
});

export const toComparison = (
  c: IComparisonRow,
  o: {
    summary: { effects: IEffectSummaryRow[]; units: Record<string, number>; incomparable: { cost: number; commercial: number } };
    lineageSeqNow: number;
    invalidatedExplanations: number;
    left: { seq: number; observedAt: string | null };
    right: { seq: number; observedAt: string | null };
  },
) => ({
  ...toComparisonBrief(c),
  decompositionMethod: c.decomposition_method,
  method: c.method_description,
  tolerance: c.tolerance,
  lineageSeq: c.lineage_seq,
  resultSha256: c.result_sha256,
  revisions: { left: o.left, right: o.right },
  summary: o.summary,
  // Сравнение не меняется: «устарело» — вычисляемый признак (новые решения о парах или изменившиеся основания причин).
  outdated: {
    value: o.lineageSeqNow > c.lineage_seq || o.invalidatedExplanations > 0,
    lineageChanged: o.lineageSeqNow > c.lineage_seq,
    invalidatedExplanations: o.invalidatedExplanations,
  },
});

export const toExplanation = (e: IExplanationRow, visible: boolean) => ({
  id: e.id,
  version: e.version,
  reasonKind: e.reason_kind,
  reasonStatus: e.reason_status,
  rationale: visible ? e.rationale : null,
  restricted: !visible,
  suggestionId: e.suggestion_id,
  actor: { id: e.actor_user_id, name: e.actor_name },
  createdAt: e.created_at.toISOString(),
  bases: e.bases.map((b) => ({ basisType: b.basisType, fragmentId: b.fragmentId, decisionId: b.decisionId, origin: b.origin, text: visible ? b.text : null })),
  basisChanged: e.invalidated.length > 0,
  invalidations: e.invalidated,
});

export const toSuggestion = (s: IReasonSuggestionRow, visible: boolean) => ({
  id: s.id,
  runId: s.run_id,
  unitId: s.unit_id,
  reasonKind: s.reason_kind,
  rationale: visible ? s.rationale : null,
  restricted: !visible,
  status: s.status,
  decidedBy: s.decided_by,
  decidedAt: s.decided_at?.toISOString() ?? null,
  decisionReason: s.decision_reason,
  explanationId: s.explanation_id,
  rowVersion: s.row_version,
  evidence: s.evidence.map((f) => ({ fragmentId: f.fragmentId, origin: f.origin, text: visible ? f.text : null })),
});

export const toUnit = (u: IComparisonUnitRow, explanation: ReturnType<typeof toExplanation> | null, suggestions: ReturnType<typeof toSuggestion>[], version: number) => ({
  id: u.id,
  unitNo: u.unit_no,
  kind: u.kind,
  leftPositions: u.left_positions,
  rightPositions: u.right_positions,
  lineageIds: u.lineage_ids,
  title: u.title,
  unitCode: u.unit_code,
  // Дельта — только у сопоставимой меры; у несопоставимой — суммы известных строк без разницы.
  cost: { left: u.cost_left, right: u.cost_right, delta: u.cost_comparable ? u.cost_delta : null, comparable: u.cost_comparable, reason: u.cost_reason },
  commercial: { left: u.commercial_left, right: u.commercial_right, delta: u.commercial_comparable ? u.commercial_delta : null, comparable: u.commercial_comparable, reason: u.commercial_reason },
  columns: { materialDelta: u.material_column_delta, workDelta: u.work_column_delta, shift: u.column_shift },
  effects: u.effects.map((e) => ({ measure: e.measure, component: e.component, amount: e.amount, lineRefs: e.line_refs })),
  explanation,
  explanationVersion: version,
  suggestions,
});

export const toLineageRow = (l: ILineageCurrentRow) => ({
  id: l.id,
  fromPositionId: l.from_position,
  toPositionId: l.to_position,
  method: l.method,
  status: l.status,
  decidedBy: l.decided_by,
  decidedBySystem: l.decided_by_kind === 'service',
  seq: l.seq,
  createdAt: l.created_at.toISOString(),
});

export const toPositionBrief = (p: IPositionBrief) => ({
  externalPositionId: p.external_position_id,
  positionNumber: p.position_number,
  itemNo: p.item_no,
  workName: p.work_name,
  unitCode: p.unit_code,
  isSection: p.is_section,
});

export const toReasonRun = (r: IReasonRunRow) => ({
  id: r.id,
  comparisonId: r.comparison_id,
  status: r.status,
  model: r.model_provider ? { provider: r.model_provider, model: r.model_id, version: r.model_version, promptVersion: r.prompt_version } : null,
  coverage: r.coverage,
  failureCode: r.failure_code,
  createdAt: r.created_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
});
