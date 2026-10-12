// Этап 16: токены чат-клиентов. У выпуска нет ключа идемпотентности: значение токена нигде не сохраняется.
import { apiDelete, apiGet, apiPost } from './client';
import type { IAcceptChatProposalBody, IApiToken, IApiTokenList, IChatProposal, IChatProposalList, IIssueApiTokenBody, IIssuedApiToken } from './mcpTypes';

export const listApiTokens = (signal?: AbortSignal) => apiGet<IApiTokenList>('/me/api-tokens', { signal });

export const issueApiToken = (body: IIssueApiTokenBody) => apiPost<IIssuedApiToken>('/me/api-tokens', { body });

export const revokeApiToken = (id: string) => apiDelete<IApiToken>(`/api-tokens/${encodeURIComponent(id)}`);

// ---------------------------------------------------------------- Предложения из чата

export const listChatProposals = (stageId: string, signal?: AbortSignal) => apiGet<IChatProposalList>(`/stages/${encodeURIComponent(stageId)}/mcp-proposals`, { signal });

export const acceptChatProposal = (p: IChatProposal, body: IAcceptChatProposalBody, idempotencyKey: string) =>
  apiPost<IChatProposal>(`/mcp-proposals/${encodeURIComponent(p.id)}/accept`, { body, ifMatch: p.etag, idempotencyKey });

export const rejectChatProposal = (p: IChatProposal, reason: string, idempotencyKey: string) =>
  apiPost<IChatProposal>(`/mcp-proposals/${encodeURIComponent(p.id)}/reject`, { body: { reason }, ifMatch: p.etag, idempotencyKey });
