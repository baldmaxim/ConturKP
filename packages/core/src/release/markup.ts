// Разметка образца шаблона (этап 12; D-032 В-12-3; ADR-013 п. 2). Размечается копия образца, оригинал ревизии
// сохраняется. Плейсхолдеры: `{{ключ}}` — значение поля схемы `forms/1`; `{{#ключ}}…{{/ключ}}` — блок только для
// применимого и заполненного поля, для поля-таблицы — повторение строки (внутри `{{колонка}}`). Проверка — до утверждения
// ревизии: ключи и типы по схеме, обязательные поля и обязательные колонки таблиц выводятся, блоки закрыты и вложены
// верно. Сканер (адаптер OOXML) извлекает теги из текста абзацев DOCX и ячеек XLSX; здесь — только проверка.
import { allFields, type IField, type IFormSchema, type ITableField } from '../forms/schema.ts';

export type OutputFormat = 'docx' | 'xlsx';

// Тег из текста образца: значение, открытие или закрытие блока; `where` — место в образце для сообщения.
export interface IMarkupTag {
  kind: 'value' | 'open' | 'close' | 'invalid';
  key: string;
  raw: string;
  where: string;
}

export type MarkupIssueCode =
  | 'invalid_tag'
  | 'unbalanced_braces'
  | 'unknown_key'
  | 'block_not_closed'
  | 'close_without_open'
  | 'close_mismatch'
  | 'xlsx_block_unsupported'
  | 'table_requires_loop'
  | 'loop_requires_table'
  | 'unknown_column'
  | 'ambiguous_key'
  | 'required_not_printed'
  | 'required_column_not_printed'
  | 'no_placeholders';

export interface IMarkupIssue {
  code: MarkupIssueCode;
  key: string | null;
  where: string | null;
  message: string;
}

export interface IMarkupResult {
  ok: boolean;
  format: OutputFormat;
  // Ключи полей, которые выводит образец (значением или блоком), и столбцы таблиц внутри повторений.
  printed: string[];
  blocks: string[];
  loops: { key: string; columns: string[] }[];
  // Необязательные поля схемы, которых образец не выводит (сведения, не ошибка).
  notPrinted: string[];
  tags: number;
  issues: IMarkupIssue[];
}

const TAG_RE = /\{\{([^{}]*)\}\}/gu;
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/u;

// Теги одного фрагмента текста (абзац DOCX, ячейка XLSX). Непарные «{{» / «}}» — тег «invalid».
export const tagsOfText = (text: string, where: string): IMarkupTag[] => {
  const out: IMarkupTag[] = [];
  let rest = text;
  for (const m of text.matchAll(TAG_RE)) {
    const inner = m[1]!.trim();
    const raw = m[0];
    if (inner.startsWith('#')) out.push({ kind: KEY_RE.test(inner.slice(1).trim()) ? 'open' : 'invalid', key: inner.slice(1).trim(), raw, where });
    else if (inner.startsWith('/')) out.push({ kind: KEY_RE.test(inner.slice(1).trim()) ? 'close' : 'invalid', key: inner.slice(1).trim(), raw, where });
    else out.push({ kind: KEY_RE.test(inner) ? 'value' : 'invalid', key: inner, raw, where });
    rest = rest.replace(raw, '');
  }
  if (rest.includes('{{') || rest.includes('}}')) out.push({ kind: 'invalid', key: '', raw: rest.includes('{{') ? '{{' : '}}', where });
  return out;
};

const isRequired = (f: IField): boolean => f.required !== undefined && f.required !== false;

export const checkMarkup = (schema: IFormSchema, format: OutputFormat, tags: readonly IMarkupTag[]): IMarkupResult => {
  const fields = new Map(allFields(schema).map((f) => [f.key, f]));
  const issues: IMarkupIssue[] = [];
  const issue = (code: MarkupIssueCode, key: string | null, where: string | null, message: string) => issues.push({ code, key, where, message });
  const printed = new Set<string>();
  const blocks = new Set<string>();
  const loops = new Map<string, Set<string>>();
  const stack: { key: string; where: string; table: ITableField | null }[] = [];

  for (const t of tags) {
    if (t.kind === 'invalid') {
      if (t.raw === '{{' || t.raw === '}}') issue('unbalanced_braces', null, t.where, `непарные фигурные скобки «${t.raw}»`);
      else issue('invalid_tag', null, t.where, `тег «${t.raw}» — не ключ поля (латиница, цифры, «_», с буквы)`);
      continue;
    }
    if (format === 'xlsx' && t.kind !== 'value') {
      issue('xlsx_block_unsupported', t.key, t.where, 'в XLSX блоки не поддерживаются: только {{ключ}} в ячейке');
      continue;
    }
    const loop = [...stack].reverse().find((s) => s.table !== null)?.table ?? null;
    const column = loop?.columns.find((c) => c.key === t.key) ?? null;
    if (t.kind === 'close') {
      const top = stack.pop();
      if (!top) issue('close_without_open', t.key, t.where, `«{{/${t.key}}}» без открытия блока`);
      else if (top.key !== t.key) {
        issue('close_mismatch', t.key, t.where, `блок «${top.key}» закрыт тегом «${t.key}»`);
        stack.push(top);
      }
      continue;
    }
    if (column && fields.has(t.key)) {
      issue('ambiguous_key', t.key, t.where, `«${t.key}» — и колонка таблицы «${loop!.key}», и поле схемы`);
      continue;
    }
    if (column) {
      if (t.kind === 'open') issue('loop_requires_table', t.key, t.where, `колонка «${t.key}» не может открывать блок`);
      else loops.get(loop!.key)!.add(t.key);
      continue;
    }
    const f = fields.get(t.key);
    if (!f) {
      issue(loop ? 'unknown_column' : 'unknown_key', t.key, t.where, loop ? `«${t.key}» — не колонка таблицы «${loop.key}» и не поле схемы` : `«${t.key}» — нет такого поля в схеме ревизии`);
      continue;
    }
    if (t.kind === 'open') {
      stack.push({ key: t.key, where: t.where, table: f.type === 'table' ? f : null });
      blocks.add(t.key);
      printed.add(t.key);
      if (f.type === 'table' && !loops.has(t.key)) loops.set(t.key, new Set());
      continue;
    }
    if (f.type === 'table' && format === 'docx') {
      issue('table_requires_loop', t.key, t.where, `таблица «${t.key}» в DOCX выводится повторением {{#${t.key}}}…{{/${t.key}}}`);
      continue;
    }
    printed.add(t.key);
  }
  for (const s of stack) issue('block_not_closed', s.key, s.where, `блок «${s.key}» не закрыт тегом {{/${s.key}}}`);

  for (const f of fields.values()) {
    if (isRequired(f) && !printed.has(f.key)) issue('required_not_printed', f.key, null, `обязательное поле «${f.label}» не выводится образцом`);
    if (f.type === 'table' && loops.has(f.key)) {
      for (const c of f.columns) {
        if (c.required && !loops.get(f.key)!.has(c.key)) issue('required_column_not_printed', `${f.key}.${c.key}`, null, `обязательная колонка «${c.label}» таблицы «${f.label}» не выводится`);
      }
    }
  }
  const tagCount = tags.filter((t) => t.kind !== 'invalid').length;
  if (tagCount === 0) issue('no_placeholders', null, null, 'в образце нет плейсхолдеров {{ключ}}');
  return {
    ok: issues.length === 0,
    format,
    printed: [...printed].sort(),
    blocks: [...blocks].sort(),
    loops: [...loops.entries()].map(([key, cols]) => ({ key, columns: [...cols].sort() })).sort((a, b) => (a.key < b.key ? -1 : 1)),
    notPrinted: [...fields.values()].filter((f) => !printed.has(f.key)).map((f) => f.key).sort(),
    tags: tagCount,
    issues,
  };
};
