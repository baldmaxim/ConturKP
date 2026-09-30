// Текст из HTML письма (этап 07). HTML не отображается и не исполняется: теги удаляются, скрипты,
// стили и заголовок документа выбрасываются целиком, внешние ресурсы не загружаются (A38, I16).
// Цитата <blockquote> превращается в строки с префиксом «> » — её узнаёт splitMailBody.

const NAMED: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  euro: '€',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  bull: '•',
  middot: '·',
  shy: '',
  times: '×',
  deg: '°',
  numero: '№',
};

export const decodeHtmlEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/giu, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });

const BQ_OPEN = '\u0001bq+\u0001';
const BQ_CLOSE = '\u0001bq-\u0001';

export const htmlToText = (html: string): string => {
  let s = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|head|title|noscript|template|svg|object|iframe)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(script|style|head|title|noscript|template|svg|object|iframe)\b[^>]*\/?>/giu, ' ')
    .replace(/<blockquote\b[^>]*>/giu, `\n${BQ_OPEN}\n`)
    .replace(/<\/blockquote\s*>/giu, `\n${BQ_CLOSE}\n`)
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol|section|article|header|footer)\s*>/giu, '\n')
    .replace(/<(p|div|tr|li|h[1-6]|table|hr)\b[^>]*>/giu, '\n')
    .replace(/<\/(td|th)\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, '');
  s = decodeHtmlEntities(s);
  const out: string[] = [];
  let depth = 0;
  for (const raw of s.split(/\r?\n/u)) {
    if (raw.trim() === BQ_OPEN) {
      depth += 1;
      out.push('');
      continue;
    }
    if (raw.trim() === BQ_CLOSE) {
      depth = Math.max(0, depth - 1);
      out.push('');
      continue;
    }
    const line = raw.replace(/[ \t ]+/gu, ' ').trim();
    out.push(depth > 0 && line.length > 0 ? `${'> '.repeat(depth)}${line}` : line);
  }
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
};
