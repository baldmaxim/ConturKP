// Этап 16: токены чат-клиентов. У выпуска нет ключа идемпотентности: значение токена нигде не сохраняется.
import { apiDelete, apiGet, apiPost } from './client';
import type { IApiToken, IApiTokenList, IIssueApiTokenBody, IIssuedApiToken } from './mcpTypes';

export const listApiTokens = (signal?: AbortSignal) => apiGet<IApiTokenList>('/me/api-tokens', { signal });

export const issueApiToken = (body: IIssueApiTokenBody) => apiPost<IIssuedApiToken>('/me/api-tokens', { body });

export const revokeApiToken = (id: string) => apiDelete<IApiToken>(`/api-tokens/${encodeURIComponent(id)}`);
