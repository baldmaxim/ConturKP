// Вызовы комплекта-кандидата и библиотеки вложений (этап 12; portal-api §2.9). Файлы — по ID через API, права
// проверяет сервер при каждом запросе (D-032 В-12-7).
import { API_BASE, apiGet, apiPost } from './client';
import type { ICandidateBrief, ICandidateView, IStandardAttachment } from './releaseTypes';

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
