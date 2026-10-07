// Закрытость производных текстов решений этапа 13 (Review 13-1 R13-02; R08-02, ADR-006). Причина принятия риска
// наследует закрытость своего предмета: замечание — его основания (как в этапе 09), вопрос заказчику — замыкание
// закрытости этапа 08. Причина решения по удержанию — закрытость предмета события входа: письмо — mail.read его ящика,
// редакция документа и распознавание — чтение документа (вложение письма — mail.read), версия поля — её основания,
// решение — его предмет; события тендера (загрузка, расчёт, набор источников, вопросы–ответы, транскрипция) — доступ к
// содержимому тендера. Права — текущие. Предмет, закрытость которого не определяется, закрыт.
import {
  axisEvents,
  contentTenderIds,
  fieldVersionVisibility,
  findingEvidence,
  readableDocumentRevisions,
  readableMailboxIds,
  stageVisibility,
  type IAccessContext,
  type Queryable,
} from '@kontur/db';
import { axisBasesVisible, reviewVisibility } from './reviewMappers.ts';

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
