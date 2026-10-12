// Разногласия, гипотезы модели и приоритет источников этапа 09 (D-029; portal-api §2.7 в редакции этапа 09). Оси
// разногласия — события человека с основаниями (I08, I09); решение по разногласию о фактах D-018 пишет ребро графа той же
// транзакцией (В-09-2); гипотеза становится замечанием только решением человека (I11, I12); приоритет меняет
// руководитель (В-09-1). Вторая линия — охранники БД миграции 0024.
import {
  AcceptSuggestionRequest,
  AxisEventRequest,
  CreateDiscrepancyRequest,
  DiscrepancyDecisionRequest,
  RejectSuggestionRequest,
  SourcePriorityRequest,
} from '@kontur/contracts';
import { DEFAULT_SOURCE_PRIORITY, isAxisValue, SOURCE_KIND_TITLES, WRITTEN_BASIS_VALUES, WRITTEN_ORIGINS, type SourceKind } from '@kontur/core';
import {
  acceptSuggestion,
  axisEvents,
  contractCaps,
  createDiscrepancy,
  decisionsFor,
  evidenceFactOwner,
  findingEvidence,
  getDiscrepancy,
  getFinding,
  getSuggestion,
  insertAxisEvent,
  insertFactDecision,
  insertReviewDecision,
  insertSourcePriority,
  listDiscrepancies,
  lockTenderStages,
  readableFragments,
  recomputeOwnerGraph,
  rejectSuggestion,
  sourcePriorityRevisions,
  type IAccessContext,
  type Pool,
  type PoolClient,
  type Queryable,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { forbidden, HttpError } from '../http/errors.ts';
import { discrepancyView, findingDetail, reviewVisibility, suggestionView } from '../reviewMappers.ts';
import { loadStageWith, requireInScope } from './requirementScope.ts';
import { conflict, loadFinding, requireFindingCurrent, requireFindingVisible, stageVersion, syncStageForDecision } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';
import { loadTender, requireTenderCap } from './tenders.ts';

export const discrepanciesRouter = (pool: Pool): Router => {
  const router = Router();

  // ---------------------------------------------------------------- Разногласия

  router.post(
    '/findings/:id/discrepancy',
    command(pool, {
      action: 'discrepancy.create',
      entityType: 'discrepancy',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadFinding(client, ctx, uuidParam(req, 'id', 'finding'), 'finding.write')),
      prepare: async (client, ctx, req) => syncStageForDecision(client, (await loadFinding(client, ctx, uuidParam(req, 'id', 'finding'), 'finding.write')).stage_id),
      run: async (client, ctx, req) => {
        const body = parseBody(CreateDiscrepancyRequest, req.body);
        const probe = await loadFinding(client, ctx, uuidParam(req, 'id', 'finding'), 'finding.write');
        await syncStageForDecision(client, probe.stage_id);
        const f = await loadFinding(client, ctx, probe.id, 'finding.write', true);
        await requireFindingVisible(client, ctx, f);
        requireFindingCurrent(f);
        if (f.discrepancy_id) throw conflict('у замечания уже есть разногласие', 'discrepancy_exists', { tenderId: f.tender_id, entityType: 'finding', entityId: f.id }, { discrepancyId: f.discrepancy_id });
        const id = await createDiscrepancy(client, { tenderId: f.tender_id, stageId: f.stage_id, findingId: f.id, topic: body.topic, userId: ctx.principal.userId });
        return {
          status: 201,
          body: await findingDetail(client, ctx, (await getFinding(client, f.id))!),
          audit: [{ action: 'discrepancy.create', entityType: 'discrepancy', entityId: id, tenderId: f.tender_id, details: { findingId: f.id } }],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/discrepancies',
    query(pool, 'discrepancy.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'tender.read');
      const rows = await listDiscrepancies(pool, stage.id);
      const events = await axisEvents(pool, rows.map((d) => d.id));
      const evidence = await findingEvidence(pool, rows.map((d) => d.finding_id));
      const vis = await reviewVisibility(pool, ctx, stage.id, evidence, {
        fragments: events.flatMap((e) => e.bases.map((b) => b.fragment_id).filter((x): x is string => !!x)),
        mailRevisions: events.flatMap((e) => e.bases.map((b) => b.mail_message_revision_id).filter((x): x is string => !!x)),
        documentRevisions: events.flatMap((e) => e.bases.map((b) => b.document_revision_id).filter((x): x is string => !!x)),
      });
      const decisions = await decisionsFor(pool, rows.map((d) => d.id));
      res.json({ items: rows.map((d) => discrepancyView(d, events.filter((e) => e.discrepancy_id === d.id), vis.finding(d.finding_id), vis, decisions)) });
    }),
  );

  const loadDiscrepancy = async (db: Queryable, ctx: IAccessContext, id: string, cap: Parameters<typeof requireInScope>[4]) => requireInScope(ctx, await getDiscrepancy(db, id), 'discrepancy', id, cap);

  router.post(
    '/discrepancies/:id/status-events',
    command(pool, {
      action: 'discrepancy.axis',
      entityType: 'discrepancy',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadDiscrepancy(client, ctx, uuidParam(req, 'id', 'discrepancy'), 'finding.write')),
      prepare: async (client, ctx, req) => syncStageForDecision(client, (await loadDiscrepancy(client, ctx, uuidParam(req, 'id', 'discrepancy'), 'finding.write')).stage_id),
      run: async (client, ctx, req) => {
        const d = await loadDiscrepancy(client, ctx, uuidParam(req, 'id', 'discrepancy'), 'finding.write');
        const body = parseBody(AxisEventRequest, req.body);
        const target = { tenderId: d.tender_id, entityType: 'discrepancy', entityId: d.id };
        if (!isAxisValue(body.axis, body.value)) throw new HttpError(400, 'VALIDATION_FAILED', `значение «${body.value}» не относится к оси ${body.axis}`, {}, target);
        await syncStageForDecision(client, d.stage_id);
        const f = (await getFinding(client, d.finding_id))!;
        await requireFindingVisible(client, ctx, f);
        requireFindingCurrent(f);
        // Первая линия правил оснований (вторая — discrepancy_event_basis_check): подсказка — не основание; письменное
        // основание для согласия и отказа; речь переговоров — не выше «обсуждено устно» (I08, A03).
        const fragmentIds = body.bases.filter((b) => b.type === 'fragment').map((b) => b.id);
        const origins = fragmentIds.length
          ? (await client.query<{ origin: string }>('SELECT origin FROM evidence_fragment WHERE id = ANY($1::uuid[])', [fragmentIds])).rows.map((x) => x.origin)
          : [];
        if (origins.includes('negotiation_hint')) throw conflict('подсказка переговоров не основание позиции заказчика', 'hint_not_basis', target);
        const written = origins.some((o) => WRITTEN_ORIGINS.includes(o)) || body.bases.some((b) => ['mail_message_revision', 'document_revision', 'qa_item_revision'].includes(b.type));
        if (WRITTEN_BASIS_VALUES.includes(body.value) && !written) throw conflict(`«${body.value}» — только с письменным основанием`, 'written_basis_required', target);
        const id = await insertAxisEvent(client, { discrepancy: d, axis: body.axis, value: body.value, reason: body.reason, userId: ctx.principal.userId, bases: body.bases });
        return {
          status: 201,
          body: await findingDetail(client, ctx, (await getFinding(client, d.finding_id))!),
          audit: [{ action: 'discrepancy.axis', entityType: 'discrepancy', entityId: d.id, tenderId: d.tender_id, details: { eventId: id, axis: body.axis, value: body.value, bases: body.bases.length } }],
        };
      },
    }),
  );

  // Решение по разногласию. Обе стороны замечания — факты D-018: та же транзакция пишет ребро графа и пересчитывает граф
  // (D-029 В-09-2); право на граф — как у экрана фактов (тендер — fact.confirm, договор — contract.manage).
  router.post(
    '/discrepancies/:id/decisions',
    command(pool, {
      action: 'discrepancy.decision',
      entityType: 'discrepancy',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadDiscrepancy(client, ctx, uuidParam(req, 'id', 'discrepancy'), 'requirement.decide')),
      prepare: async (client, ctx, req) => syncStageForDecision(client, (await loadDiscrepancy(client, ctx, uuidParam(req, 'id', 'discrepancy'), 'requirement.decide')).stage_id),
      run: async (client, ctx, req) => {
        const probe = await loadDiscrepancy(client, ctx, uuidParam(req, 'id', 'discrepancy'), 'requirement.decide');
        const body = parseBody(DiscrepancyDecisionRequest, req.body);
        const target = { tenderId: probe.tender_id, entityType: 'discrepancy', entityId: probe.id };
        await lockTenderStages(client, probe.tender_id, [probe.stage_id]);
        // Актуальность основания (R09-03): события этапа обрабатываются здесь; по «устаревшему» замечанию решения нет —
        // ни по разногласию, ни по графу D-018.
        await syncStageForDecision(client, probe.stage_id);
        const f = (await getFinding(client, probe.finding_id, true))!;
        await requireFindingVisible(client, ctx, f);
        requireFindingCurrent(f);
        const evidence = await findingEvidence(client, [f.id]);
        const left = evidence.filter((e) => e.side === 'left' && e.evidence_fact_id).map((e) => e.evidence_fact_id!);
        const right = evidence.filter((e) => e.side === 'right' && e.evidence_fact_id).map((e) => e.evidence_fact_id!);
        const linked = left.length > 0 && right.length > 0;
        if (!linked && body.graph) throw conflict('стороны разногласия не связаны с фактами D-018: решение по графу не создаётся', 'no_fact_link', target);
        if (linked && !body.graph) throw conflict('стороны — факты D-018: укажите, какое значение действует, или что значения не конфликтуют', 'graph_decision_required', target, { left, right });
        let graph: { decisionId: string; hash: string } | null = null;
        if (linked && body.graph) {
          const [a, b] = body.graph.kind === 'prevails'
            ? [body.graph.prevailingFactId, [...left, ...right].includes(body.graph.prevailingFactId) ? (left.includes(body.graph.prevailingFactId) ? right[0]! : left[0]!) : null]
            : [left[0]!, right[0]!];
          if (!a || !b) throw conflict('действующее значение — один из фактов сторон разногласия', 'fact_not_in_discrepancy', target);
          const owner = await evidenceFactOwner(client, a);
          const other = await evidenceFactOwner(client, b);
          if (!owner || !other || owner.tenderId !== other.tenderId || owner.contractId !== other.contractId) {
            throw conflict('факты сторон — разных владельцев графа', 'fact_owner_mismatch', target);
          }
          const canGraph = owner.contractId ? contractCaps(ctx, owner.contractId).includes('contract.manage') : hasTenderCap(ctx, owner.tenderId!, 'fact.confirm');
          if (!canGraph) throw forbidden(owner.contractId ? 'contract.manage' : 'fact.confirm', target);
          const decisionId = await insertFactDecision(client, { owner, factId: a, otherFactId: b, kind: body.graph.kind, reason: body.rationale.slice(0, 2000), userId: ctx.principal.userId });
          graph = { decisionId, hash: (await recomputeOwnerGraph(client, owner)).hash };
        }
        const decisionId = await insertReviewDecision(client, {
          tenderId: probe.tender_id,
          stageId: probe.stage_id,
          type: 'discrepancy_decision',
          subjectType: 'discrepancy',
          subjectId: probe.id,
          statement: body.statement,
          rationale: body.rationale,
          userId: ctx.principal.userId,
        });
        return {
          status: 201,
          body: { decisionId, factDecisionId: graph?.decisionId ?? null, finding: await findingDetail(client, ctx, (await getFinding(client, f.id))!) },
          audit: [{ action: 'discrepancy.decision', entityType: 'discrepancy', entityId: probe.id, tenderId: probe.tender_id, details: { decisionId, factDecisionId: graph?.decisionId ?? null, graphHash: graph?.hash ?? null } }],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Гипотезы модели

  const loadSuggestion = async (db: PoolClient, ctx: IAccessContext, id: string, lock = false) => requireInScope(ctx, await getSuggestion(db, id, lock), 'model_suggestion', id, 'finding.write');
  // Сначала этап и его события (гипотеза могла истечь), затем строка гипотезы — порядок блокировок как у инвалидации.
  const loadSuggestionCurrent = async (db: PoolClient, ctx: IAccessContext, id: string) => {
    const probe = await loadSuggestion(db, ctx, id);
    await syncStageForDecision(db, probe.stage_id);
    return loadSuggestion(db, ctx, id, true);
  };

  router.post(
    '/model-suggestions/:id/accept',
    command(pool, {
      action: 'model_suggestion.accept',
      entityType: 'model_suggestion',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadSuggestion(client, ctx, uuidParam(req, 'id', 'model_suggestion'))),
      prepare: async (client, ctx, req) => syncStageForDecision(client, (await loadSuggestion(client, ctx, uuidParam(req, 'id', 'model_suggestion'))).stage_id),
      run: async (client, ctx, req) => {
        const s = await loadSuggestionCurrent(client, ctx, uuidParam(req, 'id', 'model_suggestion'));
        const body = parseBody(AcceptSuggestionRequest, req.body);
        const target = { tenderId: s.tender_id, entityType: 'model_suggestion', entityId: s.id };
        if (s.status !== 'open') throw conflict('гипотеза уже решена или истекла', 'suggestion_not_open', target, { status: s.status });
        const findingId = await acceptSuggestion(client, s, { userId: ctx.principal.userId, severity: body.severity, reason: body.reason ?? null, inputVersion: await stageVersion(client, s.stage_id) });
        const f = (await getFinding(client, findingId))!;
        await requireFindingVisible(client, ctx, f);
        return {
          status: 201,
          body: await findingDetail(client, ctx, f),
          audit: [{ action: 'model_suggestion.accept', entityType: 'model_suggestion', entityId: s.id, tenderId: s.tender_id, details: { findingId, severity: body.severity } }],
        };
      },
    }),
  );

  router.post(
    '/model-suggestions/:id/reject',
    command(pool, {
      action: 'model_suggestion.reject',
      entityType: 'model_suggestion',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadSuggestion(client, ctx, uuidParam(req, 'id', 'model_suggestion'))),
      run: async (client, ctx, req) => {
        const s = await loadSuggestionCurrent(client, ctx, uuidParam(req, 'id', 'model_suggestion'));
        const body = parseBody(RejectSuggestionRequest, req.body);
        if (s.status !== 'open') throw conflict('гипотеза уже решена или истекла', 'suggestion_not_open', { tenderId: s.tender_id, entityType: 'model_suggestion', entityId: s.id }, { status: s.status });
        // Нельзя решать по тому, чего не можешь прочитать (R08-02): текст и обоснование гипотезы закрыты вместе с её
        // основаниями — тем же правилом, что при чтении прогона; иначе ответ команды отдал бы их в обход прав (S15a-01).
        const fragmentIds = s.evidence.map((e) => e.fragment_id).filter((x): x is string => !!x);
        const readable = await readableFragments(client, ctx, fragmentIds);
        if (fragmentIds.some((f) => !readable.has(f))) {
          throw conflict('среди оснований гипотезы есть то, что вы не можете читать', 'restricted_fragments', { tenderId: s.tender_id, entityType: 'model_suggestion', entityId: s.id });
        }
        await rejectSuggestion(client, s, ctx.principal.userId, body.reason);
        return {
          status: 200,
          body: suggestionView((await getSuggestion(client, s.id))!, true),
          audit: [{ action: 'model_suggestion.reject', entityType: 'model_suggestion', entityId: s.id, tenderId: s.tender_id, details: {} }],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Приоритет источников (D-029 В-09-1)

  const priorityView = async (db: Queryable, ctx: IAccessContext, tenderId: string) => {
    const revisions = await sourcePriorityRevisions(db, tenderId);
    const kinds = (revisions[0]?.kinds ?? [...DEFAULT_SOURCE_PRIORITY]) as SourceKind[];
    return {
      tenderId,
      isDefault: revisions.length === 0,
      kinds: kinds.map((k) => ({ kind: k, title: SOURCE_KIND_TITLES[k] })),
      revisions: revisions.map((r) => ({ id: r.id, seq: r.seq, kinds: r.kinds, reason: r.reason, createdBy: r.created_by_name, createdAt: r.created_at.toISOString() })),
      canManage: hasTenderCap(ctx, tenderId, 'source_priority.manage'),
      note: 'Приоритет подсказывает предлагаемую сторону конфликта; конфликт решает человек, дата приоритетом не является.',
    };
  };

  router.get(
    '/tenders/:id/source-priority',
    query(pool, 'source_priority.read', 'tender', async (ctx, req, res) => {
      const t = await loadTender(pool, ctx, uuidParam(req, 'id', 'tender'));
      requireTenderCap(ctx, t, 'tender.read');
      res.json(await priorityView(pool, ctx, t.id));
    }),
  );

  router.post(
    '/tenders/:id/source-priority',
    command(pool, {
      action: 'source_priority.update',
      entityType: 'tender',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const t = await loadTender(client, ctx, uuidParam(req, 'id', 'tender'));
        requireTenderCap(ctx, t, 'source_priority.manage');
      },
      run: async (client, ctx, req) => {
        const t = await loadTender(client, ctx, uuidParam(req, 'id', 'tender'));
        requireTenderCap(ctx, t, 'source_priority.manage');
        const body = parseBody(SourcePriorityRequest, req.body);
        const id = await insertSourcePriority(client, { tenderId: t.id, kinds: body.kinds, reason: body.reason, userId: ctx.principal.userId });
        return {
          status: 201,
          body: await priorityView(client, ctx, t.id),
          audit: [{ action: 'source_priority.update', entityType: 'source_priority_revision', entityId: id, tenderId: t.id, details: { kinds: body.kinds } }],
        };
      },
    }),
  );

  return router;
};
