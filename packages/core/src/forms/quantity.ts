// Величина источника в единицах поля (этап 11; Review 11-1 R11-04; D-031 В-11-6, В-11-10; I10). Число из фразы факта
// или цитаты берётся вместе с классом единицы, масштабом («тыс.», «млн», «млрд») и валютой источника. В единицы поля оно
// переводится только точным сдвигом десятичной запятой внутри одной валюты; другая валюта, другой вид дней, срок в
// годах для поля в месяцах, сумма без валюты — «неизвестно»: предложения нет, сверка — «не сверено». Без вычислений
// моделью и без float.
import { extractQuantities } from '../answers/claimNumbers.ts';
import { dec, mul, str, D } from '../money/decimal.ts';
import { normalizeNumber } from './values.ts';

export type DayKind = 'working' | 'calendar' | 'banking' | 'unspecified';

export type UnitClass =
  | { kind: 'money'; currency: string; exp: number }
  | { kind: 'day'; dayKind: DayKind }
  | { kind: 'percent' | 'week' | 'month' | 'year' | 'plain' | 'unknown' };

type ReadingKind = 'money' | 'scaled' | 'plain' | 'percent' | 'day' | 'week' | 'month' | 'year';

interface IReading {
  index: number;
  digits: string;
  kind: ReadingKind;
  currency: string | null;
  exp: number;
  dayKind: DayKind;
}

const SCALES: [RegExp, number][] = [
  [/^тыс\p{L}*\.?\s*/u, 3],
  [/^млн\p{L}*\.?\s*/u, 6],
  [/^млрд\p{L}*\.?\s*/u, 9],
];

const CURRENCIES: [RegExp, string][] = [
  [/^(?:руб\p{L}*|₽|р\.|rub(?![\p{L}]))/u, 'RUB'],
  [/^(?:тенге|₸|kzt(?![\p{L}]))/u, 'KZT'],
  [/^(?:usd(?![\p{L}])|\$|долл\p{L}*)/u, 'USD'],
  [/^(?:eur(?![\p{L}])|€|евро(?![\p{L}]))/u, 'EUR'],
  [/^(?:cny(?![\p{L}])|юан\p{L}*)/u, 'CNY'],
];

const scaleOf = (s: string): { exp: number; rest: string } => {
  for (const [re, exp] of SCALES) {
    const m = re.exec(s);
    if (m) return { exp, rest: s.slice(m[0].length) };
  }
  return { exp: 0, rest: s };
};

const currencyOf = (s: string): string | null => CURRENCIES.find(([re]) => re.test(s))?.[1] ?? null;

const dayKindOf = (s: string): DayKind =>
  /^раб/u.test(s) ? 'working' : /^кал/u.test(s) ? 'calendar' : /^банк/u.test(s) ? 'banking' : 'unspecified';

// Класс единицы поля по схеме: валюта — `currency` или слово единицы; масштаб — приставка единицы («млн руб.»).
export const fieldUnitClass = (f: { unit?: string | null; currency?: string | null }): UnitClass => {
  const unit = (f.unit ?? '').trim().toLowerCase();
  const { exp, rest } = scaleOf(unit);
  const named = currencyOf(rest);
  if (f.currency || named) {
    if (f.currency && named && f.currency !== named) return { kind: 'unknown' };
    return { kind: 'money', currency: (f.currency || named)!, exp };
  }
  if (unit === '%') return { kind: 'percent' };
  const day = /^(?:(раб|кал|банк)\p{L}*\.?\s*)?(?:дн|день|сут)/u.exec(unit);
  if (day) return { kind: 'day', dayKind: dayKindOf(day[1] ?? '') };
  if (/^нед/u.test(unit)) return { kind: 'week' };
  if (/^мес/u.test(unit)) return { kind: 'month' };
  if (/^(?:лет|год)/u.test(unit)) return { kind: 'year' };
  return unit === '' ? { kind: 'plain' } : { kind: 'unknown' };
};

// Величины текста с классом единицы, масштабом, валютой и видом дней источника.
const readingsOf = (text: string): IReading[] =>
  extractQuantities(text).flatMap((q): IReading[] => {
    const digits = normalizeNumber(q.raw);
    if (digits === null) return [];
    const after = text
      .slice(q.index + q.raw.length)
      .replace(/^\s*\([^)]{0,120}\)/u, '')
      .replace(/^\s+/u, '')
      .toLowerCase();
    const base = { index: q.index, digits, currency: null, exp: 0, dayKind: 'unspecified' as DayKind };
    switch (q.unit) {
      case 'currency':
      case 'number': {
        const { exp, rest } = scaleOf(after);
        const currency = currencyOf(rest);
        if (currency) return [{ ...base, kind: 'money', currency, exp }];
        return [{ ...base, kind: exp > 0 ? 'scaled' : 'plain', exp }];
      }
      case 'percent':
        return [{ ...base, kind: 'percent' }];
      case 'day':
        return [{ ...base, kind: 'day', dayKind: dayKindOf(after) }];
      case 'week':
      case 'month':
      case 'year':
        return [{ ...base, kind: q.unit }];
      default:
        return [];
    }
  });

// Точный сдвиг десятичной запятой: 25 000 000 руб. → 25 млн руб.
const shift = (digits: string, exp: number): string => (exp === 0 ? digits : str(mul(dec(digits), new D(10).pow(exp))));

const inFieldUnits = (cls: UnitClass, r: IReading): string | null => {
  switch (cls.kind) {
    case 'money':
      return r.kind === 'money' && r.currency === cls.currency ? shift(r.digits, r.exp - cls.exp) : null;
    case 'day':
      return r.kind === 'day' && r.dayKind === cls.dayKind ? r.digits : null;
    case 'percent':
    case 'week':
    case 'month':
    case 'year':
    case 'plain':
      return r.kind === cls.kind ? r.digits : null;
    default:
      return null;
  }
};

// Величины, которые могут относиться к полю этого класса (первая из них — значение фразы факта).
const candidateKinds = (cls: UnitClass): ReadonlySet<ReadingKind> => {
  switch (cls.kind) {
    case 'money':
    case 'plain':
      return new Set<ReadingKind>(['money', 'scaled', 'plain']);
    case 'percent':
      return new Set<ReadingKind>(['percent']);
    case 'day':
    case 'week':
    case 'month':
    case 'year':
      return new Set<ReadingKind>(['day', 'week', 'month', 'year']);
    default:
      return new Set<ReadingKind>();
  }
};

// Значение фразы факта в единицах поля. `text` — фраза факта; `context` — та же фраза с продолжением во фрагменте
// источника (валюта и масштаб идут после числа: «составляет 25 000 000 руб.»). Берётся первая величина фразы того же
// рода; если её единица, масштаб или валюта не определены или отличаются — null.
export const factValueInFieldUnits = (f: { unit?: string | null; currency?: string | null }, text: string, context: string | null = null): string | null => {
  const cls = fieldUnitClass(f);
  const kinds = candidateKinds(cls);
  const source = context && context.startsWith(text) ? context : text;
  const first = readingsOf(source).find((r) => r.index < text.length && kinds.has(r.kind));
  return first ? inFieldUnits(cls, first) : null;
};

// Число предложения модели есть в одной из цитат в единицах поля (I10: модель не считает и не переводит валюту).
export const numberInQuotes = (f: { unit?: string | null; currency?: string | null }, value: string, quotes: readonly string[]): boolean => {
  const cls = fieldUnitClass(f);
  const v = normalizeNumber(value);
  if (v === null) return false;
  return quotes.some((q) =>
    readingsOf(q).some((r) => {
      const x = inFieldUnits(cls, r);
      return x !== null && dec(x).eq(dec(v));
    }),
  );
};
