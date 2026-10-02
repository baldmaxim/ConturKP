// Планировщик вопроса (этап 08a): перенос Locus `query-planner.js`, `chat-intent.js` и `conversation-turns.js`
// без выбора проекта по формулировке — область задаёт сервер по правам и контексту диалога (D-019). Правило, не модель.
import type { VersionPolicy } from './claimChecks.ts';

export const PLANNER_VERSION = 'rules/1-kontur';

export type AnswerIntent = 'fact' | 'compare' | 'find_document' | 'follow_up' | 'overview';

export interface IAnswerPlan {
  plannerVersion: string;
  intent: AnswerIntent;
  entities: string[];
  versionPolicy: VersionPolicy;
  followUp: boolean;
  dates: string[];
  // Нужно уточнить до поиска: в вопросе нет ни одного слова или числа.
  needsClarification: boolean;
}

export interface IHistoryTurn {
  question: string;
  answer: string;
}

const ENTITY_PATTERNS: [string, RegExp][] = [
  ['contract_price', /цен\p{L}*\s+договор|стоимост\p{L}*\s+(?:договор|работ)|сумм\p{L}*\s+договор/iu],
  ['vat_rate', /ндс/iu],
  ['advance_percent', /аванс/iu],
  ['retention_percent', /гарантийн\p{L}*\s+удержани/iu],
  ['retention_return_term', /(?:возврат|выплат)\p{L}*[^.?]{0,40}удержани|удержани\p{L}*[^.?]{0,40}(?:возврат|выплат)|срок\p{L}*\s+выплат/iu],
  ['warranty_period', /гарантийн\p{L}*\s+срок/iu],
  ['work_start_date', /начал\p{L}*\s+работ/iu],
  ['work_end_date', /(?:окончани|заверш)\p{L}*\s+работ|срок\p{L}*\s+(?:выполнения|окончания)/iu],
  ['penalty_rate', /неустойк|пени|штраф/iu],
  ['party_customer', /заказчик/iu],
  ['party_contractor', /(?:ген)?подрядчик/iu],
  ['estimate_total', /смет/iu],
];

// \b в JavaScript только ASCII даже с флагом u, поэтому границы кириллических слов — через обходы Unicode.
const HISTORICAL_VERSION = /первоначальн|изначальн|исходн\p{L}*\s+редакци|до\s+(?:подписания\s+|заключения\s+)?(?:доп\p{L}*\.?\s*соглашени|дс(?![\p{L}\p{N}]))|в\s+редакции\s+договора|старая\s+редакция|прежн\p{L}*\s+(?:редакци|услови)/iu;
const ALL_VERSIONS = /истори\p{L}*\s+изменени|все\s+редакции|как\s+менял|изменени\p{L}*\s+(?:по|всех)\s+(?:доп\p{L}*\.?\s*соглашени|дс(?![\p{L}\p{N}]))/iu;
const COMPARE = /сравн|разниц|отлича|чем\s+отлича/iu;
const FIND_DOCUMENT = /(?:найди|покажи|где)\s+(?:документ|файл|договор|акт|письм|смет)|какой\s+документ|в\s+каком\s+(?:документе|файле)/iu;
const DATE = /\b\d{2}\.\d{2}\.\d{4}\b/g;

const normalizeIntentText = (value = ''): string =>
  String(value || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const BROAD_ANSWER = [
  /\b(?:summary|overview|summarize|summarise)\b/i,
  /\b(?:main|key|essential)\s+(?:terms|conditions|points|facts|risks)\b/i,
  /(?:^|\s)(?:основн|ключев|существенн)\p{L}*\s+(?:услов|положен|пункт|факт|риск|требован)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:сводк|обзор|резюме)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:проанализируй|разбери|проверь)\s+(?:договор|контракт|проект)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:что|чего)\s+(?:в|по)\s+(?:договор|контракт)\p{L}*(?:\s|$)/u,
];
const CONTRACT_OVERVIEW = [/(?:^|\s)(?:договор|контракт|соглашени|дс|допсоглашени|услов)\p{L}*(?:\s|$)/u, /\b(?:contract|agreement|terms|conditions)\b/i];
const CONTRACT_OVERVIEW_TERMS = [
  'предмет договора',
  'стороны заказчик подрядчик исполнитель',
  'цена стоимость сумма договора НДС',
  'срок выполнения работ дата окончания период',
  'оплата платеж аванс',
  'гарантийное удержание банковская гарантия обеспечение',
  'ответственность штраф пени неустойка',
  'дополнительное соглашение изменение цены',
].join(' ');

export const hasBroadAnswerIntent = (question = ''): boolean => {
  const text = normalizeIntentText(question);
  return BROAD_ANSWER.some((pattern) => pattern.test(text));
};

// ---------------------------------------------------------------- Уточняющий вопрос (conversation-turns.js)

export const MAX_CONTEXT_TURNS = 6;
export const MAX_HISTORY_ANSWER_CHARS = 600;
export const MAX_HISTORY_QUESTION_CHARS = 400;
const FOLLOW_UP_START = /^(?:а|и|ну|также|тоже|еще|ещё|тогда|то есть|а если|and|also|what about)(?:\s|,|$)/iu;
const FOLLOW_UP_MAX_WORDS = 4;

const words = (text: string): string[] => String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export const isFollowUpQuestion = (question = ''): boolean => {
  const text = String(question || '').trim();
  if (!text) return false;
  return FOLLOW_UP_START.test(text) || words(text).length <= FOLLOW_UP_MAX_WORDS;
};

// Номера цитат относятся к прежнему пакету — из ответа истории они убираются.
export const historyAnswerText = (answer = ''): string => {
  const text = String(answer || '')
    .replace(/(^|\n)\s*Источники\s*:[^\n]*/giu, '')
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > MAX_HISTORY_ANSWER_CHARS ? `${text.slice(0, MAX_HISTORY_ANSWER_CHARS).trim()}…` : text;
};

export const boundedHistory = (turns: readonly IHistoryTurn[]): IHistoryTurn[] =>
  turns.slice(-MAX_CONTEXT_TURNS).map((t) => ({ question: String(t.question || '').slice(0, MAX_HISTORY_QUESTION_CHARS), answer: historyAnswerText(t.answer) }));

// Запрос поиска: обзор договора расширяется условиями; короткий уточняющий вопрос — вместе с предыдущим вопросом.
export const retrievalQuery = (question: string, turns: readonly IHistoryTurn[]): string => {
  const text = normalizeIntentText(question);
  let query = question;
  if (hasBroadAnswerIntent(text) && CONTRACT_OVERVIEW.some((pattern) => pattern.test(text))) query = `${question}\n${CONTRACT_OVERVIEW_TERMS}`;
  const previous = turns.at(-1)?.question ?? '';
  if (previous && isFollowUpQuestion(question)) query = `${query}\n${previous}`;
  return query.slice(0, 1000);
};

// ---------------------------------------------------------------- План

const versionPolicy = (question: string): VersionPolicy => (ALL_VERSIONS.test(question) ? 'all' : HISTORICAL_VERSION.test(question) ? 'historical' : 'current');

export const planQuestion = (question: string, turns: readonly IHistoryTurn[] = []): IAnswerPlan => {
  const followUp = turns.length > 0 && isFollowUpQuestion(question);
  const intent: AnswerIntent = COMPARE.test(question)
    ? 'compare'
    : FIND_DOCUMENT.test(question)
      ? 'find_document'
      : followUp
        ? 'follow_up'
        : hasBroadAnswerIntent(question)
          ? 'overview'
          : 'fact';
  // Сущности уточняющего вопроса — из него самого, а если их нет, то из предыдущего вопроса.
  const own = ENTITY_PATTERNS.filter(([, pattern]) => pattern.test(question)).map(([type]) => type);
  const inherited = followUp && own.length === 0 ? ENTITY_PATTERNS.filter(([, pattern]) => pattern.test(turns.at(-1)?.question ?? '')).map(([type]) => type) : [];
  return {
    plannerVersion: PLANNER_VERSION,
    intent,
    entities: own.length ? own : inherited,
    versionPolicy: versionPolicy(question),
    followUp,
    dates: question.match(DATE) ?? [],
    needsClarification: words(question).length === 0,
  };
};
