// Кандидаты требований и фактов (AD-08-2 первого текста, OD-08-5, «Candidate confirmation»): создание
// инженером, правка — новой версией, подтверждение и отклонение — requirement.confirm / fact.confirm, перенос
// кандидата прежнего реестра — явной операцией. Цитировать и подтверждать можно только то, что пользователь
// может прочитать целиком (R08-02 — замыкание закрытости); модель подтверждать не может (кандидатов модели пишет
// только прогон в worker). Конфликт с действующим требованием и противоречащее основание подтверждаются только с
// пояснением (R08-01).
import {
  ConfirmFactCandidateRequest,
  ConfirmRequirementCandidateRequest,
  CreateFactCandidateRequest,
  CreateRequirementCandidateRequest,
  RejectCandidateRequest,
} from '@kontur/contracts';
import { formatEtag, type TenderCapability } from '@kontur/core';
import {
  activeRegistryOf,
  confirmationConflicts,
  confirmFactCandidate,
  confirmRequirementCandidate,
  createFactCandidate,
  createRequirementCandidate,
  getFactCandidate,
  getRequirementCandidate,
  linksOf,
  listFactCandidates,
  listFactKinds,
  listRequirementCandidates,
  readableFragments,
  rebaseFactCandidate,
  rebaseRequirementCandidate,
  rejectFactCandidate,
  rejectRequirementCandidate,
  stageVisibility,
  type IAccessContext,
  type IFactCandidateRow,
  type IRequirementCandidateRow,
  type IStageVisibility,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { HttpError } from '../http/errors.ts';
import { toConflicts, toFactCandidate, toRequirementCandidate } from '../requirementMappers.ts';
import { loadRegistryWith, requireActiveRegistry, requireInScope, requireVisible } from './requirementScope.ts';

type Kind = 'requirement' | 'fact';
const CAPS: Record<Kind, { read: TenderCapability; create: TenderCapability; confirm: TenderCapability }> = {
  requirement: { read: 'requirement.read', create: 'requirement.create', confirm: 'requirement.confirm' },
  fact: { read: 'fact.read', create: 'fact.create', confirm: 'fact.confirm' },
};
const STATUSES = ['proposed', 'confirmed', 'rejected', 'superseded'];

const restricted = (target: { tenderId: string; entityType: string; entityId: string }, n: number): HttpError =>
  new HttpError(409, 'STATE_CONFLICT', 'среди оснований есть фрагменты, которые вы не можете читать', { current: { reason: 'restricted_fragments', restricted: n } }, target);

const requireReadable = async (client: PoolClient, ctx: IAccessContext, ids: string[], target: { tenderId: string; entityType: string; entityId: string }) => {
  const readable = await readableFragments(client, ctx, ids);
  const missing = new Set(ids.filter((id) => !readable.has(id))).size;
  if (missing > 0) throw restricted(target, missing);
};

const requirementView = (c: IRequirementCandidateRow, links: Parameters<typeof toRequirementCandidate>[1], vis: IStageVisibility) => {
  const visible = vis.visible('candidate', c.id);
  return toRequirementCandidate(c, links, vis.readable, visible, toConflicts(c.conflicts, visible, (id) => vis.visible('requirement', id)));
};

const factView = (c: IFactCandidateRow, links: Parameters<typeof toFactCandidate>[1], vis: IStageVisibility) =>
  toFactCandidate(c, links, vis.readable, vis.visible('fact_candidate', c.id));

const projectRequirement = async (db: Pool | PoolClient, ctx: IAccessContext, id: string) => {
  const c = (await getRequirementCandidate(db, id))!;
  const links = (await linksOf(db, 'requirement_candidate_id', [c.id])).get(c.id) ?? [];
  return { row: c, body: requirementView(c, links, await stageVisibility(db, ctx, c.stage_id)) };
};

const projectFact = async (db: Pool | PoolClient, ctx: IAccessContext, id: string) => {
  const c = (await getFactCandidate(db, id))!;
  const links = (await linksOf(db, 'fact_candidate_id', [c.id])).get(c.id) ?? [];
  return { row: c, body: factView(c, links, await stageVisibility(db, ctx, c.stage_id)) };
};

export const requirementCandidatesRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/requirement-registries/:id/candidates',
    query(pool, 'requirement.candidate.list', 'requirement_registry', async (ctx, req, res) => {
      const kind: Kind = req.query.kind === 'fact' ? 'fact' : 'requirement';
      const registry = await loadRegistryWith(pool, ctx, uuidParam(req, 'id', 'requirement_registry'), CAPS[kind].read);
      const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status) ? req.query.status : null;
      const runId = typeof req.query.runId === 'string' && /^[0-9a-f-]{36}$/u.test(req.query.runId) ? req.query.runId : null;
      if (kind === 'requirement') {
        const rows = await listRequirementCandidates(pool, registry.id, { status, runId, limit: 1000 });
        const links = await linksOf(pool, 'requirement_candidate_id', rows.map((r) => r.id));
        const vis = await stageVisibility(pool, ctx, registry.stage_id);
        res.json({ items: rows.map((r) => requirementView(r, links.get(r.id) ?? [], vis)) });
        return;
      }
      const rows = await listFactCandidates(pool, registry.id, { status, runId, limit: 1000 });
      const links = await linksOf(pool, 'fact_candidate_id', rows.map((r) => r.id));
      const vis = await stageVisibility(pool, ctx, registry.stage_id);
      res.json({ items: rows.map((r) => factView(r, links.get(r.id) ?? [], vis)) });
    }),
  );

  router.get(
    '/requirement-candidates/:id',
    query(pool, 'requirement.candidate.read', 'requirement_candidate', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'requirement_candidate');
      requireInScope(ctx, await getRequirementCandidate(pool, id), 'requirement_candidate', id, 'requirement.read');
      const p = await projectRequirement(pool, ctx, id);
      res.set('ETag', formatEtag(p.row.id, p.row.row_version)).json(p.body);
    }),
  );

  router.get(
    '/fact-candidates/:id',
    query(pool, 'fact.candidate.read', 'fact_candidate', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'fact_candidate');
      requireInScope(ctx, await getFactCandidate(pool, id), 'fact_candidate', id, 'fact.read');
      const p = await projectFact(pool, ctx, id);
      res.set('ETag', formatEtag(p.row.id, p.row.row_version)).json(p.body);
    }),
  );

  router.post(
    '/requirement-registries/:id/requirement-candidates',
    command(pool, {
      action: 'requirement.candidate.create',
      entityType: 'requirement_candidate',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.create')),
      run: async (client, ctx, req) => {
        const body = parseBody(CreateRequirementCandidateRequest, req.body);
        const registry = await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.create');
        const target = { tenderId: registry.tender_id, entityType: 'requirement_registry', entityId: registry.id };
        requireActiveRegistry(registry.active, target);
        await requireReadable(client, ctx, body.evidence.map((e) => e.fragmentId), target);
        // Правка и изменение — только видимого объекта (R08-02).
        if (body.targetRequirementId || body.derivedFromCandidateId) {
          const vis = await stageVisibility(client, ctx, registry.stage_id);
          if (body.targetRequirementId) requireVisible(vis, 'requirement', body.targetRequirementId, target);
          if (body.derivedFromCandidateId) requireVisible(vis, 'candidate', body.derivedFromCandidateId, target);
        }
        const id = await createRequirementCandidate(client, {
          tenderId: registry.tender_id,
          stageId: registry.stage_id,
          registryId: registry.id,
          userId: ctx.principal.userId,
          statement: body.statement,
          parameters: body.parameters.map((p) => ({ name: p.name, value: p.value, unit: p.unit ?? null })),
          objectScope: Object.fromEntries(Object.entries(body.objectScope).filter(([, v]) => v)),
          rationale: body.rationale ?? null,
          evidence: body.evidence,
          targetRequirementId: body.targetRequirementId ?? null,
          derivedFromCandidateId: body.derivedFromCandidateId ?? null,
        });
        const p = await projectRequirement(client, ctx, id);
        return {
          status: 201,
          body: p.body,
          etag: formatEtag(id, p.row.row_version),
          audit: [{ action: 'requirement.candidate.create', entityType: 'requirement_candidate', entityId: id, tenderId: registry.tender_id, details: { registryId: registry.id, derivedFrom: body.derivedFromCandidateId ?? null, evidence: body.evidence.length } }],
        };
      },
    }),
  );

  router.post(
    '/requirement-registries/:id/fact-candidates',
    command(pool, {
      action: 'fact.candidate.create',
      entityType: 'fact_candidate',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'fact.create')),
      run: async (client, ctx, req) => {
        const body = parseBody(CreateFactCandidateRequest, req.body);
        const registry = await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'fact.create');
        const target = { tenderId: registry.tender_id, entityType: 'requirement_registry', entityId: registry.id };
        requireActiveRegistry(registry.active, target);
        await requireReadable(client, ctx, body.evidence.map((e) => e.fragmentId), target);
        if (body.targetFactId || body.derivedFromCandidateId) {
          const vis = await stageVisibility(client, ctx, registry.stage_id);
          if (body.targetFactId) requireVisible(vis, 'fact', body.targetFactId, target);
          if (body.derivedFromCandidateId) requireVisible(vis, 'fact_candidate', body.derivedFromCandidateId, target);
        }
        // Вид факта — только из справочника (Р-08-4): других бизнес-классов портал не придумывает.
        if (!(await listFactKinds(client)).some((k) => k.code === body.factKind)) {
          throw new HttpError(409, 'STATE_CONFLICT', `вид факта ${body.factKind} не предусмотрен справочником`, { current: { reason: 'unknown_fact_kind' } }, target);
        }
        const id = await createFactCandidate(client, {
          tenderId: registry.tender_id,
          stageId: registry.stage_id,
          registryId: registry.id,
          userId: ctx.principal.userId,
          factKind: body.factKind,
          displayValue: body.displayValue,
          normalizedValue: body.normalizedValue,
          unit: body.unit ?? null,
          rationale: body.rationale ?? null,
          evidence: body.evidence,
          targetFactId: body.targetFactId ?? null,
          derivedFromCandidateId: body.derivedFromCandidateId ?? null,
        });
        const p = await projectFact(client, ctx, id);
        return {
          status: 201,
          body: p.body,
          etag: formatEtag(id, p.row.row_version),
          audit: [{ action: 'fact.candidate.create', entityType: 'fact_candidate', entityId: id, tenderId: registry.tender_id, details: { registryId: registry.id, factKind: body.factKind } }],
        };
      },
    }),
  );

  // Подтверждение, отклонение и перенос — общий порядок для обоих видов.
  for (const kind of ['requirement', 'fact'] as const) {
    const entityType = `${kind}_candidate`;
    const path = `/${kind}-candidates/:id`;
    const load = async (client: PoolClient, ctx: IAccessContext, id: string, cap: TenderCapability) =>
      kind === 'requirement'
        ? requireInScope(ctx, await getRequirementCandidate(client, id), entityType, id, cap)
        : requireInScope(ctx, await getFactCandidate(client, id), entityType, id, cap);
    const project = (client: PoolClient, ctx: IAccessContext, id: string) => (kind === 'requirement' ? projectRequirement(client, ctx, id) : projectFact(client, ctx, id));
    const taintKind = kind === 'requirement' ? ('candidate' as const) : ('fact_candidate' as const);
    const requireCandidateVisible = async (client: PoolClient, ctx: IAccessContext, c: { id: string; stage_id: string }, target: { tenderId: string; entityType: string; entityId: string }) =>
      requireVisible(await stageVisibility(client, ctx, c.stage_id), taintKind, c.id, target);

    router.post(
      `${path}/confirm`,
      command(pool, {
        action: `${kind}.candidate.confirm`,
        entityType,
        idempotent: true,
        authorize: async (client, ctx, req) => void (await load(client, ctx, uuidParam(req, 'id', entityType), CAPS[kind].confirm)),
        run: async (client, ctx, req) => {
          const id = uuidParam(req, 'id', entityType);
          const rowVersion = requireIfMatch(req, id);
          const c = await load(client, ctx, id, CAPS[kind].confirm);
          const target = { tenderId: c.tender_id, entityType, entityId: id };
          // Сначала версия: конкурентное второе подтверждение получает 412 независимо от того, успел ли первый
          // зафиксироваться (инвариант 14 — предсказуемый конфликт).
          if (c.row_version !== rowVersion) throw versionConflict({ status: c.status, rowVersion: c.row_version });
          requireActiveRegistry(c.registry_active, target);
          if (c.status !== 'proposed') throw new HttpError(409, 'STATE_CONFLICT', `кандидат уже в статусе ${c.status}`, { current: { status: c.status } }, target);
          // Подтверждается только видимое целиком: все основания любой роли и всё, из чего унаследован текст (R08-02).
          await requireCandidateVisible(client, ctx, c, target);
          let done: { revisionId: string; entityId: string } | null;
          if (kind === 'requirement') {
            const body = parseBody(ConfirmRequirementCandidateRequest, req.body);
            const rc = c as Awaited<ReturnType<typeof getRequirementCandidate>> & object;
            const edit = {
              statement: body.statement ?? rc.statement,
              parameters: body.parameters ? body.parameters.map((p) => ({ name: p.name, value: p.value, unit: p.unit ?? null })) : rc.parameters,
              objectScope: body.objectScope ? Object.fromEntries(Object.entries(body.objectScope).filter(([, v]) => v)) : rc.object_scope,
              conflictNote: body.conflictNote ?? null,
            };
            // R08-01: конфликт с действующим требованием реестра (тот же параметр, та же область, другое значение)
            // или противоречащее основание — подтверждение только с пояснением; без конфликта пояснение не пишется.
            const conflict = await confirmationConflicts(client, rc, edit);
            const conflicted = conflict.contradicted || conflict.conflicts.length > 0;
            if (conflicted && !edit.conflictNote) {
              const vis = await stageVisibility(client, ctx, rc.stage_id);
              throw new HttpError(
                409,
                'STATE_CONFLICT',
                conflict.conflicts.length > 0
                  ? `требование противоречит действующим: ${[...new Set(conflict.conflicts.map((x) => x.code))].join(', ')} — укажите пояснение к конфликту`
                  : 'среди оснований есть противоречащее (contradicts) — укажите пояснение к конфликту',
                { current: { reason: 'requirement_conflict', contradicted: conflict.contradicted, conflicts: toConflicts(conflict.conflicts, true, (rid) => vis.visible('requirement', rid)) } },
                target,
              );
            }
            if (!conflicted && edit.conflictNote) {
              throw new HttpError(409, 'STATE_CONFLICT', 'пояснение к конфликту указывается только при конфликте', { current: { reason: 'conflict_note_unexpected' } }, target);
            }
            const r = await confirmRequirementCandidate(client, rc, rowVersion, ctx.principal.userId, edit);
            done = r ? { revisionId: r.revisionId, entityId: r.requirementId } : null;
          } else {
            const body = parseBody(ConfirmFactCandidateRequest, req.body);
            const fc = c as Awaited<ReturnType<typeof getFactCandidate>> & object;
            const r = await confirmFactCandidate(client, fc, rowVersion, ctx.principal.userId, {
              displayValue: body.displayValue ?? fc.display_value,
              normalizedValue: body.normalizedValue ?? fc.normalized_value,
              unit: body.unit === undefined ? fc.unit : body.unit,
            });
            done = r ? { revisionId: r.revisionId, entityId: r.factId } : null;
          }
          if (!done) throw versionConflict({ status: c.status, rowVersion: c.row_version });
          const p = await project(client, ctx, id);
          return {
            status: 200,
            body: { candidate: p.body, [`${kind}Id`]: done.entityId, revisionId: done.revisionId },
            etag: formatEtag(id, p.row.row_version),
            audit: [{ action: `${kind}.candidate.confirm`, entityType, entityId: id, tenderId: c.tender_id, details: { [`${kind}Id`]: done.entityId, revisionId: done.revisionId, origin: c.origin } }],
          };
        },
      }),
    );

    router.post(
      `${path}/reject`,
      command(pool, {
        action: `${kind}.candidate.reject`,
        entityType,
        authorize: async (client, ctx, req) => void (await load(client, ctx, uuidParam(req, 'id', entityType), CAPS[kind].confirm)),
        run: async (client, ctx, req) => {
          const id = uuidParam(req, 'id', entityType);
          const rowVersion = requireIfMatch(req, id);
          const body = parseBody(RejectCandidateRequest, req.body);
          const c = await load(client, ctx, id, CAPS[kind].confirm);
          if (c.row_version !== rowVersion) throw versionConflict({ status: c.status, rowVersion: c.row_version });
          const target = { tenderId: c.tender_id, entityType, entityId: id };
          requireActiveRegistry(c.registry_active, target);
          await requireCandidateVisible(client, ctx, c, target);
          const ok = kind === 'requirement'
            ? await rejectRequirementCandidate(client, id, rowVersion, ctx.principal.userId, body.reason)
            : await rejectFactCandidate(client, id, rowVersion, ctx.principal.userId, body.reason);
          if (!ok) throw versionConflict({ status: c.status, rowVersion: c.row_version });
          const p = await project(client, ctx, id);
          return {
            status: 200,
            body: p.body,
            etag: formatEtag(id, p.row.row_version),
            audit: [{ action: `${kind}.candidate.reject`, entityType, entityId: id, tenderId: c.tender_id, details: { origin: c.origin } }],
          };
        },
      }),
    );

    router.post(
      `${path}/rebase`,
      command(pool, {
        action: `${kind}.candidate.rebase`,
        entityType,
        idempotent: true,
        authorize: async (client, ctx, req) => void (await load(client, ctx, uuidParam(req, 'id', entityType), CAPS[kind].create)),
        run: async (client, ctx, req) => {
          const id = uuidParam(req, 'id', entityType);
          const c = await load(client, ctx, id, CAPS[kind].create);
          const target = { tenderId: c.tender_id, entityType, entityId: id };
          const active = await activeRegistryOf(client, c.stage_id);
          if (!active || active.id === c.registry_id) throw new HttpError(409, 'STATE_CONFLICT', 'кандидат уже в активном реестре', { current: { reason: 'already_active' } }, target);
          if (c.status !== 'proposed') throw new HttpError(409, 'STATE_CONFLICT', `переносится только предложение (статус ${c.status})`, { current: { status: c.status } }, target);
          await requireCandidateVisible(client, ctx, c, target);
          const r = kind === 'requirement'
            ? await rebaseRequirementCandidate(client, c as Awaited<ReturnType<typeof getRequirementCandidate>> & object, active, ctx.principal.userId)
            : await rebaseFactCandidate(client, c as Awaited<ReturnType<typeof getFactCandidate>> & object, active, ctx.principal.userId);
          if ('error' in r) throw new HttpError(409, 'STATE_CONFLICT', r.error === 'already_rebased' ? 'кандидат уже перенесён' : 'в новом снимке нет содержательного основания кандидата', { current: { reason: r.error } }, target);
          const p = await project(client, ctx, r.id);
          return {
            status: 201,
            body: p.body,
            etag: formatEtag(r.id, p.row.row_version),
            audit: [{ action: `${kind}.candidate.rebase`, entityType, entityId: r.id, tenderId: c.tender_id, details: { from: id, fromRegistryId: c.registry_id, toRegistryId: active.id } }],
          };
        },
      }),
    );
  }

  return router;
};
