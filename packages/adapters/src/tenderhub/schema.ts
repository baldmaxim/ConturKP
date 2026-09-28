// Строки ответов TenderHub (ENDPOINTS.md, OpenAPI archive.yaml): проверка типов по контракту.
// Числа остаются лексемами источника. Неверный тип или отсутствие ключевого поля — CONTRACT_MISMATCH;
// отсутствие прочего документированного поля — null с учётом в отчёте (сверка со сборкой, R-06).
import { canonicalDecimal, storableText } from '@kontur/core';
import { lexemeOf, NumLex } from './lexeme.ts';
import { thError } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CURRENCIES = ['RUB', 'USD', 'EUR', 'CNY'] as const;
export type Currency = (typeof CURRENCIES)[number];

// Число источника: каноническая запись для хранения и исходная лексема.
export interface ISourceNumber {
  value: string;
  lexeme: string;
}

export class RowIssues {
  readonly problems: string[] = [];
  // Документированное поле, которого нет в ответе: имя → число строк.
  readonly missing = new Map<string, number>();

  fail(route: string): void {
    if (this.problems.length > 0) {
      throw thError('CONTRACT_MISMATCH', 'contract_mismatch', `ответ ${route} не соответствует контракту: ${this.problems.slice(0, 5).join('; ')}`, false, {
        route,
        problems: this.problems.length,
      });
    }
  }

  missingReport(): Record<string, number> {
    return Object.fromEntries([...this.missing.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

class Row {
  private readonly o: Record<string, unknown>;
  private readonly at: string;
  private readonly issues: RowIssues;
  private readonly scope: string;

  constructor(o: unknown, at: string, issues: RowIssues, scope: string) {
    this.o = o !== null && typeof o === 'object' && !Array.isArray(o) && !(o instanceof NumLex) ? (o as Record<string, unknown>) : {};
    if (this.o !== o) issues.problems.push(`${at}: ожидался объект`);
    this.at = at;
    this.issues = issues;
    this.scope = scope;
  }

  private raw(name: string, required: boolean): unknown {
    if (!(name in this.o)) {
      if (required) this.issues.problems.push(`${this.at}.${name}: нет обязательного поля`);
      else this.issues.missing.set(`${this.scope}.${name}`, (this.issues.missing.get(`${this.scope}.${name}`) ?? 0) + 1);
      return null;
    }
    return this.o[name];
  }

  str(name: string, required = false): string | null {
    const v = this.raw(name, required);
    if (v === null || v === undefined) {
      if (required && name in this.o) this.issues.problems.push(`${this.at}.${name}: пусто`);
      return null;
    }
    if (typeof v !== 'string') {
      this.issues.problems.push(`${this.at}.${name}: ожидалась строка`);
      return null;
    }
    return storableText(v);
  }

  uuid(name: string, required = false): string | null {
    const v = this.str(name, required);
    if (v === null) return null;
    if (!UUID.test(v)) {
      this.issues.problems.push(`${this.at}.${name}: ожидался uuid`);
      return null;
    }
    return v.toLowerCase();
  }

  num(name: string, required = false): ISourceNumber | null {
    const v = this.raw(name, required);
    if (v === null || v === undefined) {
      if (required && name in this.o) this.issues.problems.push(`${this.at}.${name}: пусто`);
      return null;
    }
    const lexeme = lexemeOf(v);
    if (lexeme === null) {
      this.issues.problems.push(`${this.at}.${name}: ожидалось число`);
      return null;
    }
    return { value: canonicalDecimal(lexeme), lexeme };
  }

  int(name: string, required = false): number | null {
    const n = this.num(name, required);
    if (n === null) return null;
    if (!/^-?\d+$/u.test(n.value) || !Number.isSafeInteger(Number(n.value))) {
      this.issues.problems.push(`${this.at}.${name}: ожидалось целое`);
      return null;
    }
    return Number(n.value);
  }

  bool(name: string, required = false): boolean | null {
    const v = this.raw(name, required);
    if (v === null || v === undefined) {
      if (required && name in this.o) this.issues.problems.push(`${this.at}.${name}: пусто`);
      return null;
    }
    if (typeof v !== 'boolean') {
      this.issues.problems.push(`${this.at}.${name}: ожидалось логическое значение`);
      return null;
    }
    return v;
  }

  currency(name: string): Currency | null {
    const v = this.str(name);
    if (v === null) return null;
    if (!(CURRENCIES as readonly string[]).includes(v)) {
      // Валюта участвует в сопоставлении денег (ADR-005 §5): неизвестная — не «додумывается».
      this.issues.problems.push(`${this.at}.${name}: валюта вне контракта (RUB, USD, EUR, CNY)`);
      return null;
    }
    return v as Currency;
  }

  // Вложенный справочник: null допустим.
  nested(name: string): Row | null {
    const v = this.raw(name, false);
    if (v === null || v === undefined) return null;
    return new Row(v, `${this.at}.${name}`, this.issues, `${this.scope}.${name}`);
  }
}

// ---------------------------------------------------------------- Конверт

export const envelopeData = (body: unknown, route: string): { data: unknown; nextCursor: string | null } => {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('data' in body)) {
    throw thError('CONTRACT_MISMATCH', 'contract_mismatch', `ответ ${route} без конверта {"data": …}`, false, { route });
  }
  const b = body as { data: unknown; next_cursor?: unknown };
  const cursor = b.next_cursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 2000)) {
    throw thError('CONTRACT_MISMATCH', 'contract_mismatch', `ответ ${route}: некорректный next_cursor`, false, { route });
  }
  return { data: b.data, nextCursor: typeof cursor === 'string' ? cursor : null };
};

const arrayOf = (data: unknown, route: string): unknown[] => {
  if (!Array.isArray(data)) throw thError('CONTRACT_MISMATCH', 'contract_mismatch', `ответ ${route}: data не массив`, false, { route });
  return data;
};

// ---------------------------------------------------------------- Строки маршрутов

export interface ISourceBrief {
  id: string;
  tenderNumber: string;
  title: string | null;
  clientName: string | null;
  version: number | null;
  isArchived: boolean | null;
  submissionDeadline: string | null;
  updatedAt: string | null;
}

export const parseBrief = (data: unknown, issues: RowIssues): ISourceBrief[] =>
  arrayOf(data, 'brief').map((o, i) => {
    const r = new Row(o, `data[${i}]`, issues, 'brief');
    return {
      id: r.uuid('id', true) ?? '',
      tenderNumber: r.str('tender_number', true) ?? '',
      title: r.str('title'),
      clientName: r.str('client_name'),
      version: r.int('version'),
      isArchived: r.bool('is_archived'),
      submissionDeadline: r.str('submission_deadline'),
      updatedAt: r.str('updated_at'),
    };
  });

export interface ISourceOverview {
  id: string;
  tenderNumber: string;
  title: string | null;
  clientName: string | null;
  isArchived: boolean | null;
  cachedGrandTotal: ISourceNumber | null;
  usdRate: ISourceNumber | null;
  eurRate: ISourceNumber | null;
  cnyRate: ISourceNumber | null;
  positionCount: number;
  boqItemCount: number;
  updatedAt: string | null;
}

export const parseOverview = (data: unknown, issues: RowIssues): ISourceOverview => {
  const r = new Row(data, 'data', issues, 'overview');
  return {
    id: r.uuid('id', true) ?? '',
    tenderNumber: r.str('tender_number', true) ?? '',
    title: r.str('title'),
    clientName: r.str('client_name'),
    isArchived: r.bool('is_archived'),
    cachedGrandTotal: r.num('cached_grand_total'),
    usdRate: r.num('usd_rate'),
    eurRate: r.num('eur_rate'),
    cnyRate: r.num('cny_rate'),
    positionCount: r.int('position_count', true) ?? 0,
    boqItemCount: r.int('boq_item_count', true) ?? 0,
    updatedAt: r.str('updated_at'),
  };
};

// Поля позиции, общие у постраничного маршрута и with-costs: по ним сверяются два чтения.
export interface ISourcePositionCommon {
  id: string;
  tenderId: string;
  positionNumber: ISourceNumber | null;
  itemNo: string | null;
  workName: string;
  clientNote: string | null;
  unitCode: string | null;
  volume: ISourceNumber | null;
  manualVolume: ISourceNumber | null;
  manualNote: string | null;
  hierarchyLevel: number | null;
  isAdditional: boolean | null;
  parentPositionId: string | null;
  totalMaterial: ISourceNumber | null;
  totalWorks: ISourceNumber | null;
  updatedAt: string | null;
}

const positionCommon = (r: Row): ISourcePositionCommon => ({
  id: r.uuid('id', true) ?? '',
  tenderId: r.uuid('tender_id', true) ?? '',
  positionNumber: r.num('position_number', true),
  itemNo: r.str('item_no'),
  workName: r.str('work_name', true) ?? '',
  clientNote: r.str('client_note'),
  unitCode: r.str('unit_code'),
  volume: r.num('volume'),
  manualVolume: r.num('manual_volume'),
  manualNote: r.str('manual_note'),
  hierarchyLevel: r.int('hierarchy_level'),
  isAdditional: r.bool('is_additional'),
  parentPositionId: r.uuid('parent_position_id'),
  totalMaterial: r.num('total_material'),
  totalWorks: r.num('total_works'),
  updatedAt: r.str('updated_at'),
});

// GET /tenders/{id}/positions — признаки раздела и категория затрат по строкам позиции.
export interface ISourcePositionPaged extends ISourcePositionCommon {
  sectionNumber: string | null;
  positionName: string | null;
  isSection: boolean;
  costCategoryName: string | null;
}

export const parsePositionsPage = (data: unknown, issues: RowIssues, page: number): ISourcePositionPaged[] =>
  arrayOf(data, 'positions').map((o, i) => {
    const r = new Row(o, `page[${page}].data[${i}]`, issues, 'positions');
    return {
      ...positionCommon(r),
      sectionNumber: r.str('section_number'),
      positionName: r.str('position_name'),
      isSection: r.bool('is_section', true) ?? false,
      costCategoryName: r.str('cost_category_name'),
    };
  });

// GET /tenders/{id}/positions/with-costs — итоги позиции и агрегаты по её строкам.
export interface ISourcePositionCosts extends ISourcePositionCommon {
  materialCostPerUnit: ISourceNumber | null;
  workCostPerUnit: ISourceNumber | null;
  totalCommercialMaterial: ISourceNumber | null;
  totalCommercialWork: ISourceNumber | null;
  totalCommercialMaterialPerUnit: ISourceNumber | null;
  totalCommercialWorkPerUnit: ISourceNumber | null;
  baseTotal: ISourceNumber | null;
  commercialTotal: ISourceNumber | null;
  materialCostTotal: ISourceNumber | null;
  workCostTotal: ISourceNumber | null;
  markupPercentage: ISourceNumber | null;
  itemsCount: number | null;
}

export const parsePositionsWithCosts = (data: unknown, issues: RowIssues): ISourcePositionCosts[] =>
  arrayOf(data, 'positions/with-costs').map((o, i) => {
    const r = new Row(o, `data[${i}]`, issues, 'with_costs');
    return {
      ...positionCommon(r),
      materialCostPerUnit: r.num('material_cost_per_unit'),
      workCostPerUnit: r.num('work_cost_per_unit'),
      totalCommercialMaterial: r.num('total_commercial_material'),
      totalCommercialWork: r.num('total_commercial_work'),
      totalCommercialMaterialPerUnit: r.num('total_commercial_material_per_unit'),
      totalCommercialWorkPerUnit: r.num('total_commercial_work_per_unit'),
      baseTotal: r.num('base_total'),
      commercialTotal: r.num('commercial_total'),
      materialCostTotal: r.num('material_cost_total'),
      workCostTotal: r.num('work_cost_total'),
      markupPercentage: r.num('markup_percentage'),
      itemsCount: r.int('items_count'),
    };
  });

// GET /tenders/{id}/boq-items-full — строки сметы со справочниками.
export interface ISourceBoqItem {
  id: string;
  tenderId: string;
  positionId: string;
  sortNumber: number | null;
  itemType: string;
  materialType: string | null;
  description: string | null;
  unitCode: string | null;
  quantity: ISourceNumber | null;
  baseQuantity: ISourceNumber | null;
  consumptionCoefficient: ISourceNumber | null;
  conversionCoefficient: ISourceNumber | null;
  unitRate: ISourceNumber | null;
  currency: Currency | null;
  deliveryPriceType: string | null;
  deliveryAmount: ISourceNumber | null;
  totalAmount: ISourceNumber | null;
  commercialMarkup: ISourceNumber | null;
  totalCommercialMaterial: ISourceNumber | null;
  totalCommercialWork: ISourceNumber | null;
  quoteLink: string | null;
  workNameId: string | null;
  materialNameId: string | null;
  detailCostCategoryId: string | null;
  parentWorkItemId: string | null;
  workName: string | null;
  materialName: string | null;
  costCategory: string | null;
  detailCostCategory: string | null;
  detailCostLocation: string | null;
  updatedAt: string | null;
}

export const parseBoqItems = (data: unknown, issues: RowIssues): ISourceBoqItem[] =>
  arrayOf(data, 'boq-items-full').map((o, i) => {
    const r = new Row(o, `data[${i}]`, issues, 'boq_items');
    const detail = r.nested('detail_cost_categories');
    return {
      id: r.uuid('id', true) ?? '',
      tenderId: r.uuid('tender_id', true) ?? '',
      positionId: r.uuid('client_position_id', true) ?? '',
      sortNumber: r.int('sort_number'),
      itemType: r.str('boq_item_type', true) ?? '',
      materialType: r.str('material_type'),
      description: r.str('description'),
      unitCode: r.str('unit_code'),
      quantity: r.num('quantity'),
      baseQuantity: r.num('base_quantity'),
      consumptionCoefficient: r.num('consumption_coefficient'),
      conversionCoefficient: r.num('conversion_coefficient'),
      unitRate: r.num('unit_rate'),
      currency: r.currency('currency_type'),
      deliveryPriceType: r.str('delivery_price_type'),
      deliveryAmount: r.num('delivery_amount'),
      totalAmount: r.num('total_amount'),
      commercialMarkup: r.num('commercial_markup'),
      totalCommercialMaterial: r.num('total_commercial_material_cost'),
      totalCommercialWork: r.num('total_commercial_work_cost'),
      quoteLink: r.str('quote_link'),
      workNameId: r.str('work_name_id'),
      materialNameId: r.str('material_name_id'),
      detailCostCategoryId: r.str('detail_cost_category_id'),
      parentWorkItemId: r.uuid('parent_work_item_id'),
      workName: r.nested('work_names')?.str('name') ?? null,
      materialName: r.nested('material_names')?.str('name') ?? null,
      costCategory: detail?.nested('cost_categories')?.str('name') ?? null,
      detailCostCategory: detail?.str('name') ?? null,
      detailCostLocation: detail?.str('location') ?? null,
      updatedAt: r.str('updated_at'),
    };
  });
