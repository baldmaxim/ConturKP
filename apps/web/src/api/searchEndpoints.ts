// Вызовы поиска и снимка области (этап 05, portal-api §2.3–2.4).
import { apiGet, apiPost } from './client';
import type { IEvidenceScope, IListResponse, ISearchRun } from './types';

const enc = encodeURIComponent;

export type TSearchScopeChoice = { mode: 'working'; stageId: string } | { mode: 'review'; evidenceScopeId: string };

export const runSearch = (tenderId: string, scope: TSearchScopeChoice, query: string, limit = 20): Promise<ISearchRun> =>
  apiPost<ISearchRun>('/search', { body: { context: { kind: 'tender', tenderId, ...scope }, query, limit } });

export const getSearchRun = (runId: string, signal?: AbortSignal): Promise<ISearchRun> =>
  apiGet<ISearchRun>(`/search-runs/${enc(runId)}`, { signal });

export const listEvidenceScopes = (stageId: string, signal?: AbortSignal): Promise<IListResponse<IEvidenceScope>> =>
  apiGet<IListResponse<IEvidenceScope>>(`/stages/${enc(stageId)}/evidence-scopes`, { signal });

/** Снимок из последней замороженной ревизии набора: тот же состав возвращает прежний снимок. */
export const createEvidenceScope = (stageId: string, idempotencyKey: string): Promise<IEvidenceScope> =>
  apiPost<IEvidenceScope>(`/stages/${enc(stageId)}/evidence-scopes`, { body: {}, idempotencyKey });
