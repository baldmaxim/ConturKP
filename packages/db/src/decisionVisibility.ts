// Видимость оснований решений (этапы 09, 13, 14): замечания этапа 09 — по их основаниям; причины принятий риска и решений
// по удержаниям — по закрытости предмета (Review 13-1 R13-02; R08-02, ADR-006). Перенесено из сервера без изменения
// логики (Review 14-1 R14-01): ту же проверку выполняет worker перед размещением внутреннего набора, где в папку уходит
// манифест выпуска с причинами решений. Права — текущие. Предмет, закрытость которого не определяется, закрыт.
import type { IReleaseManifest } from '@kontur/core';
import { contentTenderIds, readableMailboxIds, type IAccessContext } from './access.ts';
import { axisEvents, readableDocumentRevisions, readableMailRevisions, type IAxisEventRow } from './discrepancies.ts';
import { fieldVersionVisibility } from './fieldBasisAccess.ts';
import { findingEvidence, type IFindingEvidenceRow } from './findings.ts';
import type { Queryable } from './pool.ts';
import { candidateFieldVersionIds } from './releaseCandidates.ts';
import { readableFragments } from './requirementAccess.ts';
import { stageVisibility } from './requirementTaint.ts';

// ---------------------------------------------------------------- Замечания этапа 09

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

export const axisBasesVisible = (events: readonly IAxisEventRow[], vis: IReviewVisibility): boolean =>
  events.every((e) =>
    e.bases.every(
      (b) =>
        (!b.fragment_id || vis.fragment(b.fragment_id)) &&
        (!b.mail_message_revision_id || vis.mailRevision(b.mail_message_revision_id)) &&
        (!b.document_revision_id || vis.documentRevision(b.document_revision_id)),
    ),
  );

// ---------------------------------------------------------------- Решения этапа 13

export interface IDecisionSubjects {
  // Предметы принятий риска: finding, customer_question, review_check_result, field_version, candidate_check.
  subjects?: readonly { type: string; id: string }[];
  // Предметы событий входов (stage_input_event.ref_type / ref_id).
  events?: readonly { refType: string; refId: string }[];
  // Замечания рисков этапа 09 (манифест выпуска).
  findings?: readonly string[];
}

export interface IDecisionVisibility {
  subject: (type: string, id: string) => boolean;
  event: (refType: string, refId: string) => boolean;
  finding: (id: string) => boolean;
}

// Виды предметов, открытые каждому, кто видит комплект (сам комплект закрыт, если закрыта хоть одна версия поля).
const CANDIDATE_LEVEL = new Set(['review_check_result', 'candidate_check']);
// События уровня тендера: видны тем, кто читает содержимое тендера.
const TENDER_LEVEL = new Set(['import_batch', 'calculation_revision', 'source_set_revision', 'qa_import', 'transcript_revision']);

export const decisionVisibility = async (db: Queryable, ctx: IAccessContext, stage: { id: string; tenderId: string }, q: IDecisionSubjects): Promise<IDecisionVisibility> => {
  const subjects = q.subjects ?? [];
  const events = q.events ?? [];
  const ofType = <T>(list: readonly T[], pick: (x: T) => [string, string], type: string): string[] => [...new Set(list.map(pick).filter(([t]) => t === type).map(([, id]) => id))];
  const subjectIds = (type: string) => ofType(subjects, (s) => [s.type, s.id], type);
  const eventIds = (type: string) => ofType(events, (e) => [e.refType, e.refId], type);

  // Решения-предметы событий: по требованию — замыкание этапа; по замечанию — замечание; по разногласию — его замечание и
  // основания осей.
  const decisions = new Map(
    (
      await db.query<{ id: string; decision_type: string; subject_id: string }>('SELECT id, decision_type, subject_id FROM decision WHERE id = ANY($1::uuid[])', [eventIds('decision')])
    ).rows.map((d) => [d.id, d]),
  );
  const discrepancyIds = [...decisions.values()].filter((d) => d.decision_type === 'discrepancy_decision').map((d) => d.subject_id);
  const discrepancies = new Map(
    (await db.query<{ id: string; finding_id: string }>('SELECT id, finding_id FROM discrepancy WHERE id = ANY($1::uuid[])', [discrepancyIds])).rows.map((d) => [d.id, d.finding_id]),
  );
  const axes = await axisEvents(db, discrepancyIds);
  const findingIds = [
    ...subjectIds('finding'),
    ...(q.findings ?? []),
    ...[...decisions.values()].filter((d) => d.decision_type === 'finding_resolution' || d.decision_type === 'finding_risk_acceptance').map((d) => d.subject_id),
    ...discrepancies.values(),
  ];
  const review = await reviewVisibility(db, ctx, stage.id, findingIds.length ? await findingEvidence(db, [...new Set(findingIds)]) : [], {
    fragments: axes.flatMap((e) => e.bases.map((b) => b.fragment_id).filter((x): x is string => !!x)),
    mailRevisions: axes.flatMap((e) => e.bases.map((b) => b.mail_message_revision_id).filter((x): x is string => !!x)),
    documentRevisions: axes.flatMap((e) => e.bases.map((b) => b.document_revision_id).filter((x): x is string => !!x)),
  });
  const stageVis = await stageVisibility(db, ctx, stage.id);
  const fields = await fieldVersionVisibility(db, ctx, [...subjectIds('field_version'), ...eventIds('draft_field_version')]);

  const recognition = new Map(
    (
      await db.query<{ id: string; document_revision_id: string }>('SELECT id, document_revision_id FROM recognition_run WHERE id = ANY($1::uuid[])', [eventIds('recognition_run')])
    ).rows.map((r) => [r.id, r.document_revision_id]),
  );
  const docs = await readableDocumentRevisions(db, ctx, [...eventIds('document_revision'), ...recognition.values()]);
  const mails = new Set(
    (
      await db.query<{ id: string }>('SELECT id FROM mail_message WHERE id = ANY($1::uuid[]) AND mailbox_id = ANY($2::uuid[])', [eventIds('mail_message'), readableMailboxIds(ctx)])
    ).rows.map((m) => m.id),
  );
  const tenderContent = contentTenderIds(ctx).includes(stage.tenderId);

  const decisionVisible = (id: string): boolean => {
    const d = decisions.get(id);
    if (!d) return false;
    if (d.decision_type === 'requirement_decision') return stageVis.visible('decision', d.id);
    if (d.decision_type === 'finding_resolution' || d.decision_type === 'finding_risk_acceptance') return review.finding(d.subject_id);
    if (d.decision_type === 'discrepancy_decision') {
      const finding = discrepancies.get(d.subject_id);
      return !!finding && review.finding(finding) && axisBasesVisible(axes.filter((e) => e.discrepancy_id === d.subject_id), review);
    }
    return false;
  };

  return {
    subject: (type, id) => {
      if (CANDIDATE_LEVEL.has(type)) return true;
      if (type === 'finding') return review.finding(id);
      if (type === 'customer_question') return stageVis.visible('question', id);
      if (type === 'field_version') return fields(id);
      return false;
    },
    event: (refType, refId) => {
      if (TENDER_LEVEL.has(refType)) return tenderContent;
      if (refType === 'mail_message') return mails.has(refId);
      if (refType === 'document_revision') return docs.has(refId);
      if (refType === 'recognition_run') return docs.has(recognition.get(refId) ?? '');
      if (refType === 'draft_field_version') return fields(refId);
      if (refType === 'decision') return decisionVisible(refId);
      return false;
    },
    finding: (id) => review.finding(id),
  };
};

// ---------------------------------------------------------------- Комплект и манифест выпуска

// Комплект виден, если видна каждая закреплённая в нём версия поля.
export const candidateVisibleTo = async (db: Queryable, ctx: IAccessContext, candidateId: string): Promise<boolean> => {
  const pinned = await candidateFieldVersionIds(db, candidateId);
  const visible = await fieldVersionVisibility(db, ctx, pinned);
  return pinned.every(visible);
};

type ManifestDecisions = Pick<IReleaseManifest, 'acceptedRisks' | 'reviewRisks' | 'holds'>;

// Предметы решений, записанных в манифест выпуска: принятые риски, риски этапа 09, события решений по удержаниям.
export const releaseManifestSubjects = async (db: Queryable, stageId: string, m: ManifestDecisions): Promise<IDecisionSubjects & { subjects: { type: string; id: string }[]; findings: string[]; events: { refType: string; refId: string }[] }> => {
  const events = (
    await db.query<{ ref_type: string; ref_id: string }>('SELECT ref_type, ref_id FROM stage_input_event WHERE stage_id = $1 AND seq = ANY($2::bigint[])', [
      stageId,
      m.holds.map((h) => h.eventSeq),
    ])
  ).rows.map((e) => ({ refType: e.ref_type, refId: e.ref_id }));
  return { subjects: m.acceptedRisks.map((a) => ({ type: a.subjectType, id: a.subjectId })), findings: m.reviewRisks.map((x) => x.findingId), events };
};

// Манифест выпуска — точная неизменяемая запись с причинами решений: читает тот, кто сейчас видит предмет каждого
// решения в нём (R13-02). Запись при отзыве прав не переписывается — закрывается чтение.
export const releaseManifestReadableBy = async (db: Queryable, ctx: IAccessContext, r: { stage_id: string; tender_id: string }, m: ManifestDecisions): Promise<boolean> => {
  const q = await releaseManifestSubjects(db, r.stage_id, m);
  const vis = await decisionVisibility(db, ctx, { id: r.stage_id, tenderId: r.tender_id }, q);
  return q.subjects.every((x) => vis.subject(x.type, x.id)) && q.findings.every(vis.finding) && q.events.every((e) => vis.event(e.refType, e.refId));
};
