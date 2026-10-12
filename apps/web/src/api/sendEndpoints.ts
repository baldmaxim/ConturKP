// Вызовы этапа 15 (D-035; portal-api §2.10): отправки и нарушения выпуска, сравнение выпусков тендера.
import { API_BASE, apiGet, apiPost, apiPut, etagOf } from './client';
import type {
  IComparisonBrief,
  IComparisonItem,
  IComparisonView,
  IIncidentBody,
  IIncidentView,
  IItemReason,
  IReasonBody,
  IReleaseSends,
  ISendCandidates,
  ISendView,
  ITenderRelease,
  TCompareSection,
  TRegisterSendBody,
} from './sendTypes';

const enc = encodeURIComponent;

export const listReleaseSends = (releaseId: string, signal?: AbortSignal) => apiGet<IReleaseSends>(`/releases/${enc(releaseId)}/send-events`, { signal });

export const listSendCandidates = (releaseId: string, signal?: AbortSignal) => apiGet<ISendCandidates>(`/releases/${enc(releaseId)}/send-candidates`, { signal });

export const registerSend = (releaseId: string, body: TRegisterSendBody, idempotencyKey: string) => apiPost<ISendView>(`/releases/${enc(releaseId)}/send-events`, { body, idempotencyKey });

export const acceptSendExtras = (s: ISendView, reason: string, idempotencyKey: string) => apiPost<ISendView>(`/send-events/${enc(s.id)}/accept-extras`, { body: { reason }, ifMatch: s.etag, idempotencyKey });

export const registerIncident = (releaseId: string, body: IIncidentBody, idempotencyKey: string) => apiPost<IIncidentView>(`/releases/${enc(releaseId)}/compliance-incidents`, { body, idempotencyKey });

export const sendEvidenceUrl = (sendEventId: string): string => `${API_BASE}/send-events/${enc(sendEventId)}/evidence`;
export const incidentEvidenceUrl = (incidentId: string): string => `${API_BASE}/compliance-incidents/${enc(incidentId)}/evidence`;
export const sendEvidenceUploadUrl = (releaseId: string, fileName: string): string => `${API_BASE}/releases/${enc(releaseId)}/send-evidence?name=${enc(fileName)}`;

// ---------------------------------------------------------------- Сравнение выпусков

export const listTenderReleases = (tenderId: string, signal?: AbortSignal) => apiGet<{ items: ITenderRelease[]; canCompare: boolean }>(`/tenders/${enc(tenderId)}/releases`, { signal });

export const listReleaseComparisons = (tenderId: string, signal?: AbortSignal) => apiGet<{ items: IComparisonBrief[] }>(`/tenders/${enc(tenderId)}/release-comparisons`, { signal });

export const createReleaseComparison = (tenderId: string, leftReleaseId: string, rightReleaseId: string, idempotencyKey: string) =>
  apiPost<IComparisonBrief>(`/tenders/${enc(tenderId)}/release-comparisons`, { body: { leftReleaseId, rightReleaseId }, idempotencyKey });

export const getReleaseComparison = (id: string, signal?: AbortSignal) => apiGet<IComparisonView>(`/release-comparisons/${enc(id)}`, { signal });

export const listComparisonItems = (id: string, section: TCompareSection, after: number, signal?: AbortSignal) =>
  apiGet<{ items: IComparisonItem[]; hasMore: boolean; nextAfter: number | null }>(`/release-comparisons/${enc(id)}/items?section=${section}&after=${after}&limit=100`, { signal });

export const setItemReason = (item: IComparisonItem, body: IReasonBody) =>
  apiPut<{ version: number; reason: IItemReason }>(`/release-comparison-items/${enc(item.id)}/reason`, { body, ifMatch: etagOf(item.id, item.reasonVersion) });
