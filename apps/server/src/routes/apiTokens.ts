// Этап 16 (D-037; проект §3): персональные токены чат-клиентов. Выпуск, список и отзыв — только человек с сессией:
// маршруты живут под /api/v1, куда токен не принимается. Значение токена возвращается один раз, в журнал и в запись
// идемпотентности не попадает — поэтому у выпуска нет ключа идемпотентности.
import { API_TOKEN_MAX_ACTIVE, IssueApiTokenRequest } from '@kontur/contracts';
import { globalCapabilities, hasContentRole } from '@kontur/core';
import { activeApiTokenCount, getApiToken, issueApiToken, listApiTokens, revokeApiToken, type ApiTokenScope, type IAccessContext, type IApiTokenRow, type Pool } from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';

const stateOf = (t: IApiTokenRow, now: Date): 'active' | 'expired' | 'revoked' => (t.revoked_at ? 'revoked' : t.expires_at.getTime() <= now.getTime() ? 'expired' : 'active');

const tokenView = (t: IApiTokenRow, now: Date) => ({
  id: t.id,
  name: t.name,
  clientKind: t.client_kind,
  prefix: t.token_prefix,
  scopes: t.scopes,
  lifetimeDays: t.lifetime_days,
  state: stateOf(t, now),
  createdAt: t.created_at.toISOString(),
  expiresAt: t.expires_at.toISOString(),
  lastUsedAt: t.last_used_at ? t.last_used_at.toISOString() : null,
  revokedAt: t.revoked_at ? t.revoked_at.toISOString() : null,
});

// Чат-клиент работает с содержимым тендеров: токен выпускает инженер или руководитель.
const requireContentRole = (ctx: IAccessContext): void => {
  if (!hasContentRole(ctx.roles)) throw forbidden('mcp.token', { entityType: 'api_token' });
};

export const apiTokensRouter = (pool: Pool, clock: () => Date = () => new Date()): Router => {
  const router = Router();

  router.get(
    '/me/api-tokens',
    query(pool, 'mcp.token.list', 'api_token', async (ctx, _req, res) => {
      const now = clock();
      const items = (await listApiTokens(pool, ctx.principal.userId)).map((t) => tokenView(t, now));
      res.json({ items, canIssue: hasContentRole(ctx.roles), maxActive: API_TOKEN_MAX_ACTIVE, active: items.filter((t) => t.state === 'active').length });
    }),
  );

  router.post(
    '/me/api-tokens',
    command(pool, {
      action: 'mcp.token.issue',
      entityType: 'api_token',
      authorize: async (_client, ctx) => requireContentRole(ctx),
      run: async (client, ctx, req) => {
        requireContentRole(ctx);
        const body = parseBody(IssueApiTokenRequest, req.body);
        if ((await activeApiTokenCount(client, ctx.principal.userId)) >= API_TOKEN_MAX_ACTIVE) {
          throw new HttpError(409, 'STATE_CONFLICT', `действующих токенов уже ${API_TOKEN_MAX_ACTIVE}: отзовите ненужный`, { current: { reason: 'token_limit', max: API_TOKEN_MAX_ACTIVE } }, { entityType: 'api_token' });
        }
        const scopes: ApiTokenScope[] = body.propose ? ['read', 'propose'] : ['read'];
        const { row, token } = await issueApiToken(client, { userId: ctx.principal.userId, name: body.name, clientKind: body.clientKind, scopes, lifetimeDays: body.lifetimeDays });
        return {
          status: 201,
          // Значение токена — только в этом ответе; повторно его получить нельзя.
          body: { ...tokenView(row, clock()), token },
          audit: [{ action: 'mcp.token.issue', entityType: 'api_token', entityId: row.id, details: { clientKind: row.client_kind, scopes: row.scopes, lifetimeDays: row.lifetime_days } }],
        };
      },
    }),
  );

  // Отзывает владелец; администратор отзывает чужой токен, не видя ни значения, ни содержимого вызовов.
  const loadToken = async (db: Parameters<typeof getApiToken>[0], ctx: IAccessContext, id: string, lock = false): Promise<IApiTokenRow> => {
    const t = await getApiToken(db, id, lock);
    const admin = globalCapabilities(ctx.roles).includes('admin.users');
    if (!t || (t.user_id !== ctx.principal.userId && !admin)) throw notFound({ entityType: 'api_token', entityId: id });
    return t;
  };

  router.delete(
    '/api-tokens/:id',
    command(pool, {
      action: 'mcp.token.revoke',
      entityType: 'api_token',
      authorize: async (client, ctx, req) => void (await loadToken(client, ctx, uuidParam(req, 'id', 'api_token'))),
      run: async (client, ctx, req) => {
        const t = await loadToken(client, ctx, uuidParam(req, 'id', 'api_token'), true);
        // Повторный отзыв ничего не меняет и отвечает текущим состоянием.
        if (!t.revoked_at) await revokeApiToken(client, t.id, ctx.principal.userId);
        const fresh = (await getApiToken(client, t.id))!;
        return {
          status: 200,
          body: tokenView(fresh, clock()),
          audit: t.revoked_at ? [] : [{ action: 'mcp.token.revoke', entityType: 'api_token', entityId: t.id, details: { ownerUserId: t.user_id, byOwner: t.user_id === ctx.principal.userId } }],
        };
      },
    }),
  );

  return router;
};
