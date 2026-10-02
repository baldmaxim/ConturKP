// Проверка этапа 09 (D-029; portal-api §2.7 в редакции этапа 09; docs/architecture/09-review-checks-design.md §7):
// прогоны и замечания. Первая линия — права участника тендера (review.run, finding.write, finding.accept_risk), вторая —
// охранники БД миграции 0024. Невидимый объект — 404, видимый без права — 403. Разногласия, гипотезы и приоритет —
// discrepancies.ts.
import { createChatModel } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import { CreateFindingRequest, FindingTransitionRequest, PatchFindingRequest } from '@kontur/contracts';
import { FINDING_KIND_META, formatEtag, HUMAN_FINDING_TRANSITIONS, type FindingStatus, type IEvidenceDraft } from '@kontur/core';
import { createHumanFinding, createReviewRun, getFinding, getReviewRun, listFindings, listReviewRuns, lockTenderStages, patchFinding, transitionFinding, type Pool } from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden } from '../http/errors.ts';
import { findingDetail, findingsList, runBrief, runView } from '../reviewMappers.ts';
import { loadStageWith, requireInScope } from './requirementScope.ts';
import { conflict, loadFinding, requireFindingVisible, stageVersion } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';

export const reviewsRouter = (pool: Pool, config: IAppConfig): Router => {
  const router = Router();

  // ---------------------------------------------------------------- Прогоны

  router.post(
    '/stages/:id/review-runs',
    command(pool, {
      action: 'review.run.request',
      entityType: 'review_run',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'review.run')),
      run: async (client, ctx, req) => {
        const stage = await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'review.run');
        const target = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        const chat = createChatModel(config.chatModel);
        const r = await createReviewRun(client, { tenderId: stage.tender_id, stageId: stage.id, userId: ctx.principal.userId, model: chat ? { providerId: chat.providerId, model: chat.model, version: chat.version } : null });
        if (!r.ok) throw conflict('у этапа нет снимка области: зафиксируйте снимок источников', 'no_scope', target);
        return {
          status: r.created ? 201 : 200,
          body: { ...runBrief(r.run), reused: !r.created },
          audit: [
            {
              action: 'review.run.request',
              entityType: 'review_run',
              entityId: r.run.id,
              tenderId: stage.tender_id,
              details: { reused: !r.created, scopeId: r.run.evidence_scope_id, registryId: r.run.registry_id, calculationRevisionId: r.run.calculation_revision_id, rulesVersion: r.run.rules_version, model: r.run.model_provider },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/review-runs',
    query(pool, 'review.run.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'tender.read');
      res.json({ items: (await listReviewRuns(pool, stage.id)).map(runBrief) });
    }),
  );

  router.get(
    '/review-runs/:id',
    query(pool, 'review.run.read', 'review_run', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'review_run');
      const run = requireInScope(ctx, await getReviewRun(pool, id), 'review_run', id, 'tender.read');
      res.json(await runView(pool, ctx, run));
    }),
  );

  // ---------------------------------------------------------------- Замечания

  router.get(
    '/stages/:id/findings',
    query(pool, 'finding.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'tender.read');
      const q = req.query as Record<string, string | undefined>;
      const status = q.status && (Object.keys(HUMAN_FINDING_TRANSITIONS) as string[]).includes(q.status) ? (q.status as FindingStatus) : null;
      const severity = q.severity && ['critical', 'major', 'minor'].includes(q.severity) ? (q.severity as 'critical' | 'major' | 'minor') : null;
      const kind = q.kind && q.kind in FINDING_KIND_META ? q.kind : null;
      const runId = q.runId && /^[0-9a-f-]{36}$/iu.test(q.runId) ? q.runId.toLowerCase() : null;
      const rows = await listFindings(pool, stage.id, { status, kind, severity, runId });
      res.json({
        items: await findingsList(pool, ctx, stage.id, rows),
        canWrite: hasTenderCap(ctx, stage.tender_id, 'finding.write'),
        canAcceptRisk: hasTenderCap(ctx, stage.tender_id, 'finding.accept_risk'),
        canDecide: hasTenderCap(ctx, stage.tender_id, 'requirement.decide'),
      });
    }),
  );

  router.get(
    '/findings/:id',
    query(pool, 'finding.read', 'finding', async (ctx, req, res) => {
      const f = await loadFinding(pool, ctx, uuidParam(req, 'id', 'finding'), 'tender.read');
      res.setHeader('ETag', formatEtag(f.id, Number(f.row_version)));
      res.json(await findingDetail(pool, ctx, f));
    }),
  );

  router.post(
    '/stages/:id/findings',
    command(pool, {
      action: 'finding.create',
      entityType: 'finding',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'finding.write')),
      run: async (client, ctx, req) => {
        const stage = await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'finding.write');
        const body = parseBody(CreateFindingRequest, req.body);
        const evidence: IEvidenceDraft[] = body.evidence.map((e) =>
          'fragmentId' in e
            ? { side: e.side, objectType: 'fragment', fragmentId: e.fragmentId }
            : { side: e.side, objectType: 'calculation_object', calculationRevisionId: e.calculationRevisionId, externalPositionId: e.externalPositionId, externalItemId: e.externalItemId ?? null },
        );
        const id = await createHumanFinding(client, {
          tenderId: stage.tender_id,
          stageId: stage.id,
          userId: ctx.principal.userId,
          title: body.title,
          detail: body.detail ?? null,
          severity: body.severity,
          confidence: body.confidence,
          action: body.action ?? null,
          evidence,
          inputVersion: await stageVersion(client, stage.id),
        });
        const f = (await getFinding(client, id))!;
        await requireFindingVisible(client, ctx, f);
        return {
          status: 201,
          body: await findingDetail(client, ctx, f),
          etag: formatEtag(f.id, Number(f.row_version)),
          audit: [{ action: 'finding.create', entityType: 'finding', entityId: id, tenderId: stage.tender_id, details: { severity: body.severity, evidence: evidence.length } }],
        };
      },
    }),
  );

  router.post(
    '/findings/:id/transitions',
    command(pool, {
      action: 'finding.transition',
      entityType: 'finding',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadFinding(client, ctx, uuidParam(req, 'id', 'finding'), 'finding.write')),
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'finding');
        const body = parseBody(FindingTransitionRequest, req.body);
        const probe = await loadFinding(client, ctx, id, 'finding.write');
        const target = { tenderId: probe.tender_id, entityType: 'finding', entityId: id };
        if (body.to === 'accepted_risk' && !hasTenderCap(ctx, probe.tender_id, 'finding.accept_risk')) throw forbidden('finding.accept_risk', target);
        // Порядок блокировок §1.2: этапы тендера (решение проходит барьер), затем замечание.
        await lockTenderStages(client, probe.tender_id, [probe.stage_id]);
        const f = await loadFinding(client, ctx, id, 'finding.write', true);
        if (requireIfMatch(req, f.id) !== Number(f.row_version)) throw versionConflict({ rowVersion: Number(f.row_version), status: f.status });
        await requireFindingVisible(client, ctx, f);
        if (!HUMAN_FINDING_TRANSITIONS[f.status].includes(body.to)) {
          throw conflict(`переход ${f.status} → ${body.to} не допускается`, 'transition_not_allowed', target, { status: f.status });
        }
        if (body.to === 'accepted_risk' && !FINDING_KIND_META[f.kind].riskAcceptable) {
          throw conflict('техническое замечание риском не принимается (D-029 В-09-3)', 'risk_not_acceptable', target, { kind: f.kind });
        }
        const owner = body.ownerUserId !== undefined ? body.ownerUserId : f.owner_user_id;
        if (body.to === 'in_progress' && !owner) throw conflict('в работу — с ответственным', 'owner_required', target);
        const { decisionId } = await transitionFinding(client, f, {
          to: body.to,
          reason: body.reason ?? null,
          statement: body.statement ?? null,
          userId: ctx.principal.userId,
          ...(body.ownerUserId !== undefined ? { ownerUserId: body.ownerUserId } : {}),
        });
        const fresh = (await getFinding(client, id))!;
        return {
          status: 200,
          body: await findingDetail(client, ctx, fresh),
          etag: formatEtag(fresh.id, Number(fresh.row_version)),
          audit: [{ action: `finding.${body.to}`, entityType: 'finding', entityId: id, tenderId: f.tender_id, details: { from: f.status, to: body.to, decisionId, kind: f.kind } }],
        };
      },
    }),
  );

  router.patch(
    '/findings/:id',
    command(pool, {
      action: 'finding.update',
      entityType: 'finding',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadFinding(client, ctx, uuidParam(req, 'id', 'finding'), 'finding.write')),
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'finding');
        const body = parseBody(PatchFindingRequest, req.body);
        const f = await loadFinding(client, ctx, id, 'finding.write', true);
        if (requireIfMatch(req, f.id) !== Number(f.row_version)) throw versionConflict({ rowVersion: Number(f.row_version) });
        await requireFindingVisible(client, ctx, f);
        await patchFinding(
          client,
          f,
          {
            ...(body.severity !== undefined ? { severity: body.severity } : {}),
            ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
            ...(body.ownerUserId !== undefined ? { ownerUserId: body.ownerUserId } : {}),
            ...(body.action !== undefined ? { action: body.action ?? null } : {}),
            ...(body.impact !== undefined ? { impact: body.impact ?? null } : {}),
          },
          ctx.principal.userId,
          body.reason ?? null,
        );
        const fresh = (await getFinding(client, id))!;
        return {
          status: 200,
          body: await findingDetail(client, ctx, fresh),
          etag: formatEtag(fresh.id, Number(fresh.row_version)),
          audit: [{ action: 'finding.update', entityType: 'finding', entityId: id, tenderId: f.tender_id, details: { severity: body.severity, confidence: body.confidence, owner: body.ownerUserId } }],
        };
      },
    }),
  );

  return router;
};
