// Экономика расчёта (этап 10; проект docs/architecture/10-economics-design.md §2–§7; D-030): отчёт ревизии с
// десятичным пересчётом строк, предложения сопоставления позиций, решения по парам и сравнение двух ревизий. Исходные
// данные ревизий не меняются; результаты пишутся один раз и неизменны (вторая линия — миграция 0026).
import {
  buildRevisionEconomics,
  compareRevisions,
  ComparisonInvariantError,
  COMPARISON_METHOD_VERSION,
  DECOMPOSITION_METHOD,
  ECONOMICS_METHOD_VERSION,
  LINE_TOLERANCE,
  METHOD_DESCRIPTION,
  MoneyArithmeticError,
  planProposals,
  RECONCILIATION_TOLERANCE,
  str,
  strOrNull,
  tenderHubApiComponents,
  type ICommercialComponent,
  type ICompareSide,
  type IComparePosition,
  type IConfirmedPair,
  type ILineageState,
  type ILineInput,
  type IProposalPlan,
  type IRevisionEconomics,
  type SourceIdentity,
} from '@kontur/core';
import { contentTenderIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

// ---------------------------------------------------------------- Загрузка ревизии

export interface IEconomicsRevision {
  id: string;
  tender_id: string;
  stage_id: string;
  seq: number;
  content_id: string;
  external_tender_id: string;
  content_hash: string;
  source_grand_total: string | null;
  usd_rate: string | null;
  eur_rate: string | null;
  cny_rate: string | null;
  observed_at: Date | null;
  source_instance_id: string | null;
  external_version: number | null;
  components: ICommercialComponent[] | null;
  contract_version: string | null;
}

export const loadEconomicsRevision = async (db: Queryable, revisionId: string): Promise<IEconomicsRevision | null> =>
  (
    await db.query<IEconomicsRevision>(
      `SELECT r.id, r.tender_id, r.stage_id, r.seq, r.content_id, r.external_tender_id, c.content_hash,
              c.source_grand_total::text AS source_grand_total, c.usd_rate::text AS usd_rate, c.eur_rate::text AS eur_rate, c.cny_rate::text AS cny_rate,
              k.finished_at AS observed_at, k.source_instance_id, (k.source_observed ->> 'version')::int AS external_version,
              k.consistency -> 'commercialComponents' AS components, k.contract_version
         FROM calculation_revision r JOIN calculation_content c ON c.id = r.content_id JOIN calculation_capture k ON k.id = r.capture_id
        WHERE r.id = $1`,
      [revisionId],
    )
  ).rows[0] ?? null;

const loadPositions = async (db: Queryable, contentId: string): Promise<(IComparePosition & { commercialTotal: string | null })[]> =>
  (
    await db.query<{
      external_position_id: string;
      position_number: string;
      item_no: string | null;
      work_name: string;
      unit_code: string | null;
      is_additional: boolean | null;
      is_section: boolean;
      manual_volume: string | null;
      commercial_total: string | null;
    }>(
      `SELECT external_position_id, position_number::text AS position_number, item_no, work_name, unit_code, is_additional, is_section,
              manual_volume::text AS manual_volume, commercial_total::text AS commercial_total
         FROM calculation_position WHERE content_id = $1 ORDER BY position_number, external_position_id`,
      [contentId],
    )
  ).rows.map((p) => ({
    externalPositionId: p.external_position_id,
    positionNumber: p.position_number,
    itemNo: p.item_no,
    workName: p.work_name,
    unitCode: p.unit_code,
    isAdditional: p.is_additional,
    isSection: p.is_section,
    manualVolume: p.manual_volume,
    commercialTotal: p.commercial_total,
  }));

const loadLines = async (db: Queryable, contentId: string): Promise<ILineInput[]> =>
  (
    await db.query<Record<string, string | null>>(
      `SELECT external_item_id, external_position_id, item_type, material_type, unit_code, description, work_name_id, material_name_id,
              detail_cost_category_id, parent_work_external_item_id, quantity::text AS quantity, consumption_coefficient::text AS consumption_coefficient,
              conversion_coefficient::text AS conversion_coefficient, unit_rate::text AS unit_rate, currency, delivery_price_type,
              delivery_amount::text AS delivery_amount, total_amount::text AS total_amount, commercial_markup::text AS commercial_markup,
              total_commercial_material::text AS total_commercial_material, total_commercial_work::text AS total_commercial_work
         FROM calculation_line WHERE content_id = $1 ORDER BY external_position_id, coalesce(sort_number, 2147483647), external_item_id`,
      [contentId],
    )
  ).rows.map((l) => ({
    externalItemId: l.external_item_id!,
    externalPositionId: l.external_position_id!,
    itemType: l.item_type!,
    materialType: l.material_type ?? null,
    unitCode: l.unit_code ?? null,
    description: l.description ?? null,
    workNameId: l.work_name_id ?? null,
    materialNameId: l.material_name_id ?? null,
    detailCostCategoryId: l.detail_cost_category_id ?? null,
    parentWorkExternalItemId: l.parent_work_external_item_id ?? null,
    quantity: l.quantity ?? null,
    consumptionCoefficient: l.consumption_coefficient ?? null,
    conversionCoefficient: l.conversion_coefficient ?? null,
    unitRate: l.unit_rate ?? null,
    currency: l.currency ?? null,
    deliveryPriceType: l.delivery_price_type ?? null,
    deliveryAmount: l.delivery_amount ?? null,
    totalAmount: l.total_amount ?? null,
    commercialMarkup: l.commercial_markup ?? null,
    totalCommercialMaterial: l.total_commercial_material ?? null,
    totalCommercialWork: l.total_commercial_work ?? null,
  }));

// ---------------------------------------------------------------- Отчёт ревизии

export interface IRevisionEconomicsRow {
  id: string;
  revision_id: string;
  tender_id: string;
  method_version: string;
  report: IRevisionEconomics;
  created_at: Date;
}

export const getRevisionEconomics = async (db: Queryable, revisionId: string): Promise<IRevisionEconomicsRow | null> =>
  (
    await db.query<IRevisionEconomicsRow>(
      'SELECT id, revision_id, tender_id, method_version, report, created_at FROM revision_economics WHERE revision_id = $1 AND method_version = $2',
      [revisionId, ECONOMICS_METHOD_VERSION],
    )
  ).rows[0] ?? null;

const lock = (db: Queryable, domain: string, key: string) => db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [domain, key]);

// Отчёт пишется один раз на ревизию и версию метода (ревизия неизменна — отчёт детерминирован). Параллельный запрос
// той же ревизии ждёт блокировку и читает уже записанный отчёт.
export const ensureRevisionEconomics = async (db: Queryable, revisionId: string, userId: string | null): Promise<IRevisionEconomicsRow | null> => {
  await lock(db, 'economics.report', revisionId);
  const existing = await getRevisionEconomics(db, revisionId);
  if (existing) return existing;
  const rev = await loadEconomicsRevision(db, revisionId);
  if (!rev) return null;
  const positions = await loadPositions(db, rev.content_id);
  const lines = await loadLines(db, rev.content_id);
  const { report, lineChecks } = buildRevisionEconomics({
    grandTotal: rev.source_grand_total,
    rates: { USD: rev.usd_rate, EUR: rev.eur_rate, CNY: rev.cny_rate },
    ratesObservedAt: rev.observed_at?.toISOString() ?? null,
    positions: positions.map((p) => ({ externalPositionId: p.externalPositionId, isSection: p.isSection, manualVolume: p.manualVolume, commercialTotal: p.commercialTotal })),
    lines,
    components: rev.components ?? tenderHubApiComponents(rev.contract_version ?? 'unknown'),
  });
  const r = report.reconciliation;
  const ins = await db.query<{ id: string }>(
    `INSERT INTO revision_economics (tender_id, revision_id, method_version, cost_total, commercial_total, grand_total, residual, tolerance,
                                     reconciliation_status, line_tolerance_rel, line_tolerance_abs, report, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [rev.tender_id, rev.id, ECONOMICS_METHOD_VERSION, report.totals.cost, r.confirmedPart, r.target, r.residual, RECONCILIATION_TOLERANCE, r.status,
     LINE_TOLERANCE.relative, LINE_TOLERANCE.absolute, JSON.stringify(report), userId],
  );
  const economicsId = ins.rows[0]!.id;
  if (lineChecks.length > 0) {
    await db.query(
      `INSERT INTO revision_line_check (economics_id, external_item_id, formula, recomputed_cost, deviation, within_tolerance, derived_quantity, flags)
       SELECT $1, x.external_item_id, x.formula, x.recomputed_cost, x.deviation, x.within_tolerance, x.derived_quantity,
              ARRAY(SELECT jsonb_array_elements_text(x.flags))
         FROM jsonb_to_recordset($2::jsonb) AS x(external_item_id uuid, formula text, recomputed_cost numeric, deviation numeric,
                                                 within_tolerance boolean, derived_quantity numeric, flags jsonb)`,
      [
        economicsId,
        JSON.stringify(
          lineChecks.map((c) => ({
            external_item_id: c.externalItemId,
            formula: c.formula,
            recomputed_cost: strOrNull(c.recomputedCost),
            deviation: strOrNull(c.deviation),
            within_tolerance: c.withinTolerance,
            derived_quantity: strOrNull(c.derivedQuantity),
            flags: c.flags,
          })),
        ),
      ],
    );
  }
  return getRevisionEconomics(db, revisionId);
};

export interface ILineCheckRow {
  external_item_id: string;
  external_position_id: string;
  item_type: string;
  description: string | null;
  quantity: string | null;
  total_amount: string | null;
  formula: string;
  recomputed_cost: string | null;
  deviation: string | null;
  within_tolerance: boolean | null;
  derived_quantity: string | null;
  flags: string[];
}

// Строки с отклонениями (§5.9) — постранично; без флага — все строки с хотя бы одним отклонением.
export const revisionDeviationLines = async (db: Queryable, economicsId: string, o: { flag: string | null; after: string | null; limit: number }): Promise<ILineCheckRow[]> =>
  (
    await db.query<ILineCheckRow>(
      `SELECT c.external_item_id, l.external_position_id, l.item_type, l.description, l.quantity::text AS quantity, l.total_amount::text AS total_amount,
              c.formula, c.recomputed_cost::text AS recomputed_cost, c.deviation::text AS deviation, c.within_tolerance,
              c.derived_quantity::text AS derived_quantity, c.flags
         FROM revision_line_check c
         JOIN revision_economics e ON e.id = c.economics_id
         JOIN calculation_revision r ON r.id = e.revision_id
         JOIN calculation_line l ON l.content_id = r.content_id AND l.external_item_id = c.external_item_id
        WHERE c.economics_id = $1 AND cardinality(c.flags) > 0 AND ($2::text IS NULL OR $2 = ANY (c.flags))
          AND ($3::uuid IS NULL OR c.external_item_id > $3::uuid)
        ORDER BY c.external_item_id LIMIT $4`,
      [economicsId, o.flag, o.after, o.limit],
    )
  ).rows;

// ---------------------------------------------------------------- Сопоставление позиций

export interface ILineageCurrentRow {
  id: string;
  from_position: string;
  to_position: string;
  method: 'source_lineage' | 'exact_key' | 'position_key' | 'manual';
  status: 'proposed' | 'confirmed' | 'rejected';
  decided_by: string | null;
  decided_by_kind: 'human' | 'service' | null;
  seq: number;
  created_at: Date;
}

// Действующее состояние по паре позиций — последняя запись (append-only, D-030).
export const currentLineage = async (db: Queryable, leftId: string, rightId: string): Promise<ILineageCurrentRow[]> =>
  (
    await db.query<ILineageCurrentRow>(
      `SELECT DISTINCT ON (l.from_external_position_id, l.to_external_position_id)
              l.id, l.from_external_position_id AS from_position, l.to_external_position_id AS to_position, l.method, l.status, l.decided_by,
              u.kind AS decided_by_kind, l.seq, l.created_at
         FROM position_lineage l LEFT JOIN app_user u ON u.id = l.decided_by
        WHERE l.from_revision_id = $1 AND l.to_revision_id = $2
        ORDER BY l.from_external_position_id, l.to_external_position_id, l.seq DESC`,
      [leftId, rightId],
    )
  ).rows;

export const lineageSeq = async (db: Queryable, leftId: string, rightId: string): Promise<number> =>
  Number((await db.query<{ seq: string }>('SELECT lineage_pair_seq($1, $2)::text AS seq', [leftId, rightId])).rows[0]!.seq);

// Идентичность источника обеих ревизий (D-030 «Дополнение»): экземпляр из конфигурации, тендер и версия.
export const sourceIdentityOf = async (db: Queryable, left: IEconomicsRevision, right: IEconomicsRevision): Promise<SourceIdentity> => {
  // Один и тот же тендер TenderHub (строка версии) — UUID позиций могут совпадать; подтверждает система только при
  // заданном и одинаковом экземпляре и известной одинаковой версии, иначе — предложение.
  if (left.external_tender_id !== right.external_tender_id) return 'different';
  const same = (await db.query<{ ok: boolean }>('SELECT calculation_revisions_same_source($1, $2) AS ok', [left.id, right.id])).rows[0]!.ok;
  return same ? 'same' : 'unknown';
};

const systemLineageUser = async (db: Queryable): Promise<string> =>
  (await db.query<{ id: string }>("SELECT id FROM app_user WHERE login = 'system.lineage' AND kind = 'service'")).rows[0]!.id;

const toKeyInput = (p: IComparePosition) => ({ ...p });

// Предложения пишутся append-only: система подтверждает только source_lineage одного экземпляра, тендера и версии;
// остальное — proposed. Повторно предложение по паре с решением не создаётся.
export const writeProposals = async (db: Queryable, d: { tenderId: string; left: IEconomicsRevision; right: IEconomicsRevision }): Promise<IProposalPlan> => {
  const lp = await loadPositions(db, d.left.content_id);
  const rp = await loadPositions(db, d.right.content_id);
  const current = await currentLineage(db, d.left.id, d.right.id);
  const states: ILineageState[] = current.map((c) => ({ from: c.from_position, to: c.to_position, status: c.status }));
  const plan = planProposals(lp.map(toKeyInput), rp.map(toKeyInput), states, await sourceIdentityOf(db, d.left, d.right));
  const rows: { from: string; to: string; method: string; status: 'proposed' | 'confirmed'; system: boolean }[] = [
    ...plan.systemConfirmed.map((p) => ({ ...p, method: 'source_lineage', status: 'confirmed' as const, system: true })),
    ...plan.proposals.map((p) => ({ from: p.from, to: p.to, method: p.method, status: 'proposed' as const, system: false })),
  ];
  if (rows.length > 0) {
    const system = plan.systemConfirmed.length > 0 ? await systemLineageUser(db) : null;
    await db.query(
      `INSERT INTO position_lineage (tender_id, from_revision_id, from_external_position_id, to_revision_id, to_external_position_id, method, status, decided_by)
       SELECT $1, $2, x.f, $3, x.t, x.m, x.s, CASE WHEN x.sys THEN $4::uuid END
         FROM jsonb_to_recordset($5::jsonb) AS x(f uuid, t uuid, m text, s text, sys boolean)`,
      [d.tenderId, d.left.id, d.right.id, system, JSON.stringify(rows.map((r) => ({ f: r.from, t: r.to, m: r.method, s: r.status, sys: r.system })))],
    );
  }
  return plan;
};

// Неоднозначные группы для ручной проверки — по текущему состоянию, без записи.
export const ambiguousGroups = async (db: Queryable, left: IEconomicsRevision, right: IEconomicsRevision): Promise<IProposalPlan['ambiguous']> => {
  const lp = await loadPositions(db, left.content_id);
  const rp = await loadPositions(db, right.content_id);
  const current = await currentLineage(db, left.id, right.id);
  return planProposals(lp.map(toKeyInput), rp.map(toKeyInput), current.map((c) => ({ from: c.from_position, to: c.to_position, status: c.status })), 'different').ambiguous;
};

export interface IPositionBrief {
  external_position_id: string;
  position_number: string;
  item_no: string | null;
  work_name: string;
  unit_code: string | null;
  is_section: boolean;
}

export const positionBriefs = async (db: Queryable, contentId: string): Promise<IPositionBrief[]> =>
  (
    await db.query<IPositionBrief>(
      'SELECT external_position_id, position_number::text AS position_number, item_no, work_name, unit_code, is_section FROM calculation_position WHERE content_id = $1 ORDER BY position_number, external_position_id',
      [contentId],
    )
  ).rows;

export class EconomicsDomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Решения человека по парам: подтверждение предложения — тем же методом, ручная пара — manual; отклонение — rejected.
export const appendHumanLineage = async (
  db: Queryable,
  d: { tenderId: string; leftId: string; rightId: string; userId: string; decisions: { from: string; to: string; status: 'confirmed' | 'rejected' }[] },
): Promise<number> => {
  if (d.decisions.length === 0) return 0;
  const current = new Map((await currentLineage(db, d.leftId, d.rightId)).map((c) => [`${c.from_position}>${c.to_position}`, c]));
  const rows = d.decisions.map((x) => {
    const cur = current.get(`${x.from}>${x.to}`);
    const method = cur && cur.method !== 'manual' && cur.status === 'proposed' ? cur.method : 'manual';
    return { f: x.from, t: x.to, m: method, s: x.status };
  });
  await db.query(
    `INSERT INTO position_lineage (tender_id, from_revision_id, from_external_position_id, to_revision_id, to_external_position_id, method, status, decided_by)
     SELECT $1, $2, x.f, $3, x.t, x.m, x.s, $4 FROM jsonb_to_recordset($5::jsonb) AS x(f uuid, t uuid, m text, s text)`,
    [d.tenderId, d.leftId, d.rightId, d.userId, JSON.stringify(rows)],
  );
  return rows.length;
};

// ---------------------------------------------------------------- Сравнение

export interface IComparisonRow {
  id: string;
  tender_id: string;
  stage_id: string;
  left_revision_id: string;
  right_revision_id: string;
  method_version: string;
  decomposition_method: string;
  method_description: Record<string, unknown>;
  tolerance: string;
  lineage_seq: number;
  status: 'computing' | 'ready' | 'failed';
  failure_reason: string | null;
  totals: Record<string, { targetKind: string; left: string; right: string; delta: string }> | null;
  result_sha256: string | null;
  requested_by: string;
  created_at: Date;
  finished_at: Date | null;
}

const COMPARISON_COLUMNS =
  'c.id, c.tender_id, c.stage_id, c.left_revision_id, c.right_revision_id, c.method_version, c.decomposition_method, c.method_description, c.tolerance::text AS tolerance, c.lineage_seq::int AS lineage_seq, c.status, c.failure_reason, c.totals, c.result_sha256, c.requested_by, c.created_at, c.finished_at';

export const getComparison = async (db: Queryable, ctx: IAccessContext | null, id: string): Promise<IComparisonRow | null> =>
  (
    await db.query<IComparisonRow>(
      `SELECT ${COMPARISON_COLUMNS} FROM calculation_comparison c WHERE c.id = $1 AND ($2::uuid[] IS NULL OR c.tender_id = ANY($2::uuid[]))`,
      [id, ctx ? contentTenderIds(ctx) : null],
    )
  ).rows[0] ?? null;

export const listComparisons = async (db: Queryable, stageId: string): Promise<IComparisonRow[]> =>
  (await db.query<IComparisonRow>(`SELECT ${COMPARISON_COLUMNS} FROM calculation_comparison c WHERE c.stage_id = $1 ORDER BY c.created_at DESC LIMIT 50`, [stageId])).rows;

const sideOf = async (db: Queryable, rev: IEconomicsRevision): Promise<ICompareSide> => ({
  revisionId: rev.id,
  contentHash: rev.content_hash,
  grandTotal: rev.source_grand_total,
  rates: { USD: rev.usd_rate, EUR: rev.eur_rate, CNY: rev.cny_rate },
  positions: await loadPositions(db, rev.content_id),
  lines: await loadLines(db, rev.content_id),
});

export interface ICreatedComparison {
  comparison: IComparisonRow;
  proposals: IProposalPlan;
}

// Сравнение одной транзакцией (проект §6): блокировка пары ревизий → предложения сопоставления → закреплённый набор
// подтверждённых пар (lineage_seq) → разложение в ядре → единицы и вклады → ready. Ошибка арифметики или инварианта
// ядра — сравнение failed с причиной, а не частичный результат.
export const createComparison = async (
  db: Queryable,
  d: { tenderId: string; stageId: string; left: IEconomicsRevision; right: IEconomicsRevision; userId: string },
): Promise<ICreatedComparison> => {
  await lock(db, 'economics.compare', `${d.left.id}>${d.right.id}`);
  const proposals = await writeProposals(db, { tenderId: d.tenderId, left: d.left, right: d.right });
  const current = await currentLineage(db, d.left.id, d.right.id);
  const pairs: IConfirmedPair[] = current.filter((c) => c.status === 'confirmed').map((c) => ({ lineageId: c.id, from: c.from_position, to: c.to_position }));
  const seq = await lineageSeq(db, d.left.id, d.right.id);
  const ins = await db.query<{ id: string }>(
    `INSERT INTO calculation_comparison (tender_id, stage_id, left_revision_id, right_revision_id, method_version, decomposition_method, method_description, tolerance, lineage_seq, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [d.tenderId, d.stageId, d.left.id, d.right.id, COMPARISON_METHOD_VERSION, DECOMPOSITION_METHOD, JSON.stringify(METHOD_DESCRIPTION), RECONCILIATION_TOLERANCE, seq, d.userId],
  );
  const id = ins.rows[0]!.id;
  try {
    const result = compareRevisions(await sideOf(db, d.left), await sideOf(db, d.right), pairs);
    const unitIds = new Map<number, string>();
    if (result.units.length > 0) {
      const units = await db.query<{ id: string; unit_no: number }>(
        `INSERT INTO comparison_unit (comparison_id, unit_no, kind, left_positions, right_positions, lineage_ids, title, unit_code, cost_left, cost_right,
                                      cost_comparable, cost_reason, commercial_left, commercial_right, commercial_comparable, commercial_reason,
                                      material_column_delta, work_column_delta, column_shift)
         SELECT $1, x.unit_no, x.kind, ARRAY(SELECT jsonb_array_elements_text(x.lp))::uuid[], ARRAY(SELECT jsonb_array_elements_text(x.rp))::uuid[],
                ARRAY(SELECT jsonb_array_elements_text(x.li))::uuid[], x.title, x.unit_code, x.cl, x.cr, x.cc, x.cre, x.ml, x.mr, x.mc, x.mre, x.md, x.wd, x.sh
           FROM jsonb_to_recordset($2::jsonb) AS x(unit_no int, kind text, lp jsonb, rp jsonb, li jsonb, title text, unit_code text, cl numeric, cr numeric,
                                                   cc boolean, cre text, ml numeric, mr numeric, mc boolean, mre text, md numeric, wd numeric, sh boolean)
         RETURNING id, unit_no`,
        [
          id,
          JSON.stringify(
            result.units.map((u) => ({
              unit_no: u.unitNo,
              kind: u.kind,
              lp: u.left,
              rp: u.right,
              li: u.lineageIds,
              title: u.title.slice(0, 2000) || '—',
              unit_code: u.unitCode,
              cl: strOrNull(u.cost.left),
              cr: strOrNull(u.cost.right),
              cc: u.cost.comparable,
              cre: u.cost.reason,
              ml: strOrNull(u.commercial.left),
              mr: strOrNull(u.commercial.right),
              mc: u.commercial.comparable,
              mre: u.commercial.reason,
              md: strOrNull(u.columns.materialDelta),
              wd: strOrNull(u.columns.workDelta),
              sh: u.columns.shift,
            })),
          ),
        ],
      );
      for (const u of units.rows) unitIds.set(u.unit_no, u.id);
    }
    await db.query(
      `INSERT INTO comparison_effect (comparison_id, unit_id, measure, component, amount, line_refs)
       SELECT $1, x.unit_id, x.measure, x.component, x.amount, x.refs FROM jsonb_to_recordset($2::jsonb) AS x(unit_id uuid, measure text, component text, amount numeric, refs jsonb)`,
      [
        id,
        JSON.stringify(
          result.effects.map((e) => ({ unit_id: e.unitNo === null ? null : unitIds.get(e.unitNo), measure: e.measure, component: e.component, amount: str(e.amount), refs: e.lineRefs })),
        ),
      ],
    );
    const totals = Object.fromEntries(
      Object.entries(result.totals).map(([k, v]) => [k, { targetKind: v.targetKind, left: str(v.left), right: str(v.right), delta: str(v.delta) }]),
    );
    await db.query("UPDATE calculation_comparison SET status = 'ready', totals = $2::jsonb, result_sha256 = $3, finished_at = now() WHERE id = $1", [id, JSON.stringify(totals), result.resultSha256]);
  } catch (err) {
    if (!(err instanceof ComparisonInvariantError) && !(err instanceof MoneyArithmeticError)) throw err;
    await db.query("UPDATE calculation_comparison SET status = 'failed', failure_reason = $2, finished_at = now() WHERE id = $1", [id, err.message.slice(0, 1000)]);
  }
  return { comparison: (await getComparison(db, null, id))!, proposals };
};

export interface IComparisonUnitRow {
  id: string;
  unit_no: number;
  kind: string;
  left_positions: string[];
  right_positions: string[];
  lineage_ids: string[];
  title: string;
  unit_code: string | null;
  cost_left: string | null;
  cost_right: string | null;
  cost_comparable: boolean;
  cost_reason: string | null;
  commercial_left: string | null;
  commercial_right: string | null;
  commercial_comparable: boolean;
  commercial_reason: string | null;
  cost_delta: string | null;
  commercial_delta: string | null;
  material_column_delta: string | null;
  work_column_delta: string | null;
  column_shift: boolean;
  effects: { measure: string; component: string; amount: string; line_refs: { left: string[]; right: string[] } }[];
}

export const comparisonUnits = async (
  db: Queryable,
  comparisonId: string,
  o: { kind: string | null; changedOnly: boolean; afterNo: number; limit: number },
): Promise<IComparisonUnitRow[]> =>
  (
    await db.query<IComparisonUnitRow>(
      `SELECT u.id, u.unit_no, u.kind, u.left_positions, u.right_positions, u.lineage_ids, u.title, u.unit_code,
              u.cost_left::text AS cost_left, u.cost_right::text AS cost_right, u.cost_comparable, u.cost_reason,
              u.commercial_left::text AS commercial_left, u.commercial_right::text AS commercial_right, u.commercial_comparable, u.commercial_reason,
              trim_scale(u.cost_right - u.cost_left)::text AS cost_delta, trim_scale(u.commercial_right - u.commercial_left)::text AS commercial_delta,
              u.material_column_delta::text AS material_column_delta, u.work_column_delta::text AS work_column_delta, u.column_shift,
              coalesce((SELECT jsonb_agg(jsonb_build_object('measure', e.measure, 'component', e.component, 'amount', trim_scale(e.amount)::text, 'line_refs', e.line_refs)
                                         ORDER BY e.measure DESC, array_position(ARRAY['volume','unit_rate','currency_change','fx_rate','delivery','coefficient','source_tail','composition_added','composition_removed','composition_changed','not_decomposable','incomparable_units','unexplained_remainder'], e.component))
                          FROM comparison_effect e WHERE e.unit_id = u.id), '[]'::jsonb) AS effects
         FROM comparison_unit u
        WHERE u.comparison_id = $1 AND ($2::text IS NULL OR u.kind = $2) AND u.unit_no > $3
          AND (NOT $4 OR u.kind <> 'matched' OR NOT u.cost_comparable OR NOT u.commercial_comparable
               OR u.cost_left <> u.cost_right OR u.commercial_left <> u.commercial_right)
        ORDER BY u.unit_no LIMIT $5`,
      [comparisonId, o.kind, o.afterNo, o.changedOnly, o.limit],
    )
  ).rows;

export interface IEffectSummaryRow {
  measure: string;
  component: string;
  level: 'unit' | 'tender';
  amount: string;
  units: number;
}

export const comparisonSummary = async (db: Queryable, comparisonId: string): Promise<{ effects: IEffectSummaryRow[]; units: Record<string, number>; incomparable: { cost: number; commercial: number } }> => {
  const effects = (
    await db.query<IEffectSummaryRow>(
      `SELECT measure, component, CASE WHEN unit_id IS NULL THEN 'tender' ELSE 'unit' END AS level, trim_scale(sum(amount))::text AS amount, count(DISTINCT unit_id)::int AS units
         FROM comparison_effect e WHERE comparison_id = $1 GROUP BY measure, component, (unit_id IS NULL)
        ORDER BY measure DESC, level DESC, array_position(ARRAY['volume','unit_rate','currency_change','fx_rate','delivery','coefficient','source_tail','composition_added','composition_removed','composition_changed','not_decomposable','incomparable_units','unexplained_remainder'], e.component)`,
      [comparisonId],
    )
  ).rows;
  const kinds = (await db.query<{ kind: string; n: number }>('SELECT kind, count(*)::int AS n FROM comparison_unit WHERE comparison_id = $1 GROUP BY kind', [comparisonId])).rows;
  const inc = (
    await db.query<{ cost: number; commercial: number }>(
      'SELECT count(*) FILTER (WHERE NOT cost_comparable)::int AS cost, count(*) FILTER (WHERE NOT commercial_comparable)::int AS commercial FROM comparison_unit WHERE comparison_id = $1',
      [comparisonId],
    )
  ).rows[0]!;
  return { effects, units: Object.fromEntries(kinds.map((k) => [k.kind, k.n])), incomparable: inc };
};

export const getComparisonUnit = async (db: Queryable, unitId: string): Promise<{ id: string; comparison_id: string; unit_no: number; title: string } | null> =>
  (await db.query<{ id: string; comparison_id: string; unit_no: number; title: string }>('SELECT id, comparison_id, unit_no, title FROM comparison_unit WHERE id = $1', [unitId])).rows[0] ?? null;
