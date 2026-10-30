// Закрытый расчёт решением руководителя (этап 18; D-044, Q-01; проект §15). X-01 (закрытие у источника) остаётся
// BLOCKED_EXTERNAL: решение заменяет его для боевого выпуска, но закрытием в TenderHub не является. Решение — на одну
// ревизию `provisional`, отзывное; решает и отзывает руководитель тендера (calculation.close). Сериализация с
// согласованием и выпуском — блокировка этапа (lockTenderStages), второй слой — advisory-блокировка в охранниках 0044.
import { CalculationClosureRequest } from '@kontur/contracts';
import {
  activeClosureDecision,
  getCalculationRevision,
  listClosureDecisions,
  lockTenderStages,
  recordClosureDecision,
  revokeClosureDecision,
  type IAccessContext,
  type IClosureDecisionRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { conflict } from './reviewScope.ts';
import { hasTenderCap, requireTenderCapById } from './scope.ts';

const decisionView = (d: IClosureDecisionRow) => ({
  id: d.id,
  decidedBy: { id: d.decided_by, name: d.decided_by_name },
  reason: d.reason,
  decidedAt: d.decided_at.toISOString(),
  revocation: d.revocation_id
    ? { id: d.revocation_id, revokedBy: { id: d.revoked_by, name: d.revoked_by_name }, reason: d.revocation_reason, revokedAt: d.revoked_at?.toISOString() ?? null }
    : null,
});

const loadRevision = async (db: Queryable, ctx: IAccessContext, id: string) => {
  const r = await getCalculationRevision(db, ctx, id);
  if (!r) throw notFound({ entityType: 'calculation_revision', entityId: id });
  requireTenderCapById(ctx, r.tender_id, 'tender.read', { entityType: 'calculation_revision', entityId: id });
  return r;
};

const stateOf = async (db: Queryable, ctx: IAccessContext, rev: { id: string; tender_id: string; kind: string }) => {
  const rows = await listClosureDecisions(db, rev.id);
  const active = activeClosureDecision(rows);
  const canManage = hasTenderCap(ctx, rev.tender_id, 'calculation.close');
  return {
    revisionId: rev.id,
    kind: rev.kind,
    closed: active !== null,
    active: active ? decisionView(active) : null,
    // Подсказка интерфейсу; решение всегда за сервером и охранниками БД.
    canDecide: canManage && rev.kind === 'provisional' && active === null,
    canRevoke: canManage && active !== null,
    history: rows.map(decisionView),
  };
};

export const calculationClosureRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/calculation-revisions/:id/closure',
    query(pool, 'calculation.closure.read', 'calculation_revision', async (ctx, req, res) => {
      res.json(await stateOf(pool, ctx, await loadRevision(pool, ctx, uuidParam(req, 'id', 'calculation_revision'))));
    }),
  );

  router.post(
    '/calculation-revisions/:id/closure',
    command(pool, {
      action: 'calculation.close',
      entityType: 'calculation_revision',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const rev = await loadRevision(client, ctx, uuidParam(req, 'id', 'calculation_revision'));
        requireTenderCapById(ctx, rev.tender_id, 'calculation.close', { entityType: 'calculation_revision', entityId: rev.id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'calculation_revision');
        const rev = await loadRevision(client, ctx, id);
        const body = parseBody(CalculationClosureRequest, req.body);
        const target = { tenderId: rev.tender_id, entityType: 'calculation_revision', entityId: id };
        // Первая доменная блокировка — этап: та же, что у согласования, выпуска и сборки кандидата.
        if ((await lockTenderStages(client, rev.tender_id, [rev.stage_id])).length === 0) throw new HttpError(409, 'STATE_CONFLICT', 'этап в архиве', {}, target);
        if (rev.kind !== 'provisional') throw conflict('решение принимается только по предварительной (provisional) ревизии', 'revision_not_provisional', target);
        if (activeClosureDecision(await listClosureDecisions(client, id))) throw conflict('у ревизии уже есть действующее решение', 'closure_already_active', target);
        const d = await recordClosureDecision(client, { tenderId: rev.tender_id, stageId: rev.stage_id, revisionId: id, userId: ctx.principal.userId, reason: body.reason });
        return {
          status: 201,
          body: await stateOf(client, ctx, rev),
          audit: [
            {
              action: 'calculation.close',
              entityType: 'calculation_revision',
              entityId: id,
              tenderId: rev.tender_id,
              details: { decisionId: d.id, stageId: rev.stage_id, reason: body.reason },
            },
          ],
        };
      },
    }),
  );

  router.post(
    '/calculation-revisions/:id/closure/revoke',
    command(pool, {
      action: 'calculation.close_revoke',
      entityType: 'calculation_revision',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const rev = await loadRevision(client, ctx, uuidParam(req, 'id', 'calculation_revision'));
        requireTenderCapById(ctx, rev.tender_id, 'calculation.close', { entityType: 'calculation_revision', entityId: rev.id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'calculation_revision');
        const rev = await loadRevision(client, ctx, id);
        const body = parseBody(CalculationClosureRequest, req.body);
        const target = { tenderId: rev.tender_id, entityType: 'calculation_revision', entityId: id };
        if ((await lockTenderStages(client, rev.tender_id, [rev.stage_id])).length === 0) throw new HttpError(409, 'STATE_CONFLICT', 'этап в архиве', {}, target);
        const active = activeClosureDecision(await listClosureDecisions(client, id));
        if (!active) throw conflict('у ревизии нет действующего решения', 'closure_not_active', target);
        const d = await revokeClosureDecision(client, { decisionId: active.id, userId: ctx.principal.userId, reason: body.reason });
        return {
          status: 200,
          body: await stateOf(client, ctx, rev),
          audit: [
            {
              action: 'calculation.close_revoke',
              entityType: 'calculation_revision',
              entityId: id,
              tenderId: rev.tender_id,
              details: { decisionId: d.id, stageId: rev.stage_id, reason: body.reason },
            },
          ],
        };
      },
    }),
  );

  return router;
};
