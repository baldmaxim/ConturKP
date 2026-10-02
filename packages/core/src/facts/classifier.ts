// Классификатор документа (D-028): перенос Locus `document-classifier.js` (HEAD 33c6bcf) — вид, номер, дата документа
// и ссылка на основной договор читаются правилом из заголовка. Отличие Контура — откуда заголовок: markdown-заголовка
// у фрагментов нет, поэтому заголовок — первый из начальных фрагментов первой страницы, совпавший с шаблоном
// заголовка, иначе имя документа; «голова» — начало текста первой страницы.
import type { DocumentKind, IDocumentClass, IParentRef } from './types.ts';

const NUMBER = '([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\\-/.]*?)';
const DATE = '(\\d{2}\\.\\d{2}\\.\\d{4})';

const AMENDMENT = new RegExp(`дополнительн\\p{L}*\\s+соглашени\\p{L}*\\s*№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, 'iu');
const APPENDIX = new RegExp(`^приложени\\p{L}*\\s*№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, 'iu');
const CONTRACT = new RegExp(`договор\\p{L}*[^№\\n]{0,60}№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, 'iu');
const PARENT_CONTRACT = new RegExp(`к\\s+договор\\p{L}*[^№\\n]{0,60}№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, 'iu');
// Сколько начальных фрагментов первой страницы проверяется как заголовок.
const TITLE_CANDIDATES = 5;
const HEAD_CHARS = 1500;

export const isoDate = (value: string | null | undefined = ''): string | null => {
  const match = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
};

export const normalizeDocumentNumber = (value = ''): string =>
  String(value || '')
    .trim()
    .replace(/[.,;:]+$/u, '')
    .toLowerCase()
    .replaceAll('ё', 'е');

const parentRef = (text: string): IParentRef | null => {
  const match = text.match(PARENT_CONTRACT);
  return match ? { number: match[1]!, numberKey: normalizeDocumentNumber(match[1]), date: isoDate(match[2]) } : null;
};

// Фрагмент — заголовок, если он короткий и начинается с названия документа («Договор …», «Дополнительное соглашение …»,
// «Приложение № …»): упоминание договора внутри письма («… по договору № 15-П …») заголовком не считается.
const TITLE_START = /^\s*(?:договор|дополнительн\p{L}*\s+соглашени|приложени)/iu;
const TITLE_MAX_CHARS = 300;
const isTitle = (text: string): boolean =>
  text.length <= TITLE_MAX_CHARS && TITLE_START.test(text) && (AMENDMENT.test(text) || APPENDIX.test(text) || CONTRACT.test(text));

// Классификация по заголовку и голове документа — дословно донор.
export const classifyByTitle = (title: string, head: string): IDocumentClass => {
  const titleOrHead = `${title}\n${head}`;
  const amendment = title.match(AMENDMENT);
  if (amendment) {
    return { kind: 'amendment', title, number: amendment[1]!, documentDate: isoDate(amendment[2]), parentRef: parentRef(titleOrHead), method: 'title:amendment' };
  }
  const appendix = title.match(APPENDIX);
  if (appendix) {
    return { kind: 'appendix', title, number: appendix[1]!, documentDate: isoDate(appendix[2]), parentRef: parentRef(titleOrHead), method: 'title:appendix' };
  }
  const contract = title.match(CONTRACT);
  // \b в JavaScript только ASCII: конец кириллического слова — обходом Unicode.
  if (contract && !/^\s*(?:письм|акт(?![\p{L}\p{N}])|исх)/iu.test(title)) {
    return { kind: 'contract', title, number: contract[1]!, documentDate: isoDate(contract[2]), parentRef: null, method: 'title:contract' };
  }
  if (/(?:^|\s)смет\p{L}*/iu.test(title) || /\.xlsx?$/iu.test(title) || /^\s{0,3}#{1,6}\s+(?:Лист|sheet)\s*:/imu.test(head)) {
    return { kind: 'estimate', title, number: '', documentDate: null, parentRef: null, method: 'content:estimate' };
  }
  if (/(?:^|\s)акт\p{L}*\s|КС-2|КС-3/iu.test(title)) {
    return { kind: 'act', title, number: '', documentDate: null, parentRef: parentRef(titleOrHead), method: 'title:act' };
  }
  if (/исх\.\s*№/iu.test(head) || /(?:^|\s)письм\p{L}*/iu.test(title)) {
    const outgoing = head.match(new RegExp(`исх\\.\\s*№\\s*${NUMBER}(?:\\s+от\\s+${DATE})?(?=[\\s,.]|$)`, 'iu'));
    return { kind: 'letter', title, number: outgoing?.[1] ?? '', documentDate: isoDate(outgoing?.[2]), parentRef: parentRef(head), method: 'content:letter' };
  }
  return { kind: 'other', title, number: '', documentDate: null, parentRef: null, method: 'none' };
};

/**
 * Классификация документа Контура: `firstPage` — тексты фрагментов первой страницы в порядке чтения,
 * `documentTitle` — имя документа портала. Заголовок — первый из начальных фрагментов, похожий на заголовок
 * договора, допсоглашения или приложения; иначе имя документа (смета, письмо, акт узнаются по нему и по голове).
 */
export const classifyDocument = (o: { firstPage: readonly string[]; documentTitle: string }): IDocumentClass => {
  const head = o.firstPage.join('\n').slice(0, HEAD_CHARS);
  const fromText = o.firstPage.slice(0, TITLE_CANDIDATES).find((text) => isTitle(text.split('\n')[0] ?? ''));
  const title = (fromText?.split('\n')[0] ?? o.documentTitle).trim();
  const result = classifyByTitle(title, head);
  return { ...result, method: fromText ? result.method : `${result.method}:name` };
};

export const documentKindOf = (value: string): DocumentKind =>
  (['contract', 'amendment', 'appendix', 'estimate', 'act', 'letter'] as const).find((k) => k === value) ?? 'other';
