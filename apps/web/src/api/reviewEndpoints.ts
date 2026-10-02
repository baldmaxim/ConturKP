// Вызовы проверки и разногласий этапа 09 (portal-api §2.7 в редакции этапа 09).
import { apiGet, apiPatch, apiPost } from './client';
import type { IDiscrepancyView, IFindingDetail, IFindingList, IRunBrief, IRunView, ISourcePriorityView, ISuggestionView, TAxis, TConfidence, TSeverity } from './reviewTypes';

const enc = encodeURIComponent;

export const listReviewRuns = (stageId: string, signal?: AbortSignal): Promise<{ items: IRunBrief[] }> => apiGet(`/stages/${enc(stageId)}/review-runs`, { signal });
export const getReviewRun = (runId: string, signal?: AbortSignal): Promise<IRunView> => apiGet(`/review-runs/${enc(runId)}`, { signal });
export const startReviewRun = (stageId: string, idempotencyKey: string): Promise<IRunBrief & { reused: boolean }> =>
  apiPost(`/stages/${enc(stageId)}/review-runs`, { body: {}, idempotencyKey });

export const listFindings = (stageId: string, filter: { status?: string; severity?: string; kind?: string }, signal?: AbortSignal): Promise<IFindingList> => {
  const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => !!v) as [string, string][]).toString();
  return apiGet(`/stages/${enc(stageId)}/findings${q ? `?${q}` : ''}`, { signal });
};
export const getFinding = (id: string, signal?: AbortSignal): Promise<IFindingDetail> => apiGet(`/findings/${enc(id)}`, { signal });

export const transitionFinding = (
  f: { id: string; etag: string },
  body: { to: string; reason?: string | null; statement?: string | null; ownerUserId?: string | null },
  idempotencyKey: string,
): Promise<IFindingDetail> => apiPost(`/findings/${enc(f.id)}/transitions`, { body, ifMatch: f.etag, idempotencyKey });

export const patchFinding = (
  f: { id: string; etag: string },
  body: { severity?: TSeverity; confidence?: TConfidence; ownerUserId?: string | null; action?: string | null; impact?: string | null; reason?: string | null },
  idempotencyKey: string,
): Promise<IFindingDetail> => apiPatch(`/findings/${enc(f.id)}`, { body, ifMatch: f.etag, idempotencyKey });

export const createDiscrepancy = (findingId: string, topic: string, idempotencyKey: string): Promise<IFindingDetail> =>
  apiPost(`/findings/${enc(findingId)}/discrepancy`, { body: { topic }, idempotencyKey });

export const listDiscrepancies = (stageId: string, signal?: AbortSignal): Promise<{ items: IDiscrepancyView[] }> => apiGet(`/stages/${enc(stageId)}/discrepancies`, { signal });

export const addAxisEvent = (
  discrepancyId: string,
  body: { axis: TAxis; value: string; reason: string; bases: { type: string; id: string }[] },
  idempotencyKey: string,
): Promise<IFindingDetail> => apiPost(`/discrepancies/${enc(discrepancyId)}/status-events`, { body, idempotencyKey });

export const decideDiscrepancy = (
  discrepancyId: string,
  body: { statement: string; rationale: string; graph?: { kind: 'prevails'; prevailingFactId: string } | { kind: 'distinct' } | null },
  idempotencyKey: string,
): Promise<{ decisionId: string; factDecisionId: string | null; finding: IFindingDetail }> => apiPost(`/discrepancies/${enc(discrepancyId)}/decisions`, { body, idempotencyKey });

export const acceptSuggestion = (id: string, body: { severity: TSeverity; reason: string | null }, idempotencyKey: string): Promise<IFindingDetail> =>
  apiPost(`/model-suggestions/${enc(id)}/accept`, { body, idempotencyKey });
export const rejectSuggestion = (id: string, reason: string, idempotencyKey: string): Promise<ISuggestionView> =>
  apiPost(`/model-suggestions/${enc(id)}/reject`, { body: { reason }, idempotencyKey });

export const getSourcePriority = (tenderId: string, signal?: AbortSignal): Promise<ISourcePriorityView> => apiGet(`/tenders/${enc(tenderId)}/source-priority`, { signal });
export const setSourcePriority = (tenderId: string, body: { kinds: string[]; reason: string }, idempotencyKey: string): Promise<ISourcePriorityView> =>
  apiPost(`/tenders/${enc(tenderId)}/source-priority`, { body, idempotencyKey });
