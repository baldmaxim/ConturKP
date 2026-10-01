// Кандидаты требований (AD-08-2 первого текста, «Candidate confirmation»): предложение модели, правила,
// инженера или явный перенос; подтверждение — только человеком с requirement.confirm и только в активном
// реестре; правка предложения — новая версия кандидата (И-08-5); кандидат прежнего реестра — явным
// переносом (rebase). Подтверждение создаёт требование или его новую ревизию с основаниями кандидата.
import { requirementCode, type IEvidenceRef, type IObjectScope, type IRequirementParameter } from '@kontur/core';
import { copyEvidenceLinks, fragmentsInScope, insertEvidenceLinks } from './requirementAccess.ts';
import type { Queryable } from './pool.ts';

export interface IRequirementCandidateRow {
  id: string;
  tender_id: string;
  stage_id: string;
  registry_id: string;
  origin: 'human' | 'model' | 'rule' | 'carried';
  analysis_run_id: string | null;
  target_requirement_id: string | null;
  target_code: string | null;
  rebased_from_candidate_id: string | null;
  carried_from_revision_id: string | null;
  derived_from_candidate_id: string | null;
  statement: string;
  parameters: IRequirementParameter[];
  object_scope: IObjectScope;
  rationale: string | null;
  confidence: string | null;
  status: 'proposed' | 'confirmed' | 'rejected' | 'superseded';
  status_reason: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_by: string;
  created_at: Date;
  row_version: number;
  registry_active: boolean;
  revision_id: string | null;
  requirement_id: string | null;
  // R08-01: противоречащее основание и конфликт параметров с действующими требованиями реестра.
  contradicted: boolean;
  conflicts: { requirementId: string; code: string; parameter: string }[];
}

const SELECT = `SELECT c.*, t.code AS target_code, (a.registry_id IS NOT NULL) AS registry_active,
                       v.id AS revision_id, v.requirement_id,
                       EXISTS (SELECT 1 FROM evidence_link l WHERE l.requirement_candidate_id = c.id AND l.role = 'contradicts') AS contradicted,
                       (SELECT coalesce(jsonb_agg(jsonb_build_object('requirementId', x.requirement_id, 'code', x.code, 'parameter', x.parameter)
                                                  ORDER BY x.code, x.parameter), '[]'::jsonb)
                          FROM requirement_parameter_conflicts(c.registry_id, c.target_requirement_id, c.parameters, c.object_scope) x) AS conflicts
                  FROM requirement_candidate c
                  LEFT JOIN requirement t ON t.id = c.target_requirement_id
                  LEFT JOIN requirement_registry_active a ON a.registry_id = c.registry_id
                  LEFT JOIN requirement_revision v ON v.candidate_id = c.id`;

export const getRequirementCandidate = async (db: Queryable, id: string): Promise<IRequirementCandidateRow | null> =>
  (await db.query<IRequirementCandidateRow>(`${SELECT} WHERE c.id = $1`, [id])).rows[0] ?? null;

export const listRequirementCandidates = async (
  db: Queryable,
  registryId: string,
  f: { status?: string | null; runId?: string | null; limit: number },
): Promise<IRequirementCandidateRow[]> =>
  (
    await db.query<IRequirementCandidateRow>(
      `${SELECT} WHERE c.registry_id = $1 AND ($2::text IS NULL OR c.status = $2) AND ($3::uuid IS NULL OR c.analysis_run_id = $3)
        ORDER BY c.created_at, c.id LIMIT $4`,
      [registryId, f.status ?? null, f.runId ?? null, f.limit],
    )
  ).rows;

export interface INewRequirementCandidate {
  tenderId: string;
  stageId: string;
  registryId: string;
  userId: string;
  statement: string;
  parameters: IRequirementParameter[];
  objectScope: IObjectScope;
  rationale: string | null;
  evidence: IEvidenceRef[];
  targetRequirementId: string | null;
  derivedFromCandidateId: string | null;
}

// Ручной кандидат или новая версия предложения (правка): прежнее предложение становится superseded.
export const createRequirementCandidate = async (db: Queryable, c: INewRequirementCandidate): Promise<string> => {
  const ins = await db.query<{ id: string }>(
    `INSERT INTO requirement_candidate (tender_id, stage_id, registry_id, origin, target_requirement_id, derived_from_candidate_id,
                                        statement, parameters, object_scope, rationale, created_by)
     VALUES ($1, $2, $3, 'human', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [c.tenderId, c.stageId, c.registryId, c.targetRequirementId, c.derivedFromCandidateId, c.statement, JSON.stringify(c.parameters),
     JSON.stringify(c.objectScope), c.rationale, c.userId],
  );
  const id = ins.rows[0]!.id;
  await insertEvidenceLinks(db, 'requirement_candidate_id', id, c.tenderId, c.userId, c.evidence);
  if (c.derivedFromCandidateId) {
    await db.query(
      `UPDATE requirement_candidate SET status = 'superseded', status_reason = 'заменено правкой', decided_by = $2, decided_at = now(),
              updated_at = now(), row_version = row_version + 1
        WHERE id = $1 AND status = 'proposed'`,
      [c.derivedFromCandidateId, c.userId],
    );
  }
  return id;
};

// Явный перенос предложения прежнего реестра в активный (Р-08-6): основания — те, что есть в новом снимке;
// без основания supports в новом снимке переноса нет.
export const rebaseRequirementCandidate = async (
  db: Queryable,
  source: IRequirementCandidateRow,
  target: { id: string; evidence_scope_id: string },
  userId: string,
): Promise<{ id: string } | { error: 'no_supports_in_scope' | 'already_rebased' }> => {
  const done = await db.query<{ id: string }>('SELECT id FROM requirement_candidate WHERE rebased_from_candidate_id = $1 AND registry_id = $2', [source.id, target.id]);
  if (done.rows[0]) return { error: 'already_rebased' };
  const links = (
    await db.query<{ fragment_id: string; role: string }>('SELECT fragment_id, role FROM evidence_link WHERE requirement_candidate_id = $1', [source.id])
  ).rows;
  const inScope = await fragmentsInScope(db, target.evidence_scope_id, links.map((l) => l.fragment_id));
  const kept = links.filter((l) => inScope.has(l.fragment_id));
  if (!kept.some((l) => l.role === 'supports')) return { error: 'no_supports_in_scope' };
  const ins = await db.query<{ id: string }>(
    `INSERT INTO requirement_candidate (tender_id, stage_id, registry_id, origin, target_requirement_id, rebased_from_candidate_id,
                                        statement, parameters, object_scope, rationale, confidence, created_by)
     VALUES ($1, $2, $3, 'carried', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [source.tender_id, source.stage_id, target.id, source.target_requirement_id, source.id, source.statement, JSON.stringify(source.parameters),
     JSON.stringify(source.object_scope), source.rationale, source.confidence, userId],
  );
  await insertEvidenceLinks(db, 'requirement_candidate_id', ins.rows[0]!.id, source.tender_id, userId, kept.map((l) => ({ fragmentId: l.fragment_id, role: l.role })));
  return { id: ins.rows[0]!.id };
};

export const rejectRequirementCandidate = async (db: Queryable, id: string, rowVersion: number, userId: string, reason: string): Promise<boolean> =>
  ((
    await db.query(
      `UPDATE requirement_candidate SET status = 'rejected', status_reason = $4, decided_by = $3, decided_at = now(), updated_at = now(),
              row_version = row_version + 1
        WHERE id = $1 AND row_version = $2 AND status = 'proposed'`,
      [id, rowVersion, userId, reason],
    )
  ).rowCount ?? 0) === 1;

export interface IConfirmEdit {
  statement: string;
  parameters: IRequirementParameter[];
  objectScope: IObjectScope;
  // R08-01: пояснение при конфликте; без конфликта — null.
  conflictNote: string | null;
}

// R08-01: конфликт для подтверждения с итоговыми параметрами — противоречащее основание и конфликты параметров.
export const confirmationConflicts = async (
  db: Queryable,
  c: IRequirementCandidateRow,
  edit: { parameters: IRequirementParameter[]; objectScope: IObjectScope },
): Promise<{ contradicted: boolean; conflicts: { requirementId: string; code: string; parameter: string }[] }> => {
  const r = await db.query<{ requirement_id: string; code: string; parameter: string }>(
    'SELECT requirement_id, code, parameter FROM requirement_parameter_conflicts($1, $2, $3, $4) ORDER BY code, parameter',
    [c.registry_id, c.target_requirement_id, JSON.stringify(edit.parameters), JSON.stringify(edit.objectScope)],
  );
  const contradicts = await db.query('SELECT 1 FROM evidence_link WHERE requirement_candidate_id = $1 AND role = $2', [c.id, 'contradicts']);
  return {
    contradicted: (contradicts.rowCount ?? 0) > 0,
    conflicts: r.rows.map((x) => ({ requirementId: x.requirement_id, code: x.code, parameter: x.parameter })),
  };
};

// Подтверждение (инвариант 2): переход кандидата и ревизия требования — одной транзакцией; текст ревизии —
// текст подтверждающего (по умолчанию — кандидата), исходный остаётся у кандидата (И-08-5).
export const confirmRequirementCandidate = async (
  db: Queryable,
  c: IRequirementCandidateRow,
  rowVersion: number,
  userId: string,
  edit: IConfirmEdit,
): Promise<{ requirementId: string; revisionId: string; code: string } | null> => {
  const upd = await db.query(
    `UPDATE requirement_candidate SET status = 'confirmed', decided_by = $3, decided_at = now(), updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND row_version = $2 AND status = 'proposed'`,
    [c.id, rowVersion, userId],
  );
  if ((upd.rowCount ?? 0) !== 1) return null;
  let requirementId: string;
  let seq: number;
  let previous: string | null;
  let code: string;
  const revisionId = (await db.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  if (c.target_requirement_id) {
    const last = await db.query<{ id: string; seq: number; code: string }>(
      `SELECT v.id, v.seq, q.code FROM requirement q JOIN requirement_revision v ON v.requirement_id = q.id
        WHERE q.id = $1 ORDER BY v.seq DESC LIMIT 1`,
      [c.target_requirement_id],
    );
    requirementId = c.target_requirement_id;
    seq = last.rows[0]!.seq + 1;
    previous = last.rows[0]!.id;
    code = last.rows[0]!.code;
  } else {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('requirement_code'), hashtext($1::text))", [c.stage_id]);
    const n = await db.query<{ n: number }>(
      "SELECT coalesce(max(substring(code FROM 3)::int), 0) + 1 AS n FROM requirement WHERE stage_id = $1",
      [c.stage_id],
    );
    code = requirementCode(n.rows[0]!.n);
    const q = await db.query<{ id: string }>(
      'INSERT INTO requirement (tender_id, stage_id, code, current_revision_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [c.tender_id, c.stage_id, code, revisionId],
    );
    requirementId = q.rows[0]!.id;
    seq = 1;
    previous = null;
  }
  await db.query(
    `INSERT INTO requirement_revision (id, requirement_id, tender_id, stage_id, registry_id, seq, supersedes_revision_id, status, change_kind,
                                       candidate_id, statement, parameters, object_scope, authored_by, confirmed_by, content_sha256, conflict_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', 'confirmation', $8, $9, $10, $11, $12, $13, repeat('0', 64), $14)`,
    [revisionId, requirementId, c.tender_id, c.stage_id, c.registry_id, seq, previous, c.id, edit.statement, JSON.stringify(edit.parameters),
     JSON.stringify(edit.objectScope), c.created_by, userId, edit.conflictNote],
  );
  await copyEvidenceLinks(db, { column: 'requirement_candidate_id', id: c.id }, { column: 'requirement_revision_id', id: revisionId }, c.tender_id, userId);
  if (previous) {
    await db.query('UPDATE requirement SET current_revision_id = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [requirementId, revisionId]);
  }
  return { requirementId, revisionId, code };
};
