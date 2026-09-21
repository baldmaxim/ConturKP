// Транспорт и защита браузерной сессии (ADR-006 §12–13).
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IAppConfig } from '@kontur/config';
import { findActiveSession, loadAccessContext, sha256, touchSession, type Pool } from '@kontur/db';
import type { NextFunction, Request, Response } from 'express';
import { setState, stateOf } from './context.ts';
import { auditFailure } from './command.ts';
import { HttpError } from './errors.ts';

export const SESSION_COOKIE = 'kkp_session';
export const CSRF_COOKIE = 'kkp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  // pdf.js подключает шрифты документа через FontFace с blob-URL, созданным нашим же
  // скриптом из уже полученного файла: внешних запросов это не добавляет (script-src 'self').
  "font-src 'self' blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const securityHeaders =
  (config: IAppConfig) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    setState(req, { requestId, auth: null });
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.tls) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };

export const parseCookies = (header: string | undefined): Map<string, string> => {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      map.set(name, decodeURIComponent(value));
    } catch {
      // некорректная кодировка cookie — игнорируем
    }
  }
  return map;
};

const TOUCH_INTERVAL_MS = 60_000;

// Восстанавливает сессию из cookie. Отсутствие или недействительность сессии здесь не ошибка:
// обработчик решает сам, нужна ли аутентификация.
export const sessionMiddleware =
  (config: IAppConfig, pool: Pool, clock: () => Date) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = parseCookies(req.header('cookie')).get(SESSION_COOKIE);
    if (!token || token.length > 200) return next();
    const now = clock();
    const session = await findActiveSession(pool, token, now, config.sessionIdleMinutes);
    if (!session) return next();
    const state = stateOf(req);
    const ctx = await loadAccessContext(pool, session.user_id, state.requestId);
    if (!ctx) return next();
    if (now.getTime() - session.last_seen_at.getTime() > TOUCH_INTERVAL_MS) await touchSession(pool, session.id, now);
    setState(req, { ...state, auth: { sessionId: session.id, csrfHash: session.csrf_hash, ctx } });
    next();
  };

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Изменяющие запросы: Origin из списка разрешённых; для сессии — CSRF-токен,
// связанный с ней (в сессии хранится его хэш; значение — в читаемой cookie и заголовке).
// Отказ пишется в журнал (A25).
export const csrfGuard =
  (config: IAppConfig, pool: Pool) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!MUTATING.has(req.method)) return next();
    const origin = req.header('origin');
    let err: HttpError | null = null;
    if (!origin || !config.allowedOrigins.includes(origin)) {
      err = new HttpError(403, 'FORBIDDEN', 'запрос с неразрешённого Origin', {}, { details: { check: 'origin', origin: origin ?? null } });
    } else {
      const auth = stateOf(req).auth;
      const header = req.header(CSRF_HEADER);
      if (auth && !(typeof header === 'string' && header.length <= 200 && timingSafeEqual(sha256(header), auth.csrfHash))) {
        err = new HttpError(403, 'FORBIDDEN', 'CSRF-токен отсутствует или неверен', {}, { details: { check: 'csrf' } });
      }
    }
    if (!err) return next();
    await auditFailure(pool, req, 'http.request', 'request', err);
    throw err;
  };

export const cookieOptions = (config: IAppConfig, httpOnly: boolean) => ({
  httpOnly,
  secure: config.tls !== null,
  sameSite: 'strict' as const,
  path: '/',
  maxAge: config.sessionAbsoluteHours * 3600_000,
});
