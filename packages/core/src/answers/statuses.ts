// Словарь статусов ответа (D-019, AD-08a-2): объединение состояний портала (portal-api §3 п. 4) и «нужно уточнить»
// Locus плюс два положительных итога. Отделён от результатов проверки (`review_check_result.outcome`, этап 09): ни
// одно значение не совпадает, «подтверждено цитатами» — не «проверено по регламенту». Недостаток оснований и отказ
// модели — неполнота (I18).
export const ANSWER_STATUSES = [
  'confirmed_by_citations',
  'citations_disagree',
  'needs_clarification',
  'not_found_in_scope',
  'incomplete_processing',
  'no_data',
  'not_provided',
  'confirmed_discrepancy',
] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

// Ответное ядро 08a не присваивает: отсутствие условия не выводится из ненайденного (I07); подтверждённое
// разногласие — решение человека этапа 09.
export const NOT_ASSIGNED_BY_ANSWER_CORE: readonly AnswerStatus[] = ['not_provided', 'confirmed_discrepancy'];

export const INCOMPLETE_REASONS = ['insufficient_evidence', 'model_failed', 'draft_invalid', 'model_disabled', 'scope_incomplete', 'no_readable_evidence'] as const;
export type IncompleteReason = (typeof INCOMPLETE_REASONS)[number];

// Результаты регламентной проверки (этап 09, data-model `review_check_result`) — для доказательства непересечения.
export const CHECK_OUTCOMES = ['passed', 'failed', 'not_applicable', 'incomplete', 'error'] as const;
