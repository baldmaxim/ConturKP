// Подписи отправки и сравнения выпусков (этап 15; D-035). Отправка — факт отправки: получение и согласие заказчика ею
// не подтверждаются (A46). «Не зарегистрирована» — нет данных, а не «не отправлено» (A33).
import type { IBadgeMeta } from './sourceLabels';

export const SEND_STATE: Record<string, IBadgeMeta> = {
  not_registered: { label: 'Отправка не зарегистрирована', icon: 'send', tone: 'muted', dashed: true },
  registered_unchecked: { label: 'Отправка без сверки состава', icon: 'send', tone: 'info', dashed: true },
  verified: { label: 'Отправка подтверждена', icon: 'send', tone: 'success' },
  disputed: { label: 'Состав не совпал', icon: 'file-exclamation-point', tone: 'danger' },
};

export const SEND_STATUS: Record<string, IBadgeMeta> = {
  registered: { label: 'Зарегистрирована без сверки', icon: 'send', tone: 'info', dashed: true },
  verified: { label: 'Подтверждена', icon: 'check', tone: 'success' },
  disputed: { label: 'Состав не совпал', icon: 'file-exclamation-point', tone: 'danger' },
};

export const SEND_CHANNEL: Record<string, string> = { email: 'Электронная почта', customer_portal: 'Портал заказчика', paper: 'На бумаге', other: 'Другой канал' };

export const SEND_BLOCKED: Record<string, string> = {
  release_is_test: 'Тестовый выпуск не отправляется: зарегистрировать можно только нарушение',
  held: 'Отправка удержана: по новым событиям этапа нужно решение руководителя',
  excluded: 'Отправка исключена: по событию решено «влияет» — нужен новый комплект',
  intake_not_current: 'Отправка удержана: канал поступления не проверен',
};

export const SEND_WARNING: Record<string, string> = {
  not_placed: 'Выпуск ещё не размещён во всех назначениях',
  cloud_unconfirmed: 'Доставка в облако Яндекс Диска не подтверждена',
};

export const FILE_CLASS: Record<string, string> = {
  kit: 'файл комплекта',
  internal: 'внутренний файл этого выпуска',
  other_release: 'файл другого комплекта',
  unknown: 'нет в комплекте',
};

export const INCIDENT_KIND: Record<string, string> = {
  test_release_sent_externally: 'Тестовый комплект ушёл заказчику',
  sent_despite_blocker: 'Комплект отправлен, хотя отправка удержана или исключена',
  other: 'Другое нарушение',
};

// ---------------------------------------------------------------- Сравнение выпусков

export const COMPARE_SECTION: Record<string, string> = {
  sources: 'Источники',
  requirements: 'Требования',
  questions: 'Вопросы',
  terms: 'Условия и факты документов',
  decisions: 'Решения',
  applications: 'Приложения и файлы',
  received: 'Получено между выпусками',
};

export const SECTION_ORDER = ['sources', 'requirements', 'questions', 'terms', 'decisions', 'applications', 'received'] as const;

export const CHANGE: Record<string, IBadgeMeta> = {
  added: { label: 'Добавлено', icon: 'plus', tone: 'success' },
  removed: { label: 'Снято', icon: 'x', tone: 'danger' },
  changed: { label: 'Изменено', icon: 'pencil', tone: 'warning' },
  revision_changed: { label: 'Новая редакция', icon: 'files', tone: 'warning' },
  recognition_changed: { label: 'Новое распознавание', icon: 'scan-search', tone: 'info' },
  same_content: { label: 'То же содержимое', icon: 'copy', tone: 'muted' },
  coverage_changed: { label: 'Изменено покрытие', icon: 'list-checks', tone: 'warning' },
  status_changed: { label: 'Изменён статус', icon: 'repeat', tone: 'warning' },
  answered: { label: 'Получен ответ', icon: 'message-square', tone: 'success' },
  withdrawn: { label: 'Вопрос снят', icon: 'undo-2', tone: 'muted' },
  opened: { label: 'Открыт вопрос', icon: 'message-square', tone: 'warning' },
  closed: { label: 'Вопрос закрыт', icon: 'check', tone: 'success' },
  superseded: { label: 'Заменено решением', icon: 'repeat', tone: 'warning' },
  renamed: { label: 'Переименован', icon: 'copy', tone: 'muted' },
  in_scope: { label: 'В области выпуска', icon: 'check', tone: 'success' },
  out_of_scope: { label: 'Вне области выпуска', icon: 'ban', tone: 'muted' },
  late_recognized: { label: 'Поздно распознан', icon: 'clock-alert', tone: 'warning' },
  same_content_new_name: { label: 'То же содержимое, новое имя', icon: 'copy', tone: 'muted' },
  not_recognized: { label: 'Не распознан', icon: 'file-question-mark', tone: 'warning', dashed: true },
};

export const SUBJECT: Record<string, string> = {
  document_revision: 'Документ',
  document_occurrence: 'Место получения',
  mail_message_revision: 'Письмо',
  mail_message: 'Письмо',
  transcript_revision: 'Транскрипция',
  requirement_revision: 'Требование',
  qa_item_revision: 'Вопрос–ответ',
  customer_question: 'Вопрос заказчику',
  evidence_fact: 'Факт документа',
  decision: 'Решение',
  risk_acceptance: 'Принятый риск',
  finding_risk: 'Риск по замечанию',
  hold_decision: 'Решение по событию',
  candidate_file: 'Файл комплекта',
  field_version: 'Поле приложения',
};

export const REASON_STATUS: Record<string, IBadgeMeta> = {
  unknown: { label: 'Причина не установлена', icon: 'file-question-mark', tone: 'muted', dashed: true },
  hypothesis: { label: 'Причина — гипотеза', icon: 'info', tone: 'warning', dashed: true },
  confirmed: { label: 'Причина подтверждена', icon: 'shield-check', tone: 'success' },
};

export const REASON_KIND: Record<string, string> = {
  document: 'Документ',
  answer: 'Ответ или письмо заказчика',
  supplier: 'Предложение поставщика',
  internal_decision: 'Внутреннее решение',
  unknown: 'Не установлена',
};

export const DISPOSITION: Record<string, string> = {
  not_applicable: 'решение руководителя: «не влияет»',
  requires_new_candidate: 'решение руководителя: «влияет»',
  none: 'решения по документу нет',
};

export const COVERAGE: Record<string, string> = { covered: 'покрыто', partial: 'покрыто частично', uncovered: 'не покрыто', not_applicable: 'неприменимо', needs_review: 'нужна проверка' };

export const MEASURE: Record<string, string> = { cost: 'Прямые затраты', commercial: 'Коммерческая стоимость' };
