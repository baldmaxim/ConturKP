// Предложения значений полей моделью (этап 11; D-031 В-11-5; проект §6). Вход закрепляется при запуске: поля и
// кандидаты-основания из последнего снимка области (полнотекстовая ветка по подписи поля), только читаемые
// запустившим (R09-02). Права запустившего перепроверяет задание перед моделью (R09-04); предложения пишутся
// под блокировкой этапа, прошедшие гейт цитат и только по действующим основаниям (урок R10-01, R10-03).
import { canonicalJson, FORM_SUGGEST_PROMPT_VERSION, formSuggestSystemPrompt, sha256Hex, SUGGESTIBLE_TYPES, type FieldValue, type IField, type IFormSchema } from '@kontur/core';
import type { IAccessContext } from './access.ts';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';
import { readableFragments } from './requirementAccess.ts';
import { dependenciesOf, insertDependencies, type IModelIdentity } from './reviewRuns.ts';
import { getActiveVersion } from './searchIndex.ts';
import { ftsBranch, queryLexemes } from './searchRuns.ts';
import { listEvidenceScopes, resolveSnapshotScope } from './searchScope.ts';

export const FORM_SUGGEST_JOB_KIND = 'forms.suggest';
const FORM_SUGGEST_PRIORITY = 30;
const CANDIDATES_PER_FIELD = 5;
export const MAX_SUGGEST_FIELDS = 60;

export interface IFieldSuggestionRunRow {
  id: string;
  tender_id: string;
  stage_id: string;
  draft_id: string;
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

export interface ISuggestPinnedField {
  fieldKey: string;
  label: string;
  type: (typeof SUGGESTIBLE_TYPES)[number];
  help: string | null;
  unit: string | null;
  options: { value: string; label: string }[] | null;
  fragments: { fragmentId: string }[];
}

export interface ISuggestPinnedInput {
  draftId: string;
  draftTitle: string;
  scopeId: string;
  indexVersionId: string | null;
  fields: ISuggestPinnedField[];
  restrictedAtStart: number;
  truncatedFields: number;
}

const suggestible = (f: IField): f is IField & { type: ISuggestPinnedField['type'] } => (SUGGESTIBLE_TYPES as readonly string[]).includes(f.type);

export type CreateFieldSuggestionRunResult = { ok: true; run: IFieldSuggestionRunRow } | { ok: false; reason: 'no_scope' | 'no_fields' };

export const createFieldSuggestionRun = async (
  db: Queryable,
  r: { tenderId: string; stageId: string; draftId: string; draftTitle: string; schema: IFormSchema; ctx: IAccessContext; model: IModelIdentity | null; fieldKeys: readonly string[] | null },
): Promise<CreateFieldSuggestionRunResult> => {
  const scope = (await listEvidenceScopes(db, r.stageId))[0];
  if (!scope) return { ok: false, reason: 'no_scope' };
  const fields = r.schema.sections.flatMap((s) => s.fields).filter(suggestible).filter((f) => !r.fieldKeys || r.fieldKeys.includes(f.key));
  if (fields.length === 0) return { ok: false, reason: 'no_fields' };
  const chosen = fields.slice(0, MAX_SUGGEST_FIELDS);
  const resolved = await resolveSnapshotScope(db, scope);
  const version = await getActiveVersion(db);
  let restricted = 0;
  const pinned: ISuggestPinnedField[] = [];
  for (const f of chosen) {
    let ids: string[] = [];
    if (version && resolved.unitIds.length > 0) {
      const hits = await ftsBranch(db, version.id, resolved.unitIds, await queryLexemes(db, `${f.label} ${f.help ?? ''}`.trim()), CANDIDATES_PER_FIELD * 2);
      const readable = await readableFragments(db, r.ctx, hits.map((h) => h.fragmentId));
      restricted += hits.filter((h) => !readable.has(h.fragmentId)).length;
      ids = hits.map((h) => h.fragmentId).filter((id) => readable.has(id)).slice(0, CANDIDATES_PER_FIELD);
    }
    pinned.push({
      fieldKey: f.key,
      label: f.label,
      type: f.type,
      help: f.help ?? null,
      unit: f.type === 'number' ? (f.unit ?? null) : null,
      options: f.type === 'choice' ? f.options.map((o) => ({ value: o.value, label: o.label })) : null,
      fragments: ids.map((fragmentId) => ({ fragmentId })),
    });
  }
  const input: ISuggestPinnedInput = {
    draftId: r.draftId,
    draftTitle: r.draftTitle,
    scopeId: scope.id,
    indexVersionId: version?.id ?? null,
    fields: pinned,
    restrictedAtStart: restricted,
    truncatedFields: fields.length - chosen.length,
  };
  const prompt = r.model ? formSuggestSystemPrompt() : null;
  const run = (
    await db.query<IFieldSuggestionRunRow>(
      `INSERT INTO field_suggestion_run (tender_id, stage_id, draft_id, evidence_scope_id, model_provider, model_id, model_version, prompt_version, prompt_sha256, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [r.tenderId, r.stageId, r.draftId, scope.id, r.model?.providerId ?? null, r.model?.model ?? null, r.model?.version ?? null,
       prompt ? FORM_SUGGEST_PROMPT_VERSION : null, prompt ? sha256Hex(prompt) : null, r.ctx.principal.userId],
    )
  ).rows[0]!;
  await db.query('INSERT INTO field_suggestion_run_input (run_id, input, input_sha256) VALUES ($1, $2, $3)', [run.id, JSON.stringify(input), sha256Hex(canonicalJson(input))]);
  await enqueueJob(db, { kind: FORM_SUGGEST_JOB_KIND, dedupeKey: `forms-suggest:${run.id}`, payload: { runId: run.id }, resourceClass: 'gpu', priority: FORM_SUGGEST_PRIORITY, maxAttempts: 3, tenderId: r.tenderId });
  return { ok: true, run };
};

export const getFieldSuggestionRun = async (db: Queryable, id: string): Promise<IFieldSuggestionRunRow | null> =>
  (await db.query<IFieldSuggestionRunRow>('SELECT * FROM field_suggestion_run WHERE id = $1', [id])).rows[0] ?? null;

export const listFieldSuggestionRuns = async (db: Queryable, draftId: string): Promise<IFieldSuggestionRunRow[]> =>
  (await db.query<IFieldSuggestionRunRow>('SELECT * FROM field_suggestion_run WHERE draft_id = $1 ORDER BY created_at DESC LIMIT 20', [draftId])).rows;

export const fieldSuggestionRunInput = async (db: Queryable, runId: string): Promise<{ input: ISuggestPinnedInput; input_sha256: string } | null> =>
  (await db.query<{ input: ISuggestPinnedInput; input_sha256: string }>('SELECT input, input_sha256 FROM field_suggestion_run_input WHERE run_id = $1', [runId])).rows[0] ?? null;

export const startFieldSuggestionRun = async (db: Queryable, runId: string): Promise<void> => {
  await db.query("UPDATE field_suggestion_run SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'", [runId]);
};

export const finishFieldSuggestionRun = async (
  db: Queryable,
  runId: string,
  f: { status: 'completed' | 'completed_with_gaps' | 'failed'; coverage: Record<string, unknown>; failureCode: string | null },
): Promise<void> => {
  await db.query('UPDATE field_suggestion_run SET status = $2, coverage = $3, failure_code = $4, finished_at = now() WHERE id = $1', [runId, f.status, JSON.stringify(f.coverage), f.failureCode]);
};

export interface IFieldSuggestionItem {
  fieldKey: string;
  value: FieldValue;
  rationale: string;
  citations: { fragmentId: string; quote: string }[];
}

// Предложения пишутся под блокировкой этапа вместе с цитатами и зависимостями; повтор задания второй раз не пишет.
export const insertFieldSuggestions = async (db: Queryable, run: IFieldSuggestionRunRow, items: readonly IFieldSuggestionItem[]): Promise<string[]> => {
  const fieldIds = new Map(
    (await db.query<{ id: string; field_key: string }>('SELECT id, field_key FROM draft_field WHERE draft_id = $1', [run.draft_id])).rows.map((r) => [r.field_key, r.id]),
  );
  const ids: string[] = [];
  for (const it of items) {
    const fieldId = fieldIds.get(it.fieldKey);
    if (!fieldId) continue;
    const ins = await db.query<{ id: string }>(
      `INSERT INTO field_suggestion (tender_id, stage_id, run_id, draft_id, field_id, value, rationale)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (run_id, field_id) DO NOTHING RETURNING id`,
      [run.tender_id, run.stage_id, run.id, run.draft_id, fieldId, JSON.stringify(it.value), it.rationale || 'предложено по цитате'],
    );
    const id = ins.rows[0]?.id;
    if (!id) continue;
    for (const c of it.citations) await db.query('INSERT INTO field_suggestion_evidence (suggestion_id, fragment_id, quote) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, c.fragmentId, c.quote]);
    const refs = await dependenciesOf(db, it.citations.map((c) => ({ side: 'context' as const, objectType: 'fragment' as const, fragmentId: c.fragmentId })));
    await insertDependencies(db, { tenderId: run.tender_id, stageId: run.stage_id, dependentType: 'field_suggestion', dependentId: id, refs });
    ids.push(id);
  }
  return ids;
};

export interface IFieldSuggestionRow {
  id: string;
  run_id: string;
  draft_id: string;
  field_id: string;
  field_key: string;
  value: FieldValue;
  rationale: string;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  field_version_id: string | null;
  row_version: number;
  stage_id: string;
  tender_id: string;
  created_at: Date;
  evidence: { fragmentId: string; origin: string; text: string; quote: string }[];
}

const SUGGESTION_SELECT = `
  SELECT s.id, s.run_id, s.draft_id, s.field_id, f.field_key, s.value, s.rationale, s.status, s.decided_by, s.decided_at, s.decision_reason, s.field_version_id,
         s.row_version::int AS row_version, s.stage_id, s.tender_id, s.created_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object('fragmentId', g.id, 'origin', g.origin, 'text', left(g.text, 600), 'quote', ev.quote) ORDER BY ev.id)
                     FROM field_suggestion_evidence ev JOIN evidence_fragment g ON g.id = ev.fragment_id WHERE ev.suggestion_id = s.id), '[]'::jsonb) AS evidence
    FROM field_suggestion s JOIN draft_field f ON f.id = s.field_id`;

export const getFieldSuggestion = async (db: Queryable, id: string, lock = false): Promise<IFieldSuggestionRow | null> => {
  if (lock) await db.query('SELECT 1 FROM field_suggestion WHERE id = $1 FOR UPDATE', [id]);
  return (await db.query<IFieldSuggestionRow>(`${SUGGESTION_SELECT} WHERE s.id = $1`, [id])).rows[0] ?? null;
};

export const listFieldSuggestions = async (db: Queryable, draftId: string): Promise<IFieldSuggestionRow[]> =>
  (await db.query<IFieldSuggestionRow>(`${SUGGESTION_SELECT} WHERE s.draft_id = $1 AND s.status IN ('open', 'expired') ORDER BY s.created_at DESC`, [draftId])).rows;

export const decideFieldSuggestion = async (
  db: Queryable,
  d: { id: string; userId: string; status: 'accepted' | 'rejected'; reason: string | null; fieldVersionId: string | null },
): Promise<void> => {
  await db.query(
    `UPDATE field_suggestion SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, field_version_id = $5, updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [d.id, d.status, d.userId, d.reason, d.fieldVersionId],
  );
};
