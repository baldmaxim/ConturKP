// Граф фактов D-018 (D-028; portal-api §2.12): просмотр графа договора и тендера и решение человека по паре фактов.
// Решение — неизменяемое ребро графа; граф владельца пересчитывается в той же транзакции. Невидимый владелец — 404;
// видимый без нужной возможности — 403. Право решать: договор — contract.manage, тендер — fact.confirm.
import { FactDecisionRequest } from '@kontur/contracts';
import { contractCaps, evidenceFactOwner, getContract, insertFactDecision, ownerGraphView, recomputeOwnerGraph, type IAccessContext, type IFactOwner, type Pool, type Queryable } from '@kontur/db';
import { Router } from 'express';
import { factGraphView } from '../factMappers.ts';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { hasTenderCap } from './scope.ts';

// Владелец виден и читается: договор — contract.read, тендер — участник с fact.read.
const requireOwnerRead = async (db: Queryable, ctx: IAccessContext, owner: IFactOwner, target: { entityType: string; entityId: string }): Promise<void> => {
  if (owner.contractId) {
    if (!(await getContract(db, ctx, owner.contractId))) throw notFound(target);
    if (!contractCaps(ctx, owner.contractId).includes('contract.read')) throw forbidden('contract.read', { ...target, details: { contractId: owner.contractId } });
    return;
  }
  if (!hasTenderCap(ctx, owner.tenderId!, 'tender.read')) throw notFound(target);
  if (!hasTenderCap(ctx, owner.tenderId!, 'fact.read')) throw forbidden('fact.read', { ...target, tenderId: owner.tenderId! });
};

const canDecide = (ctx: IAccessContext, owner: IFactOwner): boolean =>
  owner.contractId ? contractCaps(ctx, owner.contractId).includes('contract.manage') : hasTenderCap(ctx, owner.tenderId!, 'fact.confirm');

const ownerRef = (owner: IFactOwner) => (owner.contractId ? { kind: 'contract' as const, id: owner.contractId } : { kind: 'tender' as const, id: owner.tenderId! });

export const factsRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/contracts/:id/fact-graph',
    query(pool, 'fact.graph.read', 'contract', async (ctx, req, res) => {
      const owner = { tenderId: null, contractId: uuidParam(req, 'id', 'contract') };
      await requireOwnerRead(pool, ctx, owner, { entityType: 'contract', entityId: owner.contractId });
      res.json(factGraphView(ownerRef(owner), await ownerGraphView(pool, owner), canDecide(ctx, owner)));
    }),
  );

  router.get(
    '/tenders/:id/fact-graph',
    query(pool, 'fact.graph.read', 'tender', async (ctx, req, res) => {
      const owner = { tenderId: uuidParam(req, 'id', 'tender'), contractId: null };
      await requireOwnerRead(pool, ctx, owner, { entityType: 'tender', entityId: owner.tenderId });
      res.json(factGraphView(ownerRef(owner), await ownerGraphView(pool, owner), canDecide(ctx, owner)));
    }),
  );

  router.post(
    '/evidence-facts/:id/decisions',
    command(pool, {
      action: 'fact.decision',
      entityType: 'evidence_fact',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'evidence_fact');
        const owner = await evidenceFactOwner(client, id);
        if (!owner) throw notFound({ entityType: 'evidence_fact', entityId: id });
        await requireOwnerRead(client, ctx, owner, { entityType: 'evidence_fact', entityId: id });
        if (!canDecide(ctx, owner)) throw forbidden(owner.contractId ? 'contract.manage' : 'fact.confirm', { entityType: 'evidence_fact', entityId: id, tenderId: owner.tenderId ?? undefined });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'evidence_fact');
        const body = parseBody(FactDecisionRequest, req.body);
        const owner = (await evidenceFactOwner(client, id))!;
        const other = await evidenceFactOwner(client, body.otherFactId);
        const target = { entityType: 'evidence_fact', entityId: id, tenderId: owner.tenderId ?? undefined };
        if (!other || other.tenderId !== owner.tenderId || other.contractId !== owner.contractId || body.otherFactId === id) {
          throw new HttpError(409, 'STATE_CONFLICT', 'решение — о двух разных фактах одного договора или тендера', { current: { reason: 'fact_pair_invalid' } }, target);
        }
        const decisionId = await insertFactDecision(client, { owner, factId: id, otherFactId: body.otherFactId, kind: body.kind, reason: body.reason, userId: ctx.principal.userId });
        const graph = await recomputeOwnerGraph(client, owner);
        return {
          status: 201,
          body: { decisionId, graph: factGraphView(ownerRef(owner), await ownerGraphView(client, owner), canDecide(ctx, owner)) },
          audit: [
            {
              action: 'fact.decision',
              entityType: 'fact_decision',
              entityId: decisionId,
              tenderId: owner.tenderId,
              details: { factId: id, otherFactId: body.otherFactId, kind: body.kind, contractId: owner.contractId, graphHash: graph.hash },
            },
          ],
        };
      },
    }),
  );

  return router;
};
