// Представление прогона поиска и снимка области для API (portal-api §2.3–2.4). Предварительный
// лексический результат помечается preliminary и за итоговый не выдаётся (ADR-012 §14).
import { emptyScopeMessage, fuseRrf, type IBranchHit } from '@kontur/core';
import { outcomeOf } from './recognitionMappers.ts';
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
  // Фрагмент договора (D-023): в тендерном контексте попадает в итог только при contract.read.
  contractId: d?.contract_id ?? null,
  documentId: d?.document_id ?? null,
  documentTitle: d?.document_title ?? null,
  documentRevisionId: d?.document_revision_id ?? null,
  revisionSeq: d?.revision_seq ?? null,
  recognitionRunId: d?.run_id ?? null,
  fragmentKind: d?.fragment_kind ?? null,
  pageIndex: d?.page_index ?? null,
  pageLabel: d?.page_label ?? null,
  sheetLabel: d?.sheet_label ?? null,
  // A43: движок и итог прогона видны у каждого попадания; у локального — структурный якорь.
  engine: d?.run_engine ?? null,
  runOutcome: outcomeOf(d?.run_status),
  unitKind: d?.unit_kind ?? null,
  locator: d?.locator ?? null,
  // Вид источника (AD-07-1a): документ, письмо или транскрипция; шапка письма — и у фрагмента вложения.
  sourceKind: d?.source_unit_type ?? null,
  mail: d?.mail_message_id
    ? {
        messageId: d.mail_message_id,
        mailboxId: d.mailbox_id,
        revisionId: d.mail_message_revision_id,
        subject: d.mail_subject,
        from: d.mail_from,
        sentAt: d.mail_sent_at?.toISOString() ?? null,
        attachmentFilename: d.attachment_filename,
      }
    : null,
  transcript: d?.transcript_revision_id
    ? {
        sessionId: d.session_id,
        sessionTitle: d.session_title,
        revisionId: d.transcript_revision_id,
        speakerLabel: d.speaker_label,
        startMs: d.t_start_ms,
        endMs: d.t_end_ms,
      }
    : null,
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
    context: {
      kind: run.context_kind,
      tenderId: run.tender_id,
      contractId: run.contract_id,
      mode: run.mode,
      stageId: run.stage_id,
      evidenceScopeId: run.evidence_scope_id,
    },
    query: run.query_text,
    scopeHash: run.scope_hash,
    scope: {
      units: counts.units ?? 0,
      pagesRecognized: counts.pagesRecognized ?? 0,
      pagesTotal: counts.pagesTotal ?? 0,
      unitsNotIndexed: counts.unitsNotIndexed ?? 0,
      revisionsWithoutRun: counts.revisionsWithoutRun ?? 0,
      excludedByAcl: counts.excludedByAcl ?? 0,
      localUnits: counts.localUnits ?? 0,
      localNeedsReview: counts.localNeedsReview ?? 0,
      mailUnits: counts.mailUnits ?? 0,
      transcriptUnits: counts.transcriptUnits ?? 0,
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

// Единица договора в снимке тендера видна участнику только как факт (D-022 OD-3): название, документ, прогон
// и идентификатор договора — лишь с contract.read по этому договору. Так же письмо и вложение (D-025):
// шапка письма, документ вложения и прогон — лишь с mail.read на ящик письма; снимок права не даёт.
export const toEvidenceScope = (
  s: IEvidenceScopeRow & { units?: number },
  items?: IEvidenceScopeItemRow[],
  readableContracts: ReadonlySet<string> = new Set(),
  readableMailboxes: ReadonlySet<string> = new Set(),
) => ({
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
        items: items.map((i) => {
          const restricted =
            (i.contract_id !== null && !readableContracts.has(i.contract_id)) || (i.mailbox_id !== null && !readableMailboxes.has(i.mailbox_id));
          return {
            unitType: i.unit_type,
            contractId: restricted ? null : i.contract_id,
            restricted,
            documentRevisionId: restricted && i.unit_type !== 'document_recognition' ? null : i.document_revision_id,
            documentId: restricted ? null : i.document_id,
            documentTitle: restricted ? null : i.document_title,
            revisionSeq: restricted ? null : i.revision_seq,
            recognitionRunId: restricted ? null : i.recognition_run_id,
            runStatus: restricted ? null : i.run_status,
            pagesTotal: restricted ? null : i.pages_total,
            pagesRecognized: restricted ? null : i.pages_recognized,
            mailMessageId: restricted ? null : i.mail_message_id,
            mailMessageRevisionId: restricted ? null : i.mail_message_revision_id,
            mailRevisionSeq: restricted ? null : i.mail_revision_seq,
            mailSubject: restricted ? null : i.mail_subject,
            mailSentAt: restricted ? null : (i.mail_sent_at?.toISOString() ?? null),
            transcriptRevisionId: i.transcript_revision_id,
            transcriptSeq: i.transcript_seq,
            sessionId: i.session_id,
            sessionTitle: i.session_title,
          };
        }),
      }
    : {}),
});
