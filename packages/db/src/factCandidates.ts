// Кандидаты фактов (OD-08-3, Р-08-4, AD-08-7 первого текста): как у требований, но отдельные таблицы и права
// (fact.create, fact.confirm). Вид факта — из справочника fact_kind; основание supports — письменный текст (D-018).
import type { IEvidenceRef } from '@kontur/core';
import { copyEvidenceLinks, fragmentsInScope, insertEvidenceLinks } from './requirementAccess.ts';
import type { Queryable } from './pool.ts';

export interface IFactCandidateRow {
  id: string;
  tender_id: string;
  stage_id: string;
  registry_id: string;
  fact_kind: string;
  fact_kind_title: string;
  origin: 'human' | 'model' | 'rule' | 'carried';
  analysis_run_id: string | null;
  target_fact_id: string | null;
  rebased_from_candidate_id: string | null;
  carried_from_revision_id: string | null;
  derived_from_candidate_id: string | null;
  display_value: string;
  normalized_value: Record<string, unknown>;
  unit: string | null;
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
  fact_id: string | null;
}

const SELECT = `SELECT c.*, k.title AS fact_kind_title, (a.registry_id IS NOT NULL) AS registry_active, v.id AS revision_id, v.fact_id
                  FROM fact_candidate c
                  JOIN fact_kind k ON k.code = c.fact_kind
                  LEFT JOIN requirement_registry_active a ON a.registry_id = c.registry_id
                  LEFT JOIN fact_revision v ON v.candidate_id = c.id`;

export const getFactCandidate = async (db: Queryable, id: string): Promise<IFactCandidateRow | null> =>
  (await db.query<IFactCandidateRow>(`${SELECT} WHERE c.id = $1`, [id])).rows[0] ?? null;

export const listFactCandidates = async (
  db: Queryable,
  registryId: string,
  f: { status?: string | null; runId?: string | null; limit: number },
): Promise<IFactCandidateRow[]> =>
  (
    await db.query<IFactCandidateRow>(
      `${SELECT} WHERE c.registry_id = $1 AND ($2::text IS NULL OR c.status = $2) AND ($3::uuid IS NULL OR c.analysis_run_id = $3)
        ORDER BY c.created_at, c.id LIMIT $4`,
      [registryId, f.status ?? null, f.runId ?? null, f.limit],
    )
  ).rows;

export const listFactKinds = async (db: Queryable): Promise<{ code: string; title: string; value_type: string; normative_source: string }[]> =>
  (await db.query<{ code: string; title: string; value_type: string; normative_source: string }>('SELECT code, title, value_type, normative_source FROM fact_kind ORDER BY title')).rows;

export interface INewFactCandidate {
  tenderId: string;
  stageId: string;
  registryId: string;
  userId: string;
  factKind: string;
  displayValue: string;
  normalizedValue: Record<string, unknown>;
  unit: string | null;
  rationale: string | null;
  evidence: IEvidenceRef[];
  targetFactId: string | null;
  derivedFromCandidateId: string | null;
}

export const createFactCandidate = async (db: Queryable, c: INewFactCandidate): Promise<string> => {
  const ins = await db.query<{ id: string }>(
    `INSERT INTO fact_candidate (tender_id, stage_id, registry_id, fact_kind, origin, target_fact_id, derived_from_candidate_id,
                                 display_value, normalized_value, unit, rationale, created_by)
     VALUES ($1, $2, $3, $4, 'human', $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [c.tenderId, c.stageId, c.registryId, c.factKind, c.targetFactId, c.derivedFromCandidateId, c.displayValue, JSON.stringify(c.normalizedValue),
     c.unit, c.rationale, c.userId],
  );
  const id = ins.rows[0]!.id;
  await insertEvidenceLinks(db, 'fact_candidate_id', id, c.tenderId, c.userId, c.evidence);
  if (c.derivedFromCandidateId) {
    await db.query(
      `UPDATE fact_candidate SET status = 'superseded', status_reason = 'заменено правкой', decided_by = $2, decided_at = now(),
              updated_at = now(), row_version = row_version + 1
        WHERE id = $1 AND status = 'proposed'`,
      [c.derivedFromCandidateId, c.userId],
    );
  }
  return id;
};

export const rebaseFactCandidate = async (
  db: Queryable,
  source: IFactCandidateRow,
  target: { id: string; evidence_scope_id: string },
  userId: string,
): Promise<{ id: string } | { error: 'no_supports_in_scope' | 'already_rebased' }> => {
  const done = await db.query<{ id: string }>('SELECT id FROM fact_candidate WHERE rebased_from_candidate_id = $1 AND registry_id = $2', [source.id, target.id]);
  if (done.rows[0]) return { error: 'already_rebased' };
  const links = (await db.query<{ fragment_id: string; role: string }>('SELECT fragment_id, role FROM evidence_link WHERE fact_candidate_id = $1', [source.id])).rows;
  const inScope = await fragmentsInScope(db, target.evidence_scope_id, links.map((l) => l.fragment_id));
  const kept = links.filter((l) => inScope.has(l.fragment_id));
  if (!kept.some((l) => l.role === 'supports')) return { error: 'no_supports_in_scope' };
  const ins = await db.query<{ id: string }>(
    `INSERT INTO fact_candidate (tender_id, stage_id, registry_id, fact_kind, origin, target_fact_id, rebased_from_candidate_id,
                                 display_value, normalized_value, unit, rationale, confidence, created_by)
     VALUES ($1, $2, $3, $4, 'carried', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [source.tender_id, source.stage_id, target.id, source.fact_kind, source.target_fact_id, source.id, source.display_value,
     JSON.stringify(source.normalized_value), source.unit, source.rationale, source.confidence, userId],
  );
  await insertEvidenceLinks(db, 'fact_candidate_id', ins.rows[0]!.id, source.tender_id, userId, kept.map((l) => ({ fragmentId: l.fragment_id, role: l.role })));
  return { id: ins.rows[0]!.id };
};

export const rejectFactCandidate = async (db: Queryable, id: string, rowVersion: number, userId: string, reason: string): Promise<boolean> =>
  ((
    await db.query(
      `UPDATE fact_candidate SET status = 'rejected', status_reason = $4, decided_by = $3, decided_at = now(), updated_at = now(),
              row_version = row_version + 1
        WHERE id = $1 AND row_version = $2 AND status = 'proposed'`,
      [id, rowVersion, userId, reason],
    )
  ).rowCount ?? 0) === 1;

export interface IFactConfirmEdit {
  displayValue: string;
  normalizedValue: Record<string, unknown>;
  unit: string | null;
}

export const confirmFactCandidate = async (
  db: Queryable,
  c: IFactCandidateRow,
  rowVersion: number,
  userId: string,
  edit: IFactConfirmEdit,
): Promise<{ factId: string; revisionId: string } | null> => {
  const upd = await db.query(
    `UPDATE fact_candidate SET status = 'confirmed', decided_by = $3, decided_at = now(), updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND row_version = $2 AND status = 'proposed'`,
    [c.id, rowVersion, userId],
  );
  if ((upd.rowCount ?? 0) !== 1) return null;
  const revisionId = (await db.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  let factId: string;
  let seq = 1;
  let previous: string | null = null;
  if (c.target_fact_id) {
    const last = await db.query<{ id: string; seq: number }>('SELECT id, seq FROM fact_revision WHERE fact_id = $1 ORDER BY seq DESC LIMIT 1', [c.target_fact_id]);
    factId = c.target_fact_id;
    seq = last.rows[0]!.seq + 1;
    previous = last.rows[0]!.id;
  } else {
    factId = (
      await db.query<{ id: string }>('INSERT INTO fact (tender_id, stage_id, fact_kind, current_revision_id) VALUES ($1, $2, $3, $4) RETURNING id', [
        c.tender_id,
        c.stage_id,
        c.fact_kind,
        revisionId,
      ])
    ).rows[0]!.id;
  }
  await db.query(
    `INSERT INTO fact_revision (id, fact_id, tender_id, stage_id, registry_id, fact_kind, seq, supersedes_revision_id, status, change_kind,
                                candidate_id, display_value, normalized_value, unit, quality, authored_by, confirmed_by, content_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', 'confirmation', $9, $10, $11, $12, $13, $14, $15, repeat('0', 64))`,
    [revisionId, factId, c.tender_id, c.stage_id, c.registry_id, c.fact_kind, seq, previous, c.id, edit.displayValue, JSON.stringify(edit.normalizedValue),
     edit.unit, JSON.stringify(c.confidence === null ? {} : { confidence: Number(c.confidence) }), c.created_by, userId],
  );
  await copyEvidenceLinks(db, { column: 'fact_candidate_id', id: c.id }, { column: 'fact_revision_id', id: revisionId }, c.tender_id, userId);
  if (previous) await db.query('UPDATE fact SET current_revision_id = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [factId, revisionId]);
  return { factId, revisionId };
};
