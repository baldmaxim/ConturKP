// Единственная точка сравнения денег (ADR-005 §5; D-030 В-10-2): прямое сравнение сумм разных видов, валют, НДС или
// баз единицы в коде запрещено. Несопоставимость — результат с причиной, а не замечание о расхождении (A18, A19, A21).
export type MoneyCurrency = 'RUB' | 'USD' | 'EUR' | 'CNY' | 'UNKNOWN';
export type MoneyVat = 'included' | 'excluded' | 'not_applicable' | 'unknown';
export type PriceKind = 'cost' | 'supplier_quote' | 'commercial' | 'unknown';

export interface IMoneyBasis {
  currency: MoneyCurrency;
  vat: MoneyVat;
  priceKind: PriceKind;
  // База единицы после явного пересчёта объёма (например «шт»); null — итог без единицы.
  unitBase: string | null;
  // Поле источника и версия его семантики: при неизвестном НДС сравниваются только значения одного поля и одного
  // вида цены (D-030 В-10-2).
  field: string | null;
  semanticsVersion: string | null;
}

export type IncomparableCode = 'price_kind_differs' | 'price_kind_unknown' | 'currency_differs' | 'currency_unknown' | 'unit_base_differs' | 'vat_differs' | 'vat_unknown';

export type Comparability =
  | { comparable: true; basis: 'same_attributes' | 'same_source_field' }
  | { comparable: false; code: IncomparableCode; reason: string };

const PRICE_KIND_TITLE: Record<PriceKind, string> = {
  cost: 'себестоимость',
  supplier_quote: 'цена поставщика',
  commercial: 'коммерческая цена',
  unknown: 'неизвестный вид цены',
};

const no = (code: IncomparableCode, reason: string): Comparability => ({ comparable: false, code, reason });

export const comparable = (a: IMoneyBasis, b: IMoneyBasis): Comparability => {
  if (a.priceKind === 'unknown' || b.priceKind === 'unknown') return no('price_kind_unknown', 'вид цены неизвестен');
  if (a.priceKind !== b.priceKind) {
    return no('price_kind_differs', `разные виды цены: ${PRICE_KIND_TITLE[a.priceKind]} и ${PRICE_KIND_TITLE[b.priceKind]} — наценка сама по себе не расхождение`);
  }
  if (a.currency === 'UNKNOWN' || b.currency === 'UNKNOWN') return no('currency_unknown', 'валюта неизвестна');
  if (a.currency !== b.currency) return no('currency_differs', `разные валюты: ${a.currency} и ${b.currency} — без курса ревизии не сравниваются`);
  if (a.unitBase !== b.unitBase) return no('unit_base_differs', `разные базы единицы: ${a.unitBase ?? 'итог'} и ${b.unitBase ?? 'итог'} — нужен явный пересчёт объёма`);
  if (a.vat !== b.vat) return no('vat_differs', `разный признак НДС: ${a.vat} и ${b.vat}`);
  if (a.vat === 'unknown') {
    if (a.field !== null && a.field === b.field && a.semanticsVersion !== null && a.semanticsVersion === b.semanticsVersion) {
      return { comparable: true, basis: 'same_source_field' };
    }
    return no('vat_unknown', 'НДС неизвестен: сравниваются только значения одного поля и одного вида цены');
  }
  return { comparable: true, basis: 'same_attributes' };
};
