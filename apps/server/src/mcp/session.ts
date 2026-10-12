// Этап 16 (ADR-010; проект docs/architecture/16-mcp-design.md): вызов чат-клиента — токен пользователя и его текущие права.
// Контекст прав загружается заново на каждый запрос: отзыв назначения, роли или `mail.read` действует сразу.
import type { IAppConfig } from '@kontur/config';
import type { IAccessContext, IApiTokenRow, Pool } from '@kontur/db';
import type { BlobStore } from '@kontur/storage';

export interface IMcpSession {
  pool: Pool;
  // Хранилище нужно только сравнению выпусков: оно читает закреплённые манифесты сторон. Файлы чат-клиенту не отдаются.
  store: BlobStore;
  config: IAppConfig;
  clock: () => Date;
  ctx: IAccessContext;
  token: IApiTokenRow;
  requestId: string;
}

// Коды ошибок инструментов — docs/contracts/mcp-tools.md §5.
export type McpErrorCode =
  | 'needs_selection'
  | 'out_of_scope'
  | 'invalid_citation'
  | 'not_available'
  | 'scope_changed'
  | 'rate_limited'
  | 'forbidden_action'
  | 'invalid_request'
  | 'internal';

export class McpToolError extends Error {
  readonly code: McpErrorCode;
  readonly data: Record<string, unknown>;
  constructor(code: McpErrorCode, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// Объект вне области или прав: одно сообщение для чужого и несуществующего — существование не раскрывается (A12).
export const outOfScope = (): McpToolError => new McpToolError('out_of_scope', 'объект вне области запроса или недоступен');
