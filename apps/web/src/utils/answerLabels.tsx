// Подписи ответного ядра (этап 08a, AD-08a-2; BRAND.md §4.5–4.6). Статус ответа — свой словарь: «подтверждено
// цитатами» не означает «проверено по регламенту»; неполнота — пунктиром; цвет не единственный носитель смысла.
import type { ReactElement } from 'react';
import type { IAnswerRun, TAnswerStatus, TIncompleteReason, TVersionNote } from '../api/answerTypes';
import { Badge, type TBadgeTone } from '../components/Badge';
import type { TIconName } from '../components/Icon';

interface IStatusMeta {
  label: string;
  tone: TBadgeTone;
  icon: TIconName;
  dashed?: boolean;
}

export const ANSWER_STATUS_META: Record<TAnswerStatus, IStatusMeta> = {
  confirmed_by_citations: { label: 'Подтверждено цитатами', tone: 'accent', icon: 'link' },
  citations_disagree: { label: 'Основания расходятся', tone: 'warning', icon: 'file-exclamation-point' },
  needs_clarification: { label: 'Нужно уточнить вопрос', tone: 'info', icon: 'file-question-mark', dashed: true },
  not_found_in_scope: { label: 'Не найдено в области', tone: 'neutral', icon: 'scan-search' },
  incomplete_processing: { label: 'Неполная обработка', tone: 'warning', icon: 'hourglass', dashed: true },
  no_data: { label: 'Нет данных', tone: 'muted', icon: 'inbox', dashed: true },
  not_provided: { label: 'Не предусмотрено', tone: 'neutral', icon: 'info' },
  confirmed_discrepancy: { label: 'Подтверждённое разногласие', tone: 'danger', icon: 'file-exclamation-point' },
};

export const INCOMPLETE_REASON_LABELS: Record<TIncompleteReason, string> = {
  insufficient_evidence: 'недостаточно оснований',
  model_failed: 'модель не ответила',
  draft_invalid: 'ответ модели не прошёл проверку формата',
  model_disabled: 'модель не настроена',
  scope_incomplete: 'обработка области не завершена',
  no_readable_evidence: 'найденное недоступно по правам',
};

export const VERSION_NOTE_LABELS: Record<Exclude<TVersionNote, 'current'>, string> = {
  superseded: 'Заменённая редакция',
  conflict: 'Расхождение оснований',
};

export const DROP_ISSUE_LABELS: Record<string, string> = {
  missing_evidence: 'без ссылки на основание',
  unknown_evidence: 'ссылка на фрагмент вне пакета',
  out_of_scope: 'основание вне области',
  no_citation_target: 'нечего процитировать',
  non_documentary_basis: 'основание не из текста документа',
  number_not_in_evidence: 'число не подтверждено цитатой',
  unit_mismatch: 'единица не совпадает с цитатой',
  ambiguous_number: 'неоднозначное число',
  superseded_evidence: 'значение заменённой редакции выдано за текущее',
  type_mismatch: 'тип утверждения не совпадает с основанием',
};

export const dropIssueLabel = (code: string): string =>
  DROP_ISSUE_LABELS[code] ?? (code.startsWith('verifier:') ? 'не подтверждено проверкой модели' : code);

/** Бейдж хода: пока ответа нет — состояние задания; после — статус ответа. */
export const answerRunBadge = (run: IAnswerRun): ReactElement => {
  if (run.status === 'queued') return <Badge tone="info" icon="hourglass" dashed label="Вопрос в очереди" />;
  if (run.status === 'running') return <Badge tone="info" icon="loader-circle" dashed label="Ответ составляется" />;
  if (run.status === 'failed' || !run.answerStatus) return <Badge tone="warning" icon="circle-x" dashed label="Ответ не получен" />;
  const meta = ANSWER_STATUS_META[run.answerStatus];
  const reason = run.incompleteReason ? `: ${INCOMPLETE_REASON_LABELS[run.incompleteReason]}` : '';
  return <Badge tone={meta.tone} icon={meta.icon} dashed={meta.dashed} label={`${meta.label}${reason}`} />;
};
