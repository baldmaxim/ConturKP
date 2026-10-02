// Проекции ответного ядра (этап 08a, D-027 AD-08a-4). Текст ответа — производный текст оснований: он и цитаты выдаются
// автору, только если он сейчас читает каждое процитированное основание (как у требований, R08-02); иначе — оболочка со
// статусом. Текст основания — по правам источника. Отклонённые утверждения выдаются только числом и кодами проблем:
// их текста нет и в БД. Статус ответа выдаётся своим словарём и никогда не называется результатом проверки.
import { hitDetails, readableFragments, runClaims, runEvidence, dialogMessages, dialogRuns, type IAccessContext, type IAnswerRunRow, type IDialogRow, type Queryable } from '@kontur/db';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const placeOf = (d: NonNullable<Awaited<ReturnType<typeof hitDetails>> extends Map<string, infer R> ? R : never>) => ({
  sourceKind: d.source_unit_type,
  documentTitle: d.document_title,
  pageIndex: d.page_index,
  pageLabel: d.page_label,
  sheetLabel: d.sheet_label,
  mailSubject: d.mail_subject,
  sessionTitle: d.session_title,
});

export const answerRunView = async (db: Queryable, ctx: IAccessContext, run: IAnswerRunRow) => {
  const base = {
    id: run.id,
    dialogId: run.dialog_id,
    seq: run.seq,
    questionMessageId: run.question_message_id,
    status: run.status,
    answerStatus: run.answer_status,
    incompleteReason: run.incomplete_reason,
    plan: { intent: run.plan.intent, followUp: run.plan.followUp, versionPolicy: run.plan.versionPolicy, entities: run.plan.entities },
    verifierMode: run.verifier_mode,
    verificationLevel: run.verification_level,
    model: run.provider_id ? { provider: run.provider_id, model: run.model_id, version: run.model_version } : null,
    repairs: run.repairs,
    searchRunId: run.search_run_id,
    failureCode: run.failure_code,
    createdAt: iso(run.created_at),
    finishedAt: iso(run.finished_at),
  };
  if (run.status !== 'completed') return { ...base, answer: null };
  const evidence = await runEvidence(db, [run.id]);
  const claims = await runClaims(db, [run.id]);
  const readable = await readableFragments(db, ctx, evidence.map((e) => e.fragment_id));
  const details = await hitDetails(db, evidence.filter((e) => readable.has(e.fragment_id)).map((e) => e.fragment_id));
  const byLabel = new Map(evidence.map((e) => [e.label, e]));
  const coverage = run.coverage as { citations?: string[]; conflictCitations?: number[] };
  const citationLabels = coverage.citations ?? [];
  const shown = claims.filter((c) => c.shown);
  // Ответ виден, только если читаются все процитированные основания (утверждения и расхождение).
  const cited = [...new Set(citationLabels)].map((l) => byLabel.get(l)?.fragment_id).filter((f): f is string => Boolean(f));
  const visible = cited.every((f) => readable.has(f));
  const message = (await db.query<{ text: string }>('SELECT text FROM dialog_message WHERE answer_run_id = $1', [run.id])).rows[0]?.text ?? null;
  const evidenceView = (label: string, number: number | null) => {
    const e = byLabel.get(label)!;
    const open = readable.has(e.fragment_id);
    const d = details.get(e.fragment_id);
    return {
      number,
      label,
      fragmentId: e.fragment_id,
      versionNote: e.version_note,
      restricted: !open,
      origin: open ? e.origin : null,
      text: open ? (d?.text ?? null) : null,
      place: open && d ? placeOf(d) : null,
    };
  };
  const droppedIssues: Record<string, number> = {};
  for (const c of claims.filter((x) => !x.shown)) for (const code of c.issues) droppedIssues[code] = (droppedIssues[code] ?? 0) + 1;
  return {
    ...base,
    coverage: run.coverage,
    answer: {
      visible,
      text: visible ? message : null,
      citations: visible ? citationLabels.map((label, i) => evidenceView(label, i + 1)) : [],
      conflictCitations: visible ? (coverage.conflictCitations ?? []) : [],
      claims: visible ? shown.map((c) => ({ kind: c.kind, text: c.text, citations: c.citations })) : [],
      shownClaims: shown.length,
      droppedClaims: claims.length - shown.length,
      droppedIssues,
      // Найденные основания пакета (при выключенной модели и неполноте — единственный результат хода).
      foundFragments: evidence.filter((e) => !citationLabels.includes(e.label)).map((e) => evidenceView(e.label, null)),
    },
  };
};

export const dialogView = async (db: Queryable, ctx: IAccessContext, dialog: IDialogRow) => {
  const messages = await dialogMessages(db, dialog.id);
  const runs = await dialogRuns(db, dialog.id);
  const views = await Promise.all(runs.map((r) => answerRunView(db, ctx, r)));
  const visibleAnswer = new Map(views.map((v) => [v.id, v.answer ? v.answer.visible : true]));
  return {
    id: dialog.id,
    title: dialog.title,
    contextKind: dialog.context_kind,
    tenderId: dialog.tender_id,
    contractId: dialog.contract_id,
    stageId: dialog.stage_id,
    mode: dialog.mode,
    evidenceScopeId: dialog.evidence_scope_id,
    createdAt: iso(dialog.created_at),
    messages: messages.map((m) => {
      const open = m.role === 'user' || visibleAnswer.get(m.answer_run_id!) !== false;
      return { id: m.id, seq: m.seq, role: m.role, text: open ? m.text : null, hidden: !open, answerRunId: m.answer_run_id, createdAt: iso(m.created_at) };
    }),
    runs: views,
  };
};
