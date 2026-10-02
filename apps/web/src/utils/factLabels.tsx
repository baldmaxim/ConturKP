// Подписи графа фактов D-018 (D-028; BRAND.md §4.5–4.6): решение правила и решение человека различимы; конфликт и
// неоднозначность — не «ошибка», а вопрос человеку; цвет не единственный носитель смысла.
import type { ReactElement } from 'react';
import type { IGraphFactState, TFactDecisionKind, TRemarkKind } from '../api/factTypes';
import { Badge } from '../components/Badge';

export const DOCUMENT_KIND_LABELS: Record<string, string> = {
  contract: 'Договор',
  amendment: 'Допсоглашение',
  appendix: 'Приложение',
  estimate: 'Смета',
  act: 'Акт',
  letter: 'Письмо',
  other: 'Документ',
};

export const SUPERSEDED_REASON_LABELS: Record<string, string> = {
  amendment: 'перекрыт допсоглашением',
  human: 'перекрыт решением человека',
  document_revision: 'прежняя редакция документа',
};

export const REMARK_KIND_LABELS: Record<TRemarkKind, string> = {
  parent_not_found: 'Договор не найден',
  parent_ambiguous: 'Несколько договоров с этим номером',
  undated_amendment: 'Допсоглашение без даты',
  amendment_target_ambiguous: 'Неясно, какое значение изменено',
  value_conflict: 'Значения расходятся',
};

export const DECISION_KIND_LABELS: Record<TFactDecisionKind, string> = {
  prevails: 'действует вместо',
  distinct: 'независимы',
  rule: 'возвращено правилу',
};

export const factStateBadge = (state: IGraphFactState | null): ReactElement => {
  if (!state) return <Badge tone="muted" icon="hourglass" dashed label="Состояние не посчитано" />;
  if (state.status === 'conflict') return <Badge tone="warning" icon="file-exclamation-point" label="Конфликт" />;
  if (state.status === 'superseded') return <Badge tone="muted" icon="clock-alert" dashed label={`Не действует: ${SUPERSEDED_REASON_LABELS[state.supersededReason ?? ''] ?? 'перекрыт'}`} />;
  return <Badge tone="success" icon="check" label="Действует" />;
};

export const decidedByBadge = (state: IGraphFactState | null): ReactElement | null =>
  state?.decidedBy === 'human' ? <Badge tone="accent" icon="user-check" label="Решение человека" /> : null;
