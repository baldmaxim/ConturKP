// Вызовы API распознавания и доказательств (этап 04, portal-api §2.4).
import { apiGet, apiPost, etagOf } from './client';
import type { IEvidenceDetail, IFragmentPage, IListResponse, IRecognitionRun, IRecognitionRunDetail, ISourceSetRevision } from './types';

const enc = encodeURIComponent;

export const listRecognitionRuns = (revisionId: string, signal?: AbortSignal): Promise<IListResponse<IRecognitionRun>> =>
  apiGet<IListResponse<IRecognitionRun>>(`/document-revisions/${enc(revisionId)}/recognition-runs`, { signal });

export const getRecognitionRun = (runId: string, signal?: AbortSignal): Promise<IRecognitionRunDetail> =>
  apiGet<IRecognitionRunDetail>(`/recognition-runs/${enc(runId)}`, { signal });

export const listFragments = (
  runId: string,
  q: { pageIndex?: number; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<IFragmentPage> => {
  const params = new URLSearchParams();
  if (q.pageIndex !== undefined) {
    params.set('pageIndex', String(q.pageIndex));
  }
  if (q.cursor) {
    params.set('cursor', q.cursor);
  }
  if (q.limit !== undefined) {
    params.set('limit', String(q.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiGet<IFragmentPage>(`/recognition-runs/${enc(runId)}/fragments${suffix}`, { signal });
};

export const getEvidence = (fragmentId: string, signal?: AbortSignal): Promise<IEvidenceDetail> =>
  apiGet<IEvidenceDetail>(`/evidence/${enc(fragmentId)}`, { signal });

/** Заморозка состава: требует распознавания включённых редакций (409 с перечнем блокирующих). */
export const freezeSourceSet = (revisionId: string, rowVersion: number, idempotencyKey: string): Promise<ISourceSetRevision> =>
  apiPost<ISourceSetRevision>(`/source-set-revisions/${enc(revisionId)}/freeze`, {
    body: {},
    ifMatch: etagOf(revisionId, rowVersion),
    idempotencyKey,
  });
