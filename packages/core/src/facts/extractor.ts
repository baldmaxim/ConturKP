// Детерминированное извлечение фактов (D-018, D-028): перенос Locus `fact-extractor.js` (HEAD 33c6bcf), правила
// `rules/1` — дословно. Каждый факт привязан к фрагменту, из которого прочитан; значение, которое правило не читает
// однозначно, не извлекается (без догадок). Отличие Контура — вход: фрагменты прогона распознавания вместо
// markdown-спанов; строка таблицы — фрагмент с якорем строки листа, CSV или таблицы DOCX.
import type { FactNormalized, FactType, IExtractedFact, IFactSpan } from './types.ts';

const DECIMAL = '(\\d+(?:[.,]\\d+)?)';
// Срок аванса читается только из пункта о размере аванса: «зачёт аванса … в течение 30 дней» — не второй срок.
const ADVANCE_SIZE = /аванс\p{L}*[^.%]{0,40}?(?:в\s+размере|составляет)\s+\d/iu;
const AMOUNT = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const ORGANIZATION = '((?:ООО|АО|ПАО|ЗАО|ТОО|ИП)\\s*«[^»]+»)';

const toNumber = (value: string | undefined): number => Number(String(value || '').replace(/[  ]/gu, '').replace(',', '.'));

const currencyOf = (text: string): string => {
  if (/тенге|₸|\bKZT\b/iu.test(text)) return 'KZT';
  if (/руб|₽|\bRUB\b/iu.test(text)) return 'RUB';
  return '';
};

const sentences = (text: string): string[] => String(text || '').split(/(?<=[.;!?])\s+/u);

// Срок или предел относится к обязательству своего предложения: «Аванс 3%. Отчёт в течение 30 дней» — не срок аванса.
const sentenceMatching = (text: string, ...patterns: RegExp[]): string | null => sentences(text).find((sentence) => patterns.every((pattern) => pattern.test(sentence))) ?? null;

interface IFound {
  raw: string;
  normalized: FactNormalized;
  unit?: string;
  condition?: string;
}

const dayTerm = (text: string): IFound | null => {
  const match = text.match(/в\s+течение\s+(\d+)\s+(рабочих|календарных|банковских)?\s*(?:дн\p{L}*)([^.;]*)/iu);
  if (!match) return null;
  return { raw: match[0].trim(), normalized: { days: Number(match[1]), dayKind: (match[2] || '').toLowerCase() || 'unspecified' }, condition: match[3]!.trim() };
};

const periodMonths = (amount: string, unit: string): number => (/^(?:лет|год)/iu.test(unit) ? Number(amount) * 12 : Number(amount));

export const isoDateOf = (value: string): string | null => {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
};

// Каждое правило читает один тип факта из абзаца; `text` — тело пункта (кавычки изменения раскрыты).
const PARAGRAPH_RULES: { type: FactType; read: (text: string) => IFound | null }[] = [
  {
    type: 'party_customer',
    read: (text) => {
      const match = text.match(new RegExp(`Заказчик\\s*:\\s*${ORGANIZATION}`, 'u'));
      return match ? { raw: match[0], normalized: { name: match[1]! } } : null;
    },
  },
  {
    type: 'party_contractor',
    read: (text) => {
      const match = text.match(new RegExp(`(?:Генподрядчик|Подрядчик)\\s*:\\s*${ORGANIZATION}`, 'u'));
      return match ? { raw: match[0], normalized: { name: match[1]! } } : null;
    },
  },
  {
    type: 'contract_price',
    read: (text) => {
      const match = text.match(new RegExp(`цена\\s+договора\\s+составляет\\s+${AMOUNT}`, 'iu'));
      if (!match) return null;
      const sentence = text.slice(match.index).split(/[.;](?:\s|$)/u)[0]!;
      return { raw: match[0], normalized: { amount: toNumber(match[1]), currency: currencyOf(sentence) }, unit: currencyOf(sentence) };
    },
  },
  {
    type: 'vat_rate',
    read: (text) => {
      const match = text.match(new RegExp(`НДС\\s*${DECIMAL}\\s*%`, 'iu'));
      return match ? { raw: match[0], normalized: { percent: toNumber(match[1]) }, unit: '%' } : null;
    },
  },
  {
    type: 'advance_percent',
    read: (text) => {
      const match = text.match(new RegExp(`аванс\\p{L}*[^.%]{0,40}?(?:в\\s+размере|составляет)\\s+${DECIMAL}\\s*%`, 'iu'));
      return match ? { raw: match[0], normalized: { percent: toNumber(match[1]) }, unit: '%' } : null;
    },
  },
  {
    type: 'advance_term',
    read: (text) => {
      const sentence = sentenceMatching(text, ADVANCE_SIZE);
      const term = sentence ? dayTerm(sentence) : null;
      return term ? { ...term, unit: 'days' } : null;
    },
  },
  {
    type: 'retention_percent',
    read: (text) => {
      const match = text.match(new RegExp(`гарантийн\\p{L}*\\s+удержани\\p{L}*[^.%]{0,60}?(?:в\\s+размере|составляет)\\s+${DECIMAL}\\s*%`, 'iu'));
      return match ? { raw: match[0], normalized: { percent: toNumber(match[1]) }, unit: '%' } : null;
    },
  },
  {
    type: 'retention_return_term',
    read: (text) => {
      const sentence = sentenceMatching(text, /гарантийн\p{L}*\s+удержани/iu, /возвра/iu);
      const term = sentence ? dayTerm(sentence) : null;
      return term ? { ...term, unit: 'days' } : null;
    },
  },
  {
    type: 'warranty_period',
    read: (text) => {
      const match = text.match(/гарантийный\s+срок[^.]{0,80}?составляет\s+(\d+)\s*(лет|года|год|месяц\p{L}*)/iu);
      return match ? { raw: match[0], normalized: { months: periodMonths(match[1]!, match[2]!) }, unit: 'months' } : null;
    },
  },
  {
    type: 'work_start_date',
    read: (text) => {
      const match = text.match(/начало\s+(?:выполнения\s+)?работ\s*:\s*(\d{2}\.\d{2}\.\d{4})/iu);
      return match ? { raw: match[0], normalized: { date: isoDateOf(match[1]!) ?? '' }, unit: 'date' } : null;
    },
  },
  {
    type: 'work_end_date',
    read: (text) => {
      const match = text.match(/окончание\s+(?:выполнения\s+)?работ\s*:\s*(\d{2}\.\d{2}\.\d{4})/iu);
      return match ? { raw: match[0], normalized: { date: isoDateOf(match[1]!) ?? '' }, unit: 'date' } : null;
    },
  },
  {
    type: 'penalty_rate',
    read: (text) => {
      const penalty = new RegExp(`неустойк\\p{L}*\\s+в\\s+размере\\s+${DECIMAL}\\s*%`, 'iu');
      const sentence = sentenceMatching(text, penalty);
      const match = sentence?.match(penalty);
      if (!sentence || !match) return null;
      const cap = sentence.slice(match.index).match(new RegExp(`не\\s+более\\s+${DECIMAL}\\s*%`, 'iu'));
      return { raw: match[0], normalized: { percent: toNumber(match[1]), ...(cap ? { capPercent: toNumber(cap[1]) } : {}) }, unit: '%' };
    },
  },
];

const AMENDING_CLAUSE = /пункт\p{L}*\s+(\d+(?:\.\d+)*)\s+договора\s+изложить\s+в\s+новой\s+редакции\s*:?\s*(?:«([\s\S]*)»)?/iu;
const CLAUSE_NUMBER = /^(\d+(?:\.\d+)+)\.?\s/u;

const clauseContext = (text: string): { clauseRef: string; amends: boolean; text: string } => {
  const amending = text.match(AMENDING_CLAUSE);
  if (amending) return { clauseRef: amending[1]!, amends: true, text: amending[2] || text };
  const clause = text.match(CLAUSE_NUMBER);
  return { clauseRef: clause?.[1] ?? '', amends: false, text };
};

const tableRowFact = (text: string): (IFound & { type: FactType }) | null => {
  if (!/итого/iu.test(text)) return null;
  const cells = text
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  const amountCell = [...cells].reverse().find((cell) => new RegExp(`^${AMOUNT}$`, 'u').test(cell));
  if (!amountCell) return null;
  return { type: 'estimate_total', raw: text.trim(), normalized: { amount: toNumber(amountCell), currency: currencyOf(text) }, unit: '' };
};

export const normalizedKey = (normalized: FactNormalized = {}): string =>
  JSON.stringify(
    Object.keys(normalized)
      .sort()
      .map((key) => [key, normalized[key]]),
  );

// Одно значение одного типа, прочитанное в документе дважды, — один факт с несколькими основаниями.
export const extractDocumentFacts = (spans: readonly IFactSpan[]): IExtractedFact[] => {
  const byKey = new Map<string, IExtractedFact>();
  const add = (span: IFactSpan, context: { clauseRef: string; amends: boolean }, found: (IFound & { type: FactType }) | null) => {
    if (!found) return;
    const key = `${found.type}|${normalizedKey(found.normalized)}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.fragmentIds.includes(span.fragmentId)) existing.fragmentIds.push(span.fragmentId);
      return;
    }
    byKey.set(key, {
      factType: found.type,
      rawValue: String(found.raw || '').slice(0, 500),
      normalized: found.normalized,
      normalizedKey: normalizedKey(found.normalized),
      unit: found.unit ?? '',
      condition: (found.condition ?? '').slice(0, 500),
      clauseRef: context.clauseRef,
      amends: context.amends,
      fragmentIds: [span.fragmentId],
    });
  };
  for (const span of spans) {
    if (span.tableRow) {
      add(span, { clauseRef: '', amends: false }, tableRowFact(span.text));
      continue;
    }
    const context = clauseContext(span.text);
    for (const rule of PARAGRAPH_RULES) {
      const found = rule.read(context.text);
      if (found) add(span, context, { type: rule.type, ...found });
    }
  }
  return [...byKey.values()];
};

// Отображаемое значение факта: «10 %», «60 мес.», «30 календарных дн.», «2027-03-31», сумма с валютой, организация.
export const factDisplay = (normalized: FactNormalized): string => {
  if ('name' in normalized) return String(normalized.name);
  if ('percent' in normalized) return `${normalized.percent} %${'capPercent' in normalized ? `, не более ${normalized.capPercent} %` : ''}`;
  if ('months' in normalized) return `${normalized.months} мес.`;
  if ('days' in normalized) return `${normalized.days} ${normalized.dayKind === 'unspecified' ? '' : `${normalized.dayKind} `}дн.`;
  if ('date' in normalized) return String(normalized.date);
  if ('amount' in normalized) return `${normalized.amount}${normalized.currency ? ` ${normalized.currency}` : ''}`;
  return JSON.stringify(normalized);
};

// Параметр кандидата требования из значения факта (D-028, судьба `requirement_candidate`): число отдельно от единицы,
// чтобы конфликт требований этапа 08 (R08-01, R08-03) сравнивал значения, а не строки.
export const factParameter = (normalized: FactNormalized): { value: string; unit: string | null } => {
  if ('percent' in normalized) return { value: String(normalized.percent), unit: '%' };
  if ('months' in normalized) return { value: String(normalized.months), unit: 'мес' };
  if ('days' in normalized) return { value: String(normalized.days), unit: 'дн' };
  if ('date' in normalized) return { value: String(normalized.date), unit: null };
  if ('amount' in normalized) return { value: String(normalized.amount), unit: normalized.currency ? String(normalized.currency) : null };
  if ('name' in normalized) return { value: String(normalized.name), unit: null };
  return { value: JSON.stringify(normalized), unit: null };
};
