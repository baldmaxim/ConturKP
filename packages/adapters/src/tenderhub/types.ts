// Адаптер TenderHub (docs/contracts/adapters.md §2, ADR-007 §5–8, D-016). Контракт — документация
// API от 2026-09-02 (архив ApiTenderHub, SHA-256 сверен ревью 00-1) и OpenAPI archive.yaml 1.0.0.
// Только чтение по X-API-Key (область tenders:read); Bearer не используется никогда.

export const TENDERHUB_CONTRACT_VERSION = 'th-api-2026-09-02/adapter-1';

export type TenderHubErrorCode =
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT_UNKNOWN_OUTCOME'
  | 'CONTRACT_MISMATCH'
  | 'INVALID_DATA';

// Ошибка адаптера — без секретов и без данных ответа: только классы, коды и путь маршрута.
export interface ITenderHubError {
  code: TenderHubErrorCode;
  // Машинная причина для выгрузки и интерфейса: auth_failed, forbidden_scope, rate_limited, …
  reason: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export class TenderHubError extends Error {
  readonly error: ITenderHubError;
  constructor(error: ITenderHubError) {
    super(error.message);
    this.error = error;
  }
}

export const thError = (
  code: TenderHubErrorCode,
  reason: string,
  message: string,
  retryable: boolean,
  details?: ITenderHubError['details'],
): TenderHubError => new TenderHubError({ code, reason, message, retryable, ...(details ? { details } : {}) });

// Сырой ответ маршрута: тело после распаковки gzip — ровно то, что сохраняется в blob.
export interface IRawResponse {
  // openapi — живая спецификация развёрнутой сборки (GET /api/v1/archive/openapi.yaml), только для live-smoke (R-06).
  route: 'brief' | 'overview' | 'positions' | 'positions_with_costs' | 'boq_items_full' | 'openapi';
  // Путь с параметрами запроса, без базового адреса и без ключа.
  path: string;
  status: number;
  contentEncoding: string | null;
  // Время источника из заголовка Date (секундная точность) и время получения порталом.
  sourceDate: string | null;
  receivedAt: string;
  body: Buffer;
}
