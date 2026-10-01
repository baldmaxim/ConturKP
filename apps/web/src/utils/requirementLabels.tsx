// Подписи и бейджи этапа 08 (BRAND.md §4.5–4.6): тип данных различим — гипотеза модели, предложение
// человека, подтверждение человеком; неполнота — пунктиром; цвет не единственный носитель смысла.
import type { ReactElement } from 'react';
import type { TCandidateOrigin, TCandidateStatus, TCoverageState, TEvidenceRole, TFragmentState } from '../api/requirementTypes';
import { Badge } from '../components/Badge';

export const ROLE_LABELS: Record<TEvidenceRole, string> = {
  supports: 'Основание',
  contradicts: 'Противоречит',
  clarifies: 'Уточняет',
  supersedes_context: 'Контекст замены',
};

export const COVERAGE_LABELS: Record<TCoverageState, string> = {
  uncovered: 'Нет покрытия в расчёте',
  partial: 'Покрыто частично',
  covered: 'Покрыто',
  not_applicable: 'Не применимо',
  needs_review: 'Нужна проверка',
};

export const FRAGMENT_STATE_LABELS: Record<TFragmentState, string> = {
  covered: 'Связан с требованием',
  reviewed: 'Связан с фактом',
  explicitly_not_requirement: 'Не требование',
  unreviewed: 'Не просмотрен',
};

export const SOURCE_KIND_LABELS: Record<string, string> = {
  recognition_run: 'Документ',
  mail_message_revision: 'Письмо',
  transcript_revision: 'Переговоры',
  qa_item_revision: 'Вопрос–ответ',
};

export const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  completed: 'Завершён',
  completed_with_gaps: 'Завершён с пробелами',
  failed: 'Отказ',
};

export const originBadge = (origin: TCandidateOrigin): ReactElement =>
  origin === 'model' ? (
    <Badge tone="info" icon="scan-search" dashed label="Гипотеза модели" />
  ) : origin === 'rule' ? (
    <Badge tone="info" icon="list-checks" label="Факт правила" />
  ) : origin === 'carried' ? (
    <Badge tone="neutral" icon="repeat" label="Перенос из прежнего реестра" />
  ) : (
    <Badge tone="neutral" icon="pencil" label="Предложение человека" />
  );

export const candidateStatusBadge = (s: TCandidateStatus): ReactElement =>
  s === 'confirmed' ? (
    <Badge tone="success" icon="user-check" label="Подтверждено человеком" />
  ) : s === 'rejected' ? (
    <Badge tone="muted" icon="x" label="Отклонено" />
  ) : s === 'superseded' ? (
    <Badge tone="muted" icon="repeat" label="Заменено правкой" />
  ) : (
    <Badge tone="warning" icon="hourglass" dashed label="Ждёт решения" />
  );

export const coverageBadge = (s: TCoverageState | null): ReactElement =>
  s === null ? (
    <Badge tone="muted" icon="circle-dot" dashed label="Покрытие не оценено" />
  ) : s === 'covered' ? (
    <Badge tone="success" icon="check" label={COVERAGE_LABELS[s]} />
  ) : s === 'partial' || s === 'needs_review' ? (
    <Badge tone="warning" icon="clock-alert" dashed label={COVERAGE_LABELS[s]} />
  ) : s === 'uncovered' ? (
    <Badge tone="danger" icon="circle-x" label={COVERAGE_LABELS[s]} />
  ) : (
    <Badge tone="muted" icon="circle-dot" label={COVERAGE_LABELS[s]} />
  );

export const fragmentStateBadge = (s: TFragmentState): ReactElement =>
  s === 'covered' ? (
    <Badge tone="success" icon="check" label={FRAGMENT_STATE_LABELS[s]} />
  ) : s === 'reviewed' ? (
    <Badge tone="info" icon="check" label={FRAGMENT_STATE_LABELS[s]} />
  ) : s === 'explicitly_not_requirement' ? (
    <Badge tone="muted" icon="x" label={FRAGMENT_STATE_LABELS[s]} />
  ) : (
    <Badge tone="warning" icon="hourglass" dashed label={FRAGMENT_STATE_LABELS[s]} />
  );
