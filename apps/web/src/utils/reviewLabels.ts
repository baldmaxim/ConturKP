// Подписи этапа 09: исходы проверок, статусы замечаний, критичность, оси разногласия (I09) и их значения.
import type { TBadgeTone } from '../components/Badge';
import type { TIconName } from '../components/Icon';
import type { TAxis, TCheckOutcome, TConfidence, TFindingStatus, TRunStatus, TSeverity, TSummaryKind } from '../api/reviewTypes';

export const OUTCOME_LABELS: Record<TCheckOutcome, { label: string; tone: TBadgeTone; icon: TIconName; dashed?: boolean }> = {
  passed: { label: 'пройдено', tone: 'success', icon: 'check' },
  failed: { label: 'есть замечания', tone: 'warning', icon: 'file-exclamation-point' },
  not_applicable: { label: 'не применимо', tone: 'muted', icon: 'circle-dot' },
  incomplete: { label: 'неполно', tone: 'warning', icon: 'hourglass', dashed: true },
  error: { label: 'ошибка', tone: 'danger', icon: 'circle-x' },
};

export const RUN_STATUS_LABELS: Record<TRunStatus, { label: string; tone: TBadgeTone; icon: TIconName; dashed?: boolean }> = {
  queued: { label: 'в очереди', tone: 'info', icon: 'hourglass', dashed: true },
  running: { label: 'выполняется', tone: 'info', icon: 'loader-circle', dashed: true },
  completed: { label: 'завершена', tone: 'success', icon: 'check' },
  completed_with_gaps: { label: 'с пробелами', tone: 'warning', icon: 'file-question-mark', dashed: true },
  failed: { label: 'не выполнена', tone: 'danger', icon: 'circle-x' },
};

export const SUMMARY_TONES: Record<TSummaryKind, 'info' | 'success' | 'warning' | 'danger'> = {
  running: 'info',
  failed: 'danger',
  outdated: 'warning',
  incomplete: 'warning',
  findings: 'warning',
  risk_accepted: 'info',
  clean: 'success',
};

export const FINDING_STATUS_LABELS: Record<TFindingStatus, { label: string; tone: TBadgeTone; icon: TIconName; dashed?: boolean }> = {
  open: { label: 'открыто', tone: 'warning', icon: 'file-exclamation-point' },
  in_progress: { label: 'в работе', tone: 'info', icon: 'loader-circle' },
  resolved: { label: 'решено', tone: 'success', icon: 'check' },
  accepted_risk: { label: 'риск принят', tone: 'accent', icon: 'shield-x' },
  rejected: { label: 'отклонено', tone: 'muted', icon: 'circle-x' },
  stale: { label: 'устарело', tone: 'warning', icon: 'clock-alert', dashed: true },
};

export const SEVERITY_LABELS: Record<TSeverity, { label: string; tone: TBadgeTone }> = {
  critical: { label: 'критичное', tone: 'danger' },
  major: { label: 'существенное', tone: 'warning' },
  minor: { label: 'незначительное', tone: 'neutral' },
};

export const CONFIDENCE_LABELS: Record<TConfidence, string> = { low: 'низкая', medium: 'средняя', high: 'высокая' };

export const ORIGIN_LABELS: Record<string, string> = { rule: 'правило', model_suggestion: 'гипотеза модели, принята человеком', human: 'человек' };

export const SIDE_LABELS: Record<string, string> = { left: 'Основание', right: 'Сопоставлено', context: 'Контекст' };

export const AXIS_LABELS: Record<TAxis, string> = {
  customer_position: 'Позиция заказчика',
  calculation: 'Учтено в расчёте',
  proposal: 'Отражено в КП',
  documents: 'Закреплено в документах',
};

export const AXIS_VALUES: Record<TAxis, Record<string, string>> = {
  customer_position: {
    unknown: 'неизвестна',
    proposed_by_contractor: 'предложено подрядчиком',
    discussed_orally: 'обсуждено устно',
    agreed_in_writing: 'согласовано письменно',
    rejected_by_customer: 'отклонено заказчиком',
  },
  calculation: { not_reflected: 'не учтено', partially_reflected: 'учтено частично', reflected: 'учтено', not_applicable: 'не применимо' },
  proposal: { not_reflected: 'не отражено', reflected: 'отражено', not_applicable: 'не применимо' },
  documents: { not_fixed: 'не закреплено', fixed_in_tz: 'закреплено в ТЗ', fixed_in_contract: 'закреплено в договоре', not_applicable: 'не применимо' },
};

// Подсказка к значению оси: какое основание требуется (I08, A01, A03).
export const AXIS_BASIS_HINTS: Record<string, string> = {
  agreed_in_writing: 'Нужно письменное основание: письмо, ответ заказчика или документ. Речь переговоров и подсказка не подходят.',
  rejected_by_customer: 'Нужно письменное основание: письмо, ответ заказчика или документ.',
  discussed_orally: 'Основание — реплика переговоров; подсказка сервиса переговоров основанием не бывает.',
  fixed_in_tz: 'Нужен фрагмент ТЗ: согласие письмом ТЗ не меняет.',
  fixed_in_contract: 'Нужен фрагмент договора или допсоглашения.',
};

export const DECISION_TYPE_LABELS: Record<string, string> = {
  finding_resolution: 'Решение по замечанию',
  finding_risk_acceptance: 'Принятие риска',
  discrepancy_decision: 'Решение по разногласию',
};

export const EVENT_KIND_LABELS: Record<string, string> = {
  created: 'создано',
  status: 'статус',
  severity: 'критичность',
  confidence: 'уверенность',
  owner: 'ответственный',
  action: 'действие',
  impact: 'влияние',
};

export const statusLabel = (value: string | null): string => (value ? (FINDING_STATUS_LABELS[value as TFindingStatus]?.label ?? SEVERITY_LABELS[value as TSeverity]?.label ?? CONFIDENCE_LABELS[value as TConfidence] ?? value) : '—');
