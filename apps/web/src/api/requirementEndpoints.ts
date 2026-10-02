// Вызовы этапа 08 (D-026; portal-api §2.7 в редакции этапа 08).
import { apiGet, apiPatch, apiPost, etagOf } from './client';
import type {
  IAnalysisRun,
  IAssumption,
  ICompletenessCounts,
  ICompletenessView,
  ICustomerQuestion,
  IFact,
  IFactCandidate,
  IFragmentState,
  IObjectScope,
  IParameter,
  IRegistry,
  IRegistryView,
  IRequirement,
  IRequirementCandidate,
  IRequirementCard,
  IStageNote,
  TAnalysisTask,
  TCoverageState,
  TEvidenceRole,
  TFragmentState,
} from './requirementTypes';
import type { IListResponse } from './types';

const enc = encodeURIComponent;
type TRef = { fragmentId: string; role: TEvidenceRole };

export const getRegistryView = (stageId: string, signal?: AbortSignal): Promise<IRegistryView> => apiGet(`/stages/${enc(stageId)}/requirement-registry`, { signal });

export const createRegistry = (stageId: string, input: { evidenceScopeId: string; reason: string }, idempotencyKey: string): Promise<IRegistry & { carry: Record<string, number> }> =>
  apiPost(`/stages/${enc(stageId)}/requirement-registries`, { body: input, idempotencyKey });

export const listRequirements = (registryId: string, signal?: AbortSignal): Promise<IListResponse<IRequirement>> =>
  apiGet(`/requirement-registries/${enc(registryId)}/requirements`, { signal });

export const getRequirementCard = (id: string, signal?: AbortSignal): Promise<IRequirementCard> => apiGet(`/requirements/${enc(id)}`, { signal });

export const listCandidates = <T extends 'requirement' | 'fact'>(
  registryId: string,
  kind: T,
  signal?: AbortSignal,
): Promise<IListResponse<T extends 'requirement' ? IRequirementCandidate : IFactCandidate>> =>
  apiGet(`/requirement-registries/${enc(registryId)}/candidates?kind=${kind}`, { signal });

export const proposeRequirement = (
  registryId: string,
  input: { statement: string; parameters?: IParameter[]; objectScope?: IObjectScope; rationale?: string | null; evidence: TRef[]; targetRequirementId?: string | null; derivedFromCandidateId?: string | null },
  idempotencyKey: string,
): Promise<IRequirementCandidate> => apiPost(`/requirement-registries/${enc(registryId)}/requirement-candidates`, { body: input, idempotencyKey });

export const proposeFact = (
  registryId: string,
  input: { factKind: string; displayValue: string; normalizedValue: Record<string, unknown>; unit?: string | null; evidence: TRef[]; derivedFromCandidateId?: string | null },
  idempotencyKey: string,
): Promise<IFactCandidate> => apiPost(`/requirement-registries/${enc(registryId)}/fact-candidates`, { body: input, idempotencyKey });

export const confirmCandidate = (kind: 'requirement' | 'fact', c: { id: string; rowVersion: number }, body: object, idempotencyKey: string) =>
  apiPost<{ revisionId: string; requirementId?: string; factId?: string }>(`/${kind}-candidates/${enc(c.id)}/confirm`, { body, ifMatch: etagOf(c.id, c.rowVersion), idempotencyKey });

export const rejectCandidate = (kind: 'requirement' | 'fact', c: { id: string; rowVersion: number }, reason: string) =>
  apiPost(`/${kind}-candidates/${enc(c.id)}/reject`, { body: { reason }, ifMatch: etagOf(c.id, c.rowVersion) });

export const rebaseCandidate = (kind: 'requirement' | 'fact', id: string, idempotencyKey: string) =>
  apiPost(`/${kind}-candidates/${enc(id)}/rebase`, { body: {}, idempotencyKey });

export const listFacts = (registryId: string, signal?: AbortSignal): Promise<IListResponse<IFact>> => apiGet(`/requirement-registries/${enc(registryId)}/facts`, { signal });

export const listFactKinds = (signal?: AbortSignal): Promise<IListResponse<{ code: string; title: string; valueType: string }>> => apiGet('/fact-kinds', { signal });

export const supersedeRequirement = (r: { id: string; rowVersion: number }, input: { replacementId: string; reason: string }) =>
  apiPost<IRequirementCard>(`/requirements/${enc(r.id)}/supersede`, { body: input, ifMatch: etagOf(r.id, r.rowVersion) });

export interface ICoverageObjectInput {
  type: 'evidence_fragment' | 'calculation_revision' | 'decision' | 'manual_confirmation';
  fragmentId?: string;
  calculationRevisionId?: string;
  externalPositionId?: string | null;
  externalItemId?: string | null;
  match?: 'explicit_line' | 'complex_rate' | null;
  decisionId?: string;
  note?: string;
}

export const recordCoverage = (
  revisionId: string,
  input: { state: TCoverageState; reason?: string | null; unitMismatchReason?: string | null; objects: ICoverageObjectInput[] },
  idempotencyKey: string,
) =>
  apiPost<IRequirementCard>(`/requirement-revisions/${enc(revisionId)}/coverage`, { body: input, idempotencyKey });

export const recordDecision = (requirementId: string, input: { statement: string; rationale: string; supersedesDecisionId?: string | null; evidence?: TRef[] }, idempotencyKey: string) =>
  apiPost<{ decisionId: string; requirement: IRequirementCard }>(`/requirements/${enc(requirementId)}/decisions`, { body: input, idempotencyKey });

export const startAnalysis = (registryId: string, task: TAnalysisTask, idempotencyKey: string, method: 'model' | 'rules' = 'model'): Promise<IAnalysisRun> =>
  apiPost(`/requirement-registries/${enc(registryId)}/analysis-runs`, { body: method === 'rules' ? { task, method } : { task }, idempotencyKey });

export const listAnalysisRuns = (registryId: string, signal?: AbortSignal): Promise<IListResponse<IAnalysisRun>> =>
  apiGet(`/requirement-registries/${enc(registryId)}/analysis-runs`, { signal });

export const getCompleteness = (registryId: string, signal?: AbortSignal): Promise<ICompletenessView> =>
  apiGet(`/requirement-registries/${enc(registryId)}/completeness`, { signal });

export const listFragmentStates = (registryId: string, q: { scopeItemId?: string; state?: TFragmentState }, signal?: AbortSignal): Promise<IListResponse<IFragmentState>> => {
  const p = new URLSearchParams({ limit: '500', ...(q.scopeItemId ? { scopeItemId: q.scopeItemId } : {}), ...(q.state ? { state: q.state } : {}) });
  return apiGet(`/requirement-registries/${enc(registryId)}/fragments?${p.toString()}`, { signal });
};

export const markFragments = (registryId: string, input: { mark: 'not_requirement' | 'cleared'; reason?: string | null; selector: Record<string, unknown> }, idempotencyKey: string) =>
  apiPost<{ batchId: string; fragmentIds: string[]; counts: ICompletenessCounts }>(`/requirement-registries/${enc(registryId)}/marks`, { body: input, idempotencyKey });

export const completeReview = (registryId: string, idempotencyKey: string) =>
  apiPost<{ id: string; counts: ICompletenessCounts }>(`/requirement-registries/${enc(registryId)}/reviews`, { body: {}, idempotencyKey });

export const listAssumptions = (stageId: string, signal?: AbortSignal): Promise<IListResponse<IAssumption>> => apiGet(`/stages/${enc(stageId)}/assumptions`, { signal });

export const createAssumption = (stageId: string, input: { statement: string; requirementId?: string | null }, idempotencyKey: string): Promise<IAssumption> =>
  apiPost(`/stages/${enc(stageId)}/assumptions`, { body: input, idempotencyKey });

export const reviseAssumption = (a: { id: string; rowVersion: number }, input: { status: IAssumption['status']; statement?: string; reason?: string | null }): Promise<IAssumption> =>
  apiPost(`/assumptions/${enc(a.id)}/revisions`, { body: input, ifMatch: etagOf(a.id, a.rowVersion) });

export const listQuestions = (stageId: string, signal?: AbortSignal): Promise<IListResponse<ICustomerQuestion>> => apiGet(`/stages/${enc(stageId)}/customer-questions`, { signal });

export const createQuestion = (stageId: string, input: { text: string; requirementId?: string | null }, idempotencyKey: string): Promise<ICustomerQuestion> =>
  apiPost(`/stages/${enc(stageId)}/customer-questions`, { body: input, idempotencyKey });

export const updateQuestion = (q: { id: string; rowVersion: number }, patch: Record<string, unknown>): Promise<ICustomerQuestion> =>
  apiPatch(`/customer-questions/${enc(q.id)}`, { body: patch, ifMatch: etagOf(q.id, q.rowVersion) });

export const listNotes = (stageId: string, signal?: AbortSignal): Promise<IListResponse<IStageNote>> => apiGet(`/stages/${enc(stageId)}/notes`, { signal });

export const createNote = (stageId: string, text: string, idempotencyKey: string): Promise<IStageNote> => apiPost(`/stages/${enc(stageId)}/notes`, { body: { text }, idempotencyKey });
