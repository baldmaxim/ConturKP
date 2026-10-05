// Проверка и разногласия этапа 09 (D-029; portal-api §2.7 в редакции этапа 09).
export type TCheckOutcome = 'passed' | 'failed' | 'not_applicable' | 'incomplete' | 'error';
export type TRunStatus = 'queued' | 'running' | 'completed' | 'completed_with_gaps' | 'failed';
export type TSummaryKind = 'running' | 'failed' | 'outdated' | 'incomplete' | 'findings' | 'risk_accepted' | 'clean';
export type TSeverity = 'critical' | 'major' | 'minor';
export type TConfidence = 'low' | 'medium' | 'high';
export type TFindingStatus = 'open' | 'in_progress' | 'resolved' | 'accepted_risk' | 'rejected' | 'stale';
export type TAxis = 'customer_position' | 'calculation' | 'proposal' | 'documents';

export interface IRunBrief {
  id: string;
  stageId: string;
  status: TRunStatus;
  createdAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  rulesVersion: string;
  model: { provider: string; model: string | null; version: string | null } | null;
}

export interface ICheckView {
  code: string;
  title: string;
  method: 'rule' | 'model';
  outcome: TCheckOutcome | null;
  reason: string | null;
  counts: Record<string, number>;
}

export interface ISuggestionView {
  id: string;
  runId: string;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  restricted: boolean;
  title: string;
  rationale: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  findingId: string | null;
  evidence: { side: string; fragmentId: string | null; calculationRevisionId: string | null; externalPositionId: string | null }[];
  createdAt: string | null;
}

export interface IRunView extends IRunBrief {
  inputs: {
    evidenceScopeId: string;
    registryId: string | null;
    calculationRevisionId: string | null;
    priorityRevisionId: string | null;
    priority: { kind: string; title: string }[];
    stageInputVersion: number;
    scopeInputVersion: number;
    rulesVersion: string;
    rulesSha256: string;
    promptVersion: string | null;
    promptSha256: string | null;
    inputSha256: string | null;
  };
  checks: ICheckView[];
  findings: { byStatus: Partial<Record<TFindingStatus, number>>; unsettled: number };
  freshness: { outdated: boolean; reasons: string[]; events: { seq: number; type: string; at: string | null; mode: string | null; reason: string | null }[] };
  summary: { kind: TSummaryKind; text: string };
  suggestions: ISuggestionView[];
}

export interface IFindingBrief {
  id: string;
  stageId: string;
  kind: string;
  kindTitle: string;
  check: string | null;
  origin: 'rule' | 'model_suggestion' | 'human';
  restricted: boolean;
  title: string;
  detail: string | null;
  severity: TSeverity;
  confidence: TConfidence;
  status: TFindingStatus;
  owner: { id: string; name: string | null } | null;
  action: string | null;
  impact: string | null;
  suggestedSide: 'left' | 'right' | null;
  riskAcceptable: boolean;
  firstRunId: string | null;
  lastRunId: string | null;
  discrepancyId: string | null;
  basisInputVersion: number;
  basisOutdated: boolean;
  invalidated: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  etag: string;
}

export interface IFindingListItem extends IFindingBrief {
  positions: { positionId: string | null; itemId: string | null; text: string | null }[];
  requirements: string[];
}

export interface IFindingList {
  items: IFindingListItem[];
  canWrite: boolean;
  canAcceptRisk: boolean;
  canDecide: boolean;
}

export interface IEvidenceItem {
  side: 'left' | 'right' | 'context';
  type: string;
  fragment: { id: string; readable: boolean; text: string | null; origin: string | null; pageIndex: number | null; documentTitle: string | null } | null;
  calculation: { revisionId: string; positionId: string | null; itemId: string | null; text: string | null; unit: string | null; quantity: string | null } | null;
  requirement: { revisionId: string; requirementId: string | null; code: string | null } | null;
  fact: { id: string; type: string | null; rawValue: string | null } | null;
  question: { id: string; text: string | null } | null;
  qaItemRevision: { id: string; question: string | null } | null;
  documentRevision: { id: string; readable: boolean; title: string | null; revisionSeq: number | null } | null;
  note: string | null;
}

export interface IDecisionItem {
  id: string;
  type: string;
  statement: string | null;
  rationale: string | null;
  decidedBy: string;
  createdAt: string | null;
  invalidatedReason: string | null;
}

export interface IAxisState {
  value: string;
  eventId: string | null;
  actor: string | null;
  at: string | null;
  invalidatedReason: string | null;
}

export interface IDiscrepancyView {
  id: string;
  findingId: string;
  restricted: boolean;
  topic: string;
  createdBy: string;
  createdAt: string | null;
  axes: Record<TAxis, IAxisState>;
  history: { id: string; seq: number; axis: TAxis; value: string; reason: string | null; actor: string; createdAt: string | null; invalidatedReason: string | null; bases: { type: string; id: string | null }[] }[];
  decisions: IDecisionItem[];
}

export interface IFindingDetail extends IFindingBrief {
  evidence: IEvidenceItem[];
  graphFacts: { left: string[]; right: string[] } | null;
  events: { seq: number; kind: string; from: string | null; to: string | null; reason: string | null; actor: string | null; decisionId: string | null; createdAt: string | null }[];
  occurrences: { runId: string; createdAt: string | null; status: string }[];
  invalidations: { reason: string; mode: string; eventType: string; eventSeq: number; createdAt: string | null }[];
  decisions: IDecisionItem[];
  discrepancy: IDiscrepancyView | null;
  canWrite: boolean;
  canAcceptRisk: boolean;
  canDecide: boolean;
}

export interface ISourcePriorityView {
  tenderId: string;
  isDefault: boolean;
  kinds: { kind: string; title: string }[];
  revisions: { id: string; seq: number; kinds: string[]; reason: string; createdBy: string; createdAt: string }[];
  canManage: boolean;
  note: string;
}
