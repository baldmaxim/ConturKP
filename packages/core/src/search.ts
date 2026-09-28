// Чистые правила поиска портала (ADR-012): нормализация запроса, нарезка страницы прогона на
// чанки, выбор обозначений для точной ветки, слияние рангов RRF и хэши области. Без ввода-вывода:
// один и тот же вход даёт один и тот же результат, поэтому версии правил записываются в данные.
import { createHash } from 'node:crypto';

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------- Запрос

export const QUERY_NORMALIZATION_VERSION = 'q1';
export const MAX_QUERY_CHARS = 500;

// NFC, пробелы схлопнуты, края обрезаны. Хэш запроса считается по нормализованному тексту.
export const normalizeQuery = (raw: string): string => raw.normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, MAX_QUERY_CHARS);

// Свёртка для точного поиска обозначений — та же, что у search_chunk.search_text (миграция 0009).
export const EXACT_FOLD_FROM = 'ёabcehkmoptxy';
export const EXACT_FOLD_TO = 'еавсенкмортху';

export const exactFold = (text: string): string => {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const i = EXACT_FOLD_FROM.indexOf(ch);
    out += i >= 0 ? EXACT_FOLD_TO[i]! : ch;
  }
  return out;
};

// Обозначения для точной ветки: коды листов, шифры, марки, номера пунктов и позиций, величины.
// Токен с цифрой — обозначение, если в нём есть буква или разделитель либо он не короче 4 символов:
// «B30», «АР-01», «3.1», «0,1%», «2026» — да; «30» — нет, слишком много совпадений. Токен без цифр —
// обозначение, если это заглавные буквы с разделителем («ФИКС-АР», «АР/КЖ»). Двухбуквенные марки
// («КЖ») сюда не входят: подстрокой они совпали бы внутри слов, их находит полнотекстовая ветка.
// Фразы в кавычках ищутся целиком.
const TRIM_PUNCT = /^[\s"'«»„“”()[\]{}:;!?]+|[\s"'«»„“”()[\]{}:;!?.,]+$/gu;

export const designationTokens = (query: string): string[] => {
  const tokens = new Set<string>();
  for (const m of query.matchAll(/["«„“]([^"»”“]{3,200})["»”“]/gu)) tokens.add(exactFold(m[1]!.trim()));
  for (const raw of query.split(/\s+/u)) {
    const t = raw.replace(TRIM_PUNCT, '');
    if (t.length < 2) continue;
    const hasLetter = /\p{L}/u.test(t);
    const hasSeparator = /[.\-/,]/u.test(t);
    if (/\d/u.test(t)) {
      if (hasLetter || hasSeparator || t.length >= 4) tokens.add(exactFold(t));
      continue;
    }
    const letters = t.replace(/[^\p{L}]/gu, '');
    const allCaps = letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
    if (hasSeparator && allCaps) tokens.add(exactFold(t));
  }
  return [...tokens].sort();
};

// ---------------------------------------------------------------- Нарезка чанков

export const CHUNKER_VERSION = 'c1';
// Происхождение, которое индексируется (ADR-012 §21): остальное — skipped/origin_not_evidence.
export const EVIDENCE_ORIGINS: readonly string[] = ['document_text', 'recognized_text', 'email_body', 'attachment_text', 'negotiation_speech'];

export interface IChunkSourceFragment {
  id: string;
  origin: string;
  kind: string;
  text: string;
}

export interface IChunkLink {
  fragmentId: string;
  ordinal: number;
  role: 'header' | 'body';
  // Смещения в тексте чанка header_text + '\n' + body_text.
  charStart: number;
  charEnd: number;
}

export interface IBuiltChunk {
  partNo: number;
  headerText: string;
  bodyText: string;
  links: IChunkLink[];
}

export interface ISkippedFragment {
  fragmentId: string;
  reason: 'origin_not_evidence' | 'empty_text';
}

export interface IChunkOptions {
  maxBodyChars: number;
  maxHeaderChars: number;
  overlapChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: IChunkOptions = { maxBodyChars: 3000, maxHeaderChars: 1000, overlapChars: 600 };

const BODY_SEPARATOR = '\n\n';

// Страница прогона → чанки. Шапка — фрагменты штампа (шифр, лист, наименование, отметки): она
// повторяется в каждой части и весит больше при полнотекстовом ранжировании. Тело режется по
// границам фрагментов; последний фрагмент части повторяется в начале следующей, если он не длиннее
// перекрытия, — фраза на стыке частей не теряется. Фрагмент длиннее части не режется: доказательство
// уже разбито на части при разборе (R04-06).
export const buildPageChunks = (
  fragments: readonly IChunkSourceFragment[],
  options: IChunkOptions = DEFAULT_CHUNK_OPTIONS,
): { chunks: IBuiltChunk[]; indexed: string[]; skipped: ISkippedFragment[] } => {
  const skipped: ISkippedFragment[] = [];
  const header: IChunkSourceFragment[] = [];
  const body: IChunkSourceFragment[] = [];
  for (const f of fragments) {
    if (!EVIDENCE_ORIGINS.includes(f.origin)) skipped.push({ fragmentId: f.id, reason: 'origin_not_evidence' });
    else if (f.text.trim().length === 0) skipped.push({ fragmentId: f.id, reason: 'empty_text' });
    else if (f.kind === 'stamp_block') header.push(f);
    else body.push(f);
  }
  const headerParts: { f: IChunkSourceFragment; text: string }[] = [];
  let headerLength = 0;
  for (const f of header) {
    const text = f.text.trim();
    if (headerLength > 0 && headerLength + 1 + text.length > options.maxHeaderChars) {
      // Лишняя шапка не теряется: она становится обычным фрагментом тела.
      body.unshift(f);
      continue;
    }
    headerParts.push({ f, text });
    headerLength += (headerLength > 0 ? 1 : 0) + text.length;
  }
  const headerText = headerParts.map((h) => h.text).join('\n');
  const parts: IChunkSourceFragment[][] = [];
  let current: IChunkSourceFragment[] = [];
  let length = 0;
  // Перенесённый хвост никогда не остаётся частью в одиночку: в той же итерации к нему
  // добавляется следующий фрагмент.
  for (const f of body) {
    const size = f.text.trim().length;
    if (current.length > 0 && length + BODY_SEPARATOR.length + size > options.maxBodyChars) {
      parts.push(current);
      const tail = current[current.length - 1]!;
      const tailSize = tail.text.trim().length;
      current = tailSize <= options.overlapChars ? [tail] : [];
      length = current.length > 0 ? tailSize : 0;
    }
    length += (current.length > 0 ? BODY_SEPARATOR.length : 0) + size;
    current.push(f);
  }
  if (current.length > 0 || parts.length === 0) parts.push(current);
  const chunks: IBuiltChunk[] = [];
  parts.forEach((part, partNo) => {
    if (part.length === 0 && headerParts.length === 0) return;
    const links: IChunkLink[] = [];
    let offset = 0;
    for (const h of headerParts) {
      links.push({ fragmentId: h.f.id, ordinal: links.length, role: 'header', charStart: offset, charEnd: offset + h.text.length });
      offset += h.text.length + 1;
    }
    const bodyStart = headerText.length + 1;
    const texts: string[] = [];
    let bodyOffset = 0;
    for (const f of part) {
      const text = f.text.trim();
      links.push({ fragmentId: f.id, ordinal: links.length, role: 'body', charStart: bodyStart + bodyOffset, charEnd: bodyStart + bodyOffset + text.length });
      texts.push(text);
      bodyOffset += text.length + BODY_SEPARATOR.length;
    }
    chunks.push({ partNo, headerText, bodyText: texts.join(BODY_SEPARATOR), links });
  });
  const indexedIds = new Set<string>();
  for (const c of chunks) for (const l of c.links) indexedIds.add(l.fragmentId);
  return { chunks, indexed: [...indexedIds], skipped };
};

export const chunkKeyOf = (runId: string, pageIndex: number | null, partNo: number): string =>
  `${runId}:p${pageIndex === null ? 'x' : pageIndex}:c${partNo}`;

// Текст чанка в том виде, в каком он хранится и хэшируется: шапка, перевод строки, тело.
export const chunkText = (c: Pick<IBuiltChunk, 'headerText' | 'bodyText'>): string => `${c.headerText}\n${c.bodyText}`;

// ---------------------------------------------------------------- Ранжирование

export type SearchBranch = 'exact' | 'fts' | 'vector';
export const BRANCH_ORDER: readonly SearchBranch[] = ['exact', 'fts', 'vector'];

// Версия правил ранжирования, закрепляемая в прогоне поиска (ADR-012 §11, G05-04):
// r1 — каждая ветка ранжирует чанки области и проецирует чанк во фрагменты только его связей;
// шапка листа (повторяющийся контекст) цитируется, только если совпадения нет ни в одном фрагменте тела:
//   exact  — до 2 фрагментов с наибольшим числом обозначений запроса (фрагмент без обозначения
//            не цитируется, даже если обозначение есть в соседнем фрагменте чанка);
//   fts    — текст готовится search_prepare (кавычки, тире, № и неразрывный пробел отделяются от слов);
//            основа от 5 символов ищется по префиксу; чанк ранжируется суммой IDF лексем запроса по
//            области, затем ts_rank_cd с весом шапки; до 2 фрагментов, чья сумма IDF своих лексем не
//            меньше половины лучшего фрагмента чанка; обзорный вопрос по договору расширяется
//            перечнем договорных терминов (донор Locus) и даёт по одному фрагменту на чанк —
//            ведущий пункт раздела: первый по порядку совпавший фрагмент тела, не нумерованный заголовок;
//   vector — один фрагмент тела с наибольшим числом лексем запроса, затем первый по порядку;
//   порядок в ветке — по рангу чанка, внутри чанка — по весу фрагмента, затем по порядку в чанке;
//   фрагмент, уже занявший ранг в ветке, пропускается;
// итог — RRF с k = 60 по зафиксированному набору веток.
export const RANKING_VERSION = 'r1';
export const FRAGMENTS_PER_CHUNK = 2;

// Расширение обзорного вопроса по договору — перенос правила донора (Locus,
// apps/rag-api/src/chat-intent.js, expandedChatRetrievalQuery): «основные условия договора»
// лексически слабы, поэтому к ним добавляются договорные термины. Применяется только
// к полнотекстовой ветке; точная ветка и вектор запроса берут исходный вопрос.
const intentText = (value: string): string =>
  value.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/gu, ' ').trim();

const BROAD_INTENT = [
  /\b(?:summary|overview|summarize|summarise)\b/iu,
  /\b(?:main|key|essential)\s+(?:terms|conditions|points|facts|risks)\b/iu,
  /(?:^|\s)(?:основн|ключев|существенн)\p{L}*\s+(?:услов|положен|пункт|факт|риск|требован)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:сводк|обзор|резюме)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:проанализируй|разбери|проверь)\s+(?:договор|контракт|проект)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:что|чего)\s+(?:в|по)\s+(?:договор|контракт)\p{L}*(?:\s|$)/u,
];
const CONTRACT_INTENT = [/(?:^|\s)(?:договор|контракт|соглашени|дс|допсоглашени|услов)\p{L}*(?:\s|$)/u, /\b(?:contract|agreement|terms|conditions)\b/iu];
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

export const expandRetrievalQuery = (query: string): { text: string; expanded: boolean } => {
  const t = intentText(query);
  if (!BROAD_INTENT.some((p) => p.test(t)) || !CONTRACT_INTENT.some((p) => p.test(t))) return { text: query, expanded: false };
  return { text: `${query}\n${CONTRACT_OVERVIEW_TERMS}`, expanded: true };
};
export const RRF_K = 60;
export const BRANCH_LIMIT = 50;

export interface IBranchHit {
  fragmentId: string;
  origin: string;
  chunkKey: string | null;
  score: number;
}

export interface IFusedHit {
  fragmentId: string;
  origin: string;
  chunkKey: string | null;
  score: number;
  matchedVia: SearchBranch[];
  bestRank: number;
}

// Ранговое слияние (RRF): сумма 1 / (k + ранг) по веткам, где фрагмент найден. Взвешенное
// слияние счётчиков не применяется — двойное ранжирование не воспроизводимо (ADR-012 §11).
// Ничьи решаются детерминированно: лучший ранг, число веток, затем идентификатор фрагмента.
export const fuseRrf = (branches: Partial<Record<SearchBranch, readonly IBranchHit[]>>, limit: number, k = RRF_K): IFusedHit[] => {
  const acc = new Map<string, IFusedHit>();
  for (const branch of BRANCH_ORDER) {
    const hits = branches[branch];
    if (!hits) continue;
    hits.forEach((hit, i) => {
      const rank = i + 1;
      const prev = acc.get(hit.fragmentId);
      if (prev) {
        if (prev.matchedVia.includes(branch)) return;
        prev.score += 1 / (k + rank);
        prev.matchedVia.push(branch);
        prev.bestRank = Math.min(prev.bestRank, rank);
        prev.chunkKey = prev.chunkKey ?? hit.chunkKey;
      } else {
        acc.set(hit.fragmentId, { fragmentId: hit.fragmentId, origin: hit.origin, chunkKey: hit.chunkKey, score: 1 / (k + rank), matchedVia: [branch], bestRank: rank });
      }
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || b.matchedVia.length - a.matchedVia.length || (a.fragmentId < b.fragmentId ? -1 : a.fragmentId > b.fragmentId ? 1 : 0))
    .slice(0, limit);
};

// ---------------------------------------------------------------- Хэши области

export interface IScopeUnit {
  unitType: 'document_recognition';
  documentRevisionId: string;
  recognitionRunId: string | null;
}

const byKey = (a: string[], b: string[]): number => {
  const x = a.join('|');
  const y = b.join('|');
  return x < y ? -1 : x > y ? 1 : 0;
};

// Хэш снимка области (data-model §5): хэш состава ревизии набора + отсортированные типизированные
// единицы. Одинаковый состав этапа даёт тот же хэш и ту же строку снимка.
export const evidenceScopeContentHash = (sourceSetHash: string, units: readonly IScopeUnit[]): string => {
  const rows = units.map((u) => [u.unitType, u.documentRevisionId, u.recognitionRunId ?? '', '', '']).sort(byKey);
  return sha256Hex(`kontur.evidence_scope.v1\n${sourceSetHash}\n${JSON.stringify(rows)}`);
};

// Хэш области прогона поиска (ADR-008 §3): хэш снимка (сохранённого или временного) плюс
// отсортированные единицы после фильтра прав. Пишется в прогон и в аудит.
export const searchScopeHash = (snapshotHash: string, allowedUnitIds: readonly string[]): string =>
  sha256Hex(`kontur.search_scope.v1\n${snapshotHash}\n${[...allowedUnitIds].sort().join(',')}`);

// ---------------------------------------------------------------- Эмбеддинги

// Шаблон входа модели (ADR-012 §9): plain — текст как есть; e5 — префиксы query:/passage:, как
// требуют модели семейства E5. Версия шаблона входит в ключ кеша и в параметры версии индекса.
export type EmbeddingTemplate = 'plain' | 'e5';
export const EMBEDDING_MAX_INPUT_CHARS = 2000;

export const embeddingInputVersion = (template: EmbeddingTemplate): string => `${template}:${EMBEDDING_MAX_INPUT_CHARS}:1`;

export const templateOfInputVersion = (inputVersion: string): EmbeddingTemplate => (inputVersion.startsWith('e5:') ? 'e5' : 'plain');

export const embeddingInput = (template: EmbeddingTemplate, purpose: 'index' | 'query', text: string): string => {
  const body = text.slice(0, EMBEDDING_MAX_INPUT_CHARS);
  if (template === 'e5') return `${purpose === 'query' ? 'query' : 'passage'}: ${body}`;
  return body;
};

// Отпечаток модели: имя, размерность и ревизия из настройки. Подмену весов под тем же именем
// ловит пробный вектор (probeMatches), а не этот хэш.
export const modelFingerprint = (model: string, dim: number, revision: string): string => sha256Hex(`${model}\n${dim}\n${revision}`);

export const PROBE_TEXT = 'Контур КП: пробная строка отпечатка модели эмбеддингов, v1';
export const PROBE_MIN_COSINE = 0.999;

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

export const probeMatches = (stored: readonly number[], fresh: readonly number[]): boolean => cosine(stored, fresh) >= PROBE_MIN_COSINE;

// Предел размерности проекта (ADR-012 §6): вектор halfvec при STORAGE PLAIN обязан помещаться
// в страницу вместе со служебными колонками. Подтверждается интеграционным тестом (G05-05).
export const MAX_EMBEDDING_DIM = 4000;

// Формат вектора для halfvec/vector в тексте запроса: [x,y,…].
export const vectorLiteral = (v: readonly number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

// ---------------------------------------------------------------- Формулировки

// Пустой результат — не «требования нет», а число единиц и распознанных страниц области (I07).
export const emptyScopeMessage = (units: number, pagesRecognized: number, pagesTotal: number): string =>
  `не найдено в области: ${units} ${plural(units, 'единица', 'единицы', 'единиц')}, ${pagesRecognized} ${plural(pagesRecognized, 'страница', 'страницы', 'страниц')} распознано из ${pagesTotal}`;

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
