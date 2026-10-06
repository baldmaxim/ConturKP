// Экономика этапа 10 (D-030; docs/architecture/10-economics-design.md §7; portal-api §2.5, §2.10 в редакции этапа 10):
// отчёт ревизии, сравнение двух ревизий одного тендера, решения по парам позиций, причины изменений и гипотезы модели.
// Первая линия — права участника тендера (economics.compare, calculation.capture, change_reason.confirm), вторая —
// охранники миграции 0026. Невидимый объект — 404, видимый без права — 403. Решения по причинам и гипотезам — только по
// актуальным основаниям: команда сама обрабатывает поступившие события этапа (как R09-01).
import { createChatModel } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import { formatEtag, parseIfMatch } from '@kontur/core';
import {
  ComparisonUnitsQuery,
  CreateComparisonRequest,
  DecideReasonSuggestionRequest,
  DeviationLinesQuery,
  ExplanationRequest,
  LineageDecisionsRequest,
  StartReasonRunRequest,
} from '@kontur/contracts';
import {
  ambiguousGroups,
  appendExplanation,
  appendHumanLineage,
  comparisonSummary,
  comparisonUnits,
  createComparison,
  createReasonRun,
  currentExplanations,
  currentLineage,
  decideReasonSuggestion,
  ensureRevisionEconomics,
  explanationHistory,
  explanationVersion,
  getCalculationRevision,
  getComparison,
  getComparisonUnit,
  getReasonRun,
  getReasonSuggestion,
  getRevisionEconomics,
  lineageSeq,
  listComparisons,
  listReasonRuns,
  listReasonSuggestions,
  loadEconomicsRevision,
  lockStageForReview,
  positionBriefs,
  readableFragments,
  revisionDeviationLines,
  supersededBases,
  withTransaction,
  type IAccessContext,
  type IComparisonRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import { Router, type Request } from 'express';
import { command, parseBody, query, uuidParam, versionConflict } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import {
  toComparison,
  toComparisonBrief,
  toDeviationLine,
  toExplanation,
  toLineageRow,
  toPositionBrief,
  toReasonRun,
  toRevisionEconomics,
  toSuggestion,
  toUnit,
} from '../economicsMappers.ts';
import { loadStageWith } from './requirementScope.ts';
import { conflict, syncStageForDecision } from './reviewScope.ts';
import { requireTenderCapById } from './scope.ts';

// If-Match производной версии: "<id>:<n>".
const requireDerivedIfMatch = (req: Request, id: string): number => {
  const parsed = parseIfMatch(req.header('if-match'));
  if (parsed.kind === 'missing') throw new HttpError(428, 'PRECONDITION_REQUIRED', 'изменение требует заголовка If-Match');
  if (parsed.kind === 'invalid' || parsed.id !== id) throw new HttpError(412, 'VERSION_CONFLICT', 'If-Match не относится к этому объекту');
  return parsed.rowVersion;
};

const loadRevision = async (db: Queryable, ctx: IAccessContext, id: string) => {
  const r = await getCalculationRevision(db, ctx, id);
  if (!r) throw notFound({ entityType: 'calculation_revision', entityId: id });
  requireTenderCapById(ctx, r.tender_id, 'tender.read', { entityType: 'calculation_revision', entityId: id });
  return r;
};

const loadComparison = async (db: Queryable, ctx: IAccessContext, id: string, cap: Parameters<typeof requireTenderCapById>[2] = 'tender.read'): Promise<IComparisonRow> => {
  const c = await getComparison(db, ctx, id);
  if (!c) throw notFound({ entityType: 'calculation_comparison', entityId: id });
  requireTenderCapById(ctx, c.tender_id, cap, { entityType: 'calculation_comparison', entityId: id });
  return c;
};

const loadUnit = async (db: Queryable, ctx: IAccessContext, id: string, cap: Parameters<typeof requireTenderCapById>[2]) => {
  const u = await getComparisonUnit(db, id);
  if (!u) throw notFound({ entityType: 'comparison_unit', entityId: id });
  const c = await loadComparison(db, ctx, u.comparison_id, cap);
  return { unit: u, comparison: c };
};

const target = (c: IComparisonRow) => ({ tenderId: c.tender_id, entityType: 'calculation_comparison', entityId: c.id });

// Новая версия причины — только по действующим основаниям (R10-01): заменённая редакция, распознавание, состав
// источников или решение — отказ до записи; вторая линия — триггеры 0027.
const rejectSupersededBases = async (db: Queryable, c: IComparisonRow, fragmentIds: readonly string[], decisionIds: readonly string[]): Promise<void> => {
  const stale = await supersededBases(db, c.stage_id, fragmentIds, decisionIds);
  if (stale.length > 0) {
    throw conflict('основание заменено (новая редакция, распознавание, состав источников или решение): выберите действующее основание', 'basis_superseded', target(c), { superseded: stale });
  }
};

// Производный текст причины и гипотезы — целиком, только если пользователь читает все основания (R08-02).
const visibilityOf = async (db: Queryable, ctx: IAccessContext, fragmentIds: readonly string[]) => {
  const readable = await readableFragments(db, ctx, fragmentIds);
  return (ids: readonly (string | null)[]) => ids.every((id) => id === null || readable.has(id));
};

const unitsView = async (db: Queryable, ctx: IAccessContext, c: IComparisonRow, q: { kind: string | null; changedOnly: boolean; afterNo: number; limit: number }) => {
  const rows = await comparisonUnits(db, c.id, { ...q, limit: q.limit + 1 });
  const page = rows.slice(0, q.limit);
  const explanations = await currentExplanations(db, c.id);
  const suggestions = (await listReasonSuggestions(db, c.id)).filter((s) => s.status === 'open' || s.status === 'expired');
  const fragmentIds = [...[...explanations.values()].flatMap((e) => e.bases.map((b) => b.fragmentId).filter((x): x is string => !!x)), ...suggestions.flatMap((s) => s.evidence.map((f) => f.fragmentId))];
  const visible = await visibilityOf(db, ctx, fragmentIds);
  const versions = new Map<string, number>();
  for (const u of page) versions.set(u.id, await explanationVersion(db, u.id));
  return {
    items: page.map((u) => {
      const e = explanations.get(u.id);
      return toUnit(
        u,
        e ? toExplanation(e, visible(e.bases.map((b) => b.fragmentId))) : null,
        suggestions.filter((s) => s.unit_id === u.id).map((s) => toSuggestion(s, visible(s.evidence.map((f) => f.fragmentId)))),
        versions.get(u.id) ?? 0,
      );
    }),
    hasMore: rows.length > q.limit,
    nextAfter: rows.length > q.limit ? page[page.length - 1]!.unit_no : null,
  };
};

export const economicsRouter = (pool: Pool, config: IAppConfig): Router => {
  const router = Router();

  // ---------------------------------------------------------------- Отчёт ревизии

  // Отчёт пишется при первом запросе и далее неизменен (ревизия неизменна — отчёт детерминирован).
  router.get(
    '/calculation-revisions/:id/economics',
    query(pool, 'economics.report.read', 'calculation_revision', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'calculation_revision');
      await loadRevision(pool, ctx, id);
      const row = (await getRevisionEconomics(pool, id)) ?? (await withTransaction(pool, (client) => ensureRevisionEconomics(client, id, ctx.principal.userId)));
      const rev = await loadEconomicsRevision(pool, id);
      if (!row || !rev) throw notFound({ entityType: 'calculation_revision', entityId: id });
      res.json(toRevisionEconomics(rev, row));
    }),
  );

  router.get(
    '/calculation-revisions/:id/economics/deviations',
    query(pool, 'economics.report.read', 'calculation_revision', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'calculation_revision');
      await loadRevision(pool, ctx, id);
      const q = parseBody(DeviationLinesQuery, req.query);
      const row = (await getRevisionEconomics(pool, id)) ?? (await withTransaction(pool, (client) => ensureRevisionEconomics(client, id, ctx.principal.userId)));
      if (!row) throw notFound({ entityType: 'calculation_revision', entityId: id });
      const rows = await revisionDeviationLines(pool, row.id, { flag: q.flag ?? null, after: q.after ?? null, limit: q.limit + 1 });
      const page = rows.slice(0, q.limit);
      res.json({ items: page.map(toDeviationLine), hasMore: rows.length > q.limit, nextAfter: rows.length > q.limit ? page[page.length - 1]!.external_item_id : null });
    }),
  );

  // ---------------------------------------------------------------- Сравнение

  router.post(
    '/stages/:id/comparisons',
    command(pool, {
      action: 'economics.comparison.create',
      entityType: 'calculation_comparison',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'economics.compare')),
      run: async (client, ctx, req) => {
        const stage = await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'economics.compare');
        const t = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        const body = parseBody(CreateComparisonRequest, req.body);
        const [left, right] = [await getCalculationRevision(client, ctx, body.leftRevisionId), await getCalculationRevision(client, ctx, body.rightRevisionId)];
        if (!left || !right || left.tender_id !== stage.tender_id || right.tender_id !== stage.tender_id) {
          throw new HttpError(400, 'VALIDATION_FAILED', 'сравниваются две ревизии расчёта тендера этого этапа', {}, t);
        }
        const r = await createComparison(client, {
          tenderId: stage.tender_id,
          stageId: stage.id,
          left: (await loadEconomicsRevision(client, left.id))!,
          right: (await loadEconomicsRevision(client, right.id))!,
          userId: ctx.principal.userId,
        });
        return {
          status: 201,
          body: {
            ...toComparisonBrief(r.comparison),
            proposals: { systemConfirmed: r.proposals.systemConfirmed.length, proposed: r.proposals.proposals.length, ambiguous: r.proposals.ambiguous.length },
          },
          audit: [
            {
              action: 'economics.comparison.create',
              entityType: 'calculation_comparison',
              entityId: r.comparison.id,
              tenderId: stage.tender_id,
              details: {
                stageId: stage.id,
                leftRevisionId: left.id,
                rightRevisionId: right.id,
                status: r.comparison.status,
                lineageSeq: r.comparison.lineage_seq,
                systemConfirmed: r.proposals.systemConfirmed.length,
                proposed: r.proposals.proposals.length,
              },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/comparisons',
    query(pool, 'economics.comparison.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'tender.read');
      res.json({ items: (await listComparisons(pool, stage.id)).map(toComparisonBrief) });
    }),
  );

  router.get(
    '/comparisons/:id',
    query(pool, 'economics.comparison.read', 'calculation_comparison', async (ctx, req, res) => {
      const c = await loadComparison(pool, ctx, uuidParam(req, 'id', 'calculation_comparison'));
      const [left, right] = [await loadEconomicsRevision(pool, c.left_revision_id), await loadEconomicsRevision(pool, c.right_revision_id)];
      const invalidated = (
        await pool.query<{ n: number }>(
          `SELECT count(DISTINCT e.id)::int AS n FROM change_explanation e JOIN evidence_invalidation i ON i.dependent_type = 'change_explanation' AND i.dependent_id = e.id
            WHERE e.comparison_id = $1 AND e.version = (SELECT max(x.version) FROM change_explanation x WHERE x.unit_id = e.unit_id)`,
          [c.id],
        )
      ).rows[0]!.n;
      res.json(
        toComparison(c, {
          summary: await comparisonSummary(pool, c.id),
          lineageSeqNow: await lineageSeq(pool, c.left_revision_id, c.right_revision_id),
          invalidatedExplanations: invalidated,
          left: { seq: left!.seq, observedAt: left!.observed_at?.toISOString() ?? null },
          right: { seq: right!.seq, observedAt: right!.observed_at?.toISOString() ?? null },
        }),
      );
    }),
  );

  router.get(
    '/comparisons/:id/units',
    query(pool, 'economics.comparison.read', 'calculation_comparison', async (ctx, req, res) => {
      const c = await loadComparison(pool, ctx, uuidParam(req, 'id', 'calculation_comparison'));
      const q = parseBody(ComparisonUnitsQuery, req.query);
      res.json(await unitsView(pool, ctx, c, { kind: q.kind ?? null, changedOnly: q.changed === 'true', afterNo: q.after, limit: q.limit }));
    }),
  );

  // ---------------------------------------------------------------- Сопоставление позиций

  router.get(
    '/comparisons/:id/lineage',
    query(pool, 'economics.lineage.read', 'calculation_comparison', async (ctx, req, res) => {
      const c = await loadComparison(pool, ctx, uuidParam(req, 'id', 'calculation_comparison'));
      const [left, right] = [(await loadEconomicsRevision(pool, c.left_revision_id))!, (await loadEconomicsRevision(pool, c.right_revision_id))!];
      const seq = await lineageSeq(pool, left.id, right.id);
      res.setHeader('ETag', formatEtag(c.id, seq));
      res.json({
        version: seq,
        comparisonLineageSeq: c.lineage_seq,
        left: (await positionBriefs(pool, left.content_id)).map(toPositionBrief),
        right: (await positionBriefs(pool, right.content_id)).map(toPositionBrief),
        items: (await currentLineage(pool, left.id, right.id)).map(toLineageRow),
        ambiguous: await ambiguousGroups(pool, left, right),
      });
    }),
  );

  // Решения инженера по парам (append-only). If-Match — последнее решение по паре ревизий: параллельная запись даёт 412,
  // а не смешение решений (I13).
  router.post(
    '/comparisons/:id/lineage-decisions',
    command(pool, {
      action: 'economics.lineage.decide',
      entityType: 'calculation_comparison',
      authorize: async (client, ctx, req) => void (await loadComparison(client, ctx, uuidParam(req, 'id', 'calculation_comparison'), 'calculation.capture')),
      run: async (client, ctx, req) => {
        const c = await loadComparison(client, ctx, uuidParam(req, 'id', 'calculation_comparison'), 'calculation.capture');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['economics.compare', `${c.left_revision_id}>${c.right_revision_id}`]);
        const seq = await lineageSeq(client, c.left_revision_id, c.right_revision_id);
        if (requireDerivedIfMatch(req, c.id) !== seq) throw versionConflict({ version: seq });
        const body = parseBody(LineageDecisionsRequest, req.body);
        const n = await appendHumanLineage(client, {
          tenderId: c.tender_id,
          leftId: c.left_revision_id,
          rightId: c.right_revision_id,
          userId: ctx.principal.userId,
          decisions: body.decisions.map((d) => ({ from: d.fromPositionId.toLowerCase(), to: d.toPositionId.toLowerCase(), status: d.status })),
        });
        const now = await lineageSeq(client, c.left_revision_id, c.right_revision_id);
        return {
          status: 201,
          body: { version: now, recorded: n },
          etag: formatEtag(c.id, now),
          audit: [
            {
              action: 'economics.lineage.decide',
              entityType: 'calculation_comparison',
              entityId: c.id,
              tenderId: c.tender_id,
              details: { recorded: n, confirmed: body.decisions.filter((d) => d.status === 'confirmed').length, rejected: body.decisions.filter((d) => d.status === 'rejected').length },
            },
          ],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Причины изменений

  router.get(
    '/comparison-units/:id/explanations',
    query(pool, 'economics.explanation.read', 'comparison_unit', async (ctx, req, res) => {
      const { unit } = await loadUnit(pool, ctx, uuidParam(req, 'id', 'comparison_unit'), 'tender.read');
      const rows = await explanationHistory(pool, unit.id);
      const visible = await visibilityOf(pool, ctx, rows.flatMap((e) => e.bases.map((b) => b.fragmentId).filter((x): x is string => !!x)));
      res.json({ items: rows.map((e) => toExplanation(e, visible(e.bases.map((b) => b.fragmentId)))) });
    }),
  );

  // Новая версия причины (I11, A23): If-Match — текущая версия по единице; основания должен читать сам автор.
  router.put(
    '/comparison-units/:id/explanation',
    command(pool, {
      action: 'economics.explanation.set',
      entityType: 'comparison_unit',
      authorize: async (client, ctx, req) => void (await loadUnit(client, ctx, uuidParam(req, 'id', 'comparison_unit'), 'change_reason.confirm')),
      prepare: async (client, ctx, req) => {
        const { comparison } = await loadUnit(client, ctx, uuidParam(req, 'id', 'comparison_unit'), 'change_reason.confirm');
        await syncStageForDecision(client, comparison.stage_id);
      },
      run: async (client, ctx, req) => {
        const { unit, comparison } = await loadUnit(client, ctx, uuidParam(req, 'id', 'comparison_unit'), 'change_reason.confirm');
        await lockStageForReview(client, comparison.stage_id);
        await syncStageForDecision(client, comparison.stage_id);
        const version = await explanationVersion(client, unit.id);
        if (requireDerivedIfMatch(req, unit.id) !== version) throw versionConflict({ version });
        const body = parseBody(ExplanationRequest, req.body);
        const readable = await readableFragments(client, ctx, body.fragmentIds);
        if (body.fragmentIds.some((f) => !readable.has(f.toLowerCase()))) {
          throw conflict('среди оснований есть фрагменты, которые вы не можете читать', 'restricted_fragments', target(comparison));
        }
        await rejectSupersededBases(client, comparison, body.fragmentIds.map((f) => f.toLowerCase()), body.decisionIds.map((d) => d.toLowerCase()));
        const id = await appendExplanation(client, {
          tenderId: comparison.tender_id,
          stageId: comparison.stage_id,
          comparisonId: comparison.id,
          unitId: unit.id,
          userId: ctx.principal.userId,
          reasonKind: body.reasonKind,
          reasonStatus: body.reasonStatus,
          rationale: body.rationale ?? null,
          fragmentIds: body.fragmentIds.map((f) => f.toLowerCase()),
          decisionIds: body.decisionIds.map((d) => d.toLowerCase()),
          suggestionId: null,
        });
        const history = await explanationHistory(client, unit.id);
        return {
          status: 200,
          body: { version: version + 1, explanation: toExplanation(history[0]!, true) },
          etag: formatEtag(unit.id, version + 1),
          audit: [
            {
              action: 'economics.explanation.set',
              entityType: 'comparison_unit',
              entityId: unit.id,
              tenderId: comparison.tender_id,
              details: { comparisonId: comparison.id, explanationId: id, version: version + 1, reasonKind: body.reasonKind, reasonStatus: body.reasonStatus, bases: body.fragmentIds.length + body.decisionIds.length },
            },
          ],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Гипотезы причин

  router.post(
    '/comparisons/:id/reason-runs',
    command(pool, {
      action: 'economics.reason_run.request',
      entityType: 'reason_run',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadComparison(client, ctx, uuidParam(req, 'id', 'calculation_comparison'), 'economics.compare')),
      run: async (client, ctx, req) => {
        const c = await loadComparison(client, ctx, uuidParam(req, 'id', 'calculation_comparison'), 'economics.compare');
        const body = parseBody(StartReasonRunRequest, req.body);
        if (c.status !== 'ready') throw conflict('сравнение не готово', 'comparison_not_ready', target(c));
        const chat = createChatModel(config.chatModel);
        const r = await createReasonRun(client, {
          tenderId: c.tender_id,
          stageId: c.stage_id,
          comparisonId: c.id,
          ctx,
          model: chat ? { providerId: chat.providerId, model: chat.model, version: chat.version } : null,
          unitIds: body.unitIds ? body.unitIds.map((u) => u.toLowerCase()) : null,
        });
        if (!r.ok && r.reason === 'no_scope') throw conflict('у этапа нет снимка области: зафиксируйте снимок источников', 'no_scope', target(c));
        if (!r.ok) throw conflict('нет изменившихся единиц без подтверждённой причины', 'no_units', target(c));
        return {
          status: 201,
          body: toReasonRun(r.run),
          audit: [
            {
              action: 'economics.reason_run.request',
              entityType: 'reason_run',
              entityId: r.run.id,
              tenderId: c.tender_id,
              details: { comparisonId: c.id, scopeId: r.run.evidence_scope_id, model: r.run.model_provider, units: body.unitIds?.length ?? null },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/comparisons/:id/reason-runs',
    query(pool, 'economics.reason_run.list', 'calculation_comparison', async (ctx, req, res) => {
      const c = await loadComparison(pool, ctx, uuidParam(req, 'id', 'calculation_comparison'));
      res.json({ items: (await listReasonRuns(pool, c.id)).map(toReasonRun) });
    }),
  );

  router.get(
    '/reason-runs/:id',
    query(pool, 'economics.reason_run.read', 'reason_run', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'reason_run');
      const run = await getReasonRun(pool, id);
      if (!run) throw notFound({ entityType: 'reason_run', entityId: id });
      await loadComparison(pool, ctx, run.comparison_id);
      res.json(toReasonRun(run));
    }),
  );

  const decide = (status: 'accepted' | 'rejected') =>
    command(pool, {
      action: status === 'accepted' ? 'economics.reason_suggestion.accept' : 'economics.reason_suggestion.reject',
      entityType: 'change_reason_suggestion',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'change_reason_suggestion');
        const s = await getReasonSuggestion(client, id);
        if (!s) throw notFound({ entityType: 'change_reason_suggestion', entityId: id });
        await loadComparison(client, ctx, s.comparison_id, 'change_reason.confirm');
      },
      prepare: async (client, _ctx, req) => {
        const s = await getReasonSuggestion(client, uuidParam(req, 'id', 'change_reason_suggestion'));
        if (s) await syncStageForDecision(client, s.stage_id);
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'change_reason_suggestion');
        const probe = (await getReasonSuggestion(client, id))!;
        const c = await loadComparison(client, ctx, probe.comparison_id, 'change_reason.confirm');
        await lockStageForReview(client, c.stage_id);
        await syncStageForDecision(client, c.stage_id);
        const s = (await getReasonSuggestion(client, id, true))!;
        if (requireDerivedIfMatch(req, s.id) !== s.row_version) throw versionConflict(toSuggestion(s, false));
        if (s.status === 'expired') throw conflict('основание гипотезы изменилось: гипотеза погашена', 'suggestion_expired', target(c));
        if (s.status !== 'open') throw conflict('гипотеза уже решена', 'suggestion_decided', target(c));
        const body = parseBody(DecideReasonSuggestionRequest, req.body);
        const fragments = s.evidence.map((f) => f.fragmentId);
        const readable = await readableFragments(client, ctx, fragments);
        if (fragments.some((f) => !readable.has(f))) throw conflict('среди оснований гипотезы есть то, что вы не можете читать', 'restricted_fragments', target(c));
        let explanationId: string | null = null;
        if (status === 'accepted') {
          await rejectSupersededBases(client, c, fragments, []);
          explanationId = await appendExplanation(client, {
            tenderId: c.tender_id,
            stageId: c.stage_id,
            comparisonId: c.id,
            unitId: s.unit_id,
            userId: ctx.principal.userId,
            reasonKind: s.reason_kind,
            reasonStatus: 'confirmed',
            rationale: s.rationale,
            fragmentIds: fragments,
            decisionIds: [],
            suggestionId: s.id,
          });
        }
        await decideReasonSuggestion(client, { id: s.id, userId: ctx.principal.userId, status, reason: body.reason ?? null, explanationId });
        const after = (await getReasonSuggestion(client, s.id))!;
        return {
          status: 200,
          body: toSuggestion(after, true),
          etag: formatEtag(after.id, after.row_version),
          audit: [
            {
              action: status === 'accepted' ? 'economics.reason_suggestion.accept' : 'economics.reason_suggestion.reject',
              entityType: 'change_reason_suggestion',
              entityId: s.id,
              tenderId: c.tender_id,
              details: { comparisonId: c.id, unitId: s.unit_id, reasonKind: s.reason_kind, explanationId },
            },
          ],
        };
      },
    });

  router.post('/change-reason-suggestions/:id/accept', decide('accepted'));
  router.post('/change-reason-suggestions/:id/reject', decide('rejected'));

  return router;
};
