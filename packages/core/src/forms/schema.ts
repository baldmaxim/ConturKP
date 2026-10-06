// Схема полей шаблона приложения `forms/1` (этап 11, D-031 В-11-2; проект §5.1). Схема — JSON, который готовит
// человек и утверждает руководитель; ядро проверяет её до утверждения. Условия — декларативные, без исполняемого кода
// (I16): ссылки только на поля той же схемы, применимость без циклов.
import { canonicalJson } from '../requirements.ts';
import { sha256Hex } from '../search.ts';
import { isDecimalLexeme } from '../calculation.ts';

export const FORM_SCHEMA_VERSION = 'forms/1' as const;
export const FIELD_TYPES = ['choice', 'text', 'number', 'date', 'table'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type CellType = Exclude<FieldType, 'table'>;

// Длинная формулировка (проверка задания): по умолчанию 20 000 символов, предел схемы — 100 000.
export const TEXT_DEFAULT_MAX = 20_000;
export const TEXT_HARD_MAX = 100_000;
export const TABLE_HARD_MAX_ROWS = 1000;

export type Condition =
  | { field: string; op: 'eq' | 'ne' | 'in' | 'empty' | 'notEmpty'; value?: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface IChoiceOption {
  value: string;
  label: string;
  // Утверждённая формулировка варианта (логический идентификатор библиотеки).
  wordingId?: string;
}

// Контекст смысла (D-031 В-11-7): предмет, период, единица и валюта. Предмет и период — постоянные или ссылка на поле.
export interface IFieldContext {
  subject?: string;
  period?: string;
  periodField?: string;
}

interface IFieldBase {
  key: string;
  label: string;
  help?: string;
  required?: boolean | Condition;
  applicableWhen?: Condition;
  // Смысл поля (D-031 В-11-6): `fact:<тип факта D-018>` или `custom:<ключ>`.
  meaning?: string;
  context?: IFieldContext;
}

export interface IChoiceField extends IFieldBase {
  type: 'choice';
  options: IChoiceOption[];
  multiple?: boolean;
}

export interface ITextField extends IFieldBase {
  type: 'text';
  maxLength?: number;
  multiline?: boolean;
  wordingTags?: string[];
}

export interface INumberField extends IFieldBase {
  type: 'number';
  unit?: string;
  currency?: string;
  scale?: number;
  min?: string;
  max?: string;
}

export interface IDateField extends IFieldBase {
  type: 'date';
  min?: string;
  max?: string;
}

export interface ITableColumn {
  key: string;
  label: string;
  type: CellType;
  required?: boolean;
  options?: IChoiceOption[];
  unit?: string;
  scale?: number;
  maxLength?: number;
}

export interface ITableField extends IFieldBase {
  type: 'table';
  columns: ITableColumn[];
  minRows?: number;
  maxRows?: number;
}

export type IField = IChoiceField | ITextField | INumberField | IDateField | ITableField;

export interface ISection {
  key: string;
  title: string;
  help?: string;
  fields: IField[];
}

// Условие несовместимости: нарушено, если `when` выполняется (например, два несовместимых варианта).
export interface IConstraint {
  id: string;
  when: Condition;
  message: string;
}

export interface IFormSchema {
  schemaVersion: typeof FORM_SCHEMA_VERSION;
  title: string;
  sections: ISection[];
  constraints?: IConstraint[];
}

export interface ISchemaIssue {
  path: string;
  message: string;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/u;
const MEANING_RE = /^(fact|custom):[a-z][a-z0-9_]{0,63}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export const allFields = (schema: IFormSchema): IField[] => schema.sections.flatMap((s) => s.fields);
export const fieldMap = (schema: IFormSchema): Map<string, IField> => new Map(allFields(schema).map((f) => [f.key, f]));

// Поля, на которые ссылается условие.
export const conditionFields = (c: Condition): string[] => {
  if ('all' in c) return c.all.flatMap(conditionFields);
  if ('any' in c) return c.any.flatMap(conditionFields);
  if ('not' in c) return conditionFields(c.not);
  return [c.field];
};

const checkCondition = (c: unknown, path: string, keys: ReadonlySet<string>, out: ISchemaIssue[], depth = 0): void => {
  if (depth > 8) {
    out.push({ path, message: 'условие вложено глубже 8 уровней' });
    return;
  }
  if (!isObj(c)) {
    out.push({ path, message: 'условие — объект' });
    return;
  }
  if ('all' in c || 'any' in c) {
    const list = (c.all ?? c.any) as unknown;
    if (!Array.isArray(list) || list.length === 0 || list.length > 50) out.push({ path, message: 'all/any — непустой список до 50 условий' });
    else list.forEach((x, i) => checkCondition(x, `${path}.${'all' in c ? 'all' : 'any'}[${i}]`, keys, out, depth + 1));
    return;
  }
  if ('not' in c) {
    checkCondition(c.not, `${path}.not`, keys, out, depth + 1);
    return;
  }
  if (typeof c.field !== 'string' || !keys.has(c.field)) out.push({ path, message: `условие ссылается на неизвестное поле «${String(c.field)}»` });
  if (!['eq', 'ne', 'in', 'empty', 'notEmpty'].includes(String(c.op))) out.push({ path, message: `неизвестная операция «${String(c.op)}»` });
  if ((c.op === 'eq' || c.op === 'ne') && !['string', 'number', 'boolean'].includes(typeof c.value)) out.push({ path, message: 'eq/ne — со значением' });
  if (c.op === 'in' && (!Array.isArray(c.value) || c.value.length === 0)) out.push({ path, message: 'in — с непустым списком' });
};

const checkOptions = (options: unknown, path: string, out: ISchemaIssue[]): void => {
  if (!Array.isArray(options) || options.length === 0 || options.length > 200) {
    out.push({ path, message: 'варианты — непустой список до 200' });
    return;
  }
  const seen = new Set<string>();
  options.forEach((o, i) => {
    if (!isObj(o) || !isStr(o.value, 200) || !isStr(o.label, 2000)) out.push({ path: `${path}[${i}]`, message: 'вариант — { value, label }' });
    else if (seen.has(o.value)) out.push({ path: `${path}[${i}]`, message: `вариант «${o.value}» повторяется` });
    else seen.add(o.value);
    if (isObj(o) && o.wordingId !== undefined && !isStr(o.wordingId, 100)) out.push({ path: `${path}[${i}].wordingId`, message: 'идентификатор формулировки — строка' });
  });
};

const checkNumberProps = (f: Record<string, unknown>, path: string, out: ISchemaIssue[]): void => {
  if (f.scale !== undefined && !(Number.isInteger(f.scale) && (f.scale as number) >= 0 && (f.scale as number) <= 10)) out.push({ path: `${path}.scale`, message: 'scale — целое 0…10' });
  for (const k of ['min', 'max'] as const) if (f[k] !== undefined && !(typeof f[k] === 'string' && isDecimalLexeme(f[k] as string))) out.push({ path: `${path}.${k}`, message: `${k} — десятичная строка` });
  if (f.unit !== undefined && !isStr(f.unit, 40)) out.push({ path: `${path}.unit`, message: 'единица — строка до 40 символов' });
  if (f.currency !== undefined && !['RUB', 'USD', 'EUR', 'CNY'].includes(String(f.currency))) out.push({ path: `${path}.currency`, message: 'валюта — RUB, USD, EUR, CNY' });
};

// Проверка схемы до утверждения: структура, уникальность ключей, условия, отсутствие циклов применимости.
export const validateSchema = (raw: unknown): { ok: true; schema: IFormSchema } | { ok: false; issues: ISchemaIssue[] } => {
  const out: ISchemaIssue[] = [];
  if (!isObj(raw)) return { ok: false, issues: [{ path: '$', message: 'схема — объект JSON' }] };
  if (raw.schemaVersion !== FORM_SCHEMA_VERSION) out.push({ path: '$.schemaVersion', message: `версия схемы — ${FORM_SCHEMA_VERSION}` });
  if (!isStr(raw.title, 300)) out.push({ path: '$.title', message: 'название — строка до 300 символов' });
  if (!Array.isArray(raw.sections) || raw.sections.length === 0 || raw.sections.length > 100) {
    out.push({ path: '$.sections', message: 'разделы — непустой список до 100' });
    return { ok: false, issues: out };
  }
  const keys = new Set<string>();
  const sectionKeys = new Set<string>();
  const fields: Record<string, unknown>[] = [];
  raw.sections.forEach((s, si) => {
    const sp = `$.sections[${si}]`;
    if (!isObj(s)) {
      out.push({ path: sp, message: 'раздел — объект' });
      return;
    }
    if (typeof s.key !== 'string' || !KEY_RE.test(s.key)) out.push({ path: `${sp}.key`, message: 'ключ раздела — латиница, цифры, «_»' });
    else if (sectionKeys.has(s.key)) out.push({ path: `${sp}.key`, message: `раздел «${s.key}» повторяется` });
    else sectionKeys.add(s.key);
    if (!isStr(s.title, 300)) out.push({ path: `${sp}.title`, message: 'название раздела — строка до 300 символов' });
    if (!Array.isArray(s.fields) || s.fields.length === 0 || s.fields.length > 500) {
      out.push({ path: `${sp}.fields`, message: 'поля — непустой список до 500' });
      return;
    }
    s.fields.forEach((f, fi) => {
      const fp = `${sp}.fields[${fi}]`;
      if (!isObj(f)) {
        out.push({ path: fp, message: 'поле — объект' });
        return;
      }
      fields.push({ ...f, __path: fp });
      if (typeof f.key !== 'string' || !KEY_RE.test(f.key)) out.push({ path: `${fp}.key`, message: 'ключ поля — латиница, цифры, «_», с буквы' });
      else if (keys.has(f.key)) out.push({ path: `${fp}.key`, message: `поле «${f.key}» повторяется` });
      else keys.add(f.key);
      if (!isStr(f.label, 2000)) out.push({ path: `${fp}.label`, message: 'подпись поля — строка до 2000 символов' });
      if (!FIELD_TYPES.includes(f.type as FieldType)) out.push({ path: `${fp}.type`, message: `тип — ${FIELD_TYPES.join(', ')}` });
      if (f.meaning !== undefined && !(typeof f.meaning === 'string' && MEANING_RE.test(f.meaning))) out.push({ path: `${fp}.meaning`, message: 'смысл — fact:<тип> или custom:<ключ>' });
      if (f.type === 'choice') checkOptions(f.options, `${fp}.options`, out);
      if (f.type === 'text' && f.maxLength !== undefined && !(Number.isInteger(f.maxLength) && (f.maxLength as number) >= 1 && (f.maxLength as number) <= TEXT_HARD_MAX)) {
        out.push({ path: `${fp}.maxLength`, message: `maxLength — 1…${TEXT_HARD_MAX}` });
      }
      if (f.type === 'number') checkNumberProps(f, fp, out);
      if (f.type === 'date') for (const k of ['min', 'max'] as const) if (f[k] !== undefined && !(typeof f[k] === 'string' && DATE_RE.test(f[k] as string))) out.push({ path: `${fp}.${k}`, message: `${k} — ГГГГ-ММ-ДД` });
      if (f.type === 'table') {
        if (!Array.isArray(f.columns) || f.columns.length === 0 || f.columns.length > 30) out.push({ path: `${fp}.columns`, message: 'колонки — непустой список до 30' });
        else {
          const cols = new Set<string>();
          f.columns.forEach((c, ci) => {
            const cp = `${fp}.columns[${ci}]`;
            if (!isObj(c) || typeof c.key !== 'string' || !KEY_RE.test(c.key) || !isStr(c.label, 300)) out.push({ path: cp, message: 'колонка — { key, label, type }' });
            else if (cols.has(c.key)) out.push({ path: cp, message: `колонка «${c.key}» повторяется` });
            else cols.add(c.key);
            if (isObj(c) && !['choice', 'text', 'number', 'date'].includes(String(c.type))) out.push({ path: `${cp}.type`, message: 'тип ячейки — choice, text, number, date' });
            if (isObj(c) && c.type === 'choice') checkOptions(c.options, `${cp}.options`, out);
            if (isObj(c) && c.type === 'number') checkNumberProps(c, cp, out);
          });
        }
        for (const k of ['minRows', 'maxRows'] as const) {
          if (f[k] !== undefined && !(Number.isInteger(f[k]) && (f[k] as number) >= 0 && (f[k] as number) <= TABLE_HARD_MAX_ROWS)) out.push({ path: `${fp}.${k}`, message: `${k} — 0…${TABLE_HARD_MAX_ROWS}` });
        }
      }
      if (isObj(f.context)) {
        if (f.context.subject !== undefined && !isStr(f.context.subject, 300)) out.push({ path: `${fp}.context.subject`, message: 'предмет — строка' });
        if (f.context.period !== undefined && !isStr(f.context.period, 300)) out.push({ path: `${fp}.context.period`, message: 'период — строка' });
      } else if (f.context !== undefined) out.push({ path: `${fp}.context`, message: 'контекст — объект' });
    });
  });
  // Условия и ссылки контекста — на поля этой схемы.
  for (const f of fields) {
    const fp = String(f.__path);
    if (f.applicableWhen !== undefined) checkCondition(f.applicableWhen, `${fp}.applicableWhen`, keys, out);
    if (f.required !== undefined && typeof f.required !== 'boolean') checkCondition(f.required, `${fp}.required`, keys, out);
    if (isObj(f.context) && f.context.periodField !== undefined && !(typeof f.context.periodField === 'string' && keys.has(f.context.periodField))) {
      out.push({ path: `${fp}.context.periodField`, message: 'период ссылается на неизвестное поле' });
    }
  }
  if (raw.constraints !== undefined) {
    if (!Array.isArray(raw.constraints) || raw.constraints.length > 200) out.push({ path: '$.constraints', message: 'условия несовместимости — список до 200' });
    else {
      const ids = new Set<string>();
      raw.constraints.forEach((c, i) => {
        const cp = `$.constraints[${i}]`;
        if (!isObj(c) || typeof c.id !== 'string' || !KEY_RE.test(c.id) || !isStr(c.message, 1000)) out.push({ path: cp, message: 'условие — { id, when, message }' });
        else if (ids.has(c.id)) out.push({ path: cp, message: `условие «${c.id}» повторяется` });
        else ids.add(c.id);
        if (isObj(c)) checkCondition(c.when, `${cp}.when`, keys, out);
      });
    }
  }
  if (out.length > 0) return { ok: false, issues: out };
  const schema = raw as unknown as IFormSchema;
  const cycle = applicabilityCycle(schema);
  if (cycle) return { ok: false, issues: [{ path: '$', message: `цикл применимости: ${cycle.join(' → ')}` }] };
  return { ok: true, schema };
};

// Цикл в графе «применимость поля зависит от поля» (условия applicableWhen и required).
const applicabilityCycle = (schema: IFormSchema): string[] | null => {
  const deps = new Map<string, string[]>();
  for (const f of allFields(schema)) {
    const d = [...(f.applicableWhen ? conditionFields(f.applicableWhen) : []), ...(f.required && typeof f.required !== 'boolean' ? conditionFields(f.required) : [])];
    deps.set(f.key, d);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 'done') return null;
    if (state.get(k) === 'visiting') return [...stack.slice(stack.indexOf(k)), k];
    state.set(k, 'visiting');
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(k, 'done');
    return null;
  };
  for (const k of deps.keys()) {
    const c = visit(k);
    if (c) return c;
  }
  return null;
};

// Отпечаток схемы — канонический JSON (ключи по порядку), не зависит от пробелов файла.
export const schemaSha256 = (schema: IFormSchema): string => sha256Hex(canonicalJson(schema));

// Ключи полей и безусловно обязательные поля — для второй линии БД (условия БД не вычисляет).
export const schemaKeys = (schema: IFormSchema): { fieldKeys: string[]; requiredKeys: string[] } => ({
  fieldKeys: allFields(schema).map((f) => f.key),
  requiredKeys: allFields(schema)
    .filter((f) => f.required === true && f.applicableWhen === undefined)
    .map((f) => f.key),
});
