// Перенос приложения на новую ревизию шаблона (этап 11; D-031 В-11-8; проект §4). Перенос — явное действие: значение
// переносится по ключу и совместимому типу, если проходит схему новой ревизии, и требует повторного подтверждения.
// Отчёт показывает изменения подписи, единицы, вариантов и условий применимости у перенесённых полей, а также
// удалённые, несовместимые и новые поля. Ничего не подтверждается молча.
import { canonicalJson } from '../requirements.ts';
import { allFields, type IField, type IFormSchema } from './schema.ts';
import { validateValue, type FieldValue } from './values.ts';

export type FieldChangeKind = 'label' | 'unit' | 'currency' | 'options' | 'applicability' | 'required' | 'meaning' | 'context' | 'columns' | 'limits';

export interface IFieldChange {
  kind: FieldChangeKind;
  from: string;
  to: string;
}

export interface IMigrationPlan {
  carried: { key: string; label: string; value: FieldValue; changes: IFieldChange[] }[];
  dropped: { key: string; label: string; reason: 'removed' | 'type_changed' | 'invalid'; detail: string }[];
  added: { key: string; label: string; required: boolean }[];
}

const j = (v: unknown): string => (v === undefined ? '—' : typeof v === 'string' ? v : canonicalJson(v));

const optionsText = (f: IField): string => (f.type === 'choice' ? f.options.map((o) => `${o.value}: ${o.label}`).join('; ') : '');

export const fieldChanges = (a: IField, b: IField): IFieldChange[] => {
  const out: IFieldChange[] = [];
  const push = (kind: FieldChangeKind, from: unknown, to: unknown) => {
    if (j(from) !== j(to)) out.push({ kind, from: j(from), to: j(to) });
  };
  push('label', a.label, b.label);
  if (a.type === 'number' && b.type === 'number') {
    push('unit', a.unit, b.unit);
    push('currency', a.currency, b.currency);
    push('limits', { scale: a.scale, min: a.min, max: a.max }, { scale: b.scale, min: b.min, max: b.max });
  }
  if (a.type === 'choice' && b.type === 'choice') {
    push('options', optionsText(a), optionsText(b));
    push('limits', { multiple: a.multiple === true }, { multiple: b.multiple === true });
  }
  if (a.type === 'text' && b.type === 'text') push('limits', { maxLength: a.maxLength }, { maxLength: b.maxLength });
  if (a.type === 'date' && b.type === 'date') push('limits', { min: a.min, max: a.max }, { min: b.min, max: b.max });
  if (a.type === 'table' && b.type === 'table') {
    push('columns', a.columns, b.columns);
    push('limits', { minRows: a.minRows, maxRows: a.maxRows }, { minRows: b.minRows, maxRows: b.maxRows });
  }
  push('applicability', a.applicableWhen, b.applicableWhen);
  push('required', a.required ?? false, b.required ?? false);
  push('meaning', a.meaning, b.meaning);
  push('context', a.context, b.context);
  return out;
};

export const planMigration = (from: IFormSchema, to: IFormSchema, values: ReadonlyMap<string, FieldValue | null>): IMigrationPlan => {
  const next = new Map(allFields(to).map((f) => [f.key, f]));
  const prev = new Map(allFields(from).map((f) => [f.key, f]));
  const plan: IMigrationPlan = { carried: [], dropped: [], added: [] };
  for (const a of allFields(from)) {
    const value = values.get(a.key) ?? null;
    const b = next.get(a.key);
    if (!b) {
      if (value !== null) plan.dropped.push({ key: a.key, label: a.label, reason: 'removed', detail: 'поля нет в новой ревизии' });
      continue;
    }
    if (value === null) continue;
    if (a.type !== b.type) {
      plan.dropped.push({ key: a.key, label: a.label, reason: 'type_changed', detail: `тип изменён: ${a.type} → ${b.type}` });
      continue;
    }
    const check = validateValue(b, value);
    if (!check.ok) {
      plan.dropped.push({ key: a.key, label: a.label, reason: 'invalid', detail: check.errors.join('; ') });
      continue;
    }
    plan.carried.push({ key: a.key, label: b.label, value: check.value, changes: fieldChanges(a, b) });
  }
  for (const b of allFields(to)) if (!prev.has(b.key)) plan.added.push({ key: b.key, label: b.label, required: b.required !== undefined && b.required !== false });
  return plan;
};
