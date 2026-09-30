// Прогон поиска и три ветки (ADR-012 §11–17, state-machines §21). Фильтр по единицам области
// стоит в WHERE каждой ветки — до ORDER BY … LIMIT; постфильтрации top-k нет (ADR-008 §5, A42).
// Ветка ранжирует чанки и проецирует каждый в один фрагмент его связей по правилам RANKING_VERSION
// (G05-04): цитата — всегда существующий evidence_fragment.id из связей этого чанка.
import { EXACT_FOLD_FROM, EXACT_FOLD_TO, FRAGMENTS_PER_CHUNK, fuseRrf, vectorLiteral, type IBranchHit, type SearchBranch } from '@kontur/core';
import { contentTenderIds, readableContractIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

// ---------------------------------------------------------------- Ветки

const escapeLike = (s: string): string => s.replace(/[\\%_]/gu, (c) => `\\${c}`);

const firstPerFragment = <T extends { fragment_id: string }>(rows: T[], limit: number): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.fragment_id)) continue;
    seen.add(r.fragment_id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
};

// Точная ветка: обозначения запроса (коды листов, марки, номера пунктов) как подстроки
// нормализованного текста. Цитируется фрагмент, который сам содержит больше всего обозначений:
// фрагмент без обозначения ветка не цитирует, даже если оно есть в соседнем фрагменте чанка.
export const exactBranch = async (db: Queryable, versionId: string, unitIds: string[], tokens: string[], limit: number): Promise<IBranchHit[]> => {
  if (tokens.length === 0 || unitIds.length === 0) return [];
  const patterns = tokens.map((t) => `%${escapeLike(t)}%`);
  const r = await db.query<{ chunk_key: string; fragment_id: string; origin: string; matched: number; chunk_matched: number }>(
    `WITH chunks AS (
       SELECT c.id, c.chunk_key,
              (SELECT count(*) FROM unnest($3::text[]) p WHERE c.search_text LIKE p) AS matched
         FROM search_chunk c
        WHERE c.index_version_id = $1 AND c.source_unit_id = ANY ($2::uuid[]) AND c.search_text LIKE ANY ($3::text[])
        ORDER BY matched DESC, c.chunk_key
        LIMIT $4)
     SELECT ch.chunk_key, ch.matched AS chunk_matched, best.fragment_id, best.origin, best.matched
       FROM chunks ch
       CROSS JOIN LATERAL (
         SELECT c.fragment_id, c.origin, c.ordinal, c.matched FROM (
           SELECT l.fragment_id, f.origin, l.ordinal, l.role, x.matched,
                  max(x.matched) FILTER (WHERE l.role = 'body') OVER () AS body_top, max(x.matched) OVER () AS top
             FROM search_chunk_fragment l
             JOIN evidence_fragment f ON f.id = l.fragment_id
             CROSS JOIN LATERAL (
               SELECT (SELECT count(*) FROM unnest($3::text[]) p
                        WHERE translate(lower(f.text), '${EXACT_FOLD_FROM}', '${EXACT_FOLD_TO}') LIKE p) AS matched) x
            WHERE l.chunk_id = ch.id) c
          WHERE c.matched > 0
            AND CASE WHEN coalesce(c.body_top, 0) > 0 THEN c.role = 'body' AND c.matched = c.body_top ELSE c.matched = c.top END
          ORDER BY c.ordinal
          LIMIT $5) best
      ORDER BY best.matched DESC, ch.matched DESC, ch.chunk_key, best.ordinal`,
    [versionId, unitIds, patterns, limit * 2, FRAGMENTS_PER_CHUNK],
  );
  return firstPerFragment(r.rows, limit).map((x) => ({ fragmentId: x.fragment_id, origin: x.origin, chunkKey: x.chunk_key, score: x.matched }));
};

// Лексемы запроса в конфигурации russian (стоп-слова отброшены, слова приведены к основе).
export const queryLexemes = async (db: Queryable, query: string): Promise<string[]> => {
  const r = await db.query<{ lex: string[] | null }>("SELECT array_agg(DISTINCT lexeme ORDER BY lexeme) AS lex FROM unnest(to_tsvector('russian', search_prepare($1::text)))", [query]);
  return r.rows[0]?.lex ?? [];
};

// Полнотекстовая ветка: лексемы запроса через ИЛИ (вопрос на естественном языке содержит слова,
// которых в тексте нет), чанк ранжируется суммой IDF найденных лексем по области, затем
// ts_rank_cd с весом шапки. Цитируется фрагмент с наибольшей суммой IDF своих лексем.
// Нумерованный заголовок раздела: «7. Ответственность сторон» — короткая строка без знаков конца
// предложения. Для обзорного вопроса ведущим пунктом раздела он не считается.
const HEADING_RE = '^\\s*\\d+(\\.\\d+)*\\.?\\s+[^.!?;:]{1,80}$';

// overview — обзорный вопрос (expandRetrievalQuery): по одному фрагменту на чанк ради разнообразия
// разделов, и это ведущий пункт раздела — первый по порядку фрагмент тела, совпавший хотя бы по
// одному термину и не являющийся заголовком (ranking r1).
export const ftsBranch = async (
  db: Queryable,
  versionId: string,
  unitIds: string[],
  lexemes: string[],
  limit: number,
  overview = false,
): Promise<IBranchHit[]> => {
  if (lexemes.length === 0 || unitIds.length === 0) return [];
  const r = await db.query<{ chunk_key: string; fragment_id: string; origin: string; cov: number }>(
    `WITH q AS (
       SELECT (SELECT string_agg(search_term(x)::text, ' | ' ORDER BY x) FROM unnest($3::text[]) x)::tsquery AS tsq),
     n AS (
       SELECT count(*)::float8 AS total FROM search_chunk c WHERE c.index_version_id = $1 AND c.source_unit_id = ANY ($2::uuid[])),
     idf AS (
       SELECT x AS lexeme, search_term(x) AS tq,
              ln((n.total - df.df + 0.5) / (df.df + 0.5) + 1) AS w
         FROM unnest($3::text[]) x, n,
              LATERAL (SELECT count(*)::float8 AS df FROM search_chunk c
                        WHERE c.index_version_id = $1 AND c.source_unit_id = ANY ($2::uuid[]) AND c.fts @@ search_term(x)) df),
     hits AS (
       SELECT c.id, c.chunk_key,
              (SELECT coalesce(sum(i.w), 0) FROM idf i WHERE c.fts @@ i.tq) AS cov,
              ts_rank_cd(c.fts, q.tsq, 1) AS rnk
         FROM search_chunk c, q
        WHERE c.index_version_id = $1 AND c.source_unit_id = ANY ($2::uuid[]) AND c.fts @@ q.tsq
        ORDER BY cov DESC, rnk DESC, c.chunk_key
        LIMIT $4)
     SELECT h.chunk_key, h.cov, best.fragment_id, best.origin
       FROM hits h
       CROSS JOIN LATERAL (
         SELECT c.fragment_id, c.origin, c.ordinal, c.fcov, c.frnk FROM (
           SELECT l.fragment_id, f.origin, l.ordinal, l.role, x.fcov, x.frnk,
                  f.text ~ '${HEADING_RE}' AS is_heading,
                  max(x.fcov) FILTER (WHERE l.role = 'body') OVER () AS body_top, max(x.fcov) OVER () AS top
             FROM search_chunk_fragment l
             JOIN evidence_fragment f ON f.id = l.fragment_id
             CROSS JOIN LATERAL (
               SELECT (SELECT coalesce(sum(i.w), 0) FROM idf i WHERE to_tsvector('russian', search_prepare(f.text)) @@ i.tq) AS fcov,
                      ts_rank_cd(to_tsvector('russian', search_prepare(f.text)), (SELECT tsq FROM q), 1) AS frnk) x
            WHERE l.chunk_id = h.id) c
          WHERE c.fcov > 0
            AND CASE WHEN coalesce(c.body_top, 0) > 0
                     THEN c.role = 'body' AND ($6 OR c.fcov >= 0.5 * c.body_top)
                     ELSE $6 OR c.fcov >= 0.5 * c.top END
          ORDER BY CASE WHEN $6 THEN c.is_heading END, CASE WHEN $6 THEN c.ordinal END, c.fcov DESC, c.frnk DESC, c.ordinal
          LIMIT CASE WHEN $6 THEN 1 ELSE $5 END) best
      ORDER BY h.cov DESC, h.rnk DESC, h.chunk_key, best.fcov DESC, best.frnk DESC, best.ordinal`,
    [versionId, unitIds, lexemes, limit * 2, FRAGMENTS_PER_CHUNK, overview],
  );
  return firstPerFragment(r.rows, limit).map((x) => ({ fragmentId: x.fragment_id, origin: x.origin, chunkKey: x.chunk_key, score: x.cov }));
};

// Векторная ветка — точный перебор по уже отфильтрованной области: ANN-индекса нет намеренно
// (ADR-012 §7). Текст запроса вынесен в константу, чтобы тест плана проверял ровно его.
export const VECTOR_TOP_SQL = `
  SELECT v.chunk_id, v.embedding <=> $3::halfvec AS dist
    FROM search_chunk_vector v
   WHERE v.index_version_id = $1 AND v.source_unit_id = ANY ($2::uuid[])
   ORDER BY dist, v.chunk_id
   LIMIT $4`;

export const vectorBranch = async (
  db: Queryable,
  versionId: string,
  unitIds: string[],
  queryVector: number[],
  lexemes: string[],
  limit: number,
): Promise<IBranchHit[]> => {
  if (unitIds.length === 0) return [];
  const top = await db.query<{ chunk_id: string; dist: number }>(VECTOR_TOP_SQL, [versionId, unitIds, vectorLiteral(queryVector), limit * 2]);
  if (top.rows.length === 0) return [];
  // Проекция: фрагмент связей чанка с наибольшим числом лексем запроса, затем тело раньше шапки,
  // затем порядок в чанке. Фрагмент вне связей этого чанка выбран быть не может.
  const proj = await db.query<{ chunk_id: string; chunk_key: string; fragment_id: string; origin: string }>(
    `SELECT c.id AS chunk_id, c.chunk_key, best.fragment_id, best.origin
       FROM search_chunk c
       CROSS JOIN LATERAL (
         SELECT l.fragment_id, f.origin
           FROM search_chunk_fragment l JOIN evidence_fragment f ON f.id = l.fragment_id
          WHERE l.chunk_id = c.id
          ORDER BY (SELECT count(*) FROM unnest($2::text[]) x WHERE to_tsvector('russian', search_prepare(f.text)) @@ search_term(x)) DESC,
                   (l.role = 'body') DESC, l.ordinal
          LIMIT 1) best
      WHERE c.id = ANY ($1::uuid[]) AND c.index_version_id = $3 AND c.source_unit_id = ANY ($4::uuid[])`,
    [top.rows.map((t) => t.chunk_id), lexemes, versionId, unitIds],
  );
  const byChunk = new Map(proj.rows.map((p) => [p.chunk_id, p]));
  const ordered = top.rows.flatMap((t) => {
    const p = byChunk.get(t.chunk_id);
    return p ? [{ ...p, dist: t.dist }] : [];
  });
  return firstPerFragment(ordered, limit).map((x) => ({ fragmentId: x.fragment_id, origin: x.origin, chunkKey: x.chunk_key, score: 1 - x.dist }));
};

// Владелец контекста прогона (ADR-012 §24): тендер или договор.
export type SearchOwner = { kind: 'tender'; tenderId: string } | { kind: 'contract'; contractId: string };

export const ownerOfRun = (run: { tender_id: string | null; contract_id: string | null }): SearchOwner =>
  run.tender_id ? { kind: 'tender', tenderId: run.tender_id } : { kind: 'contract', contractId: run.contract_id! };

// Вторая линия (ADR-012 §13): каждый фрагмент результата сверяется с закреплённой областью по БД.
// Фрагмент договора в тендерном прогоне допустим только у договора, связанного с этим тендером,
// фрагмент письма и вложения — только у письма, у которого есть пара с этим тендером, фрагмент
// транскрипции — только своего тендера; то же правило держит охранник search_run_result (0012, 0018).
export const fragmentsOutsideScope = async (db: Queryable, owner: SearchOwner, fragmentIds: string[], unitIds: string[]): Promise<string[]> => {
  if (fragmentIds.length === 0) return [];
  const r = await db.query<{ id: string }>(
    `SELECT x.id FROM unnest($1::uuid[]) AS x(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM evidence_fragment f
         WHERE f.id = x.id AND f.source_unit_id = ANY ($4::uuid[])
           AND CASE WHEN $2::uuid IS NOT NULL
                    THEN f.tender_id = $2::uuid
                      OR (f.contract_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM contract_tender l WHERE l.contract_id = f.contract_id AND l.tender_id = $2::uuid))
                      OR (f.source_unit_type = 'recognition_run' AND f.tender_id IS NULL AND f.contract_id IS NULL AND EXISTS (
                            SELECT 1 FROM mail_message_tender l
                             WHERE l.message_id = document_revision_mail_message(f.document_revision_id) AND l.tender_id = $2::uuid))
                      OR (f.source_unit_type = 'mail_message_revision' AND EXISTS (
                            SELECT 1 FROM mail_message_revision mr JOIN mail_message_tender l ON l.message_id = mr.message_id
                             WHERE mr.id = f.mail_message_revision_id AND l.tender_id = $2::uuid))
                      OR (f.source_unit_type = 'transcript_revision' AND EXISTS (
                            SELECT 1 FROM transcript_revision t WHERE t.id = f.transcript_revision_id AND t.tender_id = $2::uuid))
                    ELSE f.contract_id = $3::uuid END)`,
    [fragmentIds, owner.kind === 'tender' ? owner.tenderId : null, owner.kind === 'contract' ? owner.contractId : null, unitIds],
  );
  return r.rows.map((x) => x.id);
};

// ---------------------------------------------------------------- Прогон

export type SearchRunStatus = 'pending' | 'complete' | 'degraded' | 'failed';
export type SemanticStatus = 'queued' | 'running' | 'complete' | 'unavailable' | 'failed' | 'timeout' | 'cancelled';

export interface ISearchRunRow {
  id: string;
  context_kind: 'tender' | 'contract';
  tender_id: string | null;
  contract_id: string | null;
  stage_id: string | null;
  mode: 'working' | 'review';
  evidence_scope_id: string | null;
  requested_by: string;
  principal_kind: string;
  query_text: string;
  query_sha256: string;
  query_normalization_version: string;
  result_limit: number;
  scope_hash: string;
  allowed_source_unit_ids: string[];
  scope_counts: Record<string, number>;
  index_version_id: string;
  ranking_version: string;
  embedding_model: string | null;
  embedding_model_fingerprint: string | null;
  status: SearchRunStatus;
  semantic_status: SemanticStatus;
  semantic_reason: string | null;
  job_id: string | null;
  deadline_at: Date;
  timings: Record<string, number>;
  failure_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface INewSearchRun {
  owner: SearchOwner;
  stageId: string | null;
  mode: 'working' | 'review';
  evidenceScopeId: string | null;
  requestedBy: string;
  queryText: string;
  querySha256: string;
  queryNormalizationVersion: string;
  resultLimit: number;
  scopeHash: string;
  allowedUnitIds: string[];
  scopeCounts: Record<string, number>;
  indexVersionId: string;
  rankingVersion: string;
  embeddingModel: string | null;
  embeddingModelFingerprint: string | null;
  semanticStatus: 'queued' | 'running';
  deadlineMs: number;
}

// Прогон создаётся pending всегда, даже если итог будет получен в той же транзакции (G05-02).
export const createSearchRun = async (db: Queryable, r: INewSearchRun): Promise<string> => {
  const q = await db.query<{ id: string }>(
    `INSERT INTO search_run (context_kind, tender_id, contract_id, stage_id, mode, evidence_scope_id, requested_by, query_text, query_sha256,
                             query_normalization_version, result_limit, scope_hash, allowed_source_unit_ids, scope_counts,
                             index_version_id, ranking_version, embedding_model, embedding_model_fingerprint, semantic_status, deadline_at)
     VALUES ($19, $1, $20, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[], $12::jsonb, $13, $14, $15, $16, $17,
             now() + make_interval(secs => $18::double precision / 1000))
     RETURNING id`,
    [
      r.owner.kind === 'tender' ? r.owner.tenderId : null,
      r.stageId,
      r.mode,
      r.evidenceScopeId,
      r.requestedBy,
      r.queryText,
      r.querySha256,
      r.queryNormalizationVersion,
      r.resultLimit,
      r.scopeHash,
      r.allowedUnitIds,
      JSON.stringify(r.scopeCounts),
      r.indexVersionId,
      r.rankingVersion,
      r.embeddingModel,
      r.embeddingModelFingerprint,
      r.semanticStatus,
      r.deadlineMs,
      r.owner.kind,
      r.owner.kind === 'contract' ? r.owner.contractId : null,
    ],
  );
  return q.rows[0]!.id;
};

export const getSearchRun = async (db: Queryable, id: string, lock = false): Promise<ISearchRunRow | null> => {
  const r = await db.query<ISearchRunRow>(`SELECT * FROM search_run WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ?? null;
};

// Прогон читает только его автор и только пока владелец контекста ему доступен (ADR-012 §13):
// тендер — участник, договор — contract.read.
export const getScopedSearchRun = async (db: Queryable, ctx: IAccessContext, id: string): Promise<ISearchRunRow | null> => {
  const r = await db.query<ISearchRunRow>(
    'SELECT * FROM search_run WHERE id = $1 AND requested_by = $2 AND (tender_id = ANY($3::uuid[]) OR contract_id = ANY($4::uuid[]))',
    [id, ctx.principal.userId, contentTenderIds(ctx), readableContractIds(ctx)],
  );
  return r.rows[0] ?? null;
};

export const setRunJob = async (db: Queryable, runId: string, jobId: string): Promise<void> => {
  await db.query("UPDATE search_run SET job_id = $2 WHERE id = $1 AND status = 'pending'", [runId, jobId]);
};

export const markSemanticRunning = async (db: Queryable, runId: string): Promise<boolean> => {
  const r = await db.query("UPDATE search_run SET semantic_status = 'running' WHERE id = $1 AND status = 'pending' AND semantic_status = 'queued'", [runId]);
  return (r.rowCount ?? 0) > 0;
};

export interface IStoredHit extends IBranchHit {
  branch: SearchBranch | 'fused';
  rank: number;
  matchedVia: string[];
}

export const insertBranchHits = async (db: Queryable, runId: string, branch: SearchBranch | 'fused', hits: (IBranchHit & { matchedVia?: string[] })[]): Promise<void> => {
  if (hits.length === 0) return;
  await db.query(
    `INSERT INTO search_run_result (run_id, branch, rank, fragment_id, origin, score, matched_via, chunk_key)
     SELECT $1, $2, x.rank, x.fragment_id, x.origin, x.score, string_to_array(x.via, ','), x.chunk_key
       FROM unnest($3::int[], $4::uuid[], $5::text[], $6::float8[], $7::text[], $8::text[]) AS x(rank, fragment_id, origin, score, via, chunk_key)`,
    [
      runId,
      branch,
      hits.map((_, i) => i + 1),
      hits.map((h) => h.fragmentId),
      hits.map((h) => h.origin),
      hits.map((h) => h.score),
      hits.map((h) => (h.matchedVia ?? [branch]).join(',')),
      hits.map((h) => h.chunkKey),
    ],
  );
};

export const runHits = async (db: Queryable, runId: string): Promise<IStoredHit[]> => {
  const r = await db.query<{ branch: SearchBranch | 'fused'; rank: number; fragment_id: string; origin: string; score: number; matched_via: string[]; chunk_key: string | null }>(
    'SELECT branch, rank, fragment_id, origin, score, matched_via, chunk_key FROM search_run_result WHERE run_id = $1 ORDER BY branch, rank',
    [runId],
  );
  return r.rows.map((x) => ({ branch: x.branch, rank: x.rank, fragmentId: x.fragment_id, origin: x.origin, score: x.score, matchedVia: x.matched_via, chunkKey: x.chunk_key }));
};

export interface ITerminalOutcome {
  status: 'complete' | 'degraded';
  semanticStatus: Exclude<SemanticStatus, 'queued' | 'running'>;
  semanticReason: string | null;
  vectorHits?: IBranchHit[];
  timings?: Record<string, number>;
}

export type FinalizeResult = 'finalized' | 'not_pending' | 'scope_violation';

// Терминализация прогона (state-machines §21): строка прогона блокируется, запись условна по
// status = 'pending'. Итоговое слияние строится ровно один раз и только по зафиксированному набору
// веток: {exact, fts, vector} для complete, {exact, fts} для degraded. Фрагмент вне закреплённой
// области отклоняет ответ целиком (ADR-012 §13).
export const finalizeRun = async (db: Queryable, runId: string, o: ITerminalOutcome): Promise<FinalizeResult> => {
  const run = await getSearchRun(db, runId, true);
  if (!run || run.status !== 'pending') return 'not_pending';
  const stored = await runHits(db, runId);
  const of = (b: SearchBranch): IBranchHit[] => stored.filter((h) => h.branch === b);
  const branches: Partial<Record<SearchBranch, IBranchHit[]>> = { exact: of('exact'), fts: of('fts') };
  if (o.status === 'complete') branches.vector = o.vectorHits ?? [];
  const fused = fuseRrf(branches, run.result_limit);
  const all = [...(o.vectorHits ?? []).map((h) => h.fragmentId), ...fused.map((h) => h.fragmentId)];
  const outside = await fragmentsOutsideScope(db, ownerOfRun(run), [...new Set(all)], run.allowed_source_unit_ids);
  if (outside.length > 0) {
    await db.query(
      `UPDATE search_run SET status = 'failed', semantic_status = CASE WHEN semantic_status IN ('queued', 'running') THEN 'failed' ELSE semantic_status END,
              failure_code = 'scope_violation', finished_at = now() WHERE id = $1 AND status = 'pending'`,
      [runId],
    );
    return 'scope_violation';
  }
  if (o.status === 'complete') await insertBranchHits(db, runId, 'vector', o.vectorHits ?? []);
  await insertBranchHits(db, runId, 'fused', fused.map((h) => ({ ...h, matchedVia: h.matchedVia })));
  await db.query(
    `UPDATE search_run SET status = $2, semantic_status = $3, semantic_reason = $4, timings = timings || $5::jsonb, finished_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [runId, o.status, o.semanticStatus, o.semanticReason, JSON.stringify(o.timings ?? {})],
  );
  return 'finalized';
};

export const failRunScope = async (db: Queryable, runId: string): Promise<void> => {
  await db.query(
    `UPDATE search_run SET status = 'failed', semantic_status = 'failed', failure_code = 'scope_violation', finished_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [runId],
  );
};

// Просроченные ожидающие прогоны: автономная терминализация не зависит от чтения клиентом (G05-02).
export const expiredPendingRuns = async (db: Queryable, limit = 100): Promise<string[]> => {
  const r = await db.query<{ id: string }>("SELECT id FROM search_run WHERE status = 'pending' AND deadline_at < now() ORDER BY deadline_at LIMIT $1", [limit]);
  return r.rows.map((x) => x.id);
};

export const recordTimings = async (db: Queryable, runId: string, timings: Record<string, number>): Promise<void> => {
  await db.query("UPDATE search_run SET timings = timings || $2::jsonb WHERE id = $1 AND status = 'pending'", [runId, JSON.stringify(timings)]);
};

// ---------------------------------------------------------------- Представление результата

export interface IHitDetailRow {
  id: string;
  source_unit_type: 'recognition_run' | 'mail_message_revision' | 'transcript_revision';
  contract_id: string | null;
  run_id: string | null;
  document_revision_id: string | null;
  document_id: string | null;
  document_title: string | null;
  revision_seq: number | null;
  origin: string;
  fragment_kind: string;
  page_index: number | null;
  page_label: string | null;
  sheet_label: string | null;
  bbox_norm: string[] | null;
  bbox_space: string | null;
  text: string;
  // Маркировка A43: движок и итог прогона-источника, якорь локального фрагмента и вид единицы.
  run_engine: string | null;
  run_status: string | null;
  locator: Record<string, unknown> | null;
  unit_kind: string | null;
  // Почтовая ветка (AD-07-1a): письмо, ящик и шапка ревизии; у фрагмента вложения — письмо вложения.
  mail_message_id: string | null;
  mailbox_id: string | null;
  mail_message_revision_id: string | null;
  mail_subject: string | null;
  mail_from: string | null;
  mail_sent_at: Date | null;
  attachment_filename: string | null;
  // Транскрипция: сессия, редакция, говорящий и таймкод сегмента.
  session_id: string | null;
  session_title: string | null;
  transcript_revision_id: string | null;
  speaker_label: string | null;
  t_start_ms: number | null;
  t_end_ms: number | null;
}

export const hitDetails = async (db: Queryable, fragmentIds: string[]): Promise<Map<string, IHitDetailRow>> => {
  if (fragmentIds.length === 0) return new Map();
  const r = await db.query<IHitDetailRow>(
    `SELECT f.id, f.source_unit_type, f.contract_id, f.run_id, f.document_revision_id, dr.document_id, d.title AS document_title, dr.revision_seq,
            f.origin, f.fragment_kind, f.page_index, p.page_label, p.sheet_label, f.bbox_norm, f.bbox_space, f.text,
            r.engine AS run_engine, r.status AS run_status, f.locator, p.unit_kind,
            coalesce(mr.message_id, amr.message_id) AS mail_message_id, coalesce(m.mailbox_id, am.mailbox_id) AS mailbox_id,
            coalesce(mr.id, amr.id) AS mail_message_revision_id, coalesce(mr.subject, amr.subject) AS mail_subject,
            coalesce(mr.from_address, amr.from_address) AS mail_from, coalesce(mr.sent_at, amr.sent_at) AS mail_sent_at,
            a.filename AS attachment_filename,
            ns.id AS session_id, ns.title AS session_title, f.transcript_revision_id, ts.speaker_label, ts.t_start_ms, ts.t_end_ms
       FROM evidence_fragment f
       LEFT JOIN recognition_run r ON r.id = f.run_id
       LEFT JOIN document_revision dr ON dr.id = f.document_revision_id
       LEFT JOIN document d ON d.id = dr.document_id
       LEFT JOIN recognition_page p ON p.run_id = f.run_id AND p.page_index = f.page_index
       LEFT JOIN mail_message_revision mr ON mr.id = f.mail_message_revision_id
       LEFT JOIN mail_message m ON m.id = mr.message_id
       LEFT JOIN mail_attachment a ON a.id = d.mail_attachment_id
       LEFT JOIN mail_message_revision amr ON amr.id = a.revision_id
       LEFT JOIN mail_message am ON am.id = amr.message_id
       LEFT JOIN transcript_segment ts ON ts.id = f.transcript_segment_id
       LEFT JOIN transcript_revision tr ON tr.id = f.transcript_revision_id
       LEFT JOIN negotiation_session ns ON ns.id = tr.session_id
      WHERE f.id = ANY($1::uuid[])`,
    [fragmentIds],
  );
  return new Map(r.rows.map((x) => [x.id, x]));
};
