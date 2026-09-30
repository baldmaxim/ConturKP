// Снимок области доказательств (portal-api §2.3, state-machines §5.1, R01-01): неизменяемый
// состав единиц источника для исторического поиска, проверки и выпуска. Строится из замороженной
// ревизии набора этапа; одинаковый состав возвращает существующий снимок.
import { CreateEvidenceScopeRequest } from '@kontur/contracts';
import {
  createEvidenceScope,
  evidenceScopeItems,
  getEvidenceScope,
  getSetRevision,
  latestFrozenRevision,
  listEvidenceScopes,
  planEvidenceScope,
  readableContractIds,
  readableMailboxIds,
  type Pool,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { toEvidenceScope } from '../searchMappers.ts';
import { requireTenderCapById } from './scope.ts';
import { loadStage } from './stages.ts';

export const evidenceScopesRouter = (pool: Pool): Router => {
  const router = Router();

  router.post(
    '/stages/:id/evidence-scopes',
    command(pool, {
      action: 'evidence.scope.create',
      entityType: 'evidence_scope',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        requireTenderCapById(ctx, stage.tender_id, 'source.write', { entityType: 'tender_stage', entityId: stage.id });
      },
      run: async (client, ctx, req) => {
        const body = parseBody(CreateEvidenceScopeRequest, req.body);
        // Под блокировкой этапа (state-machines §5.1): состав и номер версии входов согласованы.
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'), true);
        const target = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        let rev = body.sourceSetRevisionId ? await getSetRevision(client, body.sourceSetRevisionId) : null;
        if (body.sourceSetRevisionId && (!rev || rev.stage_id !== stage.id)) throw notFound({ entityType: 'source_set_revision', entityId: body.sourceSetRevisionId });
        if (rev && rev.status !== 'frozen') throw new HttpError(409, 'STATE_CONFLICT', 'снимок строится только из замороженной ревизии набора', {}, target);
        const base = rev ? { id: rev.id, content_hash: rev.content_hash } : await latestFrozenRevision(client, stage.id);
        if (!base || !base.content_hash) {
          throw new HttpError(409, 'STATE_CONFLICT', 'у этапа нет замороженной ревизии набора источников', { current: { reason: 'no_frozen_source_set' } }, target);
        }
        const plan = await planEvidenceScope(client, { id: base.id, content_hash: base.content_hash }, { tenderId: stage.tender_id, stageId: stage.id });
        // Вложение письма, связь которого снята, снимок не пропустит (охранник единицы, D-025): явный отказ.
        if (plan.unlinkedAttachments.length > 0) {
          throw new HttpError(
            409,
            'STATE_CONFLICT',
            'в наборе есть вложения писем без действующей связи с тендером; исключите их из набора',
            { current: { reason: 'attachment_link_inactive', documentRevisionIds: plan.unlinkedAttachments } },
            target,
          );
        }
        const created = await createEvidenceScope(client, {
          stageId: stage.id,
          tenderId: stage.tender_id,
          sourceSetRevisionId: base.id,
          inputVersion: stage.input_version,
          contentHash: plan.contentHash,
          createdBy: ctx.principal.userId,
          units: plan.units,
        });
        const scope = (await getEvidenceScope(client, ctx, created.id))!;
        return {
          status: created.created ? 201 : 200,
          body: { ...toEvidenceScope(scope, await evidenceScopeItems(client, scope.id), new Set(readableContractIds(ctx)), new Set(readableMailboxIds(ctx))), reused: !created.created },
          audit: [
            {
              action: 'evidence.scope.create',
              entityType: 'evidence_scope',
              entityId: scope.id,
              tenderId: stage.tender_id,
              details: { reused: !created.created, contentHash: scope.content_hash, units: plan.units.length, sourceSetRevisionId: base.id },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/evidence-scopes',
    query(pool, 'evidence.scope.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      res.json({ items: (await listEvidenceScopes(pool, stage.id)).map((s) => toEvidenceScope(s)) });
    }),
  );

  router.get(
    '/evidence-scopes/:id',
    query(pool, 'evidence.scope.read', 'evidence_scope', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'evidence_scope');
      const scope = await getEvidenceScope(pool, ctx, id);
      if (!scope) throw notFound({ entityType: 'evidence_scope', entityId: id });
      res.json(toEvidenceScope(scope, await evidenceScopeItems(pool, id), new Set(readableContractIds(ctx)), new Set(readableMailboxIds(ctx))));
    }),
  );

  return router;
};
