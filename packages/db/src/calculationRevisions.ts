// Расчёт TenderHub: чтение ревизий, позиций и строк с курсорами и сопоставление позиций между
// ревизиями (этап 06; data-model §4.5). Числа — строкой (numeric::text).
import { contentTenderIds, type IAccessContext } from './access.ts';
import type { ICalcRevisionRow, SourceStatus } from './calculationContent.ts';
import type { Queryable } from './pool.ts';

// ---------------------------------------------------------------- Чтение ревизий

export interface ICalcRevisionView extends ICalcRevisionRow {
  normalization_version: string;
  source_grand_total: string | null;
  usd_rate: string | null;
  eur_rate: string | null;
  cny_rate: string | null;
  kp_total: string | null;
  kp_total_currency: string | null;
  kp_total_rule: string | null;
  kp_total_semantics: Record<string, unknown>;
  content_hash: string;
  positions_count: number;
  lines_count: number;
  source_observed: Record<string, unknown> | null;
  consistency: Record<string, unknown> | null;
  raw_bundle_sha256: string | null;
  contract_version: string | null;
  statuses: { status: SourceStatus; observed_at: string; seq: number }[];
}

const REVISION_VIEW = `
  SELECT r.*, c.normalization_version, c.source_grand_total::text AS source_grand_total, c.usd_rate::text AS usd_rate,
         c.eur_rate::text AS eur_rate, c.cny_rate::text AS cny_rate, c.kp_total::text AS kp_total, c.kp_total_currency,
         c.kp_total_rule, c.kp_total_semantics, c.content_hash, c.positions_count, c.lines_count,
         k.source_observed, k.consistency, k.raw_bundle_sha256, k.contract_version,
         coalesce((SELECT jsonb_agg(jsonb_build_object('status', e.status, 'observed_at', e.observed_at, 'seq', e.seq) ORDER BY e.seq)
                     FROM calculation_revision_status_event e WHERE e.revision_id = r.id), '[]'::jsonb) AS statuses
    FROM calculation_revision r
    JOIN calculation_content c ON c.id = r.content_id
    JOIN calculation_capture k ON k.id = r.capture_id`;

export const getCalculationRevision = async (db: Queryable, ctx: IAccessContext, id: string): Promise<ICalcRevisionView | null> => {
  const r = await db.query<ICalcRevisionView>(`${REVISION_VIEW} WHERE r.id = $1 AND r.tender_id = ANY($2::uuid[])`, [id, contentTenderIds(ctx)]);
  return r.rows[0] ?? null;
};

export const listCalculationRevisions = async (db: Queryable, stageId: string): Promise<ICalcRevisionView[]> => {
  const r = await db.query<ICalcRevisionView>(`${REVISION_VIEW} WHERE r.stage_id = $1 ORDER BY r.seq DESC`, [stageId]);
  return r.rows;
};

// Позиции и строки ревизии — числа строкой (numeric::text), курсор — по порядку выдачи.
export interface IPositionRow {
  external_position_id: string;
  position_number: string;
  item_no: string | null;
  work_name: string;
  unit_code: string | null;
  volume: string | null;
  manual_volume: string | null;
  manual_note: string | null;
  client_note: string | null;
  section_number: string | null;
  position_name: string | null;
  is_section: boolean;
  is_additional: boolean | null;
  hierarchy_level: number | null;
  parent_external_position_id: string | null;
  cost_category_name: string | null;
  total_material: string | null;
  total_works: string | null;
  material_cost_per_unit: string | null;
  work_cost_per_unit: string | null;
  total_commercial_material: string | null;
  total_commercial_work: string | null;
  total_commercial_material_per_unit: string | null;
  total_commercial_work_per_unit: string | null;
  base_total: string | null;
  commercial_total: string | null;
  material_cost_total: string | null;
  work_cost_total: string | null;
  markup_percentage: string | null;
  items_count: number | null;
  raw_lexemes: Record<string, string>;
  lines: number;
}

const numericText = (cols: string[], alias: string): string => cols.map((c) => `${alias}.${c}::text AS ${c}`).join(', ');

const POSITION_NUMERIC = [
  'volume', 'manual_volume', 'total_material', 'total_works', 'material_cost_per_unit', 'work_cost_per_unit',
  'total_commercial_material', 'total_commercial_work', 'total_commercial_material_per_unit', 'total_commercial_work_per_unit',
  'base_total', 'commercial_total', 'material_cost_total', 'work_cost_total', 'markup_percentage',
];

export const revisionPositions = async (
  db: Queryable,
  contentId: string,
  o: { after: { positionNumber: string; id: string } | null; limit: number },
): Promise<IPositionRow[]> => {
  const r = await db.query<IPositionRow>(
    `SELECT p.external_position_id, p.position_number::text AS position_number, p.item_no, p.work_name, p.unit_code, p.manual_note,
            p.client_note, p.section_number, p.position_name, p.is_section, p.is_additional, p.hierarchy_level,
            p.parent_external_position_id, p.cost_category_name, p.items_count, p.raw_lexemes, ${numericText(POSITION_NUMERIC, 'p')},
            (SELECT count(*)::int FROM calculation_line l WHERE l.content_id = p.content_id AND l.external_position_id = p.external_position_id) AS lines
       FROM calculation_position p
      WHERE p.content_id = $1
        AND ($2::numeric IS NULL OR (p.position_number, p.external_position_id) > ($2::numeric, $3::uuid))
      ORDER BY p.position_number, p.external_position_id
      LIMIT $4`,
    [contentId, o.after?.positionNumber ?? null, o.after?.id ?? null, o.limit],
  );
  return r.rows;
};

export interface ILineRow {
  external_item_id: string;
  external_position_id: string;
  sort_number: number | null;
  item_type: string;
  material_type: string | null;
  description: string | null;
  work_name: string | null;
  material_name: string | null;
  unit_code: string | null;
  quantity: string | null;
  base_quantity: string | null;
  consumption_coefficient: string | null;
  conversion_coefficient: string | null;
  unit_rate: string | null;
  currency: 'RUB' | 'USD' | 'EUR' | 'CNY' | null;
  delivery_price_type: string | null;
  delivery_amount: string | null;
  total_amount: string | null;
  commercial_markup: string | null;
  total_commercial_material: string | null;
  total_commercial_work: string | null;
  quote_link: string | null;
  quote_price_date: string | null;
  quote_valid_until: string | null;
  cost_category: string | null;
  detail_cost_category: string | null;
  detail_cost_location: string | null;
  work_name_id: string | null;
  material_name_id: string | null;
  detail_cost_category_id: string | null;
  parent_work_external_item_id: string | null;
  raw_lexemes: Record<string, string>;
  order_key: number;
}

const LINE_NUMERIC = [
  'quantity', 'base_quantity', 'consumption_coefficient', 'conversion_coefficient', 'unit_rate', 'delivery_amount',
  'total_amount', 'commercial_markup', 'total_commercial_material', 'total_commercial_work',
];

export const revisionLines = async (
  db: Queryable,
  contentId: string,
  o: { positionId: string | null; after: { positionId: string; order: number; id: string } | null; limit: number },
): Promise<ILineRow[]> => {
  const r = await db.query<ILineRow>(
    `SELECT l.external_item_id, l.external_position_id, l.sort_number, l.item_type, l.material_type, l.description, l.work_name,
            l.material_name, l.unit_code, l.currency, l.delivery_price_type, l.quote_link, l.quote_price_date::text AS quote_price_date,
            l.quote_valid_until::text AS quote_valid_until, l.cost_category, l.detail_cost_category, l.detail_cost_location,
            l.work_name_id, l.material_name_id, l.detail_cost_category_id, l.parent_work_external_item_id, l.raw_lexemes,
            ${numericText(LINE_NUMERIC, 'l')}, coalesce(l.sort_number, 2147483647) AS order_key
       FROM calculation_line l
      WHERE l.content_id = $1 AND ($2::uuid IS NULL OR l.external_position_id = $2::uuid)
        AND ($3::uuid IS NULL OR (l.external_position_id, coalesce(l.sort_number, 2147483647), l.external_item_id) > ($3::uuid, $4::int, $5::uuid))
      ORDER BY l.external_position_id, coalesce(l.sort_number, 2147483647), l.external_item_id
      LIMIT $6`,
    [contentId, o.positionId, o.after?.positionId ?? null, o.after?.order ?? null, o.after?.id ?? null, o.limit],
  );
  return r.rows;
};

// ---------------------------------------------------------------- Lineage

export interface ILineageRow {
  id: string;
  from_revision_id: string;
  from_external_position_id: string;
  to_revision_id: string;
  to_external_position_id: string;
  method: 'source_lineage' | 'exact_key' | 'manual';
  confidence: string | null;
  status: 'proposed' | 'confirmed' | 'rejected';
  decided_by: string | null;
  created_at: Date;
}

export const listLineage = async (db: Queryable, toRevisionId: string): Promise<ILineageRow[]> => {
  const r = await db.query<ILineageRow>(
    'SELECT id, from_revision_id, from_external_position_id, to_revision_id, to_external_position_id, method, confidence::text AS confidence, status, decided_by, created_at FROM position_lineage WHERE to_revision_id = $1 ORDER BY seq',
    [toRevisionId],
  );
  return r.rows;
};

// Решения человека по сопоставлению позиций (method = manual) дописываются: прежние строки не меняются.
export const appendLineageDecisions = async (
  db: Queryable,
  d: { tenderId: string; fromRevisionId: string; toRevisionId: string; userId: string; links: { fromPositionId: string; toPositionId: string; status: 'confirmed' | 'rejected' }[] },
): Promise<number> => {
  for (const l of d.links) {
    await db.query(
      `INSERT INTO position_lineage (tender_id, from_revision_id, from_external_position_id, to_revision_id, to_external_position_id, method, status, decided_by)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7)`,
      [d.tenderId, d.fromRevisionId, l.fromPositionId, d.toRevisionId, l.toPositionId, l.status, d.userId],
    );
  }
  return d.links.length;
};
