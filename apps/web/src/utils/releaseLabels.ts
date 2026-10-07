// Подписи комплекта-кандидата (этап 12; D-032). Статус «готов к согласованию» — не разрешение на выпуск: согласование
// и блокеры — этап 13; отметки и известные блокеры показываются, а не скрываются (I18).
import type { IBadgeMeta } from './sourceLabels';

export const CANDIDATE_STATUS: Record<string, IBadgeMeta> = {
  assembling: { label: 'Собирается', icon: 'loader-circle', tone: 'info' },
  assembly_failed: { label: 'Сборка не удалась', icon: 'circle-x', tone: 'danger' },
  ready_for_approval: { label: 'Собран — к согласованию', icon: 'check', tone: 'success' },
  approved: { label: 'Согласован', icon: 'stamp', tone: 'accent' },
  returned: { label: 'Возвращён на доработку', icon: 'undo-2', tone: 'warning' },
  released: { label: 'Выпущен', icon: 'package-check', tone: 'success' },
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

// Матрица блокеров этапа 13 (D-033): что запрещает действие и снимается ли принятием риска.
export const BLOCKER_TITLES: Record<string, string> = {
  ACTOR_NOT_AUTHORIZED: 'Нет полномочий',
  RESTRICTED_INPUTS: 'Входы комплекта закрыты для вас',
  APPROVAL_NOT_ACTIVE: 'Нет действующего согласования этого содержимого',
  CANDIDATE_CONTENT_MISMATCH: 'Файлы в хранилище не совпадают с согласуемыми',
  REVIEW_SCOPE_MISMATCH: 'Проверки построены на другом снимке или расчёте',
  REVIEW_OUTDATED: 'Проверки устарели: нужен новый прогон и новый комплект',
  REVIEW_MISSING: 'Нет завершённого прогона проверок',
  REVIEW_PROCESSING_INCOMPLETE: 'Обработка неполна или с ошибками',
  INPUTS_CHANGED: 'После сборки поступила информация без решения',
  INTAKE_NOT_CURRENT: 'Канал поступления давно не проверялся',
  FIELDS_STALE: 'Основание значения поля изменилось',
  CALCULATION_PROVISIONAL: 'Расчёт предварительный (Q-01, X-01)',
  TEMPLATE_DEMO: 'Демонстрационная форма (Q-08)',
  KP_TOTAL_NOT_APPROVED: 'Правило итога КП не утверждено (Q-05)',
  REVIEW_UNCERTAIN: 'Покрытие требований не оценено',
  CRITICAL_FINDINGS_OPEN: 'Открыты критические замечания',
  QUESTIONS_UNANSWERED: 'Вопросы заказчику без ответа',
  FIELDS_INCOMPLETE: 'Поля не сверены',
  NUMBERS_UNVERIFIED: 'Числа не сверены с расчётом',
};

export const BLOCKER_CLASS: Record<string, string> = {
  authority: 'полномочия',
  technical: 'технический',
  integrity: 'целостность',
  business: 'бизнес-риск',
};

export const HOLD_STATUS: Record<string, IBadgeMeta> = {
  open: { label: 'Ждёт решения', icon: 'octagon-pause', tone: 'danger' },
  resolved_not_applicable: { label: 'Не влияет', icon: 'check', tone: 'success' },
  resolved_requires_new_candidate: { label: 'Влияет — нужен новый комплект', icon: 'undo-2', tone: 'warning' },
};

export const SEND_READINESS: Record<string, IBadgeMeta> = {
  ready: { label: 'Готов к отправке', icon: 'send', tone: 'success' },
  held: { label: 'Отправка удержана', icon: 'octagon-pause', tone: 'danger' },
  excluded: { label: 'Отправка исключена: нужен новый комплект', icon: 'ban', tone: 'danger' },
  intake_not_current: { label: 'Отправка удержана: канал поступления не проверен', icon: 'octagon-pause', tone: 'warning' },
};

export const HISTORY_ACTIONS: Record<string, string> = {
  created: 'Сборка начата',
  assembled: 'Комплект собран',
  assembly_failed: 'Сборка не удалась',
  risk_accepted: 'Принят риск',
  approved: 'Согласовано',
  approval_revoked: 'Согласование отозвано',
  approval_superseded: 'Согласование заменено новым комплектом',
  hold_not_applicable: 'Решение по событию: не влияет',
  hold_requires_new_candidate: 'Решение по событию: влияет',
  returned: 'Возвращён на доработку',
  released: 'Выпущено',
  superseded: 'Заменён новым комплектом',
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
