// Прогон анализа (D-026 «Model run», OD-08-2): неизменяемые условия — провайдер, модель, версия, промпт,
// настройки, снимок, вход; повтор на тех же входах возвращает тот же прогон, пока он не завершился отказом
// (И-08-3). Вход — допустимые фрагменты снимка, которые запустивший может читать (И-08-2). Кандидатов пишет
// только выполняющийся прогон; модель ничего не подтверждает (граница «AI safety»).
import type { AnalysisStatus, AnalysisTask, IModelFactCandidate, IModelRequirementCandidate } from '@kontur/core';
import { candidateKey, REVIEWABLE_ORIGINS } from '@kontur/core';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';

export interface IAnalysisRunRow {
  id: string;
  tender_id: string;
  stage_id: string;
  registry_id: string;
  evidence_scope_id: string;
  task: AnalysisTask;
  provider_id: string;
  model_id: string;
  model_version: string;
  prompt_version: string;
  prompt_sha256: string;
  inference_config: Record<string, unknown>;
  config_sha256: string;
  output_schema_version: string;
  input_sha256: string;
  input_count: number;
  attempt: number;
  status: AnalysisStatus;
  failure_code: string | null;
  coverage: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: unknown;
  requested_by: string;
  job_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  row_version: number;
}

export interface IScopeFragmentRow {
  id: string;
  origin: string;
  text: string;
  text_sha256: string;
  source_unit_type: string;
  scope_item_id: string;
  page_index: number | null;
}

// Допустимые фрагменты снимка в устойчивом порядке (единица снимка, страница, порядок, часть).
export const reviewableScopeFragments = async (db: Queryable, scopeId: string): Promise<IScopeFragmentRow[]> =>
  (
    await db.query<IScopeFragmentRow>(
      `SELECT f.id, f.origin, f.text, f.text_sha256, f.source_unit_type, i.id AS scope_item_id, f.page_index
         FROM evidence_scope_item i
         JOIN evidence_fragment f
           ON f.source_unit_id = coalesce(i.recognition_run_id, i.mail_message_revision_id, i.transcript_revision_id, i.qa_item_revision_id)
        WHERE i.scope_id = $1 AND f.origin = ANY($2::text[])
        ORDER BY i.id, f.page_index NULLS LAST, f.ordinal NULLS LAST, f.part_index, f.id`,
      [scopeId, REVIEWABLE_ORIGINS],
    )
  ).rows;

export interface IRunKey {
  registryId: string;
  task: AnalysisTask;
  providerId: string;
  modelId: string;
  modelVersion: string;
  promptSha256: string;
  configSha256: string;
  inputSha256: string;
}

export interface INewAnalysisRun extends IRunKey {
  tenderId: string;
  stageId: string;
  evidenceScopeId: string;
  promptVersion: string;
  inferenceConfig: Record<string, unknown>;
  outputSchemaVersion: string;
  inputFragmentIds: string[];
  requestedBy: string;
}

const KEY_WHERE = `registry_id = $1 AND task = $2 AND provider_id = $3 AND model_id = $4 AND model_version = $5
                   AND prompt_sha256 = $6 AND config_sha256 = $7 AND input_sha256 = $8`;
const keyParams = (k: IRunKey): unknown[] => [k.registryId, k.task, k.providerId, k.modelId, k.modelVersion, k.promptSha256, k.configSha256, k.inputSha256];

// Приоритет задания — 20: ниже импорта (50), выше пачек индексации (10); класс gpu (И-08-4, ADR-004 §7a).
export const ANALYSIS_JOB_PRIORITY = 20;
export const ANALYSIS_JOB_ATTEMPTS = 3;

export const enqueueAnalysisBatch = (db: Queryable, run: { id: string; tender_id: string }) =>
  enqueueJob(db, {
    kind: 'analysis.extract',
    dedupeKey: `analysis:${run.id}`,
    payload: { runId: run.id },
    resourceClass: 'gpu',
    priority: ANALYSIS_JOB_PRIORITY,
    maxAttempts: ANALYSIS_JOB_ATTEMPTS,
    tenderId: run.tender_id,
  });

// Повтор с тем же ключом — тот же прогон (если он не отказ); иначе новая попытка с входом и заданием.
export const createAnalysisRun = async (db: Queryable, r: INewAnalysisRun): Promise<{ run: IAnalysisRunRow; created: boolean }> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('analysis_run'), hashtext($1::text))", [r.registryId + r.inputSha256 + r.promptSha256 + r.configSha256]);
  const existing = await db.query<IAnalysisRunRow>(`SELECT * FROM analysis_run WHERE ${KEY_WHERE} AND status <> 'failed'`, keyParams(r));
  if (existing.rows[0]) return { run: existing.rows[0], created: false };
  const attempt = await db.query<{ n: number }>(`SELECT coalesce(max(attempt), 0) + 1 AS n FROM analysis_run WHERE ${KEY_WHERE}`, keyParams(r));
  const ins = await db.query<IAnalysisRunRow>(
    `INSERT INTO analysis_run (tender_id, stage_id, registry_id, evidence_scope_id, task, provider_id, model_id, model_version, prompt_version,
                               prompt_sha256, inference_config, config_sha256, output_schema_version, input_sha256, input_count, attempt, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [
      r.tenderId, r.stageId, r.registryId, r.evidenceScopeId, r.task, r.providerId, r.modelId, r.modelVersion, r.promptVersion,
      r.promptSha256, JSON.stringify(r.inferenceConfig), r.configSha256, r.outputSchemaVersion, r.inputSha256, r.inputFragmentIds.length,
      attempt.rows[0]!.n, r.requestedBy,
    ],
  );
  const run = ins.rows[0]!;
  if (r.inputFragmentIds.length > 0) {
    await db.query('INSERT INTO analysis_run_input (run_id, fragment_id) SELECT $1, unnest($2::uuid[])', [run.id, r.inputFragmentIds]);
  }
  const job = await enqueueAnalysisBatch(db, run);
  const upd = await db.query<IAnalysisRunRow>(
    'UPDATE analysis_run SET job_id = $2, row_version = row_version + 1, updated_at = now() WHERE id = $1 RETURNING *',
    [run.id, job.id],
  );
  return { run: upd.rows[0]!, created: true };
};

export const getAnalysisRun = async (db: Queryable, id: string): Promise<IAnalysisRunRow | null> =>
  (await db.query<IAnalysisRunRow>('SELECT * FROM analysis_run WHERE id = $1', [id])).rows[0] ?? null;

export const listAnalysisRuns = async (db: Queryable, registryId: string, limit = 50): Promise<IAnalysisRunRow[]> =>
  (await db.query<IAnalysisRunRow>('SELECT * FROM analysis_run WHERE registry_id = $1 ORDER BY created_at DESC, id LIMIT $2', [registryId, limit])).rows;

export const analysisRunInputIds = async (db: Queryable, runId: string): Promise<string[]> =>
  (await db.query<{ fragment_id: string }>('SELECT fragment_id FROM analysis_run_input WHERE run_id = $1', [runId])).rows.map((x) => x.fragment_id);

// Вход для модели в устойчивом порядке входа.
export const analysisRunInputs = async (db: Queryable, runId: string): Promise<{ id: string; origin: string; text: string }[]> =>
  (
    await db.query<{ id: string; origin: string; text: string }>(
      `SELECT f.id, f.origin, f.text FROM analysis_run_input i JOIN evidence_fragment f ON f.id = i.fragment_id
        WHERE i.run_id = $1 ORDER BY f.source_unit_id, f.page_index NULLS LAST, f.ordinal NULLS LAST, f.part_index, f.id`,
      [runId],
    )
  ).rows;

export const factKindCodes = async (db: Queryable): Promise<string[]> =>
  (await db.query<{ code: string }>('SELECT code FROM fact_kind ORDER BY code')).rows.map((x) => x.code);

export const startAnalysisRun = async (db: Queryable, runId: string): Promise<boolean> =>
  ((await db.query("UPDATE analysis_run SET status = 'running', started_at = now(), updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'queued'", [runId]))
    .rowCount ?? 0) === 1;

export const updateAnalysisProgress = async (
  db: Queryable,
  runId: string,
  progress: Record<string, unknown>,
  coverage: Record<string, unknown>,
  result: unknown,
): Promise<void> => {
  await db.query(
    "UPDATE analysis_run SET progress = $2, coverage = $3, result = $4, updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND status = 'running'",
    [runId, JSON.stringify(progress), JSON.stringify(coverage), JSON.stringify(result)],
  );
};

export const finishAnalysisRun = async (
  db: Queryable,
  runId: string,
  f: { status: 'completed' | 'completed_with_gaps' | 'failed'; failureCode: string | null; coverage: Record<string, unknown>; result: unknown },
): Promise<boolean> =>
  ((
    await db.query(
      `UPDATE analysis_run SET status = $2, failure_code = $3, coverage = $4, result = $5, finished_at = now(), updated_at = now(),
              row_version = row_version + 1
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [runId, f.status, f.failureCode, JSON.stringify(f.coverage), f.result === undefined ? null : JSON.stringify(f.result)],
    )
  ).rowCount ?? 0) === 1;

const insertCandidateLinks = async (db: Queryable, column: string, ownerId: string, tenderId: string, userId: string, refs: { fragmentId: string; role: string }[]) => {
  await db.query(
    `INSERT INTO evidence_link (tender_id, fragment_id, role, ${column}, created_by)
     SELECT $1, u.f, u.r, $2, $3 FROM unnest($4::uuid[], $5::text[]) AS u(f, r)`,
    [tenderId, ownerId, userId, refs.map((e) => e.fragmentId), refs.map((e) => e.role)],
  );
};

// Кандидаты требований от модели: повтор того же предложения с теми же основаниями в прогоне не дублируется.
export const insertModelRequirementCandidates = async (db: Queryable, run: IAnalysisRunRow, items: IModelRequirementCandidate[]): Promise<number> => {
  let n = 0;
  for (const c of items) {
    const key = candidateKey('requirement_extraction', c.statement, c.evidence.filter((e) => e.role === 'supports').map((e) => e.fragmentId));
    const ins = await db.query<{ id: string }>(
      `INSERT INTO requirement_candidate (tender_id, stage_id, registry_id, origin, analysis_run_id, candidate_key, statement, parameters,
                                          object_scope, rationale, confidence, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (analysis_run_id, candidate_key) DO NOTHING RETURNING id`,
      [run.tender_id, run.stage_id, run.registry_id, run.provider_id === 'rules' ? 'rule' : 'model', run.id, key, c.statement,
       JSON.stringify(c.parameters), JSON.stringify(c.objectScope), c.rationale, c.confidence, run.requested_by],
    );
    if (!ins.rows[0]) continue;
    await insertCandidateLinks(db, 'requirement_candidate_id', ins.rows[0].id, run.tender_id, run.requested_by, c.evidence);
    n += 1;
  }
  return n;
};

export const insertModelFactCandidates = async (db: Queryable, run: IAnalysisRunRow, items: IModelFactCandidate[]): Promise<number> => {
  let n = 0;
  for (const c of items) {
    const key = candidateKey('fact_extraction', `${c.factKind}\n${c.displayValue}`, c.evidence.filter((e) => e.role === 'supports').map((e) => e.fragmentId));
    const ins = await db.query<{ id: string }>(
      `INSERT INTO fact_candidate (tender_id, stage_id, registry_id, fact_kind, origin, analysis_run_id, candidate_key, display_value,
                                   normalized_value, unit, rationale, confidence, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (analysis_run_id, candidate_key) DO NOTHING RETURNING id`,
      [run.tender_id, run.stage_id, run.registry_id, c.factKind, run.provider_id === 'rules' ? 'rule' : 'model', run.id, key, c.displayValue,
       JSON.stringify(c.normalizedValue), c.unit, c.rationale, c.confidence, run.requested_by],
    );
    if (!ins.rows[0]) continue;
    await insertCandidateLinks(db, 'fact_candidate_id', ins.rows[0].id, run.tender_id, run.requested_by, c.evidence);
    n += 1;
  }
  return n;
};
