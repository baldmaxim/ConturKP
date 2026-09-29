// Договор и строки доступа к нему (D-017, D-022, D-023; portal-api §2.6). Невидимый договор — 404,
// видимый без нужной возможности — 403. Создатель получает доступ к созданному договору (OD-2);
// остальные выдачи ведёт администратор договоров (admin.contract), содержимого это право не открывает.
import { ContractStatusRequest, CreateContractRequest, PatchContractRequest, PutContractAccessRequest } from '@kontur/contracts';
import { CREATOR_CAPABILITIES, formatEtag, hasContentRole, type ContractCapability, type Role } from '@kontur/core';
import {
  activeGrantsOf,
  bumpContractVersion,
  canCreateContract,
  contractCaps,
  getContract,
  getUser,
  insertContract,
  insertGrant,
  isContractAdmin,
  listContractGrants,
  listContracts,
  listCreatorGrants,
  revokeGrant,
  setContractStatus,
  updateContract,
  type IAccessContext,
  type IContractRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import { Router } from 'express';
import { toContract, toGrant } from '../contractMappers.ts';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { requireContractCap } from './contractScope.ts';

export const loadContract = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IContractRow> => {
  const c = await getContract(db, ctx, id, lock);
  if (!c) throw notFound({ entityType: 'contract', entityId: id });
  return c;
};

const view = (ctx: IAccessContext, c: IContractRow) => toContract(c, contractCaps(ctx, c.id));

const requireContractAdmin = (ctx: IAccessContext, entityId: string | null = null): void => {
  if (!isContractAdmin(ctx)) throw forbidden('admin.contract', { entityType: 'contract', entityId });
};

// Выдача действует только при роли инженера или руководителя: без неё строка ничего бы не дала,
// поэтому администратор получает понятный отказ, а не молчаливую бездействующую выдачу.
const requireGrantee = async (db: Queryable, userId: string, target: { entityType: string; entityId: string | null }) => {
  const user = await getUser(db, userId);
  if (!user) throw notFound({ entityType: 'app_user', entityId: userId });
  if (user.status !== 'active' || !hasContentRole(new Set(user.roles as Role[]))) {
    throw new HttpError(409, 'STATE_CONFLICT', 'выдача по договору действует только у активного инженера или руководителя', {}, { ...target, details: { userId } });
  }
  return user;
};

const auditTarget = (c: IContractRow) => ({ entityType: 'contract', entityId: c.id, details: { contractId: c.id } });

export const contractsRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/contracts',
    query(pool, 'contract.list', 'contract', async (ctx, _req, res) => {
      res.json({ items: (await listContracts(pool, ctx)).map((c) => view(ctx, c)), canCreate: canCreateContract(ctx), isContractAdmin: isContractAdmin(ctx) });
    }),
  );

  router.post(
    '/contracts',
    command(pool, {
      action: 'contract.create',
      entityType: 'contract',
      idempotent: true,
      authorize: async (_client, ctx) => {
        if (!canCreateContract(ctx)) throw forbidden('contract.create', { entityType: 'contract' });
      },
      run: async (client, ctx, req) => {
        const body = parseBody(CreateContractRequest, req.body);
        const id = await insertContract(
          client,
          ctx,
          { number: body.number, title: body.title, counterparty: body.counterparty ?? null, signedOn: body.signedOn ?? null },
          CREATOR_CAPABILITIES,
        );
        // Контекст запроса собран до вставки: права создателя в нём ещё не видны, поэтому
        // ответ строится по тем же возможностям, что записаны строками source = creator.
        const c = (await getContract(client, { ...ctx, contractGrants: new Map([[id, new Set<ContractCapability>(CREATOR_CAPABILITIES)]]) }, id))!;
        return {
          status: 201,
          body: toContract(c, CREATOR_CAPABILITIES),
          etag: formatEtag(id, c.row_version),
          audit: [
            {
              action: 'contract.create',
              entityType: 'contract',
              entityId: id,
              details: { contractId: id, number: c.number, creatorCapabilities: [...CREATOR_CAPABILITIES] },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/contracts/:id',
    query(pool, 'contract.read', 'contract', async (ctx, req, res) => {
      const c = await loadContract(pool, ctx, uuidParam(req, 'id', 'contract'));
      res.setHeader('ETag', formatEtag(c.id, c.row_version));
      res.json(view(ctx, c));
    }),
  );

  router.patch(
    '/contracts/:id',
    command(pool, {
      action: 'contract.update',
      entityType: 'contract',
      authorize: async (client, ctx, req) => {
        const c = await loadContract(client, ctx, uuidParam(req, 'id', 'contract'));
        requireContractCap(ctx, c.id, 'contract.manage', auditTarget(c));
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'contract');
        const c = await loadContract(client, ctx, id, true);
        requireContractCap(ctx, id, 'contract.manage', auditTarget(c));
        if (requireIfMatch(req, id) !== c.row_version) throw versionConflict(view(ctx, c));
        const body = parseBody(PatchContractRequest, req.body);
        // Контрагент и дата — содержательные поля: их меняет только тот, кто их видит (OD-2).
        if (body.counterparty !== undefined || body.signedOn !== undefined) requireContractCap(ctx, id, 'contract.read', auditTarget(c));
        await updateContract(client, id, body);
        const after = await loadContract(client, ctx, id);
        // События договора видит журнал администратора (без тендера): содержательные поля — только признаком
        // изменения, без значений (D-022 OD-2: администратор без contract.read содержимого не видит).
        const changes: Record<string, unknown> = {};
        for (const [k, before, now, content] of [
          ['number', c.number, after.number, false],
          ['title', c.title, after.title, false],
          ['counterparty', c.counterparty, after.counterparty, true],
          ['signedOn', c.signed_on, after.signed_on, true],
        ] as const) {
          if (before !== now) changes[k] = content ? { changed: true } : { from: before, to: now };
        }
        return {
          status: 200,
          body: view(ctx, after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'contract.update', entityType: 'contract', entityId: id, details: { contractId: id, changes } }],
        };
      },
    }),
  );

  // Архив и возврат (OD-5): физического удаления нет; документы, редакции и доказательства остаются.
  for (const [path, action, from, to] of [
    ['archive', 'contract.archive', 'active', 'archived'],
    ['restore', 'contract.restore', 'archived', 'active'],
  ] as const) {
    router.post(
      `/contracts/:id/${path}`,
      command(pool, {
        action,
        entityType: 'contract',
        authorize: async (client, ctx, req) => {
          const c = await loadContract(client, ctx, uuidParam(req, 'id', 'contract'));
          requireContractCap(ctx, c.id, 'contract.manage', auditTarget(c));
        },
        run: async (client, ctx, req) => {
          const id = uuidParam(req, 'id', 'contract');
          parseBody(ContractStatusRequest, req.body);
          const c = await loadContract(client, ctx, id, true);
          requireContractCap(ctx, id, 'contract.manage', auditTarget(c));
          if (requireIfMatch(req, id) !== c.row_version) throw versionConflict(view(ctx, c));
          if (c.status !== from) throw new HttpError(409, 'STATE_CONFLICT', to === 'archived' ? 'договор уже в архиве' : 'договор не в архиве', { current: view(ctx, c) }, auditTarget(c));
          await setContractStatus(client, ctx, id, to);
          const after = await loadContract(client, ctx, id);
          return {
            status: 200,
            body: view(ctx, after),
            etag: formatEtag(id, after.row_version),
            audit: [{ action, entityType: 'contract', entityId: id, details: { contractId: id } }],
          };
        },
      }),
    );
  }

  // ---------------------------------------------------------------- Строки доступа (admin.contract)

  router.get(
    '/contracts/:id/access',
    query(pool, 'contract.access.read', 'contract', async (ctx, req, res) => {
      const c = await loadContract(pool, ctx, uuidParam(req, 'id', 'contract'));
      requireContractAdmin(ctx, c.id);
      res.setHeader('ETag', formatEtag(c.id, c.row_version));
      res.json({ items: (await listContractGrants(pool, c.id)).map(toGrant), contractRowVersion: c.row_version });
    }),
  );

  router.put(
    '/contracts/:id/access/:userId',
    command(pool, {
      action: 'contract.access.set',
      entityType: 'contract_access',
      authorize: async (client, ctx, req) => {
        const c = await loadContract(client, ctx, uuidParam(req, 'id', 'contract'));
        requireContractAdmin(ctx, c.id);
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'contract');
        const userId = uuidParam(req, 'userId', 'app_user');
        const c = await loadContract(client, ctx, id, true);
        requireContractAdmin(ctx, id);
        if (requireIfMatch(req, id) !== c.row_version) throw versionConflict(view(ctx, c));
        const { capabilities } = parseBody(PutContractAccessRequest, req.body);
        const wanted = new Set(capabilities);
        const current = await activeGrantsOf(client, id, userId);
        const revoked = current.filter((g) => !wanted.has(g.capability as ContractCapability));
        const granted = [...wanted].filter((cap) => !current.some((g) => g.capability === cap));
        if (granted.length > 0) await requireGrantee(client, userId, { entityType: 'contract', entityId: id });
        for (const g of revoked) await revokeGrant(client, ctx, g.id);
        for (const cap of granted) await insertGrant(client, ctx, { contractId: id, userId, capability: cap });
        if (revoked.length + granted.length > 0) await bumpContractVersion(client, id);
        const after = await loadContract(client, ctx, id);
        return {
          status: 200,
          body: { items: (await listContractGrants(client, id)).map(toGrant), contractRowVersion: after.row_version },
          etag: formatEtag(id, after.row_version),
          audit: [
            ...granted.map((capability) => ({ action: 'contract.access.grant', entityType: 'app_user', entityId: userId, details: { contractId: id, capability } })),
            ...revoked.map((g) => ({ action: 'contract.access.revoke', entityType: 'app_user', entityId: userId, details: { contractId: id, capability: g.capability } })),
          ],
        };
      },
    }),
  );

  // Глобальная выдача contract.create (D-022 OD-2): создавать договоры может только тот, кому её дали.
  router.get(
    '/admin/contract-creators',
    query(pool, 'contract.creator.read', 'contract_access', async (ctx, _req, res) => {
      requireContractAdmin(ctx);
      res.json({ items: (await listCreatorGrants(pool)).map(toGrant) });
    }),
  );

  for (const [method, action] of [
    ['put', 'contract.creator.grant'],
    ['delete', 'contract.creator.revoke'],
  ] as const) {
    router[method](
      '/admin/contract-creators/:userId',
      command(pool, {
        action,
        entityType: 'contract_access',
        authorize: async (_client, ctx) => requireContractAdmin(ctx),
        run: async (client, ctx, req) => {
          const userId = uuidParam(req, 'userId', 'app_user');
          requireContractAdmin(ctx);
          // Строка пользователя сериализует выдачу и отзыв одного пользователя.
          const locked = await client.query('SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE', [userId]);
          if (locked.rowCount === 0) throw notFound({ entityType: 'app_user', entityId: userId });
          const current = await activeGrantsOf(client, null, userId);
          let changed = false;
          if (method === 'put' && current.length === 0) {
            await requireGrantee(client, userId, { entityType: 'app_user', entityId: userId });
            await insertGrant(client, ctx, { contractId: null, userId, capability: 'contract.create' });
            changed = true;
          }
          if (method === 'delete') {
            for (const g of current) await revokeGrant(client, ctx, g.id);
            changed = current.length > 0;
          }
          return {
            status: 200,
            body: { items: (await listCreatorGrants(client)).map(toGrant) },
            audit: changed ? [{ action, entityType: 'app_user', entityId: userId, details: { capability: 'contract.create' } }] : [],
          };
        },
      }),
    );
  }

  return router;
};
