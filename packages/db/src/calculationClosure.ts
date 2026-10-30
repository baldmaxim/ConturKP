// Закрытый расчёт решением руководителя (этап 18; D-044, Q-01; проект §15). Решение — на одну ревизию `provisional`,
// отзывное; обе таблицы неизменяемы (миграция 0044). Команды вызываются под блокировкой этапа (lockTenderStages) —
// той же, что у согласования и выпуска; второй слой — advisory-блокировка этапа в охранниках БД. Кандидат закрепляет
// действующее решение входом `calculation_closure` (releaseCandidates.ts); единый предикат — `calculation_closed_by_decision`.
import type { Queryable } from './pool.ts';

export interface IClosureDecisionRow {
  id: string;
  tender_id: string;
  stage_id: string;
  calculation_revision_id: string;
  decided_by: string;
  decided_by_name: string;
  reason: string;
  decided_at: Date;
  revocation_id: string | null;
  revoked_by: string | null;
  revoked_by_name: string | null;
  revocation_reason: string | null;
  revoked_at: Date | null;
}

const SELECT = `
  SELECT d.id, d.tender_id, d.stage_id, d.calculation_revision_id, d.decided_by, du.display_name AS decided_by_name, d.reason, d.decided_at,
         v.id AS revocation_id, v.revoked_by, ru.display_name AS revoked_by_name, v.reason AS revocation_reason, v.revoked_at
    FROM calculation_closure_decision d
    JOIN app_user du ON du.id = d.decided_by
    LEFT JOIN calculation_closure_revocation v ON v.decision_id = d.id
    LEFT JOIN app_user ru ON ru.id = v.revoked_by`;

// История решений по ревизии: от последнего к первому.
export const listClosureDecisions = async (db: Queryable, revisionId: string): Promise<IClosureDecisionRow[]> =>
  (await db.query<IClosureDecisionRow>(`${SELECT} WHERE d.calculation_revision_id = $1 ORDER BY d.decided_at DESC, d.id`, [revisionId])).rows;

export const getClosureDecision = async (db: Queryable, id: string): Promise<IClosureDecisionRow | null> =>
  (await db.query<IClosureDecisionRow>(`${SELECT} WHERE d.id = $1`, [id])).rows[0] ?? null;

// Действующее решение: не отозвано (не больше одного на ревизию — охранник БД).
export const activeClosureDecision = (rows: readonly IClosureDecisionRow[]): IClosureDecisionRow | null => rows.find((r) => r.revocation_id === null) ?? null;

export const recordClosureDecision = async (
  db: Queryable,
  i: { tenderId: string; stageId: string; revisionId: string; userId: string; reason: string },
): Promise<IClosureDecisionRow> => {
  const id = (
    await db.query<{ id: string }>(
      'INSERT INTO calculation_closure_decision (tender_id, stage_id, calculation_revision_id, decided_by, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [i.tenderId, i.stageId, i.revisionId, i.userId, i.reason],
    )
  ).rows[0]!.id;
  return (await getClosureDecision(db, id))!;
};

export const revokeClosureDecision = async (db: Queryable, i: { decisionId: string; userId: string; reason: string }): Promise<IClosureDecisionRow> => {
  await db.query('INSERT INTO calculation_closure_revocation (decision_id, revoked_by, reason) VALUES ($1, $2, $3)', [i.decisionId, i.userId, i.reason]);
  return (await getClosureDecision(db, i.decisionId))!;
};

// Решение, закреплённое во входе кандидата (для показа: кто и когда решил, отозвано ли).
export const candidateClosureDecision = async (db: Queryable, candidateId: string): Promise<IClosureDecisionRow | null> =>
  (
    await db.query<IClosureDecisionRow>(
      `${SELECT} WHERE d.id = (SELECT ci.ref_id FROM candidate_input ci WHERE ci.candidate_id = $1 AND ci.kind = 'calculation_closure' LIMIT 1)`,
      [candidateId],
    )
  ).rows[0] ?? null;

// Единый предикат второй линии (миграция 0044): у кандидата закреплено действующее решение по его ревизии расчёта.
export const calculationClosedByDecision = async (db: Queryable, candidateId: string): Promise<boolean> =>
  (await db.query<{ closed: boolean }>('SELECT calculation_closed_by_decision($1) AS closed', [candidateId])).rows[0]!.closed;
