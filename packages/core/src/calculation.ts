// Расчёт TenderHub (этап 06; ADR-005 §1–2, ADR-007 §5–8, data-model §4.5, state-machines §6).
// Числа живут строками десятичной записи от лексемы источника до БД и API: промежуточного float нет.
import { createHash } from 'node:crypto';

// Версия нормализации выгрузки: входит в хэш содержимого. Изменение правил нормализации — новая версия.
export const CALCULATION_NORMALIZATION_VERSION = 'th1';

// Пределы лексемы числа: float64 источника не выходит за 1e±324, поэтому всё длиннее — не число контракта.
const MAX_LEXEME_LENGTH = 400;
const MAX_EXPONENT = 400;
const JSON_NUMBER = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u;

export const isDecimalLexeme = (lexeme: string): boolean => {
  if (lexeme.length === 0 || lexeme.length > MAX_LEXEME_LENGTH) return false;
  const m = JSON_NUMBER.exec(lexeme);
  return m !== null && Math.abs(Number(m[4] ?? '0')) <= MAX_EXPONENT;
};

// Каноническая десятичная запись — та же, что даёт PostgreSQL для trim_scale(numeric)::text:
// без экспоненты, без ведущих нулей целой части и хвостовых нулей дробной, «-0» → «0».
export const canonicalDecimal = (lexeme: string): string => {
  const m = JSON_NUMBER.exec(lexeme);
  if (!m || !isDecimalLexeme(lexeme)) throw new Error('не десятичная лексема числа');
  const negative = m[1] === '-';
  const intPart = m[2]!;
  const fracPart = m[3] ?? '';
  const exp = Number(m[4] ?? '0');
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  let whole: string;
  let frac: string;
  if (point <= 0) {
    whole = '0';
    frac = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + '0'.repeat(point - digits.length);
    frac = '';
  } else {
    whole = digits.slice(0, point);
    frac = digits.slice(point);
  }
  whole = whole.replace(/^0+(?=\d)/u, '');
  frac = frac.replace(/0+$/u, '');
  const body = frac ? `${whole}.${frac}` : whole;
  return negative && /[1-9]/u.test(body) ? `-${body}` : body;
};

// Текст источника перед записью: одиночные суррогаты и NUL PostgreSQL не хранит — они заменяются
// символом U+FFFD до хэширования, чтобы хэш приложения и БД считались по одному и тому же тексту.
export const storableText = (value: string): string => value.toWellFormed().replace(/\u0000/gu, '�');

// ---------------------------------------------------------------- Содержимое

// Числа — каноническая десятичная запись (строка) или null; целые — number.
export interface ICalcContentHeader {
  normalizationVersion: string;
  sourceGrandTotal: string | null;
  usdRate: string | null;
  eurRate: string | null;
  cnyRate: string | null;
  // Итог КП и правило: пусты, пока владелец не задал правило (Q-05).
  kpTotal: string | null;
  kpTotalCurrency: 'RUB' | 'USD' | 'EUR' | 'CNY' | null;
  kpTotalRule: string | null;
}

export interface ICalcPosition {
  externalPositionId: string;
  positionNumber: string;
  itemNo: string | null;
  workName: string;
  unitCode: string | null;
  volume: string | null;
  manualVolume: string | null;
  manualNote: string | null;
  clientNote: string | null;
  sectionNumber: string | null;
  positionName: string | null;
  isSection: boolean;
  isAdditional: boolean | null;
  hierarchyLevel: number | null;
  parentExternalPositionId: string | null;
  costCategoryName: string | null;
  totalMaterial: string | null;
  totalWorks: string | null;
  materialCostPerUnit: string | null;
  workCostPerUnit: string | null;
  totalCommercialMaterial: string | null;
  totalCommercialWork: string | null;
  totalCommercialMaterialPerUnit: string | null;
  totalCommercialWorkPerUnit: string | null;
  baseTotal: string | null;
  commercialTotal: string | null;
  materialCostTotal: string | null;
  workCostTotal: string | null;
  markupPercentage: string | null;
  itemsCount: number | null;
  // Исходные лексемы чисел по именам полей источника (ADR-005 §1).
  rawLexemes: Record<string, string>;
}

export interface ICalcLine {
  externalItemId: string;
  externalPositionId: string;
  sortNumber: number | null;
  itemType: string;
  materialType: string | null;
  description: string | null;
  workName: string | null;
  materialName: string | null;
  unitCode: string | null;
  quantity: string | null;
  baseQuantity: string | null;
  consumptionCoefficient: string | null;
  conversionCoefficient: string | null;
  unitRate: string | null;
  currency: 'RUB' | 'USD' | 'EUR' | 'CNY' | null;
  deliveryPriceType: string | null;
  deliveryAmount: string | null;
  totalAmount: string | null;
  commercialMarkup: string | null;
  totalCommercialMaterial: string | null;
  totalCommercialWork: string | null;
  quoteLink: string | null;
  costCategory: string | null;
  detailCostCategory: string | null;
  detailCostLocation: string | null;
  workNameId: string | null;
  materialNameId: string | null;
  detailCostCategoryId: string | null;
  parentWorkExternalItemId: string | null;
  rawLexemes: Record<string, string>;
}

export interface ICalcContent {
  header: ICalcContentHeader;
  positions: ICalcPosition[];
  lines: ICalcLine[];
}

// Кодирование полей — то же, что calc_enc_* в миграции 0011: менять вместе.
const encText = (v: string | null): string => (v === null ? '~' : JSON.stringify(v));
const encNum = (v: string | null): string => (v === null ? '~' : v);
const encInt = (v: number | null): string => (v === null ? '~' : String(v));
const encBool = (v: boolean | null): string => (v === null ? '~' : v ? 't' : 'f');
const encUuid = (v: string | null): string => (v === null ? '~' : v.toLowerCase());

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Каноническая строка содержимого (формат calculation_content_hash в миграции 0011).
export const calculationContentText = (c: ICalcContent): string => {
  const h = c.header;
  const out: string[] = [
    'kontur.calculation_content.v1\n',
    `H|${encText(h.normalizationVersion)}|${encNum(h.sourceGrandTotal)}|${encNum(h.usdRate)}|${encNum(h.eurRate)}|${encNum(h.cnyRate)}` +
      `|${encNum(h.kpTotal)}|${encText(h.kpTotalCurrency)}|${encText(h.kpTotalRule)}|${encInt(c.positions.length)}|${encInt(c.lines.length)}\n`,
  ];
  const positions = [...c.positions].sort((a, b) => byKey(a.externalPositionId.toLowerCase(), b.externalPositionId.toLowerCase()));
  for (const p of positions) {
    out.push(
      [
        'P',
        encUuid(p.externalPositionId),
        encNum(p.positionNumber),
        encText(p.itemNo),
        encText(p.workName),
        encText(p.unitCode),
        encNum(p.volume),
        encNum(p.manualVolume),
        encText(p.manualNote),
        encText(p.clientNote),
        encText(p.sectionNumber),
        encText(p.positionName),
        encBool(p.isSection),
        encBool(p.isAdditional),
        encInt(p.hierarchyLevel),
        encUuid(p.parentExternalPositionId),
        encText(p.costCategoryName),
        encNum(p.totalMaterial),
        encNum(p.totalWorks),
        encNum(p.materialCostPerUnit),
        encNum(p.workCostPerUnit),
        encNum(p.totalCommercialMaterial),
        encNum(p.totalCommercialWork),
        encNum(p.totalCommercialMaterialPerUnit),
        encNum(p.totalCommercialWorkPerUnit),
        encNum(p.baseTotal),
        encNum(p.commercialTotal),
        encNum(p.materialCostTotal),
        encNum(p.workCostTotal),
        encNum(p.markupPercentage),
        encInt(p.itemsCount),
      ].join('|') + '\n',
    );
  }
  const lines = [...c.lines].sort((a, b) => byKey(a.externalItemId.toLowerCase(), b.externalItemId.toLowerCase()));
  for (const l of lines) {
    out.push(
      [
        'L',
        encUuid(l.externalItemId),
        encUuid(l.externalPositionId),
        encInt(l.sortNumber),
        encText(l.itemType),
        encText(l.materialType),
        encText(l.description),
        encText(l.workName),
        encText(l.materialName),
        encText(l.unitCode),
        encNum(l.quantity),
        encNum(l.baseQuantity),
        encNum(l.consumptionCoefficient),
        encNum(l.conversionCoefficient),
        encNum(l.unitRate),
        encText(l.currency),
        encText(l.deliveryPriceType),
        encNum(l.deliveryAmount),
        encNum(l.totalAmount),
        encNum(l.commercialMarkup),
        encNum(l.totalCommercialMaterial),
        encNum(l.totalCommercialWork),
        encText(l.quoteLink),
        encText(l.costCategory),
        encText(l.detailCostCategory),
        encText(l.detailCostLocation),
        encText(l.workNameId),
        encText(l.materialNameId),
        encText(l.detailCostCategoryId),
        encUuid(l.parentWorkExternalItemId),
      ].join('|') + '\n',
    );
  }
  return out.join('');
};

// Хэш содержимого (data-model §5): позиции, строки, итог КП с правилом, значения источника и курсы,
// версия нормализации. БД пересчитывает его той же формулой и не фиксирует содержимое при расхождении.
export const calculationContentHash = (c: ICalcContent): string =>
  createHash('sha256').update(calculationContentText(c), 'utf8').digest('hex');

// Итог КП не выводится, пока владелец не задал правило (Q-05): описание остаётся в содержимом.
export const KP_TOTAL_RULE_NOT_SET = {
  status: 'rule_not_set',
  question: 'Q-05',
  note: 'правило итога КП не задано владельцем; ни один показатель TenderHub итогом КП не объявлен',
  unavailableComponents: ['insurance', 'reduction', 'redistribution'],
} as const;

// ---------------------------------------------------------------- Production gate (state-machines §11.1)

export type CalculationRevisionKind = 'provisional' | 'verified';

// Боевой выпуск с ревизией provisional блокируется CALCULATION_PROVISIONAL независимо от назначений
// доставки (ADR-007 §5). Блокер неотключаемый: снимается только решением владельца по Q-01, которого нет.
export const calculationProductionBlockers = (kind: CalculationRevisionKind): 'CALCULATION_PROVISIONAL'[] =>
  kind === 'provisional' ? ['CALCULATION_PROVISIONAL'] : [];
