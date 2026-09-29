// Сценарии прогона поиска, общие для сервера и worker (ADR-012 §14, state-machines §21):
// синхронная часть POST /search, решение о смысловой ветке, завершение смысловой ветки заданием
// и автономная деградация просроченного прогона. Внешних вызовов здесь нет: вектор запроса
// получает только worker, сервер берёт его из кеша или ставит задание.
import {
  BRANCH_LIMIT,
  designationTokens,
  embeddingInput,
  expandRetrievalQuery,
  normalizeQuery,
  QUERY_NORMALIZATION_VERSION,
  RANKING_VERSION,
  sha256Hex,
  templateOfInputVersion,
  type IBranchHit,
} from '@kontur/core';
import { enqueueJob, requestCancel } from './jobs.ts';
import type { Queryable } from './pool.ts';
import { cacheLookup, getModelStatus, getVersion, versionVectorCounts, type ISearchIndexVersionRow } from './searchIndex.ts';
import {
  createSearchRun,
  exactBranch,
  finalizeRun,
  fragmentsOutsideScope,
  ftsBranch,
  getSearchRun,
  insertBranchHits,
  queryLexemes,
  vectorBranch,
  type FinalizeResult,
  type SearchOwner,
} from './searchRuns.ts';
import { scopeCoverage, type IResolvedScope } from './searchScope.ts';

export type SemanticPlan =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'cached'; vector: number[] }
  | { kind: 'empty' }
  | { kind: 'queue' };

// Свежесть отказа модели, после которой сервер снова пробует смысловую ветку.
const MODEL_FAILURE_TTL_MS = 10 * 60_000;
const MODEL_REASONS = new Set(['model_unavailable', 'model_fingerprint_mismatch', 'dimension_mismatch']);

export const queryEmbeddingKey = (v: ISearchIndexVersionRow, query: string) => {
  const template = templateOfInputVersion(v.embedding_input_version!);
  return {
    key: { purpose: 'query' as const, model: v.embedding_model!, fingerprint: v.embedding_model_fingerprint!, inputVersion: v.embedding_input_version!, dim: v.embedding_dim! },
    input: embeddingInput(template, 'query', query),
  };
};

// Решение о смысловой ветке на сервере (ADR-012 §14, §17): честная недоступность с причиной,
// вектор запроса из кеша (синхронно, без внешних вызовов) или задание класса gpu.
export const planSemantic = async (db: Queryable, v: ISearchIndexVersionRow, query: string, now: Date): Promise<SemanticPlan> => {
  if (!v.embedding_model) return { kind: 'unavailable', reason: 'index_without_embeddings' };
  const counts = await versionVectorCounts(db, v.id);
  if (counts.chunks === 0) return { kind: 'empty' };
  if (counts.vectors === 0) return { kind: 'unavailable', reason: 'index_vectors_missing' };
  const status = await getModelStatus(db);
  if (
    status?.last_error_code &&
    status.last_checked_at &&
    now.getTime() - status.last_checked_at.getTime() < MODEL_FAILURE_TTL_MS &&
    (!status.last_success_at || status.last_success_at < status.last_checked_at)
  ) {
    return { kind: 'unavailable', reason: MODEL_REASONS.has(status.last_error_code) ? status.last_error_code : 'model_unavailable' };
  }
  const { key, input } = queryEmbeddingKey(v, query);
  const cached = await cacheLookup(db, key, [sha256Hex(input)]);
  const vector = cached.values().next().value;
  return vector ? { kind: 'cached', vector } : { kind: 'queue' };
};

export interface ISearchStart {
  owner: SearchOwner;
  // Единицы области, исключённые фильтром прав до ранжирования (ADR-008 §4): только число.
  excludedByAcl: number;
  stageId: string | null;
  mode: 'working' | 'review';
  evidenceScopeId: string | null;
  requestedBy: string;
  rawQuery: string;
  limit: number;
  deadlineMs: number;
  scope: IResolvedScope;
  scopeHash: string;
  version: ISearchIndexVersionRow;
  now: Date;
}

export interface ISearchStarted {
  runId: string;
  needsJob: boolean;
  result: FinalizeResult | 'pending';
}

// Синхронная часть поиска в транзакции команды: прогон создаётся pending (G05-02), точная и
// полнотекстовая ветки пишутся сразу, смысловая — синхронно из кеша, заданием или честным отказом.
export const startSearch = async (db: Queryable, s: ISearchStart): Promise<ISearchStarted> => {
  const query = normalizeQuery(s.rawQuery);
  const coverage = await scopeCoverage(db, s.version.id, s.scope.unitIds);
  // Пустая область: искать нечем ни одной ветке — прогон завершается сразу, без задания.
  const plan: SemanticPlan = s.scope.unitIds.length === 0 ? { kind: 'empty' } : await planSemantic(db, s.version, query, s.now);
  const runId = await createSearchRun(db, {
    owner: s.owner,
    stageId: s.stageId,
    mode: s.mode,
    evidenceScopeId: s.evidenceScopeId,
    requestedBy: s.requestedBy,
    queryText: query,
    querySha256: sha256Hex(query),
    queryNormalizationVersion: QUERY_NORMALIZATION_VERSION,
    resultLimit: s.limit,
    scopeHash: s.scopeHash,
    allowedUnitIds: s.scope.unitIds,
    scopeCounts: { ...coverage, revisionsWithoutRun: s.scope.revisionsWithoutRun, excludedByAcl: s.excludedByAcl },
    indexVersionId: s.version.id,
    rankingVersion: RANKING_VERSION,
    embeddingModel: s.version.embedding_model,
    embeddingModelFingerprint: s.version.embedding_model_fingerprint,
    semanticStatus: plan.kind === 'queue' ? 'queued' : 'running',
    deadlineMs: s.deadlineMs,
  });
  const t0 = Date.now();
  const exact = await exactBranch(db, s.version.id, s.scope.unitIds, designationTokens(query), BRANCH_LIMIT);
  const t1 = Date.now();
  const lexemes = await queryLexemes(db, query);
  const retrieval = expandRetrievalQuery(query);
  const ftsLexemes = retrieval.expanded ? await queryLexemes(db, retrieval.text) : lexemes;
  const fts = await ftsBranch(db, s.version.id, s.scope.unitIds, ftsLexemes, BRANCH_LIMIT, retrieval.expanded);
  const t2 = Date.now();
  const outside = await fragmentsOutsideScope(db, s.owner, [...exact, ...fts].map((h) => h.fragmentId), s.scope.unitIds);
  if (outside.length > 0) {
    await db.query(
      `UPDATE search_run SET status = 'failed', semantic_status = 'failed', failure_code = 'scope_violation', finished_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [runId],
    );
    return { runId, needsJob: false, result: 'scope_violation' };
  }
  await insertBranchHits(db, runId, 'exact', exact);
  await insertBranchHits(db, runId, 'fts', fts);
  const timings = { exactMs: t1 - t0, ftsMs: t2 - t1, queryExpanded: retrieval.expanded ? 1 : 0 };
  if (plan.kind === 'queue') {
    await db.query("UPDATE search_run SET timings = timings || $2::jsonb WHERE id = $1 AND status = 'pending'", [runId, JSON.stringify(timings)]);
    return { runId, needsJob: true, result: 'pending' };
  }
  if (plan.kind === 'unavailable') {
    const result = await finalizeRun(db, runId, { status: 'degraded', semanticStatus: 'unavailable', semanticReason: plan.reason, timings });
    return { runId, needsJob: false, result };
  }
  let vectorHits: IBranchHit[] = [];
  const t3 = Date.now();
  if (plan.kind === 'cached') vectorHits = await vectorBranch(db, s.version.id, s.scope.unitIds, plan.vector, lexemes, BRANCH_LIMIT);
  const result = await finalizeRun(db, runId, {
    status: 'complete',
    semanticStatus: 'complete',
    semanticReason: plan.kind === 'cached' ? 'query_vector_cached' : null,
    vectorHits,
    timings: { ...timings, vectorMs: Date.now() - t3 },
  });
  return { runId, needsJob: false, result };
};

// Смысловая ветка по готовности вектора запроса (worker, под действующей арендой): версия
// закреплена за прогоном и держится FOR SHARE, поэтому её данные не удаляются во время чтения.
export const completeSemantic = async (db: Queryable, runId: string, queryVector: number[], timings: Record<string, number>): Promise<FinalizeResult> => {
  const run = await getSearchRun(db, runId, true);
  if (!run || run.status !== 'pending') return 'not_pending';
  const v = await getVersion(db, run.index_version_id, 'share');
  if (!v || v.purged_at) {
    return finalizeRun(db, runId, { status: 'degraded', semanticStatus: 'failed', semanticReason: 'index_vectors_missing', timings });
  }
  const lexemes = await queryLexemes(db, run.query_text);
  const t0 = Date.now();
  const vectorHits = await vectorBranch(db, v.id, run.allowed_source_unit_ids, queryVector, lexemes, BRANCH_LIMIT);
  return finalizeRun(db, runId, { status: 'complete', semanticStatus: 'complete', semanticReason: null, vectorHits, timings: { ...timings, vectorMs: Date.now() - t0 } });
};

// Отказ смысловой ветки — деградация с причиной, а не тихая смена семантики (ADR-012 §14).
export const degradeSemantic = async (
  db: Queryable,
  runId: string,
  semanticStatus: 'failed' | 'cancelled' | 'unavailable' | 'timeout',
  reason: string,
): Promise<FinalizeResult> => finalizeRun(db, runId, { status: 'degraded', semanticStatus, semanticReason: reason });

// ---------------------------------------------------------------- Задания индексации (ADR-004 §7a)

export const JOB_PRIORITY = { searchSemantic: 100, indexBuild: 10, indexEmbed: 10, indexPurge: 0 } as const;

export const enqueueIndexBuild = (db: Queryable, versionId: string) =>
  enqueueJob(db, { kind: 'index.build', dedupeKey: `index-build:${versionId}`, payload: { versionId }, priority: JOB_PRIORITY.indexBuild });

export const enqueueIndexEmbed = (db: Queryable, versionId: string) =>
  enqueueJob(db, { kind: 'index.embed', dedupeKey: `index-embed:${versionId}`, payload: { versionId }, resourceClass: 'gpu', priority: JOB_PRIORITY.indexEmbed });

export const enqueueIndexPurge = (db: Queryable, versionId: string) =>
  enqueueJob(db, { kind: 'index.purge', dedupeKey: `index-purge:${versionId}`, payload: { versionId }, priority: JOB_PRIORITY.indexPurge });

export const enqueueSemantic = (db: Queryable, runId: string, tenderId: string | null) =>
  enqueueJob(db, {
    kind: 'search.semantic',
    dedupeKey: `search:${runId}`,
    payload: { searchRunId: runId },
    resourceClass: 'gpu',
    priority: JOB_PRIORITY.searchSemantic,
    maxAttempts: 1,
    tenderId,
  });

// Новый завершённый прогон распознавания дочитывается в живые версии индекса (active и building):
// поиск находит новый документ без ожидания прохода обслуживания.
export const enqueueLiveIndexBuilds = async (db: Queryable): Promise<void> => {
  const r = await db.query<{ id: string }>("SELECT id FROM search_index_version WHERE status IN ('building', 'active') ORDER BY seq");
  for (const v of r.rows) await enqueueIndexBuild(db, v.id);
};

// Просроченный прогон терминализуется автономно (G05-02): проходом обслуживания worker или
// попутно при чтении. Заданию ставится отмена; его позднее завершение ничего не запишет.
export const degradeIfExpired = async (db: Queryable, runId: string): Promise<boolean> => {
  const r = await db.query<{ expired: boolean; job_id: string | null }>(
    "SELECT deadline_at < now() AS expired, job_id FROM search_run WHERE id = $1 AND status = 'pending' FOR UPDATE",
    [runId],
  );
  const row = r.rows[0];
  if (!row?.expired) return false;
  const res = await finalizeRun(db, runId, { status: 'degraded', semanticStatus: 'timeout', semanticReason: 'semantic_timeout' });
  if (row.job_id) await requestCancel(db, row.job_id);
  return res === 'finalized';
};
