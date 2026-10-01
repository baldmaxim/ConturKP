// Типы ответов этапа 08 (D-026): реестр, прогоны анализа, кандидаты, требования и факты, покрытие, решения,
// допущения, вопросы заказчику, пометки и полнота. Поля текста — null, если пользователь не читает все
// основания объекта любой роли с наследованием (Р-08-5, R08-02): тогда показывается безопасная оболочка.
// Конфликт требований и несовпадение единиц покрытия — R08-01.

export type TEvidenceRole = 'supports' | 'contradicts' | 'clarifies' | 'supersedes_context';
export type TCandidateStatus = 'proposed' | 'confirmed' | 'rejected' | 'superseded';
export type TCandidateOrigin = 'human' | 'model' | 'rule' | 'carried';
export type TCoverageState = 'uncovered' | 'partial' | 'covered' | 'not_applicable' | 'needs_review';
export type TAnalysisTask = 'requirement_extraction' | 'fact_extraction';
export type TAnalysisStatus = 'queued' | 'running' | 'completed' | 'completed_with_gaps' | 'failed';
export type TFragmentState = 'covered' | 'reviewed' | 'explicitly_not_requirement' | 'unreviewed';

export interface IEvidenceLink {
  fragmentId: string;
  role: TEvidenceRole;
  sourceKind: string;
  restricted: boolean;
  origin: string | null;
  pageIndex: number | null;
  text: string | null;
}

export interface IParameter {
  name: string;
  value: string;
  unit: string | null;
}

export interface IObjectScope {
  object?: string;
  section?: string;
  floor?: string;
  room?: string;
}

// Конфликт с действующим требованием реестра: имя параметра — null, если одно из требований скрыто.
export interface IConflict {
  requirementId: string;
  code: string;
  parameter: string | null;
}

export interface IRegistry {
  id: string;
  stageId: string;
  tenderId: string;
  seq: number;
  evidenceScopeId: string;
  scopeHash: string;
  scopeCreatedAt: string;
  previousRegistryId: string | null;
  reason: string;
  active: boolean;
  createdAt: string;
}

export interface ICompletenessCounts {
  total_units: number;
  reviewed_units: number;
  covered_units: number;
  explicit_not_requirement_units: number;
  unreviewed_units: number;
  empty_units: number;
}

export interface IRegistryView {
  active: IRegistry | null;
  registries: IRegistry[];
  completeness: ICompletenessCounts | null;
  lastReview: (ICompletenessCounts & { id: string; seq: number; completed_at: string }) | null;
  model: { configured: boolean; provider: string };
}

export interface IAnalysisRun {
  id: string;
  registryId: string;
  task: TAnalysisTask;
  status: TAnalysisStatus;
  failureCode: string | null;
  providerId: string;
  modelId: string;
  modelVersion: string;
  promptVersion: string;
  inputCount: number;
  attempt: number;
  coverage: { fragmentsTotal?: number; batchesTotal?: number; batchesProcessed?: number; batchesFailed?: number; candidatesSaved?: number; truncatedFragments?: number; dropped?: Record<string, number> };
  createdAt: string;
  finishedAt: string | null;
  reused?: boolean;
  excludedByAccess?: number;
}

interface ICandidateBase {
  id: string;
  registryId: string;
  registryActive: boolean;
  origin: TCandidateOrigin;
  analysisRunId: string | null;
  status: TCandidateStatus;
  statusReason: string | null;
  createdBy: string;
  createdAt: string;
  rowVersion: number;
  visible: boolean;
  restricted: boolean;
  evidenceCounts: Record<string, number>;
  rationale: string | null;
  confidence: number | null;
  evidence: IEvidenceLink[];
  derivedFromCandidateId: string | null;
  rebasedFromCandidateId: string | null;
}

export interface IRequirementCandidate extends ICandidateBase {
  kind: 'requirement';
  targetRequirementId: string | null;
  targetCode: string | null;
  requirementId: string | null;
  statement: string | null;
  parameters: IParameter[] | null;
  objectScope: IObjectScope | null;
  contradicted: boolean;
  conflicts: IConflict[];
}

export interface IFactCandidate extends ICandidateBase {
  kind: 'fact';
  factKind: string;
  factKindTitle: string;
  factId: string | null;
  displayValue: string | null;
  unit: string | null;
}

export interface IRequirement {
  id: string;
  code: string;
  stageId: string;
  registryId: string;
  registryActive: boolean;
  currentRevisionId: string;
  seq: number;
  status: 'confirmed' | 'superseded';
  changeKind: string;
  supersededByCode: string | null;
  coverageState: TCoverageState | null;
  coverageUnitMismatch: boolean;
  contradicted: boolean;
  conflicts: IConflict[];
  conflictNote: string | null;
  rowVersion: number;
  visible: boolean;
  restricted: boolean;
  evidenceCounts: Record<string, number>;
  statement: string | null;
  parameters: IParameter[] | null;
  objectScope: IObjectScope | null;
  revisionCreatedAt: string;
}

export interface ICoverageObject {
  id: string;
  type: 'evidence_fragment' | 'calculation_revision' | 'decision' | 'manual_confirmation';
  fragmentId: string | null;
  calculationRevisionId: string | null;
  calculationRevisionSeq: number | null;
  calculationRevisionKind: string | null;
  externalPositionId: string | null;
  externalItemId: string | null;
  positionName: string | null;
  positionNumber: string | null;
  match: 'explicit_line' | 'complex_rate' | null;
  decisionId: string | null;
  note: string | null;
  requirementUnits: string[] | null;
  calculationUnit: string | null;
  unitStatus: 'match' | 'mismatch' | 'not_comparable' | null;
}

export interface ICoverage {
  id: string;
  revisionId: string;
  seq: number;
  state: TCoverageState;
  origin: 'human' | 'system';
  reason: string | null;
  createdAt: string;
  visible: boolean;
  unitMismatch: boolean;
  unitMismatchReason: string | null;
  objects: ICoverageObject[];
  objectCount: number;
}

export interface IDecision {
  id: string;
  status: 'active' | 'superseded';
  supersedesDecisionId: string | null;
  decidedAt: string;
  visible: boolean;
  statement: string | null;
  rationale: string | null;
  evidence: IEvidenceLink[];
}

export interface IRequirementRevision {
  id: string;
  seq: number;
  registrySeq: number;
  status: 'confirmed' | 'superseded';
  changeKind: 'confirmation' | 'carry_over' | 'supersede';
  createdAt: string;
  visible: boolean;
  statement: string | null;
  conflictNote: string | null;
  supersededByCode: string | null;
  evidence: IEvidenceLink[];
}

export interface IAssumption {
  id: string;
  requirementId: string | null;
  requirementCode: string | null;
  seq: number;
  status: 'open' | 'confirmed' | 'rejected' | 'superseded';
  rowVersion: number;
  visible: boolean;
  statement: string | null;
  reason: string | null;
  revisionCreatedAt: string;
}

export interface ICustomerQuestion {
  id: string;
  requirementId: string | null;
  requirementCode: string | null;
  visible: boolean;
  text: string | null;
  status: 'draft' | 'sent' | 'answered' | 'closed';
  askedAt: string | null;
  answeredAt: string | null;
  answerQaItemNo: string | null;
  answerNote: string | null;
  rowVersion: number;
}

export interface IStageNote {
  id: string;
  text: string;
  supersededBy: string | null;
  createdAt: string;
}

export interface IRequirementCard extends IRequirement {
  revisions: IRequirementRevision[];
  coverage: ICoverage[];
  decisions: IDecision[];
  assumptions: IAssumption[];
  questions: ICustomerQuestion[];
}

export interface IFact {
  id: string;
  factKind: string;
  factKindTitle: string;
  seq: number;
  status: 'confirmed' | 'superseded';
  visible: boolean;
  restricted: boolean;
  displayValue: string | null;
  unit: string | null;
  evidence: IEvidenceLink[];
}

export interface IUnitCompleteness {
  scopeItemId: string;
  unitType: string;
  technicalStatus: 'ok' | 'not_recognized' | 'no_fragments';
  total: number;
  covered: number;
  reviewed: number;
  explicitNotRequirement: number;
  unreviewed: number;
  unit: {
    restricted: boolean;
    documentRevisionId: string | null;
    documentTitle: string | null;
    mailSubject: string | null;
    sessionTitle: string | null;
    qaItemNo: string | null;
    qaThreadTitle: string | null;
    qaItemRevisionId: string | null;
    mailMessageRevisionId: string | null;
    transcriptRevisionId: string | null;
  } | null;
}

export interface ICompletenessView {
  registry: IRegistry;
  counts: ICompletenessCounts;
  units: IUnitCompleteness[];
  reviews: (ICompletenessCounts & { id: string; seq: number; completed_at: string })[];
}

export interface IFragmentState {
  fragmentId: string;
  scopeItemId: string;
  state: TFragmentState;
  restricted: boolean;
  origin: string | null;
  pageIndex: number | null;
  text: string | null;
}
