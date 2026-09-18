import type { IProblem } from './types';

export const API_BASE = '/api/v1';
const CSRF_COOKIE = 'kkp_csrf';

type THttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface IRequestOptions {
  body?: unknown;
  /** Значение If-Match (ETag формата "<id>:<rowVersion>"). */
  ifMatch?: string;
  /** Ключ идемпотентности: один на одну попытку пользователя. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Не переводить на экран входа при 401 (форма входа сама показывает ошибку). */
  skipAuthRedirect?: boolean;
}

/** Ошибка вызова API: либо ответ problem+json, либо сбой сети. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: IProblem | null;
  readonly isNetwork: boolean;

  constructor(message: string, status: number, problem: IProblem | null, isNetwork = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.isNetwork = isNetwork;
  }

  get code(): string | null {
    return this.problem?.code ?? null;
  }
}

let unauthenticatedHandler: (() => void) | null = null;

/** Регистрирует обработчик 401: сброс сессии и переход на экран входа. */
export const setUnauthenticatedHandler = (handler: (() => void) | null): void => {
  unauthenticatedHandler = handler;
};

/** ETag объекта: "<id>:<rowVersion>". */
export const etagOf = (id: string, rowVersion: number): string => `"${id}:${rowVersion}"`;

const readCookie = (name: string): string | null => {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return trimmed.slice(prefix.length);
      }
    }
  }
  return null;
};

/**
 * UUID v4. crypto.randomUUID доступен только в защищённом контексте (HTTPS/localhost);
 * в LAN по HTTP — фолбэк на crypto.getRandomValues (доступен везде).
 */
export const newUuid = (): string => {
  if (typeof crypto.randomUUID === 'function' && window.isSecureContext) {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const isProblem = (value: unknown): value is IProblem =>
  typeof value === 'object' && value !== null && 'status' in value && 'code' in value;

const parseProblem = async (response: Response): Promise<IProblem> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      const body: unknown = await response.json();
      if (isProblem(body)) {
        return body;
      }
    } catch {
      // Тело не разобрано — ниже собираем problem по статусу.
    }
  }
  return {
    type: 'about:blank',
    title: response.statusText || 'Ошибка',
    status: response.status,
    code: response.status >= 500 ? 'INTERNAL' : 'UNKNOWN',
    requestId: response.headers.get('x-request-id') ?? '',
  };
};

const request = async <T>(method: THttpMethod, path: string, options: IRequestOptions = {}): Promise<T> => {
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) {
      headers.set('X-CSRF-Token', csrf);
    }
  }
  if (options.ifMatch) {
    headers.set('If-Match', options.ifMatch);
  }
  if (options.idempotencyKey) {
    headers.set('Idempotency-Key', options.idempotencyKey);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError('Нет связи с сервером', 0, null, true);
  }

  if (!response.ok) {
    const problem = await parseProblem(response);
    if (response.status === 401 && !options.skipAuthRedirect) {
      unauthenticatedHandler?.();
    }
    throw new ApiError(problem.title, response.status, problem);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
};

export const apiGet = <T>(path: string, options?: IRequestOptions): Promise<T> => request<T>('GET', path, options);
export const apiPost = <T>(path: string, options?: IRequestOptions): Promise<T> => request<T>('POST', path, options);
export const apiPut = <T>(path: string, options?: IRequestOptions): Promise<T> => request<T>('PUT', path, options);
export const apiPatch = <T>(path: string, options?: IRequestOptions): Promise<T> => request<T>('PATCH', path, options);
export const apiDelete = <T>(path: string, options?: IRequestOptions): Promise<T> => request<T>('DELETE', path, options);

export const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';
