// Ошибки API — RFC 9457 (application/problem+json) с машинным кодом (portal-api §1).
import type { ErrorCode, IProblem } from '@kontur/contracts';
import type { Response } from 'express';
import { ZodError } from 'zod';

export interface IAuditTarget {
  entityType?: string;
  entityId?: string | null;
  // Только для тендера, существование которого пользователю уже известно.
  tenderId?: string | null;
  details?: Record<string, unknown>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly extra: Partial<IProblem>;
  readonly target: IAuditTarget;
  constructor(status: number, code: ErrorCode, detail?: string, extra: Partial<IProblem> = {}, target: IAuditTarget = {}) {
    super(detail ?? code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
    this.target = target;
  }
}

const TITLES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Требуется вход',
  FORBIDDEN: 'Недостаточно прав',
  NOT_FOUND: 'Не найдено',
  PRECONDITION_REQUIRED: 'Требуется If-Match',
  VERSION_CONFLICT: 'Объект изменён другим пользователем',
  STATE_CONFLICT: 'Конфликт состояния',
  VALIDATION_FAILED: 'Некорректный запрос',
  IDEMPOTENCY_KEY_REUSED: 'Ключ идемпотентности использован с другим запросом',
  RATE_LIMITED: 'Слишком много попыток',
  INTERNAL: 'Внутренняя ошибка',
};

export const notFound = (target: IAuditTarget = {}): HttpError =>
  new HttpError(404, 'NOT_FOUND', 'Объект не найден или нет доступа', {}, target);
export const forbidden = (capability: string, target: IAuditTarget = {}): HttpError =>
  new HttpError(403, 'FORBIDDEN', `нет права ${capability}`, {}, { ...target, details: { ...target.details, capability } });
export const validation = (err: ZodError): HttpError =>
  new HttpError(400, 'VALIDATION_FAILED', 'Проверьте поля запроса', {
    errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });

// Ошибки PostgreSQL, означающие нарушение правил данных, а не сбой.
export const fromPgError = (err: unknown): HttpError | null => {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === '23505') return new HttpError(409, 'STATE_CONFLICT', `значение уже занято (${e.constraint ?? 'unique'})`);
  if (e.code === '23514') return new HttpError(409, 'STATE_CONFLICT', e.message);
  return null;
};

export const sendProblem = (res: Response, err: HttpError, requestId: string): void => {
  const body: IProblem = {
    type: 'about:blank',
    title: TITLES[err.code],
    status: err.status,
    code: err.code,
    ...(err.detail ? { detail: err.detail } : {}),
    requestId,
    ...err.extra,
  };
  res.status(err.status).type('application/problem+json').send(JSON.stringify(body));
};
