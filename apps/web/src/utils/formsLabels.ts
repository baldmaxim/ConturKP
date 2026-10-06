// Подписи приложений этапа 11 (D-031): состояние значения, происхождение, пункты незавершённого. Термины — отдела
// тендеров: «принято», «изменено вручную», «требует обсуждения», «перенесено — подтвердите», «устарело».
import type { IFieldDefinition, IFormIssue, TFieldOrigin, TFieldState, TFieldValue } from '../api/formsTypes';
import type { TBadgeTone } from '../components/Badge';
import type { TIconName } from '../components/Icon';
import { formatDecimal } from './calculationLabels';

export const STATE_LABEL: Record<TFieldState, { label: string; tone: TBadgeTone; icon: TIconName }> = {
  accepted: { label: 'Принято', tone: 'success', icon: 'check' },
  edited: { label: 'Изменено вручную', tone: 'info', icon: 'pencil' },
  needs_discussion: { label: 'Требует обсуждения', tone: 'warning', icon: 'message-square' },
  cleared: { label: 'Очищено', tone: 'muted', icon: 'x' },
  carried_over: { label: 'Перенесено — подтвердите', tone: 'warning', icon: 'repeat' },
};

export const ORIGIN_LABEL: Record<TFieldOrigin, string> = {
  manual: 'ввод человека',
  approved_wording: 'утверждённая формулировка',
  model_suggestion: 'предложение модели, принято человеком',
  system_suggestion: 'предложение системы из факта, принято человеком',
  carried_over: 'перенесено с прежней ревизии шаблона',
};

export const ISSUE_LABEL: Record<IFormIssue['kind'], string> = {
  required_empty: 'Не заполнено',
  invalid_value: 'Не проходит схему',
  constraint: 'Несовместимые варианты',
  contradiction: 'Противоречие',
  stale: 'Устарело',
  carried_over: 'Перенесено',
  needs_discussion: 'Обсуждение',
  unverified: 'Не сверено',
};

export const CHANGE_LABEL: Record<string, string> = {
  label: 'подпись',
  unit: 'единица',
  currency: 'валюта',
  options: 'варианты',
  applicability: 'условие применимости',
  required: 'обязательность',
  meaning: 'смысл',
  context: 'контекст',
  columns: 'колонки',
  limits: 'ограничения',
};

const formatDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
};

// Значение для показа: число — с единицей, дата — ДД.ММ.ГГГГ, вариант — подписью, таблица — числом строк.
export const formatFieldValue = (def: IFieldDefinition, value: TFieldValue | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  if (def.type === 'number' && typeof value === 'string') return `${formatDecimal(value)}${def.unit ? ` ${def.unit}` : ''}`;
  if (def.type === 'date' && typeof value === 'string') return formatDate(value);
  if (def.type === 'choice') {
    const labels = (Array.isArray(value) ? value : [value]).map((v) => def.options?.find((o) => o.value === v)?.label ?? String(v));
    return labels.join('; ');
  }
  if (def.type === 'table' && Array.isArray(value)) return `строк: ${value.length}`;
  return typeof value === 'string' ? value : JSON.stringify(value);
};
