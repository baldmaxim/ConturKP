// Реестр требований этапа (Р-08-6): один активный реестр на этап, закреплённый на снимке области;
// переход на новый снимок — явная операция с аудитом и ссылкой на прежний реестр. Прежний реестр
// не меняется. Перенос (И-08-14): подтверждённое требование или факт, все основания которого есть в новом
// снимке, переносится ревизией carry_over; иначе — кандидатом с основаниями из нового снимка, если среди
// них осталось supports; иначе остаётся в истории прежнего реестра. Оценки покрытия не переносятся.
import type { Queryable } from './pool.ts';

export interface IRequirementRegistryRow {
  id: string;
  tender_id: string;
  stage_id: string;
  evidence_scope_id: string;
  seq: number;
  previous_registry_id: string | null;
  reason: string;
  created_by: string;
  created_at: Date;
  active: boolean;
  scope_hash: string;
  scope_created_at: Date;
}

const REGISTRY_SELECT = `SELECT g.*, (a.registry_id IS NOT NULL) AS active, s.content_hash AS scope_hash, s.created_at AS scope_created_at
                           FROM requirement_registry g
                           JOIN evidence_scope s ON s.id = g.evidence_scope_id
                           LEFT JOIN requirement_registry_active a ON a.registry_id = g.id`;

export const getRequirementRegistry = async (db: Queryable, id: string): Promise<IRequirementRegistryRow | null> =>
  (await db.query<IRequirementRegistryRow>(`${REGISTRY_SELECT} WHERE g.id = $1`, [id])).rows[0] ?? null;

export const listRequirementRegistries = async (db: Queryable, stageId: string): Promise<IRequirementRegistryRow[]> =>
  (await db.query<IRequirementRegistryRow>(`${REGISTRY_SELECT} WHERE g.stage_id = $1 ORDER BY g.seq DESC`, [stageId])).rows;

export const activeRegistryOf = async (db: Queryable, stageId: string): Promise<IRequirementRegistryRow | null> =>
  (await db.query<IRequirementRegistryRow>(`${REGISTRY_SELECT} WHERE g.stage_id = $1 AND a.registry_id IS NOT NULL`, [stageId])).rows[0] ?? null;

export interface ICarryReport {
  requirementsCarried: number;
  requirementsAsCandidates: number;
  requirementsLeft: number;
  factsCarried: number;
  factsAsCandidates: number;
  factsLeft: number;
}

interface ILinkRow {
  fragment_id: string;
  role: string;
  in_scope: boolean;
}

const linksIn = async (db: Queryable, column: 'requirement_revision_id' | 'fact_revision_id', ownerId: string, scopeId: string): Promise<ILinkRow[]> =>
  (
    await db.query<ILinkRow>(
      `SELECT fragment_id, role, evidence_scope_has_fragment($2, fragment_id) AS in_scope FROM evidence_link WHERE ${column} = $1 ORDER BY fragment_id, role`,
      [ownerId, scopeId],
    )
  ).rows;

const insertLinks = async (
  db: Queryable,
  column: 'requirement_revision_id' | 'fact_revision_id' | 'requirement_candidate_id' | 'fact_candidate_id',
  ownerId: string,
  tenderId: string,
  links: readonly { fragment_id: string; role: string }[],
  userId: string,
): Promise<void> => {
  if (links.length === 0) return;
  await db.query(
    `INSERT INTO evidence_link (tender_id, fragment_id, role, ${column}, created_by)
     SELECT $1, u.fragment_id, u.role, $2, $3 FROM unnest($4::uuid[], $5::text[]) AS u(fragment_id, role)`,
    [tenderId, ownerId, userId, links.map((l) => l.fragment_id), links.map((l) => l.role)],
  );
};

interface ICarryRequirementRow {
  requirement_id: string;
  revision_id: string;
  seq: number;
  statement: string;
  parameters: unknown;
  object_scope: unknown;
  authored_by: string;
}

const carryRequirements = async (db: Queryable, from: string, to: IRequirementRegistryRow, userId: string, report: ICarryReport): Promise<void> => {
  const reqs = await db.query<ICarryRequirementRow>(
    `SELECT q.id AS requirement_id, v.id AS revision_id, v.seq, v.statement, v.parameters, v.object_scope, v.authored_by
       FROM requirement q JOIN requirement_revision v ON v.id = q.current_revision_id
      WHERE v.registry_id = $1 AND v.status = 'confirmed' ORDER BY q.code`,
    [from],
  );
  for (const q of reqs.rows) {
    const links = await linksIn(db, 'requirement_revision_id', q.revision_id, to.evidence_scope_id);
    if (links.every((l) => l.in_scope)) {
      const rev = await db.query<{ id: string }>(
        `INSERT INTO requirement_revision (requirement_id, tender_id, stage_id, registry_id, seq, supersedes_revision_id, status, change_kind,
                                           carried_from_revision_id, statement, parameters, object_scope, authored_by, confirmed_by, content_sha256, reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', 'carry_over', $6, $7, $8, $9, $10, $11, repeat('0', 64), 'перенос в новый реестр')
         RETURNING id`,
        [q.requirement_id, to.tender_id, to.stage_id, to.id, q.seq + 1, q.revision_id, q.statement, JSON.stringify(q.parameters), JSON.stringify(q.object_scope), q.authored_by, userId],
      );
      await insertLinks(db, 'requirement_revision_id', rev.rows[0]!.id, to.tender_id, links, userId);
      await db.query('UPDATE requirement SET current_revision_id = $2, row_version = row_version + 1, updated_at = now() WHERE id = $1', [q.requirement_id, rev.rows[0]!.id]);
      report.requirementsCarried += 1;
      continue;
    }
    const kept = links.filter((l) => l.in_scope);
    if (!kept.some((l) => l.role === 'supports')) {
      report.requirementsLeft += 1;
      continue;
    }
    const cand = await db.query<{ id: string }>(
      `INSERT INTO requirement_candidate (tender_id, stage_id, registry_id, origin, target_requirement_id, carried_from_revision_id,
                                          statement, parameters, object_scope, rationale, created_by)
       VALUES ($1, $2, $3, 'carried', $4, $5, $6, $7, $8, 'Перенос в новый реестр: часть оснований вне нового снимка', $9) RETURNING id`,
      [to.tender_id, to.stage_id, to.id, q.requirement_id, q.revision_id, q.statement, JSON.stringify(q.parameters), JSON.stringify(q.object_scope), userId],
    );
    await insertLinks(db, 'requirement_candidate_id', cand.rows[0]!.id, to.tender_id, kept, userId);
    report.requirementsAsCandidates += 1;
  }
};

interface ICarryFactRow {
  fact_id: string;
  fact_kind: string;
  revision_id: string;
  seq: number;
  display_value: string;
  normalized_value: unknown;
  unit: string | null;
  quality: unknown;
  authored_by: string;
}

const carryFacts = async (db: Queryable, from: string, to: IRequirementRegistryRow, userId: string, report: ICarryReport): Promise<void> => {
  const facts = await db.query<ICarryFactRow>(
    `SELECT q.id AS fact_id, q.fact_kind, v.id AS revision_id, v.seq, v.display_value, v.normalized_value, v.unit, v.quality, v.authored_by
       FROM fact q JOIN fact_revision v ON v.id = q.current_revision_id
      WHERE v.registry_id = $1 AND v.status = 'confirmed' ORDER BY q.created_at, q.id`,
    [from],
  );
  for (const f of facts.rows) {
    const links = await linksIn(db, 'fact_revision_id', f.revision_id, to.evidence_scope_id);
    if (links.every((l) => l.in_scope)) {
      const rev = await db.query<{ id: string }>(
        `INSERT INTO fact_revision (fact_id, tender_id, stage_id, registry_id, fact_kind, seq, supersedes_revision_id, status, change_kind,
                                    carried_from_revision_id, display_value, normalized_value, unit, quality, authored_by, confirmed_by, content_sha256, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', 'carry_over', $7, $8, $9, $10, $11, $12, $13, repeat('0', 64), 'перенос в новый реестр')
         RETURNING id`,
        [f.fact_id, to.tender_id, to.stage_id, to.id, f.fact_kind, f.seq + 1, f.revision_id, f.display_value, JSON.stringify(f.normalized_value), f.unit, JSON.stringify(f.quality), f.authored_by, userId],
      );
      await insertLinks(db, 'fact_revision_id', rev.rows[0]!.id, to.tender_id, links, userId);
      await db.query('UPDATE fact SET current_revision_id = $2, row_version = row_version + 1, updated_at = now() WHERE id = $1', [f.fact_id, rev.rows[0]!.id]);
      report.factsCarried += 1;
      continue;
    }
    const kept = links.filter((l) => l.in_scope);
    if (!kept.some((l) => l.role === 'supports')) {
      report.factsLeft += 1;
      continue;
    }
    const cand = await db.query<{ id: string }>(
      `INSERT INTO fact_candidate (tender_id, stage_id, registry_id, fact_kind, origin, target_fact_id, carried_from_revision_id,
                                   display_value, normalized_value, unit, rationale, created_by)
       VALUES ($1, $2, $3, $4, 'carried', $5, $6, $7, $8, $9, 'Перенос в новый реестр: часть оснований вне нового снимка', $10) RETURNING id`,
      [to.tender_id, to.stage_id, to.id, f.fact_kind, f.fact_id, f.revision_id, f.display_value, JSON.stringify(f.normalized_value), f.unit, userId],
    );
    await insertLinks(db, 'fact_candidate_id', cand.rows[0]!.id, to.tender_id, kept, userId);
    report.factsAsCandidates += 1;
  }
};

// Создание реестра на снимке и активация в одной транзакции; первый — без предыдущего. Вызывающий проверил
// права и снимок; гонку двух созданий разрешает охранник (40001 → 409 у вызывающего).
export const createRequirementRegistry = async (
  db: Queryable,
  r: { tenderId: string; stageId: string; evidenceScopeId: string; reason: string; userId: string },
): Promise<{ registry: IRequirementRegistryRow; previous: string | null; carry: ICarryReport }> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('requirement_registry'), hashtext($1::text))", [r.stageId]);
  const active = await db.query<{ registry_id: string; row_version: number }>(
    'SELECT registry_id, row_version FROM requirement_registry_active WHERE stage_id = $1 FOR UPDATE',
    [r.stageId],
  );
  const previous = active.rows[0]?.registry_id ?? null;
  const seq = await db.query<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM requirement_registry WHERE stage_id = $1', [r.stageId]);
  const ins = await db.query<{ id: string }>(
    `INSERT INTO requirement_registry (tender_id, stage_id, evidence_scope_id, seq, previous_registry_id, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [r.tenderId, r.stageId, r.evidenceScopeId, seq.rows[0]!.n, previous, r.reason, r.userId],
  );
  const id = ins.rows[0]!.id;
  if (previous) {
    await db.query(
      'UPDATE requirement_registry_active SET registry_id = $2, updated_by = $3, updated_at = now(), row_version = row_version + 1 WHERE stage_id = $1',
      [r.stageId, id, r.userId],
    );
  } else {
    await db.query('INSERT INTO requirement_registry_active (stage_id, tender_id, registry_id, updated_by) VALUES ($1, $2, $3, $4)', [r.stageId, r.tenderId, id, r.userId]);
  }
  const registry = (await getRequirementRegistry(db, id))!;
  const carry: ICarryReport = { requirementsCarried: 0, requirementsAsCandidates: 0, requirementsLeft: 0, factsCarried: 0, factsAsCandidates: 0, factsLeft: 0 };
  if (previous) {
    await carryRequirements(db, previous, registry, r.userId, carry);
    await carryFacts(db, previous, registry, r.userId, carry);
  }
  return { registry, previous, carry };
};
