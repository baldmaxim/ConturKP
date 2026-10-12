// Показ выводов сравнения выпусков (этап 15; проект §11–§12). Вывод хранит только ссылки, хэши и коды; названия и
// значения подставляются здесь по текущим правам читателя — тем же, что защищают сами записи: редакция и письмо —
// права источника; требование и вопрос — замыкание закрытости этапа 08; факт — его фрагменты; решения, риски и
// удержания — `decisionVisibility` (R13-02); поле приложения — `fieldVersionVisibility`; файл — видимость комплекта.
// Закрытый вывод отдаётся без ссылок, названий и значений. Пояснение причины — только при читаемых основаниях.
import {
  candidateVisibleTo,
  currentReleaseReasons,
  decisionVisibility,
  fieldVersionVisibility,
  readableDocumentRevisions,
  readableFragments,
  readableMailboxIds,
  readableMailRevisions,
  stageVisibility,
  type IAccessContext,
  type IReleaseComparisonItemRow,
  type IReleaseReasonRow,
  type Queryable,
} from '@kontur/db';

type Side = { ref: string | null; sha256: string | null; label: string | null; note: string | null; value?: unknown };

export interface IItemView {
  id: string;
  ordinal: number;
  section: string;
  change: string;
  subjectType: string;
  closed: boolean;
  left: Side | null;
  right: Side | null;
  detail: Record<string, unknown>;
  evidence: { type: string; id: string }[];
  reason: ReturnType<typeof reasonView> | null;
  reasonVersion: number;
  reasonStatus: 'unknown' | 'hypothesis' | 'confirmed';
}

const cut = (t: string | null | undefined, n = 240): string | null => (t === null || t === undefined ? null : t.length > n ? `${t.slice(0, n - 1)}…` : t);

const rows = async <T extends object>(db: Queryable, sql: string, ids: readonly string[]): Promise<T[]> => (ids.length === 0 ? [] : (await db.query<T>(sql, [[...new Set(ids)]])).rows);

const refsOf = (items: readonly IReleaseComparisonItemRow[], type: string): string[] =>
  items.filter((i) => i.subject_type === type).flatMap((i) => [i.left_ref, i.right_ref]).filter((x): x is string => !!x);

const detailId = (i: IReleaseComparisonItemRow, key: string): string | null => (typeof i.detail[key] === 'string' ? (i.detail[key] as string) : null);

export const reasonView = (r: IReleaseReasonRow, visible: boolean) => ({
  id: r.id,
  version: r.version,
  reasonKind: r.reason_kind,
  reasonStatus: r.reason_status,
  rationale: visible ? r.rationale : null,
  restricted: !visible,
  actor: { id: r.actor_user_id, name: r.actor_name },
  createdAt: r.created_at.toISOString(),
  fragmentIds: visible ? r.fragment_ids : [],
  decisionIds: visible ? r.decision_ids : [],
  bases: r.fragment_ids.length + r.decision_ids.length,
});

// Видимость причин: каждый фрагмент-основание читается, каждое решение-основание видимо (R13-02).
export const reasonVisibility = async (db: Queryable, ctx: IAccessContext, stage: { id: string; tenderId: string }, reasons: readonly IReleaseReasonRow[]): Promise<(r: IReleaseReasonRow) => boolean> => {
  const fragments = await readableFragments(db, ctx, reasons.flatMap((r) => r.fragment_ids));
  const decisions = await decisionVisibility(db, ctx, stage, { events: reasons.flatMap((r) => r.decision_ids).map((id) => ({ refType: 'decision', refId: id })) });
  return (r) => r.fragment_ids.every((f) => fragments.has(f)) && r.decision_ids.every((d) => decisions.event('decision', d));
};

export const itemViews = async (
  db: Queryable,
  ctx: IAccessContext,
  cmp: { tenderId: string; leftStageId: string; rightStageId: string },
  items: readonly IReleaseComparisonItemRow[],
): Promise<IItemView[]> => {
  // ---- Источники и полученное
  const revisionIds = [...refsOf(items, 'document_revision'), ...refsOf(items, 'document_occurrence')];
  const revisions = new Map(
    (
      await rows<{ id: string; document_id: string; title: string; revision_seq: number; doc_type: string }>(
        db,
        'SELECT dr.id, dr.document_id, d.title, dr.revision_seq, d.doc_type FROM document_revision dr JOIN document d ON d.id = dr.document_id WHERE dr.id = ANY($1::uuid[])',
        revisionIds,
      )
    ).map((r) => [r.id, r]),
  );
  const readableRevisions = await readableDocumentRevisions(db, ctx, revisionIds);
  const occurrenceIds = items.filter((i) => i.subject_type === 'document_occurrence').map((i) => detailId(i, 'subjectId')).filter((x): x is string => !!x);
  const occurrences = new Map(
    (await rows<{ id: string; observed_name: string; source_kind: string }>(db, 'SELECT id, observed_name, source_kind FROM document_occurrence WHERE id = ANY($1::uuid[])', occurrenceIds)).map((o) => [o.id, o]),
  );
  const mailRevisionIds = [...refsOf(items, 'mail_message_revision'), ...refsOf(items, 'mail_message')];
  const mailRevisions = new Map(
    (await rows<{ id: string; subject: string | null; sent_at: Date | null; direction: string }>(db, 'SELECT id, subject, sent_at, direction FROM mail_message_revision WHERE id = ANY($1::uuid[])', mailRevisionIds)).map((m) => [m.id, m]),
  );
  const readableMail = await readableMailRevisions(db, ctx, mailRevisionIds);
  const mailMessageIds = items.filter((i) => i.subject_type === 'mail_message').map((i) => detailId(i, 'subjectId')).filter((x): x is string => !!x);
  const mailMessages = new Map(
    (
      await rows<{ id: string; mailbox_id: string; subject: string | null; sent_at: Date | null }>(
        db,
        `SELECT m.id, m.mailbox_id, lr.subject, lr.sent_at FROM mail_message m
           JOIN LATERAL (SELECT r.subject, r.sent_at FROM mail_message_revision r WHERE r.message_id = m.id ORDER BY r.seq DESC LIMIT 1) lr ON true
          WHERE m.id = ANY($1::uuid[])`,
        mailMessageIds,
      )
    ).map((m) => [m.id, m]),
  );
  const mailboxes = new Set(readableMailboxIds(ctx));
  const transcripts = new Map(
    (
      await rows<{ id: string; seq: number; title: string | null }>(
        db,
        'SELECT t.id, t.seq, s.title FROM transcript_revision t JOIN negotiation_session s ON s.id = t.session_id WHERE t.id = ANY($1::uuid[])',
        refsOf(items, 'transcript_revision'),
      )
    ).map((t) => [t.id, t]),
  );

  // ---- Требования, вопросы, факты
  const requirements = new Map(
    (
      await rows<{ id: string; requirement_id: string; stage_id: string; statement: string; code: string }>(
        db,
        'SELECT v.id, v.requirement_id, v.stage_id, v.statement, q.code FROM requirement_revision v JOIN requirement q ON q.id = v.requirement_id WHERE v.id = ANY($1::uuid[])',
        refsOf(items, 'requirement_revision'),
      )
    ).map((r) => [r.id, r]),
  );
  const questions = new Map(
    (await rows<{ id: string; stage_id: string; text: string; status: string }>(db, 'SELECT id, stage_id, text, status FROM customer_question WHERE id = ANY($1::uuid[])', refsOf(items, 'customer_question'))).map((q) => [q.id, q]),
  );
  const stageIds = new Set([cmp.leftStageId, cmp.rightStageId, ...[...requirements.values()].map((r) => r.stage_id), ...[...questions.values()].map((q) => q.stage_id)]);
  const stageVis = new Map<string, Awaited<ReturnType<typeof stageVisibility>>>();
  for (const id of stageIds) stageVis.set(id, await stageVisibility(db, ctx, id));
  const qa = new Map(
    (
      await rows<{ id: string; item_no: string; question: string; answer: string | null; status: string }>(
        db,
        'SELECT r.id, i.item_no, r.question, r.answer, r.status FROM qa_item_revision r JOIN qa_item i ON i.id = r.item_id WHERE r.id = ANY($1::uuid[])',
        refsOf(items, 'qa_item_revision'),
      )
    ).map((q) => [q.id, q]),
  );
  const factIds = refsOf(items, 'evidence_fact');
  const facts = new Map(
    (
      await rows<{ id: string; fact_type: string; raw_value: string; unit: string; clause_ref: string; document_id: string; title: string }>(
        db,
        `SELECT f.id, f.fact_type, f.raw_value, f.unit, f.clause_ref, x.document_id, d.title
           FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id JOIN document d ON d.id = x.document_id WHERE f.id = ANY($1::uuid[])`,
        factIds,
      )
    ).map((f) => [f.id, f]),
  );
  const factFragments = new Map<string, string[]>();
  for (const x of await rows<{ evidence_fact_id: string; fragment_id: string }>(db, 'SELECT evidence_fact_id, fragment_id FROM evidence_fact_fragment WHERE evidence_fact_id = ANY($1::uuid[])', factIds)) {
    factFragments.set(x.evidence_fact_id, [...(factFragments.get(x.evidence_fact_id) ?? []), x.fragment_id]);
  }
  const readableFactFragments = await readableFragments(db, ctx, [...factFragments.values()].flat());
  // Факт без известных фрагментов закрыт: отсутствие основания не означает общедоступность.
  const factVisible = (id: string): boolean => {
    const list = factFragments.get(id);
    return !!list && list.length > 0 && list.every((f) => readableFactFragments.has(f));
  };

  // ---- Решения, риски, удержания
  const decisionIds = refsOf(items, 'decision');
  const decisions = new Map(
    (await rows<{ id: string; decision_type: string; statement: string; stage_id: string | null }>(db, 'SELECT id, decision_type, statement, stage_id FROM decision WHERE id = ANY($1::uuid[])', decisionIds)).map((d) => [d.id, d]),
  );
  const riskItems = items.filter((i) => i.subject_type === 'risk_acceptance');
  const risks = new Map(
    (
      await rows<{ id: string; blocker_code: string; subject_type: string; subject_id: string; stage_id: string; reason: string }>(
        db,
        'SELECT id, blocker_code, subject_type, subject_id, stage_id, reason FROM risk_acceptance WHERE id = ANY($1::uuid[])',
        refsOf(items, 'risk_acceptance'),
      )
    ).map((r) => [r.id, r]),
  );
  const findingIds = refsOf(items, 'finding_risk');
  const findings = new Map(
    (await rows<{ id: string; title: string; stage_id: string; severity: string }>(db, 'SELECT id, title, stage_id, severity FROM finding WHERE id = ANY($1::uuid[])', findingIds)).map((f) => [f.id, f]),
  );
  const holdItems = items.filter((i) => i.subject_type === 'hold_decision');
  const events = new Map(
    (
      await rows<{ id: string; stage_id: string; seq: number; event_type: string; ref_type: string; ref_id: string }>(
        db,
        'SELECT id, stage_id, seq, event_type, ref_type, ref_id FROM stage_input_event WHERE id = ANY($1::uuid[])',
        holdItems.map((i) => detailId(i, 'eventId')).filter((x): x is string => !!x),
      )
    ).map((e) => [e.id, e]),
  );
  const holdDecisions = new Map(
    (await rows<{ id: string; rationale: string | null }>(db, 'SELECT id, rationale FROM decision WHERE id = ANY($1::uuid[])', refsOf(items, 'hold_decision'))).map((d) => [d.id, d]),
  );
  // Видимость решений — по этапу предмета (левая и правая стороны могут быть разных этапов).
  const decisionVis = new Map<string, Awaited<ReturnType<typeof decisionVisibility>>>();
  for (const stageId of new Set([cmp.leftStageId, cmp.rightStageId])) {
    decisionVis.set(
      stageId,
      await decisionVisibility(db, ctx, { id: stageId, tenderId: cmp.tenderId }, {
        subjects: [...risks.values()].filter((r) => r.stage_id === stageId).map((r) => ({ type: r.subject_type, id: r.subject_id })),
        findings: [...findings.values()].filter((f) => f.stage_id === stageId).map((f) => f.id),
        events: [
          ...[...decisions.values()].filter((d) => d.stage_id === stageId).map((d) => ({ refType: 'decision', refId: d.id })),
          ...[...events.values()].filter((e) => e.stage_id === stageId).map((e) => ({ refType: e.ref_type, refId: e.ref_id })),
        ],
      }),
    );
  }

  // ---- Приложения и файлы
  const fileIds = refsOf(items, 'candidate_file');
  const files = new Map(
    (await rows<{ id: string; candidate_id: string; path: string; size_bytes: number; audience: string }>(db, 'SELECT id, candidate_id, path, size_bytes, audience FROM candidate_file WHERE id = ANY($1::uuid[])', fileIds)).map((f) => [f.id, f]),
  );
  const candidateVisible = new Map<string, boolean>();
  for (const id of new Set([...files.values()].map((f) => f.candidate_id))) candidateVisible.set(id, await candidateVisibleTo(db, ctx, id));
  const versionIds = refsOf(items, 'field_version');
  const versions = new Map(
    (
      await rows<{ id: string; value: unknown; field_key: string; draft_title: string; template_name: string }>(
        db,
        `SELECT v.id, v.value, f.field_key, a.title AS draft_title, t.name AS template_name
           FROM draft_field_version v JOIN draft_field f ON f.id = v.field_id JOIN application_draft a ON a.id = v.draft_id
           JOIN template_revision r ON r.id = a.template_revision_id JOIN application_template t ON t.id = r.template_id WHERE v.id = ANY($1::uuid[])`,
        versionIds,
      )
    ).map((v) => [v.id, v]),
  );
  const versionVisible = await fieldVersionVisibility(db, ctx, versionIds);

  // ---- Сборка
  const side = (i: IReleaseComparisonItemRow, which: 'left' | 'right'): { side: Side | null; visible: boolean } => {
    const ref = which === 'left' ? i.left_ref : i.right_ref;
    const sha256 = which === 'left' ? i.left_sha256 : i.right_sha256;
    if (!ref) return { side: null, visible: true };
    const make = (visible: boolean, label: string | null, note: string | null = null, value?: unknown) => ({ visible, side: visible ? { ref, sha256, label, note, ...(value !== undefined ? { value } : {}) } : null });
    switch (i.subject_type) {
      case 'document_revision': {
        const r = revisions.get(ref);
        return make(!!r && readableRevisions.has(ref), r ? `${r.title} (ред. ${r.revision_seq})` : null, r?.doc_type ?? null);
      }
      case 'document_occurrence': {
        const r = revisions.get(ref);
        const o = occurrences.get(detailId(i, 'subjectId') ?? '');
        return make(!!r && readableRevisions.has(ref), r ? `${r.title} (ред. ${r.revision_seq})` : null, o ? `получено как «${o.observed_name}» (${o.source_kind})` : null);
      }
      case 'mail_message_revision':
      case 'mail_message': {
        const m = mailRevisions.get(ref);
        return make(!!m && readableMail.has(ref), m ? (m.subject ?? '(без темы)') : null, m?.sent_at ? m.sent_at.toISOString() : null);
      }
      case 'transcript_revision': {
        const t = transcripts.get(ref);
        return make(!!t, t ? `${t.title ?? 'Встреча'} (ред. ${t.seq})` : null);
      }
      case 'requirement_revision': {
        const r = requirements.get(ref);
        return make(!!r && stageVis.get(r.stage_id)!.visible('requirement', r.requirement_id), r ? `${r.code}: ${cut(r.statement)}` : null);
      }
      case 'customer_question': {
        const q = questions.get(ref);
        return make(!!q && stageVis.get(q.stage_id)!.visible('question', q.id), q ? cut(q.text) : null, q?.status ?? null);
      }
      case 'qa_item_revision': {
        const q = qa.get(ref);
        return make(!!q, q ? `№ ${q.item_no}: ${cut(q.question)}` : null, q ? (q.answer ? `ответ: ${cut(q.answer)}` : 'ответа нет') : null);
      }
      case 'evidence_fact': {
        const f = facts.get(ref);
        return make(!!f && factVisible(ref), f ? `${f.raw_value}${f.unit ? ` ${f.unit}` : ''}` : null, f ? `${f.title}${f.clause_ref ? `, п. ${f.clause_ref}` : ''}` : null);
      }
      case 'decision': {
        const d = decisions.get(ref);
        const vis = d?.stage_id ? decisionVis.get(d.stage_id) : undefined;
        return make(!!d && !!vis && vis.event('decision', ref), d ? cut(d.statement) : null, d?.decision_type ?? null);
      }
      case 'risk_acceptance': {
        const r = risks.get(ref);
        const vis = r ? decisionVis.get(r.stage_id) : undefined;
        return make(!!r && !!vis && vis.subject(r.subject_type, r.subject_id), r ? r.blocker_code : null, r ? cut(r.reason) : null);
      }
      case 'finding_risk': {
        const f = findings.get(ref);
        const vis = f ? decisionVis.get(f.stage_id) : undefined;
        return make(!!f && !!vis && vis.finding(ref), f ? cut(f.title) : null, f?.severity ?? null);
      }
      case 'hold_decision': {
        const e = events.get(detailId(i, 'eventId') ?? '');
        const vis = e ? decisionVis.get(e.stage_id) : undefined;
        return make(!!e && !!vis && vis.event(e.ref_type, e.ref_id), e ? `событие № ${e.seq}: ${e.event_type}` : null, cut(holdDecisions.get(ref)?.rationale ?? null));
      }
      case 'candidate_file': {
        const f = files.get(ref);
        return make(!!f && candidateVisible.get(f.candidate_id) === true, f ? f.path : null, f ? `${f.size_bytes} байт, ${f.audience === 'customer' ? 'для заказчика' : 'внутренний'}` : null);
      }
      case 'field_version': {
        const v = versions.get(ref);
        return make(!!v && versionVisible(ref), v ? `${v.draft_title}: ${v.field_key}` : null, v?.template_name ?? null, v ? v.value : undefined);
      }
      default:
        // Неизвестный вид предмета закрыт.
        return { side: null, visible: false };
    }
  };

  // Вывод без ссылок (письмо вне правого снимка): видимость — по ящику письма.
  const extraVisible = (i: IReleaseComparisonItemRow): boolean => {
    if (i.subject_type === 'mail_message') {
      const m = mailMessages.get(detailId(i, 'subjectId') ?? '');
      return !!m && mailboxes.has(m.mailbox_id);
    }
    if (i.subject_type === 'hold_decision') {
      const e = events.get(detailId(i, 'eventId') ?? '');
      return !!e && (decisionVis.get(e.stage_id)?.event(e.ref_type, e.ref_id) ?? false);
    }
    return true;
  };

  const reasons = await currentReleaseReasons(db, items.map((i) => i.id));
  const reasonVisible = await reasonVisibility(db, ctx, { id: cmp.rightStageId, tenderId: cmp.tenderId }, [...reasons.values()]);
  const evidenceType: Record<string, string> = {
    document_occurrence: 'document_revision',
    mail_message: 'mail_message_revision',
    risk_acceptance: 'risk_acceptance',
    finding_risk: 'finding',
    hold_decision: 'decision',
  };

  return items.map((i) => {
    const l = side(i, 'left');
    const r = side(i, 'right');
    const reason = reasons.get(i.id) ?? null;
    const closed = !l.visible || !r.visible || !extraVisible(i);
    const base = { id: i.id, ordinal: Number(i.ordinal), section: i.section, change: i.change, subjectType: i.subject_type, reasonVersion: reason?.version ?? 0, reasonStatus: reason?.reason_status ?? ('unknown' as const) };
    if (closed) return { ...base, closed: true, left: null, right: null, detail: {}, evidence: [], reason: reason ? reasonView(reason, false) : null };
    const type = evidenceType[i.subject_type] ?? i.subject_type;
    const mail = i.subject_type === 'mail_message' ? mailMessages.get(detailId(i, 'subjectId') ?? '') : undefined;
    // Решение по удержанию без ссылки на запись решения: подпись — по событию.
    const event = i.subject_type === 'hold_decision' && !l.side && !r.side ? events.get(detailId(i, 'eventId') ?? '') : undefined;
    return {
      ...base,
      closed: false,
      left: l.side,
      right:
        r.side ??
        (mail
          ? { ref: null, sha256: null, label: mail.subject ?? '(без темы)', note: mail.sent_at ? mail.sent_at.toISOString() : null }
          : event
            ? { ref: null, sha256: null, label: `событие № ${event.seq}: ${event.event_type}`, note: null }
            : null),
      detail: i.detail,
      evidence: [...new Set([i.left_ref, i.right_ref].filter((x): x is string => !!x))].map((id) => ({ type, id })),
      reason: reason ? reasonView(reason, reasonVisible(reason)) : null,
    };
  });
};
