// Вызовы почтового контура, вопросов–ответов и переговоров (этап 07; portal-api §2.6). Загрузки файлов —
// в upload.ts: EML в ящик и manifest в тендер.
import { apiGet, apiPatch, apiPost, apiPut, etagOf } from './client';
import type {
  IMailAccessList,
  IMailbox,
  IMailboxList,
  IMailImport,
  IMailLink,
  IMailMessage,
  IMailMessageDetail,
  IMailRevisionDetail,
  INegotiationSession,
  INegotiationSessionDetail,
  IQaThread,
  IQaThreadDetail,
  TMailCapability,
} from './mailTypes';
import type { IListResponse } from './types';

const enc = encodeURIComponent;

export const listMailboxes = (signal?: AbortSignal): Promise<IMailboxList> => apiGet<IMailboxList>('/mailboxes', { signal });

export const getMailbox = (id: string, signal?: AbortSignal): Promise<IMailbox> => apiGet<IMailbox>(`/mailboxes/${enc(id)}`, { signal });

export const createMailbox = (input: { system: 'manual' | 'mailhub'; externalAccountId: string; displayName: string }, idempotencyKey: string): Promise<IMailbox> =>
  apiPost<IMailbox>('/mailboxes', { body: input, idempotencyKey });

export const updateMailbox = (m: IMailbox, patch: { displayName?: string; status?: 'active' | 'archived' }): Promise<IMailbox> =>
  apiPatch<IMailbox>(`/mailboxes/${enc(m.id)}`, { body: patch, ifMatch: etagOf(m.id, m.rowVersion) });

export const listMailAccess = (id: string, signal?: AbortSignal): Promise<IMailAccessList> => apiGet<IMailAccessList>(`/mailboxes/${enc(id)}/access`, { signal });

export const putMailAccess = (id: string, rowVersion: number, userId: string, capabilities: TMailCapability[]): Promise<IMailAccessList> =>
  apiPut<IMailAccessList>(`/mailboxes/${enc(id)}/access/${enc(userId)}`, { body: { capabilities }, ifMatch: etagOf(id, rowVersion) });

export const listMailboxMessages = (id: string, signal?: AbortSignal): Promise<IListResponse<IMailMessage>> =>
  apiGet<IListResponse<IMailMessage>>(`/mailboxes/${enc(id)}/messages`, { signal });

export const listMailImports = (id: string, signal?: AbortSignal): Promise<IListResponse<IMailImport>> =>
  apiGet<IListResponse<IMailImport>>(`/mailboxes/${enc(id)}/imports`, { signal });

export const getMailImport = (id: string, signal?: AbortSignal): Promise<IMailImport> => apiGet<IMailImport>(`/mail-imports/${enc(id)}`, { signal });

export const getMailMessage = (id: string, signal?: AbortSignal): Promise<IMailMessageDetail> => apiGet<IMailMessageDetail>(`/mail-messages/${enc(id)}`, { signal });

export const getMailRevision = (id: string, signal?: AbortSignal): Promise<IMailRevisionDetail & { messageId: string; mailboxId: string }> =>
  apiGet(`/mail-message-revisions/${enc(id)}`, { signal });

export const linkMailMessage = (messageId: string, input: { tenderId: string; stageId?: string | null }, idempotencyKey: string): Promise<IMailLink> =>
  apiPost<IMailLink>(`/mail-messages/${enc(messageId)}/tender-links`, { body: input, idempotencyKey });

export const unlinkMailMessage = (messageId: string, tenderId: string, idempotencyKey: string): Promise<IMailLink> =>
  apiPost<IMailLink>(`/mail-messages/${enc(messageId)}/tender-links/${enc(tenderId)}/unlink`, { body: {}, idempotencyKey });

export const listTenderMail = (tenderId: string, signal?: AbortSignal): Promise<IListResponse<IMailMessage>> =>
  apiGet<IListResponse<IMailMessage>>(`/tenders/${enc(tenderId)}/mail-messages`, { signal });

// ---------------------------------------------------------------- Вопросы–ответы и переговоры

export const listQaThreads = (tenderId: string, signal?: AbortSignal): Promise<IListResponse<IQaThread>> =>
  apiGet<IListResponse<IQaThread>>(`/tenders/${enc(tenderId)}/qa-threads`, { signal });

export const getQaThread = (id: string, signal?: AbortSignal): Promise<IQaThreadDetail> => apiGet<IQaThreadDetail>(`/qa-threads/${enc(id)}`, { signal });

export const listNegotiationSessions = (tenderId: string, signal?: AbortSignal): Promise<IListResponse<INegotiationSession>> =>
  apiGet<IListResponse<INegotiationSession>>(`/tenders/${enc(tenderId)}/negotiation-sessions`, { signal });

export const getNegotiationSession = (id: string, revisionId: string | null, signal?: AbortSignal): Promise<INegotiationSessionDetail> =>
  apiGet<INegotiationSessionDetail>(`/negotiation-sessions/${enc(id)}${revisionId ? `?revisionId=${enc(revisionId)}` : ''}`, { signal });
