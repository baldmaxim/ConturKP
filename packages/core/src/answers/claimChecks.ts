// Детерминированные проверки утверждения черновика (этап 08a): перенос Locus `claim-checks.js` (HEAD 33c6bcf).
// Выполняются до проверяющей модели и независимо от неё: её ложное «подтверждено» не пропустит в ответ неверное
// число, единицу, ложную цитату или перекрытый пункт. Отличия от донора — только привязка к пакету Контура:
// основание — элемент пакета с ID фрагмента портала; признак редакции — `versionNote` пакета (граф фактов D-018, D-028);
// подтверждают только письменные основания (AD-08a-7).
import { mentionedFactTypes } from '../facts/types.ts';
import { compareQuantities, DURATION_UNITS, extractQuantities, type IQuantity, type QuantityUnit } from './claimNumbers.ts';

export const CLAIM_KINDS = ['fact', 'amount', 'percentage', 'date', 'period', 'condition', 'comparison'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

// Письменные основания (D-018, I06, I08): описание модели, подсказка, речь переговоров и вопрос участника — нет.
export const DOCUMENTARY_ORIGINS: ReadonlySet<string> = new Set(['document_text', 'recognized_text', 'email_body', 'attachment_text', 'qa_answer']);

export type VersionNote = 'current' | 'superseded' | 'conflict';

// Факт графа D-018, основанием которого служит фрагмент, — со своим состоянием (R08a-01: в одном фрагменте могут быть
// действующий и заменённый факты; состояние проверяется по факту, а не по фрагменту целиком).
export interface IItemFact {
  factId: string;
  factType: string;
  status: 'active' | 'superseded' | 'conflict';
  // Фраза фрагмента, из которой прочитано значение (подстрока текста фрагмента).
  rawValue: string;
}

// Элемент пакета доказательств, на который ссылается утверждение меткой E1…En.
export interface IPacketItem {
  label: string;
  fragmentId: string;
  text: string;
  origin: string;
  sourceUnitId: string;
  documentKey: string;
  versionNote: VersionNote;
  reason: string;
  // Факты фрагмента по графу области хода; `undefined` — сведений о фактах нет (решает `versionNote`).
  facts?: readonly IItemFact[];
}

export interface IDraftClaim {
  claimId: string;
  text: string;
  kind: ClaimKind;
  evidenceIds: string[];
}

export type ClaimIssueCode =
  | 'missing_evidence'
  | 'unknown_evidence'
  | 'out_of_scope'
  | 'no_citation_target'
  | 'non_documentary_basis'
  | 'number_not_in_evidence'
  | 'unit_mismatch'
  | 'ambiguous_number'
  | 'superseded_evidence'
  | 'type_mismatch';

export interface IClaimIssue {
  code: ClaimIssueCode;
  detail: string;
}

export interface IClaimCheck {
  claimId: string;
  passed: boolean;
  status: 'passed' | 'unsupported' | 'contradicted';
  issues: IClaimIssue[];
  conflict: boolean;
  // Типы фактов в конфликте, значения которых утверждение использует (для показа обеих сторон расхождения).
  conflictFactTypes: string[];
}

// Проблемы, означающие, что утверждение говорит иное, чем основание (а не просто им не показано).
const CONTRADICTING_ISSUES: ReadonlySet<ClaimIssueCode> = new Set(['unit_mismatch', 'type_mismatch', 'superseded_evidence']);

// Утверждение само говорит о прежней редакции — ссылка на заменённый пункт тогда верна. Контур (R08a-01): глаголы
// изменения и прошедшее время значения («составлял», «изменило») — тоже история.
const HISTORY_WORDING = /ранее|прежн|первоначальн|изначальн|изменен|изменён|изменил|заменен|заменён|составлял|действовал|до\s+(?:подписания\s+|заключения\s+)?(?:доп|дс(?![\p{L}\p{N}]))|в\s+редакции\s+договора|(?<![\p{L}])был[аио]?(?![\p{L}])/iu;
// Подпись называет значение, когда стоит в начале фразы («Срок возврата — 3%») или прямо перед ним
// («в течение 3%»); «Неустойка за нарушение срока — 0,1%» — не срок.
const PERIOD_LABEL = /^\s*(?:срок|период|продолжительн)|(?:в\s+течени\p{L}*|сроком|на\s+срок)\s*$/iu;
const SIZE_LABEL = /^\s*(?:размер|процент|ставк)|(?:в\s+размере|размером|ставкой)\s*$/iu;

const KIND_UNITS: Partial<Record<ClaimKind, (unit: QuantityUnit) => boolean>> = {
  percentage: (unit) => unit === 'percent' || unit === 'fraction',
  period: (unit) => DURATION_UNITS.has(unit) || unit === 'date' || unit === 'calendar_year',
  date: (unit) => unit === 'date' || unit === 'calendar_year',
  // Сумма — деньги или голое число: «Сумма аванса — 10% от цены» — процент, а не сумма.
  amount: (unit) => unit === 'currency' || unit === 'number',
};

// Слова прямо перед величиной — до предыдущей величины или знака препинания («Срок возврата — 3%»).
const labelBefore = (text: string, quantity: IQuantity, previous: IQuantity | undefined): string => {
  const from = Math.max(previous ? previous.index + previous.raw.length : 0, quantity.index - 80);
  const window = text.slice(from, quantity.index);
  const boundary = Math.max(...['.', ';', ',', '\n', '!', '?'].map((mark) => window.lastIndexOf(mark)));
  // Тире и двоеточие между подписью и значением не меняют того, что подпись называет.
  return (boundary >= 0 ? window.slice(boundary + 1) : window).replace(/[\s—–:-]+$/u, '');
};

const typeIssues = (claim: IDraftClaim): IClaimIssue[] => {
  const quantities = extractQuantities(claim.text);
  const issues: IClaimIssue[] = [];
  const kindRule = KIND_UNITS[claim.kind];
  if (kindRule && quantities.length && !quantities.some((quantity) => kindRule(quantity.unit))) {
    issues.push({ code: 'type_mismatch', detail: `kind ${claim.kind} has no matching value` });
  }
  quantities.forEach((quantity, index) => {
    const label = labelBefore(claim.text, quantity, quantities[index - 1]);
    const periodAsShare = PERIOD_LABEL.test(label) && (quantity.unit === 'percent' || quantity.unit === 'currency');
    const shareAsPeriod = SIZE_LABEL.test(label) && !PERIOD_LABEL.test(label) && DURATION_UNITS.has(quantity.unit);
    if (periodAsShare || shareAsPeriod) issues.push({ code: 'type_mismatch', detail: `${quantity.raw} labelled as "${label.trim()}"` });
  });
  return issues;
};

export type VersionPolicy = 'current' | 'historical' | 'all';

export interface IClaimContext {
  evidenceById: ReadonlyMap<string, IPacketItem>;
  // Единицы источника области прогона (allowed_source_unit_ids); null — проверка области не нужна.
  allowedSourceUnitIds: ReadonlySet<string> | null;
  versionPolicy: VersionPolicy;
}

// Утверждение использует значение факта, если называет и его величину, и его условие (R08a-04): величина совпадает
// с величиной фразы факта (та же величина и единица), а подпись этой величины в утверждении — или, если подпись
// условия не называет, всё утверждение — называет тип факта. Совпадение величин разных условий («аванс 20%» и
// «НДС 20%») связи не создаёт. Утверждение, не называющее никакого условия, связывается со всеми фактами той же
// величины — консервативно: заменённое значение без названия условия не проходит. Сторона — по названию организации.
const usesValue = (text: string, fact: IItemFact): boolean => {
  const quantities = extractQuantities(text);
  const whole = mentionedFactTypes(text);
  const named = (types: ReadonlySet<string>): boolean => types.size === 0 || types.has(fact.factType);
  const byValue = compareQuantities(text, [fact.rawValue]).some(({ quantity, status }) => {
    if (status !== 'ok') return false;
    const at = quantities.findIndex((q) => q.index === quantity.index);
    const label = mentionedFactTypes(labelBefore(text, quantity, at > 0 ? quantities[at - 1] : undefined));
    return named(label.size ? label : whole);
  });
  if (byValue) return true;
  const name = /«([^»]+)»/u.exec(fact.rawValue)?.[1];
  return Boolean(name && text.includes(name) && named(whole));
};

// Текст фрагмента без фраз заменённых фактов: опора для чисел утверждения о действующей редакции.
const currentText = (item: IPacketItem): string =>
  (item.facts ?? []).filter((f) => f.status === 'superseded').reduce((text, f) => text.split(f.rawValue).join(' … '), item.text);

export const checkClaim = (claim: IDraftClaim, { evidenceById, allowedSourceUnitIds, versionPolicy }: IClaimContext): IClaimCheck => {
  const issues: IClaimIssue[] = [];
  const evidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
  if (!evidenceIds.length) issues.push({ code: 'missing_evidence', detail: 'claim cites no evidence' });
  const cited: IPacketItem[] = [];
  for (const id of evidenceIds) {
    const item = evidenceById.get(id);
    if (!item) {
      issues.push({ code: 'unknown_evidence', detail: id });
      continue;
    }
    cited.push(item);
    if (allowedSourceUnitIds && !allowedSourceUnitIds.has(item.sourceUnitId)) issues.push({ code: 'out_of_scope', detail: `${id} belongs to ${item.sourceUnitId}` });
    if (!item.fragmentId) issues.push({ code: 'no_citation_target', detail: id });
  }

  // AD-08a-7: величины и факты подтверждаются только письменными основаниями.
  const documentary = cited.filter((item) => DOCUMENTARY_ORIGINS.has(item.origin));
  if (cited.length && !documentary.length) issues.push({ code: 'non_documentary_basis', detail: [...new Set(cited.map((item) => item.origin))].join(',') });

  // Факты цитат, значения которых утверждение использует (R08a-01: состояние — у факта, а не у фрагмента).
  const usedFacts = documentary.flatMap((item) => (item.facts ?? []).filter((f) => usesValue(claim.text, f)));
  if (documentary.length) {
    // R08a-01: о действующей редакции (без исторической формулировки) заменённое значение ничего не подтверждает — ни
    // в целиком перекрытом фрагменте, ни рядом с действующим фактом того же фрагмента, ни рядом с текущей цитатой:
    // числа сверяются только с текстом действующих фактов, а использование заменённого значения отклоняет утверждение.
    const aboutCurrent = versionPolicy === 'current' && !HISTORY_WORDING.test(claim.text);
    const superseded = documentary.filter((item) => item.versionNote === 'superseded');
    const support = aboutCurrent ? documentary.filter((item) => item.versionNote !== 'superseded').map(currentText) : documentary.map((item) => item.text);
    // Только перекрытые цитаты — достаточно одной проблемы `superseded_evidence` (как у донора).
    const numbers = support.length ? compareQuantities(claim.text, support) : [];
    for (const { quantity, status } of numbers) {
      if (status === 'missing') issues.push({ code: 'number_not_in_evidence', detail: quantity.raw });
      if (status === 'unit_mismatch') issues.push({ code: 'unit_mismatch', detail: quantity.raw });
      if (status === 'ambiguous') issues.push({ code: 'ambiguous_number', detail: `${quantity.raw} also appears with another unit` });
    }
    // Заменённое значение, которое не совпадает ни с одним действующим значением того же типа в цитатах.
    const stale = usedFacts.filter((f) => f.status === 'superseded' && !usedFacts.some((g) => g.factType === f.factType && g.status !== 'superseded'));
    if (aboutCurrent && (superseded.length || stale.length)) {
      const where = [...superseded.map((item) => item.label), ...stale.map((f) => `${f.factType}:${f.rawValue}`)];
      issues.push({ code: 'superseded_evidence', detail: `replaced values cited for the current version: ${where.join(', ')}` });
    }
  }
  issues.push(...typeIssues(claim));

  const contradicting = issues.some((issue) => CONTRADICTING_ISSUES.has(issue.code));
  // Конфликт — по фактам, значения которых утверждение использует; без сведений о фактах — по пометке фрагмента.
  const conflictFactTypes = [...new Set(usedFacts.filter((f) => f.status === 'conflict').map((f) => f.factType))];
  return {
    claimId: claim.claimId,
    passed: issues.length === 0,
    status: issues.length === 0 ? 'passed' : contradicting ? 'contradicted' : 'unsupported',
    issues,
    conflict: conflictFactTypes.length > 0 || cited.some((item) => item.facts === undefined && item.versionNote === 'conflict'),
    conflictFactTypes,
  };
};

export const checkClaims = (claims: readonly IDraftClaim[], context: IClaimContext): IClaimCheck[] => claims.map((claim) => checkClaim(claim, context));
