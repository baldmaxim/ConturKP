// Причины изменений (этап 10; проект §3, §5.8, §6; D-030 В-10-8; I11, I12, A23). Причина — версия на единицу сравнения
// с автором-человеком; «подтверждено» — только с основанием подходящего вида. Модель предлагает гипотезы в прогоне с
// закреплённым входом (единицы и кандидаты-основания из снимка области, читаемые запустившим); права запустившего
// перепроверяет задание перед моделью и каждой пачкой (R09-04). Новая редакция основания отмечает причину и
// гасит открытые гипотезы (D-029) — заданием инвалидации.
import { canonicalJson, REASON_PROMPT_VERSION, reasonSystemPrompt, sha256Hex, type IParsedReason, type ReasonKind } from '@kontur/core';
import type { IAccessContext } from './access.ts';
import { CHANGE_NOTE_REASONS_SQL } from './economics.ts';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';
import { readableFragments } from './requirementAccess.ts';
import { dependenciesOf, insertDependencies, type IModelIdentity } from './reviewRuns.ts';
import { getActiveVersion } from './searchIndex.ts';
import { ftsBranch, queryLexemes } from './searchRuns.ts';
import { listEvidenceScopes, resolveSnapshotScope } from './searchScope.ts';

const fragmentRefs = (ids: readonly string[]) => ids.map((fragmentId) => ({ side: 'context' as const, objectType: 'fragment' as const, fragmentId }));

// ---------------------------------------------------------------- Версии причин

export interface IExplanationRow {
  id: string;
  comparison_id: string;
  unit_id: string;
  version: number;
  reason_kind: ReasonKind;
  reason_status: 'unknown' | 'hypothesis' | 'confirmed';
  rationale: string | null;
  suggestion_id: string | null;
  actor_user_id: string;
  actor_name: string;
  created_at: Date;
  bases: { basisType: 'fragment' | 'decision'; fragmentId: string | null; decisionId: string | null; origin: string | null; text: string | null }[];
  invalidated: { reason: string; at: string }[];
}

const EXPLANATION_SELECT = `
  SELECT e.id, e.comparison_id, e.unit_id, e.version, e.reason_kind, e.reason_status, e.rationale, e.suggestion_id, e.actor_user_id,
         u.display_name AS actor_name, e.created_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object('basisType', b.basis_type, 'fragmentId', b.fragment_id, 'decisionId', b.decision_id,
                                                       'origin', f.origin, 'text', left(f.text, 600)) ORDER BY b.id)
                     FROM change_explanation_basis b LEFT JOIN evidence_fragment f ON f.id = b.fragment_id WHERE b.explanation_id = e.id), '[]'::jsonb) AS bases,
         coalesce((SELECT jsonb_agg(jsonb_build_object('reason', i.reason, 'at', i.created_at) ORDER BY i.created_at)
                     FROM evidence_invalidation i WHERE i.dependent_type = 'change_explanation' AND i.dependent_id = e.id), '[]'::jsonb) AS invalidated
    FROM change_explanation e JOIN app_user u ON u.id = e.actor_user_id`;

// Действующие причины сравнения — последняя версия по каждой единице.
export const currentExplanations = async (db: Queryable, comparisonId: string): Promise<Map<string, IExplanationRow>> => {
  const r = await db.query<IExplanationRow>(
    `${EXPLANATION_SELECT}
      WHERE e.comparison_id = $1 AND e.version = (SELECT max(x.version) FROM change_explanation x WHERE x.unit_id = e.unit_id)`,
    [comparisonId],
  );
  return new Map(r.rows.map((x) => [x.unit_id, x]));
};

export const explanationHistory = async (db: Queryable, unitId: string): Promise<IExplanationRow[]> =>
  (await db.query<IExplanationRow>(`${EXPLANATION_SELECT} WHERE e.unit_id = $1 ORDER BY e.version DESC`, [unitId])).rows;

export const explanationVersion = async (db: Queryable, unitId: string): Promise<number> =>
  (await db.query<{ v: number }>('SELECT coalesce(max(version), 0)::int AS v FROM change_explanation WHERE unit_id = $1', [unitId])).rows[0]!.v;

export interface IExplanationInput {
  tenderId: string;
  stageId: string;
  comparisonId: string;
  unitId: string;
  userId: string;
  reasonKind: ReasonKind;
  reasonStatus: 'unknown' | 'hypothesis' | 'confirmed';
  rationale: string | null;
  fragmentIds: readonly string[];
  decisionIds: readonly string[];
  suggestionId: string | null;
}

export interface ISupersededBasis {
  fragmentId: string | null;
  decisionId: string | null;
  cause: string;
}

// Заменённые основания новой причины (R10-01): то, что событие барьера сделало бы точной целью инвалидации, — по
// текущему состоянию (функция 0027 change_basis_supersession), поэтому отказ не зависит от того, обработано ли событие.
export const supersededBases = async (db: Queryable, stageId: string, fragmentIds: readonly string[], decisionIds: readonly string[]): Promise<ISupersededBasis[]> => {
  const r = await db.query<{ fragment_id: string | null; decision_id: string | null; cause: string | null }>(
    `SELECT x.fragment_id, x.decision_id, change_basis_supersession($1, x.fragment_id, x.decision_id) AS cause
       FROM (SELECT f AS fragment_id, NULL::uuid AS decision_id FROM unnest($2::uuid[]) AS f
             UNION ALL SELECT NULL::uuid, d FROM unnest($3::uuid[]) AS d) x`,
    [stageId, [...new Set(fragmentIds)], [...new Set(decisionIds)]],
  );
  return r.rows.filter((x) => x.cause !== null).map((x) => ({ fragmentId: x.fragment_id, decisionId: x.decision_id, cause: x.cause! }));
};

// Новая версия причины с основаниями и зависимостями — одной транзакцией вызывающего (под блокировкой этапа).
export const appendExplanation = async (db: Queryable, i: IExplanationInput): Promise<string> => {
  const version = (await explanationVersion(db, i.unitId)) + 1;
  const ins = await db.query<{ id: string }>(
    `INSERT INTO change_explanation (tender_id, comparison_id, unit_id, version, reason_kind, reason_status, rationale, suggestion_id, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [i.tenderId, i.comparisonId, i.unitId, version, i.reasonKind, i.reasonStatus, i.rationale, i.suggestionId, i.userId],
  );
  const id = ins.rows[0]!.id;
  for (const f of new Set(i.fragmentIds)) {
    await db.query("INSERT INTO change_explanation_basis (explanation_id, tender_id, basis_type, fragment_id) VALUES ($1, $2, 'fragment', $3)", [id, i.tenderId, f]);
  }
  for (const d of new Set(i.decisionIds)) {
    await db.query("INSERT INTO change_explanation_basis (explanation_id, tender_id, basis_type, decision_id) VALUES ($1, $2, 'decision', $3)", [id, i.tenderId, d]);
  }
  const refs = [...(await dependenciesOf(db, fragmentRefs([...i.fragmentIds]))), ...i.decisionIds.map((d) => ({ type: 'decision', id: d }))];
  await insertDependencies(db, { tenderId: i.tenderId, stageId: i.stageId, dependentType: 'change_explanation', dependentId: id, refs });
  return id;
};

// ---------------------------------------------------------------- Прогон гипотез

export const REASON_JOB_KIND = 'economics.reasons';
const REASON_JOB_PRIORITY = 30;
// Кандидатов-оснований на единицу и единиц на прогон: вход ограничен, а не молча усечён (охват пишется в прогон).
const CANDIDATES_PER_UNIT = 5;
export const MAX_REASON_UNITS = 50;

export interface IReasonRunRow {
  id: string;
  tender_id: string;
  stage_id: string;
  comparison_id: string;
  evidence_scope_id: string;
  model_provider: string | null;
  model_id: string | null;
  model_version: string | null;
  prompt_version: string | null;
  prompt_sha256: string | null;
  status: 'queued' | 'running' | 'completed' | 'completed_with_gaps' | 'failed';
  coverage: Record<string, unknown>;
  failure_code: string | null;
  requested_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface IReasonPinnedUnit {
  unitId: string;
  unitNo: number;
  title: string;
  unitCode: string | null;
  effects: Record<string, string>;
  fragmentIds: string[];
}

export interface IReasonPinnedInput {
  comparisonId: string;
  scopeId: string;
  indexVersionId: string | null;
  units: IReasonPinnedUnit[];
  restrictedAtStart: number;
  truncatedUnits: number;
}

export const getReasonRun = async (db: Queryable, id: string): Promise<IReasonRunRow | null> =>
  (await db.query<IReasonRunRow>('SELECT * FROM reason_run WHERE id = $1', [id])).rows[0] ?? null;

export const listReasonRuns = async (db: Queryable, comparisonId: string): Promise<IReasonRunRow[]> =>
  (await db.query<IReasonRunRow>('SELECT * FROM reason_run WHERE comparison_id = $1 ORDER BY created_at DESC LIMIT 20', [comparisonId])).rows;

export const reasonRunInput = async (db: Queryable, runId: string): Promise<{ input: IReasonPinnedInput; input_sha256: string } | null> =>
  (await db.query<{ input: IReasonPinnedInput; input_sha256: string }>('SELECT input, input_sha256 FROM reason_run_input WHERE run_id = $1', [runId])).rows[0] ?? null;

export type CreateReasonRunResult = { ok: true; run: IReasonRunRow } | { ok: false; reason: 'no_scope' | 'no_units' };

// Запуск: единицы (выбранные или все изменившиеся без подтверждённой причины) и кандидаты-основания — полнотекстовый
// поиск портала по наименованию единицы в последнем снимке области этапа; только фрагменты, читаемые запустившим.
// Вход закрепляется в транзакции запуска (R09-02).
export const createReasonRun = async (
  db: Queryable,
  r: { tenderId: string; stageId: string; comparisonId: string; ctx: IAccessContext; model: IModelIdentity | null; unitIds: readonly string[] | null },
): Promise<CreateReasonRunResult> => {
  const scope = (await listEvidenceScopes(db, r.stageId))[0];
  if (!scope) return { ok: false, reason: 'no_scope' };
  const units = (
    await db.query<{ id: string; unit_no: number; title: string; unit_code: string | null; effects: Record<string, string> }>(
      `SELECT u.id, u.unit_no, u.title, u.unit_code,
              coalesce((SELECT jsonb_object_agg(e.measure || ':' || e.component, trim_scale(e.amount)::text) FROM comparison_effect e WHERE e.unit_id = u.id), '{}'::jsonb) AS effects
         FROM comparison_unit u
        WHERE u.comparison_id = $1
          AND ($2::uuid[] IS NULL OR u.id = ANY($2::uuid[]))
          AND ($2::uuid[] IS NOT NULL OR (
                (u.kind <> 'matched' OR u.cost_left IS DISTINCT FROM u.cost_right OR u.commercial_left IS DISTINCT FROM u.commercial_right
                 OR ${CHANGE_NOTE_REASONS_SQL('u')})
                AND NOT EXISTS (SELECT 1 FROM change_explanation x WHERE x.unit_id = u.id AND x.reason_status = 'confirmed'
                                   AND x.version = (SELECT max(y.version) FROM change_explanation y WHERE y.unit_id = u.id))))
        ORDER BY u.unit_no`,
      [r.comparisonId, r.unitIds ? [...r.unitIds] : null],
    )
  ).rows;
  if (units.length === 0) return { ok: false, reason: 'no_units' };
  const chosen = units.slice(0, MAX_REASON_UNITS);
  const resolved = await resolveSnapshotScope(db, scope);
  const version = await getActiveVersion(db);
  const pinned: IReasonPinnedUnit[] = [];
  let restricted = 0;
  for (const u of chosen) {
    let ids: string[] = [];
    if (version && resolved.unitIds.length > 0) {
      const hits = await ftsBranch(db, version.id, resolved.unitIds, await queryLexemes(db, u.title), CANDIDATES_PER_UNIT * 2);
      const readable = await readableFragments(db, r.ctx, hits.map((h) => h.fragmentId));
      restricted += hits.filter((h) => !readable.has(h.fragmentId)).length;
      ids = hits.map((h) => h.fragmentId).filter((id) => readable.has(id)).slice(0, CANDIDATES_PER_UNIT);
    }
    pinned.push({ unitId: u.id, unitNo: u.unit_no, title: u.title, unitCode: u.unit_code, effects: u.effects, fragmentIds: ids });
  }
  const input: IReasonPinnedInput = {
    comparisonId: r.comparisonId,
    scopeId: scope.id,
    indexVersionId: version?.id ?? null,
    units: pinned,
    restrictedAtStart: restricted,
    truncatedUnits: units.length - chosen.length,
  };
  const prompt = r.model ? reasonSystemPrompt() : null;
  const ins = await db.query<IReasonRunRow>(
    `INSERT INTO reason_run (tender_id, stage_id, comparison_id, evidence_scope_id, model_provider, model_id, model_version, prompt_version, prompt_sha256, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [r.tenderId, r.stageId, r.comparisonId, scope.id, r.model?.providerId ?? null, r.model?.model ?? null, r.model?.version ?? null,
     prompt ? REASON_PROMPT_VERSION : null, prompt ? sha256Hex(prompt) : null, r.ctx.principal.userId],
  );
  const run = ins.rows[0]!;
  await db.query('INSERT INTO reason_run_input (run_id, input, input_sha256) VALUES ($1, $2, $3)', [run.id, JSON.stringify(input), sha256Hex(canonicalJson(input))]);
  await enqueueJob(db, { kind: REASON_JOB_KIND, dedupeKey: `reasons:${run.id}`, payload: { runId: run.id }, resourceClass: 'gpu', priority: REASON_JOB_PRIORITY, maxAttempts: 3, tenderId: r.tenderId });
  return { ok: true, run };
};

export const startReasonRun = async (db: Queryable, runId: string): Promise<void> => {
  await db.query("UPDATE reason_run SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'", [runId]);
};

export const finishReasonRun = async (db: Queryable, runId: string, f: { status: 'completed' | 'completed_with_gaps' | 'failed'; coverage: Record<string, unknown>; failureCode: string | null }): Promise<void> => {
  await db.query('UPDATE reason_run SET status = $2, coverage = $3, failure_code = $4, finished_at = now() WHERE id = $1', [runId, f.status, JSON.stringify(f.coverage), f.failureCode]);
};

// Гипотезы пишутся под блокировкой этапа вместе со ссылками и зависимостями; повтор задания второй раз не пишет.
export const insertReasonSuggestions = async (db: Queryable, run: IReasonRunRow, items: readonly IParsedReason[]): Promise<string[]> => {
  const ids: string[] = [];
  for (const it of items) {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO change_reason_suggestion (tender_id, stage_id, run_id, unit_id, reason_kind, rationale)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id, unit_id) DO NOTHING RETURNING id`,
      [run.tender_id, run.stage_id, run.id, it.unitId, it.reasonKind, it.rationale],
    );
    const id = ins.rows[0]?.id;
    if (!id) continue;
    for (const f of it.fragmentIds) await db.query('INSERT INTO change_reason_suggestion_evidence (suggestion_id, fragment_id) VALUES ($1, $2)', [id, f]);
    await insertDependencies(db, { tenderId: run.tender_id, stageId: run.stage_id, dependentType: 'change_reason_suggestion', dependentId: id, refs: await dependenciesOf(db, fragmentRefs(it.fragmentIds)) });
    ids.push(id);
  }
  return ids;
};

export interface IReasonSuggestionRow {
  id: string;
  run_id: string;
  unit_id: string;
  reason_kind: 'document' | 'answer' | 'supplier';
  rationale: string;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  explanation_id: string | null;
  row_version: number;
  stage_id: string;
  tender_id: string;
  comparison_id: string;
  evidence: { fragmentId: string; origin: string; text: string }[];
}

const SUGGESTION_SELECT = `
  SELECT s.id, s.run_id, s.unit_id, s.reason_kind, s.rationale, s.status, s.decided_by, s.decided_at, s.decision_reason, s.explanation_id, s.row_version::int AS row_version,
         s.stage_id, s.tender_id, r.comparison_id,
         coalesce((SELECT jsonb_agg(jsonb_build_object('fragmentId', f.id, 'origin', f.origin, 'text', left(f.text, 600)) ORDER BY ev.id)
                     FROM change_reason_suggestion_evidence ev JOIN evidence_fragment f ON f.id = ev.fragment_id WHERE ev.suggestion_id = s.id), '[]'::jsonb) AS evidence
    FROM change_reason_suggestion s JOIN reason_run r ON r.id = s.run_id`;

export const getReasonSuggestion = async (db: Queryable, id: string, lock = false): Promise<IReasonSuggestionRow | null> => {
  if (lock) await db.query('SELECT 1 FROM change_reason_suggestion WHERE id = $1 FOR UPDATE', [id]);
  return (await db.query<IReasonSuggestionRow>(`${SUGGESTION_SELECT} WHERE s.id = $1`, [id])).rows[0] ?? null;
};

export const listReasonSuggestions = async (db: Queryable, comparisonId: string): Promise<IReasonSuggestionRow[]> =>
  (await db.query<IReasonSuggestionRow>(`${SUGGESTION_SELECT} WHERE r.comparison_id = $1 ORDER BY s.created_at DESC`, [comparisonId])).rows;

export const decideReasonSuggestion = async (
  db: Queryable,
  d: { id: string; userId: string; status: 'accepted' | 'rejected'; reason: string | null; explanationId: string | null },
): Promise<void> => {
  await db.query(
    `UPDATE change_reason_suggestion SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, explanation_id = $5,
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [d.id, d.status, d.userId, d.reason, d.explanationId],
  );
};
