// PortalCaptureStrategy (ADR-007 §5, docs/contracts/adapters.md §2): собственная выгрузка портала,
// пока TenderHub не отдаёт неизменяемую ревизию (X-01). Несколько успешных HTTP-запросов атомарность
// не доказывают, поэтому выгрузка сверяет контрольные признаки до и после и согласованность маршрутов
// между собой. Любое расхождение — попытка «inconsistent», ревизия из неё не создаётся.
import {
  CALCULATION_NORMALIZATION_VERSION,
  type ICalcContent,
  type ICalcLine,
  type ICalcPosition,
} from '@kontur/core';
import type { ITenderHubSource } from './reader.ts';
import type { ISourceBoqItem, ISourceNumber, ISourceOverview, ISourcePositionCosts, ISourcePositionPaged } from './schema.ts';
import { thError, type IRawResponse } from './types.ts';

export interface ICaptureMarkers {
  updatedAt: string | null;
  cachedGrandTotal: string | null;
  usdRate: string | null;
  eurRate: string | null;
  cnyRate: string | null;
  positionCount: number;
  boqItemCount: number;
}

export interface IConsistencyReason {
  code:
    | 'markers_changed'
    | 'positions_count_mismatch'
    | 'items_count_mismatch'
    | 'position_duplicated'
    | 'position_sets_differ'
    | 'position_changed_between_routes'
    | 'position_items_count_mismatch'
    | 'item_without_position'
    | 'item_duplicated'
    | 'row_updated_during_capture';
  detail: string;
}

export interface IConsistencyReport {
  outcome: 'consistent' | 'inconsistent';
  reasons: IConsistencyReason[];
  before: ICaptureMarkers;
  after: ICaptureMarkers;
  counts: { pages: number; positionsPaged: number; positionsWithCosts: number; boqItems: number };
  // Начало выгрузки по часам источника (заголовок Date первого ответа).
  sourceStart: string | null;
  // updated_at шапки равен текущему времени источника в обоих чтениях (COALESCE(updated_at, NOW())
  // у TenderHub): признак исключён из сравнения, остальные признаки сверяются.
  updatedAtIsSourceNow: boolean;
  missingFields: Record<string, number>;
}

export interface ISourceObserved {
  tenderNumber: string;
  title: string | null;
  clientName: string | null;
  isArchived: boolean | null;
  briefFound: boolean;
  version: number | null;
  submissionDeadlineRaw: string | null;
  submissionDeadline: string | null;
  sourceUpdatedAt: string | null;
}

export interface IPortalCaptureResult {
  transport: ITenderHubSource['transport'];
  consistency: IConsistencyReport;
  observed: ISourceObserved;
  raws: IRawResponse[];
  // Только у согласованной выгрузки.
  content: ICalcContent | null;
  // Исходные лексемы чисел шапки (второе чтение) — raw_lexemes содержимого.
  headerLexemes: Record<string, string>;
}

const MAX_REASONS = 20;
// Точность заголовка Date — секунда; updated_at шапки считается «текущим временем источника» в этих пределах.
const SOURCE_NOW_TOLERANCE_MS = 2000;

const num = (n: ISourceNumber | null): string | null => n?.value ?? null;

const markersOf = (o: ISourceOverview): ICaptureMarkers => ({
  updatedAt: o.updatedAt,
  cachedGrandTotal: num(o.cachedGrandTotal),
  usdRate: num(o.usdRate),
  eurRate: num(o.eurRate),
  cnyRate: num(o.cnyRate),
  positionCount: o.positionCount,
  boqItemCount: o.boqItemCount,
});

const timeOf = (s: string | null): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

// submission_deadline — текстовая форма timestamptz PostgreSQL: «2026-03-01 12:00:00+03».
export const parseSourceTimestamp = (raw: string | null): string | null => {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/u.exec(raw.trim());
  if (!m) return null;
  let zone = m[8] ?? 'Z';
  if (zone !== 'Z') zone = zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7] ?? ''}${zone}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const sameNumber = (a: ISourceNumber | null, b: ISourceNumber | null): boolean => (a?.value ?? null) === (b?.value ?? null);

// Поля позиции, которые отдают оба маршрута: расхождение — позиция менялась между чтениями.
const COMMON_FIELDS: { name: string; same: (p: ISourcePositionPaged, c: ISourcePositionCosts) => boolean }[] = [
  { name: 'position_number', same: (p, c) => sameNumber(p.positionNumber, c.positionNumber) },
  { name: 'item_no', same: (p, c) => p.itemNo === c.itemNo },
  { name: 'work_name', same: (p, c) => p.workName === c.workName },
  { name: 'client_note', same: (p, c) => p.clientNote === c.clientNote },
  { name: 'unit_code', same: (p, c) => p.unitCode === c.unitCode },
  { name: 'volume', same: (p, c) => sameNumber(p.volume, c.volume) },
  { name: 'manual_volume', same: (p, c) => sameNumber(p.manualVolume, c.manualVolume) },
  { name: 'manual_note', same: (p, c) => p.manualNote === c.manualNote },
  { name: 'hierarchy_level', same: (p, c) => p.hierarchyLevel === c.hierarchyLevel },
  { name: 'is_additional', same: (p, c) => p.isAdditional === c.isAdditional },
  { name: 'parent_position_id', same: (p, c) => p.parentPositionId === c.parentPositionId },
  { name: 'total_material', same: (p, c) => sameNumber(p.totalMaterial, c.totalMaterial) },
  { name: 'total_works', same: (p, c) => sameNumber(p.totalWorks, c.totalWorks) },
  { name: 'updated_at', same: (p, c) => p.updatedAt === c.updatedAt },
];

const lexemes = (pairs: [string, ISourceNumber | null][]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, n] of pairs) if (n) out[name] = n.lexeme;
  return out;
};

const toPosition = (p: ISourcePositionPaged, c: ISourcePositionCosts): ICalcPosition => ({
  externalPositionId: c.id,
  positionNumber: c.positionNumber!.value,
  itemNo: c.itemNo,
  workName: c.workName,
  unitCode: c.unitCode,
  volume: num(c.volume),
  manualVolume: num(c.manualVolume),
  manualNote: c.manualNote,
  clientNote: c.clientNote,
  sectionNumber: p.sectionNumber,
  positionName: p.positionName,
  isSection: p.isSection,
  isAdditional: c.isAdditional,
  hierarchyLevel: c.hierarchyLevel,
  parentExternalPositionId: c.parentPositionId,
  costCategoryName: p.costCategoryName,
  totalMaterial: num(c.totalMaterial),
  totalWorks: num(c.totalWorks),
  materialCostPerUnit: num(c.materialCostPerUnit),
  workCostPerUnit: num(c.workCostPerUnit),
  totalCommercialMaterial: num(c.totalCommercialMaterial),
  totalCommercialWork: num(c.totalCommercialWork),
  totalCommercialMaterialPerUnit: num(c.totalCommercialMaterialPerUnit),
  totalCommercialWorkPerUnit: num(c.totalCommercialWorkPerUnit),
  baseTotal: num(c.baseTotal),
  commercialTotal: num(c.commercialTotal),
  materialCostTotal: num(c.materialCostTotal),
  workCostTotal: num(c.workCostTotal),
  markupPercentage: num(c.markupPercentage),
  itemsCount: c.itemsCount,
  rawLexemes: lexemes([
    ['position_number', c.positionNumber],
    ['volume', c.volume],
    ['manual_volume', c.manualVolume],
    ['total_material', c.totalMaterial],
    ['total_works', c.totalWorks],
    ['material_cost_per_unit', c.materialCostPerUnit],
    ['work_cost_per_unit', c.workCostPerUnit],
    ['total_commercial_material', c.totalCommercialMaterial],
    ['total_commercial_work', c.totalCommercialWork],
    ['total_commercial_material_per_unit', c.totalCommercialMaterialPerUnit],
    ['total_commercial_work_per_unit', c.totalCommercialWorkPerUnit],
    ['base_total', c.baseTotal],
    ['commercial_total', c.commercialTotal],
    ['material_cost_total', c.materialCostTotal],
    ['work_cost_total', c.workCostTotal],
    ['markup_percentage', c.markupPercentage],
  ]),
});

const toLine = (b: ISourceBoqItem): ICalcLine => ({
  externalItemId: b.id,
  externalPositionId: b.positionId,
  sortNumber: b.sortNumber,
  itemType: b.itemType,
  materialType: b.materialType,
  description: b.description,
  workName: b.workName,
  materialName: b.materialName,
  unitCode: b.unitCode,
  quantity: num(b.quantity),
  baseQuantity: num(b.baseQuantity),
  consumptionCoefficient: num(b.consumptionCoefficient),
  conversionCoefficient: num(b.conversionCoefficient),
  unitRate: num(b.unitRate),
  currency: b.currency,
  deliveryPriceType: b.deliveryPriceType,
  deliveryAmount: num(b.deliveryAmount),
  totalAmount: num(b.totalAmount),
  commercialMarkup: num(b.commercialMarkup),
  totalCommercialMaterial: num(b.totalCommercialMaterial),
  totalCommercialWork: num(b.totalCommercialWork),
  quoteLink: b.quoteLink,
  costCategory: b.costCategory,
  detailCostCategory: b.detailCostCategory,
  detailCostLocation: b.detailCostLocation,
  workNameId: b.workNameId,
  materialNameId: b.materialNameId,
  detailCostCategoryId: b.detailCostCategoryId,
  parentWorkExternalItemId: b.parentWorkItemId,
  rawLexemes: lexemes([
    ['quantity', b.quantity],
    ['base_quantity', b.baseQuantity],
    ['consumption_coefficient', b.consumptionCoefficient],
    ['conversion_coefficient', b.conversionCoefficient],
    ['unit_rate', b.unitRate],
    ['delivery_amount', b.deliveryAmount],
    ['total_amount', b.totalAmount],
    ['commercial_markup', b.commercialMarkup],
    ['total_commercial_material_cost', b.totalCommercialMaterial],
    ['total_commercial_work_cost', b.totalCommercialWork],
  ]),
});

export const runPortalCapture = async (source: ITenderHubSource, tenderId: string, signal?: AbortSignal): Promise<IPortalCaptureResult> => {
  const id = tenderId.toLowerCase();
  const raws: IRawResponse[] = [];
  const before = await source.overview(id, signal);
  raws.push(...before.raws);
  if (before.value.id !== id) throw thError('CONTRACT_MISMATCH', 'contract_mismatch', 'overview вернул другой тендер', false, { route: 'overview' });
  const brief = await source.brief(before.value.tenderNumber, signal);
  raws.push(...brief.raws);
  const positions = await source.positions(id, signal);
  raws.push(...positions.raws);
  const withCosts = await source.positionsWithCosts(id, signal);
  raws.push(...withCosts.raws);
  const boq = await source.boqItems(id, signal);
  raws.push(...boq.raws);
  const after = await source.overview(id, signal);
  raws.push(...after.raws);

  for (const row of [...positions.value, ...withCosts.value, ...boq.value]) {
    if (row.tenderId !== id) throw thError('CONTRACT_MISMATCH', 'contract_mismatch', 'строка ответа относится к другому тендеру', false);
  }

  const reasons: IConsistencyReason[] = [];
  const add = (code: IConsistencyReason['code'], detail: string): void => {
    if (reasons.length < MAX_REASONS) reasons.push({ code, detail });
  };

  // 1. Контрольные признаки шапки до и после.
  const mb = markersOf(before.value);
  const ma = markersOf(after.value);
  const beforeDate = timeOf(before.raws[0]!.sourceDate);
  const afterDate = timeOf(after.raws[0]!.sourceDate);
  const nearNow = (updatedAt: string | null, date: number | null): boolean => {
    const u = timeOf(updatedAt);
    return u !== null && date !== null && Math.abs(u - date) <= SOURCE_NOW_TOLERANCE_MS;
  };
  const updatedAtIsSourceNow = mb.updatedAt !== ma.updatedAt && nearNow(mb.updatedAt, beforeDate) && nearNow(ma.updatedAt, afterDate);
  for (const key of ['cachedGrandTotal', 'usdRate', 'eurRate', 'cnyRate', 'positionCount', 'boqItemCount', 'updatedAt'] as const) {
    if (key === 'updatedAt' && updatedAtIsSourceNow) continue;
    if (mb[key] !== ma[key]) add('markers_changed', `шапка: ${key} до и после выгрузки различаются`);
  }

  // 2. Число позиций и строк по всем маршрутам — одно и то же.
  if (positions.value.length !== mb.positionCount || withCosts.value.length !== mb.positionCount) {
    add('positions_count_mismatch', `позиций: шапка ${mb.positionCount}, постранично ${positions.value.length}, with-costs ${withCosts.value.length}`);
  }
  if (boq.value.length !== mb.boqItemCount) add('items_count_mismatch', `строк: шапка ${mb.boqItemCount}, boq-items-full ${boq.value.length}`);

  // 3. Постраничный список и with-costs — одни и те же позиции с одинаковыми полями.
  const paged = new Map<string, ISourcePositionPaged>();
  for (const p of positions.value) {
    if (paged.has(p.id)) add('position_duplicated', `позиция ${p.id} встретилась на страницах дважды (изменение во время обхода)`);
    paged.set(p.id, p);
  }
  const costs = new Map<string, ISourcePositionCosts>();
  for (const c of withCosts.value) costs.set(c.id, c);
  for (const c of withCosts.value) {
    const p = paged.get(c.id);
    if (!p) {
      add('position_sets_differ', `позиция ${c.id} есть в with-costs, но не на страницах`);
      continue;
    }
    const changed = COMMON_FIELDS.filter((f) => !f.same(p, c)).map((f) => f.name);
    if (changed.length > 0) add('position_changed_between_routes', `позиция ${c.id}: ${changed.join(', ')}`);
  }
  for (const p of positions.value) if (!costs.has(p.id)) add('position_sets_differ', `позиция ${p.id} есть на страницах, но не в with-costs`);

  // 4. Строки — только известных позиций, id не повторяется, и их число сходится с items_count позиции.
  // Повтор id при прежних счётчиках (A, B, C → A, A, C) счётчики не выдают — проверяется отдельно (R06-01).
  const perPosition = new Map<string, number>();
  const seenItems = new Set<string>();
  for (const b of boq.value) {
    if (seenItems.has(b.id)) add('item_duplicated', `строка ${b.id} встретилась в boq-items-full дважды`);
    seenItems.add(b.id);
    if (!costs.has(b.positionId)) add('item_without_position', `строка ${b.id}: позиции ${b.positionId} нет в выгрузке`);
    perPosition.set(b.positionId, (perPosition.get(b.positionId) ?? 0) + 1);
  }
  for (const c of withCosts.value) {
    if (c.itemsCount !== null && c.itemsCount !== (perPosition.get(c.id) ?? 0)) {
      add('position_items_count_mismatch', `позиция ${c.id}: items_count ${c.itemsCount}, строк ${perPosition.get(c.id) ?? 0}`);
    }
  }

  // 5. Строки, изменённые после начала выгрузки (по часам источника), — изменение во время чтения.
  const start = beforeDate;
  if (start !== null) {
    const startSecond = Math.floor(start / 1000) * 1000;
    const fresh = [...positions.value, ...withCosts.value, ...boq.value].filter((r) => {
      const t = timeOf(r.updatedAt);
      return t !== null && t >= startSecond;
    });
    if (fresh.length > 0) add('row_updated_during_capture', `строк с updated_at не раньше начала выгрузки: ${fresh.length}`);
  }

  const deadlineRaw = brief.value.find((b) => b.id === id) ?? null;
  const observed: ISourceObserved = {
    tenderNumber: before.value.tenderNumber,
    title: before.value.title,
    clientName: before.value.clientName,
    isArchived: before.value.isArchived,
    briefFound: deadlineRaw !== null,
    version: deadlineRaw?.version ?? null,
    submissionDeadlineRaw: deadlineRaw?.submissionDeadline ?? null,
    submissionDeadline: parseSourceTimestamp(deadlineRaw?.submissionDeadline ?? null),
    sourceUpdatedAt: before.value.updatedAt,
  };

  const consistency: IConsistencyReport = {
    outcome: reasons.length === 0 ? 'consistent' : 'inconsistent',
    reasons,
    before: mb,
    after: ma,
    counts: { pages: positions.raws.length, positionsPaged: positions.value.length, positionsWithCosts: withCosts.value.length, boqItems: boq.value.length },
    sourceStart: start === null ? null : new Date(start).toISOString(),
    updatedAtIsSourceNow,
    missingFields: source.missingFields(),
  };
  const headerLexemes = lexemes([
    ['cached_grand_total', after.value.cachedGrandTotal],
    ['usd_rate', after.value.usdRate],
    ['eur_rate', after.value.eurRate],
    ['cny_rate', after.value.cnyRate],
  ]);
  if (consistency.outcome === 'inconsistent') return { transport: source.transport, consistency, observed, raws, content: null, headerLexemes };

  for (const c of withCosts.value) {
    if (!c.positionNumber) throw thError('CONTRACT_MISMATCH', 'contract_mismatch', `позиция ${c.id} без position_number`, false);
  }
  const content: ICalcContent = {
    header: {
      normalizationVersion: CALCULATION_NORMALIZATION_VERSION,
      sourceGrandTotal: ma.cachedGrandTotal,
      usdRate: ma.usdRate,
      eurRate: ma.eurRate,
      cnyRate: ma.cnyRate,
      kpTotal: null,
      kpTotalCurrency: null,
      kpTotalRule: null,
    },
    positions: withCosts.value.map((c) => toPosition(paged.get(c.id)!, c)),
    lines: boq.value.map(toLine),
  };
  return { transport: source.transport, consistency, observed, raws, content, headerLexemes };
};
