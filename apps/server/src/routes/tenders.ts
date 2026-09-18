// Тендеры, участники и журнал тендера (portal-api §2.2). Чужой тендер — 404 (ADR-006 §7).
import { CreateTenderRequest, PatchTenderRequest, PutMemberRequest, AuditQuery } from '@kontur/contracts';
import { formatEtag, globalCapabilities, tenderCapabilities, type TenderCapability } from '@kontur/core';
import {
  activeMembership,
  bumpTenderVersion,
  countActiveEngineers,
  getTender,
  getUser,
  insertMember,
  insertTender,
  listMembers,
  listTenderAudit,
  listTenders,
  removeMember,
  updateTender,
  type IAccessContext,
  type ITenderRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { toAuditEvent, toMember, toTender } from '../mappers.ts';

export const loadTender = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<ITenderRow> => {
  const t = await getTender(db, ctx, id, lock);
  if (!t) throw notFound({ entityType: 'tender', entityId: id });
  return t;
};

export const requireTenderCap = (ctx: IAccessContext, t: ITenderRow, cap: TenderCapability): void => {
  if (!tenderCapabilities(ctx.roles, t.member_role).includes(cap)) {
    throw forbidden(cap, { entityType: 'tender', entityId: t.id, tenderId: t.id });
  }
};

const changes = (before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> => {
  const diff: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) diff[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return diff;
};

const membersBody = async (db: Queryable, ctx: IAccessContext, tenderId: string) => {
  const t = await loadTender(db, ctx, tenderId);
  const items = await listMembers(db, ctx, tenderId);
  return { body: { items: items.map(toMember), tenderRowVersion: t.row_version }, etag: formatEtag(t.id, t.row_version) };
};

export const tendersRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/tenders',
    query(pool, 'tender.list', 'tender', async (ctx, _req, res) => {
      const rows = await listTenders(pool, ctx);
      res.json({ items: rows.map((t) => toTender(ctx, t)) });
    }),
  );

  router.post(
    '/tenders',
    command(pool, {
      action: 'tender.create',
      entityType: 'tender',
      idempotent: true,
      run: async (client, ctx, req) => {
        if (!globalCapabilities(ctx.roles).includes('admin.tender')) throw forbidden('admin.tender', { entityType: 'tender' });
        const body = parseBody(CreateTenderRequest, req.body);
        const id = await insertTender(client, ctx, {
          code: body.code,
          title: body.title,
          customerName: body.customerName ?? null,
          objectName: body.objectName ?? null,
        });
        const t = await loadTender(client, ctx, id);
        return {
          status: 201,
          body: toTender(ctx, t),
          etag: formatEtag(t.id, t.row_version),
          audit: [{ action: 'tender.create', entityType: 'tender', entityId: id, tenderId: id, details: { code: t.code } }],
        };
      },
    }),
  );

  router.get(
    '/tenders/:id',
    query(pool, 'tender.read', 'tender', async (ctx, req, res) => {
      const t = await loadTender(pool, ctx, uuidParam(req, 'id', 'tender'));
      res.setHeader('ETag', formatEtag(t.id, t.row_version));
      res.json(toTender(ctx, t));
    }),
  );

  router.patch(
    '/tenders/:id',
    command(pool, {
      action: 'tender.update',
      entityType: 'tender',
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'tender');
        const t = await loadTender(client, ctx, id, true);
        requireTenderCap(ctx, t, 'admin.tender');
        const expected = requireIfMatch(req, id);
        if (expected !== t.row_version) throw versionConflict(toTender(ctx, t));
        const body = parseBody(PatchTenderRequest, req.body);
        await updateTender(client, ctx, id, body);
        const after = await loadTender(client, ctx, id);
        const diff = changes(
          { title: t.title, customerName: t.customer_name, objectName: t.object_name, status: t.status },
          { title: after.title, customerName: after.customer_name, objectName: after.object_name, status: after.status },
        );
        return {
          status: 200,
          body: toTender(ctx, after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'tender.update', entityType: 'tender', entityId: id, tenderId: id, details: { changes: diff } }],
        };
      },
    }),
  );

  router.get(
    '/tenders/:id/members',
    query(pool, 'tender.members.read', 'tender', async (ctx, req, res) => {
      const { body, etag } = await membersBody(pool, ctx, uuidParam(req, 'id', 'tender'));
      res.setHeader('ETag', etag);
      res.json(body);
    }),
  );

  router.put(
    '/tenders/:id/members/:userId',
    command(pool, {
      action: 'tender.member.assign',
      entityType: 'tender_member',
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'tender');
        const userId = uuidParam(req, 'userId', 'app_user');
        const t = await loadTender(client, ctx, id, true);
        requireTenderCap(ctx, t, 'admin.tender');
        if (requireIfMatch(req, id) !== t.row_version) throw versionConflict(toTender(ctx, t));
        const { memberRole } = parseBody(PutMemberRequest, req.body);
        const user = await getUser(client, userId);
        if (!user) throw notFound({ entityType: 'app_user', entityId: userId, tenderId: id });
        if (user.status !== 'active' || !user.roles.includes(memberRole)) {
          throw new HttpError(409, 'STATE_CONFLICT', `у пользователя нет действующей роли ${memberRole}`, {}, { tenderId: id, entityId: userId });
        }
        const current = await activeMembership(client, id, userId);
        if (current?.member_role !== memberRole) {
          if (memberRole === 'engineer' && (await countActiveEngineers(client, id)) >= 2) {
            throw new HttpError(409, 'STATE_CONFLICT', 'на тендере уже два инженера', {}, { tenderId: id, entityId: userId });
          }
          if (current) await removeMember(client, ctx, current.id);
          await insertMember(client, ctx, id, userId, memberRole);
          await bumpTenderVersion(client, id);
        }
        const { body, etag } = await membersBody(client, ctx, id);
        return {
          status: 200,
          body,
          etag,
          audit:
            current?.member_role === memberRole
              ? []
              : [
                  {
                    action: 'tender.member.assign',
                    entityType: 'app_user',
                    entityId: userId,
                    tenderId: id,
                    details: { memberRole, previousRole: current?.member_role ?? null },
                  },
                ],
        };
      },
    }),
  );

  router.delete(
    '/tenders/:id/members/:userId',
    command(pool, {
      action: 'tender.member.remove',
      entityType: 'tender_member',
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'tender');
        const userId = uuidParam(req, 'userId', 'app_user');
        const t = await loadTender(client, ctx, id, true);
        requireTenderCap(ctx, t, 'admin.tender');
        if (requireIfMatch(req, id) !== t.row_version) throw versionConflict(toTender(ctx, t));
        const current = await activeMembership(client, id, userId);
        if (!current) throw notFound({ entityType: 'app_user', entityId: userId, tenderId: id });
        await removeMember(client, ctx, current.id);
        await bumpTenderVersion(client, id);
        const { body, etag } = await membersBody(client, ctx, id);
        return {
          status: 200,
          body,
          etag,
          audit: [
            { action: 'tender.member.remove', entityType: 'app_user', entityId: userId, tenderId: id, details: { memberRole: current.member_role } },
          ],
        };
      },
    }),
  );

  router.get(
    '/tenders/:id/audit-events',
    query(pool, 'tender.audit.read', 'tender', async (ctx, req, res) => {
      const t = await loadTender(pool, ctx, uuidParam(req, 'id', 'tender'));
      requireTenderCap(ctx, t, 'audit.read');
      const q = parseBody(AuditQuery, req.query);
      const rows = await listTenderAudit(pool, ctx, t.id, q.cursor ? Number(q.cursor) : null, q.limit + 1);
      const page = rows.slice(0, q.limit);
      const hasMore = rows.length > q.limit;
      res.json({ items: page.map(toAuditEvent), hasMore, nextCursor: hasMore ? String(page.at(-1)?.seq) : null });
    }),
  );

  return router;
};
