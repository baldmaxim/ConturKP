// Представление прогона поиска и снимка области для API (portal-api §2.3–2.4). Предварительный
// лексический результат помечается preliminary и за итоговый не выдаётся (ADR-012 §14).
import { emptyScopeMessage, fuseRrf, type IBranchHit } from '@kontur/core';
import {
  getSearchRun,
  getVersion,
  hitDetails,
  runHits,
  type IEvidenceScopeItemRow,
  type IEvidenceScopeRow,
  type IHitDetailRow,
  type IStoredHit,
  type Queryable,
} from '@kontur/db';

const SNIPPET_CHARS = 600;

const toHit = (rank: number, h: { fragmentId: string; origin: string; score: number; matchedVia: string[] }, d: IHitDetailRow | undefined) => ({
  rank,
  fragmentId: h.fragmentId,
  origin: h.origin,
  matchedVia: h.matchedVia,
  score: h.score,
  documentId: d?.document_id ?? null,
  documentTitle: d?.document_title ?? null,
  documentRevisionId: d?.document_revision_id ?? null,
  revisionSeq: d?.revision_seq ?? null,
  recognitionRunId: d?.run_id ?? null,
  fragmentKind: d?.fragment_kind ?? null,
  pageIndex: d?.page_index ?? null,
  pageLabel: d?.page_label ?? null,
  sheetLabel: d?.sheet_label ?? null,
  text: d ? d.text.slice(0, SNIPPET_CHARS) : '',
  textTruncated: d ? d.text.length > SNIPPET_CHARS : false,
});

export const searchRunView = async (db: Queryable, runId: string) => {
  const run = (await getSearchRun(db, runId))!;
  const version = await getVersion(db, run.index_version_id);
  const stored = await runHits(db, runId);
  const of = (b: IStoredHit['branch']): IBranchHit[] => stored.filter((h) => h.branch === b);
  const terminal = run.status !== 'pending';
  const fused = terminal ? stored.filter((h) => h.branch === 'fused') : [];
  // Пока прогон ждёт смысловую ветку, клиент видит слияние точной и полнотекстовой веток с явной
  // пометкой preliminary; в хранилище оно не пишется и итогом не считается.
  const lexical = terminal ? [] : fuseRrf({ exact: of('exact'), fts: of('fts') }, run.result_limit);
  const details = await hitDetails(db, [...fused.map((h) => h.fragmentId), ...lexical.map((h) => h.fragmentId)]);
  const counts = run.scope_counts;
  const empty = terminal && run.status !== 'failed' && fused.length === 0;
  return {
    searchRunId: run.id,
    status: run.status,
    context: { kind: run.context_kind, tenderId: run.tender_id, mode: run.mode, stageId: run.stage_id, evidenceScopeId: run.evidence_scope_id },
    query: run.query_text,
    scopeHash: run.scope_hash,
    scope: {
      units: counts.units ?? 0,
      pagesRecognized: counts.pagesRecognized ?? 0,
      pagesTotal: counts.pagesTotal ?? 0,
      unitsNotIndexed: counts.unitsNotIndexed ?? 0,
      revisionsWithoutRun: counts.revisionsWithoutRun ?? 0,
      excludedByAcl: counts.excludedByAcl ?? 0,
    },
    incomplete:
      (counts.unitsNotIndexed ?? 0) > 0 ||
      (counts.revisionsWithoutRun ?? 0) > 0 ||
      (counts.pagesRecognized ?? 0) < (counts.pagesTotal ?? 0) ||
      run.status === 'degraded',
    semantic: { status: run.semantic_status, reason: run.semantic_reason },
    index: { versionId: run.index_version_id, seq: version?.seq ?? null, embeddingModel: run.embedding_model },
    rankingVersion: run.ranking_version,
    branchCounts: { exact: of('exact').length, fts: of('fts').length, vector: of('vector').length },
    lexical: terminal ? null : { preliminary: true, items: lexical.map((h, i) => toHit(i + 1, h, details.get(h.fragmentId))) },
    fused: terminal && run.status !== 'failed' ? { items: fused.map((h) => toHit(h.rank, h, details.get(h.fragmentId))) } : null,
    emptyMessage: empty ? emptyScopeMessage(counts.units ?? 0, counts.pagesRecognized ?? 0, counts.pagesTotal ?? 0) : null,
    failureCode: run.failure_code,
    timings: run.timings,
    deadlineAt: run.deadline_at.toISOString(),
    createdAt: run.created_at.toISOString(),
    finishedAt: run.finished_at?.toISOString() ?? null,
  };
};

export const toEvidenceScope = (s: IEvidenceScopeRow & { units?: number }, items?: IEvidenceScopeItemRow[]) => ({
  id: s.id,
  stageId: s.stage_id,
  tenderId: s.tender_id,
  sourceSetRevisionId: s.source_set_revision_id,
  inputVersion: s.input_version,
  contentHash: s.content_hash,
  createdAt: s.created_at.toISOString(),
  units: s.units ?? items?.length ?? null,
  ...(items
    ? {
        items: items.map((i) => ({
          unitType: 'document_recognition',
          documentRevisionId: i.document_revision_id,
          documentId: i.document_id,
          documentTitle: i.document_title,
          revisionSeq: i.revision_seq,
          recognitionRunId: i.recognition_run_id,
          runStatus: i.run_status,
          pagesTotal: i.pages_total,
          pagesRecognized: i.pages_recognized,
        })),
      }
    : {}),
});
