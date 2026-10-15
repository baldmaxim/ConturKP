// Замечания и гипотезы модели этапа 09 (docs/architecture/09-review-checks-design.md §3, §5). Каждое изменение замечания —
// событие той же транзакции (вторая линия — finding_change_logged). Решения — неизменяемые версии decision; разногласия,
// приоритет источников и читаемость — discrepancies.ts.
import {
  findingKey,
  type Confidence,
  type FindingKind,
  type FindingStatus,
  type IEvidenceDraft,
  type Severity,
} from '@kontur/core';
import type { Queryable } from './pool.ts';
import { dependenciesOf, insertDependencies, insertFindingEvidence } from './reviewRuns.ts';
import { emitStageEvents, lockTenderStages } from './stageEvents.ts';

export interface IFindingRow {
  id: string;
  tender_id: string;
  stage_id: string;
  finding_key: string;
  kind: FindingKind;
  check_code: string | null;
  origin: 'rule' | 'model_suggestion' | 'human';
  title: string;
  detail: string | null;
  severity: Severity;
  confidence: Confidence;
  status: FindingStatus;
  owner_user_id: string | null;
  owner_name: string | null;
  action: string | null;
  impact: string | null;
  suggested_side: 'left' | 'right' | null;
  first_run_id: string | null;
  suggestion_id: string | null;
  created_by: string | null;
  created_input_version: number;
  basis_input_version: number;
  created_at: Date;
  updated_at: Date;
  row_version: number;
  discrepancy_id: string | null;
  last_run_id: string | null;
  invalidated: boolean;
}

// Версия входов, на которых основано замечание: создание или последнее обнаружение прогоном (снимок прогона).
const FINDING_SELECT = `SELECT f.*, u.display_name AS owner_name, d.id AS discrepancy_id,
       greatest(f.created_input_version, coalesce((SELECT max(r.scope_input_version) FROM finding_occurrence o JOIN review_run r ON r.id = o.run_id
                                                    WHERE o.finding_id = f.id), 0)) AS basis_input_version,
       (SELECT o.run_id FROM finding_occurrence o JOIN review_run r ON r.id = o.run_id WHERE o.finding_id = f.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_id,
       EXISTS (SELECT 1 FROM evidence_invalidation i WHERE i.dependent_type = 'finding' AND i.dependent_id = f.id) AS invalidated
  FROM finding f
  LEFT JOIN app_user u ON u.id = f.owner_user_id
  LEFT JOIN discrepancy d ON d.finding_id = f.id`;

export const getFinding = async (db: Queryable, id: string, lock = false): Promise<IFindingRow | null> => {
  if (lock) await db.query('SELECT 1 FROM finding WHERE id = $1 FOR UPDATE', [id]);
  return (await db.query<IFindingRow>(`${FINDING_SELECT} WHERE f.id = $1`, [id])).rows[0] ?? null;
};

export interface IFindingFilter {
  status: FindingStatus | null;
  kind: string | null;
  severity: Severity | null;
  runId: string | null;
}

export const listFindings = async (db: Queryable, stageId: string, f: IFindingFilter): Promise<IFindingRow[]> =>
  (
    await db.query<IFindingRow>(
      `${FINDING_SELECT}
        WHERE f.stage_id = $1 AND ($2::text IS NULL OR f.status = $2) AND ($3::text IS NULL OR f.kind = $3) AND ($4::text IS NULL OR f.severity = $4)
          AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM finding_occurrence o WHERE o.finding_id = f.id AND o.run_id = $5))
        ORDER BY CASE f.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'stale' THEN 2 ELSE 3 END,
                 CASE f.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, f.created_at, f.id`,
      [stageId, f.status, f.kind, f.severity, f.runId],
    )
  ).rows;

export interface IFindingEvidenceRow {
  finding_id: string;
  side: 'left' | 'right' | 'context';
  object_type: IEvidenceDraft['objectType'];
  fragment_id: string | null;
  fragment_text: string | null;
  fragment_origin: string | null;
  page_index: number | null;
  document_title: string | null;
  calculation_revision_id: string | null;
  external_position_id: string | null;
  external_item_id: string | null;
  calc_text: string | null;
  calc_unit: string | null;
  calc_quantity: string | null;
  requirement_revision_id: string | null;
  requirement_id: string | null;
  requirement_code: string | null;
  evidence_fact_id: string | null;
  fact_type: string | null;
  fact_raw_value: string | null;
  fact_fragment_ids: string[] | null;
  customer_question_id: string | null;
  question_text: string | null;
  question_requirement_id: string | null;
  qa_item_revision_id: string | null;
  qa_question: string | null;
  assumption_id: string | null;
  document_revision_id: string | null;
  revision_document_title: string | null;
  revision_seq: number | null;
  revision_tender_id: string | null;
  revision_contract_id: string | null;
  note: string | null;
}

export const findingEvidence = async (db: Queryable, findingIds: readonly string[]): Promise<IFindingEvidenceRow[]> =>
  findingIds.length === 0
    ? []
    : (
        await db.query<IFindingEvidenceRow>(
          `SELECT x.finding_id, x.side, x.object_type, x.fragment_id, fr.text AS fragment_text, fr.origin AS fragment_origin, fr.page_index,
                  fd.title AS document_title,
                  x.calculation_revision_id, x.external_position_id, x.external_item_id,
                  coalesce(l.description, l.work_name, l.material_name, p.work_name, p.position_name) AS calc_text,
                  coalesce(l.unit_code, p.unit_code) AS calc_unit, coalesce(l.quantity, coalesce(p.manual_volume, p.volume))::text AS calc_quantity,
                  x.requirement_revision_id, rv.requirement_id, rq.code AS requirement_code,
                  x.evidence_fact_id, ef.fact_type, ef.raw_value AS fact_raw_value,
                  CASE WHEN ef.id IS NULL THEN NULL ELSE array(SELECT ff.fragment_id FROM evidence_fact_fragment ff WHERE ff.evidence_fact_id = ef.id ORDER BY ff.ordinal) END AS fact_fragment_ids,
                  x.customer_question_id, cq.text AS question_text, cq.requirement_id AS question_requirement_id,
                  x.qa_item_revision_id, qr.question AS qa_question, x.assumption_id,
                  x.document_revision_id, dd.title AS revision_document_title, dr.revision_seq, dr.tender_id AS revision_tender_id, dr.contract_id AS revision_contract_id,
                  x.note
             FROM finding_evidence x
             LEFT JOIN evidence_fragment fr ON fr.id = x.fragment_id
             LEFT JOIN document_revision fdr ON fdr.id = fr.document_revision_id
             LEFT JOIN document fd ON fd.id = fdr.document_id
             LEFT JOIN calculation_revision cr ON cr.id = x.calculation_revision_id
             LEFT JOIN calculation_position p ON p.content_id = cr.content_id AND p.external_position_id = x.external_position_id
             LEFT JOIN calculation_line l ON l.content_id = cr.content_id AND l.external_position_id = x.external_position_id AND l.external_item_id = x.external_item_id
             LEFT JOIN requirement_revision rv ON rv.id = x.requirement_revision_id
             LEFT JOIN requirement rq ON rq.id = rv.requirement_id
             LEFT JOIN evidence_fact ef ON ef.id = x.evidence_fact_id
             LEFT JOIN customer_question cq ON cq.id = x.customer_question_id
             LEFT JOIN qa_item_revision qr ON qr.id = x.qa_item_revision_id
             LEFT JOIN document_revision dr ON dr.id = x.document_revision_id
             LEFT JOIN document dd ON dd.id = dr.document_id
            WHERE x.finding_id = ANY($1::uuid[])
            ORDER BY x.finding_id, CASE x.side WHEN 'left' THEN 0 WHEN 'right' THEN 1 ELSE 2 END, x.id`,
          [[...findingIds]],
        )
      ).rows;

export interface IFindingEventRow {
  seq: number;
  event_kind: string;
  from_value: string | null;
  to_value: string | null;
  reason: string | null;
  actor_kind: 'human' | 'system';
  actor_name: string | null;
  decision_id: string | null;
  stage_input_event_id: string | null;
  run_id: string | null;
  created_at: Date;
}

export const findingEvents = async (db: Queryable, findingId: string): Promise<IFindingEventRow[]> =>
  (
    await db.query<IFindingEventRow>(
      `SELECT e.seq, e.event_kind, e.from_value, e.to_value, e.reason, e.actor_kind, u.display_name AS actor_name, e.decision_id, e.stage_input_event_id, e.run_id, e.created_at
         FROM finding_event e LEFT JOIN app_user u ON u.id = e.actor_user_id WHERE e.finding_id = $1 ORDER BY e.seq`,
      [findingId],
    )
  ).rows;

export const findingOccurrences = async (db: Queryable, findingId: string): Promise<{ run_id: string; created_at: Date; status: string }[]> =>
  (
    await db.query<{ run_id: string; created_at: Date; status: string }>(
      'SELECT r.id AS run_id, r.created_at, r.status FROM finding_occurrence o JOIN review_run r ON r.id = o.run_id WHERE o.finding_id = $1 ORDER BY r.created_at DESC',
      [findingId],
    )
  ).rows;

export interface IDecisionView {
  id: string;
  decision_type: string;
  statement: string;
  rationale: string;
  decided_by_name: string;
  created_at: Date;
  invalidated_reason: string | null;
}

// Решения по замечанию и разногласию с отметкой недействительности (D-029: решение сохраняется в истории).
export const decisionsFor = async (db: Queryable, subjectIds: readonly string[]): Promise<(IDecisionView & { subject_id: string })[]> =>
  subjectIds.length === 0
    ? []
    : (
        await db.query<IDecisionView & { subject_id: string }>(
          `SELECT d.id, d.subject_id, d.decision_type, d.statement, d.rationale, u.display_name AS decided_by_name, d.created_at,
                  (SELECT i.reason FROM evidence_invalidation i WHERE i.dependent_type = 'decision' AND i.dependent_id = d.id ORDER BY i.created_at LIMIT 1) AS invalidated_reason
             FROM decision d JOIN app_user u ON u.id = d.decided_by
            WHERE d.subject_id = ANY($1::uuid[]) AND d.decision_type IN ('finding_resolution', 'finding_risk_acceptance', 'discrepancy_decision')
            ORDER BY d.created_at, d.id`,
          [[...subjectIds]],
        )
      ).rows;

export const findingInvalidations = async (db: Queryable, findingId: string): Promise<{ reason: string; mode: string; event_type: string; event_seq: number; created_at: Date }[]> =>
  (
    await db.query<{ reason: string; mode: string; event_type: string; event_seq: number; created_at: Date }>(
      `SELECT i.reason, i.mode, e.event_type, e.seq AS event_seq, i.created_at FROM evidence_invalidation i JOIN stage_input_event e ON e.id = i.stage_input_event_id
        WHERE i.dependent_type = 'finding' AND i.dependent_id = $1 ORDER BY e.seq`,
      [findingId],
    )
  ).rows;

// ---------------------------------------------------------------- Изменения замечания

const nextSeq = `(SELECT coalesce(max(seq), 0) + 1 FROM finding_event WHERE finding_id = $1)`;

export const insertFindingEvent = async (
  db: Queryable,
  e: { findingId: string; tenderId: string; kind: string; from: string | null; to: string | null; reason: string | null; userId: string | null; decisionId?: string | null; stageInputEventId?: string | null },
): Promise<void> => {
  await db.query(
    `INSERT INTO finding_event (finding_id, tender_id, seq, event_kind, from_value, to_value, reason, actor_kind, actor_user_id, decision_id, stage_input_event_id)
     VALUES ($1, $2, ${nextSeq}, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [e.findingId, e.tenderId, e.kind, e.from, e.to, e.reason, e.userId ? 'human' : 'system', e.userId, e.decisionId ?? null, e.stageInputEventId ?? null],
  );
};

export const insertReviewDecision = async (
  db: Queryable,
  d: { tenderId: string; stageId: string; type: 'finding_resolution' | 'finding_risk_acceptance' | 'discrepancy_decision'; subjectType: 'finding' | 'discrepancy'; subjectId: string; statement: string; rationale: string; userId: string },
): Promise<string> => {
  // Сначала строка этапа (state-machines §1.2, S17-22): внешний ключ решения иначе берёт её раньше события.
  await lockTenderStages(db, d.tenderId, [d.stageId]);
  const prev = (
    await db.query<{ id: string }>(
      `SELECT id FROM decision d WHERE d.decision_type = $1 AND d.subject_id = $2
          AND NOT EXISTS (SELECT 1 FROM decision n WHERE n.supersedes_decision_id = d.id) ORDER BY created_at DESC LIMIT 1`,
      [d.type, d.subjectId],
    )
  ).rows[0];
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by, supersedes_decision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [d.tenderId, d.stageId, d.subjectType, d.subjectId, d.type, d.statement, d.rationale, d.userId, prev?.id ?? null],
    )
  ).rows[0]!.id;
  await emitStageEvents(db, { tenderId: d.tenderId, stageIds: [d.stageId], eventType: 'decision_recorded', refType: 'decision', refId: id, actorUserId: d.userId });
  return id;
};

// Переход статуса человеком: решено — с решением; принять риск — решение руководителя; отклонить — с причиной.
export const transitionFinding = async (
  db: Queryable,
  f: IFindingRow,
  t: { to: FindingStatus; reason: string | null; statement: string | null; userId: string; ownerUserId?: string | null },
): Promise<{ decisionId: string | null }> => {
  let decisionId: string | null = null;
  if (t.to === 'resolved' || t.to === 'accepted_risk') {
    decisionId = await insertReviewDecision(db, {
      tenderId: f.tender_id,
      stageId: f.stage_id,
      type: t.to === 'resolved' ? 'finding_resolution' : 'finding_risk_acceptance',
      subjectType: 'finding',
      subjectId: f.id,
      statement: t.statement ?? (t.to === 'resolved' ? 'Замечание решено' : 'Риск принят'),
      rationale: t.reason ?? '—',
      userId: t.userId,
    });
  }
  if (t.ownerUserId !== undefined && t.ownerUserId !== f.owner_user_id) {
    await insertFindingEvent(db, { findingId: f.id, tenderId: f.tender_id, kind: 'owner', from: f.owner_user_id, to: t.ownerUserId, reason: null, userId: t.userId });
  }
  await insertFindingEvent(db, { findingId: f.id, tenderId: f.tender_id, kind: 'status', from: f.status, to: t.to, reason: t.reason, userId: t.userId, decisionId });
  await db.query(
    'UPDATE finding SET status = $2, owner_user_id = $3, updated_at = now(), row_version = row_version + 1 WHERE id = $1',
    [f.id, t.to, t.ownerUserId !== undefined ? t.ownerUserId : f.owner_user_id],
  );
  return { decisionId };
};

export interface IFindingPatch {
  severity?: Severity;
  confidence?: Confidence;
  ownerUserId?: string | null;
  action?: string | null;
  impact?: string | null;
}

export const patchFinding = async (db: Queryable, f: IFindingRow, p: IFindingPatch, userId: string, reason: string | null): Promise<void> => {
  const changes: [string, string | null, string | null][] = [];
  if (p.severity !== undefined && p.severity !== f.severity) changes.push(['severity', f.severity, p.severity]);
  if (p.confidence !== undefined && p.confidence !== f.confidence) changes.push(['confidence', f.confidence, p.confidence]);
  if (p.ownerUserId !== undefined && p.ownerUserId !== f.owner_user_id) changes.push(['owner', f.owner_user_id, p.ownerUserId]);
  if (p.action !== undefined && p.action !== f.action) changes.push(['action', f.action, p.action]);
  if (p.impact !== undefined && p.impact !== f.impact) changes.push(['impact', f.impact, p.impact]);
  for (const [kind, from, to] of changes) await insertFindingEvent(db, { findingId: f.id, tenderId: f.tender_id, kind, from, to, reason, userId });
  await db.query(
    `UPDATE finding SET severity = $2, confidence = $3, owner_user_id = $4, action = $5, impact = $6, updated_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [
      f.id,
      p.severity ?? f.severity,
      p.confidence ?? f.confidence,
      p.ownerUserId !== undefined ? p.ownerUserId : f.owner_user_id,
      p.action !== undefined ? p.action : f.action,
      p.impact !== undefined ? p.impact : f.impact,
    ],
  );
};

// Замечание человека: основания — фрагменты снимков этапа и объекты расчёта; ключ — по содержанию и основаниям.
export const createHumanFinding = async (
  db: Queryable,
  h: { tenderId: string; stageId: string; userId: string; title: string; detail: string | null; severity: Severity; confidence: Confidence; action: string | null; evidence: IEvidenceDraft[]; inputVersion: number },
): Promise<string> => {
  const key = findingKey('human', h.title.toLowerCase(), ...h.evidence.map((e) => `${e.side}:${e.fragmentId ?? e.externalPositionId ?? ''}`).sort(), h.userId, String(Date.now()));
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO finding (tender_id, stage_id, finding_key, kind, origin, title, detail, severity, confidence, action, created_by, created_input_version)
       VALUES ($1, $2, $3, 'human', 'human', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [h.tenderId, h.stageId, key, h.title, h.detail, h.severity, h.confidence, h.action, h.userId, h.inputVersion],
    )
  ).rows[0]!.id;
  await insertFindingEvent(db, { findingId: id, tenderId: h.tenderId, kind: 'created', from: null, to: 'open', reason: null, userId: h.userId });
  await insertFindingEvidence(db, id, h.tenderId, h.evidence);
  await insertDependencies(db, { tenderId: h.tenderId, stageId: h.stageId, dependentType: 'finding', dependentId: id, refs: await dependenciesOf(db, h.evidence) });
  return id;
};

// ---------------------------------------------------------------- Гипотезы модели

export interface ISuggestionRow {
  id: string;
  tender_id: string;
  stage_id: string;
  run_id: string;
  title: string;
  rationale: string;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  decided_by_name: string | null;
  decision_reason: string | null;
  finding_id: string | null;
  created_at: Date;
  row_version: number;
  evidence: { side: string; fragment_id: string | null; calculation_revision_id: string | null; external_position_id: string | null }[];
}

const SUGGESTION_SELECT = `SELECT m.id, m.tender_id, m.stage_id, m.run_id, m.title, m.rationale, m.status, u.display_name AS decided_by_name, m.decision_reason,
       m.finding_id, m.created_at, m.row_version,
       coalesce((SELECT jsonb_agg(jsonb_build_object('side', e.side, 'fragment_id', e.fragment_id, 'calculation_revision_id', e.calculation_revision_id,
                                                     'external_position_id', e.external_position_id) ORDER BY e.side, e.id)
                   FROM model_suggestion_evidence e WHERE e.suggestion_id = m.id), '[]'::jsonb) AS evidence
  FROM model_suggestion m LEFT JOIN app_user u ON u.id = m.decided_by`;

export const listSuggestions = async (db: Queryable, runId: string): Promise<ISuggestionRow[]> =>
  (await db.query<ISuggestionRow>(`${SUGGESTION_SELECT} WHERE m.run_id = $1 ORDER BY m.created_at, m.id`, [runId])).rows;

export const getSuggestion = async (db: Queryable, id: string, lock = false): Promise<ISuggestionRow | null> => {
  if (lock) await db.query('SELECT 1 FROM model_suggestion WHERE id = $1 FOR UPDATE', [id]);
  return (await db.query<ISuggestionRow>(`${SUGGESTION_SELECT} WHERE m.id = $1`, [id])).rows[0] ?? null;
};

// Принятие гипотезы человеком: замечание происхождения model_suggestion с основаниями гипотезы; критичность — выбор человека.
export const acceptSuggestion = async (db: Queryable, s: ISuggestionRow, a: { userId: string; severity: Severity; reason: string | null; inputVersion: number }): Promise<string> => {
  const evidence: IEvidenceDraft[] = s.evidence.map((e) =>
    e.fragment_id
      ? { side: e.side as IEvidenceDraft['side'], objectType: 'fragment', fragmentId: e.fragment_id }
      : { side: e.side as IEvidenceDraft['side'], objectType: 'calculation_object', calculationRevisionId: e.calculation_revision_id!, externalPositionId: e.external_position_id!, externalItemId: null },
  );
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO finding (tender_id, stage_id, finding_key, kind, origin, title, detail, severity, confidence, first_run_id, suggestion_id, created_by, created_input_version)
       VALUES ($1, $2, $3, 'model_hypothesis', 'model_suggestion', $4, $5, $6, 'low', $7, $8, $9, $10) RETURNING id`,
      [s.tender_id, s.stage_id, findingKey('model_hypothesis', s.id), s.title, s.rationale, a.severity, s.run_id, s.id, a.userId, a.inputVersion],
    )
  ).rows[0]!.id;
  await insertFindingEvent(db, { findingId: id, tenderId: s.tender_id, kind: 'created', from: null, to: 'open', reason: a.reason, userId: a.userId });
  await insertFindingEvidence(db, id, s.tender_id, evidence);
  await insertDependencies(db, { tenderId: s.tender_id, stageId: s.stage_id, dependentType: 'finding', dependentId: id, refs: await dependenciesOf(db, evidence) });
  await db.query(
    "UPDATE model_suggestion SET status = 'accepted', decided_by = $2, decided_at = now(), decision_reason = $3, finding_id = $4, updated_at = now(), row_version = row_version + 1 WHERE id = $1",
    [s.id, a.userId, a.reason, id],
  );
  return id;
};

export const rejectSuggestion = async (db: Queryable, s: ISuggestionRow, userId: string, reason: string): Promise<void> => {
  await db.query(
    "UPDATE model_suggestion SET status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = $3, updated_at = now(), row_version = row_version + 1 WHERE id = $1",
    [s.id, userId, reason],
  );
};
