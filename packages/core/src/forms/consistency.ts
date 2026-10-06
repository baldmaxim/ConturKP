// Сверка полей приложений этапа (этап 11; D-031 В-11-6, В-11-7; проект §5.5). Поля сравниваются группами: смысл
// поля (`fact:<тип>`, `custom:<ключ>`) и решение, на котором основано значение. Сравниваются только поля одного
// контекста — предмет, период, единица, валюта: разный контекст — не противоречие и не совпадение; неизвестный
// контекст или неизвестное значение — «не сверено», а не совпадение. Противоречие показывается, а не исправляется.
import { compareQuantities } from '../answers/claimNumbers.ts';
import { canonicalJson } from '../requirements.ts';
import { dec } from '../money/decimal.ts';
import { isEmptyValue, type FieldValue } from './values.ts';
import type { FieldType, IField } from './schema.ts';

export interface IFieldContextValue {
  subject: string;
  period: string | null; // null — период задан ссылкой на незаполненное поле (неизвестен)
  unit: string;
  currency: string;
}

export interface IFieldObservation {
  draftId: string;
  draftTitle: string;
  fieldKey: string;
  label: string;
  type: FieldType;
  unit: string | null;
  groupKeys: string[];
  context: IFieldContextValue;
  value: FieldValue | null;
}

// Действующее значение вне приложений: факт графа D-018 того же смысла.
export interface IReferenceValue {
  groupKey: string;
  kind: 'fact';
  id: string;
  title: string;
  text: string;
  status: 'active' | 'conflict';
}

export interface IFieldRef {
  draftId: string;
  draftTitle: string;
  fieldKey: string;
  label: string;
}

export interface IConsistencyFinding {
  kind: 'contradiction' | 'unverified';
  groupKey: string;
  a: IFieldRef;
  b: IFieldRef | null;
  reference: { kind: 'fact'; id: string; title: string } | null;
  reason: string;
}

// Контекст поля по схеме: предмет и период — постоянные или ссылка на поле; единица и валюта — из схемы числа.
export const contextOf = (f: IField, valueOf: (key: string) => FieldValue | null | undefined): IFieldContextValue => {
  const periodRef = f.context?.periodField;
  const refValue = periodRef ? valueOf(periodRef) : undefined;
  return {
    subject: f.context?.subject?.trim().toLowerCase() ?? '',
    period: periodRef ? (isEmptyValue(refValue) ? null : canonicalJson(refValue)) : (f.context?.period?.trim().toLowerCase() ?? ''),
    unit: f.type === 'number' ? (f.unit?.trim().toLowerCase() ?? '') : '',
    currency: f.type === 'number' ? (f.currency ?? '') : '',
  };
};

const normText = (s: string): string => s.toLowerCase().replace(/\s+/gu, ' ').trim();

const normalized = (type: FieldType, v: FieldValue): string => {
  if (type === 'number' && typeof v === 'string') return dec(v).toString();
  if (type === 'text' && typeof v === 'string') return normText(v);
  if (type === 'choice') return Array.isArray(v) ? [...v].sort().join('\u001f') : String(v);
  return canonicalJson(v);
};

const ref = (o: IFieldObservation): IFieldRef => ({ draftId: o.draftId, draftTitle: o.draftTitle, fieldKey: o.fieldKey, label: o.label });

type ContextRelation = 'same' | 'different' | 'unknown';

const relate = (a: IFieldContextValue, b: IFieldContextValue): ContextRelation => {
  if (a.period === null || b.period === null) return 'unknown';
  return a.subject === b.subject && a.period === b.period && a.unit === b.unit && a.currency === b.currency ? 'same' : 'different';
};

// Текст значения для сравнения с фразой факта: число — с единицей, дата — как в документах.
export const valueText = (o: Pick<IFieldObservation, 'type' | 'unit' | 'value'>): string | null => {
  if (o.value === null || isEmptyValue(o.value)) return null;
  if (o.type === 'number' && typeof o.value === 'string') return o.unit === '%' ? `${o.value}%` : `${o.value} ${o.unit ?? ''}`.trim();
  if (o.type === 'date' && typeof o.value === 'string') {
    const [y, m, d] = o.value.split('-');
    return `${d}.${m}.${y}`;
  }
  if (typeof o.value === 'string') return o.value;
  return null;
};

export const checkConsistency = (observations: readonly IFieldObservation[], references: readonly IReferenceValue[] = []): IConsistencyFinding[] => {
  const out: IConsistencyFinding[] = [];
  const groups = new Map<string, IFieldObservation[]>();
  for (const o of observations) for (const g of new Set(o.groupKeys)) (groups.get(g) ?? groups.set(g, []).get(g)!).push(o);
  for (const [groupKey, list] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.draftId === b.draftId && a.fieldKey === b.fieldKey) continue;
        const aEmpty = a.value === null || isEmptyValue(a.value);
        const bEmpty = b.value === null || isEmptyValue(b.value);
        if (aEmpty && bEmpty) continue;
        const rel = relate(a.context, b.context);
        if (rel === 'different') continue;
        const base = { groupKey, a: ref(a), b: ref(b), reference: null };
        if (rel === 'unknown') {
          out.push({ ...base, kind: 'unverified', reason: 'контекст неизвестен: период задан незаполненным полем' });
          continue;
        }
        if (aEmpty || bEmpty) {
          out.push({ ...base, kind: 'unverified', reason: 'значение одного из полей неизвестно' });
          continue;
        }
        if (a.type !== b.type) {
          out.push({ ...base, kind: 'unverified', reason: 'поля разного типа — сравнение не выполняется' });
          continue;
        }
        if (normalized(a.type, a.value!) !== normalized(b.type, b.value!)) out.push({ ...base, kind: 'contradiction', reason: 'значения различаются' });
      }
    }
    // Факты того же смысла сравниваются с полями без особого предмета и периода (контекст факта — договор в целом).
    for (const r of references.filter((x) => x.groupKey === groupKey)) {
      for (const o of list) {
        if (o.context.subject !== '' || o.context.period !== '') continue;
        const base = { groupKey, a: ref(o), b: null, reference: { kind: r.kind, id: r.id, title: r.title } };
        if (r.status === 'conflict') {
          out.push({ ...base, kind: 'unverified', reason: 'факт в конфликте: значения оснований расходятся' });
          continue;
        }
        const text = valueText(o);
        if (text === null) continue;
        const cmp = compareQuantities(text, [r.text]);
        if (cmp.length === 0) {
          if (o.type === 'text' && normText(r.text).includes(normText(text))) continue;
          out.push({ ...base, kind: 'unverified', reason: 'в значении нет величины для сравнения с фактом' });
        } else if (cmp.some((c) => c.status === 'missing')) out.push({ ...base, kind: 'contradiction', reason: 'значение расходится с действующим фактом' });
        else if (cmp.some((c) => c.status === 'ambiguous')) out.push({ ...base, kind: 'unverified', reason: 'величина факта неоднозначна' });
        // unit_mismatch — другой контекст (единица): не противоречие.
      }
    }
  }
  return out;
};
