// Значения полей формы (этап 11; проект §5.1, D-031 В-11-10): проверка и нормализация по схеме ревизии, условия
// применимости и обязательности. Число — точная десятичная строка (ADR-005, без float); дата — ГГГГ-ММ-ДД; текст
// хранится без обрезания и изменения (длинная формулировка); таблица — строки с ячейками по колонкам.
import { isDecimalLexeme } from '../calculation.ts';
import { dec, str } from '../money/decimal.ts';
import { allFields, TEXT_DEFAULT_MAX, TABLE_HARD_MAX_ROWS, type Condition, type IChoiceOption, type IField, type IFormSchema, type ITableColumn } from './schema.ts';

export type CellValue = string | string[] | null;
export type TableRow = Record<string, CellValue>;
export type FieldValue = string | string[] | TableRow[];

export type ValueCheck = { ok: true; value: FieldValue } | { ok: false; errors: string[] };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export const isEmptyValue = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

// «2,5», «1 000» → «2.5», «1000»; только запись числа, без вычислений.
export const normalizeNumber = (raw: string): string | null => {
  const s = raw.replace(/[\s ]/gu, '').replace(',', '.');
  // Только обычная запись: без экспоненты и знака «+» — значение вводит человек или берётся из цитаты.
  if (!/^-?\d+(\.\d+)?$/u.test(s) || !isDecimalLexeme(s)) return null;
  return str(dec(s));
};

export const isValidDate = (s: string): boolean => {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

const checkNumber = (raw: unknown, f: { scale?: number; min?: string; max?: string }, errors: string[], label: string): string | null => {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    errors.push(`${label}: число записывается строкой`);
    return null;
  }
  const n = normalizeNumber(String(raw));
  if (n === null) {
    errors.push(`${label}: не число`);
    return null;
  }
  const d = dec(n);
  if (f.scale !== undefined && d.decimalPlaces() > f.scale) errors.push(`${label}: не больше ${f.scale} знаков после запятой`);
  if (f.min !== undefined && d.lt(dec(f.min))) errors.push(`${label}: не меньше ${f.min}`);
  if (f.max !== undefined && d.gt(dec(f.max))) errors.push(`${label}: не больше ${f.max}`);
  return n;
};

const checkDate = (raw: unknown, f: { min?: string; max?: string }, errors: string[], label: string): string | null => {
  if (typeof raw !== 'string' || !isValidDate(raw)) {
    errors.push(`${label}: дата ГГГГ-ММ-ДД`);
    return null;
  }
  if (f.min && raw < f.min) errors.push(`${label}: не раньше ${f.min}`);
  if (f.max && raw > f.max) errors.push(`${label}: не позже ${f.max}`);
  return raw;
};

const checkChoice = (raw: unknown, options: readonly IChoiceOption[], multiple: boolean, errors: string[], label: string): string | string[] | null => {
  const allowed = new Set(options.map((o) => o.value));
  if (multiple) {
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
      errors.push(`${label}: список вариантов`);
      return null;
    }
    const unknown = raw.filter((x) => !allowed.has(x));
    if (unknown.length) errors.push(`${label}: нет вариантов ${unknown.join(', ')}`);
    return [...new Set(raw)].sort((a, b) => options.findIndex((o) => o.value === a) - options.findIndex((o) => o.value === b));
  }
  if (typeof raw !== 'string' || !allowed.has(raw)) {
    errors.push(`${label}: нет такого варианта`);
    return null;
  }
  return raw;
};

const checkText = (raw: unknown, maxLength: number, errors: string[], label: string): string | null => {
  if (typeof raw !== 'string') {
    errors.push(`${label}: текст`);
    return null;
  }
  // Длина — в символах Unicode (кириллица — один символ), текст не обрезается.
  if ([...raw].length > maxLength) errors.push(`${label}: не длиннее ${maxLength} символов`);
  return raw;
};

const checkCell = (raw: unknown, c: ITableColumn, errors: string[], label: string): CellValue => {
  if (isEmptyValue(raw)) {
    if (c.required) errors.push(`${label}: обязательная ячейка`);
    return null;
  }
  if (c.type === 'number') return checkNumber(raw, c, errors, label);
  if (c.type === 'date') return checkDate(raw, {}, errors, label);
  if (c.type === 'choice') return checkChoice(raw, c.options ?? [], false, errors, label);
  return checkText(raw, c.maxLength ?? TEXT_DEFAULT_MAX, errors, label);
};

// Проверка и нормализация значения поля по его описанию в схеме ревизии.
export const validateValue = (f: IField, raw: unknown): ValueCheck => {
  const errors: string[] = [];
  let value: FieldValue | null = null;
  if (isEmptyValue(raw)) return { ok: false, errors: ['значение пустое'] };
  switch (f.type) {
    case 'number':
      value = checkNumber(raw, f, errors, f.label);
      break;
    case 'date':
      value = checkDate(raw, f, errors, f.label);
      break;
    case 'choice':
      value = checkChoice(raw, f.options, f.multiple === true, errors, f.label);
      break;
    case 'text':
      value = checkText(raw, f.maxLength ?? TEXT_DEFAULT_MAX, errors, f.label);
      break;
    case 'table': {
      if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'object' || r === null || Array.isArray(r))) {
        errors.push(`${f.label}: строки таблицы`);
        break;
      }
      const max = f.maxRows ?? TABLE_HARD_MAX_ROWS;
      if (raw.length > max) errors.push(`${f.label}: не больше ${max} строк`);
      if (f.minRows !== undefined && raw.length < f.minRows) errors.push(`${f.label}: не меньше ${f.minRows} строк`);
      const cols = new Set(f.columns.map((c) => c.key));
      value = (raw as Record<string, unknown>[]).map((row, i) => {
        const extra = Object.keys(row).filter((k) => !cols.has(k));
        if (extra.length) errors.push(`${f.label}, строка ${i + 1}: нет колонок ${extra.join(', ')}`);
        return Object.fromEntries(f.columns.map((c) => [c.key, checkCell(row[c.key], c, errors, `${f.label}, строка ${i + 1}, «${c.label}»`)]));
      });
      break;
    }
  }
  return errors.length > 0 || value === null ? { ok: false, errors: errors.length ? errors : ['неверное значение'] } : { ok: true, value };
};

// ---------------------------------------------------------------- Условия

// Достаточно чтения по ключу: подходит и Map, и представление с учётом применимости.
export interface IValueLookup {
  get(key: string): FieldValue | null | undefined;
}

const matches = (v: FieldValue | null | undefined, expected: unknown): boolean => {
  if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x === String(expected));
  return v !== null && v !== undefined && String(v) === String(expected);
};

// Условие по значениям полей; неприменимое поле условие видит пустым.
export const evaluate = (c: Condition, values: IValueLookup): boolean => {
  if ('all' in c) return c.all.every((x) => evaluate(x, values));
  if ('any' in c) return c.any.some((x) => evaluate(x, values));
  if ('not' in c) return !evaluate(c.not, values);
  const v = values.get(c.field);
  switch (c.op) {
    case 'empty':
      return isEmptyValue(v);
    case 'notEmpty':
      return !isEmptyValue(v);
    case 'eq':
      return matches(v, c.value);
    case 'ne':
      return !matches(v, c.value);
    case 'in':
      return Array.isArray(c.value) && c.value.some((x) => matches(v, x));
  }
};

export interface IApplicability {
  applicable: ReadonlySet<string>;
  required: ReadonlySet<string>;
  // Значения с учётом применимости: значение неприменимого поля для условий — пустое.
  effective: Map<string, FieldValue | null>;
}

// Применимость и обязательность по текущим значениям (граф без циклов — проверен при утверждении схемы).
export const applicability = (schema: IFormSchema, values: IValueLookup): IApplicability => {
  const fields = allFields(schema);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const memo = new Map<string, boolean>();
  const effective = new Map<string, FieldValue | null>();
  const view: IValueLookup = { get: (k: string) => (isApplicable(k) ? (values.get(k) ?? null) : null) };
  function isApplicable(k: string): boolean {
    const known = memo.get(k);
    if (known !== undefined) return known;
    const f = byKey.get(k);
    const r = !f || !f.applicableWhen ? true : evaluate(f.applicableWhen, view);
    memo.set(k, r);
    return r;
  }
  const applicable = new Set<string>();
  const required = new Set<string>();
  for (const f of fields) {
    const a = isApplicable(f.key);
    effective.set(f.key, a ? (values.get(f.key) ?? null) : null);
    if (!a) continue;
    applicable.add(f.key);
    if (f.required === true || (f.required && typeof f.required !== 'boolean' && evaluate(f.required, view))) required.add(f.key);
  }
  return { applicable, required, effective };
};
