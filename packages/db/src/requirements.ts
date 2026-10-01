// Требования и факты реестра (AD-08-1 первого текста): идентичность на этапе, неизменяемые ревизии в реестре.
// Реестр — требования, текущая ревизия которых записана в нём. Замена — новая ревизия superseded со ссылкой
// на заменяющее (содержание и основания прежние); удаления нет.
import type { IObjectScope, IRequirementParameter } from '@kontur/core';
import { copyEvidenceLinks } from './requirementAccess.ts';
import type { Queryable } from './pool.ts';

export interface IRequirementRevisionRow {
  id: string;
  requirement_id: string;
  registry_id: string;
  registry_seq: number;
  seq: number;
  supersedes_revision_id: string | null;
  status: 'confirmed' | 'superseded';
  change_kind: 'confirmation' | 'carry_over' | 'supersede';
  candidate_id: string | null;
  carried_from_revision_id: string | null;
  statement: string;
  parameters: IRequirementParameter[];
  object_scope: IObjectScope;
  superseded_by_requirement_id: string | null;
  superseded_by_code: string | null;
  reason: string | null;
  authored_by: string;
  confirmed_by: string;
  content_sha256: string;
  // R08-01: пояснение подтверждения при конфликте требований или противоречащем основании.
  conflict_note: string | null;
  created_at: Date;
}

export interface IRequirementConflict {
  requirementId: string;
  code: string;
  parameter: string;
}

export interface IRequirementRow extends Omit<IRequirementRevisionRow, 'id' | 'created_at'> {
  id: string;
  tender_id: string;
  stage_id: string;
  code: string;
  current_revision_id: string;
  row_version: number;
  created_at: Date;
  revision_created_at: Date;
  coverage_state: string | null;
  coverage_seq: number | null;
  // R08-01: в действующей оценке покрытия есть объект с несовпадением единиц.
  coverage_unit_mismatch: boolean;
  // R08-01: у текущей ревизии есть основание contradicts; другие действующие требования с конфликтом параметров.
  contradicted: boolean;
  conflicts: IRequirementConflict[];
  registry_active: boolean;
}

const REVISION_SELECT = `SELECT v.*, g.seq AS registry_seq, sq.code AS superseded_by_code
                           FROM requirement_revision v
                           JOIN requirement_registry g ON g.id = v.registry_id
                           LEFT JOIN requirement sq ON sq.id = v.superseded_by_requirement_id`;

const REQUIREMENT_SELECT = `SELECT v.*, g.seq AS registry_seq, sq.code AS superseded_by_code, q.id, q.tender_id, q.stage_id, q.code,
                                   q.current_revision_id, q.row_version, q.created_at, v.created_at AS revision_created_at,
                                   cv.state AS coverage_state, cv.seq AS coverage_seq, (a.registry_id IS NOT NULL) AS registry_active,
                                   coalesce(cv.unit_mismatch, false) AS coverage_unit_mismatch,
                                   EXISTS (SELECT 1 FROM evidence_link l WHERE l.requirement_revision_id = v.id AND l.role = 'contradicts') AS contradicted,
                                   CASE WHEN v.status = 'confirmed' THEN
                                     (SELECT coalesce(jsonb_agg(jsonb_build_object('requirementId', c.requirement_id, 'code', c.code, 'parameter', c.parameter)
                                                                ORDER BY c.code, c.parameter), '[]'::jsonb)
                                        FROM requirement_parameter_conflicts(v.registry_id, q.id, v.parameters, v.object_scope) c)
                                   ELSE '[]'::jsonb END AS conflicts
                              FROM requirement q
                              JOIN requirement_revision v ON v.id = q.current_revision_id
                              JOIN requirement_registry g ON g.id = v.registry_id
                              LEFT JOIN requirement_registry_active a ON a.registry_id = v.registry_id
                              LEFT JOIN requirement sq ON sq.id = v.superseded_by_requirement_id
                              LEFT JOIN LATERAL (SELECT c.state, c.seq,
                                                        EXISTS (SELECT 1 FROM requirement_coverage_object o WHERE o.coverage_id = c.id AND o.unit_status = 'mismatch') AS unit_mismatch
                                                   FROM requirement_coverage c WHERE c.requirement_revision_id = v.id
                                                  ORDER BY c.seq DESC LIMIT 1) cv ON true`;

export const listRequirements = async (db: Queryable, registryId: string): Promise<IRequirementRow[]> =>
  (await db.query<IRequirementRow>(`${REQUIREMENT_SELECT} WHERE v.registry_id = $1 ORDER BY q.code`, [registryId])).rows;

export const getRequirement = async (db: Queryable, id: string): Promise<IRequirementRow | null> =>
  (await db.query<IRequirementRow>(`${REQUIREMENT_SELECT} WHERE q.id = $1`, [id])).rows[0] ?? null;

export const requirementRevisions = async (db: Queryable, requirementId: string): Promise<IRequirementRevisionRow[]> =>
  (await db.query<IRequirementRevisionRow>(`${REVISION_SELECT} WHERE v.requirement_id = $1 ORDER BY v.seq`, [requirementId])).rows;

export const getRequirementRevision = async (db: Queryable, id: string): Promise<(IRequirementRevisionRow & { tender_id: string; stage_id: string }) | null> =>
  (await db.query<IRequirementRevisionRow & { tender_id: string; stage_id: string }>(`${REVISION_SELECT} WHERE v.id = $1`, [id])).rows[0] ?? null;

// Замена требования другим требованием того же этапа (requirement.manage, охранник ревизии).
export const supersedeRequirement = async (
  db: Queryable,
  q: IRequirementRow,
  rowVersion: number,
  replacementId: string,
  userId: string,
  reason: string,
): Promise<string | null> => {
  const lock = await db.query('SELECT 1 FROM requirement WHERE id = $1 AND row_version = $2 FOR UPDATE', [q.id, rowVersion]);
  if ((lock.rowCount ?? 0) !== 1) return null;
  const rev = await db.query<{ id: string }>(
    `INSERT INTO requirement_revision (requirement_id, tender_id, stage_id, registry_id, seq, supersedes_revision_id, status, change_kind,
                                       statement, parameters, object_scope, superseded_by_requirement_id, reason, authored_by, confirmed_by, content_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, 'superseded', 'supersede', $7, $8, $9, $10, $11, $12, $13, repeat('0', 64)) RETURNING id`,
    [q.id, q.tender_id, q.stage_id, q.registry_id, q.seq + 1, q.current_revision_id, q.statement, JSON.stringify(q.parameters), JSON.stringify(q.object_scope),
     replacementId, reason, q.authored_by, userId],
  );
  const id = rev.rows[0]!.id;
  await copyEvidenceLinks(db, { column: 'requirement_revision_id', id: q.current_revision_id }, { column: 'requirement_revision_id', id }, q.tender_id, userId);
  await db.query('UPDATE requirement SET current_revision_id = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [q.id, id]);
  return id;
};

// ---------------------------------------------------------------- Факты

export interface IFactRow {
  id: string;
  tender_id: string;
  stage_id: string;
  fact_kind: string;
  fact_kind_title: string;
  current_revision_id: string;
  row_version: number;
  created_at: Date;
  registry_id: string;
  registry_seq: number;
  seq: number;
  status: 'confirmed' | 'superseded';
  change_kind: 'confirmation' | 'carry_over' | 'supersede';
  candidate_id: string | null;
  display_value: string;
  normalized_value: Record<string, unknown>;
  unit: string | null;
  quality: Record<string, unknown>;
  superseded_by_fact_id: string | null;
  reason: string | null;
  authored_by: string;
  confirmed_by: string;
  revision_created_at: Date;
  registry_active: boolean;
}

const FACT_SELECT = `SELECT q.id, q.tender_id, q.stage_id, q.fact_kind, k.title AS fact_kind_title, q.current_revision_id, q.row_version, q.created_at,
                            v.registry_id, g.seq AS registry_seq, v.seq, v.status, v.change_kind, v.candidate_id, v.display_value, v.normalized_value,
                            v.unit, v.quality, v.superseded_by_fact_id, v.reason, v.authored_by, v.confirmed_by, v.created_at AS revision_created_at,
                            (a.registry_id IS NOT NULL) AS registry_active
                       FROM fact q
                       JOIN fact_kind k ON k.code = q.fact_kind
                       JOIN fact_revision v ON v.id = q.current_revision_id
                       JOIN requirement_registry g ON g.id = v.registry_id
                       LEFT JOIN requirement_registry_active a ON a.registry_id = v.registry_id`;

export const listFacts = async (db: Queryable, registryId: string): Promise<IFactRow[]> =>
  (await db.query<IFactRow>(`${FACT_SELECT} WHERE v.registry_id = $1 ORDER BY k.title, q.created_at, q.id`, [registryId])).rows;

export const getFact = async (db: Queryable, id: string): Promise<IFactRow | null> =>
  (await db.query<IFactRow>(`${FACT_SELECT} WHERE q.id = $1`, [id])).rows[0] ?? null;

export interface IFactRevisionRow {
  id: string;
  seq: number;
  registry_id: string;
  registry_seq: number;
  status: 'confirmed' | 'superseded';
  change_kind: 'confirmation' | 'carry_over' | 'supersede';
  display_value: string;
  normalized_value: Record<string, unknown>;
  unit: string | null;
  superseded_by_fact_id: string | null;
  authored_by: string;
  confirmed_by: string;
  created_at: Date;
}

export const factRevisions = async (db: Queryable, factId: string): Promise<IFactRevisionRow[]> =>
  (
    await db.query<IFactRevisionRow>(
      `SELECT v.*, g.seq AS registry_seq FROM fact_revision v JOIN requirement_registry g ON g.id = v.registry_id WHERE v.fact_id = $1 ORDER BY v.seq`,
      [factId],
    )
  ).rows;

export const supersedeFact = async (db: Queryable, f: IFactRow, rowVersion: number, replacementId: string, userId: string, reason: string): Promise<string | null> => {
  const lock = await db.query('SELECT 1 FROM fact WHERE id = $1 AND row_version = $2 FOR UPDATE', [f.id, rowVersion]);
  if ((lock.rowCount ?? 0) !== 1) return null;
  const rev = await db.query<{ id: string }>(
    `INSERT INTO fact_revision (fact_id, tender_id, stage_id, registry_id, fact_kind, seq, supersedes_revision_id, status, change_kind, display_value,
                                normalized_value, unit, quality, superseded_by_fact_id, reason, authored_by, confirmed_by, content_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'superseded', 'supersede', $8, $9, $10, $11, $12, $13, $14, $15, repeat('0', 64)) RETURNING id`,
    [f.id, f.tender_id, f.stage_id, f.registry_id, f.fact_kind, f.seq + 1, f.current_revision_id, f.display_value, JSON.stringify(f.normalized_value), f.unit,
     JSON.stringify(f.quality), replacementId, reason, f.authored_by, userId],
  );
  const id = rev.rows[0]!.id;
  await copyEvidenceLinks(db, { column: 'fact_revision_id', id: f.current_revision_id }, { column: 'fact_revision_id', id }, f.tender_id, userId);
  await db.query('UPDATE fact SET current_revision_id = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [f.id, id]);
  return id;
};
