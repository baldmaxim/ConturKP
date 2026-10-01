// Покрытие (Р-08-2): история оценок конкретной ревизии требования и 1..N типизированных объектов —
// фрагмент, ревизия расчёта (позиция и строка; комплексная расценка — позиция без строки, A05), решение,
// ручное подтверждение. Новая ревизия расчёта этапа ставит needs_review триггером БД. Решение по требованию —
// строка decision как неизменяемая версия, замена — supersedes_decision_id (Р-08-3), запись — событие барьера.
import type { CoverageMatch, CoverageObjectType, CoverageState, IEvidenceRef } from '@kontur/core';
import { insertEvidenceLinks } from './requirementAccess.ts';
import type { Queryable } from './pool.ts';
import { emitStageEvents } from './stageEvents.ts';

export interface ICoverageObjectInput {
  type: CoverageObjectType;
  fragmentId?: string | null;
  calculationRevisionId?: string | null;
  externalPositionId?: string | null;
  externalItemId?: string | null;
  match?: CoverageMatch | null;
  decisionId?: string | null;
  note?: string | null;
}

export interface ICoverageRow {
  id: string;
  requirement_revision_id: string;
  seq: number;
  state: CoverageState;
  reason: string | null;
  origin: 'human' | 'system';
  assessed_by: string | null;
  trigger_calculation_revision_id: string | null;
  created_at: Date;
  objects: {
    id: string;
    object_type: CoverageObjectType;
    fragment_id: string | null;
    calculation_revision_id: string | null;
    calculation_revision_seq: number | null;
    calculation_revision_kind: string | null;
    external_position_id: string | null;
    external_item_id: string | null;
    position_name: string | null;
    position_number: string | null;
    match: CoverageMatch | null;
    decision_id: string | null;
    note: string | null;
  }[];
}

export const coverageHistory = async (db: Queryable, revisionIds: readonly string[]): Promise<ICoverageRow[]> => {
  if (revisionIds.length === 0) return [];
  const cov = await db.query<Omit<ICoverageRow, 'objects'>>(
    `SELECT id, requirement_revision_id, seq, state, reason, origin, assessed_by, trigger_calculation_revision_id, created_at
       FROM requirement_coverage WHERE requirement_revision_id = ANY($1::uuid[]) ORDER BY requirement_revision_id, seq`,
    [[...revisionIds]],
  );
  const obj = await db.query<ICoverageRow['objects'][number] & { coverage_id: string }>(
    `SELECT o.id, o.coverage_id, o.object_type, o.fragment_id, o.calculation_revision_id, r.seq AS calculation_revision_seq, r.kind AS calculation_revision_kind,
            o.external_position_id, o.external_item_id, p.position_name, p.position_number::text AS position_number, o.match, o.decision_id, o.note
       FROM requirement_coverage_object o
       LEFT JOIN calculation_revision r ON r.id = o.calculation_revision_id
       LEFT JOIN calculation_position p ON p.content_id = r.content_id AND p.external_position_id = o.external_position_id
      WHERE o.coverage_id = ANY($1::uuid[]) ORDER BY o.created_at, o.id`,
    [cov.rows.map((c) => c.id)],
  );
  return cov.rows.map((c) => ({ ...c, objects: obj.rows.filter((o) => o.coverage_id === c.id) }));
};

// Новая оценка текущей ревизии (requirement.confirm — охранник): номер — следующий по ревизии.
export const recordCoverage = async (
  db: Queryable,
  r: { tenderId: string; stageId: string; revisionId: string; state: CoverageState; reason: string | null; objects: ICoverageObjectInput[]; userId: string },
): Promise<string> => {
  const last = await db.query<{ id: string; seq: number }>(
    'SELECT id, seq FROM requirement_coverage WHERE requirement_revision_id = $1 ORDER BY seq DESC LIMIT 1',
    [r.revisionId],
  );
  const ins = await db.query<{ id: string }>(
    `INSERT INTO requirement_coverage (tender_id, stage_id, requirement_revision_id, seq, supersedes_coverage_id, state, reason, origin, assessed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'human', $8) RETURNING id`,
    [r.tenderId, r.stageId, r.revisionId, (last.rows[0]?.seq ?? 0) + 1, last.rows[0]?.id ?? null, r.state, r.reason, r.userId],
  );
  const id = ins.rows[0]!.id;
  for (const o of r.objects) {
    await db.query(
      `INSERT INTO requirement_coverage_object (coverage_id, tender_id, object_type, fragment_id, calculation_revision_id, external_position_id,
                                                external_item_id, match, decision_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, r.tenderId, o.type, o.fragmentId ?? null, o.calculationRevisionId ?? null, o.externalPositionId ?? null, o.externalItemId ?? null,
       o.match ?? null, o.decisionId ?? null, o.note ?? null],
    );
  }
  return id;
};

// ---------------------------------------------------------------- Решения по требованию

export interface IRequirementDecisionRow {
  id: string;
  subject_id: string;
  statement: string;
  rationale: string;
  decided_by: string;
  supersedes_decision_id: string | null;
  superseded_by: string | null;
  created_at: Date;
}

export const requirementDecisions = async (db: Queryable, requirementIds: readonly string[]): Promise<IRequirementDecisionRow[]> =>
  requirementIds.length === 0
    ? []
    : (
        await db.query<IRequirementDecisionRow>(
          `SELECT d.id, d.subject_id, d.statement, d.rationale, d.decided_by, d.supersedes_decision_id, n.id AS superseded_by, d.created_at
             FROM decision d LEFT JOIN decision n ON n.supersedes_decision_id = d.id
            WHERE d.decision_type = 'requirement_decision' AND d.subject_type = 'requirement' AND d.subject_id = ANY($1::uuid[])
            ORDER BY d.created_at, d.id`,
          [[...requirementIds]],
        )
      ).rows;

export const getDecision = async (db: Queryable, id: string) =>
  (await db.query<IRequirementDecisionRow & { tender_id: string; stage_id: string; decision_type: string }>(
    `SELECT d.id, d.tender_id, d.stage_id, d.decision_type, d.subject_id, d.statement, d.rationale, d.decided_by, d.supersedes_decision_id,
            n.id AS superseded_by, d.created_at
       FROM decision d LEFT JOIN decision n ON n.supersedes_decision_id = d.id WHERE d.id = $1`,
    [id],
  )).rows[0] ?? null;

// Запись решения: событие барьера decision_recorded — первой блокировкой транзакции (state-machines §1.1).
export const recordRequirementDecision = async (
  db: Queryable,
  r: { tenderId: string; stageId: string; requirementId: string; statement: string; rationale: string; supersedesId: string | null; evidence: IEvidenceRef[]; userId: string },
): Promise<string> => {
  const id = (await db.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  await emitStageEvents(db, { tenderId: r.tenderId, stageIds: [r.stageId], eventType: 'decision_recorded', refType: 'decision', refId: id, actorUserId: r.userId });
  await db.query(
    `INSERT INTO decision (id, tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by, supersedes_decision_id)
     VALUES ($1, $2, $3, 'requirement', $4, 'requirement_decision', $5, $6, $7, $8)`,
    [id, r.tenderId, r.stageId, r.requirementId, r.statement, r.rationale, r.userId, r.supersedesId],
  );
  await insertEvidenceLinks(db, 'decision_id', id, r.tenderId, r.userId, r.evidence);
  return id;
};
