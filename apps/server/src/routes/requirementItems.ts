// Требования и факты реестра, покрытие и решения (AD-08-1, Р-08-2, Р-08-3 и OD-08-5): реестр и карточка с
// историей ревизий; замена — requirement.manage / fact.confirm; оценка покрытия — requirement.confirm
// (И-08-13); решение — requirement.decide, с событием барьера decision_recorded. Видимость текста — Р-08-5.
import { RecordCoverageRequest, RecordDecisionRequest, SupersedeRequest } from '@kontur/contracts';
import { formatEtag } from '@kontur/core';
import {
  coverageHistory,
  factRevisions,
  getDecision,
  getFact,
  getRequirement,
  getRequirementRevision,
  linksOf,
  listAssumptions,
  listCustomerQuestions,
  listFacts,
  listRequirements,
  readableFragments,
  recordCoverage,
  recordRequirementDecision,
  requirementDecisions,
  requirementRevisions,
  supersedeFact,
  supersedeRequirement,
  visibilityOf,
  type IAccessContext,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { toAssumption, toCoverage, toCustomerQuestion, toDecision, toFact, toRequirement, toRequirementRevision } from '../requirementMappers.ts';
import { loadRegistryWith, readableOf, requireActiveRegistry, requireInScope } from './requirementScope.ts';

const requirementCard = async (db: Pool | PoolClient, ctx: IAccessContext, id: string) => {
  const q = (await getRequirement(db, id))!;
  const revisions = await requirementRevisions(db, id);
  const revLinks = await linksOf(db, 'requirement_revision_id', revisions.map((r) => r.id));
  const decisions = await requirementDecisions(db, [id]);
  const decLinks = await linksOf(db, 'decision_id', decisions.map((d) => d.id));
  const assumptions = (await listAssumptions(db, q.stage_id)).filter((a) => a.requirement_id === id);
  const asLinks = await linksOf(db, 'assumption_revision_id', assumptions.map((a) => a.current_revision_id));
  const readable = await readableOf(db, ctx, [...revLinks.values(), ...decLinks.values(), ...asLinks.values()]);
  const currentLinks = revLinks.get(q.current_revision_id) ?? [];
  const coverage = await coverageHistory(db, revisions.map((r) => r.id));
  const visibleRevisions = new Set(revisions.filter((r) => visibilityOf(revLinks.get(r.id) ?? [], readable).full).map((r) => r.id));
  return {
    row: q,
    body: {
      ...toRequirement(q, currentLinks, readable),
      revisions: revisions.map((r) => toRequirementRevision(r, revLinks.get(r.id) ?? [], readable)),
      coverage: coverage.map((c) => ({ revisionId: c.requirement_revision_id, ...toCoverage(c, visibleRevisions.has(c.requirement_revision_id)) })),
      decisions: decisions.map((d) => toDecision(d, decLinks.get(d.id) ?? [], readable)),
      assumptions: assumptions.map((a) => toAssumption(a, asLinks.get(a.current_revision_id) ?? [], readable)),
      questions: (await listCustomerQuestions(db, q.stage_id)).filter((x) => x.requirement_id === id).map(toCustomerQuestion),
    },
  };
};

const factCard = async (db: Pool | PoolClient, ctx: IAccessContext, id: string) => {
  const f = (await getFact(db, id))!;
  const revisions = await factRevisions(db, id);
  const links = await linksOf(db, 'fact_revision_id', revisions.map((r) => r.id));
  const readable = await readableOf(db, ctx, links.values());
  return {
    row: f,
    body: {
      ...toFact(f, links.get(f.current_revision_id) ?? [], readable),
      revisions: revisions.map((r) => {
        const v = visibilityOf(links.get(r.id) ?? [], readable);
        return {
          id: r.id,
          seq: r.seq,
          registrySeq: r.registry_seq,
          status: r.status,
          changeKind: r.change_kind,
          createdAt: r.created_at.toISOString(),
          supersededByFactId: r.superseded_by_fact_id,
          visible: v.full,
          displayValue: v.full ? r.display_value : null,
          normalizedValue: v.full ? r.normalized_value : null,
          unit: v.full ? r.unit : null,
        };
      }),
    },
  };
};

export const requirementItemsRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/requirement-registries/:id/requirements',
    query(pool, 'requirement.list', 'requirement_registry', async (ctx, req, res) => {
      const registry = await loadRegistryWith(pool, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.read');
      const rows = await listRequirements(pool, registry.id);
      const links = await linksOf(pool, 'requirement_revision_id', rows.map((r) => r.current_revision_id));
      const readable = await readableOf(pool, ctx, links.values());
      res.json({ items: rows.map((r) => toRequirement(r, links.get(r.current_revision_id) ?? [], readable)) });
    }),
  );

  router.get(
    '/requirements/:id',
    query(pool, 'requirement.read', 'requirement', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'requirement');
      requireInScope(ctx, await getRequirement(pool, id), 'requirement', id, 'requirement.read');
      const card = await requirementCard(pool, ctx, id);
      res.set('ETag', formatEtag(id, card.row.row_version)).json(card.body);
    }),
  );

  router.post(
    '/requirements/:id/supersede',
    command(pool, {
      action: 'requirement.supersede',
      entityType: 'requirement',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'requirement');
        requireInScope(ctx, await getRequirement(client, id), 'requirement', id, 'requirement.manage');
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'requirement');
        const rowVersion = requireIfMatch(req, id);
        const body = parseBody(SupersedeRequest, req.body);
        const q = requireInScope(ctx, await getRequirement(client, id), 'requirement', id, 'requirement.manage');
        requireActiveRegistry(q.registry_active, { tenderId: q.tender_id, entityType: 'requirement', entityId: id });
        const replacement = await getRequirement(client, body.replacementId);
        if (!replacement || replacement.stage_id !== q.stage_id) throw notFound({ entityType: 'requirement', entityId: body.replacementId });
        const rev = await supersedeRequirement(client, q, rowVersion, replacement.id, ctx.principal.userId, body.reason);
        if (!rev) throw versionConflict({ rowVersion: q.row_version });
        const card = await requirementCard(client, ctx, id);
        return {
          status: 200,
          body: card.body,
          etag: formatEtag(id, card.row.row_version),
          audit: [{ action: 'requirement.supersede', entityType: 'requirement', entityId: id, tenderId: q.tender_id, details: { revisionId: rev, replacementId: replacement.id } }],
        };
      },
    }),
  );

  router.post(
    '/requirement-revisions/:id/coverage',
    command(pool, {
      action: 'requirement.coverage.record',
      entityType: 'requirement_revision',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'requirement_revision');
        requireInScope(ctx, await getRequirementRevision(client, id), 'requirement_revision', id, 'requirement.confirm');
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'requirement_revision');
        const body = parseBody(RecordCoverageRequest, req.body);
        const rev = requireInScope(ctx, await getRequirementRevision(client, id), 'requirement_revision', id, 'requirement.confirm');
        const q = (await getRequirement(client, rev.requirement_id))!;
        const target = { tenderId: q.tender_id, entityType: 'requirement_revision', entityId: id };
        requireActiveRegistry(q.registry_active, target);
        if (q.current_revision_id !== id || q.status !== 'confirmed') {
          throw new HttpError(409, 'STATE_CONFLICT', 'покрытие оценивается для текущей подтверждённой ревизии требования', { current: { currentRevisionId: q.current_revision_id } }, target);
        }
        const links = (await linksOf(client, 'requirement_revision_id', [id])).get(id) ?? [];
        const cited = body.objects.flatMap((o) => (o.type === 'evidence_fragment' ? [o.fragmentId] : []));
        const readable = await readableFragments(client, ctx, [...links.filter((l) => l.role === 'supports').map((l) => l.fragment_id), ...cited]);
        if (!visibilityOf(links, readable).full || cited.some((f) => !readable.has(f))) {
          throw new HttpError(409, 'STATE_CONFLICT', 'среди оснований есть фрагменты, которые вы не можете читать', { current: { reason: 'restricted_fragments' } }, target);
        }
        const coverageId = await recordCoverage(client, {
          tenderId: q.tender_id,
          stageId: q.stage_id,
          revisionId: id,
          state: body.state,
          reason: body.reason ?? null,
          objects: body.objects.map((o) => ({ ...o, note: o.type === 'manual_confirmation' ? o.note : null })),
          userId: ctx.principal.userId,
        });
        const card = await requirementCard(client, ctx, q.id);
        return {
          status: 201,
          body: card.body,
          etag: formatEtag(q.id, card.row.row_version),
          audit: [{ action: 'requirement.coverage.record', entityType: 'requirement', entityId: q.id, tenderId: q.tender_id, details: { coverageId, revisionId: id, state: body.state, objects: body.objects.map((o) => o.type) } }],
        };
      },
    }),
  );

  router.post(
    '/requirements/:id/decisions',
    command(pool, {
      action: 'requirement.decision.record',
      entityType: 'requirement',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'requirement');
        requireInScope(ctx, await getRequirement(client, id), 'requirement', id, 'requirement.decide');
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'requirement');
        const body = parseBody(RecordDecisionRequest, req.body);
        const q = requireInScope(ctx, await getRequirement(client, id), 'requirement', id, 'requirement.decide');
        const target = { tenderId: q.tender_id, entityType: 'requirement', entityId: id };
        if (body.supersedesDecisionId) {
          const prev = await getDecision(client, body.supersedesDecisionId);
          if (!prev || prev.decision_type !== 'requirement_decision' || prev.subject_id !== id) throw notFound({ entityType: 'decision', entityId: body.supersedesDecisionId });
          if (prev.superseded_by) throw new HttpError(409, 'STATE_CONFLICT', 'решение уже заменено', { current: { supersededBy: prev.superseded_by } }, target);
        }
        const readable = await readableFragments(client, ctx, body.evidence.map((e) => e.fragmentId));
        if (body.evidence.some((e) => !readable.has(e.fragmentId))) {
          throw new HttpError(409, 'STATE_CONFLICT', 'среди оснований есть фрагменты, которые вы не можете читать', { current: { reason: 'restricted_fragments' } }, target);
        }
        const decisionId = await recordRequirementDecision(client, {
          tenderId: q.tender_id,
          stageId: q.stage_id,
          requirementId: id,
          statement: body.statement,
          rationale: body.rationale,
          supersedesId: body.supersedesDecisionId ?? null,
          evidence: body.evidence,
          userId: ctx.principal.userId,
        });
        const card = await requirementCard(client, ctx, id);
        return {
          status: 201,
          body: { decisionId, requirement: card.body },
          audit: [{ action: 'requirement.decision.record', entityType: 'decision', entityId: decisionId, tenderId: q.tender_id, details: { requirementId: id, supersedes: body.supersedesDecisionId ?? null } }],
        };
      },
    }),
  );

  router.get(
    '/requirement-registries/:id/facts',
    query(pool, 'fact.list', 'requirement_registry', async (ctx, req, res) => {
      const registry = await loadRegistryWith(pool, ctx, uuidParam(req, 'id', 'requirement_registry'), 'fact.read');
      const rows = await listFacts(pool, registry.id);
      const links = await linksOf(pool, 'fact_revision_id', rows.map((r) => r.current_revision_id));
      const readable = await readableOf(pool, ctx, links.values());
      res.json({ items: rows.map((r) => toFact(r, links.get(r.current_revision_id) ?? [], readable)) });
    }),
  );

  router.get(
    '/facts/:id',
    query(pool, 'fact.read', 'fact', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'fact');
      requireInScope(ctx, await getFact(pool, id), 'fact', id, 'fact.read');
      const card = await factCard(pool, ctx, id);
      res.set('ETag', formatEtag(id, card.row.row_version)).json(card.body);
    }),
  );

  router.post(
    '/facts/:id/supersede',
    command(pool, {
      action: 'fact.supersede',
      entityType: 'fact',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'fact');
        requireInScope(ctx, await getFact(client, id), 'fact', id, 'fact.confirm');
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'fact');
        const rowVersion = requireIfMatch(req, id);
        const body = parseBody(SupersedeRequest, req.body);
        const f = requireInScope(ctx, await getFact(client, id), 'fact', id, 'fact.confirm');
        requireActiveRegistry(f.registry_active, { tenderId: f.tender_id, entityType: 'fact', entityId: id });
        const replacement = await getFact(client, body.replacementId);
        if (!replacement || replacement.stage_id !== f.stage_id) throw notFound({ entityType: 'fact', entityId: body.replacementId });
        const rev = await supersedeFact(client, f, rowVersion, replacement.id, ctx.principal.userId, body.reason);
        if (!rev) throw versionConflict({ rowVersion: f.row_version });
        const card = await factCard(client, ctx, id);
        return {
          status: 200,
          body: card.body,
          etag: formatEtag(id, card.row.row_version),
          audit: [{ action: 'fact.supersede', entityType: 'fact', entityId: id, tenderId: f.tender_id, details: { revisionId: rev, replacementId: replacement.id } }],
        };
      },
    }),
  );

  return router;
};
