// Представление расчёта TenderHub для API (portal-api §2.5, ADR-005 §4). Суммы — объект денег с
// десятичной строкой; валюта и НДС, которых источник не подтверждает, — UNKNOWN / unknown: портал
// семантику не додумывает. Итог КП не выводится, пока нет правила владельца (Q-05).
import { calculationProductionBlockers, formatEtag } from '@kontur/core';
import type { ICalcRevisionView, ICalculationSourceRow, ICaptureRow, IIntegrationStatusRow, ILineRow, ILineageRow, IPositionRow } from '@kontur/db';

type PriceKind = 'cost' | 'commercial';
type Currency = 'RUB' | 'USD' | 'EUR' | 'CNY' | 'UNKNOWN';

export interface IMoney {
  amount: string;
  currency: Currency;
  vat: 'unknown';
  priceKind: PriceKind;
  unit: string | null;
  asOf: null;
  source: { type: string; revisionId: string; externalId: string | null; field: string };
}

const money = (
  amount: string | null,
  priceKind: PriceKind,
  source: IMoney['source'],
  o: { currency?: Currency; unit?: string | null } = {},
): IMoney | null =>
  amount === null ? null : { amount, currency: o.currency ?? 'UNKNOWN', vat: 'unknown', priceKind, unit: o.unit ?? null, asOf: null, source };

// ETag набора связей этапа: сумма row_version строк растёт при любом изменении (новая строка или правка).
export const calculationSourcesEtag = (stageId: string, rows: ICalculationSourceRow[]): string =>
  formatEtag(stageId, rows.reduce((sum, r) => sum + r.row_version, 0));

export const toCalculationSource = (s: ICalculationSourceRow) => ({
  id: s.id,
  stageId: s.stage_id,
  system: s.system,
  externalTenderId: s.external_tender_id,
  externalVersion: s.external_version,
  role: s.role,
  createdAt: s.created_at.toISOString(),
  updatedAt: s.updated_at.toISOString(),
});

export const toIntegration = (rows: IIntegrationStatusRow[]) =>
  rows.map((r) => ({
    component: r.component,
    status: r.status,
    lastCheckedAt: r.last_checked_at?.toISOString() ?? null,
    lastSuccessAt: r.last_success_at?.toISOString() ?? null,
    lastErrorCode: r.last_error_code,
    blockedBy: r.status === 'BLOCKED_EXTERNAL' ? ((r.details.blockedBy as string | undefined) ?? null) : null,
  }));

export const toCapture = (c: ICaptureRow) => ({
  id: c.id,
  stageId: c.stage_id,
  tenderId: c.tender_id,
  system: c.system,
  externalTenderId: c.external_tender_id,
  captureKind: c.capture_kind,
  transport: c.transport,
  trigger: c.trigger,
  deadlineBasis: c.deadline_basis?.toISOString() ?? null,
  status: c.status,
  requestedBy: c.requested_by,
  attempts: c.attempts,
  consistency: c.consistency,
  sourceObserved: c.source_observed,
  rawBundleSha256: c.raw_bundle_sha256,
  contractVersion: c.contract_version,
  contentId: c.content_id,
  revisionId: c.revision_id,
  failure: c.failure_code ? { code: c.failure_code, detail: c.failure_detail } : null,
  createdAt: c.created_at.toISOString(),
  finishedAt: c.finished_at?.toISOString() ?? null,
});

export const toRevision = (r: ICalcRevisionView) => {
  const src = (field: string): IMoney['source'] => ({ type: 'calculation_revision', revisionId: r.id, externalId: r.external_tender_id, field });
  const blockers = calculationProductionBlockers(r.kind);
  const observed = r.source_observed ?? {};
  return {
    id: r.id,
    stageId: r.stage_id,
    tenderId: r.tender_id,
    seq: r.seq,
    kind: r.kind,
    system: r.system,
    externalTenderId: r.external_tender_id,
    externalVersion: (observed.version as number | null | undefined) ?? null,
    externalRevisionRef: r.external_revision_ref,
    supersedesRevisionId: r.supersedes_revision_id,
    captureId: r.capture_id,
    createdAt: r.created_at.toISOString(),
    contentHash: r.content_hash,
    normalizationVersion: r.normalization_version,
    counts: { positions: r.positions_count, lines: r.lines_count },
    source: {
      tenderNumber: (observed.tenderNumber as string | undefined) ?? null,
      title: (observed.title as string | null | undefined) ?? null,
      submissionDeadline: (observed.submissionDeadline as string | null | undefined) ?? null,
      // cached_grand_total шапки TenderHub — значение источника; итогом КП портала не объявляется (Q-05).
      grandTotal: money(r.source_grand_total, 'commercial', src('cached_grand_total')),
      fxRates: { USD: r.usd_rate, EUR: r.eur_rate, CNY: r.cny_rate },
    },
    kpTotal: {
      value: r.kp_total === null ? null : money(r.kp_total, 'commercial', src('kp_total'), { currency: (r.kp_total_currency as Currency | null) ?? 'UNKNOWN' }),
      rule: r.kp_total_rule,
      semantics: r.kp_total_semantics,
    },
    // Боевой выпуск с provisional-ревизией блокируется CALCULATION_PROVISIONAL (state-machines §11.1).
    productionGate: { mode: 'production' as const, allowed: blockers.length === 0, blockers },
    // Закрытие у источника — только событием ревизии verified (X-01); у provisional статуса источника нет.
    sourceStatus: r.statuses.map((s) => ({ status: s.status, observedAt: s.observed_at, seq: s.seq })),
    closureAvailable: r.kind === 'verified',
    aggregates: (r.consistency?.aggregates as unknown) ?? null,
    raw: { bundleSha256: r.raw_bundle_sha256, contractVersion: r.contract_version },
  };
};

export const toPosition = (revisionId: string, p: IPositionRow) => {
  const src = (field: string): IMoney['source'] => ({ type: 'calculation_position', revisionId, externalId: p.external_position_id, field });
  return {
    externalPositionId: p.external_position_id,
    positionNumber: p.position_number,
    itemNo: p.item_no,
    workName: p.work_name,
    unitCode: p.unit_code,
    volume: p.volume,
    // manual_volume — значение источника без подтверждённой семантики: объёмом позиции не считается.
    manualVolume: p.manual_volume === null && p.manual_note === null ? null : { value: p.manual_volume, note: p.manual_note, semantics: 'unconfirmed' as const },
    clientNote: p.client_note,
    sectionNumber: p.section_number,
    positionName: p.position_name,
    // Заголовок раздела TenderHub: работой не считается.
    isSection: p.is_section,
    isAdditional: p.is_additional,
    hierarchyLevel: p.hierarchy_level,
    parentExternalPositionId: p.parent_external_position_id,
    // Самая частая категория строк позиции по TenderHub; строкам не присваивается.
    dominantCostCategory: p.cost_category_name,
    itemsCount: p.items_count,
    lines: p.lines,
    totals: {
      baseTotal: money(p.base_total, 'cost', src('base_total')),
      commercialTotal: money(p.commercial_total, 'commercial', src('commercial_total')),
      totalMaterial: money(p.total_material, 'cost', src('total_material')),
      totalWorks: money(p.total_works, 'cost', src('total_works')),
      materialCostTotal: money(p.material_cost_total, 'cost', src('material_cost_total')),
      workCostTotal: money(p.work_cost_total, 'cost', src('work_cost_total')),
      totalCommercialMaterial: money(p.total_commercial_material, 'commercial', src('total_commercial_material')),
      totalCommercialWork: money(p.total_commercial_work, 'commercial', src('total_commercial_work')),
      materialCostPerUnit: money(p.material_cost_per_unit, 'cost', src('material_cost_per_unit'), { unit: p.unit_code }),
      workCostPerUnit: money(p.work_cost_per_unit, 'cost', src('work_cost_per_unit'), { unit: p.unit_code }),
      totalCommercialMaterialPerUnit: money(p.total_commercial_material_per_unit, 'commercial', src('total_commercial_material_per_unit'), { unit: p.unit_code }),
      totalCommercialWorkPerUnit: money(p.total_commercial_work_per_unit, 'commercial', src('total_commercial_work_per_unit'), { unit: p.unit_code }),
    },
    markupPercentage: p.markup_percentage,
    rawLexemes: p.raw_lexemes,
  };
};

export const toLine = (revisionId: string, l: ILineRow) => {
  const src = (field: string): IMoney['source'] => ({ type: 'calculation_line', revisionId, externalId: l.external_item_id, field });
  return {
    externalItemId: l.external_item_id,
    externalPositionId: l.external_position_id,
    sortNumber: l.sort_number,
    itemType: l.item_type,
    materialType: l.material_type,
    description: l.description,
    workName: l.work_name,
    materialName: l.material_name,
    unitCode: l.unit_code,
    quantity: l.quantity,
    baseQuantity: l.base_quantity,
    consumptionCoefficient: l.consumption_coefficient,
    conversionCoefficient: l.conversion_coefficient,
    // Цена единицы — в валюте строки источника (currency_type), остальные суммы — без подтверждённой валюты.
    unitRate: money(l.unit_rate, 'cost', src('unit_rate'), { currency: l.currency ?? 'UNKNOWN', unit: l.unit_code }),
    currency: l.currency,
    deliveryPriceType: l.delivery_price_type,
    deliveryAmount: money(l.delivery_amount, 'cost', src('delivery_amount')),
    totalAmount: money(l.total_amount, 'cost', src('total_amount')),
    commercialMarkup: l.commercial_markup,
    totalCommercialMaterial: money(l.total_commercial_material, 'commercial', src('total_commercial_material_cost')),
    totalCommercialWork: money(l.total_commercial_work, 'commercial', src('total_commercial_work_cost')),
    quoteLink: l.quote_link,
    // Даты источника цены маршрут boq-items-full не отдаёт.
    quotePriceDate: l.quote_price_date,
    quoteValidUntil: l.quote_valid_until,
    costCategory: l.cost_category,
    detailCostCategory: l.detail_cost_category,
    detailCostLocation: l.detail_cost_location,
    workNameId: l.work_name_id,
    materialNameId: l.material_name_id,
    detailCostCategoryId: l.detail_cost_category_id,
    parentWorkExternalItemId: l.parent_work_external_item_id,
    rawLexemes: l.raw_lexemes,
  };
};

export const toLineage = (l: ILineageRow) => ({
  id: l.id,
  fromRevisionId: l.from_revision_id,
  fromPositionId: l.from_external_position_id,
  toRevisionId: l.to_revision_id,
  toPositionId: l.to_external_position_id,
  method: l.method,
  confidence: l.confidence,
  status: l.status,
  decidedBy: l.decided_by,
  createdAt: l.created_at.toISOString(),
});
