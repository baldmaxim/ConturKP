// Десятичная арифметика денег и количеств (ADR-005 §3; D-030 В-10-3): одна библиотека — decimal.js. Точность
// задана с запасом, а каждый результат проверяется: значение, которое потребовало бы округления промежуточного
// результата, — ошибка, а не тихое округление. Округление — только именованной политикой (round2HalfAway).
import DecimalModule from 'decimal.js';
import type { Decimal as DecimalClass } from 'decimal.js';

// ESM-сборка decimal.js экспортирует конструктор по умолчанию, а типы пакета описаны как CommonJS.
const Decimal = DecimalModule as unknown as typeof DecimalClass;
import { isDecimalLexeme } from '../calculation.ts';

const PRECISION = 400;
// Результат с числом значащих цифр у предела точности мог быть округлён библиотекой — такой результат не принимается.
const PRECISION_GUARD = PRECISION - 10;

export const D = Decimal.clone({ precision: PRECISION, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -9e15, toExpPos: 9e15 });
export type Dec = InstanceType<typeof D>;

export class MoneyArithmeticError extends Error {}

const checked = (d: Dec): Dec => {
  if (!d.isFinite()) throw new MoneyArithmeticError('десятичная арифметика: нечисловой результат');
  if (d.sd() >= PRECISION_GUARD) throw new MoneyArithmeticError('десятичная арифметика: результат требует округления промежуточного значения');
  return d;
};

// Десятичная строка источника или БД → число. Только запись десятичного числа (без NaN, Infinity и пробелов).
export const dec = (s: string): Dec => {
  if (!isDecimalLexeme(s)) throw new MoneyArithmeticError(`не десятичная запись: ${s.slice(0, 40)}`);
  return checked(new D(s));
};

export const decOrNull = (s: string | null | undefined): Dec | null => (s === null || s === undefined ? null : dec(s));

export const ZERO: Dec = new D(0);
export const ONE: Dec = new D(1);

export const add = (a: Dec, b: Dec): Dec => checked(a.plus(b));
export const sub = (a: Dec, b: Dec): Dec => checked(a.minus(b));
export const mul = (a: Dec, b: Dec): Dec => checked(a.times(b));
export const sum = (xs: readonly Dec[]): Dec => xs.reduce<Dec>((acc, x) => add(acc, x), ZERO);

// Именованная политика округления: десятичное до 2 знаков, половина — от нуля (как cached_grand_total TenderHub и
// ROUND(numeric, 2) PostgreSQL): 1.005 → 1.01, −1.005 → −1.01.
export const ROUNDING_POLICY = 'money2_half_away' as const;
export const round2HalfAway = (d: Dec): Dec => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

// Деление — только для показа (единичная цена, коэффициент): результат округляется явно заданным числом знаков.
export const divForDisplay = (a: Dec, b: Dec, places: number): Dec | null => (b.isZero() ? null : a.div(b).toDecimalPlaces(places, Decimal.ROUND_HALF_UP));

// Каноническая запись — как trim_scale(numeric)::text PostgreSQL: без экспоненты и хвостовых нулей, «-0» → «0».
export const str = (d: Dec): string => {
  let s = d.toFixed();
  if (s.includes('.')) s = s.replace(/0+$/u, '').replace(/\.$/u, '');
  return s === '-0' ? '0' : s;
};

export const strOrNull = (d: Dec | null): string | null => (d === null ? null : str(d));

// «Совпадает с точностью до хвостов float64 источника»: относительная и абсолютная границы задаются политикой.
export interface ITolerance {
  name: string;
  relative: string;
  absolute: string;
}

export const withinTolerance = (value: Dec, reference: Dec, t: ITolerance): boolean => {
  const bound = D.max(reference.abs().times(t.relative), new D(t.absolute));
  return value.minus(reference).abs().lte(bound);
};
