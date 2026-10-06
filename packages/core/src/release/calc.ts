// Связь числа приложения с расчётом (этап 12; D-032 В-12-6). Связь задаётся в схеме явно: величина расчёта
// (`calc.quantity`), а ревизия — закреплённая в кандидате; единица и валюта — поля. Перевод — точный сдвиг запятой
// внутри одной валюты (`forms/quantity.ts`), затем округление до `scale` поля именованной политикой «от нуля».
// Неизвестная величина, другая валюта или неизвестная единица — «не сверено», а не совпадение. Сверка с
// `source_grand_total` (cached_grand_total TenderHub, D-030 В-10-1) — только «итог источника»: Q-05 не закрывает.
import { fieldUnitClass } from '../forms/quantity.ts';
import type { CalcQuantity } from '../forms/schema.ts';
import { normalizeNumber } from '../forms/values.ts';
import { D, dec, mul, str } from '../money/decimal.ts';

// Величины расчёта с подтверждённой семантикой (D-030, таблица §3): обе — рубли, коммерческие стоимости с НДС.
export const CALC_QUANTITIES: Record<CalcQuantity, { title: string; currency: 'RUB' }> = {
  source_grand_total: { title: 'итог источника (cached_grand_total TenderHub)', currency: 'RUB' },
  commercial_total: { title: 'Σ коммерческих стоимостей строк ревизии', currency: 'RUB' },
};

export type CalcMatch =
  | { outcome: 'match'; expected: string }
  | { outcome: 'mismatch'; expected: string }
  | { outcome: 'unverified'; reason: string };

export const compareWithCalculation = (
  field: { unit?: string | null; currency?: string | null; scale?: number },
  fieldValue: string | null,
  quantity: CalcQuantity,
  calcValue: string | null,
): CalcMatch => {
  const q = CALC_QUANTITIES[quantity];
  if (calcValue === null) return { outcome: 'unverified', reason: `в закреплённой ревизии расчёта нет величины «${q.title}»` };
  const own = fieldValue === null ? null : normalizeNumber(fieldValue);
  if (own === null) return { outcome: 'unverified', reason: 'у поля нет числового значения' };
  const cls = fieldUnitClass(field);
  if (cls.kind !== 'money') return { outcome: 'unverified', reason: 'единица поля — не денежная: перевод не определён' };
  if (cls.currency !== q.currency) return { outcome: 'unverified', reason: `валюта поля ${cls.currency} ≠ валюте расчёта ${q.currency}: конвертация не задана` };
  const inField = mul(dec(calcValue), new D(10).pow(-cls.exp));
  const expected = field.scale === undefined ? inField : inField.toDecimalPlaces(field.scale, D.ROUND_HALF_UP);
  const e = str(expected);
  return dec(own).eq(expected) ? { outcome: 'match', expected: e } : { outcome: 'mismatch', expected: e };
};
