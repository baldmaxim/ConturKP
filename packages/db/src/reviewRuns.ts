// Прогон проверки этапа 09 (docs/architecture/09-review-checks-design.md §2, §3.1, §6): входы закрепляются при запуске —
// снимок области (активного реестра), реестр, последняя ревизия расчёта, приоритет источников, версия правил и модели,
// версия входов этапа. Исходы, замечания правил и гипотезы пишет только выполняющийся прогон; замечание с тем же ключом
// не дублируется — пишется вхождение. Каждое замечание и гипотеза регистрирует зависимости от своих оснований (§5.4).
import {
  DEFAULT_SOURCE_PRIORITY,
  FINDING_KIND_META,
  canonicalJson,
  REVIEW_PROMPT_VERSION,
  REVIEW_RULES_SHA256,
  REVIEW_RULES_VERSION,
  reviewSystemPrompt,
  serializeReviewInput,
  sha256Hex,
  type CheckOutcome,
  type ICheckResult,
  type IEvidenceDraft,
  type IFindingDraft,
  type IHypothesis,
  type ReviewCheckCode,
  type ReviewRunStatus,
} from '@kontur/core';
import { enqueueJob } from './jobs.ts';
import { loadReviewInput } from './reviewInputs.ts';
import type { Queryable } from './pool.ts';

export interface IReviewRunRow {
  id: string;
  tender_id: string;
  stage_id: string;
  evidence_scope_id: string;
  registry_id: string | null;
  calculation_revision_id: string | null;
  priority_revision_id: string | null;
  priority_kinds: string[];
  stage_input_version: number;
  scope_input_version: number;
  rules_version: string;
  rules_sha256: string;
  model_provider: string | null;
  model_id: string | null;
  model_version: string | null;
  prompt_version: string | null;
  prompt_sha256: string | null;
  status: ReviewRunStatus;
  coverage: Record<string, unknown>;
  failure_code: string | null;
  requested_by: string;
  job_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  row_version: number;
}

export const REVIEW_RUN_JOB_KIND = 'review.run';
export const REVIEW_MODEL_JOB_KIND = 'review.model';
export const REVIEW_RUN_PRIORITY = 40;
export const REVIEW_MODEL_PRIORITY = 20;

export const enqueueReviewRun = (db: Queryable, run: { id: string; tender_id: string }) =>
  enqueueJob(db, { kind: REVIEW_RUN_JOB_KIND, dedupeKey: `review:${run.id}`, payload: { runId: run.id }, resourceClass: 'default', priority: REVIEW_RUN_PRIORITY, maxAttempts: 3, tenderId: run.tender_id });

export const enqueueReviewModel = (db: Queryable, run: { id: string; tender_id: string }) =>
  enqueueJob(db, { kind: REVIEW_MODEL_JOB_KIND, dedupeKey: `review-model:${run.id}`, payload: { runId: run.id }, resourceClass: 'gpu', priority: REVIEW_MODEL_PRIORITY, maxAttempts: 3, tenderId: run.tender_id });

export interface IModelIdentity {
  providerId: string;
  model: string;
  version: string;
}

export type CreateReviewRunResult = { ok: true; run: IReviewRunRow; created: boolean } | { ok: false; reason: 'no_scope' | 'inputs_changed' };

export type ReadableFragments = (fragmentIds: readonly string[]) => Promise<ReadonlySet<string>>;

// Запуск: активный прогон этапа (в очереди или выполняется) возвращается повторно — двойной запуск не плодит прогонов.
// Вход закрепляется в транзакции запуска под блокировкой этапа (R09-02): содержимое реестра, покрытие, вход модели (только
// читаемые запустившим цитаты), отпечаток содержимого этапа. Если содержимое изменилось во время сборки — отказ, повтор.
export const createReviewRun = async (
  db: Queryable,
  r: { tenderId: string; stageId: string; userId: string; model: IModelIdentity | null; readable: ReadableFragments },
): Promise<CreateReviewRunResult> => {
  const stage = (await db.query<{ input_version: number }>('SELECT input_version FROM tender_stage WHERE id = $1 FOR UPDATE', [r.stageId])).rows[0]!;
  const active = (await db.query<IReviewRunRow>("SELECT * FROM review_run WHERE stage_id = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1", [r.stageId])).rows[0];
  if (active) return { ok: true, run: active, created: false };
  const registry = (
    await db.query<{ id: string; evidence_scope_id: string }>(
      'SELECT g.id, g.evidence_scope_id FROM requirement_registry_active a JOIN requirement_registry g ON g.id = a.registry_id WHERE a.stage_id = $1',
      [r.stageId],
    )
  ).rows[0];
  const scope = (
    await db.query<{ id: string; input_version: number }>(
      registry ? 'SELECT id, input_version FROM evidence_scope WHERE id = $1' : 'SELECT id, input_version FROM evidence_scope WHERE stage_id = $1 ORDER BY created_at DESC, id LIMIT 1',
      [registry ? registry.evidence_scope_id : r.stageId],
    )
  ).rows[0];
  if (!scope) return { ok: false, reason: 'no_scope' };
  const calc = (await db.query<{ id: string }>('SELECT id FROM calculation_revision WHERE stage_id = $1 ORDER BY seq DESC LIMIT 1', [r.stageId])).rows[0];
  const priority = (await db.query<{ id: string; kinds: string[] }>('SELECT id, kinds FROM source_priority_revision WHERE tender_id = $1 ORDER BY seq DESC LIMIT 1', [r.tenderId])).rows[0];
  const system = reviewSystemPrompt();
  const ins = await db.query<IReviewRunRow>(
    `INSERT INTO review_run (tender_id, stage_id, evidence_scope_id, registry_id, calculation_revision_id, priority_revision_id, priority_kinds,
                             stage_input_version, scope_input_version, rules_version, rules_sha256, model_provider, model_id, model_version,
                             prompt_version, prompt_sha256, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [
      r.tenderId, r.stageId, scope.id, registry?.id ?? null, calc?.id ?? null, priority?.id ?? null, priority?.kinds ?? [...DEFAULT_SOURCE_PRIORITY],
      stage.input_version, scope.input_version, REVIEW_RULES_VERSION, REVIEW_RULES_SHA256,
      r.model?.providerId ?? null, r.model?.model ?? null, r.model?.version ?? null,
      r.model ? REVIEW_PROMPT_VERSION : null, r.model ? sha256Hex(system) : null, r.userId,
    ],
  );
  const run = ins.rows[0]!;
  const fingerprint = await stageContentFingerprint(db, r.stageId, run.registry_id);
  const { input } = await loadReviewInput(db, run);
  const modelInput = run.model_provider ? await hypothesisSource(db, run, r.readable) : null;
  if ((await stageContentFingerprint(db, r.stageId, run.registry_id)) !== fingerprint) return { ok: false, reason: 'inputs_changed' };
  const json = serializeReviewInput(input);
  await db.query('INSERT INTO review_run_input (run_id, input, model_input, input_sha256, content_fingerprint) VALUES ($1, $2, $3, $4, $5)', [
    run.id,
    JSON.stringify(json),
    modelInput ? JSON.stringify(modelInput) : null,
    sha256Hex(`kontur.review_run_input.v1\n${canonicalJson({ input: json, model: modelInput })}`),
    fingerprint,
  ]);
  const job = await enqueueReviewRun(db, run);
  const upd = await db.query<IReviewRunRow>('UPDATE review_run SET job_id = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1 RETURNING *', [run.id, job.id]);
  return { ok: true, run: upd.rows[0]!, created: true };
};

export interface IHypothesisSource {
  requirements: { code: string; statement: string; parameters: { name: string; value: string; unit: string | null }[]; fragments: { fragmentId: string; text: string }[] }[];
  positions: { positionId: string; text: string; unit: string | null; volume: number | null }[];
  restricted: number;
}

export interface IReviewRunInputRow {
  input: Record<string, unknown>;
  model_input: IHypothesisSource | null;
  input_sha256: string;
  content_fingerprint: string;
}

// Закреплённый вход прогона; у прогонов до 0025 входа нет — их задание завершается отказом `input_not_pinned`.
export const reviewRunInput = async (db: Queryable, runId: string): Promise<IReviewRunInputRow | null> =>
  (await db.query<IReviewRunInputRow>('SELECT input, model_input, input_sha256, content_fingerprint FROM review_run_input WHERE run_id = $1', [runId])).rows[0] ?? null;

export const getReviewRun = async (db: Queryable, id: string): Promise<IReviewRunRow | null> =>
  (await db.query<IReviewRunRow>('SELECT * FROM review_run WHERE id = $1', [id])).rows[0] ?? null;

export const listReviewRuns = async (db: Queryable, stageId: string, limit = 50): Promise<IReviewRunRow[]> =>
  (await db.query<IReviewRunRow>('SELECT * FROM review_run WHERE stage_id = $1 ORDER BY created_at DESC, id LIMIT $2', [stageId, limit])).rows;

export interface ICheckResultRow {
  check_code: ReviewCheckCode;
  outcome: CheckOutcome;
  reason: string | null;
  counts: Record<string, number>;
}

export const reviewCheckResults = async (db: Queryable, runId: string): Promise<ICheckResultRow[]> =>
  (
    await db.query<ICheckResultRow>(
      'SELECT r.check_code, r.outcome, r.reason, r.counts FROM review_check_result r JOIN review_check c ON c.code = r.check_code WHERE r.run_id = $1 ORDER BY c.ordinal',
      [runId],
    )
  ).rows;

export const startReviewRun = async (db: Queryable, runId: string): Promise<boolean> =>
  ((await db.query("UPDATE review_run SET status = 'running', started_at = now(), updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'queued'", [runId]))
    .rowCount ?? 0) === 1;

export const updateReviewCoverage = async (db: Queryable, runId: string, coverage: Record<string, unknown>): Promise<void> => {
  await db.query("UPDATE review_run SET coverage = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'running'", [runId, JSON.stringify(coverage)]);
};

export const finishReviewRun = async (
  db: Queryable,
  runId: string,
  f: { status: 'completed' | 'completed_with_gaps' | 'failed'; failureCode: string | null; coverage: Record<string, unknown> },
): Promise<boolean> =>
  ((
    await db.query(
      `UPDATE review_run SET status = $2, failure_code = $3, coverage = $4, finished_at = now(), updated_at = now(), row_version = row_version + 1
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [runId, f.status, f.failureCode, JSON.stringify(f.coverage)],
    )
  ).rowCount ?? 0) === 1;

export const insertCheckResults = async (db: Queryable, runId: string, results: readonly ICheckResult[] | readonly { check: ReviewCheckCode; outcome: CheckOutcome; reason: string | null; counts: Record<string, number> }[]): Promise<void> => {
  for (const r of results) {
    await db.query('INSERT INTO review_check_result (run_id, check_code, outcome, reason, counts) VALUES ($1, $2, $3, $4, $5)', [
      runId,
      r.check,
      r.outcome,
      r.reason ? r.reason.slice(0, 2000) : null,
      JSON.stringify(r.counts),
    ]);
  }
};

// ---------------------------------------------------------------- Зависимости

export interface IDependencyRef {
  type: string;
  id: string;
}

// Зависимости оснований: объект и всё, из чего он получен — единица, редакция и документ фрагмента; ревизия и
// вопрос–ответ; ревизия расчёта; факт и его фрагменты.
export const dependenciesOf = async (db: Queryable, evidence: readonly IEvidenceDraft[]): Promise<IDependencyRef[]> => {
  const deps: IDependencyRef[] = [];
  const add = (type: string, id: string | null | undefined) => {
    if (id) deps.push({ type, id });
  };
  const fragmentIds = evidence.map((e) => e.fragmentId).filter((x): x is string => !!x);
  if (fragmentIds.length > 0) {
    const r = await db.query<{ id: string; source_unit_type: string; source_unit_id: string; document_revision_id: string | null; document_id: string | null }>(
      `SELECT f.id, f.source_unit_type, f.source_unit_id, f.document_revision_id, dr.document_id
         FROM evidence_fragment f LEFT JOIN document_revision dr ON dr.id = f.document_revision_id WHERE f.id = ANY($1::uuid[])`,
      [[...new Set(fragmentIds)]],
    );
    for (const f of r.rows) {
      add('fragment', f.id);
      add(f.source_unit_type, f.source_unit_id);
      add('document_revision', f.document_revision_id);
      add('document', f.document_id);
    }
  }
  const qaRevisions = evidence.map((e) => e.qaItemRevisionId).filter((x): x is string => !!x);
  if (qaRevisions.length > 0) {
    for (const q of (await db.query<{ id: string; item_id: string }>('SELECT id, item_id FROM qa_item_revision WHERE id = ANY($1::uuid[])', [qaRevisions])).rows) {
      add('qa_item_revision', q.id);
      add('qa_item', q.item_id);
    }
  }
  for (const e of evidence) {
    add('calculation_revision', e.calculationRevisionId);
    add('requirement_revision', e.requirementRevisionId);
    add('evidence_fact', e.evidenceFactId);
    add('customer_question', e.customerQuestionId);
    add('document_revision', e.documentRevisionId);
  }
  const seen = new Set<string>();
  return deps.filter((d) => (seen.has(`${d.type}:${d.id}`) ? false : (seen.add(`${d.type}:${d.id}`), true)));
};

export const insertDependencies = async (db: Queryable, d: { tenderId: string; stageId: string; dependentType: string; dependentId: string; refs: readonly IDependencyRef[] }): Promise<void> => {
  if (d.refs.length === 0) return;
  await db.query(
    `INSERT INTO evidence_dependency (tender_id, stage_id, dependent_type, dependent_id, depends_on_type, depends_on_id)
     SELECT $1, $2, $3, $4, u.t, u.i FROM unnest($5::text[], $6::uuid[]) AS u(t, i)
     ON CONFLICT (dependent_type, dependent_id, depends_on_type, depends_on_id) DO NOTHING`,
    [d.tenderId, d.stageId, d.dependentType, d.dependentId, d.refs.map((r) => r.type), d.refs.map((r) => r.id)],
  );
};

export const insertFindingEvidence = async (db: Queryable, findingId: string, tenderId: string, evidence: readonly IEvidenceDraft[]): Promise<void> => {
  for (const e of evidence) {
    await db.query(
      `INSERT INTO finding_evidence (finding_id, tender_id, side, object_type, fragment_id, calculation_revision_id, external_position_id, external_item_id,
                                     requirement_revision_id, evidence_fact_id, customer_question_id, qa_item_revision_id, document_revision_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        findingId, tenderId, e.side, e.objectType, e.fragmentId ?? null, e.calculationRevisionId ?? null, e.externalPositionId ?? null, e.externalItemId ?? null,
        e.requirementRevisionId ?? null, e.evidenceFactId ?? null, e.customerQuestionId ?? null, e.qaItemRevisionId ?? null, e.documentRevisionId ?? null, e.note ?? null,
      ],
    );
  }
};

// ---------------------------------------------------------------- Замечания правил

export interface IRuleFindingsOutcome {
  created: number;
  observed: number;
  createdIds: string[];
}

// Замечание правила: действующее (не устаревшее) с тем же ключом получает вхождение; иначе — новое замечание с событием
// создания, основаниями и зависимостями. Решение человека по существующему замечанию прогон не трогает (I12).
export const writeRuleFindings = async (db: Queryable, run: IReviewRunRow, drafts: readonly IFindingDraft[]): Promise<IRuleFindingsOutcome> => {
  let created = 0;
  let observed = 0;
  const createdIds: string[] = [];
  for (const d of drafts) {
    const live = (await db.query<{ id: string }>("SELECT id FROM finding WHERE stage_id = $1 AND finding_key = $2 AND status <> 'stale'", [run.stage_id, d.key])).rows[0];
    if (live) {
      await db.query('INSERT INTO finding_occurrence (run_id, finding_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [run.id, live.id]);
      observed += 1;
      continue;
    }
    const meta = FINDING_KIND_META[d.kind];
    const ins = await db.query<{ id: string }>(
      `INSERT INTO finding (tender_id, stage_id, finding_key, kind, check_code, origin, title, detail, severity, confidence, action, suggested_side,
                            first_run_id, created_input_version)
       VALUES ($1, $2, $3, $4, $5, 'rule', $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [run.tender_id, run.stage_id, d.key, d.kind, d.check, d.title.slice(0, 500), d.detail ? d.detail.slice(0, 4000) : null, meta.severity, d.confidence,
       d.action ? d.action.slice(0, 1000) : null, d.suggestedSide, run.id, run.scope_input_version],
    );
    const id = ins.rows[0]!.id;
    await db.query(
      `INSERT INTO finding_event (finding_id, tender_id, seq, event_kind, to_value, actor_kind, run_id) VALUES ($1, $2, 1, 'created', 'open', 'system', $3)`,
      [id, run.tender_id, run.id],
    );
    await insertFindingEvidence(db, id, run.tender_id, d.evidence);
    await insertDependencies(db, { tenderId: run.tender_id, stageId: run.stage_id, dependentType: 'finding', dependentId: id, refs: await dependenciesOf(db, d.evidence) });
    await db.query('INSERT INTO finding_occurrence (run_id, finding_id) VALUES ($1, $2)', [run.id, id]);
    createdIds.push(id);
    created += 1;
  }
  return { created, observed, createdIds };
};

// ---------------------------------------------------------------- Гипотезы модели

export const insertSuggestions = async (db: Queryable, run: IReviewRunRow, items: readonly IHypothesis[]): Promise<string[]> => {
  const ids: string[] = [];
  for (const h of items) {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO model_suggestion (tender_id, stage_id, run_id, request_id, kind, title, rationale, payload)
       VALUES ($1, $2, $3, $4, 'discrepancy_hypothesis', $5, $6, $7)
       ON CONFLICT (run_id, request_id) DO NOTHING RETURNING id`,
      [run.tender_id, run.stage_id, run.id, h.requestId, h.title, h.rationale, JSON.stringify({ left: { fragmentId: h.leftFragmentId }, right: h.right })],
    );
    if (!ins.rows[0]) continue;
    const id = ins.rows[0].id;
    const evidence: IEvidenceDraft[] = [{ side: 'left', objectType: 'fragment', fragmentId: h.leftFragmentId }];
    if (h.right && 'fragmentId' in h.right) evidence.push({ side: 'right', objectType: 'fragment', fragmentId: h.right.fragmentId });
    if (h.right && 'positionId' in h.right) {
      evidence.push({ side: 'right', objectType: 'calculation_object', calculationRevisionId: run.calculation_revision_id!, externalPositionId: h.right.positionId, externalItemId: null });
    }
    for (const e of evidence) {
      await db.query(
        'INSERT INTO model_suggestion_evidence (suggestion_id, tender_id, side, fragment_id, calculation_revision_id, external_position_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, run.tender_id, e.side, e.fragmentId ?? null, e.calculationRevisionId ?? null, e.externalPositionId ?? null],
      );
    }
    await insertDependencies(db, { tenderId: run.tender_id, stageId: run.stage_id, dependentType: 'model_suggestion', dependentId: id, refs: await dependenciesOf(db, evidence) });
    ids.push(id);
  }
  return ids;
};

// Вход модели: подтверждённые требования реестра с цитатами, которые запустивший может читать, и позиции расчёта.
export const hypothesisSource = async (
  db: Queryable,
  run: { registry_id: string | null; calculation_revision_id: string | null },
  readable: ReadableFragments,
): Promise<IHypothesisSource> => {
  if (!run.registry_id) return { requirements: [], positions: [], restricted: 0 };
  const rows = (
    await db.query<{ code: string; statement: string; parameters: { name: string; value: string; unit: string | null }[]; fragment_id: string; text: string }>(
      `SELECT q.code, v.statement, v.parameters, f.id AS fragment_id, f.text
         FROM requirement q JOIN requirement_revision v ON v.id = q.current_revision_id
         JOIN evidence_link l ON l.requirement_revision_id = v.id AND l.role = 'supports'
         JOIN evidence_fragment f ON f.id = l.fragment_id
        WHERE v.registry_id = $1 AND v.status = 'confirmed'
        ORDER BY q.code, l.created_at, f.id`,
      [run.registry_id],
    )
  ).rows;
  const ok = await readable(rows.map((r) => r.fragment_id));
  const byCode = new Map<string, { code: string; statement: string; parameters: { name: string; value: string; unit: string | null }[]; fragments: { fragmentId: string; text: string }[]; blocked: boolean }>();
  for (const r of rows) {
    const cur = byCode.get(r.code) ?? { code: r.code, statement: r.statement, parameters: r.parameters, fragments: [], blocked: false };
    if (ok.has(r.fragment_id)) cur.fragments.push({ fragmentId: r.fragment_id, text: r.text });
    else cur.blocked = true;
    byCode.set(r.code, cur);
  }
  // Требование с недоступной запустившему цитатой в модель не уходит целиком (производный текст тоже закрыт, R08-02).
  const requirements = [...byCode.values()].filter((r) => !r.blocked && r.fragments.length > 0).map(({ blocked: _b, ...r }) => r);
  const restricted = [...byCode.values()].filter((r) => r.blocked).length;
  const positions = run.calculation_revision_id
    ? (
        await db.query<{ external_position_id: string; text: string; unit_code: string | null; volume: string | null }>(
          `SELECT p.external_position_id, concat_ws(' — ', p.section_number, coalesce(p.work_name, p.position_name)) AS text, p.unit_code,
                  coalesce(p.manual_volume, p.volume)::text AS volume
             FROM calculation_revision r JOIN calculation_position p ON p.content_id = r.content_id
            WHERE r.id = $1 AND NOT coalesce(p.is_section, false) ORDER BY p.position_number NULLS LAST, p.external_position_id`,
          [run.calculation_revision_id],
        )
      ).rows.map((p) => ({ positionId: p.external_position_id, text: p.text, unit: p.unit_code, volume: p.volume === null ? null : Number(p.volume) }))
    : [];
  return { requirements, positions, restricted };
};

// Отпечаток содержимого этапа, которое меняется без события барьера: ревизии требований и оценки покрытия реестра,
// отметки полноты, допущения, вопросы заказчику, решения по требованиям. Прогон хранит его; другой отпечаток —
// «после проверки изменились реестр или записи этапа» (прогон устарел, §3.1).
export const stageContentFingerprint = async (db: Queryable, stageId: string, registryId: string | null): Promise<string> => {
  const r = await db.query<{ v: string }>(
    `SELECT concat_ws('|',
              (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM requirement_revision WHERE registry_id = $2),
              (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM requirement_coverage WHERE stage_id = $1),
              (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM registry_fragment_mark WHERE registry_id = $2),
              (SELECT count(*) || ':' || coalesce(max(completed_at)::text, '') FROM requirement_registry_review WHERE registry_id = $2),
              (SELECT count(*) || ':' || coalesce(max(v.created_at)::text, '') FROM assumption_revision v WHERE v.stage_id = $1),
              (SELECT count(*) || ':' || coalesce(max(row_version + extract(epoch FROM updated_at))::text, '') FROM customer_question WHERE stage_id = $1),
              (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM decision WHERE stage_id = $1 AND decision_type = 'requirement_decision')) AS v`,
    [stageId, registryId],
  );
  return sha256Hex(`kontur.stage_content.v1\n${r.rows[0]!.v}`);
};
