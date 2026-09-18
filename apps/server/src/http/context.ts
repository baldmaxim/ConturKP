// Данные запроса: request id и аутентификация, заполняются middleware.
import type { IAccessContext } from '@kontur/db';
import type { Request } from 'express';
import { HttpError } from './errors.ts';

export interface IAuthState {
  sessionId: string;
  csrfHash: Buffer;
  ctx: IAccessContext;
}

interface IRequestState {
  requestId: string;
  auth: IAuthState | null;
}

const states = new WeakMap<Request, IRequestState>();

export const setState = (req: Request, state: IRequestState): void => {
  states.set(req, state);
};

export const stateOf = (req: Request): IRequestState => states.get(req) ?? { requestId: 'unknown', auth: null };

export const requestIdOf = (req: Request): string => stateOf(req).requestId;

export const requireAuth = (req: Request): IAuthState => {
  const auth = stateOf(req).auth;
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Сессия отсутствует или истекла');
  return auth;
};

export const requireCtx = (req: Request): IAccessContext => requireAuth(req).ctx;
