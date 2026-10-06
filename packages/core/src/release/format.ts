// Вывод значений полей в документ (этап 12; ADR-013 п. 3). Значение — данные, а не разметка (I16): генератор не
// интерпретирует фигурные скобки значения. Число — точная десятичная строка с группировкой разрядов неразрывным
// пробелом и десятичной запятой (без округления: значение уже нормализовано схемой); денежное поле (с валютой и `scale`)
// дополняется нулями до `scale` знаков — «120,00», не «120»; единица пишется в тексте образца.
// Дата — ДД.ММ.ГГГГ. Вариант — подпись варианта (закреплённая в ревизии схемы; текущей библиотекой не подменяется).
// Неприменимое или пустое поле — нет значения: блок не выводится, плейсхолдер вне блока — пустая строка.
import { allFields, type IChoiceOption, type IField, type IFormSchema, type ITableColumn } from '../forms/schema.ts';
import { applicability, isEmptyValue, type FieldValue, type TableRow } from '../forms/values.ts';

const NBSP = ' ';

export const formatNumber = (s: string, fixedScale?: number): string => {
  const neg = s.startsWith('-');
  const [int, rawFrac = ''] = (neg ? s.slice(1) : s).split('.');
  const frac = fixedScale !== undefined && rawFrac.length < fixedScale ? rawFrac.padEnd(fixedScale, '0') : rawFrac;
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/gu, NBSP);
  return `${neg ? '−' : ''}${grouped}${frac ? `,${frac}` : ''}`;
};

export const formatDate = (s: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
};

const optionLabel = (options: readonly IChoiceOption[], v: string): string => options.find((o) => o.value === v)?.label ?? v;

const formatScalar = (f: { type: string; options?: IChoiceOption[]; currency?: string; scale?: number }, v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (f.type === 'number' && typeof v === 'string') return formatNumber(v, f.currency ? f.scale : undefined);
  if (f.type === 'date' && typeof v === 'string') return formatDate(v);
  if (f.type === 'choice') {
    const list = Array.isArray(v) ? v.map(String) : [String(v)];
    return list.map((x) => optionLabel(f.options ?? [], x)).join('; ');
  }
  return String(v);
};

const formatRow = (columns: readonly ITableColumn[], row: TableRow): Record<string, string> =>
  Object.fromEntries(columns.map((c) => [c.key, formatScalar(c, row[c.key])]));

// Табличное поле одной строкой текста (XLSX: таблица в ячейке): «1) a — b» по строкам.
export const tableAsText = (columns: readonly ITableColumn[], rows: readonly TableRow[]): string =>
  rows.map((r, i) => `${i + 1}) ${columns.map((c) => formatScalar(c, r[c.key])).filter((x) => x !== '').join(' — ')}`).join('\n');

export type RenderValue = string | Record<string, string>[] | false;

// Данные для генератора: ключ поля → строка, строки таблицы или false (неприменимо или пусто — блок не выводится).
export const renderData = (schema: IFormSchema, values: ReadonlyMap<string, FieldValue | null>, format: 'docx' | 'xlsx'): Record<string, RenderValue> => {
  const app = applicability(schema, values);
  const out: Record<string, RenderValue> = {};
  for (const f of allFields(schema)) {
    const v = values.get(f.key) ?? null;
    if (!app.applicable.has(f.key) || v === null || isEmptyValue(v)) {
      out[f.key] = false;
      continue;
    }
    if (f.type === 'table') {
      const rows = v as TableRow[];
      out[f.key] = format === 'xlsx' ? tableAsText(f.columns, rows) : rows.map((r) => formatRow(f.columns, r));
      continue;
    }
    out[f.key] = formatScalar(f as IField & { options?: IChoiceOption[] }, v);
  }
  return out;
};

// Тексты, которые обязаны появиться в отрисованном документе целиком (проверка отрисовки, D-032 В-12-10).
export const renderedTexts = (data: Record<string, RenderValue>): string[] =>
  Object.values(data).flatMap((v) => (v === false ? [] : typeof v === 'string' ? [v] : v.flatMap((r) => Object.values(r)))).filter((x) => x.trim() !== '');
