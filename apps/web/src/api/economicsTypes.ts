// Типы экономики этапа 10 (portal-api §2.5, §2.10 в редакции этапа 10; D-030).

export interface IEconomicsMoney {
  amount: string;
  currency: 'RUB';
  vat: 'unknown';
  priceKind: 'cost' | 'commercial';
  unit: string | null;
  asOf: string | null;
  source: { type: string; revisionId: string | null; field: string; derivation: 'source_field' | 'derived_from_formula' | 'portal_sum' };
}

export interface ICommercialComponent {
  code: string;
  status: 'available' | 'unavailable_by_key' | 'not_in_source_model';
  reason: string;
  source: { route: string | null; contractVersion: string };
}

export interface IRevisionEconomics {
  revisionId: string;
  revisionSeq: number;
  methodVersion: string;
  computedAt: string;
  totals: Record<'cost' | 'materialCost' | 'workCost' | 'otherCost' | 'commercial' | 'commercialMaterialColumn' | 'commercialWorkColumn', IEconomicsMoney | null>;
  linesWithoutCommercial: { lines: number; cost: IEconomicsMoney | null };
  foreignCurrency: { currency: string; lines: number; cost: IEconomicsMoney | null }[];
  delivery: { kind: string; lines: number; cost: IEconomicsMoney | null }[];
  positionsUnitPriceUndefined: number;
  lineCheck: { method: string; tolerance: { name: string; relative: string; absolute: string }; lines: number; within: number; outside: number; notApplicable: number };
  deviations: Record<string, number>;
  rates: { USD: string | null; EUR: string | null; CNY: string | null; observedAt: string | null; note: string };
  reconciliation: {
    targetKind: string;
    target: IEconomicsMoney | null;
    confirmedPart: IEconomicsMoney | null;
    confirmedPartRounded: IEconomicsMoney | null;
    residual: IEconomicsMoney | null;
    tolerance: string;
    status: 'reconciled' | 'residual_unconfirmed' | 'no_target';
    note: string;
    isKpTotal: false;
  };
  components: ICommercialComponent[];
}

export interface IDeviationLine {
  externalItemId: string;
  externalPositionId: string;
  itemType: string;
  description: string | null;
  quantity: string | null;
  totalAmount: string | null;
  formula: string;
  recomputedCost: string | null;
  deviation: string | null;
  withinTolerance: boolean | null;
  derivedQuantity: string | null;
  flags: string[];
}

export interface IComparisonTotals {
  targetKind: string;
  left: string;
  right: string;
  delta: string;
}

export interface IComparisonBrief {
  id: string;
  stageId: string;
  leftRevisionId: string;
  rightRevisionId: string;
  status: 'computing' | 'ready' | 'failed';
  failureReason: string | null;
  methodVersion: string;
  createdAt: string;
  totals: Record<'cost' | 'commercial', IComparisonTotals> | null;
  proposals?: { systemConfirmed: number; proposed: number; ambiguous: number };
}

export interface IEffectSummary {
  measure: 'cost' | 'commercial';
  component: string;
  level: 'unit' | 'tender';
  amount: string;
  units: number;
}

export interface IComparison extends IComparisonBrief {
  decompositionMethod: string;
  method: { order: string[]; jointEffectRule: string; anchors: string; rates: string; coefficient: string; tenderLevel: string };
  tolerance: string;
  lineageSeq: number;
  resultSha256: string | null;
  revisions: { left: { seq: number; observedAt: string | null }; right: { seq: number; observedAt: string | null } };
  summary: { effects: IEffectSummary[]; units: Record<string, number>; incomparable: { cost: number; commercial: number } };
  outdated: { value: boolean; lineageChanged: boolean; invalidatedExplanations: number };
}

export interface IExplanation {
  id: string;
  version: number;
  reasonKind: 'document' | 'answer' | 'supplier' | 'internal_decision' | 'unknown';
  reasonStatus: 'unknown' | 'hypothesis' | 'confirmed';
  rationale: string | null;
  restricted: boolean;
  suggestionId: string | null;
  actor: { id: string; name: string };
  createdAt: string;
  bases: { basisType: string; fragmentId: string | null; decisionId: string | null; origin: string | null; text: string | null }[];
  basisChanged: boolean;
}

export interface IReasonSuggestion {
  id: string;
  runId: string;
  unitId: string;
  reasonKind: 'document' | 'answer' | 'supplier';
  rationale: string | null;
  restricted: boolean;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  rowVersion: number;
  evidence: { fragmentId: string; origin: string; text: string | null }[];
}

export interface IMeasureView {
  left: string | null;
  right: string | null;
  delta: string | null;
  comparable: boolean;
  reason: string | null;
}

// Почему пара строк не разложена (R10-02): смена единицы, формула, курс, коэффициент.
export interface IDecompositionNote {
  left: string;
  right: string;
  reason: string;
  fromUnit?: string | null;
  toUnit?: string | null;
}

export interface IUnitEffect {
  measure: 'cost' | 'commercial';
  component: string;
  amount: string;
  lineRefs?: { left: string[]; right: string[]; notes?: IDecompositionNote[] };
}

export interface IComparisonUnit {
  id: string;
  unitNo: number;
  kind: 'matched' | 'added' | 'removed' | 'split_merge';
  leftPositions: string[];
  rightPositions: string[];
  title: string;
  unitCode: string | null;
  cost: IMeasureView;
  commercial: IMeasureView;
  columns: { materialDelta: string | null; workDelta: string | null; shift: boolean };
  effects: IUnitEffect[];
  explanation: IExplanation | null;
  explanationVersion: number;
  suggestions: IReasonSuggestion[];
}

export interface IUnitsPage {
  items: IComparisonUnit[];
  hasMore: boolean;
  nextAfter: number | null;
}

export interface IPositionBrief {
  externalPositionId: string;
  positionNumber: string;
  itemNo: string | null;
  workName: string;
  unitCode: string | null;
  isSection: boolean;
}

export interface ILineageRow {
  id: string;
  fromPositionId: string;
  toPositionId: string;
  method: 'source_lineage' | 'exact_key' | 'position_key' | 'manual';
  status: 'proposed' | 'confirmed' | 'rejected';
  decidedBy: string | null;
  decidedBySystem: boolean;
}

export interface ILineageView {
  version: number;
  comparisonLineageSeq: number;
  left: IPositionBrief[];
  right: IPositionBrief[];
  items: ILineageRow[];
  ambiguous: { reason: 'duplicate_key' | 'keys_disagree'; left: string[]; right: string[] }[];
}

export interface IReasonRun {
  id: string;
  comparisonId: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_gaps' | 'failed';
  model: { provider: string; model: string; version: string } | null;
  coverage: Record<string, unknown>;
  createdAt: string;
  finishedAt: string | null;
}
