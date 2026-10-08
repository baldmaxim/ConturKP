// Проекции этапа 09 (portal-api §2.7 в редакции этапа 09). Текст замечания, оснований, решений и осей производен от
// источников: он выдаётся, только если смотрящий читает все основания (R08-02, замыкание закрытости). Иначе — вид,
// статус и метаданные без текста. Сводка прогона не выводит «всё проверено» из неполного или устаревшего прогона.
import {
  FINDING_KIND_META,
  formatEtag,
  REVIEW_CHECK_TITLES,
  REVIEW_CHECKS,
  reviewSummary,
  SOURCE_KIND_TITLES,
  type FindingKind,
  type ReviewCheckCode,
  type SourceKind,
} from '@kontur/core';
import {
  axisEvents,
  stageEventClass,
  currentAxes,
  decisionsFor,
  eventsAfter,
  findingEvents,
  findingEvidence,
  findingInvalidations,
  findingOccurrences,
  getDiscrepancy,
  listSuggestions,
  readableDocumentRevisions,
  readableFragments,
  readableMailRevisions,
  reviewCheckResults,
  reviewRunInput,
  legacyStageContentFingerprint,
  legacyStageContentFingerprintV2,
  stageContentFingerprint,
  stageVisibility,
  type IAccessContext,
  type IAxisEventRow,
  type IDiscrepancyRow,
  type IFindingEvidenceRow,
  type IFindingRow,
  type IReviewRunRow,
  type ISuggestionRow,
  type Queryable,
} from '@kontur/db';
import { hasTenderCap } from './routes/scope.ts';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ---------------------------------------------------------------- Видимость

export interface IReviewVisibility {
  finding: (id: string) => boolean;
  fragment: (id: string) => boolean;
  documentRevision: (id: string) => boolean;
  mailRevision: (id: string) => boolean;
}

// Видимость замечаний этапа: все фрагменты оснований (и фрагменты фактов) читаются, требования и вопросы оснований
// видимы по замыканию закрытости этапа 08, редакции документов читаются.
export const reviewVisibility = async (db: Queryable, ctx: IAccessContext, stageId: string, evidence: readonly IFindingEvidenceRow[], extra: { fragments?: string[]; mailRevisions?: string[]; documentRevisions?: string[] } = {}): Promise<IReviewVisibility> => {
  const vis = await stageVisibility(db, ctx, stageId);
  const fragmentIds = [...evidence.flatMap((e) => [e.fragment_id, ...(e.fact_fragment_ids ?? [])]).filter((x): x is string => !!x), ...(extra.fragments ?? [])];
  const readable = await readableFragments(db, ctx, fragmentIds);
  const docs = await readableDocumentRevisions(db, ctx, [...evidence.map((e) => e.document_revision_id).filter((x): x is string => !!x), ...(extra.documentRevisions ?? [])]);
  const mails = await readableMailRevisions(db, ctx, extra.mailRevisions ?? []);
  const byFinding = new Map<string, IFindingEvidenceRow[]>();
  for (const e of evidence) byFinding.set(e.finding_id, [...(byFinding.get(e.finding_id) ?? []), e]);
  const memo = new Map<string, boolean>();
  return {
    fragment: (id) => readable.has(id),
    documentRevision: (id) => docs.has(id),
    mailRevision: (id) => mails.has(id),
    finding: (id) => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      const ok = (byFinding.get(id) ?? []).every(
        (e) =>
          (!e.fragment_id || readable.has(e.fragment_id)) &&
          (e.fact_fragment_ids ?? []).every((f) => readable.has(f)) &&
          (!e.requirement_id || vis.visible('requirement', e.requirement_id)) &&
          (!e.customer_question_id || vis.visible('question', e.customer_question_id)) &&
          (!e.document_revision_id || docs.has(e.document_revision_id)),
      );
      memo.set(id, ok);
      return ok;
    },
  };
};

// ---------------------------------------------------------------- Прогон

export interface IRunFreshness {
  outdated: boolean;
  reasons: string[];
  events: { seq: number; type: string; at: string | null; mode: string | null; reason: string | null }[];
}

// Прогон устарел (§3.1): после снимка поступили источники, после запуска — расчёт, или изменились реестр и записи этапа.
export const runFreshness = async (db: Queryable, run: IReviewRunRow): Promise<IRunFreshness> => {
  const events = await eventsAfter(db, run.stage_id, run.scope_input_version);
  // Классы событий — из общего списка барьера (S12-01): правка поля приложения (draft_field_changed, класс content) —
  // не новый источник; изменения содержимого этапа, от которых зависит проверка, ловит отпечаток содержимого ниже.
  const classOf = stageEventClass;
  const source = events.filter((e) => classOf(e.event_type) === 'source');
  const calc = events.filter((e) => classOf(e.event_type) === 'calculation' && e.seq > run.stage_input_version);
  const reasons: string[] = [];
  if (source.length > 0) reasons.push(`после снимка области поступили источники — событий ${source.length}`);
  if (calc.length > 0) reasons.push(`после проверки добавлена ревизия расчёта — событий ${calc.length}`);
  // Отпечаток содержимого закреплён при запуске вместе со входом (R09-02): изменение после запуска — «устарел». Вход,
  // закреплённый прежним отпечатком (v1 — до R13-05, v2 — до R13-06), полноту изменений не доказывает — тоже «устарел»,
  // со своей причиной.
  const stored = (await reviewRunInput(db, run.id))?.content_fingerprint ?? null;
  if (stored && stored !== (await stageContentFingerprint(db, run.stage_id, run.registry_id, run.evidence_scope_id))) {
    const legacy =
      stored === (await legacyStageContentFingerprint(db, run.stage_id, run.registry_id)) ||
      stored === (await legacyStageContentFingerprintV2(db, run.stage_id, run.registry_id, run.evidence_scope_id));
    reasons.push(
      legacy
        ? 'вход проверки закреплён прежним отпечатком содержимого (до исправлений R13-05, R13-06): запустите проверку заново'
        : 'после проверки изменились реестр требований, покрытие или записи этапа',
    );
  }
  return {
    outdated: reasons.length > 0,
    reasons,
    events: [...source, ...calc].map((e) => ({ seq: e.seq, type: e.event_type, at: iso(e.created_at), mode: e.mode, reason: e.reason })),
  };
};

export const runBrief = (run: IReviewRunRow) => ({
  id: run.id,
  stageId: run.stage_id,
  status: run.status,
  createdAt: iso(run.created_at),
  finishedAt: iso(run.finished_at),
  failureCode: run.failure_code,
  rulesVersion: run.rules_version,
  model: run.model_provider ? { provider: run.model_provider, model: run.model_id, version: run.model_version } : null,
});

export const runView = async (db: Queryable, ctx: IAccessContext, run: IReviewRunRow) => {
  const results = await reviewCheckResults(db, run.id);
  const pinned = await reviewRunInput(db, run.id);
  const freshness = await runFreshness(db, run);
  const counts = (
    await db.query<{ status: string; n: number }>(
      'SELECT f.status, count(*)::int AS n FROM finding_occurrence o JOIN finding f ON f.id = o.finding_id WHERE o.run_id = $1 GROUP BY f.status',
      [run.id],
    )
  ).rows;
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>;
  const suggestions = await listSuggestions(db, run.id);
  const vis = await reviewVisibility(db, ctx, run.stage_id, [], { fragments: suggestions.flatMap((s) => s.evidence.map((e) => e.fragment_id).filter((x): x is string => !!x)) });
  const unsettled = (byStatus.open ?? 0) + (byStatus.in_progress ?? 0) + (byStatus.stale ?? 0);
  const summary = reviewSummary({
    status: run.status,
    outcomes: results.map((r) => r.outcome),
    unsettledFindings: unsettled,
    acceptedRisks: byStatus.accepted_risk ?? 0,
    openSuggestions: suggestions.filter((s) => s.status === 'open').length,
    outdated: freshness.outdated,
  });
  const resultByCode = new Map(results.map((r) => [r.check_code, r]));
  return {
    ...runBrief(run),
    inputs: {
      evidenceScopeId: run.evidence_scope_id,
      registryId: run.registry_id,
      calculationRevisionId: run.calculation_revision_id,
      priorityRevisionId: run.priority_revision_id,
      priority: run.priority_kinds.map((k) => ({ kind: k, title: SOURCE_KIND_TITLES[k as SourceKind] ?? k })),
      stageInputVersion: Number(run.stage_input_version),
      scopeInputVersion: Number(run.scope_input_version),
      rulesVersion: run.rules_version,
      rulesSha256: run.rules_sha256,
      promptVersion: run.prompt_version,
      promptSha256: run.prompt_sha256,
      inputSha256: pinned?.input_sha256 ?? null,
    },
    coverage: run.coverage,
    checks: REVIEW_CHECKS.map((code: ReviewCheckCode) => {
      const r = resultByCode.get(code);
      return { code, title: REVIEW_CHECK_TITLES[code], method: code === 'model_hypotheses' ? 'model' : 'rule', outcome: r?.outcome ?? null, reason: r?.reason ?? null, counts: r?.counts ?? {} };
    }),
    findings: { byStatus, unsettled },
    freshness,
    summary,
    suggestions: suggestions.map((s) => suggestionView(s, s.evidence.every((e) => !e.fragment_id || vis.fragment(e.fragment_id)))),
  };
};

export const suggestionView = (s: ISuggestionRow, visible: boolean) => ({
  id: s.id,
  runId: s.run_id,
  status: s.status,
  restricted: !visible,
  title: visible ? s.title : 'Гипотеза модели (основания недоступны)',
  rationale: visible ? s.rationale : null,
  decidedBy: s.decided_by_name,
  decisionReason: visible ? s.decision_reason : null,
  findingId: s.finding_id,
  evidence: s.evidence.map((e) => ({ side: e.side, fragmentId: e.fragment_id, calculationRevisionId: e.calculation_revision_id, externalPositionId: e.external_position_id })),
  createdAt: iso(s.created_at),
  etag: formatEtag(s.id, Number(s.row_version)),
});

// ---------------------------------------------------------------- Замечание

const evidenceView = (e: IFindingEvidenceRow, vis: IReviewVisibility) => {
  const fragmentReadable = e.fragment_id ? vis.fragment(e.fragment_id) : true;
  return {
    side: e.side,
    type: e.object_type,
    fragment: e.fragment_id
      ? { id: e.fragment_id, readable: fragmentReadable, text: fragmentReadable ? e.fragment_text : null, origin: e.fragment_origin, pageIndex: e.page_index, documentTitle: fragmentReadable ? e.document_title : null }
      : null,
    calculation: e.calculation_revision_id
      ? { revisionId: e.calculation_revision_id, positionId: e.external_position_id, itemId: e.external_item_id, text: e.calc_text, unit: e.calc_unit, quantity: e.calc_quantity }
      : null,
    requirement: e.requirement_revision_id ? { revisionId: e.requirement_revision_id, requirementId: e.requirement_id, code: e.requirement_code } : null,
    fact: e.evidence_fact_id
      ? {
          id: e.evidence_fact_id,
          type: e.fact_type,
          rawValue: (e.fact_fragment_ids ?? []).every((f) => vis.fragment(f)) ? e.fact_raw_value : null,
        }
      : null,
    question: e.customer_question_id ? { id: e.customer_question_id, text: null as string | null } : null,
    qaItemRevision: e.qa_item_revision_id ? { id: e.qa_item_revision_id, question: e.qa_question } : null,
    documentRevision: e.document_revision_id
      ? { id: e.document_revision_id, readable: vis.documentRevision(e.document_revision_id), title: vis.documentRevision(e.document_revision_id) ? e.revision_document_title : null, revisionSeq: e.revision_seq }
      : null,
    note: e.note,
  };
};

// Последнее событие источников этапа: основание замечания старше него — «входы изменились» (решения и расчёт не в счёт:
// расчёт инвалидируется точно, решения прежних оснований не меняют).
const lastSourceEvent = async (db: Queryable, stageId: string): Promise<number> =>
  Number(
    (await db.query<{ seq: number | null }>("SELECT max(seq) AS seq FROM stage_input_event WHERE stage_id = $1 AND event_class = 'source'", [stageId])).rows[0]?.seq ?? 0,
  );

export const findingBrief = (f: IFindingRow, visible: boolean, currentVersion: number) => ({
  id: f.id,
  stageId: f.stage_id,
  kind: f.kind,
  kindTitle: FINDING_KIND_META[f.kind as FindingKind]?.title ?? f.kind,
  check: f.check_code,
  origin: f.origin,
  restricted: !visible,
  title: visible ? f.title : FINDING_KIND_META[f.kind as FindingKind]?.title ?? 'Замечание',
  detail: visible ? f.detail : null,
  severity: f.severity,
  confidence: f.confidence,
  status: f.status,
  owner: f.owner_user_id ? { id: f.owner_user_id, name: f.owner_name } : null,
  action: visible ? f.action : null,
  impact: visible ? f.impact : null,
  suggestedSide: f.suggested_side,
  riskAcceptable: FINDING_KIND_META[f.kind as FindingKind]?.riskAcceptable ?? false,
  firstRunId: f.first_run_id,
  lastRunId: f.last_run_id,
  discrepancyId: f.discrepancy_id,
  basisInputVersion: Number(f.basis_input_version),
  basisOutdated: Number(f.basis_input_version) < currentVersion,
  invalidated: f.invalidated,
  createdAt: iso(f.created_at),
  updatedAt: iso(f.updated_at),
  etag: formatEtag(f.id, Number(f.row_version)),
});

export const findingsList = async (db: Queryable, ctx: IAccessContext, stageId: string, rows: readonly IFindingRow[]) => {
  const evidence = await findingEvidence(db, rows.map((r) => r.id));
  const vis = await reviewVisibility(db, ctx, stageId, evidence);
  const version = await lastSourceEvent(db, stageId);
  const evidenceBy = new Map<string, IFindingEvidenceRow[]>();
  for (const e of evidence) evidenceBy.set(e.finding_id, [...(evidenceBy.get(e.finding_id) ?? []), e]);
  return rows.map((f) => {
    const visible = vis.finding(f.id);
    const ev = evidenceBy.get(f.id) ?? [];
    return {
      ...findingBrief(f, visible, version),
      positions: ev.filter((e) => e.calculation_revision_id).map((e) => ({ positionId: e.external_position_id, itemId: e.external_item_id, text: e.calc_text })),
      requirements: [...new Set(ev.filter((e) => e.requirement_code).map((e) => e.requirement_code!))],
    };
  });
};

const axisEventView = (e: IAxisEventRow, visible: boolean) => ({
  id: e.id,
  seq: e.seq,
  axis: e.axis,
  value: e.value,
  reason: visible ? e.reason : null,
  actor: e.actor_name,
  createdAt: iso(e.created_at),
  invalidatedReason: e.invalidated_reason,
  bases: e.bases.map((b) => ({ type: b.basis_type, id: b.fragment_id ?? b.qa_item_revision_id ?? b.mail_message_revision_id ?? b.document_revision_id ?? b.decision_id })),
});

export const axisBasesVisible = (events: readonly IAxisEventRow[], vis: IReviewVisibility): boolean =>
  events.every((e) =>
    e.bases.every(
      (b) =>
        (!b.fragment_id || vis.fragment(b.fragment_id)) &&
        (!b.mail_message_revision_id || vis.mailRevision(b.mail_message_revision_id)) &&
        (!b.document_revision_id || vis.documentRevision(b.document_revision_id)),
    ),
  );

export const discrepancyView = (d: IDiscrepancyRow, events: readonly IAxisEventRow[], findingVisible: boolean, vis: IReviewVisibility, decisions: Awaited<ReturnType<typeof decisionsFor>>) => {
  const visible = findingVisible && axisBasesVisible(events, vis);
  const axes = currentAxes(events);
  return {
    id: d.id,
    findingId: d.finding_id,
    restricted: !visible,
    topic: visible ? d.topic : 'Разногласие (основания недоступны)',
    createdBy: d.created_by_name,
    createdAt: iso(d.created_at),
    axes: Object.fromEntries(
      Object.entries(axes).map(([axis, a]) => [axis, { value: a.value, eventId: a.event?.id ?? null, actor: a.event?.actor_name ?? null, at: iso(a.event?.created_at ?? null), invalidatedReason: a.event?.invalidated_reason ?? null }]),
    ),
    history: events.map((e) => axisEventView(e, visible)),
    decisions: decisions
      .filter((x) => x.subject_id === d.id)
      .map((x) => ({ id: x.id, type: x.decision_type, statement: visible ? x.statement : null, rationale: visible ? x.rationale : null, decidedBy: x.decided_by_name, createdAt: iso(x.created_at), invalidatedReason: x.invalidated_reason })),
  };
};

export const findingDetail = async (db: Queryable, ctx: IAccessContext, f: IFindingRow) => {
  const evidence = await findingEvidence(db, [f.id]);
  const discrepancy = f.discrepancy_id ? await getDiscrepancy(db, f.discrepancy_id) : null;
  const events = discrepancy ? await axisEvents(db, [discrepancy.id]) : [];
  const vis = await reviewVisibility(db, ctx, f.stage_id, evidence, {
    fragments: events.flatMap((e) => e.bases.map((b) => b.fragment_id).filter((x): x is string => !!x)),
    mailRevisions: events.flatMap((e) => e.bases.map((b) => b.mail_message_revision_id).filter((x): x is string => !!x)),
    documentRevisions: events.flatMap((e) => e.bases.map((b) => b.document_revision_id).filter((x): x is string => !!x)),
  });
  const visible = vis.finding(f.id);
  const version = await lastSourceEvent(db, f.stage_id);
  const decisions = await decisionsFor(db, [f.id, ...(discrepancy ? [discrepancy.id] : [])]);
  const factIds = (side: string) => evidence.filter((e) => e.side === side && e.evidence_fact_id).map((e) => e.evidence_fact_id!);
  return {
    ...findingBrief(f, visible, version),
    evidence: evidence.map((e) => evidenceView(e, vis)),
    // Решение по графу D-018 возможно, только если обе стороны — конкретные факты (D-029 В-09-2).
    graphFacts: factIds('left').length > 0 && factIds('right').length > 0 ? { left: factIds('left'), right: factIds('right') } : null,
    events: (await findingEvents(db, f.id)).map((e) => ({
      seq: e.seq,
      kind: e.event_kind,
      from: e.event_kind === 'action' || e.event_kind === 'impact' ? (visible ? e.from_value : null) : e.from_value,
      to: e.event_kind === 'action' || e.event_kind === 'impact' ? (visible ? e.to_value : null) : e.to_value,
      reason: visible || e.actor_kind === 'system' ? e.reason : null,
      actor: e.actor_kind === 'system' ? 'система' : e.actor_name,
      decisionId: e.decision_id,
      stageInputEventId: e.stage_input_event_id,
      runId: e.run_id,
      createdAt: iso(e.created_at),
    })),
    occurrences: (await findingOccurrences(db, f.id)).map((o) => ({ runId: o.run_id, createdAt: iso(o.created_at), status: o.status })),
    invalidations: (await findingInvalidations(db, f.id)).map((i) => ({ reason: i.reason, mode: i.mode, eventType: i.event_type, eventSeq: i.event_seq, createdAt: iso(i.created_at) })),
    decisions: decisions
      .filter((x) => x.subject_id === f.id)
      .map((x) => ({ id: x.id, type: x.decision_type, statement: visible ? x.statement : null, rationale: visible ? x.rationale : null, decidedBy: x.decided_by_name, createdAt: iso(x.created_at), invalidatedReason: x.invalidated_reason })),
    discrepancy: discrepancy ? discrepancyView(discrepancy, events, visible, vis, decisions) : null,
    canWrite: hasTenderCap(ctx, f.tender_id, 'finding.write'),
    canAcceptRisk: hasTenderCap(ctx, f.tender_id, 'finding.accept_risk'),
    canDecide: hasTenderCap(ctx, f.tender_id, 'requirement.decide'),
  };
};
