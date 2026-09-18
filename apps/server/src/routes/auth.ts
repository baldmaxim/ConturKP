// Вход, выход, текущий пользователь, смена своего пароля (ADR-006 §11–12).
// Открытой регистрации нет: пользователей создаёт администратор, первого — bootstrap.
import { randomBytes } from 'node:crypto';
import type { IAppConfig } from '@kontur/config';
import { ChangePasswordRequest, LoginRequest, type IMe } from '@kontur/contracts';
import { burnPasswordCheck, globalCapabilities, hashPassword, verifyPassword } from '@kontur/core';
import {
  findCredential,
  getPasswordHash,
  loadAccessContext,
  insertSession,
  revokeSession,
  revokeUserSessions,
  updateUser,
  withTransaction,
  writeAudit,
  type IAccessContext,
  type Pool,
} from '@kontur/db';
import { Router, type Request, type Response } from 'express';
import { command, parseBody, query } from '../http/command.ts';
import { requireAuth, requestIdOf } from '../http/context.ts';
import { HttpError } from '../http/errors.ts';
import { cookieOptions, CSRF_COOKIE, SESSION_COOKIE } from '../http/security.ts';
import { LoginLimiter } from './loginLimiter.ts';

const toMe = (ctx: IAccessContext): IMe => ({
  id: ctx.principal.userId,
  login: ctx.principal.login,
  displayName: ctx.principal.displayName,
  roles: [...ctx.roles].sort(),
  capabilities: globalCapabilities(ctx.roles),
  memberships: [...ctx.memberships.entries()]
    .filter(([, role]) => ctx.roles.has(role))
    .map(([tenderId, memberRole]) => ({ tenderId, memberRole })),
});

export const authRouter = (config: IAppConfig, pool: Pool, clock: () => Date): Router => {
  const router = Router();
  const limiter = new LoginLimiter(clock);

  router.post('/auth/login', async (req: Request, res: Response) => {
    const requestId = requestIdOf(req);
    const ip = req.socket.remoteAddress ?? 'unknown';
    const body = LoginRequest.safeParse(req.body ?? {});
    const login = body.success ? body.data.login : String((req.body as { login?: unknown })?.login ?? '').slice(0, 64);
    const deny = async (reason: string, err: HttpError): Promise<never> => {
      await writeAudit(pool, {
        actorUserId: null,
        principalKind: 'anonymous',
        action: 'auth.login',
        entityType: 'app_user',
        requestId,
        outcome: 'denied',
        details: { login, reason, ip },
      });
      throw err;
    };
    if (limiter.blocked(login, ip)) {
      await deny('rate_limited', new HttpError(429, 'RATE_LIMITED', 'Слишком много неудачных попыток, повторите позже'));
    }
    const invalid = new HttpError(401, 'UNAUTHENTICATED', 'Неверный логин или пароль');
    if (!body.success) {
      limiter.fail(login, ip);
      await deny('invalid_request', invalid);
      return;
    }
    const cred = await findCredential(pool, body.data.login);
    const ok = cred?.password_hash
      ? await verifyPassword(body.data.password, cred.password_hash)
      : (await burnPasswordCheck(body.data.password), false);
    if (!cred || !ok) {
      limiter.fail(login, ip);
      await deny('invalid_credentials', invalid);
      return;
    }
    limiter.succeed(login);
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const now = clock();
    const expiresAt = new Date(now.getTime() + config.sessionAbsoluteHours * 3600_000);
    await withTransaction(pool, async (client) => {
      const sessionId = await insertSession(client, { token, csrf, userId: cred.id, now, expiresAt });
      await writeAudit(client, {
        actorUserId: cred.id,
        principalKind: 'human',
        action: 'auth.login',
        entityType: 'session',
        entityId: sessionId,
        requestId,
        outcome: 'allowed',
        details: { ip },
      });
    });
    res.cookie(SESSION_COOKIE, token, cookieOptions(config, true));
    res.cookie(CSRF_COOKIE, csrf, cookieOptions(config, false));
    const ctx = await loadAccessContext(pool, cred.id, requestId);
    res.status(200).json(ctx ? toMe(ctx) : null);
  });

  router.post(
    '/auth/logout',
    command(pool, {
      action: 'auth.logout',
      entityType: 'session',
      run: async (client, _ctx, req) => {
        const { sessionId } = requireAuth(req);
        await revokeSession(client, sessionId, clock(), 'logout');
        return {
          status: 204,
          body: undefined,
          audit: [{ action: 'auth.logout', entityType: 'session', entityId: sessionId }],
          respond: (r) => {
            r.clearCookie(SESSION_COOKIE, { path: '/' });
            r.clearCookie(CSRF_COOKIE, { path: '/' });
          },
        };
      },
    }),
  );

  router.get(
    '/me',
    query(pool, 'me.read', 'app_user', async (ctx, _req, res) => {
      res.json(toMe(ctx));
    }),
  );

  router.post(
    '/me/password',
    command(pool, {
      action: 'me.password.change',
      entityType: 'app_user',
      run: async (client, ctx, req) => {
        const body = parseBody(ChangePasswordRequest, req.body);
        const current = await getPasswordHash(client, ctx.principal.userId);
        if (!current || !(await verifyPassword(body.currentPassword, current))) {
          throw new HttpError(403, 'FORBIDDEN', 'текущий пароль неверен', {}, { entityId: ctx.principal.userId });
        }
        await updateUser(client, ctx.principal.userId, { passwordHash: await hashPassword(body.newPassword) });
        await revokeUserSessions(client, ctx.principal.userId, clock(), 'password_changed', requireAuth(req).sessionId);
        return {
          status: 204,
          body: undefined,
          audit: [{ action: 'me.password.change', entityType: 'app_user', entityId: ctx.principal.userId }],
        };
      },
    }),
  );

  return router;
};
