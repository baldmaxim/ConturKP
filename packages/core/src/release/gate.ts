// Матрица блокеров согласования и выпуска (этап 13; D-033; Q-09; state-machines §11.1). Одна функция для карточки,
// согласования, выпуска и (этап 15) отправки: факты собирает слой БД под блокировкой этапа, решение — здесь.
// Технические блокеры, полномочия и целостность принятием риска не снимаются; бизнес-блокеры — по каждому пункту, только
// действующим принятием на этого кандидата (версия изменяемого предмета совпадает), а при выпуске — ещё и учтённым в
// действующем согласовании (В-13-3).

export type GateAction = 'approve' | 'release' | 'send';
export type BlockerClass = 'authority' | 'technical' | 'integrity' | 'business';

export type BlockerCode =
  | 'ACTOR_NOT_AUTHORIZED'
  | 'RESTRICTED_INPUTS'
  | 'APPROVAL_NOT_ACTIVE'
  | 'CANDIDATE_CONTENT_MISMATCH'
  | 'REVIEW_SCOPE_MISMATCH'
  | 'REVIEW_MISSING'
  | 'REVIEW_PROCESSING_INCOMPLETE'
  | 'INPUTS_CHANGED'
  | 'INTAKE_NOT_CURRENT'
  | 'FIELDS_STALE'
  | 'CALCULATION_PROVISIONAL'
  | 'TEMPLATE_DEMO'
  | 'KP_TOTAL_NOT_APPROVED'
  | 'REVIEW_UNCERTAIN'
  | 'CRITICAL_FINDINGS_OPEN'
  | 'QUESTIONS_UNANSWERED'
  | 'FIELDS_INCOMPLETE'
  | 'NUMBERS_UNVERIFIED';

export type RiskSubjectType = 'finding' | 'customer_question' | 'review_check_result' | 'field_version' | 'candidate_check';

interface IBlockerMeta {
  class: BlockerClass;
  acceptable: boolean;
  productionOnly: boolean;
  subjectType: RiskSubjectType | null;
}

// Порядок — порядок показа: полномочия, технические, целостность, бизнес.
export const BLOCKERS: Readonly<Record<BlockerCode, IBlockerMeta>> = {
  ACTOR_NOT_AUTHORIZED: { class: 'authority', acceptable: false, productionOnly: false, subjectType: null },
  RESTRICTED_INPUTS: { class: 'authority', acceptable: false, productionOnly: false, subjectType: null },
  APPROVAL_NOT_ACTIVE: { class: 'authority', acceptable: false, productionOnly: false, subjectType: null },
  CANDIDATE_CONTENT_MISMATCH: { class: 'technical', acceptable: false, productionOnly: false, subjectType: null },
  REVIEW_SCOPE_MISMATCH: { class: 'technical', acceptable: false, productionOnly: false, subjectType: null },
  REVIEW_MISSING: { class: 'integrity', acceptable: false, productionOnly: false, subjectType: null },
  REVIEW_PROCESSING_INCOMPLETE: { class: 'integrity', acceptable: false, productionOnly: false, subjectType: null },
  INPUTS_CHANGED: { class: 'integrity', acceptable: false, productionOnly: false, subjectType: null },
  INTAKE_NOT_CURRENT: { class: 'integrity', acceptable: false, productionOnly: false, subjectType: null },
  FIELDS_STALE: { class: 'integrity', acceptable: false, productionOnly: false, subjectType: null },
  CALCULATION_PROVISIONAL: { class: 'integrity', acceptable: false, productionOnly: true, subjectType: null },
  TEMPLATE_DEMO: { class: 'integrity', acceptable: false, productionOnly: true, subjectType: null },
  KP_TOTAL_NOT_APPROVED: { class: 'integrity', acceptable: false, productionOnly: true, subjectType: null },
  REVIEW_UNCERTAIN: { class: 'business', acceptable: true, productionOnly: false, subjectType: 'review_check_result' },
  CRITICAL_FINDINGS_OPEN: { class: 'business', acceptable: true, productionOnly: false, subjectType: 'finding' },
  QUESTIONS_UNANSWERED: { class: 'business', acceptable: true, productionOnly: false, subjectType: 'customer_question' },
  FIELDS_INCOMPLETE: { class: 'business', acceptable: true, productionOnly: false, subjectType: 'field_version' },
  NUMBERS_UNVERIFIED: { class: 'business', acceptable: true, productionOnly: false, subjectType: 'candidate_check' },
};

export const BLOCKER_CODES = Object.keys(BLOCKERS) as BlockerCode[];
export const ACCEPTABLE_BLOCKERS: readonly BlockerCode[] = BLOCKER_CODES.filter((c) => BLOCKERS[c].acceptable);

// Пункт блокера: предмет (замечание, вопрос, проверка, версия поля, проверка сборки, событие, файл…), его версия и
// подпись. У бизнес-пункта `acceptable` — можно ли принять риск именно по нему (поле без других проблем, D-033 ут. 2).
export interface IGateItem {
  subjectType: string;
  subjectId: string;
  subjectKey?: string;
  subjectVersion?: number | null;
  title: string;
  acceptable?: boolean;
}

export interface IRiskAcceptanceFact {
  id: string;
  blockerCode: BlockerCode;
  subjectType: RiskSubjectType;
  subjectId: string;
  subjectKey: string;
  subjectVersion: number | null;
  reason: string;
  acceptedBy: string;
  acceptedAt: string;
}

export interface IGateFacts {
  mode: 'test' | 'production';
  actorAuthorized: boolean;
  actorSeesContent: boolean;
  // Выпуск: действующее согласование этого кандидата с тем же содержимым, на которое ссылается запрос; null — не проверяется.
  approval: { active: boolean; matches: boolean; acceptedRiskIds: readonly string[] } | null;
  // null — содержимое не сверялось (карточка); иначе — пути файлов, не совпавших с хранилищем.
  contentMismatch: readonly string[] | null;
  reviewScopeMismatch: boolean;
  reviewMissing: boolean;
  reviewProcessing: readonly IGateItem[];
  uncoveredEvents: readonly IGateItem[];
  staleChannels: readonly IGateItem[];
  fieldsStale: readonly IGateItem[];
  calculationProvisional: boolean;
  templateDemo: boolean;
  kpTotalMissing: boolean;
  reviewUncertain: readonly IGateItem[];
  criticalFindings: readonly IGateItem[];
  questions: readonly IGateItem[];
  fieldsIncomplete: readonly IGateItem[];
  numbersUnverified: readonly IGateItem[];
  acceptances: readonly IRiskAcceptanceFact[];
}

export interface IGateBlockerItem extends IGateItem {
  acceptance: IRiskAcceptanceFact | null;
}

export interface IGateBlocker {
  code: BlockerCode;
  class: BlockerClass;
  acceptable: boolean;
  items: IGateBlockerItem[];
  // Пункты без действующего принятия риска (у неснимаемого — все).
  open: number;
}

export interface IGateResult {
  action: GateAction;
  ok: boolean;
  blockers: IGateBlocker[];
  // Принятия, которые снимают пункты сейчас (для записи согласования).
  usedAcceptanceIds: string[];
}

const flag = (on: boolean, title: string): IGateItem[] => (on ? [{ subjectType: 'candidate', subjectId: '', title }] : []);

// Принятие действует для пункта: тот же код, предмет и ключ; у изменяемого предмета — та же версия (D-033 ут. 3).
export const acceptanceFor = (code: BlockerCode, item: IGateItem, acceptances: readonly IRiskAcceptanceFact[]): IRiskAcceptanceFact | null =>
  acceptances.find(
    (a) =>
      a.blockerCode === code &&
      a.subjectType === item.subjectType &&
      a.subjectId === item.subjectId &&
      a.subjectKey === (item.subjectKey ?? '') &&
      (a.subjectVersion ?? null) === (item.subjectVersion ?? null),
  ) ?? null;

export const evaluateGate = (f: IGateFacts, action: GateAction): IGateResult => {
  const raw: [BlockerCode, readonly IGateItem[]][] = [
    ['ACTOR_NOT_AUTHORIZED', flag(!f.actorAuthorized, 'нет права на действие')],
    ['RESTRICTED_INPUTS', flag(!f.actorSeesContent, 'среди входов комплекта есть то, что вы не можете читать')],
    ['APPROVAL_NOT_ACTIVE', action === 'approve' || !f.approval ? [] : flag(!f.approval.active || !f.approval.matches, 'нет действующего согласования этого содержимого')],
    ['CANDIDATE_CONTENT_MISMATCH', (f.contentMismatch ?? []).map((p) => ({ subjectType: 'candidate_file', subjectId: '', subjectKey: p, title: p }))],
    ['REVIEW_SCOPE_MISMATCH', flag(f.reviewScopeMismatch, 'проверки построены на другом снимке или другой ревизии расчёта')],
    ['REVIEW_MISSING', flag(f.reviewMissing, 'нет завершённого прогона проверок')],
    ['REVIEW_PROCESSING_INCOMPLETE', f.reviewProcessing],
    ['INPUTS_CHANGED', f.uncoveredEvents],
    ['INTAKE_NOT_CURRENT', f.staleChannels],
    ['FIELDS_STALE', f.fieldsStale],
    ['CALCULATION_PROVISIONAL', flag(f.calculationProvisional, 'ревизия расчёта предварительная')],
    ['TEMPLATE_DEMO', flag(f.templateDemo, 'в комплекте демонстрационные формы')],
    ['KP_TOTAL_NOT_APPROVED', flag(f.kpTotalMissing, 'правило итога КП не утверждено')],
    ['REVIEW_UNCERTAIN', f.reviewUncertain],
    ['CRITICAL_FINDINGS_OPEN', f.criticalFindings],
    ['QUESTIONS_UNANSWERED', f.questions],
    ['FIELDS_INCOMPLETE', f.fieldsIncomplete],
    ['NUMBERS_UNVERIFIED', f.numbersUnverified],
  ];
  const approvedIds = new Set(f.approval?.acceptedRiskIds ?? []);
  const used: string[] = [];
  const blockers: IGateBlocker[] = [];
  for (const [code, items] of raw) {
    const meta = BLOCKERS[code];
    if (items.length === 0 || (meta.productionOnly && f.mode !== 'production')) continue;
    const out = items.map((item): IGateBlockerItem => {
      if (!meta.acceptable || item.acceptable === false) return { ...item, acceptance: null };
      const found = acceptanceFor(code, item, f.acceptances);
      // При выпуске (и отправке) принятие действует, только если учтено в действующем согласовании.
      const valid = found && (action === 'approve' || approvedIds.has(found.id)) ? found : null;
      return { ...item, acceptance: valid };
    });
    const open = out.filter((i) => i.acceptance === null).length;
    for (const i of out) if (i.acceptance) used.push(i.acceptance.id);
    blockers.push({ code, class: meta.class, acceptable: meta.acceptable, items: out, open });
  }
  return { action, ok: blockers.every((b) => b.open === 0), blockers, usedAcceptanceIds: [...new Set(used)] };
};

// Коды, которые остаются открытыми (для ответа BLOCKER_PRESENT и аудита отказа).
export const openBlockerCodes = (r: IGateResult): BlockerCode[] => r.blockers.filter((b) => b.open > 0).map((b) => b.code);
