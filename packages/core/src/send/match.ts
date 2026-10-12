// Сверка вложений письма об отправке с комплектом выпуска для заказчика (этап 15; D-035; проект §4). Класс каждого
// вложения по SHA-256 определяет БД (`send_file_class`, миграция 0039) — одна реализация для команды и второй линии;
// здесь — хэш комплекта и итог сверки. Имена файлов не сравниваются: те же байты под другим именем — тот же файл.
import { createHash } from 'node:crypto';

export type SendFileClass = 'kit' | 'internal' | 'other_release' | 'unknown';
export type AttachmentCheck = 'matched' | 'mismatched' | 'not_checked';
export type SendStatus = 'registered' | 'verified' | 'disputed';
export type SendChannel = 'email' | 'customer_portal' | 'paper' | 'other';
export type SendEvidenceKind = 'mail_message' | 'uploaded_file' | 'manual_note';

export interface IKitFile {
  path: string;
  sha256: string;
  size: number;
}

export interface IClassifiedAttachment {
  ordinal: number;
  sha256: string;
  size: number;
  inline: boolean;
  class: SendFileClass;
  kitPath: string | null;
  otherReleaseId: string | null;
}

export interface ISendMatch {
  check: 'matched' | 'mismatched';
  // Файлы комплекта, которых нет среди вложений.
  missing: IKitFile[];
  extras: { unknown: number; inline: number; internal: number; otherRelease: number };
  // Все файлы комплекта на месте, а расхождение — одни лишние вложения неизвестного происхождения (D-035 В-15-1).
  extrasOnly: boolean;
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// Хэш комплекта: упорядоченный по пути (побайтно) список «путь|SHA-256|размер». То же считает БД (send_event_check).
export const sendKitSha256 = (kit: readonly IKitFile[]): string =>
  createHash('sha256')
    .update(`kontur.send_kit.v1\n${[...kit].sort((a, b) => byBytes(a.path, b.path)).map((f) => `${f.path}|${f.sha256}|${f.size}`).join('\n')}`, 'utf8')
    .digest('hex');

// «Совпало» — каждый файл комплекта присутствует и других вложений нет. Пустой комплект не совпадает ни с чем.
export const summarizeSendMatch = (kit: readonly IKitFile[], files: readonly IClassifiedAttachment[]): ISendMatch => {
  const present = new Set(files.map((f) => f.sha256));
  const missing = kit.filter((k) => !present.has(k.sha256));
  const count = (c: SendFileClass) => files.filter((f) => f.class === c).length;
  const extras = { unknown: count('unknown'), inline: files.filter((f) => f.class === 'unknown' && f.inline).length, internal: count('internal'), otherRelease: count('other_release') };
  const clean = extras.unknown === 0 && extras.internal === 0 && extras.otherRelease === 0;
  return {
    check: kit.length > 0 && missing.length === 0 && clean ? 'matched' : 'mismatched',
    missing,
    extras,
    extrasOnly: kit.length > 0 && missing.length === 0 && extras.unknown > 0 && extras.internal === 0 && extras.otherRelease === 0,
  };
};

export const sendStatusOf = (check: AttachmentCheck): SendStatus => (check === 'matched' ? 'verified' : check === 'mismatched' ? 'disputed' : 'registered');

// Отправка засчитана (комплект отправлен): подтверждена или зарегистрирована без сверки. «Состав не совпал» — нет (A32).
export const sendCounted = (status: SendStatus): boolean => status === 'verified' || status === 'registered';
