import type { IMailBodyBlock } from '../api/mailTypes.ts';

export interface IMailReadingSection {
  kind: 'message' | 'signature' | 'quote';
  text: string;
}

const signatureStart = /^(?:--\s*$|(?:с уважением|с наилучшими пожеланиями|best regards|kind regards|regards|sincerely)(?:[,!]|$)|sent from my\b|(?:отправлено с|сообщение о конфиденциальности|вы получили (?:это|данное) (?:электронное )?письмо|если вы (?:больше )?не хотите получать|отписаться от рассылки)(?=\s|[.:!?]|$)|confidentiality notice\b)/iu;
const replySeparator = /^(?:[-_]{2,}\s*(?:original message|исходное сообщение|пересылаемое сообщение|forwarded message)|on\s.+\swrote:|.+\s(?:написал|написала|пишет):)/iu;

// URL, адреса, версии и инициалы не участвуют в восстановлении границ предложений.
const protectedPatterns = [
  /(?:https?|ftp):\/\/[^\s<>]+|www\.[^\s<>]+|[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}.-]{1,253}\.[\p{L}]{2,63}|(?<!\S)[^\s<>]{1,255}\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|txt|png|jpe?g|html?|xml|json|eml)\b/giu,
  /(?<![\p{L}\p{N}])(?:\p{Lu}\.){1,3}(?:\p{Lu}\p{Ll}+)?|\b[vV]?\d+(?:\.\d+)+(?:[._+-][A-Za-z0-9-]+)*/gu,
];
const abbreviation = /(?:^|[\s(])(?:г|ул|д|корп|стр|п|пп|им|рис|табл|руб|коп|тыс|млн|млрд|кв|см|т\.\s?е|т\.\s?д|т\.\s?п|Mr|Mrs|Ms|Dr|Prof|St|No)\.$/iu;

const readableSentences = (text: string): string => text
  .replace(/([.!?]+[»”"')]*)(?=\p{Lu}(?:\p{Ll}|[ \t]+\p{Ll}))/gu, (_match: string, punctuation: string, offset: number) =>
    punctuation === '.' && abbreviation.test(text.slice(Math.max(0, offset - 16), offset + 1))
      ? '. ' : `${punctuation}\n\n`)
  .replace(/([,;:])(?=\p{Lu}(?:\p{Ll}|[ \t]+\p{Ll}))/gu, '$1 ');

/** Восстанавливает только пропущенные пробелы и абзацы; существующее форматирование сохраняется. */
export const formatMailText = (text: string): string => {
  let result = '';
  let cursor = 0;
  const protectedRanges = protectedPatterns.flatMap((pattern) => [...text.matchAll(pattern)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length })))
    .sort((left, right) => left.start - right.start);
  for (const range of protectedRanges) {
    if (range.end <= cursor) continue;
    if (range.start > cursor) result += readableSentences(text.slice(cursor, range.start));
    result += text.slice(Math.max(cursor, range.start), range.end);
    cursor = range.end;
  }
  return result + readableSentences(text.slice(cursor));
};

/** Только представление: исходные фрагменты, их якоря и текст в хранилище остаются прежними. */
export const mailReadingSections = (blocks: IMailBodyBlock[]): IMailReadingSection[] => {
  blocks = blocks.map((block) => ({ ...block, text: formatMailText(block.text) }));
  const sections: IMailReadingSection[] = [];
  let mode: IMailReadingSection['kind'] = 'message';
  const allLines = blocks.flatMap((block) => [...block.text.replace(/\r\n?/gu, '\n').split('\n'), '']);
  let offset = 0;
  let previousQuoted = false;
  for (const block of blocks) {
    // После явно цитируемых фрагментов новый нецитируемый текст снова относится к автору письма.
    if (previousQuoted && !block.quoted) mode = 'message';
    const lines = block.text.replace(/\r\n?/gu, '\n').split('\n');
    let buffer: string[] = [];
    let kind: IMailReadingSection['kind'] = block.quoted ? 'quote' : mode;
    const flush = (): void => {
      const text = buffer.join('\n');
      buffer = [];
      if (!text.trim()) return;
      const previous = sections.at(-1);
      if (previous?.kind === kind) previous.text += `\n\n${text}`;
      else sections.push({ kind, text });
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!.trim();
      const following = allLines.slice(offset + i, offset + i + 14).join('\n');
      const mailHeader = (/^(?:from|от|кому|to):\s*\S/iu.test(line) || /^[-_]{4,}$/u.test(line))
        && /^(?:from|от|кому|to):\s*\S/imu.test(following)
        && /^(?:sent|отправлено|дата|subject|тема):\s*\S/imu.test(following);
      if (kind !== 'quote' && (replySeparator.test(line) || mailHeader)) {
        flush();
        kind = mode = 'quote';
      } else if (kind === 'message' && signatureStart.test(line)) {
        flush();
        kind = mode = 'signature';
      }
      buffer.push(lines[i]!);
    }
    flush();
    offset += lines.length + 1;
    previousQuoted = block.quoted;
  }
  return sections;
};
