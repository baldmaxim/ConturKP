// Справочники этапа 09 (D-029; docs/architecture/09-review-checks-design.md §2–§5). БД повторяет проверки и виды замечаний
// таблицами review_check и review_finding_kind (миграция 0024) — менять вместе.
import { canonicalJson } from '../requirements.ts';
import { sha256Hex } from '../search.ts';

export const REVIEW_RULES_VERSION = 'rules/09-1';

export const REVIEW_CHECKS = [
  'processing',
  'registry',
  'coverage',
  'parameters',
  'units',
  'quantities',
  'obligations',
  'pd_uncertainty',
  'source_conflicts',
  'customer_silence',
  'stale_basis',
  'model_hypotheses',
] as const;
export type ReviewCheckCode = (typeof REVIEW_CHECKS)[number];
export type RuleCheckCode = Exclude<ReviewCheckCode, 'model_hypotheses'>;

export const REVIEW_CHECK_TITLES: Record<ReviewCheckCode, string> = {
  processing: 'Полнота обработки источников',
  registry: 'Полнота реестра требований',
  coverage: 'Покрытие требований расчётом',
  parameters: 'Параметры требований в строках расчёта',
  units: 'Единицы требований и расчёта',
  quantities: 'Количества, дубли и объёмы',
  obligations: 'Договорные обязательства',
  pd_uncertainty: 'Неопределённость ПД',
  source_conflicts: 'Конфликты источников',
  customer_silence: 'Молчание заказчика',
  stale_basis: 'Устаревшие основания',
  model_hypotheses: 'Гипотезы модели',
};

export type CheckOutcome = 'passed' | 'failed' | 'not_applicable' | 'incomplete' | 'error';
export type ReviewRunStatus = 'queued' | 'running' | 'completed' | 'completed_with_gaps' | 'failed';

export type Severity = 'critical' | 'major' | 'minor';
export type Confidence = 'low' | 'medium' | 'high';

export const FINDING_KINDS = [
  'coverage_gap',
  'parameter_mismatch',
  'unit_mismatch',
  'quantity_mismatch',
  'quantity_uncertain',
  'duplicate_position',
  'contract_obligation',
  'pd_uncertainty',
  'source_conflict',
  'customer_silence',
  'stale_basis',
  'registry_incomplete',
  'model_hypothesis',
  'human',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

// Таблица критичности по умолчанию — D-029 (§11.1, подтверждена владельцем): «критичное» ставит только человек; принятие
// риска не допускается для технической целостности (В-09-3).
export const FINDING_KIND_META: Record<FindingKind, { title: string; check: ReviewCheckCode | null; severity: 'major' | 'minor' | null; riskAcceptable: boolean }> = {
  coverage_gap: { title: 'Требование не покрыто расчётом', check: 'coverage', severity: 'major', riskAcceptable: true },
  parameter_mismatch: { title: 'Параметр требования не найден в строке расчёта', check: 'parameters', severity: 'major', riskAcceptable: true },
  unit_mismatch: { title: 'Единица требования и расчёта не совпадает', check: 'units', severity: 'major', riskAcceptable: true },
  quantity_mismatch: { title: 'Количество требования не совпадает с объёмом', check: 'quantities', severity: 'major', riskAcceptable: true },
  quantity_uncertain: { title: 'Величины не сопоставимы', check: 'quantities', severity: 'minor', riskAcceptable: true },
  duplicate_position: { title: 'Дубль позиции расчёта', check: 'quantities', severity: 'minor', riskAcceptable: true },
  contract_obligation: { title: 'Обязательство договора не отражено в расчёте', check: 'obligations', severity: 'major', riskAcceptable: true },
  pd_uncertainty: { title: 'Неопределённость ПД без допущения или вопроса', check: 'pd_uncertainty', severity: 'minor', riskAcceptable: true },
  source_conflict: { title: 'Источники дают разные значения', check: 'source_conflicts', severity: 'major', riskAcceptable: true },
  customer_silence: { title: 'Вопрос заказчику без ответа', check: 'customer_silence', severity: 'minor', riskAcceptable: true },
  stale_basis: { title: 'Основание перекрыто или устарело', check: 'stale_basis', severity: 'major', riskAcceptable: false },
  registry_incomplete: { title: 'Реестр требований не пройден полностью', check: 'registry', severity: 'major', riskAcceptable: false },
  model_hypothesis: { title: 'Гипотеза модели, принятая человеком', check: 'model_hypotheses', severity: null, riskAcceptable: true },
  human: { title: 'Замечание человека', check: null, severity: null, riskAcceptable: true },
};

export const FINDING_STATUSES = ['open', 'in_progress', 'resolved', 'accepted_risk', 'rejected', 'stale'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type FindingOrigin = 'rule' | 'model_suggestion' | 'human';

// Машина состояний замечания (state-machines §10); «устарело» ставит только инвалидация, «принять риск» — руководитель.
export const FINDING_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  open: ['in_progress', 'resolved', 'accepted_risk', 'rejected', 'stale'],
  in_progress: ['resolved', 'accepted_risk', 'rejected', 'stale'],
  resolved: ['stale'],
  accepted_risk: ['stale'],
  rejected: ['stale'],
  stale: ['open'],
};
// Переходы, доступные человеку командой (stale — только система).
export const HUMAN_FINDING_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  open: ['in_progress', 'resolved', 'accepted_risk', 'rejected'],
  in_progress: ['resolved', 'accepted_risk', 'rejected'],
  resolved: [],
  accepted_risk: [],
  rejected: [],
  stale: ['open'],
};
// Нерешённые для сводки: требуют внимания человека.
export const UNSETTLED_FINDING_STATUSES: readonly FindingStatus[] = ['open', 'in_progress', 'stale'];

// ---------------------------------------------------------------- Приоритет источников (D-029, В-09-1)

export const SOURCE_KINDS = ['contract', 'tz', 'qa_answer', 'customer_letter', 'pd_rd', 'minutes', 'negotiation_speech', 'other'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
// Порядок по умолчанию подтверждён владельцем: договор и допсоглашения → ТЗ → ответы заказчика → письма → ПД/РД →
// протоколы → речь на переговорах; прочее — последним.
export const DEFAULT_SOURCE_PRIORITY: readonly SourceKind[] = SOURCE_KINDS;
export const SOURCE_KIND_TITLES: Record<SourceKind, string> = {
  contract: 'Договор и допсоглашения',
  tz: 'ТЗ',
  qa_answer: 'Ответы заказчика (вопросы–ответы)',
  customer_letter: 'Письма заказчика',
  pd_rd: 'ПД / РД',
  minutes: 'Протоколы',
  negotiation_speech: 'Речь на переговорах',
  other: 'Прочее',
};

export const isSourcePriority = (kinds: readonly string[]): kinds is SourceKind[] =>
  kinds.length === SOURCE_KINDS.length && new Set(kinds).size === SOURCE_KINDS.length && kinds.every((k) => (SOURCE_KINDS as readonly string[]).includes(k));

// Вид источника фрагмента — по происхождению и документу, не по дате. Подсказка переговоров источником позиции не бывает.
export const sourceKindOf = (s: { origin: string; docType: string | null; contractDocument: boolean }): SourceKind | null => {
  switch (s.origin) {
    case 'qa_answer':
      return 'qa_answer';
    case 'email_body':
    case 'attachment_text':
      return 'customer_letter';
    case 'negotiation_speech':
      return 'negotiation_speech';
    case 'negotiation_hint':
    case 'qa_question':
    case 'model_description':
      return null;
    default:
      break;
  }
  if (s.contractDocument || s.docType === 'contract') return 'contract';
  switch (s.docType) {
    case 'tz':
      return 'tz';
    case 'pd':
    case 'rd':
      return 'pd_rd';
    case 'minutes':
      return 'minutes';
    case 'letter':
      return 'customer_letter';
    case 'qa_form':
      return 'qa_answer';
    default:
      return 'other';
  }
};

// Предлагаемая сторона конфликта: источник выше по приоритету; одного вида или вид неизвестен — приоритет не различает.
export const suggestedSide = (priority: readonly SourceKind[], left: SourceKind | null, right: SourceKind | null): 'left' | 'right' | null => {
  if (!left || !right || left === right) return null;
  return priority.indexOf(left) < priority.indexOf(right) ? 'left' : 'right';
};

// ---------------------------------------------------------------- Оси разногласия (I09, data-model §4.7.1)

export const DISCREPANCY_AXES = {
  customer_position: ['unknown', 'proposed_by_contractor', 'discussed_orally', 'agreed_in_writing', 'rejected_by_customer'],
  calculation: ['not_reflected', 'partially_reflected', 'reflected', 'not_applicable'],
  proposal: ['not_reflected', 'reflected', 'not_applicable'],
  documents: ['not_fixed', 'fixed_in_tz', 'fixed_in_contract', 'not_applicable'],
} as const;
export type DiscrepancyAxis = keyof typeof DISCREPANCY_AXES;
export const DISCREPANCY_AXIS_KEYS = Object.keys(DISCREPANCY_AXES) as DiscrepancyAxis[];
export const AXIS_DEFAULTS: Record<DiscrepancyAxis, string> = {
  customer_position: 'unknown',
  calculation: 'not_reflected',
  proposal: 'not_reflected',
  documents: 'not_fixed',
};
export const isAxisValue = (axis: DiscrepancyAxis, value: string): boolean => (DISCREPANCY_AXES[axis] as readonly string[]).includes(value);
// Значения, требующие письменного основания (I08, A01, A03).
export const WRITTEN_BASIS_VALUES: readonly string[] = ['agreed_in_writing', 'rejected_by_customer'];
export const WRITTEN_ORIGINS: readonly string[] = ['document_text', 'recognized_text', 'email_body', 'attachment_text', 'qa_answer'];

// ---------------------------------------------------------------- Версия правил

// Фразы неопределённости ПД (C08): величина уточняется позже — нужна явная оговорка (допущение или вопрос), A06.
export const PD_UNCERTAINTY_PATTERNS: readonly RegExp[] = [
  /(?:уточн|определ)\p{L}*[^.;!?]{0,40}?(?:(?<!\p{L})рд(?!\p{L})|рабоч\p{L}*\s+документац)/iu,
  /(?:будет|будут|подлежит|подлежат)\s+(?:дополнительно\s+)?уточн[её]н/iu,
  /ориентировочн/iu,
];

// Хэш правил: версия, проверки, виды и критичность, фразы. Меняется вместе с правилами — прогон хранит его.
export const REVIEW_RULES_SHA256 = sha256Hex(
  `kontur.review_rules.v1\n${canonicalJson({
    version: REVIEW_RULES_VERSION,
    checks: REVIEW_CHECKS,
    kinds: FINDING_KIND_META,
    pd: PD_UNCERTAINTY_PATTERNS.map((p) => p.source),
  })}`,
);
