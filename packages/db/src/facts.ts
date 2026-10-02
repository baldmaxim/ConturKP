// Граф фактов D-018 (D-028; docs/architecture/08a-fact-graph-design.md): извлечение правилами из прогона распознавания,
// пересчёт графа владельца (договор или тендер) с сохранением состояния и замечаний, граф области ответа и решения
// человека. Состояние — функция графа ядра (`computeFactGraph`); здесь только выборка входа и запись результата.
import {
  classifyDocument,
  computeFactGraph,
  documentKindOf,
  extractDocumentFacts,
  FACT_RULES_VERSION,
  type FactDecisionKind,
  type FactType,
  type IFactGraph,
  type IFactSpan,
  type IGraphDecision,
  type IGraphDocument,
  type IGraphFact,
} from '@kontur/core';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';

export const FACT_EXTRACT_JOB_KIND = 'fact.extract';
export const FACT_EXTRACT_PRIORITY = 30;
// Происхождения основания факта (I06, D-018); остальные фрагменты правилам не передаются.
const DOCUMENTARY = ['document_text', 'recognized_text', 'email_body', 'attachment_text'];
// Строка таблицы — фрагмент с якорем строки листа, CSV или таблицы DOCX (05a).
const TABLE_LOCATORS = ['xlsx_cells', 'csv_rows', 'docx_table_row'];

export interface IFactOwner {
  tenderId: string | null;
  contractId: string | null;
}
export const ownerKeyOf = (o: IFactOwner): string => (o.contractId ? `contract:${o.contractId}` : `tender:${o.tenderId}`);
const ownerColumn = (o: IFactOwner): { col: 'tender_id' | 'contract_id'; id: string } => (o.contractId ? { col: 'contract_id', id: o.contractId } : { col: 'tender_id', id: o.tenderId! });

// ---------------------------------------------------------------- Постановка и извлечение

// Предпочтительные завершённые прогоны распознавания документов тендера и договора без извлечения текущей версии правил.
export const runsAwaitingExtraction = async (db: Queryable, limit = 100): Promise<{ id: string; tender_id: string | null }[]> =>
  (
    await db.query<{ id: string; tender_id: string | null }>(
      `SELECT rr.id, d.tender_id
         FROM recognition_run rr
         JOIN document_revision v ON v.id = rr.document_revision_id
         JOIN document d ON d.id = v.document_id
        WHERE rr.status IN ('complete', 'partial') AND d.mail_attachment_id IS NULL
          AND recognition_preferred_run(rr.document_revision_id) = rr.id
          AND NOT EXISTS (SELECT 1 FROM fact_extraction_run x WHERE x.recognition_run_id = rr.id AND x.rules_version = $1)
        ORDER BY rr.created_at, rr.id
        LIMIT $2`,
      [FACT_RULES_VERSION, limit],
    )
  ).rows;

export const enqueueFactExtraction = (db: Queryable, runId: string, tenderId: string | null) =>
  enqueueJob(db, {
    kind: FACT_EXTRACT_JOB_KIND,
    dedupeKey: `fact:${runId}:${FACT_RULES_VERSION}`,
    payload: { runId },
    resourceClass: 'default',
    priority: FACT_EXTRACT_PRIORITY,
    maxAttempts: 3,
    tenderId,
  });

// Извлечение по прогону распознавания: классификация документа, факты, основания — одной транзакцией; повтор —
// тот же прогон извлечения. Возвращает владельца, граф которого нужно пересчитать.
export const extractRunFacts = async (db: Queryable, runId: string): Promise<{ created: boolean; owner: IFactOwner | null; facts: number }> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('fact_extract'), hashtext($1::text))", [runId]);
  const done = await db.query('SELECT 1 FROM fact_extraction_run WHERE recognition_run_id = $1 AND rules_version = $2', [runId, FACT_RULES_VERSION]);
  if (done.rows[0]) return { created: false, owner: null, facts: 0 };
  const run = (
    await db.query<{ status: string; document_revision_id: string; document_id: string; tender_id: string | null; contract_id: string | null; mail_attachment_id: string | null; title: string }>(
      `SELECT rr.status, rr.document_revision_id, v.document_id, d.tender_id, d.contract_id, d.mail_attachment_id, d.title
         FROM recognition_run rr JOIN document_revision v ON v.id = rr.document_revision_id JOIN document d ON d.id = v.document_id
        WHERE rr.id = $1`,
      [runId],
    )
  ).rows[0];
  if (!run || run.mail_attachment_id || !['complete', 'partial'].includes(run.status)) return { created: false, owner: null, facts: 0 };
  const fragments = (
    await db.query<{ id: string; text: string; origin: string; page_index: number | null; locator_kind: string | null }>(
      `SELECT id, text, origin, page_index, locator ->> 'kind' AS locator_kind FROM evidence_fragment
        WHERE run_id = $1 ORDER BY page_index NULLS LAST, ordinal NULLS LAST, part_index, id`,
      [runId],
    )
  ).rows;
  const documentary = fragments.filter((f) => DOCUMENTARY.includes(f.origin));
  const firstPage = documentary.filter((f) => f.page_index === (documentary[0]?.page_index ?? null)).map((f) => f.text);
  const cls = classifyDocument({ firstPage, documentTitle: run.title });
  const spans: IFactSpan[] = documentary.map((f) => ({ fragmentId: f.id, text: f.text, tableRow: TABLE_LOCATORS.includes(f.locator_kind ?? '') }));
  const facts = extractDocumentFacts(spans);
  const byType: Record<string, number> = {};
  for (const f of facts) byType[f.factType] = (byType[f.factType] ?? 0) + 1;
  const x = await db.query<{ id: string }>(
    `INSERT INTO fact_extraction_run (recognition_run_id, document_revision_id, document_id, tender_id, contract_id, rules_version, document_kind, document_number,
                                      document_date, parent_number, parent_number_key, parent_date, classify_method, fragments_scanned, facts_found, coverage)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12::date, $13, $14, $15, $16) RETURNING id`,
    [
      runId, run.document_revision_id, run.document_id, run.tender_id, run.contract_id, FACT_RULES_VERSION, cls.kind, cls.number.slice(0, 200),
      cls.documentDate, cls.parentRef?.number.slice(0, 200) ?? null, cls.parentRef?.numberKey.slice(0, 200) ?? null, cls.parentRef?.date ?? null,
      cls.method.slice(0, 60), documentary.length, facts.length,
      JSON.stringify({ fragments: fragments.length, documentary: documentary.length, otherOrigins: fragments.length - documentary.length, byType }),
    ],
  );
  for (const f of facts) {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO evidence_fact (extraction_run_id, fact_type, raw_value, normalized, normalized_key, unit, condition, clause_ref, amends)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [x.rows[0]!.id, f.factType, f.rawValue || f.factType, JSON.stringify(f.normalized), f.normalizedKey, f.unit.slice(0, 20), f.condition, f.clauseRef, f.amends],
    );
    await db.query(
      'INSERT INTO evidence_fact_fragment (evidence_fact_id, fragment_id, ordinal) SELECT $1, u.f, u.n FROM unnest($2::uuid[]) WITH ORDINALITY AS u(f, n)',
      [ins.rows[0]!.id, f.fragmentIds],
    );
  }
  return { created: true, owner: { tenderId: run.tender_id, contractId: run.contract_id }, facts: facts.length };
};

// ---------------------------------------------------------------- Вход графа

interface IExtractionRow {
  id: string;
  recognition_run_id: string;
  document_revision_id: string;
  document_id: string;
  revision_seq: number;
  created_at: Date;
  document_kind: string;
  document_number: string;
  document_date: string | null;
  parent_number: string | null;
  parent_number_key: string | null;
  parent_date: string | null;
  contract_role: 'contract' | 'addendum' | 'appendix' | null;
  main_document_id: string | null;
  tender_id: string | null;
  contract_id: string | null;
  document_title: string;
}

const EXTRACTION_SELECT = `SELECT x.id, x.recognition_run_id, x.document_revision_id, x.document_id, v.revision_seq, x.created_at, x.document_kind,
       x.document_number, to_char(x.document_date, 'YYYY-MM-DD') AS document_date, x.parent_number, x.parent_number_key,
       to_char(x.parent_date, 'YYYY-MM-DD') AS parent_date, d.contract_role, d.main_document_id, x.tender_id, x.contract_id, d.title AS document_title
  FROM fact_extraction_run x
  JOIN document_revision v ON v.id = x.document_revision_id
  JOIN document d ON d.id = x.document_id`;

export interface IEvidenceFactRow {
  id: string;
  extraction_run_id: string;
  fact_type: FactType;
  raw_value: string;
  normalized: Record<string, string | number>;
  normalized_key: string;
  unit: string;
  condition: string;
  clause_ref: string;
  amends: boolean;
  fragment_ids: string[];
}

const factsOfRuns = async (db: Queryable, runIds: readonly string[]): Promise<IEvidenceFactRow[]> =>
  runIds.length === 0
    ? []
    : (
        await db.query<IEvidenceFactRow>(
          `SELECT f.id, f.extraction_run_id, f.fact_type, f.raw_value, f.normalized, f.normalized_key, f.unit, f.condition, f.clause_ref, f.amends,
                  array(SELECT ff.fragment_id FROM evidence_fact_fragment ff WHERE ff.evidence_fact_id = f.id ORDER BY ff.ordinal) AS fragment_ids
             FROM evidence_fact f WHERE f.extraction_run_id = ANY($1::uuid[]) ORDER BY f.id`,
          [[...runIds]],
        )
      ).rows;

interface IDecisionRow {
  id: string;
  fact_id: string;
  other_fact_id: string;
  kind: FactDecisionKind;
}

// По документу — прогон извлечения последней из имеющихся редакций; факты прежних редакций — `retired`.
const graphInput = (runs: readonly IExtractionRow[], facts: readonly IEvidenceFactRow[], decisions: readonly IDecisionRow[]) => {
  const latest = new Map<string, IExtractionRow>();
  for (const r of runs) {
    const cur = latest.get(r.document_id);
    if (!cur || r.revision_seq > cur.revision_seq || (r.revision_seq === cur.revision_seq && r.created_at > cur.created_at)) latest.set(r.document_id, r);
  }
  const chosen = new Set([...latest.values()].map((r) => r.id));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const documents: IGraphDocument[] = [...latest.values()].map((r) => ({
    documentId: r.document_id,
    ownerKey: ownerKeyOf({ tenderId: r.tender_id, contractId: r.contract_id }),
    kind: documentKindOf(r.document_kind),
    number: r.document_number,
    documentDate: r.document_date,
    parentRef: r.parent_number ? { number: r.parent_number, numberKey: r.parent_number_key!, date: r.parent_date } : null,
    explicit: r.contract_role ? { role: r.contract_role, mainDocumentId: r.main_document_id } : null,
  }));
  const graphFacts: IGraphFact[] = facts.map((f) => ({
    factId: f.id,
    documentId: runById.get(f.extraction_run_id)!.document_id,
    factType: f.fact_type,
    normalizedKey: f.normalized_key,
    clauseRef: f.clause_ref,
    amends: f.amends,
    retired: !chosen.has(f.extraction_run_id),
  }));
  const graphDecisions: IGraphDecision[] = decisions.map((d) => ({ decisionId: d.id, factId: d.fact_id, otherFactId: d.other_fact_id, kind: d.kind }));
  return { documents, facts: graphFacts, decisions: graphDecisions, latest, chosen };
};

// ---------------------------------------------------------------- Граф владельца

// Пересчёт графа владельца под advisory-блокировкой: состояние фактов, замечания (новые открываются, исчезнувшие
// закрываются), строка графа. Вызывается в транзакции извлечения и решения человека.
export const recomputeOwnerGraph = async (db: Queryable, owner: IFactOwner): Promise<IFactGraph> => {
  const { col, id } = ownerColumn(owner);
  await db.query("SELECT pg_advisory_xact_lock(hashtext('fact_graph'), hashtext($1::text))", [id]);
  const runs = (await db.query<IExtractionRow>(`${EXTRACTION_SELECT} WHERE x.${col} = $1 AND x.rules_version = $2`, [id, FACT_RULES_VERSION])).rows;
  const facts = await factsOfRuns(db, runs.map((r) => r.id));
  const decisions = (await db.query<IDecisionRow>(`SELECT id, fact_id, other_fact_id, kind FROM fact_decision WHERE ${col} = $1 ORDER BY created_at, id`, [id])).rows;
  const input = graphInput(runs, facts, decisions);
  const graph = computeFactGraph(input);
  const states = [...graph.facts.values()].map((s) => ({
    evidence_fact_id: s.factId,
    status: s.status,
    superseded_reason: s.supersededReason,
    superseded_by_fact_id: s.supersededByFactId,
    valid_from: s.validFrom,
    valid_to: s.validTo,
    decided_by: s.decidedBy,
    decision_id: s.decisionId,
  }));
  if (states.length) {
    await db.query(
      `INSERT INTO fact_state (evidence_fact_id, tender_id, contract_id, status, superseded_reason, superseded_by_fact_id, valid_from, valid_to, decided_by, decision_id, graph_hash)
       SELECT s.evidence_fact_id, $2, $3, s.status, s.superseded_reason, s.superseded_by_fact_id, s.valid_from, s.valid_to, s.decided_by, s.decision_id, $4
         FROM jsonb_to_recordset($1::jsonb) AS s(evidence_fact_id uuid, status text, superseded_reason text, superseded_by_fact_id uuid, valid_from date, valid_to date,
                                                  decided_by text, decision_id uuid)
       ON CONFLICT (evidence_fact_id) DO UPDATE
         SET status = EXCLUDED.status, superseded_reason = EXCLUDED.superseded_reason, superseded_by_fact_id = EXCLUDED.superseded_by_fact_id,
             valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, decided_by = EXCLUDED.decided_by, decision_id = EXCLUDED.decision_id,
             graph_hash = EXCLUDED.graph_hash, computed_at = now(), row_version = fact_state.row_version + 1
       WHERE fact_state.graph_hash IS DISTINCT FROM EXCLUDED.graph_hash`,
      [JSON.stringify(states), owner.contractId ? null : owner.tenderId, owner.contractId, graph.hash],
    );
  }
  const open = (await db.query<{ id: string; remark_key: string }>(`SELECT id, remark_key FROM fact_remark WHERE ${col} = $1 AND status = 'open'`, [id])).rows;
  const keys = new Set(graph.remarks.map((r) => r.key));
  const openKeys = new Set(open.map((r) => r.remark_key));
  for (const r of open.filter((x) => !keys.has(x.remark_key))) {
    await db.query("UPDATE fact_remark SET status = 'resolved', resolved_at = now(), row_version = row_version + 1 WHERE id = $1", [r.id]);
  }
  for (const r of graph.remarks.filter((x) => !openKeys.has(x.key))) {
    await db.query(
      `INSERT INTO fact_remark (tender_id, contract_id, remark_key, kind, fact_ids, document_ids, message) VALUES ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7)`,
      [owner.contractId ? null : owner.tenderId, owner.contractId, r.key, r.kind, r.factIds, r.documentIds, r.message.slice(0, 2000)],
    );
  }
  const pending = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM document d
      WHERE d.${col} = $1
        AND EXISTS (SELECT 1 FROM document_revision v WHERE v.document_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM fact_extraction_run x JOIN document_revision v ON v.id = x.document_revision_id
                         WHERE x.document_id = d.id AND x.rules_version = $2
                           AND v.revision_seq = (SELECT max(v2.revision_seq) FROM document_revision v2 WHERE v2.document_id = d.id))`,
    [id, FACT_RULES_VERSION],
  );
  const byStatus: Record<string, number> = {};
  for (const s of graph.facts.values()) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  const coverage = { documents: input.documents.length, facts: facts.length, byStatus, documentsWithoutCurrentFacts: pending.rows[0]!.n };
  const upd = await db.query(
    `UPDATE fact_graph SET rules_version = $2, graph_hash = $3, relations = $4, coverage = $5, computed_at = now(), row_version = row_version + 1 WHERE ${col} = $1`,
    [id, FACT_RULES_VERSION, graph.hash, JSON.stringify(graph.relations), JSON.stringify(coverage)],
  );
  if ((upd.rowCount ?? 0) === 0) {
    await db.query('INSERT INTO fact_graph (tender_id, contract_id, rules_version, graph_hash, relations, coverage) VALUES ($1, $2, $3, $4, $5, $6)', [
      owner.contractId ? null : owner.tenderId, owner.contractId, FACT_RULES_VERSION, graph.hash, JSON.stringify(graph.relations), JSON.stringify(coverage),
    ]);
  }
  return graph;
};

// ---------------------------------------------------------------- Граф области ответа

export interface IScopeFact {
  factId: string;
  factType: FactType;
  status: 'active' | 'superseded' | 'conflict';
  validFrom: string | null;
  supersededByFactId: string | null;
  fragmentIds: string[];
  documentId: string;
  normalized: Record<string, string | number>;
  rawValue: string;
  clauseRef: string;
}

// Граф по единицам области хода (прогоны распознавания): поздний документ вне области не перекрывает пункт в области
// (I05); решения человека — если оба факта пары в области.
export const scopeFactGraph = async (db: Queryable, allowedUnits: readonly string[]): Promise<IScopeFact[]> => {
  if (allowedUnits.length === 0) return [];
  const runs = (await db.query<IExtractionRow>(`${EXTRACTION_SELECT} WHERE x.recognition_run_id = ANY($1::uuid[]) AND x.rules_version = $2`, [[...allowedUnits], FACT_RULES_VERSION])).rows;
  if (runs.length === 0) return [];
  const facts = await factsOfRuns(db, runs.map((r) => r.id));
  const ids = facts.map((f) => f.id);
  const decisions = ids.length
    ? (await db.query<IDecisionRow>('SELECT id, fact_id, other_fact_id, kind FROM fact_decision WHERE fact_id = ANY($1::uuid[]) AND other_fact_id = ANY($1::uuid[]) ORDER BY created_at, id', [ids])).rows
    : [];
  const input = graphInput(runs, facts, decisions);
  const graph = computeFactGraph(input);
  const runById = new Map(runs.map((r) => [r.id, r]));
  return facts.map((f) => {
    const st = graph.facts.get(f.id)!;
    return {
      factId: f.id,
      factType: f.fact_type,
      status: st.status,
      validFrom: st.validFrom,
      supersededByFactId: st.supersededByFactId,
      fragmentIds: f.fragment_ids,
      documentId: runById.get(f.extraction_run_id)!.document_id,
      normalized: f.normalized,
      rawValue: f.raw_value,
      clauseRef: f.clause_ref,
    };
  });
};

// ---------------------------------------------------------------- Решение человека и просмотр

export const evidenceFactOwner = async (db: Queryable, factId: string): Promise<IFactOwner | null> => {
  const r = await db.query<{ tender_id: string | null; contract_id: string | null }>(
    'SELECT x.tender_id, x.contract_id FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id WHERE f.id = $1',
    [factId],
  );
  return r.rows[0] ? { tenderId: r.rows[0].tender_id, contractId: r.rows[0].contract_id } : null;
};

export const insertFactDecision = async (
  db: Queryable,
  d: { owner: IFactOwner; factId: string; otherFactId: string; kind: FactDecisionKind; reason: string; userId: string },
): Promise<string> =>
  (
    await db.query<{ id: string }>(
      'INSERT INTO fact_decision (tender_id, contract_id, fact_id, other_fact_id, kind, reason, decided_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [d.owner.contractId ? null : d.owner.tenderId, d.owner.contractId, d.factId, d.otherFactId, d.kind, d.reason, d.userId],
    )
  ).rows[0]!.id;

export interface IOwnerGraphView {
  graph: { hash: string; relations: unknown[]; coverage: Record<string, unknown>; computedAt: Date } | null;
  documents: IExtractionRow[];
  facts: (IEvidenceFactRow & {
    document_id: string;
    document_revision_id: string;
    status: string | null;
    superseded_reason: string | null;
    superseded_by_fact_id: string | null;
    valid_from: string | null;
    valid_to: string | null;
    decided_by: string | null;
    decision_id: string | null;
    retired: boolean;
  })[];
  remarks: { id: string; kind: string; fact_ids: string[]; document_ids: string[]; message: string; status: string; opened_at: Date; resolved_at: Date | null }[];
  decisions: { id: string; fact_id: string; other_fact_id: string; kind: string; reason: string; decided_by: string; created_at: Date }[];
}

// Граф владельца для экрана: документы (последние извлечённые редакции), факты с состоянием, замечания, решения.
export const ownerGraphView = async (db: Queryable, owner: IFactOwner): Promise<IOwnerGraphView> => {
  const { col, id } = ownerColumn(owner);
  const g = (await db.query<{ graph_hash: string; relations: unknown[]; coverage: Record<string, unknown>; computed_at: Date }>(`SELECT graph_hash, relations, coverage, computed_at FROM fact_graph WHERE ${col} = $1`, [id])).rows[0];
  const runs = (await db.query<IExtractionRow>(`${EXTRACTION_SELECT} WHERE x.${col} = $1 AND x.rules_version = $2 ORDER BY d.title, v.revision_seq`, [id, FACT_RULES_VERSION])).rows;
  const { latest, chosen } = graphInput(runs, [], []);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const facts = (
    await db.query<IEvidenceFactRow & { status: string | null; superseded_reason: string | null; superseded_by_fact_id: string | null; valid_from: string | null; valid_to: string | null; decided_by: string | null; decision_id: string | null }>(
      `SELECT f.id, f.extraction_run_id, f.fact_type, f.raw_value, f.normalized, f.normalized_key, f.unit, f.condition, f.clause_ref, f.amends,
              array(SELECT ff.fragment_id FROM evidence_fact_fragment ff WHERE ff.evidence_fact_id = f.id ORDER BY ff.ordinal) AS fragment_ids,
              s.status, s.superseded_reason, s.superseded_by_fact_id, to_char(s.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(s.valid_to, 'YYYY-MM-DD') AS valid_to,
              s.decided_by, s.decision_id
         FROM evidence_fact f
         JOIN fact_extraction_run x ON x.id = f.extraction_run_id
         LEFT JOIN fact_state s ON s.evidence_fact_id = f.id
        WHERE x.${col} = $1 AND x.rules_version = $2
        ORDER BY f.fact_type, f.id`,
      [id, FACT_RULES_VERSION],
    )
  ).rows.map((f) => ({
    ...f,
    document_id: runById.get(f.extraction_run_id)!.document_id,
    document_revision_id: runById.get(f.extraction_run_id)!.document_revision_id,
    retired: !chosen.has(f.extraction_run_id),
  }));
  const remarks = (
    await db.query<IOwnerGraphView['remarks'][number]>(
      `SELECT id, kind, fact_ids, document_ids, message, status, opened_at, resolved_at FROM fact_remark WHERE ${col} = $1 ORDER BY status DESC, opened_at DESC, id`,
      [id],
    )
  ).rows;
  const decisions = (
    await db.query<IOwnerGraphView['decisions'][number]>(`SELECT id, fact_id, other_fact_id, kind, reason, decided_by, created_at FROM fact_decision WHERE ${col} = $1 ORDER BY created_at DESC, id`, [id])
  ).rows;
  return {
    graph: g ? { hash: g.graph_hash, relations: g.relations, coverage: g.coverage, computedAt: g.computed_at } : null,
    documents: [...latest.values()],
    facts,
    remarks,
    decisions,
  };
};

// Единицы снимка области (прогоны распознавания) — вход графа прогона анализа по правилам.
export const scopeRecognitionUnits = async (db: Queryable, scopeId: string): Promise<string[]> =>
  (await db.query<{ id: string }>('SELECT recognition_run_id AS id FROM evidence_scope_item WHERE scope_id = $1 AND recognition_run_id IS NOT NULL', [scopeId])).rows.map((r) => r.id);
