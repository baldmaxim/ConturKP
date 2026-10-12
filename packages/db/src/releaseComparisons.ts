// Сравнение двух выпусков (этап 15; проект docs/architecture/15-send-comparison-design.md §8–§11). Снимок стороны
// собирается только из закреплённых записей выпуска: снимок области кандидата, закреплённый вход его прогона проверок,
// закреплённые решения, версии полей и файлы, манифест выпуска. Текущие папки, рабочий набор источников, активный реестр
// и поисковый индекс не читаются — переиндексация и новое распознавание результат не меняют (I05, I15). Сравнение
// считается одной транзакцией и затем неизменно; причины выводов — версии, ставит человек (I11).
import {
  compareReleaseSnapshots,
  RELEASE_COMPARE_METHOD,
  sha256Hex,
  type CalculationState,
  type CompareSection,
  type IComparisonItem,
  type IFactSnap,
  type IFieldSnap,
  type IQaUnit,
  type IReceivedInput,
  type IReleaseManifest,
  type IReleaseSnapshot,
  type IRequirementSnap,
  type ISectionSummary,
  type ISourceUnit,
} from '@kontur/core';
import type { IReleaseRow } from './approvals.ts';
import { createComparison, loadEconomicsRevision } from './economics.ts';
import type { Queryable } from './pool.ts';

export interface IReleaseComparisonRow {
  id: string;
  tender_id: string;
  left_release_id: string;
  right_release_id: string;
  method_version: string;
  status: 'computing' | 'ready' | 'failed';
  failure_reason: string | null;
  calculation_comparison_id: string | null;
  summary: IReleaseComparisonSummary | null;
  result_sha256: string | null;
  requested_by: string;
  requested_by_name: string;
  created_at: Date;
  finished_at: Date | null;
}

export interface IReleaseComparisonSummary {
  sections: Record<CompareSection, ISectionSummary>;
  calculation: { state: 'same_revision' | 'compared' | 'failed'; leftRevisionId: string; rightRevisionId: string; comparisonId: string | null; resultSha256: string | null; reason: string | null };
  // Интервал «получено между выпусками»: закрепление входов левого и правого кандидатов.
  interval: { from: string; to: string; empty: boolean };
  // Редакции правого снимка без распознавания (I18).
  unrecognizedRight: number;
}

export interface IReleaseComparisonItemRow {
  id: string;
  comparison_id: string;
  ordinal: number;
  section: CompareSection;
  change: string;
  subject_type: string;
  item_key: string;
  left_ref: string | null;
  right_ref: string | null;
  left_sha256: string | null;
  right_sha256: string | null;
  detail: Record<string, unknown>;
}

export interface IReleaseReasonRow {
  id: string;
  item_id: string;
  comparison_id: string;
  version: number;
  reason_kind: 'document' | 'answer' | 'supplier' | 'internal_decision' | 'unknown';
  reason_status: 'unknown' | 'hypothesis' | 'confirmed';
  rationale: string | null;
  actor_user_id: string;
  actor_name: string;
  created_at: Date;
  fragment_ids: string[];
  decision_ids: string[];
}

// ---------------------------------------------------------------- Снимок стороны

interface IPinnedCandidate {
  id: string;
  stage_id: string;
  evidence_scope_id: string;
  calculation_revision_id: string;
  created_at: Date;
}

const pinnedCandidate = async (db: Queryable, candidateId: string): Promise<IPinnedCandidate> =>
  (await db.query<IPinnedCandidate>('SELECT id, stage_id, evidence_scope_id, calculation_revision_id, created_at FROM release_candidate WHERE id = $1', [candidateId])).rows[0]!;

interface IScopeRow {
  unit_type: string;
  document_revision_id: string | null;
  recognition_run_id: string | null;
  mail_message_revision_id: string | null;
  mail_message_id: string | null;
  transcript_revision_id: string | null;
  qa_item_revision_id: string | null;
  document_id: string | null;
  blob_sha256: string | null;
  raw_blob_sha256: string | null;
  session_id: string | null;
  transcript_sha256: string | null;
  qa_item_id: string | null;
  qa_sha256: string | null;
  qa_status: IQaUnit['status'] | null;
}

const scopeRows = async (db: Queryable, scopeId: string): Promise<IScopeRow[]> =>
  (
    await db.query<IScopeRow>(
      `SELECT i.unit_type, i.document_revision_id, i.recognition_run_id, i.mail_message_revision_id, i.mail_message_id, i.transcript_revision_id,
              i.qa_item_revision_id, dr.document_id, dr.blob_sha256, mr.raw_blob_sha256, tr.session_id, tr.content_sha256 AS transcript_sha256,
              qr.item_id AS qa_item_id, qr.content_sha256 AS qa_sha256, qr.status AS qa_status
         FROM evidence_scope_item i
         LEFT JOIN document_revision dr ON dr.id = i.document_revision_id
         LEFT JOIN mail_message_revision mr ON mr.id = i.mail_message_revision_id
         LEFT JOIN transcript_revision tr ON tr.id = i.transcript_revision_id
         LEFT JOIN qa_item_revision qr ON qr.id = i.qa_item_revision_id
        WHERE i.scope_id = $1 ORDER BY i.id`,
      [scopeId],
    )
  ).rows;

const sourcesOf = (rows: readonly IScopeRow[]): { sources: ISourceUnit[]; qa: IQaUnit[] } => {
  const sources: ISourceUnit[] = [];
  const qa: IQaUnit[] = [];
  for (const r of rows) {
    if (r.unit_type === 'document_recognition' && r.document_revision_id && r.document_id) {
      sources.push({ unitType: 'document_recognition', logicalId: r.document_id, revisionId: r.document_revision_id, sha256: r.blob_sha256, recognitionRunId: r.recognition_run_id });
    } else if (r.unit_type === 'mail_message' && r.mail_message_revision_id && r.mail_message_id) {
      sources.push({ unitType: 'mail_message', logicalId: r.mail_message_id, revisionId: r.mail_message_revision_id, sha256: r.raw_blob_sha256, recognitionRunId: null });
    } else if (r.unit_type === 'transcript_revision' && r.transcript_revision_id && r.session_id) {
      sources.push({ unitType: 'transcript_revision', logicalId: r.session_id, revisionId: r.transcript_revision_id, sha256: r.transcript_sha256, recognitionRunId: null });
    } else if (r.unit_type === 'qa_item_revision' && r.qa_item_revision_id && r.qa_item_id && r.qa_sha256 && r.qa_status) {
      qa.push({ itemId: r.qa_item_id, revisionId: r.qa_item_revision_id, contentSha256: r.qa_sha256, status: r.qa_status });
    }
  }
  return { sources, qa };
};

interface IPinnedReviewInput {
  requirements?: { requirementId: string; revisionId: string; coverage: { state: string } | null }[];
  facts?: { factId: string; factType: string; status: string }[];
  questions?: { kind: string; id: string }[];
}

const reviewOf = async (db: Queryable, candidateId: string): Promise<IReleaseSnapshot['review']> => {
  const pinned = (
    await db.query<{ input: IPinnedReviewInput }>(
      `SELECT i.input FROM candidate_input ci JOIN review_run_input i ON i.run_id = ci.ref_id
        WHERE ci.candidate_id = $1 AND ci.kind = 'review_run' ORDER BY ci.ordinal LIMIT 1`,
      [candidateId],
    )
  ).rows[0];
  if (!pinned) return null;
  const input = pinned.input;
  const reqs = input.requirements ?? [];
  const shas = new Map(
    (await db.query<{ id: string; content_sha256: string }>('SELECT id, content_sha256 FROM requirement_revision WHERE id = ANY($1::uuid[])', [reqs.map((r) => r.revisionId)])).rows.map((r) => [r.id, r.content_sha256]),
  );
  const requirements: IRequirementSnap[] = reqs.map((r) => ({ requirementId: r.requirementId, revisionId: r.revisionId, contentSha256: shas.get(r.revisionId) ?? sha256Hex(`missing:${r.revisionId}`), coverageState: r.coverage?.state ?? null }));
  const pinnedFacts = input.facts ?? [];
  const factRows = new Map(
    (
      await db.query<{ id: string; normalized_key: string; clause_ref: string; condition: string; document_id: string }>(
        `SELECT f.id, f.normalized_key, f.clause_ref, f.condition, x.document_id FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id
          WHERE f.id = ANY($1::uuid[])`,
        [pinnedFacts.map((f) => f.factId)],
      )
    ).rows.map((f) => [f.id, f]),
  );
  const facts: IFactSnap[] = [];
  for (const f of pinnedFacts) {
    const row = factRows.get(f.factId);
    if (!row) continue;
    facts.push({ factId: f.factId, factType: f.factType, normalizedKey: row.normalized_key, documentId: row.document_id, clauseRef: row.clause_ref, conditionSha256: sha256Hex(row.condition), status: f.status });
  }
  return { requirements, facts, openQuestionIds: (input.questions ?? []).filter((q) => q.kind === 'customer_question').map((q) => q.id) };
};

type ManifestDecisions = Pick<IReleaseManifest, 'acceptedRisks' | 'reviewRisks' | 'holds'>;

export const loadReleaseSnapshot = async (db: Queryable, release: IReleaseRow, manifest: ManifestDecisions): Promise<IReleaseSnapshot> => {
  const c = await pinnedCandidate(db, release.candidate_id);
  const { sources, qa } = sourcesOf(await scopeRows(db, c.evidence_scope_id));
  const decisionIds = (await db.query<{ ref_id: string }>("SELECT ref_id FROM candidate_input WHERE candidate_id = $1 AND kind = 'decision' ORDER BY ordinal", [c.id])).rows.map((r) => r.ref_id);
  const chain = (
    await db.query<{ root: string; id: string }>(
      `WITH RECURSIVE chain(root, id, depth) AS (
         SELECT d.id, d.supersedes_decision_id, 1 FROM decision d WHERE d.id = ANY($1::uuid[]) AND d.supersedes_decision_id IS NOT NULL
         UNION ALL
         SELECT c.root, d.supersedes_decision_id, c.depth + 1 FROM chain c JOIN decision d ON d.id = c.id WHERE d.supersedes_decision_id IS NOT NULL AND c.depth < 100)
       SELECT root, id FROM chain ORDER BY root, depth`,
      [decisionIds],
    )
  ).rows;
  const holds = (
    await db.query<{ event_id: string; seq: number; decision_id: string | null }>(
      `SELECT e.id AS event_id, e.seq, h.decision_id FROM stage_input_event e
         LEFT JOIN readiness_hold h ON h.input_event_id = e.id AND h.candidate_id = $2
        WHERE e.stage_id = $1 AND e.seq = ANY($3::bigint[])`,
      [c.stage_id, c.id, manifest.holds.map((h) => h.eventSeq)],
    )
  ).rows;
  const holdBySeq = new Map(holds.map((h) => [Number(h.seq), h]));
  const files = (
    await db.query<{ id: string; path: string; blob_sha256: string }>("SELECT id, path, blob_sha256 FROM candidate_file WHERE candidate_id = $1 AND role <> 'preview' ORDER BY ordinal", [c.id])
  ).rows;
  const fieldRows = (
    await db.query<{ version_id: string; draft_id: string; field_key: string; template_id: string; value_sha256: string; draft_ordinal: number }>(
      `SELECT v.id AS version_id, v.draft_id, f.field_key, r.template_id,
              encode(sha256(convert_to(coalesce(v.value::text, 'null'), 'UTF8')), 'hex') AS value_sha256,
              (SELECT min(d.ordinal) FROM candidate_input d WHERE d.candidate_id = ci.candidate_id AND d.kind = 'application_draft' AND d.ref_id = v.draft_id) AS draft_ordinal
         FROM candidate_input ci JOIN draft_field_version v ON v.id = ci.ref_id JOIN draft_field f ON f.id = v.field_id
         JOIN application_draft a ON a.id = v.draft_id JOIN template_revision r ON r.id = a.template_revision_id
        WHERE ci.candidate_id = $1 AND ci.kind = 'field_version'
        ORDER BY r.template_id, draft_ordinal, v.draft_id, f.field_key`,
      [c.id],
    )
  ).rows;
  // Номер приложения внутри шаблона: порядок приложений в комплекте.
  const slots = new Map<string, Map<string, number>>();
  const fields: IFieldSnap[] = fieldRows.map((f) => {
    const byDraft = slots.get(f.template_id) ?? new Map<string, number>();
    slots.set(f.template_id, byDraft);
    if (!byDraft.has(f.draft_id)) byDraft.set(f.draft_id, byDraft.size + 1);
    return { templateId: f.template_id, slot: byDraft.get(f.draft_id)!, fieldKey: f.field_key, versionId: f.version_id, valueSha256: f.value_sha256 };
  });
  return {
    releaseId: release.id,
    stageId: c.stage_id,
    manifestSha256: release.release_manifest_sha256,
    calculationRevisionId: c.calculation_revision_id,
    sources,
    qa,
    review: await reviewOf(db, c.id),
    decisions: decisionIds.map((id) => ({ id, supersedes: chain.filter((x) => x.root === id).map((x) => x.id) })),
    risks: manifest.acceptedRisks.map((a) => ({ id: a.id, code: a.code, subjectType: a.subjectType, subjectId: a.subjectId, subjectKey: a.subjectKey })),
    reviewRiskFindingIds: manifest.reviewRisks.map((x) => x.findingId),
    holds: manifest.holds
      .map((h) => ({ eventId: holdBySeq.get(h.eventSeq)?.event_id ?? '', decision: h.decision === 'не влияет' ? ('not_applicable' as const) : ('requires_new_candidate' as const), decisionId: holdBySeq.get(h.eventSeq)?.decision_id ?? null }))
      .filter((h) => h.eventId !== ''),
    files: files.map((f) => ({ fileId: f.id, path: f.path, sha256: f.blob_sha256 })),
    fields,
  };
};

// ---------------------------------------------------------------- Получено между выпусками (проект §10)

const receivedInputs = async (db: Queryable, tenderId: string, l: IPinnedCandidate, r: IPinnedCandidate, leftRows: readonly IScopeRow[], rightRows: readonly IScopeRow[]): Promise<IReceivedInput[]> => {
  const out: IReceivedInput[] = [];
  const empty = r.created_at <= l.created_at;
  const leftRuns = new Map(leftRows.filter((x) => x.document_revision_id).map((x) => [x.document_revision_id!, x.recognition_run_id]));
  const rightDocs = new Map(rightRows.filter((x) => x.document_revision_id).map((x) => [x.document_revision_id!, x]));
  const rightMail = new Map(rightRows.filter((x) => x.unit_type === 'mail_message' && x.mail_message_id).map((x) => [x.mail_message_id!, x]));
  const base = { repeatOccurrence: false, recognizedAfterLeft: false, disposition: 'none' as const, decisionId: null };

  const docs = empty
    ? []
    : (
        await db.query<{ id: string; blob_sha256: string }>(
          `SELECT dr.id, dr.blob_sha256 FROM document_revision dr JOIN document d ON d.id = dr.document_id
            WHERE dr.tender_id = $1 AND d.mail_attachment_id IS NULL AND dr.created_at > $2 AND dr.created_at <= $3 ORDER BY dr.created_at, dr.id`,
          [tenderId, l.created_at, r.created_at],
        )
      ).rows;
  const outside = docs.filter((d) => !rightDocs.has(d.id)).map((d) => d.id);
  // Решение руководителя по событию получения редакции: комплект правой стороны, затем левой.
  const dispositions = new Map<string, { status: string; decision_id: string | null }>();
  if (outside.length > 0) {
    const rows = await db.query<{ revision_id: string; status: string; decision_id: string | null; is_right: boolean }>(
      `SELECT e.ref_id AS revision_id, h.status, h.decision_id, (h.candidate_id = $3) AS is_right
         FROM stage_input_event e JOIN readiness_hold h ON h.input_event_id = e.id
        WHERE e.ref_type = 'document_revision' AND e.ref_id = ANY($1::uuid[]) AND h.candidate_id IN ($2, $3) AND h.status <> 'open'
        ORDER BY e.ref_id, (h.candidate_id = $3) DESC, h.resolved_at, h.id`,
      [outside, l.id, r.id],
    );
    for (const x of rows.rows) if (!dispositions.has(x.revision_id)) dispositions.set(x.revision_id, x);
  }
  for (const d of docs) {
    const unit = rightDocs.get(d.id);
    const disp = dispositions.get(d.id);
    out.push({
      ...base,
      kind: 'document_revision',
      id: d.id,
      revisionId: d.id,
      sha256: d.blob_sha256,
      inInterval: true,
      inRightScope: !!unit,
      rightRecognized: !!unit?.recognition_run_id,
      disposition: disp ? (disp.status === 'resolved_not_applicable' ? 'not_applicable' : 'requires_new_candidate') : 'none',
      decisionId: disp?.decision_id ?? null,
    });
  }

  // Поздно распознанные: редакция получена до левого закрепления, у левой стороны распознавания нет, прогон правого
  // снимка создан после левого закрепления.
  const lateCandidates = [...rightDocs.values()].filter((x) => x.recognition_run_id && !leftRuns.get(x.document_revision_id!));
  if (lateCandidates.length > 0) {
    const late = await db.query<{ id: string; blob_sha256: string }>(
      `SELECT dr.id, dr.blob_sha256 FROM document_revision dr JOIN recognition_run rr ON rr.document_revision_id = dr.id
        WHERE rr.id = ANY($1::uuid[]) AND dr.created_at <= $2 AND rr.created_at > $2 ORDER BY dr.id`,
      [lateCandidates.map((x) => x.recognition_run_id), l.created_at],
    );
    for (const d of late.rows) {
      out.push({ ...base, kind: 'document_revision', id: d.id, revisionId: d.id, sha256: d.blob_sha256, inInterval: false, inRightScope: true, rightRecognized: true, recognizedAfterLeft: true });
    }
  }

  if (!empty) {
    const occurrences = await db.query<{ id: string; document_revision_id: string; blob_sha256: string; repeat: boolean }>(
      `SELECT o.id, o.document_revision_id, dr.blob_sha256, (o.id <> first.id) AS repeat
         FROM document_occurrence o JOIN document_revision dr ON dr.id = o.document_revision_id
         JOIN LATERAL (SELECT x.id FROM document_occurrence x WHERE x.document_revision_id = o.document_revision_id ORDER BY x.observed_at, x.id LIMIT 1) first ON true
        WHERE o.tender_id = $1 AND o.observed_at > $2 AND o.observed_at <= $3 ORDER BY o.observed_at, o.id`,
      [tenderId, l.created_at, r.created_at],
    );
    for (const o of occurrences.rows) {
      out.push({ ...base, kind: 'document_occurrence', id: o.id, revisionId: o.document_revision_id, sha256: o.blob_sha256, inInterval: true, repeatOccurrence: o.repeat, inRightScope: rightDocs.has(o.document_revision_id), rightRecognized: !!rightDocs.get(o.document_revision_id)?.recognition_run_id });
    }
    const mail = await db.query<{ message_id: string }>(
      `SELECT l.message_id FROM mail_message_tender l WHERE l.tender_id = $1 AND l.status = 'linked' AND l.linked_at > $2 AND l.linked_at <= $3 ORDER BY l.linked_at, l.id`,
      [tenderId, l.created_at, r.created_at],
    );
    for (const m of mail.rows) {
      const unit = rightMail.get(m.message_id);
      out.push({ ...base, kind: 'mail_message', id: m.message_id, revisionId: unit?.mail_message_revision_id ?? null, sha256: unit?.raw_blob_sha256 ?? null, inInterval: true, inRightScope: !!unit, rightRecognized: !!unit });
    }
  }
  return out;
};

// ---------------------------------------------------------------- Создание

const COLUMNS = `c.id, c.tender_id, c.left_release_id, c.right_release_id, c.method_version, c.status, c.failure_reason, c.calculation_comparison_id, c.summary,
  c.result_sha256, c.requested_by, u.display_name AS requested_by_name, c.created_at, c.finished_at`;

export const getReleaseComparison = async (db: Queryable, id: string): Promise<IReleaseComparisonRow | null> =>
  (await db.query<IReleaseComparisonRow>(`SELECT ${COLUMNS} FROM release_comparison c JOIN app_user u ON u.id = c.requested_by WHERE c.id = $1`, [id])).rows[0] ?? null;

export const listReleaseComparisons = async (db: Queryable, tenderId: string, limit = 50): Promise<IReleaseComparisonRow[]> =>
  (await db.query<IReleaseComparisonRow>(`SELECT ${COLUMNS} FROM release_comparison c JOIN app_user u ON u.id = c.requested_by WHERE c.tender_id = $1 ORDER BY c.created_at DESC, c.id LIMIT $2`, [tenderId, limit])).rows;

export interface ICreateReleaseComparison {
  tenderId: string;
  left: IReleaseRow;
  right: IReleaseRow;
  leftManifest: ManifestDecisions;
  rightManifest: ManifestDecisions;
  userId: string;
}

// Сравнение расчёта: действующее сравнение этой пары ревизий (закреплённое сопоставление — текущее) берётся повторно —
// причины изменений единиц принадлежат ему; иначе создаётся новое (этап 10).
const calculationOf = async (db: Queryable, d: ICreateReleaseComparison, leftRevisionId: string, rightRevisionId: string): Promise<CalculationState> => {
  if (leftRevisionId === rightRevisionId) return { state: 'same_revision', revisionId: leftRevisionId };
  const existing = (
    await db.query<{ id: string; result_sha256: string }>(
      `SELECT id, result_sha256 FROM calculation_comparison
        WHERE left_revision_id = $1 AND right_revision_id = $2 AND status = 'ready' AND lineage_seq = lineage_pair_seq($1, $2)
        ORDER BY created_at DESC, id LIMIT 1`,
      [leftRevisionId, rightRevisionId],
    )
  ).rows[0];
  if (existing) return { state: 'compared', comparisonId: existing.id, resultSha256: existing.result_sha256 };
  const [left, right] = [await loadEconomicsRevision(db, leftRevisionId), await loadEconomicsRevision(db, rightRevisionId)];
  const created = await createComparison(db, { tenderId: d.tenderId, stageId: d.right.stage_id, left: left!, right: right!, userId: d.userId });
  const c = created.comparison;
  return c.status === 'ready' ? { state: 'compared', comparisonId: c.id, resultSha256: c.result_sha256! } : { state: 'failed', comparisonId: c.id, reason: c.failure_reason ?? 'сравнение расчёта не построено' };
};

export const createReleaseComparison = async (db: Queryable, d: ICreateReleaseComparison): Promise<IReleaseComparisonRow> => {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['release.compare', `${d.left.id}>${d.right.id}`]);
  const id = (
    await db.query<{ id: string }>(
      'INSERT INTO release_comparison (tender_id, left_release_id, right_release_id, method_version, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [d.tenderId, d.left.id, d.right.id, RELEASE_COMPARE_METHOD, d.userId],
    )
  ).rows[0]!.id;
  const [lc, rc] = [await pinnedCandidate(db, d.left.candidate_id), await pinnedCandidate(db, d.right.candidate_id)];
  const [left, right] = [await loadReleaseSnapshot(db, d.left, d.leftManifest), await loadReleaseSnapshot(db, d.right, d.rightManifest)];
  const [leftRows, rightRows] = [await scopeRows(db, lc.evidence_scope_id), await scopeRows(db, rc.evidence_scope_id)];
  const calculation = await calculationOf(db, d, left.calculationRevisionId, right.calculationRevisionId);
  const result = compareReleaseSnapshots(left, right, await receivedInputs(db, d.tenderId, lc, rc, leftRows, rightRows), calculation);
  if (result.items.length > 0) {
    await db.query(
      `INSERT INTO release_comparison_item (comparison_id, ordinal, section, change, subject_type, item_key, left_ref, right_ref, left_sha256, right_sha256, detail)
       SELECT $1, x.ordinal, x.section, x.change, x.subject_type, x.item_key, x.left_ref, x.right_ref, x.left_sha256, x.right_sha256, x.detail
         FROM jsonb_to_recordset($2::jsonb) AS x(ordinal int, section text, change text, subject_type text, item_key text, left_ref uuid, right_ref uuid,
                                                 left_sha256 text, right_sha256 text, detail jsonb)`,
      [
        id,
        JSON.stringify(
          result.items.map((i: IComparisonItem, n: number) => ({
            ordinal: n + 1,
            section: i.section,
            change: i.change,
            subject_type: i.subjectType,
            item_key: i.key,
            left_ref: i.leftRef,
            right_ref: i.rightRef,
            left_sha256: i.leftSha256,
            right_sha256: i.rightSha256,
            detail: i.detail,
          })),
        ),
      ],
    );
  }
  const summary: IReleaseComparisonSummary = {
    sections: result.sections,
    calculation: {
      state: calculation.state,
      leftRevisionId: left.calculationRevisionId,
      rightRevisionId: right.calculationRevisionId,
      comparisonId: calculation.state === 'same_revision' ? null : calculation.comparisonId,
      resultSha256: calculation.state === 'compared' ? calculation.resultSha256 : null,
      reason: calculation.state === 'failed' ? calculation.reason : null,
    },
    interval: { from: lc.created_at.toISOString(), to: rc.created_at.toISOString(), empty: rc.created_at <= lc.created_at },
    unrecognizedRight: right.sources.filter((u) => u.unitType === 'document_recognition' && u.recognitionRunId === null).length,
  };
  await db.query(
    "UPDATE release_comparison SET status = 'ready', summary = $2::jsonb, result_sha256 = $3, calculation_comparison_id = $4, finished_at = now() WHERE id = $1",
    [id, JSON.stringify(summary), result.resultSha256, summary.calculation.comparisonId],
  );
  return (await getReleaseComparison(db, id))!;
};

// ---------------------------------------------------------------- Выводы и причины

export const getReleaseComparisonItem = async (db: Queryable, id: string): Promise<IReleaseComparisonItemRow | null> =>
  (await db.query<IReleaseComparisonItemRow>('SELECT * FROM release_comparison_item WHERE id = $1', [id])).rows[0] ?? null;

export const releaseComparisonItems = async (db: Queryable, comparisonId: string, o: { section: CompareSection | null; after: number; limit: number }): Promise<IReleaseComparisonItemRow[]> =>
  (
    await db.query<IReleaseComparisonItemRow>(
      'SELECT * FROM release_comparison_item WHERE comparison_id = $1 AND ($2::text IS NULL OR section = $2) AND ordinal > $3 ORDER BY ordinal LIMIT $4',
      [comparisonId, o.section, o.after, o.limit],
    )
  ).rows;

const REASON_SELECT = `SELECT e.id, e.item_id, e.comparison_id, e.version, e.reason_kind, e.reason_status, e.rationale, e.actor_user_id, u.display_name AS actor_name, e.created_at,
         coalesce((SELECT array_agg(b.fragment_id ORDER BY b.fragment_id) FROM release_comparison_reason_basis b WHERE b.reason_id = e.id AND b.fragment_id IS NOT NULL), '{}') AS fragment_ids,
         coalesce((SELECT array_agg(b.decision_id ORDER BY b.decision_id) FROM release_comparison_reason_basis b WHERE b.reason_id = e.id AND b.decision_id IS NOT NULL), '{}') AS decision_ids
    FROM release_comparison_reason e JOIN app_user u ON u.id = e.actor_user_id`;

// Действующая (последняя) версия причины по выводам.
export const currentReleaseReasons = async (db: Queryable, itemIds: readonly string[]): Promise<Map<string, IReleaseReasonRow>> => {
  if (itemIds.length === 0) return new Map();
  const r = await db.query<IReleaseReasonRow>(
    `${REASON_SELECT} WHERE e.item_id = ANY($1::uuid[]) AND e.version = (SELECT max(x.version) FROM release_comparison_reason x WHERE x.item_id = e.item_id)`,
    [[...itemIds]],
  );
  return new Map(r.rows.map((x) => [x.item_id, { ...x, version: Number(x.version) }]));
};

export const releaseReasonHistory = async (db: Queryable, itemId: string): Promise<IReleaseReasonRow[]> =>
  (await db.query<IReleaseReasonRow>(`${REASON_SELECT} WHERE e.item_id = $1 ORDER BY e.version DESC`, [itemId])).rows.map((x) => ({ ...x, version: Number(x.version) }));

export const releaseReasonVersion = async (db: Queryable, itemId: string): Promise<number> =>
  Number((await db.query<{ v: number }>('SELECT coalesce(max(version), 0) AS v FROM release_comparison_reason WHERE item_id = $1', [itemId])).rows[0]!.v);

// Число выводов по статусу действующей причины (без версии — «не установлена»).
export const releaseReasonCounts = async (db: Queryable, comparisonId: string): Promise<{ unknown: number; hypothesis: number; confirmed: number }> => {
  const r = await db.query<{ status: 'unknown' | 'hypothesis' | 'confirmed'; n: number }>(
    `SELECT coalesce(e.reason_status, 'unknown') AS status, count(*)::int AS n
       FROM release_comparison_item i
       LEFT JOIN release_comparison_reason e ON e.item_id = i.id AND e.version = (SELECT max(x.version) FROM release_comparison_reason x WHERE x.item_id = i.id)
      WHERE i.comparison_id = $1 GROUP BY 1`,
    [comparisonId],
  );
  const out = { unknown: 0, hypothesis: 0, confirmed: 0 };
  for (const x of r.rows) out[x.status] = x.n;
  return out;
};

export interface IReleaseReasonInput {
  tenderId: string;
  comparisonId: string;
  itemId: string;
  version: number;
  reasonKind: IReleaseReasonRow['reason_kind'];
  reasonStatus: IReleaseReasonRow['reason_status'];
  rationale: string | null;
  fragmentIds: readonly string[];
  decisionIds: readonly string[];
  userId: string;
}

export const appendReleaseReason = async (db: Queryable, i: IReleaseReasonInput): Promise<string> => {
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO release_comparison_reason (tender_id, comparison_id, item_id, version, reason_kind, reason_status, rationale, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [i.tenderId, i.comparisonId, i.itemId, i.version, i.reasonKind, i.reasonStatus, i.rationale, i.userId],
    )
  ).rows[0]!.id;
  for (const f of [...new Set(i.fragmentIds)]) {
    await db.query("INSERT INTO release_comparison_reason_basis (reason_id, tender_id, basis_type, fragment_id) VALUES ($1, $2, 'fragment', $3)", [id, i.tenderId, f]);
  }
  for (const d of [...new Set(i.decisionIds)]) {
    await db.query("INSERT INTO release_comparison_reason_basis (reason_id, tender_id, basis_type, decision_id) VALUES ($1, $2, 'decision', $3)", [id, i.tenderId, d]);
  }
  return id;
};
