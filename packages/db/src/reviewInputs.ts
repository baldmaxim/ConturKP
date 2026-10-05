// Вход программных проверок этапа 09 (docs/architecture/09-review-checks-design.md §1, §4): всё читается из закреплённых
// при запуске объектов — снимка области, реестра, ревизии расчёта, приоритета. Проверки — правило, а не пользователь:
// вход полный, показ результата ограничивается правами смотрящего (замыкание закрытости, R08-02).
import {
  calcObjectKey,
  FACT_RULES_VERSION,
  hasPdUncertainty,
  sourceKindOf,
  type ICalcObjectText,
  type IBasisFragment,
  type ICoverageObject,
  type IRequirementParameter,
  type IReviewFact,
  type IReviewFragment,
  type IReviewInput,
  type IReviewPosition,
  type IReviewQuestion,
  type IReviewRequirement,
  type IReviewUnit,
  type SourceKind,
} from '@kontur/core';
import { registryCompleteness } from './completeness.ts';
import { scopeFactGraphFull } from './facts.ts';
import type { Queryable } from './pool.ts';
import { listRequirements } from './requirements.ts';

export interface IFragmentSource {
  fragmentId: string;
  origin: string;
  documentRevisionId: string | null;
  sourceKind: SourceKind | null;
}

// Вид источника фрагментов: происхождение, вид документа и принадлежность договору (D-029 В-09-1).
export const fragmentSources = async (db: Queryable, fragmentIds: readonly string[]): Promise<Map<string, IFragmentSource>> => {
  if (fragmentIds.length === 0) return new Map();
  const r = await db.query<{ id: string; origin: string; document_revision_id: string | null; doc_type: string | null; contract_document: boolean }>(
    `SELECT f.id, f.origin, f.document_revision_id, d.doc_type, (d.contract_id IS NOT NULL) AS contract_document
       FROM evidence_fragment f
       LEFT JOIN document_revision dr ON dr.id = f.document_revision_id
       LEFT JOIN document d ON d.id = dr.document_id
      WHERE f.id = ANY($1::uuid[])`,
    [[...new Set(fragmentIds)]],
  );
  return new Map(
    r.rows.map((x) => [
      x.id,
      { fragmentId: x.id, origin: x.origin, documentRevisionId: x.document_revision_id, sourceKind: sourceKindOf({ origin: x.origin, docType: x.doc_type, contractDocument: x.contract_document }) },
    ]),
  );
};

const units = async (db: Queryable, scopeId: string): Promise<IReviewUnit[]> =>
  (
    await db.query<{
      scope_item_id: string;
      unit_type: string;
      label: string;
      recognition_run_id: string | null;
      run_status: string | null;
      pages_total: number | null;
      pages_recognized: number | null;
      pages_failed: number;
      fragments: number;
    }>(
      `SELECT i.id AS scope_item_id, i.unit_type,
              coalesce(d.title || ' (ред. ' || dr.revision_seq || ')', i.unit_type) AS label,
              i.recognition_run_id, r.status AS run_status, r.pages_total, r.pages_recognized,
              (SELECT count(*) FROM recognition_page p WHERE p.run_id = r.id AND p.status IN ('missing', 'failed'))::int AS pages_failed,
              (SELECT count(*) FROM evidence_fragment f
                WHERE f.source_unit_id = coalesce(i.recognition_run_id, i.mail_message_revision_id, i.transcript_revision_id, i.qa_item_revision_id))::int AS fragments
         FROM evidence_scope_item i
         LEFT JOIN document_revision dr ON dr.id = i.document_revision_id
         LEFT JOIN document d ON d.id = dr.document_id
         LEFT JOIN recognition_run r ON r.id = i.recognition_run_id
        WHERE i.scope_id = $1
        ORDER BY i.unit_type, label, i.id`,
      [scopeId],
    )
  ).rows.map((u) => ({
    scopeItemId: u.scope_item_id,
    unitType: u.unit_type,
    label: u.label,
    technicalStatus: u.unit_type === 'document_recognition' && !u.recognition_run_id ? 'not_recognized' : u.fragments === 0 ? 'no_fragments' : 'ok',
    runStatus: u.run_status,
    pagesTotal: u.pages_total,
    pagesRecognized: u.pages_recognized,
    pagesFailed: u.pages_failed,
  }));

// Элементы импорта этапа (и каналов тендера) без исхода: ожидают или отклонены без решения — источник недоступен (I18).
const importsPending = async (db: Queryable, tenderId: string, stageId: string): Promise<number> =>
  (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM import_item i JOIN import_batch b ON b.id = i.batch_id
        WHERE i.tender_id = $1 AND (b.stage_id = $2 OR b.stage_id IS NULL)
          AND (i.status = 'pending' OR (i.status IN ('rejected', 'skipped_partial') AND i.resolution = 'none'))`,
      [tenderId, stageId],
    )
  ).rows[0]!.n;

interface ILinkRow {
  revision_id: string;
  fragment_id: string;
  role: string;
}

const requirementsOf = async (db: Queryable, registryId: string): Promise<{ requirements: IReviewRequirement[]; sources: Map<string, IFragmentSource> }> => {
  const rows = (await listRequirements(db, registryId)).filter((r) => r.status === 'confirmed');
  if (rows.length === 0) return { requirements: [], sources: new Map() };
  const revisionIds = rows.map((r) => r.current_revision_id);
  const links = (
    await db.query<ILinkRow>(
      `SELECT requirement_revision_id AS revision_id, fragment_id, role FROM evidence_link
        WHERE requirement_revision_id = ANY($1::uuid[]) AND role IN ('supports', 'contradicts') ORDER BY created_at, id`,
      [revisionIds],
    )
  ).rows;
  const sources = await fragmentSources(db, links.map((l) => l.fragment_id));
  const coverage = (
    await db.query<{ id: string; revision_id: string; state: string; reason: string | null; unit_mismatch_reason: string | null }>(
      `SELECT DISTINCT ON (c.requirement_revision_id) c.id, c.requirement_revision_id AS revision_id, c.state, c.reason, c.unit_mismatch_reason
         FROM requirement_coverage c WHERE c.requirement_revision_id = ANY($1::uuid[])
        ORDER BY c.requirement_revision_id, c.seq DESC`,
      [revisionIds],
    )
  ).rows;
  const objects = coverage.length
    ? (
        await db.query<{ coverage_id: string; object_type: ICoverageObject['type']; calculation_revision_id: string | null; external_position_id: string | null; external_item_id: string | null; match: ICoverageObject['match']; unit_status: ICoverageObject['unitStatus'] }>(
          `SELECT coverage_id, object_type, calculation_revision_id, external_position_id, external_item_id, match, unit_status
             FROM requirement_coverage_object WHERE coverage_id = ANY($1::uuid[]) ORDER BY created_at, id`,
          [coverage.map((c) => c.id)],
        )
      ).rows
    : [];
  const covered = (
    await db.query<{ requirement_id: string }>(
      `SELECT a.requirement_id FROM assumption a JOIN assumption_revision v ON v.id = a.current_revision_id
        WHERE a.requirement_id = ANY($1::uuid[]) AND v.status IN ('open', 'confirmed')
       UNION SELECT q.requirement_id FROM customer_question q WHERE q.requirement_id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    )
  ).rows;
  const withRecord = new Set(covered.map((c) => c.requirement_id));
  const basis = (revisionId: string, role: string): IBasisFragment[] =>
    links
      .filter((l) => l.revision_id === revisionId && l.role === role)
      .map((l) => ({ fragmentId: l.fragment_id, documentRevisionId: sources.get(l.fragment_id)?.documentRevisionId ?? null, sourceKind: sources.get(l.fragment_id)?.sourceKind ?? null }));
  const requirements = rows.map((r): IReviewRequirement => {
    const c = coverage.find((x) => x.revision_id === r.current_revision_id) ?? null;
    const supports = basis(r.current_revision_id, 'supports');
    return {
      requirementId: r.id,
      revisionId: r.current_revision_id,
      code: r.code,
      parameters: r.parameters as IRequirementParameter[],
      supports,
      contradicts: basis(r.current_revision_id, 'contradicts'),
      fromContract: supports.some((s) => s.sourceKind === 'contract'),
      conflicts: r.conflicts.map((x) => ({ requirementId: x.requirementId, parameter: x.parameter })),
      conflictNote: r.conflict_note,
      coverage: c
        ? {
            id: c.id,
            state: c.state,
            reason: c.reason,
            unitMismatchReason: c.unit_mismatch_reason,
            objects: objects
              .filter((o) => o.coverage_id === c.id)
              .map((o) => ({
                type: o.object_type,
                calculationRevisionId: o.calculation_revision_id,
                externalPositionId: o.external_position_id,
                externalItemId: o.external_item_id,
                match: o.match,
                unitStatus: o.unit_status,
              })),
          }
        : null,
      hasAssumptionOrQuestion: withRecord.has(r.id),
    };
  });
  return { requirements, sources };
};

// Тексты строк и позиций объектов покрытия (любых ревизий расчёта, на которые ссылаются оценки).
const calcObjectTexts = async (db: Queryable, requirements: readonly IReviewRequirement[]): Promise<Map<string, ICalcObjectText>> => {
  const objs = requirements.flatMap((r) => r.coverage?.objects ?? []).filter((o) => o.type === 'calculation_revision' && o.calculationRevisionId && o.externalPositionId);
  if (objs.length === 0) return new Map();
  const r = await db.query<{
    calc: string;
    pos: string;
    item: string | null;
    work_name: string | null;
    position_name: string | null;
    p_unit: string | null;
    volume: string | null;
    found_position: boolean;
    description: string | null;
    l_work: string | null;
    material_name: string | null;
    l_unit: string | null;
    quantity: string | null;
  }>(
    `SELECT o.calc, o.pos, o.item, p.work_name, p.position_name, p.unit_code AS p_unit, coalesce(p.manual_volume, p.volume)::text AS volume,
            (p.id IS NOT NULL) AS found_position, l.description, l.work_name AS l_work, l.material_name, l.unit_code AS l_unit, l.quantity::text AS quantity
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS o(calc, pos, item)
       JOIN calculation_revision rv ON rv.id = o.calc
       LEFT JOIN calculation_position p ON p.content_id = rv.content_id AND p.external_position_id = o.pos
       LEFT JOIN calculation_line l ON l.content_id = rv.content_id AND l.external_position_id = o.pos AND l.external_item_id = o.item`,
    [objs.map((o) => o.calculationRevisionId), objs.map((o) => o.externalPositionId), objs.map((o) => o.externalItemId)],
  );
  const out = new Map<string, ICalcObjectText>();
  for (const x of r.rows) {
    if (!x.found_position || (x.item && x.description === null && x.l_work === null && x.material_name === null && x.l_unit === null)) continue;
    const num = (v: string | null): number | null => (v === null ? null : Number(v));
    out.set(
      calcObjectKey(x.calc, x.pos, x.item),
      x.item
        ? { texts: [x.description, x.l_work, x.material_name, x.work_name, x.position_name].filter((t): t is string => !!t), unit: x.l_unit, quantity: num(x.quantity) }
        : { texts: [x.work_name, x.position_name].filter((t): t is string => !!t), unit: x.p_unit, quantity: num(x.volume) },
    );
  }
  return out;
};

const positionsOf = async (db: Queryable, calcRevisionId: string | null): Promise<IReviewPosition[]> =>
  calcRevisionId
    ? (
        await db.query<{ external_position_id: string; name: string; unit_code: string | null; section_number: string | null; volume: string | null; total: string | null; is_section: boolean }>(
          `SELECT p.external_position_id, coalesce(p.work_name, p.position_name, '') AS name, p.unit_code, p.section_number,
                  coalesce(p.manual_volume, p.volume)::text AS volume, coalesce(p.commercial_total, p.base_total)::text AS total, coalesce(p.is_section, false) AS is_section
             FROM calculation_revision r JOIN calculation_position p ON p.content_id = r.content_id
            WHERE r.id = $1 ORDER BY p.position_number NULLS LAST, p.external_position_id`,
          [calcRevisionId],
        )
      ).rows.map((p) => ({
        externalPositionId: p.external_position_id,
        name: p.name,
        unit: p.unit_code,
        section: p.section_number,
        volume: p.volume === null ? null : Number(p.volume),
        total: p.total === null ? null : Number(p.total),
        isSection: p.is_section,
      }))
    : [];

// Текст документов снимка (C08): во вход — только фрагменты с фразами неопределённости ПД (с отметкой связанного
// действующего допущения) и общее число фрагментов: вход закрепляется снимком, полный текст документов в нём не нужен.
const documentFragments = async (db: Queryable, scopeId: string): Promise<{ fragments: IReviewFragment[]; total: number }> => {
  const rows = (
    await db.query<{ id: string; text: string; origin: string; has_assumption: boolean }>(
      `SELECT f.id, f.text, f.origin,
              EXISTS (SELECT 1 FROM evidence_link l JOIN assumption_revision v ON v.id = l.assumption_revision_id
                        JOIN assumption a ON a.current_revision_id = v.id
                       WHERE l.fragment_id = f.id AND v.status IN ('open', 'confirmed')) AS has_assumption
         FROM evidence_scope_item i JOIN evidence_fragment f ON f.source_unit_id = i.recognition_run_id
        WHERE i.scope_id = $1 AND f.origin IN ('document_text', 'recognized_text')
        ORDER BY i.id, f.page_index NULLS LAST, f.ordinal NULLS LAST, f.part_index, f.id`,
      [scopeId],
    )
  ).rows;
  return {
    fragments: rows.filter((f) => hasPdUncertainty(f.text)).map((f) => ({ fragmentId: f.id, text: f.text, origin: f.origin, hasAssumption: f.has_assumption })),
    total: rows.length,
  };
};

// Новые редакции документов оснований (A10): прежняя редакция → последняя.
const newerRevisions = async (db: Queryable, revisionIds: readonly string[]): Promise<Map<string, string>> => {
  if (revisionIds.length === 0) return new Map();
  const r = await db.query<{ id: string; newer: string | null }>(
    `SELECT dr.id, (SELECT n.id FROM document_revision n WHERE n.document_id = dr.document_id AND n.revision_seq > dr.revision_seq
                     ORDER BY n.revision_seq DESC LIMIT 1) AS newer
       FROM document_revision dr WHERE dr.id = ANY($1::uuid[])`,
    [[...new Set(revisionIds)]],
  );
  return new Map(r.rows.filter((x) => x.newer).map((x) => [x.id, x.newer!]));
};

// Вопросы без ответа (C10): отправленные вопросы заказчику этапа и открытые вопросы–ответы снимка.
const unansweredQuestions = async (db: Queryable, stageId: string, scopeId: string): Promise<IReviewQuestion[]> => {
  const cq = (
    await db.query<{ id: string; asked_at: Date | null }>("SELECT id, asked_at FROM customer_question WHERE stage_id = $1 AND status = 'sent' ORDER BY asked_at, id", [stageId])
  ).rows.map((q): IReviewQuestion => ({ kind: 'customer_question', id: q.id, revisionId: null, fragmentIds: [], askedAt: q.asked_at ? q.asked_at.toISOString().slice(0, 10) : null }));
  const qa = (
    await db.query<{ item_id: string; revision_id: string; asked_at: Date | null; fragment_ids: string[] }>(
      `SELECT r.item_id, r.id AS revision_id, r.asked_at,
              array(SELECT f.id FROM evidence_fragment f WHERE f.source_unit_id = r.id AND f.origin = 'qa_question' ORDER BY f.ordinal NULLS LAST, f.id) AS fragment_ids
         FROM evidence_scope_item i JOIN qa_item_revision r ON r.id = i.qa_item_revision_id
        WHERE i.scope_id = $1 AND r.status = 'open' ORDER BY r.item_id`,
      [scopeId],
    )
  ).rows.map((q): IReviewQuestion => ({ kind: 'qa_item', id: q.item_id, revisionId: q.revision_id, fragmentIds: q.fragment_ids, askedAt: q.asked_at ? q.asked_at.toISOString().slice(0, 10) : null }));
  return [...cq, ...qa];
};

export interface IReviewRunInputs {
  input: IReviewInput;
  // Единицы распознавания снимка без извлечения фактов текущих правил: охват C09/C11 неполон.
  unitsWithoutFacts: number;
}

export const loadReviewInput = async (
  db: Queryable,
  run: { tender_id: string; stage_id: string; evidence_scope_id: string; registry_id: string | null; calculation_revision_id: string | null; priority_kinds: string[] },
): Promise<IReviewRunInputs> => {
  const scopeUnits = await units(db, run.evidence_scope_id);
  const recognitionUnits = (
    await db.query<{ id: string }>('SELECT recognition_run_id AS id FROM evidence_scope_item WHERE scope_id = $1 AND recognition_run_id IS NOT NULL', [run.evidence_scope_id])
  ).rows.map((x) => x.id);
  const graph = await scopeFactGraphFull(db, recognitionUnits);
  const factSources = await fragmentSources(db, graph.facts.flatMap((f) => f.fragmentIds.slice(0, 1)));
  const facts: IReviewFact[] = graph.facts.map((f) => ({
    factId: f.factId,
    factType: f.factType,
    status: f.status,
    rawValue: f.rawValue,
    fragmentIds: f.fragmentIds,
    supersededByFactId: f.supersededByFactId,
    sourceKind: factSources.get(f.fragmentIds[0] ?? '')?.sourceKind ?? null,
  }));
  let registry: IReviewInput['registry'] = null;
  let requirements: IReviewRequirement[] = [];
  let sources = new Map<string, IFragmentSource>();
  if (run.registry_id) {
    const counts = await registryCompleteness(db, run.registry_id);
    const pass = await db.query('SELECT 1 FROM requirement_registry_review WHERE registry_id = $1 AND unreviewed_units = 0 LIMIT 1', [run.registry_id]);
    registry = { id: run.registry_id, passCompleted: (pass.rowCount ?? 0) > 0, unreviewed: counts.unreviewed_units, total: counts.total_units };
    ({ requirements, sources } = await requirementsOf(db, run.registry_id));
  }
  const docText = await documentFragments(db, run.evidence_scope_id);
  const basisRevisions = [...sources.values()].map((s) => s.documentRevisionId).filter((x): x is string => !!x);
  const input: IReviewInput = {
    priority: run.priority_kinds as SourceKind[],
    units: scopeUnits,
    importsPending: await importsPending(db, run.tender_id, run.stage_id),
    registry,
    calculationRevisionId: run.calculation_revision_id,
    calcObjects: await calcObjectTexts(db, requirements),
    positions: await positionsOf(db, run.calculation_revision_id),
    requirements,
    fragments: docText.fragments,
    fragmentsTotal: docText.total,
    facts,
    factConflicts: graph.remarks.filter((r) => r.kind === 'value_conflict').map((r) => ({ factIds: r.factIds })),
    newerRevisions: await newerRevisions(db, basisRevisions),
    questions: await unansweredQuestions(db, run.stage_id, run.evidence_scope_id),
    factsPendingUnits: 0,
  };
  // Ожидают извлечения фактов текущих правил: предпочтительный завершённый прогон документа (не вложения письма) без
  // прогона извлечения. Пока извлечения нет, конфликты фактов и перекрытые основания проверить нельзя (I18).
  const pending = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM recognition_run rr
       JOIN document_revision v ON v.id = rr.document_revision_id JOIN document d ON d.id = v.document_id
      WHERE rr.id = ANY($1::uuid[]) AND rr.status IN ('complete', 'partial') AND d.mail_attachment_id IS NULL
        AND recognition_preferred_run(rr.document_revision_id) = rr.id
        AND NOT EXISTS (SELECT 1 FROM fact_extraction_run x WHERE x.recognition_run_id = rr.id AND x.rules_version = $2)`,
    [recognitionUnits, FACT_RULES_VERSION],
  );
  input.factsPendingUnits = pending.rows[0]!.n;
  return { input, unitsWithoutFacts: pending.rows[0]!.n };
};
