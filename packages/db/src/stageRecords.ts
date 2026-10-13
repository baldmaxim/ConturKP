// Допущение, вопрос заказчику и пометка этапа (OD-08-6, вариант A): три отдельных типа, не требования и не
// факты. Допущение — ревизии со статусом и автором; вопрос — изменяемая запись со статусами и ответом из Q&A
// или пояснением; пометка — неизменяемая заметка, в полноту, факты, требования и вход модели не попадает.
import type { AssumptionStatus, CustomerQuestionStatus, IEvidenceRef } from '@kontur/core';
import { insertEvidenceLinks } from './requirementAccess.ts';
import type { Queryable } from './pool.ts';

export interface IAssumptionRow {
  id: string;
  tender_id: string;
  stage_id: string;
  requirement_id: string | null;
  requirement_code: string | null;
  current_revision_id: string;
  row_version: number;
  created_at: Date;
  seq: number;
  statement: string;
  status: AssumptionStatus;
  superseded_by_assumption_id: string | null;
  reason: string | null;
  authored_by: string;
  revision_created_at: Date;
}

const ASSUMPTION_SELECT = `SELECT a.id, a.tender_id, a.stage_id, a.requirement_id, q.code AS requirement_code, a.current_revision_id, a.row_version, a.created_at,
                                  v.seq, v.statement, v.status, v.superseded_by_assumption_id, v.reason, v.authored_by, v.created_at AS revision_created_at
                             FROM assumption a
                             JOIN assumption_revision v ON v.id = a.current_revision_id
                             LEFT JOIN requirement q ON q.id = a.requirement_id`;

export const listAssumptions = async (db: Queryable, stageId: string): Promise<IAssumptionRow[]> =>
  (await db.query<IAssumptionRow>(`${ASSUMPTION_SELECT} WHERE a.stage_id = $1 ORDER BY a.created_at, a.id`, [stageId])).rows;

export const getAssumption = async (db: Queryable, id: string): Promise<IAssumptionRow | null> =>
  (await db.query<IAssumptionRow>(`${ASSUMPTION_SELECT} WHERE a.id = $1`, [id])).rows[0] ?? null;

export const assumptionRevisions = async (db: Queryable, id: string) =>
  (await db.query<{ id: string; seq: number; statement: string; status: AssumptionStatus; reason: string | null; authored_by: string; created_at: Date }>(
    'SELECT id, seq, statement, status, reason, authored_by, created_at FROM assumption_revision WHERE assumption_id = $1 ORDER BY seq',
    [id],
  )).rows;

export const createAssumption = async (
  db: Queryable,
  r: { tenderId: string; stageId: string; requirementId: string | null; statement: string; evidence: IEvidenceRef[] | null; userId: string },
): Promise<string> => {
  const revisionId = (await db.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  const a = await db.query<{ id: string }>(
    'INSERT INTO assumption (tender_id, stage_id, requirement_id, current_revision_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [r.tenderId, r.stageId, r.requirementId, revisionId],
  );
  await db.query(
    `INSERT INTO assumption_revision (id, assumption_id, tender_id, stage_id, seq, statement, status, authored_by)
     VALUES ($1, $2, $3, $4, 1, $5, 'open', $6)`,
    [revisionId, a.rows[0]!.id, r.tenderId, r.stageId, r.statement, r.userId],
  );
  if (r.evidence) await insertEvidenceLinks(db, 'assumption_revision_id', revisionId, r.tenderId, r.userId, r.evidence);
  return a.rows[0]!.id;
};

// Новая ревизия допущения: правка текста в open, подтверждение, отклонение, замена (охранник проверяет переход и право).
export const reviseAssumption = async (
  db: Queryable,
  a: IAssumptionRow,
  rowVersion: number,
  r: { statement: string; status: AssumptionStatus; reason: string | null; supersededBy: string | null; userId: string },
): Promise<string | null> => {
  const lock = await db.query('SELECT 1 FROM assumption WHERE id = $1 AND row_version = $2 FOR UPDATE', [a.id, rowVersion]);
  if ((lock.rowCount ?? 0) !== 1) return null;
  const rev = await db.query<{ id: string }>(
    `INSERT INTO assumption_revision (assumption_id, tender_id, stage_id, seq, supersedes_revision_id, statement, status, superseded_by_assumption_id, reason, authored_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [a.id, a.tender_id, a.stage_id, a.seq + 1, a.current_revision_id, r.statement, r.status, r.supersededBy, r.reason, r.userId],
  );
  await db.query('UPDATE assumption SET current_revision_id = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [a.id, rev.rows[0]!.id]);
  return rev.rows[0]!.id;
};

// ---------------------------------------------------------------- Вопрос заказчику

export interface ICustomerQuestionRow {
  id: string;
  tender_id: string;
  stage_id: string;
  requirement_id: string | null;
  requirement_code: string | null;
  // Происхождение (миграция 0041, R16-01): предложение из чата, принятием которого создан вопрос; неизменно.
  source_proposal_id: string | null;
  text: string;
  status: CustomerQuestionStatus;
  asked_at: Date | null;
  answered_at: Date | null;
  answer_qa_item_revision_id: string | null;
  answer_qa_item_no: string | null;
  answer_note: string | null;
  responsible_user_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  row_version: number;
}

const QUESTION_SELECT = `SELECT c.*, q.code AS requirement_code, qi.item_no AS answer_qa_item_no
                           FROM customer_question c
                           LEFT JOIN requirement q ON q.id = c.requirement_id
                           LEFT JOIN qa_item_revision qr ON qr.id = c.answer_qa_item_revision_id
                           LEFT JOIN qa_item qi ON qi.id = qr.item_id`;

export const listCustomerQuestions = async (db: Queryable, stageId: string): Promise<ICustomerQuestionRow[]> =>
  (await db.query<ICustomerQuestionRow>(`${QUESTION_SELECT} WHERE c.stage_id = $1 ORDER BY c.created_at, c.id`, [stageId])).rows;

export const getCustomerQuestion = async (db: Queryable, id: string): Promise<ICustomerQuestionRow | null> =>
  (await db.query<ICustomerQuestionRow>(`${QUESTION_SELECT} WHERE c.id = $1`, [id])).rows[0] ?? null;

export const createCustomerQuestion = async (
  db: Queryable,
  r: { tenderId: string; stageId: string; requirementId: string | null; text: string; responsibleUserId: string | null; userId: string; sourceProposalId?: string | null },
): Promise<string> =>
  (
    await db.query<{ id: string }>(
      `INSERT INTO customer_question (tender_id, stage_id, requirement_id, text, responsible_user_id, created_by, updated_by, source_proposal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7) RETURNING id`,
      [r.tenderId, r.stageId, r.requirementId, r.text, r.responsibleUserId, r.userId, r.sourceProposalId ?? null],
    )
  ).rows[0]!.id;

export interface IQuestionPatch {
  text: string;
  requirementId: string | null;
  status: CustomerQuestionStatus;
  askedAt: Date | null;
  answeredAt: Date | null;
  answerQaItemRevisionId: string | null;
  answerNote: string | null;
  responsibleUserId: string | null;
}

export const updateCustomerQuestion = async (db: Queryable, id: string, rowVersion: number, p: IQuestionPatch, userId: string): Promise<boolean> =>
  ((
    await db.query(
      `UPDATE customer_question SET text = $3, requirement_id = $4, status = $5, asked_at = $6, answered_at = $7, answer_qa_item_revision_id = $8,
              answer_note = $9, responsible_user_id = $10, updated_by = $11, updated_at = now(), row_version = row_version + 1
        WHERE id = $1 AND row_version = $2`,
      [id, rowVersion, p.text, p.requirementId, p.status, p.askedAt, p.answeredAt, p.answerQaItemRevisionId, p.answerNote, p.responsibleUserId, userId],
    )
  ).rowCount ?? 0) === 1;

// ---------------------------------------------------------------- Пометка этапа

export interface IStageNoteRow {
  id: string;
  stage_id: string;
  text: string;
  supersedes_note_id: string | null;
  superseded_by: string | null;
  created_by: string;
  created_at: Date;
}

export const listStageNotes = async (db: Queryable, stageId: string): Promise<IStageNoteRow[]> =>
  (
    await db.query<IStageNoteRow>(
      `SELECT n.id, n.stage_id, n.text, n.supersedes_note_id, s.id AS superseded_by, n.created_by, n.created_at
         FROM stage_note n LEFT JOIN stage_note s ON s.supersedes_note_id = n.id
        WHERE n.stage_id = $1 ORDER BY n.created_at DESC, n.id`,
      [stageId],
    )
  ).rows;

export const createStageNote = async (db: Queryable, r: { tenderId: string; stageId: string; text: string; supersedesNoteId: string | null; userId: string }): Promise<string> =>
  (
    await db.query<{ id: string }>(
      'INSERT INTO stage_note (tender_id, stage_id, text, supersedes_note_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [r.tenderId, r.stageId, r.text, r.supersedesNoteId, r.userId],
    )
  ).rows[0]!.id;
