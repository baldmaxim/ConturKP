// Блоки тела письма — единицы доказательства с якорем { block, quoted } (этап 07, по образцу
// AD-05a-1). Блок — абзац между пустыми строками. Цитата прежней переписки помечается quoted:
// строки с префиксом «>» или всё, что идёт после разделителя пересылки или ответа («-----Original
// Message-----», «… написал:», шапка «От: … Отправлено: …»). Так старый ответ из цитаты не выдаётся
// за новый (проверка этапа «цитируемый старый ответ»). Текст блока не меняется.

export interface IMailBlock {
  block: number;
  quoted: boolean;
  text: string;
}

const SEPARATORS: RegExp[] = [
  /^-{2,}\s*(original message|исходное сообщение|пересылаемое сообщение|forwarded message|переадресованное сообщение)\s*-{2,}$/iu,
  /^(on\s.+\swrote|.+\s(написал|написала|пишет)):?$/iu,
  /^_{5,}$/u,
];

const OUTLOOK_FROM = /^(from|от|отправитель):\s+\S/iu;
const OUTLOOK_SENT = /^(sent|date|отправлено|дата):\s+\S/iu;

const isSeparator = (lines: string[], i: number): boolean => {
  const line = lines[i]!.trim();
  if (SEPARATORS.some((re) => re.test(line))) return true;
  // Шапка пересылки Outlook: «От:» и следом «Отправлено:» в пределах двух строк.
  if (OUTLOOK_FROM.test(line)) {
    for (let j = i + 1; j <= i + 2 && j < lines.length; j += 1) if (OUTLOOK_SENT.test(lines[j]!.trim())) return true;
  }
  return false;
};

export const splitMailBody = (text: string): IMailBlock[] => {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: IMailBlock[] = [];
  let current: string[] = [];
  let quotedTail = false;
  const flush = (): void => {
    const body = current.join('\n').trim();
    current = [];
    if (body.length === 0) return;
    const nonEmpty = body.split('\n').filter((l) => l.trim().length > 0);
    const quoted = quotedTail || nonEmpty.every((l) => /^\s*>/u.test(l));
    blocks.push({ block: blocks.length + 1, quoted, text: body });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!quotedTail && isSeparator(lines, i)) {
      flush();
      quotedTail = true;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line.replace(/\s+$/u, ''));
  }
  flush();
  return blocks;
};
