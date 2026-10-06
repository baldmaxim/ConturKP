// Подписи комплекта-кандидата (этап 12; D-032). Статус «готов к согласованию» — не разрешение на выпуск: согласование
// и блокеры — этап 13; отметки и известные блокеры показываются, а не скрываются (I18).
import type { IBadgeMeta } from './sourceLabels';

export const CANDIDATE_STATUS: Record<string, IBadgeMeta> = {
  assembling: { label: 'Собирается', icon: 'loader-circle', tone: 'info' },
  assembly_failed: { label: 'Сборка не удалась', icon: 'circle-x', tone: 'danger' },
  ready_for_approval: { label: 'Собран — к согласованию', icon: 'check', tone: 'success' },
  superseded: { label: 'Заменён новым', icon: 'repeat', tone: 'muted', dashed: true },
};

export const MODE_LABEL: Record<string, string> = { test: 'Тестовый', production: 'Боевой' };

export const CHECK_LABELS: Record<string, string> = {
  placeholders_left: 'Остатки разметки',
  render_complete: 'Полнота отрисовки',
  fonts_embedded: 'Шрифты встроены',
  font_substituted: 'Подмена шрифтов',
  cell_overflow: 'Переполнение ячеек',
  numbers_match_calculation: 'Числа и расчёт',
  hashes: 'SHA-256 файлов',
  converter_unavailable: 'Конвертер',
  conversion_failed: 'Конвертация в PDF',
  restricted_inputs: 'Права на входы',
  creator_not_authorized: 'Права создателя',
  markup_missing: 'Разметка образца',
  render_failed: 'Генерация',
  assembly_error: 'Ошибка сборки',
};

export const OUTCOME_LABEL: Record<string, IBadgeMeta> = {
  passed: { label: 'Пройдено', icon: 'check', tone: 'success' },
  failed: { label: 'Не пройдено', icon: 'circle-x', tone: 'danger' },
  unverified: { label: 'Не сверено', icon: 'file-question-mark', tone: 'warning', dashed: true },
  not_applicable: { label: 'Не применимо', icon: 'circle-dot', tone: 'muted' },
};

export const BLOCKER_LABELS: Record<string, string> = {
  CALCULATION_PROVISIONAL: 'Расчёт предварительный (X-01): боевой выпуск запрещён до решения владельца',
  TEMPLATE_DEMO: 'Демонстрационная форма (Q-08): боевой выпуск запрещён до проверки реальных форм',
};

export const noteLabel = (note: string): string => note.replace(/^[A-Z_]+:\s*/u, '');

export const EVENT_LABELS: Record<string, string> = {
  import_accepted: 'Принята загрузка',
  document_revision_registered: 'Новая редакция документа',
  source_set_changed: 'Изменён состав источников',
  recognition_run_completed: 'Завершено распознавание',
  calculation_revision_added: 'Новая ревизия расчёта',
  communication_linked: 'Связано письмо',
  transcript_revision_added: 'Новая редакция переговоров',
  qa_form_added: 'Новые ответы заказчика',
  decision_recorded: 'Записано решение',
  draft_field_changed: 'Изменено поле приложения',
};

export const formatBytes = (n: number): string => (n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1).replace('.', ',')} КБ` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`);
