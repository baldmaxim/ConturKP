// Реестр требований, полнота и прогоны анализа этапа 08 (D-026: Р-08-6, Р-08-7, OD-08-7, «Model run», OD-08-2).
// Сервер в модель не ходит (ADR-007): он фиксирует прогон с описанием модели, входом и ключом повтора и ставит
// задание; вызывает модель worker.
import { createChatModel } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import { CreateRequirementRegistryRequest, MarkFragmentsRequest, StartAnalysisRunRequest } from '@kontur/contracts';
import { analysisInputHash, configHash, FACT_RULES_VERSION, OUTPUT_SCHEMA_VERSION, PROMPT_VERSION, sha256Hex, systemPrompt, type FragmentReviewState } from '@kontur/core';
import {
  analysisRunInputIds,
  completeRegistryReview,
  createAnalysisRun,
  createRequirementRegistry,
  evidenceScopeItems,
  expandMarkSelector,
  factKindCodes,
  fragmentStates,
  getAnalysisRun,
  getEvidenceScope,
  listAnalysisRuns,
  listFactKinds,
  listRegistryReviews,
  listRequirementRegistries,
  markFragments,
  readableContractIds,
  readableFragments,
  RULES_PROVIDER,
  readableMailboxIds,
  registryCompleteness,
  reviewableScopeFragments,
  unitCompleteness,
  type MarkSelector,
  type Pool,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { toAnalysisRun, toRegistry } from '../requirementMappers.ts';
import { toEvidenceScope } from '../searchMappers.ts';
import { loadRegistryWith, loadStageWith, requireActiveRegistry, requireInScope } from './requirementScope.ts';

const REVIEW_STATES: readonly FragmentReviewState[] = ['covered', 'reviewed', 'explicitly_not_requirement', 'unreviewed'];
const intParam = (v: unknown, def: number, max: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : def;
};

export const requirementRegistriesRouter = (pool: Pool, config: IAppConfig): Router => {
  const router = Router();

  router.get(
    '/stages/:id/requirement-registry',
    query(pool, 'requirement.registry.read', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.read');
      const registries = await listRequirementRegistries(pool, stage.id);
      const active = registries.find((r) => r.active) ?? null;
      res.json({
        active: active ? toRegistry(active) : null,
        registries: registries.map(toRegistry),
        completeness: active ? await registryCompleteness(pool, active.id) : null,
        lastReview: active ? ((await listRegistryReviews(pool, active.id))[0] ?? null) : null,
        model: { configured: createChatModel(config.chatModel) !== null, provider: config.chatModel.provider },
      });
    }),
  );

  router.post(
    '/stages/:id/requirement-registries',
    command(pool, {
      action: 'requirement.registry.create',
      entityType: 'requirement_registry',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.manage')),
      run: async (client, ctx, req) => {
        const body = parseBody(CreateRequirementRegistryRequest, req.body);
        const stage = await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.manage');
        const target = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        const scope = await getEvidenceScope(client, ctx, body.evidenceScopeId);
        if (!scope || scope.stage_id !== stage.id) throw notFound({ entityType: 'evidence_scope', entityId: body.evidenceScopeId });
        const current = (await listRequirementRegistries(client, stage.id)).find((r) => r.active);
        if (current?.evidence_scope_id === scope.id) {
          throw new HttpError(409, 'STATE_CONFLICT', 'активный реестр уже закреплён на этом снимке', { current: { reason: 'same_scope', registryId: current.id } }, target);
        }
        const created = await createRequirementRegistry(client, { tenderId: stage.tender_id, stageId: stage.id, evidenceScopeId: scope.id, reason: body.reason, userId: ctx.principal.userId });
        return {
          status: 201,
          body: { ...toRegistry(created.registry), carry: created.carry },
          audit: [
            {
              action: 'requirement.registry.create',
              entityType: 'requirement_registry',
              entityId: created.registry.id,
              tenderId: stage.tender_id,
              details: { seq: created.registry.seq, previousRegistryId: created.previous, evidenceScopeId: scope.id, carry: created.carry },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/requirement-registries/:id/completeness',
    query(pool, 'requirement.completeness.read', 'requirement_registry', async (ctx, req, res) => {
      const registry = await loadRegistryWith(pool, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.read');
      const items = new Map((await evidenceScopeItems(pool, registry.evidence_scope_id)).map((i) => [i.item_id, i]));
      const scope = await getEvidenceScope(pool, ctx, registry.evidence_scope_id);
      const projected = scope ? toEvidenceScope(scope, [...items.values()], new Set(readableContractIds(ctx)), new Set(readableMailboxIds(ctx))).items ?? [] : [];
      const byItem = new Map([...items.keys()].map((id, i) => [id, projected[i]]));
      res.json({
        registry: toRegistry(registry),
        counts: await registryCompleteness(pool, registry.id),
        units: (await unitCompleteness(pool, registry.id)).map((u) => ({
          scopeItemId: u.scope_item_id,
          unitType: u.unit_type,
          technicalStatus: u.technical_status,
          total: u.total,
          covered: u.covered,
          reviewed: u.reviewed,
          explicitNotRequirement: u.explicit_not_requirement,
          unreviewed: u.unreviewed,
          unit: byItem.get(u.scope_item_id) ?? null,
        })),
        reviews: (await listRegistryReviews(pool, registry.id)).map((r) => ({ ...r, completed_at: r.completed_at.toISOString() })),
      });
    }),
  );

  router.get(
    '/requirement-registries/:id/fragments',
    query(pool, 'requirement.completeness.fragments', 'requirement_registry', async (ctx, req, res) => {
      const registry = await loadRegistryWith(pool, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.read');
      const scopeItemId = typeof req.query.scopeItemId === 'string' && /^[0-9a-f-]{36}$/u.test(req.query.scopeItemId) ? req.query.scopeItemId : null;
      const state = REVIEW_STATES.find((s) => s === req.query.state) ?? null;
      const rows = await fragmentStates(pool, registry.id, { scopeItemId, state, limit: intParam(req.query.limit, 200, 500), offset: intParam(req.query.offset, 0, 1_000_000) });
      const readable = await readableFragments(pool, ctx, rows.map((r) => r.fragment_id));
      res.json({
        items: rows.map((r) => ({
          fragmentId: r.fragment_id,
          scopeItemId: r.scope_item_id,
          state: r.state,
          restricted: !readable.has(r.fragment_id),
          origin: readable.has(r.fragment_id) ? r.origin : null,
          pageIndex: readable.has(r.fragment_id) ? r.page_index : null,
          text: readable.has(r.fragment_id) ? r.text : null,
        })),
      });
    }),
  );

  router.post(
    '/requirement-registries/:id/marks',
    command(pool, {
      action: 'requirement.registry.mark',
      entityType: 'requirement_registry',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.create')),
      run: async (client, ctx, req) => {
        const body = parseBody(MarkFragmentsRequest, req.body);
        const registry = await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.create');
        const target = { tenderId: registry.tender_id, entityType: 'requirement_registry', entityId: registry.id };
        requireActiveRegistry(registry.active, target);
        const ids = await expandMarkSelector(client, registry.id, body.selector as MarkSelector, body.mark);
        if (ids.length === 0) throw new HttpError(409, 'STATE_CONFLICT', 'селектор не дал ни одного фрагмента прохода', { current: { reason: 'empty_selection' } }, target);
        // Отмечает только то, что пользователь может прочитать: «не требование» без чтения — не просмотр.
        const readable = await readableFragments(client, ctx, ids);
        if (readable.size !== ids.length) {
          throw new HttpError(409, 'STATE_CONFLICT', 'в выборке есть фрагменты, которые вы не можете читать', { current: { reason: 'restricted_fragments', restricted: ids.length - readable.size } }, target);
        }
        const batchId = await markFragments(client, { tenderId: registry.tender_id, registryId: registry.id, selector: body.selector as MarkSelector, mark: body.mark, reason: body.reason ?? null, fragmentIds: ids, userId: ctx.principal.userId });
        return {
          status: 201,
          body: { batchId, fragmentIds: ids, counts: await registryCompleteness(client, registry.id) },
          audit: [{ action: 'requirement.registry.mark', entityType: 'requirement_registry', entityId: registry.id, tenderId: registry.tender_id, details: { batchId, selectorKind: body.selector.kind, mark: body.mark, fragments: ids.length } }],
        };
      },
    }),
  );

  router.post(
    '/requirement-registries/:id/reviews',
    command(pool, {
      action: 'requirement.registry.review.complete',
      entityType: 'requirement_registry',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.manage')),
      run: async (client, ctx, req) => {
        const registry = await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.manage');
        const target = { tenderId: registry.tender_id, entityType: 'requirement_registry', entityId: registry.id };
        requireActiveRegistry(registry.active, target);
        // Завершает проход только тот, кто может прочитать все фрагменты прохода (И-08-8).
        const all = await reviewableScopeFragments(client, registry.evidence_scope_id);
        const readable = await readableFragments(client, ctx, all.map((f) => f.id));
        if (readable.size !== all.length) {
          throw new HttpError(409, 'STATE_CONFLICT', 'часть фрагментов прохода вам недоступна — завершить проход нельзя', { current: { reason: 'restricted_fragments', restricted: all.length - readable.size } }, target);
        }
        const done = await completeRegistryReview(client, { tenderId: registry.tender_id, registryId: registry.id, userId: ctx.principal.userId });
        if ('unreviewed' in done) {
          throw new HttpError(409, 'STATE_CONFLICT', `непросмотренных фрагментов: ${done.unreviewed} — реестр не полон`, { current: { reason: 'unreviewed', unreviewed: done.unreviewed } }, target);
        }
        return {
          status: 201,
          body: { id: done.id, counts: done.counts },
          audit: [{ action: 'requirement.registry.review.complete', entityType: 'requirement_registry', entityId: registry.id, tenderId: registry.tender_id, details: { reviewId: done.id, ...done.counts } }],
        };
      },
    }),
  );

  router.post(
    '/requirement-registries/:id/analysis-runs',
    command(pool, {
      action: 'analysis.run.request',
      entityType: 'analysis_run',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'analysis.run')),
      run: async (client, ctx, req) => {
        const body = parseBody(StartAnalysisRunRequest, req.body);
        const registry = await loadRegistryWith(client, ctx, uuidParam(req, 'id', 'requirement_registry'), 'analysis.run');
        const target = { tenderId: registry.tender_id, entityType: 'requirement_registry', entityId: registry.id };
        requireActiveRegistry(registry.active, target);
        // Правила (D-028) — кандидаты требований из фактов графа D-018, модель не нужна; иначе — генеративная модель.
        const rules = body.method === 'rules';
        const chat = rules ? null : createChatModel(config.chatModel);
        if (!rules && !chat) throw new HttpError(409, 'STATE_CONFLICT', 'генеративная модель не настроена (MODEL_PROVIDER=none)', { current: { reason: 'model_not_configured' } }, target);
        // Вход — допустимые фрагменты снимка, которые запустивший может читать (OD-08-1 «Запрет», И-08-2).
        const all = await reviewableScopeFragments(client, registry.evidence_scope_id);
        const readable = await readableFragments(client, ctx, all.map((f) => f.id));
        const inputs = all.filter((f) => readable.has(f.id));
        const kinds = body.task === 'fact_extraction' ? await factKindCodes(client) : [];
        const system = rules ? `rules:${FACT_RULES_VERSION}:requirement_candidate` : systemPrompt(body.task, kinds);
        const inference = chat ? chat.inferenceConfig : { rulesVersion: FACT_RULES_VERSION };
        const { run, created } = await createAnalysisRun(client, {
          registryId: registry.id,
          tenderId: registry.tender_id,
          stageId: registry.stage_id,
          evidenceScopeId: registry.evidence_scope_id,
          task: body.task,
          providerId: chat ? chat.providerId : RULES_PROVIDER,
          modelId: chat ? chat.model : 'evidence_fact',
          modelVersion: chat ? chat.version : FACT_RULES_VERSION,
          promptVersion: rules ? 'rules' : PROMPT_VERSION[body.task],
          promptSha256: sha256Hex(system),
          inferenceConfig: inference,
          configSha256: configHash(inference),
          outputSchemaVersion: OUTPUT_SCHEMA_VERSION[body.task],
          inputSha256: analysisInputHash(inputs.map((f) => ({ id: f.id, textSha256: f.text_sha256 }))),
          inputFragmentIds: inputs.map((f) => f.id),
          requestedBy: ctx.principal.userId,
        });
        return {
          status: created ? 201 : 200,
          body: { ...toAnalysisRun(run, false), reused: !created, excludedByAccess: all.length - inputs.length },
          audit: [
            {
              action: 'analysis.run.request',
              entityType: 'analysis_run',
              entityId: run.id,
              tenderId: registry.tender_id,
              details: { task: body.task, reused: !created, inputCount: inputs.length, inputSha256: run.input_sha256, provider: run.provider_id, model: run.model_id, attempt: run.attempt },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/requirement-registries/:id/analysis-runs',
    query(pool, 'analysis.run.list', 'requirement_registry', async (ctx, req, res) => {
      const registry = await loadRegistryWith(pool, ctx, uuidParam(req, 'id', 'requirement_registry'), 'requirement.read');
      res.json({ items: (await listAnalysisRuns(pool, registry.id)).map((r) => toAnalysisRun(r, false)) });
    }),
  );

  router.get(
    '/analysis-runs/:id',
    query(pool, 'analysis.run.read', 'analysis_run', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'analysis_run');
      const run = requireInScope(ctx, await getAnalysisRun(pool, id), 'analysis_run', id, 'requirement.read');
      const inputs = await analysisRunInputIds(pool, run.id);
      const readable = await readableFragments(pool, ctx, inputs);
      res.json(toAnalysisRun(run, readable.size === inputs.length));
    }),
  );

  router.get(
    '/fact-kinds',
    query(pool, 'fact.kind.list', 'fact_kind', async (_ctx, _req, res) => {
      res.json({ items: (await listFactKinds(pool)).map((k) => ({ code: k.code, title: k.title, valueType: k.value_type, normativeSource: k.normative_source })) });
    }),
  );

  return router;
};
