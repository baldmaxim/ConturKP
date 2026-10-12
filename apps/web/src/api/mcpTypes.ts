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

// Предложения чат-клиента на этапе: принимает или отклоняет человек.
export type TChatProposalKind = 'finding' | 'question' | 'condition_text' | 'change_reason';

export interface IChatProposal {
  id: string;
  stageId: string;
  kind: TChatProposalKind;
  status: 'open' | 'accepted' | 'rejected';
  restricted: boolean;
  title: string | null;
  body: string | null;
  detail: Record<string, unknown>;
  citedFragmentIds: string[];
  citations: number;
  proposedOnBehalfOf: { id: string; name: string };
  createdAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionReason: string | null;
  result: { type: string; id: string } | null;
  etag: string;
  can: { decide: boolean };
}

export interface IChatProposalList {
  items: IChatProposal[];
  open: number;
}

export interface IAcceptChatProposalBody {
  severity?: 'critical' | 'major' | 'minor';
  confidence?: 'low' | 'medium' | 'high';
}
