// Администрирование пользователей и журнал вне тендеров (ADR-006: admin.*).
import { AuditQuery, CreateUserRequest, PatchUserRequest, ResetPasswordRequest } from '@kontur/contracts';
import { formatEtag, globalCapabilities, hashPassword, type GlobalCapability } from '@kontur/core';
import {
  countActiveAdmins,
  getUser,
  insertUser,
  lockAdminSet,
  listGlobalAudit,
  listUsers,
  revokeUserSessions,
  setRoles,
  updateUser,
  type IAccessContext,
  type IUserRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { toAuditEvent, toUser } from '../mappers.ts';

const requireGlobal = (ctx: IAccessContext, cap: GlobalCapability, entityType: string, entityId: string | null = null): void => {
  if (!globalCapabilities(ctx.roles).includes(cap)) throw forbidden(cap, { entityType, entityId });
};

const loadUser = async (db: Queryable, id: string, lock = false): Promise<IUserRow> => {
  const u = await getUser(db, id, lock);
  if (!u) throw notFound({ entityType: 'app_user', entityId: id });
  return u;
};

export const adminRouter = (pool: Pool, clock: () => Date): Router => {
  const router = Router();

  router.get(
    '/admin/users',
    query(pool, 'admin.users.list', 'app_user', async (ctx, _req, res) => {
      requireGlobal(ctx, 'admin.users', 'app_user');
      res.json({ items: (await listUsers(pool, ctx)).map(toUser) });
    }),
  );

  router.post(
    '/admin/users',
    command(pool, {
      action: 'admin.user.create',
      entityType: 'app_user',
      idempotent: true,
      authorize: async (_client, ctx) => requireGlobal(ctx, 'admin.users', 'app_user'),
      run: async (client, ctx, req) => {
        requireGlobal(ctx, 'admin.users', 'app_user');
        const body = parseBody(CreateUserRequest, req.body);
        const roles = [...new Set(body.roles)];
        const id = await insertUser(
          client,
          { login: body.login, displayName: body.displayName, passwordHash: await hashPassword(body.password), roles },
          ctx.principal.userId,
        );
        const u = await loadUser(client, id);
        return {
          status: 201,
          body: toUser(u),
          etag: formatEtag(id, u.row_version),
          audit: [{ action: 'admin.user.create', entityType: 'app_user', entityId: id, details: { login: u.login, roles } }],
        };
      },
    }),
  );

  router.patch(
    '/admin/users/:id',
    command(pool, {
      action: 'admin.user.update',
      entityType: 'app_user',
      authorize: async (_client, ctx, req) => requireGlobal(ctx, 'admin.users', 'app_user', uuidParam(req, 'id', 'app_user')),
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'app_user');
        requireGlobal(ctx, 'admin.users', 'app_user', id);
        // Блокировка набора администраторов — до блокировки строки пользователя (единый порядок).
        await lockAdminSet(client);
        const u = await loadUser(client, id, true);
        if (requireIfMatch(req, id) !== u.row_version) throw versionConflict(toUser(u));
        const body = parseBody(PatchUserRequest, req.body);
        const roles = body.roles ? [...new Set(body.roles)] : u.roles;
        const losesAdmin = u.roles.includes('admin') && u.status === 'active' && (!roles.includes('admin') || body.status === 'disabled');
        if (losesAdmin && (await countActiveAdmins(client)) <= 1) {
          throw new HttpError(409, 'STATE_CONFLICT', 'нельзя снять последнего активного администратора', {}, { entityId: id });
        }
        if (body.roles) await setRoles(client, id, roles, ctx.principal.userId);
        await updateUser(client, id, { displayName: body.displayName, status: body.status });
        if (body.status === 'disabled' && u.status !== 'disabled') await revokeUserSessions(client, id, clock(), 'user_disabled');
        const after = await loadUser(client, id);
        return {
          status: 200,
          body: toUser(after),
          etag: formatEtag(id, after.row_version),
          audit: [
            {
              action: 'admin.user.update',
              entityType: 'app_user',
              entityId: id,
              details: {
                displayName: body.displayName !== undefined && body.displayName !== u.display_name ? { from: u.display_name, to: after.display_name } : undefined,
                status: after.status !== u.status ? { from: u.status, to: after.status } : undefined,
                roles: body.roles ? { from: u.roles, to: after.roles } : undefined,
              },
            },
          ],
        };
      },
    }),
  );

  router.post(
    '/admin/users/:id/password',
    command(pool, {
      action: 'admin.user.password_reset',
      entityType: 'app_user',
      authorize: async (_client, ctx, req) => requireGlobal(ctx, 'admin.users', 'app_user', uuidParam(req, 'id', 'app_user')),
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'app_user');
        requireGlobal(ctx, 'admin.users', 'app_user', id);
        const u = await loadUser(client, id, true);
        if (requireIfMatch(req, id) !== u.row_version) throw versionConflict(toUser(u));
        const body = parseBody(ResetPasswordRequest, req.body);
        await updateUser(client, id, { passwordHash: await hashPassword(body.password) });
        await revokeUserSessions(client, id, clock(), 'password_changed');
        const after = await loadUser(client, id);
        return {
          status: 200,
          body: toUser(after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'admin.user.password_reset', entityType: 'app_user', entityId: id }],
        };
      },
    }),
  );

  router.get(
    '/admin/audit-events',
    query(pool, 'admin.audit.read', 'audit_event', async (ctx, req, res) => {
      requireGlobal(ctx, 'admin.audit', 'audit_event');
      const q = parseBody(AuditQuery, req.query);
      const rows = await listGlobalAudit(pool, ctx, q.cursor ? Number(q.cursor) : null, q.limit + 1);
      const page = rows.slice(0, q.limit);
      const hasMore = rows.length > q.limit;
      res.json({ items: page.map(toAuditEvent), hasMore, nextCursor: hasMore ? String(page.at(-1)?.seq) : null });
    }),
  );

  return router;
};
