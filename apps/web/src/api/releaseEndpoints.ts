// Вызовы комплекта-кандидата и библиотеки вложений (этап 12; portal-api §2.9). Файлы — по ID через API, права
// проверяет сервер при каждом запросе (D-032 В-12-7).
import { API_BASE, apiGet, apiPost } from './client';
import type { ICandidateBrief, ICandidateView, IHistoryEntry, IHoldView, IReleaseView, IStandardAttachment } from './releaseTypes';

const enc = encodeURIComponent;

export const listCandidates = (stageId: string, signal?: AbortSignal) => apiGet<{ items: ICandidateBrief[]; canCreate: boolean }>(`/stages/${enc(stageId)}/release-candidates`, { signal });

export const getCandidate = (id: string, signal?: AbortSignal) => apiGet<ICandidateView>(`/release-candidates/${enc(id)}`, { signal });

export const createCandidate = (stageId: string, body: { mode: 'test' | 'production'; draftIds: string[]; attachmentRevisionIds: string[] }, idempotencyKey: string) =>
  apiPost<ICandidateView>(`/stages/${enc(stageId)}/release-candidates`, { body, idempotencyKey });

export const candidateFileUrl = (fileId: string): string => `${API_BASE}/candidate-files/${enc(fileId)}/content`;
export const candidateArchiveUrl = (id: string, set: 'customer' | 'all' = 'customer'): string => `${API_BASE}/release-candidates/${enc(id)}/archive?set=${set}`;
export const candidateManifestUrl = (id: string): string => `${API_BASE}/release-candidates/${enc(id)}/manifest`;

export const listAttachments = (signal?: AbortSignal) => apiGet<{ items: IStandardAttachment[]; canCreateCompany: boolean }>('/standard-attachments', { signal });

export const createAttachment = (title: string, idempotencyKey: string) => apiPost<{ id: string; title: string }>('/standard-attachments', { body: { title }, idempotencyKey });

export const createAttachmentRevision = (attachmentId: string, body: { sha256: string; fileName: string; audience: 'customer' | 'internal' }, idempotencyKey: string) =>
  apiPost<IStandardAttachment>(`/standard-attachments/${enc(attachmentId)}/revisions`, { body, idempotencyKey });

export const approveAttachmentRevision = (a: IStandardAttachment) => apiPost<IStandardAttachment>(`/standard-attachment-revisions/${enc(a.revisionId)}/approve`, { body: {}, ifMatch: a.etag });

// ---------------------------------------------------------------- Этап 13: согласование и выпуск (D-033)

export const approveCandidate = (c: ICandidateView, comment: string | null, idempotencyKey: string) =>
  apiPost<ICandidateView>(`/release-candidates/${enc(c.id)}/approve`, {
    body: { contentHash: c.contentHash, compositionHash: c.gate?.approve?.compositionHash, ...(comment ? { comment } : {}) },
    ifMatch: c.etag,
    idempotencyKey,
  });

export const returnCandidate = (c: ICandidateView, reason: string, idempotencyKey: string) =>
  apiPost<ICandidateView>(`/release-candidates/${enc(c.id)}/return`, { body: { reason }, ifMatch: c.etag, idempotencyKey });

export const revokeApproval = (approval: { id: string; etag: string }, reason: string, idempotencyKey: string) =>
  apiPost<ICandidateView>(`/approvals/${enc(approval.id)}/revoke`, { body: { reason }, ifMatch: approval.etag, idempotencyKey });

export const releaseCandidate = (c: ICandidateView, approvalId: string, idempotencyKey: string) =>
  apiPost<ICandidateView>(`/release-candidates/${enc(c.id)}/release`, {
    body: { approvalId, contentHash: c.contentHash, compositionHash: c.gate?.release?.compositionHash },
    ifMatch: c.etag,
    idempotencyKey,
  });

export const acceptRisk = (candidateId: string, body: { blockerCode: string; subjectType: string; subjectId: string; subjectKey: string; reason: string }, idempotencyKey: string) =>
  apiPost<ICandidateView>(`/release-candidates/${enc(candidateId)}/risk-acceptances`, { body, idempotencyKey });

export const listHolds = (stageId: string, candidateId: string, signal?: AbortSignal) =>
  apiGet<{ items: IHoldView[]; canResolve: boolean }>(`/stages/${enc(stageId)}/holds?candidateId=${enc(candidateId)}`, { signal });

export const resolveHolds = (candidateId: string, body: { holdIds: string[]; resolution: 'not_applicable' | 'requires_new_candidate'; reason: string }, idempotencyKey: string) =>
  apiPost<ICandidateView>(`/release-candidates/${enc(candidateId)}/holds/resolve`, { body, idempotencyKey });

export const candidateHistory = (candidateId: string, signal?: AbortSignal) => apiGet<{ items: IHistoryEntry[] }>(`/release-candidates/${enc(candidateId)}/history`, { signal });

export const listReleases = (stageId: string, signal?: AbortSignal) => apiGet<{ items: (IReleaseView & { restricted: boolean })[] }>(`/stages/${enc(stageId)}/releases`, { signal });

export const releaseManifestUrl = (id: string): string => `${API_BASE}/releases/${enc(id)}/manifest`;
export const releaseArchiveUrl = (id: string, set: 'customer' | 'all' = 'customer'): string => `${API_BASE}/releases/${enc(id)}/archive?set=${set}`;
