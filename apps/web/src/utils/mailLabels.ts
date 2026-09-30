// Подписи почтового контура, вопросов–ответов и переговоров (этап 07).
import type { ICommunicationIntegration, TLinkReason, TMailCapability, TMailDirection } from '../api/mailTypes';

export const MAIL_CAPABILITY_LABELS: Record<TMailCapability, string> = {
  'mail.read': 'Чтение писем',
  'mail.import': 'Импорт EML',
  'mail.link': 'Связь с тендерами',
  'mail.manage': 'Ведение ящика',
};

export const MAIL_CAPABILITY_HINTS: Record<TMailCapability, string> = {
  'mail.read': 'Тема, тело, адреса, вложения, поиск и цитаты писем ящика.',
  'mail.import': 'Загрузка файлов EML в ящик.',
  'mail.link': 'Подтверждение и снятие связи письма с тендером, где пользователь ведёт источники.',
  'mail.manage': 'Название и архив ящика.',
};

export const ALL_MAIL_CAPABILITIES: TMailCapability[] = ['mail.read', 'mail.import', 'mail.link', 'mail.manage'];

export const DIRECTION_LABELS: Record<TMailDirection, string> = {
  inbound: 'Входящее',
  outbound: 'Отправленное',
  unknown: 'Направление не указано',
};

export const LINK_REASON_LABELS: Record<TLinkReason, string> = {
  tender_code_in_subject: 'код тендера в теме',
  tender_code_in_body: 'код тендера в тексте',
  tenderhub_number_in_subject: 'номер TenderHub в теме',
  tenderhub_number_in_body: 'номер TenderHub в тексте',
};

export const REJECT_REASON_LABELS: Record<string, string> = {
  type_not_allowed: 'тип файла не принимается',
  size_limit: 'больше предела вложения',
  corrupt: 'файл повреждён',
};

export const IMPORT_FAILURE_LABELS: Record<string, string> = {
  mail_empty: 'файл пуст',
  mail_malformed: 'это не письмо RFC 5322 или оно повреждено',
  mail_too_large: 'письмо больше предела разбора',
};

export const INTEGRATION_LABELS: Record<string, string> = {
  mailhub: 'Автоматическое чтение MailHub',
  negotiations: 'Сервис переговоров',
};

export const integrationText = (i: ICommunicationIntegration): string => {
  const what = INTEGRATION_LABELS[i.system] ?? i.system;
  if (i.status === 'BLOCKED_EXTERNAL') return `${what}: заблокировано внешней зависимостью${i.blockedBy ? ` ${i.blockedBy}` : ''}. Штатный путь — ручной импорт файлов.`;
  if (i.status === 'NOT_IMPLEMENTED') return `${what}: не реализовано.`;
  return `${what}: ${i.status}.`;
};

export const QA_STATUS_LABELS: Record<'open' | 'answered' | 'withdrawn', string> = {
  open: 'Без ответа',
  answered: 'Ответ получен',
  withdrawn: 'Снят',
};

export const SIDE_LABELS: Record<'customer' | 'contractor' | 'unknown', string> = {
  customer: 'Заказчик',
  contractor: 'Подрядчик',
  unknown: 'Сторона не указана',
};

// Таймкод сегмента: мм:сс или чч:мм:сс.
export const formatTimecode = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};
