// Разбор EML (этап 07, D-025, AD-07-3): postal-mime 4.0.2 (MIT-0) — чистый разбор MIME без сети и
// файловой системы (A38). HTML письма не отображается и не загружает внешние ресурсы: он только
// переводится в текст. Команды внутри письма — данные (I16). Пересказы и вердикты модели MailHub в
// EML не входят; в портал попадает только первичный текст письма и его вложения.
import PostalMime from 'postal-mime';
import type { Address, Email } from 'postal-mime';
import { htmlToText } from './htmlText.ts';
import { splitMailBody } from './mailBody.ts';

export type MailParticipantRole = 'from' | 'sender' | 'to' | 'cc' | 'bcc' | 'reply_to';

export interface IMailParticipant {
  role: MailParticipantRole;
  address: string;
  name: string | null;
}

export interface IMailBodyBlock {
  block: number;
  quoted: boolean;
  text: string;
}

export interface IMailAttachmentPart {
  ordinal: number;
  filename: string;
  mimeType: string;
  disposition: 'attachment' | 'inline';
  contentId: string | null;
  bytes: Buffer;
}

export interface IParsedMail {
  // Нормализованный Message-ID без угловых скобок; null — заголовка нет.
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  // ISO-время отправки (UTC) или null, если заголовка Date нет или он не разобран.
  sentAt: string | null;
  from: { address: string; name: string | null } | null;
  participants: IMailParticipant[];
  bodySource: 'text' | 'html' | 'none';
  blocks: IMailBodyBlock[];
  attachments: IMailAttachmentPart[];
  warnings: string[];
}

export interface IMailLimits {
  maxRawBytes: number;
  maxAttachments: number;
  maxBodyChars: number;
  maxNestingDepth: number;
  maxHeadersBytes: number;
}

export const DEFAULT_MAIL_LIMITS: IMailLimits = {
  maxRawBytes: 50 * 1024 * 1024,
  maxAttachments: 200,
  maxBodyChars: 2_000_000,
  maxNestingDepth: 50,
  maxHeadersBytes: 1024 * 1024,
};

export type MailParseFailure = 'empty' | 'too_large' | 'malformed';

// Отказ разбора детерминирован: повтор того же файла даст тот же результат (без повторов задания).
export class MailParseError extends Error {
  readonly code: MailParseFailure;
  constructor(code: MailParseFailure, message: string) {
    super(message);
    this.name = 'MailParseError';
    this.code = code;
  }
}

const HEADER_LINE = /^[!-9;-~]+:/u;
const KNOWN_HEADERS = /^(from|to|cc|subject|date|message-id|received|mime-version|return-path|delivered-to):/iu;

// Файл должен начинаться с блока заголовков RFC 5322 и содержать хотя бы один заголовок письма:
// иначе это не письмо, и разборщик не угадывает (как unsupported_format в 05a).
const looksLikeMessage = (raw: Buffer): boolean => {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1');
  const lines = head.split(/\r?\n/u);
  let known = false;
  for (const line of lines) {
    if (line === '') break;
    if (/^[ \t]/u.test(line)) continue;
    if (!HEADER_LINE.test(line)) return false;
    if (KNOWN_HEADERS.test(line)) known = true;
  }
  return known;
};

const stripAngles = (value: string): string => value.trim().replace(/^<+/u, '').replace(/>+$/u, '').trim();

export const normalizeMessageId = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const first = value.trim().split(/\s+/u)[0] ?? '';
  const id = stripAngles(first);
  return id.length > 0 && id.length <= 1000 ? id : null;
};

const referenceIds = (value: string | null | undefined): string[] =>
  (value ?? '')
    .split(/\s+/u)
    .map(stripAngles)
    .filter((x) => x.length > 0 && x.length <= 1000)
    .slice(0, 500);

const flatten = (list: Address[] | Address | undefined): { address: string; name: string | null }[] => {
  const out: { address: string; name: string | null }[] = [];
  for (const a of Array.isArray(list) ? list : list ? [list] : []) {
    if (a.group) {
      for (const m of a.group) if (m.address) out.push({ address: m.address.trim().toLowerCase(), name: m.name?.trim() || null });
    } else if (a.address) {
      out.push({ address: a.address.trim().toLowerCase(), name: a.name?.trim() || null });
    }
  }
  return out.filter((x) => x.address.length > 0 && x.address.length <= 320);
};

const participantsOf = (email: Email): IMailParticipant[] => {
  const roles: [MailParticipantRole, Address[] | Address | undefined][] = [
    ['from', email.from],
    ['sender', email.sender],
    ['to', email.to],
    ['cc', email.cc],
    ['bcc', email.bcc],
    ['reply_to', email.replyTo],
  ];
  return roles.flatMap(([role, list]) => flatten(list).map((p) => ({ role, ...p })));
};

const toBuffer = (content: ArrayBuffer | Uint8Array | string): Buffer =>
  typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content));

// Имя вложения без пути и управляющих символов; нет имени — по порядку и типу.
const safeFilename = (name: string | null, ordinal: number, mimeType: string): string => {
  const base = (name ?? '').split(/[\\/]/u).pop()?.replace(/[\u0000-\u001f\u007f]/gu, '').trim() ?? '';
  if (base.length > 0) return base.slice(0, 255);
  const ext = mimeType === 'message/rfc822' ? '.eml' : '';
  return `вложение-${ordinal}${ext}`;
};

export const parseEml = async (raw: Buffer, limits: IMailLimits = DEFAULT_MAIL_LIMITS): Promise<IParsedMail> => {
  if (raw.length === 0) throw new MailParseError('empty', 'файл пуст');
  if (raw.length > limits.maxRawBytes) throw new MailParseError('too_large', `файл ${raw.length} байт больше предела ${limits.maxRawBytes}`);
  if (!looksLikeMessage(raw)) throw new MailParseError('malformed', 'не письмо: в начале файла нет заголовков RFC 5322');
  let email: Email;
  try {
    email = await PostalMime.parse(raw, {
      attachmentEncoding: 'arraybuffer',
      maxNestingDepth: limits.maxNestingDepth,
      maxHeadersSize: limits.maxHeadersBytes,
    });
  } catch (err) {
    throw new MailParseError('malformed', `письмо не разобрано: ${(err as Error).message.slice(0, 300)}`);
  }
  const warnings: string[] = [];
  const messageId = normalizeMessageId(email.messageId);
  if (!messageId) warnings.push('message_id_missing');
  let sentAt: string | null = null;
  if (email.date) {
    const d = new Date(email.date);
    if (Number.isNaN(d.getTime())) warnings.push('date_unparsed');
    else sentAt = d.toISOString();
  } else {
    warnings.push('date_missing');
  }
  let bodySource: IParsedMail['bodySource'] = 'none';
  let text = '';
  if (email.text && email.text.trim().length > 0) {
    bodySource = 'text';
    text = email.text;
  } else if (email.html && email.html.trim().length > 0) {
    bodySource = 'html';
    text = htmlToText(email.html);
    warnings.push('body_from_html');
  }
  if (text.length > limits.maxBodyChars) throw new MailParseError('too_large', `текст письма длиннее предела ${limits.maxBodyChars} символов`);
  if (email.attachments.length > limits.maxAttachments) {
    throw new MailParseError('too_large', `вложений ${email.attachments.length}, предел — ${limits.maxAttachments}`);
  }
  const attachments = email.attachments.map((a, i) => ({
    ordinal: i + 1,
    filename: safeFilename(a.filename, i + 1, a.mimeType),
    mimeType: (a.mimeType || 'application/octet-stream').toLowerCase().slice(0, 200),
    disposition: a.disposition === 'inline' ? ('inline' as const) : ('attachment' as const),
    contentId: a.contentId ? stripAngles(a.contentId).slice(0, 500) || null : null,
    bytes: toBuffer(a.content),
  }));
  const from = flatten(email.from)[0] ?? null;
  return {
    messageId,
    inReplyTo: normalizeMessageId(email.inReplyTo),
    references: referenceIds(email.references),
    subject: email.subject ? email.subject.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').slice(0, 2000) : null,
    sentAt,
    from,
    participants: participantsOf(email),
    bodySource,
    blocks: splitMailBody(text),
    attachments,
    warnings,
  };
};
