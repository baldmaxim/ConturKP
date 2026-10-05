// Себестоимость строки TenderHub по формуле источника (D-030, таблица семантики п. 4–7, 13): десятичный пересчёт —
// для сверки, полученные суммы не меняются. Группы материалов и работ — по явному перечню типов, не по префиксу.
// Ограничения исследованной версии источника (количество > 0 и т. п.) — не основание отбрасывать данные: отклонения
// возвращаются флагами и показываются отдельно (§5.9 проекта).
import { add, dec, decOrNull, mul, ONE, sub, withinTolerance, ZERO, type Dec, type ITolerance } from './decimal.ts';

export const MATERIAL_TYPES: readonly string[] = ['мат', 'суб-мат', 'мат-комп.'];
export const WORK_TYPES: readonly string[] = ['раб', 'суб-раб', 'раб-комп.'];

export type LineFormula = 'work' | 'material' | 'not_applicable';
export const formulaOf = (itemType: string): LineFormula => (WORK_TYPES.includes(itemType) ? 'work' : MATERIAL_TYPES.includes(itemType) ? 'material' : 'not_applicable');

// Метод и допуск пересчёта: хвосты float64 источника (L1 живой пробы — не больше 1e-9 относительно).
export const LINE_RECOMPUTE_METHOD = 'tenderhub-0611f20/boq_amount' as const;
export const LINE_TOLERANCE: ITolerance = { name: 'float64_tail', relative: '0.000000001', absolute: '0.000001' };
// Доля доставки «не в цене» — константа исследованного кода источника (п. 6).
export const DELIVERY_NOT_IN_PRICE_RATE = '0.03';

export interface ILineInput {
  externalItemId: string;
  externalPositionId: string;
  itemType: string;
  materialType: string | null;
  unitCode: string | null;
  description: string | null;
  workNameId: string | null;
  materialNameId: string | null;
  detailCostCategoryId: string | null;
  parentWorkExternalItemId: string | null;
  quantity: string | null;
  consumptionCoefficient: string | null;
  conversionCoefficient: string | null;
  unitRate: string | null;
  currency: string | null;
  deliveryPriceType: string | null;
  deliveryAmount: string | null;
  totalAmount: string | null;
  commercialMarkup: string | null;
  totalCommercialMaterial: string | null;
  totalCommercialWork: string | null;
}

export interface IRates {
  USD: string | null;
  EUR: string | null;
  CNY: string | null;
}

// null и RUB — множитель 1 (п. 2); валюта без курса ревизии (или курс ≤ 0) — курса нет.
export const fxOf = (currency: string | null, rates: IRates): Dec | null => {
  if (currency === null || currency === 'RUB') return ONE;
  const raw = currency === 'USD' ? rates.USD : currency === 'EUR' ? rates.EUR : currency === 'CNY' ? rates.CNY : null;
  const rate = decOrNull(raw);
  return rate !== null && rate.gt(0) ? rate : null;
};

export const normalizedCurrency = (currency: string | null): string => currency ?? 'RUB';

const nz = (s: string | null): Dec => decOrNull(s) ?? ZERO;
const coefficient = (s: string | null): Dec => {
  const v = decOrNull(s);
  return v === null || v.isZero() ? ONE : v;
};

// Множители формулы строки (п. 4–7): Q — количество, K — расход (1 у работ и привязанных материалов), R — цена
// в валюте строки, F — курс ревизии, вид доставки и сумма «суммой».
export interface ILineFactors {
  formula: LineFormula;
  q: Dec;
  k: Dec;
  r: Dec;
  f: Dec | null;
  delivery: 'in_price' | 'not_in_price' | 'amount' | 'none';
  deliveryAmount: Dec;
  currency: string;
}

export const lineFactors = (l: ILineInput, rates: IRates): ILineFactors => {
  const formula = formulaOf(l.itemType);
  const delivery =
    formula !== 'material' ? 'none' : l.deliveryPriceType === 'не в цене' ? 'not_in_price' : l.deliveryPriceType === 'суммой' ? 'amount' : l.deliveryPriceType === 'в цене' ? 'in_price' : 'none';
  return {
    formula,
    q: nz(l.quantity),
    k: formula === 'material' && l.parentWorkExternalItemId === null ? coefficient(l.consumptionCoefficient) : ONE,
    r: nz(l.unitRate),
    f: fxOf(l.currency, rates),
    delivery,
    deliveryAmount: nz(l.deliveryAmount),
    currency: normalizedCurrency(l.currency),
  };
};

// Стоимость единицы в ₽: работы — R·F; материалы — R·F·(1 + 0,03 при «не в цене») + доставка «суммой».
export const unitCost = (formula: LineFormula, r: Dec, f: Dec, delivery: ILineFactors['delivery'], deliveryAmount: Dec): Dec => {
  const base = mul(r, f);
  if (formula !== 'material') return base;
  if (delivery === 'not_in_price') return add(base, mul(base, dec(DELIVERY_NOT_IN_PRICE_RATE)));
  if (delivery === 'amount') return add(base, deliveryAmount);
  return base;
};

export const quantityBase = (x: ILineFactors): Dec => (x.formula === 'material' ? mul(x.q, x.k) : x.q);

// Пересчёт себестоимости по формуле; null — формула неприменима (тип вне перечня) или нет курса ревизии.
export const recomputeCost = (x: ILineFactors): Dec | null => {
  if (x.formula === 'not_applicable' || x.f === null) return null;
  return mul(quantityBase(x), unitCost(x.formula, x.r, x.f, x.delivery, x.deliveryAmount));
};

export type LineFlag =
  | 'quantity_nonpositive'
  | 'negative_amount'
  | 'unknown_item_type'
  | 'missing_commercial'
  | 'missing_fx_rate'
  | 'bound_quantity_mismatch'
  | 'recompute_outside_tolerance';

export const LINE_FLAGS: readonly LineFlag[] = [
  'quantity_nonpositive',
  'negative_amount',
  'unknown_item_type',
  'missing_commercial',
  'missing_fx_rate',
  'bound_quantity_mismatch',
  'recompute_outside_tolerance',
];

export interface ILineCheck {
  externalItemId: string;
  formula: LineFormula;
  recomputedCost: Dec | null;
  deviation: Dec | null;
  withinTolerance: boolean | null;
  derivedQuantity: Dec | null;
  flags: LineFlag[];
}

// Выведенное количество привязанного материала — диагностика (п. 4): qty работы × conversion × consumption,
// пустые и нулевые коэффициенты — 1. Хранимое количество им не заменяется.
export const derivedBoundQuantity = (child: ILineInput, parent: ILineInput | undefined): Dec | null => {
  if (child.parentWorkExternalItemId === null || !parent || parent.quantity === null) return null;
  return mul(mul(dec(parent.quantity), coefficient(child.conversionCoefficient)), coefficient(child.consumptionCoefficient));
};

const negative = (s: string | null): boolean => s !== null && dec(s).isNegative() && !dec(s).isZero();

export const checkLine = (l: ILineInput, rates: IRates, parent: ILineInput | undefined): ILineCheck => {
  const x = lineFactors(l, rates);
  const flags: LineFlag[] = [];
  const quantity = decOrNull(l.quantity);
  if (quantity === null || quantity.lte(0)) flags.push('quantity_nonpositive');
  if ([l.unitRate, l.deliveryAmount, l.totalAmount, l.totalCommercialMaterial, l.totalCommercialWork].some(negative)) flags.push('negative_amount');
  if (x.formula === 'not_applicable') flags.push('unknown_item_type');
  if (l.totalCommercialMaterial === null && l.totalCommercialWork === null) flags.push('missing_commercial');
  if (x.formula !== 'not_applicable' && x.f === null) flags.push('missing_fx_rate');
  const derived = derivedBoundQuantity(l, parent);
  if (derived !== null && (quantity === null || !withinTolerance(quantity, derived, LINE_TOLERANCE))) flags.push('bound_quantity_mismatch');
  const recomputed = recomputeCost(x);
  const total = decOrNull(l.totalAmount);
  const deviation = recomputed !== null && total !== null ? sub(total, recomputed) : null;
  const within = recomputed !== null && total !== null ? withinTolerance(total, recomputed, LINE_TOLERANCE) : null;
  if (within === false) flags.push('recompute_outside_tolerance');
  return { externalItemId: l.externalItemId, formula: x.formula, recomputedCost: recomputed, deviation, withinTolerance: within, derivedQuantity: derived, flags };
};
