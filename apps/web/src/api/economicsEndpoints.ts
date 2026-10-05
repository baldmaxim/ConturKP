// Вызовы экономики этапа 10 (portal-api §2.5, §2.10 в редакции этапа 10). Суммы и вклады считает сервер; клиент
// показывает и передаёт решения человека (пары позиций, причины, решения по гипотезам).
import type {
  IComparison,
  IComparisonBrief,
  IDeviationLine,
  IExplanation,
  ILineageView,
  IReasonRun,
  IReasonSuggestion,
  IRevisionEconomics,
  IUnitsPage,
} from './economicsTypes';
import { apiGet, apiPost, apiPut, etagOf } from './client';
import type { IListResponse } from './types';

const enc = encodeURIComponent;

export const getRevisionEconomics = (revisionId: string, signal?: AbortSignal): Promise<IRevisionEconomics> =>
  apiGet<IRevisionEconomics>(`/calculation-revisions/${enc(revisionId)}/economics`, { signal });

export const getDeviationLines = (revisionId: string, flag: string | null, signal?: AbortSignal): Promise<{ items: IDeviationLine[]; hasMore: boolean }> =>
  apiGet<{ items: IDeviationLine[]; hasMore: boolean }>(`/calculation-revisions/${enc(revisionId)}/economics/deviations?limit=50${flag ? `&flag=${enc(flag)}` : ''}`, { signal });

export const createComparison = (stageId: string, leftRevisionId: string, rightRevisionId: string, idempotencyKey: string): Promise<IComparisonBrief> =>
  apiPost<IComparisonBrief>(`/stages/${enc(stageId)}/comparisons`, { body: { leftRevisionId, rightRevisionId }, idempotencyKey });

export const listComparisons = (stageId: string, signal?: AbortSignal): Promise<IListResponse<IComparisonBrief>> =>
  apiGet<IListResponse<IComparisonBrief>>(`/stages/${enc(stageId)}/comparisons`, { signal });

export const getComparison = (id: string, signal?: AbortSignal): Promise<IComparison> => apiGet<IComparison>(`/comparisons/${enc(id)}`, { signal });

export const getComparisonUnits = (id: string, changedOnly: boolean, after: number, signal?: AbortSignal): Promise<IUnitsPage> =>
  apiGet<IUnitsPage>(`/comparisons/${enc(id)}/units?limit=50&after=${after}${changedOnly ? '&changed=true' : ''}`, { signal });

export const getLineage = (id: string, signal?: AbortSignal): Promise<ILineageView> => apiGet<ILineageView>(`/comparisons/${enc(id)}/lineage`, { signal });

/** Решения по парам; If-Match — последнее решение по паре ревизий. */
export const decideLineage = (
  id: string,
  version: number,
  decisions: { fromPositionId: string; toPositionId: string; status: 'confirmed' | 'rejected' }[],
): Promise<{ version: number; recorded: number }> =>
  apiPost<{ version: number; recorded: number }>(`/comparisons/${enc(id)}/lineage-decisions`, { body: { decisions }, ifMatch: etagOf(id, version) });

export const setExplanation = (
  unitId: string,
  version: number,
  body: { reasonKind: IExplanation['reasonKind']; reasonStatus: IExplanation['reasonStatus']; rationale: string | null; fragmentIds: string[] },
): Promise<{ version: number; explanation: IExplanation }> =>
  apiPut<{ version: number; explanation: IExplanation }>(`/comparison-units/${enc(unitId)}/explanation`, { body, ifMatch: etagOf(unitId, version) });

export const startReasonRun = (comparisonId: string, unitIds: string[] | null, idempotencyKey: string): Promise<IReasonRun> =>
  apiPost<IReasonRun>(`/comparisons/${enc(comparisonId)}/reason-runs`, { body: unitIds ? { unitIds } : {}, idempotencyKey });

export const listReasonRuns = (comparisonId: string, signal?: AbortSignal): Promise<IListResponse<IReasonRun>> =>
  apiGet<IListResponse<IReasonRun>>(`/comparisons/${enc(comparisonId)}/reason-runs`, { signal });

export const decideSuggestion = (s: IReasonSuggestion, decision: 'accept' | 'reject'): Promise<IReasonSuggestion> =>
  apiPost<IReasonSuggestion>(`/change-reason-suggestions/${enc(s.id)}/${decision}`, { body: {}, ifMatch: etagOf(s.id, s.rowVersion) });
