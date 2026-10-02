// Числовой гейт ответного ядра (этап 08a): перенос Locus `apps/rag-api/src/answer-core/claim-numbers.js`
// (HEAD 33c6bcf) дословно — те же регулярные выражения, классы единиц и правила сравнения; изменены только типы.
// Числа читаются вместе с классом единицы (процент, срок, деньги, дата), поэтому «3%» не подтверждается
// «30 дней» или «3 года»; коды и ссылки (B30, КС-2, 15-П, W8, п. 3.1, № 2, статья 719) числами не считаются.

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const MONTH_NAME = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';

const NUMBER = String.raw`\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
// Не величина: часть кода или имени (B30, КС-2, 15-П, W8) или ссылка (п. 3.1, № 2, статья 719).
const NOT_AFTER = String.raw`(?<![\p{L}\d.,/\-])`;
// Только целые слова: «НДС 20%» — процент, а не ссылка на «ДС».
const REFERENCE_BEFORE = /(?:(?<![\p{L}])(?:п\.|пп\.|пункт\p{L}*|N|ст\.|стать\p{L}*|раздел\p{L}*|глав\p{L}*|приложени\p{L}*|абзац\p{L}*|дс|акт\p{L}*)|№)\s*$/iu;
// Пояснение в скобках между числом и единицей: «245 000 000 (двести сорок пять миллионов) рублей».
const PARENTHETICAL = String.raw`(?:\s*\([^)]{0,120}\))?`;

const UNIT_RULES: [QuantityUnit, RegExp][] = [
  ['percent', /^\s*(?:%|процент)/iu],
  ['day', /^\s*(?:(?:календарн|рабоч|банковск)\p{L}*\s+)?(?:дн(?![\p{L}])|дн[яеи]\p{L}*|день|сут\p{L}*)/iu],
  ['week', /^\s*недел\p{L}*/iu],
  ['month', /^\s*(?:месяц\p{L}*|мес\.?(?![\p{L}]))/iu],
  ['year', /^\s*(?:год\p{L}*|лет(?![\p{L}])|г\.)/iu],
  ['currency', /^\s*(?:(?:тыс|млн|млрд)\.?\s*)?(?:руб\p{L}*|₽|р\.)/iu],
];

const MULTIPLIER: [RegExp, number][] = [
  [/^\s*тыс/iu, 1e3],
  [/^\s*млн/iu, 1e6],
  [/^\s*млрд/iu, 1e9],
];
const DURATION_IN_MONTHS: Partial<Record<QuantityUnit, number>> = { month: 1, year: 12 };

export type QuantityUnit = 'percent' | 'day' | 'week' | 'month' | 'year' | 'currency' | 'date' | 'calendar_year' | 'fraction' | 'number';

export interface IQuantity {
  unit: QuantityUnit;
  value: number | string;
  raw: string;
  index: number;
}

export const DURATION_UNITS: ReadonlySet<QuantityUnit> = new Set<QuantityUnit>(['day', 'week', 'month', 'year']);

const parseNumber = (raw: string): number => Number(String(raw).replace(/[   ]/g, '').replace(',', '.'));

const isoDate = (day: string | number, month: string | number, year: string | number): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// unit: percent | day | week | month | year | currency | date | calendar_year | fraction | number
export const extractQuantities = (text = ''): IQuantity[] => {
  const source = String(text || '');
  const quantities: IQuantity[] = [];
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number): boolean => taken.some(([from, to]) => start < to && end > from);
  const take = (start: number, end: number, quantity: Omit<IQuantity, 'index'>): void => {
    taken.push([start, end]);
    quantities.push({ ...quantity, index: start });
  };

  for (const match of source.matchAll(/(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/g)) {
    take(match.index, match.index + match[0].length, { unit: 'date', value: isoDate(match[1]!, match[2]!, match[3]!), raw: match[0] });
  }
  for (const match of source.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTH_NAME})\\s+(\\d{4})`, 'giu'))) {
    const month = MONTHS.findIndex((stem) => match[2]!.toLowerCase().startsWith(stem)) + 1;
    if (month > 0) take(match.index, match.index + match[0].length, { unit: 'date', value: isoDate(match[1]!, month, match[3]!), raw: match[0] });
  }
  for (const match of source.matchAll(/(?<![\d/])(\d+)\s*\/\s*(\d+)(?![\d/])/g)) {
    if (overlaps(match.index, match.index + match[0].length)) continue;
    take(match.index, match.index + match[0].length, { unit: 'fraction', value: `${match[1]}/${match[2]}`, raw: match[0] });
  }

  for (const match of source.matchAll(new RegExp(`${NOT_AFTER}(${NUMBER})(?![\\p{L}\\d]|-\\p{L})`, 'gu'))) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(start, end)) continue;
    if (REFERENCE_BEFORE.test(source.slice(Math.max(0, start - 14), start))) continue;
    let value = parseNumber(match[1]!);
    const rest = source.slice(end).replace(new RegExp(`^${PARENTHETICAL}`, 'u'), '');
    const [unit = 'number'] = UNIT_RULES.find(([, pattern]) => pattern.test(rest)) ?? [];
    // «245 млн» без «руб.» — то же число, что «245 000 000»: множитель масштабирует и голое число.
    if (unit === 'currency' || unit === 'number') {
      const multiplier = MULTIPLIER.find(([pattern]) => pattern.test(rest));
      if (multiplier) value *= multiplier[1];
    }
    if (unit === 'year' && Number.isInteger(value) && value >= 1900 && value <= 2100) {
      take(start, end, { unit: 'calendar_year', value, raw: match[0] });
      continue;
    }
    take(start, end, { unit, value, raw: match[0] });
  }
  return quantities.sort((left, right) => left.index - right.index);
};

const sameNumber = (left: number | string, right: number | string): boolean => Math.abs(Number(left) - Number(right)) < 1e-9;

const durationMonths = (quantity: IQuantity): number | null => {
  const factor = DURATION_IN_MONTHS[quantity.unit];
  return factor ? Number(quantity.value) * factor : null;
};

// true, когда величина основания говорит то же, что величина утверждения (значение и класс единицы).
const supports = (claim: IQuantity, evidence: IQuantity): boolean => {
  if (claim.unit === 'date') return evidence.unit === 'date' && evidence.value === claim.value;
  if (claim.unit === 'calendar_year') {
    return (evidence.unit === 'calendar_year' && sameNumber(evidence.value, claim.value)) || (evidence.unit === 'date' && String(evidence.value).startsWith(`${claim.value}-`));
  }
  if (claim.unit === 'fraction') return evidence.unit === 'fraction' && evidence.value === claim.value;
  // Голое число подтверждается только голым числом или суммой (строки таблиц), но не процентом, сроком или
  // долей с теми же цифрами: «Сумма аванса — 10» не равно «аванс 10%».
  if (claim.unit === 'number') return (evidence.unit === 'number' || evidence.unit === 'currency') && sameNumber(evidence.value, claim.value);
  if (claim.unit === 'currency') {
    // В строках таблиц суммы идут без слова валюты («| Итого по смете | 244 800 000 |»).
    return (evidence.unit === 'currency' || (evidence.unit === 'number' && Number(claim.value) >= 1000)) && sameNumber(evidence.value, claim.value);
  }
  if (evidence.unit === claim.unit) return sameNumber(evidence.value, claim.value);
  const claimMonths = durationMonths(claim);
  const evidenceMonths = durationMonths(evidence);
  return claimMonths !== null && evidenceMonths !== null && sameNumber(claimMonths, evidenceMonths);
};

export type QuantityStatus = 'ok' | 'ambiguous' | 'unit_mismatch' | 'missing';

// Каждая величина утверждения сравнивается с величинами процитированных оснований.
// «ambiguous»: голое число, которое основание называет и суммой, и с другой единицей («аванс 10%, комиссия
// 10 рублей»), — какое из них имеет в виду утверждение, без контекста не решить.
export const compareQuantities = (claimText: string, evidenceTexts: readonly string[] = []): { quantity: IQuantity; status: QuantityStatus }[] => {
  const evidence = evidenceTexts.flatMap((text) => extractQuantities(text));
  return extractQuantities(claimText).map((quantity) => {
    const sameValue = (item: IQuantity): boolean => typeof item.value === 'number' && typeof quantity.value === 'number' && sameNumber(item.value, quantity.value);
    if (evidence.some((item) => supports(quantity, item))) {
      const otherUnit = quantity.unit === 'number' && evidence.some((item) => sameValue(item) && item.unit !== 'number' && item.unit !== 'currency');
      return { quantity, status: otherUnit ? 'ambiguous' : 'ok' };
    }
    return { quantity, status: evidence.some(sameValue) ? 'unit_mismatch' : 'missing' };
  });
};
