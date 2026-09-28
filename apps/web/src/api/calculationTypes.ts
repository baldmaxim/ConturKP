// Расчёт TenderHub (этап 06, portal-api §2.5). Суммы — десятичные строки (ADR-005 §4), в number не
// переводятся: форматирование работает со строкой.

export type TCurrency = 'RUB' | 'USD' | 'EUR' | 'CNY' | 'UNKNOWN';

export interface IMoney {
  amount: string;
  currency: TCurrency;
  vat: 'unknown';
  priceKind: 'cost' | 'commercial';
  unit: string | null;
  asOf: null;
  source: { type: string; revisionId: string; externalId: string | null; field: string };
}

export interface ICalculationSource {
  id: string;
  stageId: string;
  system: 'tenderhub';
  externalTenderId: string;
  externalVersion: number | null;
  role: 'primary' | 'reference';
  createdAt: string;
  updatedAt: string;
}

export interface IIntegrationState {
  component: string;
  status: 'NOT_IMPLEMENTED' | 'VERIFIED_FIXTURE' | 'VERIFIED_LIVE' | 'BLOCKED_EXTERNAL';
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  blockedBy: string | null;
}

export interface ICalculationSources {
  version: number;
  primary: ICalculationSource | null;
  references: ICalculationSource[];
  integration: IIntegrationState[];
}

export type TCaptureStatus = 'capturing' | 'complete' | 'inconsistent' | 'failed';

export interface ICaptureAttempt {
  no: number;
  outcome: 'consistent' | 'inconsistent' | 'failed';
  code?: string;
  message?: string;
  reasons?: { code: string; detail: string }[];
  startedAt: string;
  finishedAt: string;
}

export interface ISourceObserved {
  tenderNumber: string;
  title: string | null;
  version: number | null;
  submissionDeadline: string | null;
  briefFound: boolean;
}

export interface ICalculationCapture {
  id: string;
  stageId: string;
  externalTenderId: string;
  trigger: 'manual' | 'deadline';
  deadlineBasis: string | null;
  status: TCaptureStatus;
  attempts: ICaptureAttempt[];
  sourceObserved: ISourceObserved | null;
  revisionId: string | null;
  failure: { code: string; detail: string | null } | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface IAggregateCheck {
  check: string;
  positions: number;
  ok: number;
  rounding: number;
  mismatch: number;
  examples: { positionId: string; source: string | null; computed: string; diff: string }[];
}

export interface IAggregates {
  tolerance: string;
  checks: IAggregateCheck[];
  grandTotal: { source: string | null; positionsCommercialSum: string; diff: string | null; status: 'ok' | 'rounding' | 'mismatch' | 'unavailable'; note: string };
}

export interface ICalculationRevision {
  id: string;
  stageId: string;
  seq: number;
  kind: 'provisional' | 'verified';
  externalTenderId: string;
  externalVersion: number | null;
  externalRevisionRef: string | null;
  supersedesRevisionId: string | null;
  captureId: string;
  createdAt: string;
  contentHash: string;
  counts: { positions: number; lines: number };
  source: {
    tenderNumber: string | null;
    title: string | null;
    submissionDeadline: string | null;
    grandTotal: IMoney | null;
    fxRates: { USD: string | null; EUR: string | null; CNY: string | null };
  };
  kpTotal: { value: IMoney | null; rule: string | null; semantics: { status?: string; question?: string; note?: string } };
  productionGate: { mode: 'production'; allowed: boolean; blockers: string[] };
  sourceStatus: { status: string; observedAt: string; seq: number }[];
  closureAvailable: boolean;
  aggregates: IAggregates | null;
}

export interface ICalculationPosition {
  externalPositionId: string;
  positionNumber: string;
  itemNo: string | null;
  workName: string;
  unitCode: string | null;
  volume: string | null;
  manualVolume: { value: string | null; note: string | null; semantics: 'unconfirmed' } | null;
  clientNote: string | null;
  isSection: boolean;
  isAdditional: boolean | null;
  hierarchyLevel: number | null;
  dominantCostCategory: string | null;
  itemsCount: number | null;
  lines: number;
  totals: { baseTotal: IMoney | null; commercialTotal: IMoney | null };
  markupPercentage: string | null;
}

export interface ICalculationLine {
  externalItemId: string;
  externalPositionId: string;
  sortNumber: number | null;
  itemType: string;
  materialType: string | null;
  description: string | null;
  workName: string | null;
  materialName: string | null;
  unitCode: string | null;
  quantity: string | null;
  unitRate: IMoney | null;
  currency: TCurrency | null;
  totalAmount: IMoney | null;
  totalCommercialMaterial: IMoney | null;
  totalCommercialWork: IMoney | null;
  costCategory: string | null;
  parentWorkExternalItemId: string | null;
}

export interface IPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}
