// Этап 16: токены чат-клиентов (MCP портала).
export type TApiTokenClient = 'codex' | 'cursor' | 'other';
export type TApiTokenState = 'active' | 'expired' | 'revoked';

export interface IApiToken {
  id: string;
  name: string;
  clientKind: TApiTokenClient;
  prefix: string;
  scopes: ('read' | 'propose')[];
  lifetimeDays: number;
  state: TApiTokenState;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IApiTokenList {
  items: IApiToken[];
  canIssue: boolean;
  maxActive: number;
  active: number;
}

// Значение токена приходит только в ответе на выпуск.
export interface IIssuedApiToken extends IApiToken {
  token: string;
}

export interface IIssueApiTokenBody {
  name: string;
  clientKind: TApiTokenClient;
  propose: boolean;
  lifetimeDays: 7 | 30 | 90;
}
