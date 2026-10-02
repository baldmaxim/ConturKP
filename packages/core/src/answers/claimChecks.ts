// Детерминированные проверки утверждения черновика (этап 08a): перенос Locus `claim-checks.js` (HEAD 33c6bcf).
// Выполняются до проверяющей модели и независимо от неё: её ложное «подтверждено» не пропустит в ответ неверное
// число, единицу, ложную цитату или перекрытый пункт. Отличия от донора — только привязка к пакету Контура:
// основание — элемент пакета с ID фрагмента портала; признак редакции — `versionNote` пакета (AD-08a-1);
// подтверждают только письменные основания (AD-08a-7).
import { compareQuantities, DURATION_UNITS, extractQuantities, type IQuantity, type QuantityUnit } from './claimNumbers.ts';

export const CLAIM_KINDS = ['fact', 'amount', 'percentage', 'date', 'period', 'condition', 'comparison'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

// Письменные основания (D-018, I06, I08): описание модели, подсказка, речь переговоров и вопрос участника — нет.
export const DOCUMENTARY_ORIGINS: ReadonlySet<string> = new Set(['document_text', 'recognized_text', 'email_body', 'attachment_text', 'qa_answer']);

export type VersionNote = 'current' | 'superseded' | 'conflict';

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
}

// Проблемы, означающие, что утверждение говорит иное, чем основание (а не просто им не показано).
const CONTRADICTING_ISSUES: ReadonlySet<ClaimIssueCode> = new Set(['unit_mismatch', 'type_mismatch', 'superseded_evidence']);

// Утверждение само говорит о прежней редакции — ссылка на заменённый пункт тогда верна.
const HISTORY_WORDING = /ранее|прежн|первоначальн|изначальн|изменен|заменен|до\s+(?:подписания\s+|заключения\s+)?(?:доп|дс(?![\p{L}\p{N}]))|в\s+редакции\s+договора|(?<![\p{L}])был[аио]?(?![\p{L}])/iu;
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

  if (documentary.length) {
    for (const { quantity, status } of compareQuantities(claim.text, documentary.map((item) => item.text))) {
      if (status === 'missing') issues.push({ code: 'number_not_in_evidence', detail: quantity.raw });
      if (status === 'unit_mismatch') issues.push({ code: 'unit_mismatch', detail: quantity.raw });
      if (status === 'ambiguous') issues.push({ code: 'ambiguous_number', detail: `${quantity.raw} also appears with another unit` });
    }
    const allSuperseded = documentary.every((item) => item.versionNote === 'superseded');
    if (versionPolicy === 'current' && allSuperseded && !HISTORY_WORDING.test(claim.text)) {
      issues.push({ code: 'superseded_evidence', detail: 'only replaced clauses are cited for the current version' });
    }
  }
  issues.push(...typeIssues(claim));

  const contradicting = issues.some((issue) => CONTRADICTING_ISSUES.has(issue.code));
  return {
    claimId: claim.claimId,
    passed: issues.length === 0,
    status: issues.length === 0 ? 'passed' : contradicting ? 'contradicted' : 'unsupported',
    issues,
    conflict: cited.some((item) => item.versionNote === 'conflict'),
  };
};

export const checkClaims = (claims: readonly IDraftClaim[], context: IClaimContext): IClaimCheck[] => claims.map((claim) => checkClaim(claim, context));
