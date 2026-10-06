// Список незавершённых пунктов приложения (этап 11; проект §5.8, D-031 В-11-4, В-11-7, В-11-8). Пустой список
// блокирующих пунктов — условие «заполнено». «Не сверено» видно, но не блокирует: противоречие не установлено.
import { allFields, type IFormSchema } from './schema.ts';
import { applicability, evaluate, validateValue, type FieldValue } from './values.ts';
import type { IConsistencyFinding } from './consistency.ts';

export type FieldState = 'accepted' | 'edited' | 'needs_discussion' | 'cleared' | 'carried_over';

export interface IFieldStatus {
  value: FieldValue | null;
  state: FieldState | null; // null — версий нет
  stale: boolean; // основание изменилось (отметка инвалидации на последней версии)
  comment?: string | null;
  responsibleName?: string | null;
}

export type IssueKind = 'required_empty' | 'needs_discussion' | 'stale' | 'carried_over' | 'invalid_value' | 'constraint' | 'contradiction' | 'unverified';

export interface IFormIssue {
  kind: IssueKind;
  fieldKey: string | null;
  label: string;
  blocking: boolean;
  message: string;
}

export const ISSUE_ORDER: readonly IssueKind[] = ['required_empty', 'invalid_value', 'constraint', 'contradiction', 'stale', 'carried_over', 'needs_discussion', 'unverified'];

export const draftIssues = (schema: IFormSchema, fields: ReadonlyMap<string, IFieldStatus>, findings: readonly IConsistencyFinding[], draftId: string): IFormIssue[] => {
  const values = new Map<string, FieldValue | null>();
  for (const [k, s] of fields) values.set(k, s.state === 'cleared' ? null : s.value);
  const app = applicability(schema, values);
  const out: IFormIssue[] = [];
  for (const f of allFields(schema)) {
    const s = fields.get(f.key);
    const applicable = app.applicable.has(f.key);
    const value = values.get(f.key) ?? null;
    if (!applicable) continue;
    if (app.required.has(f.key) && value === null) out.push({ kind: 'required_empty', fieldKey: f.key, label: f.label, blocking: true, message: 'обязательное поле не заполнено' });
    if (value !== null) {
      const check = validateValue(f, value);
      if (!check.ok) out.push({ kind: 'invalid_value', fieldKey: f.key, label: f.label, blocking: true, message: check.errors.join('; ') });
    }
    if (s?.stale) out.push({ kind: 'stale', fieldKey: f.key, label: f.label, blocking: true, message: 'основание изменилось — подтвердите значение заново' });
    if (s?.state === 'carried_over') out.push({ kind: 'carried_over', fieldKey: f.key, label: f.label, blocking: true, message: 'перенесено с прежней ревизии шаблона — подтвердите' });
    if (s?.state === 'needs_discussion') {
      out.push({ kind: 'needs_discussion', fieldKey: f.key, label: f.label, blocking: true, message: `требует обсуждения${s.responsibleName ? ` (ответственный — ${s.responsibleName})` : ''}${s.comment ? `: ${s.comment}` : ''}` });
    }
  }
  for (const c of schema.constraints ?? []) {
    // Условие несовместимости видит только применимые значения.
    const view = { get: (k: string) => app.effective.get(k) ?? null };
    if (evaluate(c.when, view)) out.push({ kind: 'constraint', fieldKey: null, label: c.id, blocking: true, message: c.message });
  }
  for (const x of findings) {
    const mine = [x.a, x.b].filter((r) => r && r.draftId === draftId);
    for (const r of mine) {
      if (!r || !app.applicable.has(r.fieldKey)) continue;
      const other = r === x.a ? x.b : x.a;
      const where = other ? `«${other.label}» в приложении «${other.draftTitle}»` : x.reference ? `факт «${x.reference.title}»` : '';
      out.push({
        kind: x.kind,
        fieldKey: r.fieldKey,
        label: r.label,
        blocking: x.kind === 'contradiction',
        message: `${x.kind === 'contradiction' ? 'противоречие' : 'не сверено'}${where ? ` — ${where}` : ''}: ${x.reason}`,
      });
    }
  }
  return out.sort((a, b) => ISSUE_ORDER.indexOf(a.kind) - ISSUE_ORDER.indexOf(b.kind));
};


export const blockingIssues = (issues: readonly IFormIssue[]): IFormIssue[] => issues.filter((i) => i.blocking);
