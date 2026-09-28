// Подписи расчёта TenderHub (этап 06): статусы выгрузки и ревизии, причины отказа, формат чисел.
// Числа — десятичные строки: форматируются без перевода в number (ADR-005 §3 запрещает number для денег).
import type { ICalculationCapture, IMoney, TCaptureStatus } from '../api/calculationTypes';
import type { IBadgeMeta } from './sourceLabels';

export const CAPTURE_STATUS: Record<TCaptureStatus, IBadgeMeta> = {
  capturing: { label: 'Выгрузка идёт', icon: 'hourglass', tone: 'info', dashed: true },
  complete: { label: 'Выгружено', icon: 'check', tone: 'success' },
  // Коротко: значок не шире строки на 360 px; подробности — текстом под ним.
  inconsistent: { label: 'Данные менялись', icon: 'repeat', tone: 'warning', dashed: true },
  failed: { label: 'Выгрузка не удалась', icon: 'circle-x', tone: 'danger' },
};

export const REVISION_KIND: Record<'provisional' | 'verified', IBadgeMeta> = {
  provisional: { label: 'Предварительная (provisional)', icon: 'clock-alert', tone: 'warning', dashed: true },
  verified: { label: 'Ревизия TenderHub (verified)', icon: 'check', tone: 'success' },
};

// Причины отказа — по разделу «Ошибки и диагностика» документации TenderHub; ключ не показывается никогда.
const FAILURE: Record<string, string> = {
  integration_not_configured: 'Интеграция TenderHub не настроена: нет адреса или ключа (U-04). Ключ вносит администратор в окружение сервера.',
  auth_failed: 'TenderHub отклонил ключ: отозван, просрочен или неверен (401). Нужен новый ключ.',
  auth_header_rejected: 'TenderHub не увидел ключ в заголовке X-API-Key (401). Проверьте прокси между порталом и TenderHub.',
  forbidden_scope: 'У ключа нет права «Чтение тендеров и смет» (403).',
  forbidden_tender: 'Тендер вне списка разрешённых для ключа (403).',
  not_found: 'Тендер не найден или маршрута нет в развёрнутой сборке TenderHub (404). Проверьте id тендера.',
  rate_limited: 'Лимит запросов TenderHub в минуту исчерпан (429). Повторите позже.',
  endpoint_disabled: 'Администратор TenderHub выключил этот эндпоинт (503).',
  unavailable: 'TenderHub недоступен.',
  connection_lost: 'TenderHub оборвал передачу ответа.',
  timeout: 'TenderHub не ответил вовремя.',
  non_json_response: 'Вместо TenderHub ответил другой сервис (не JSON). Проверьте адрес TenderHub.',
  contract_mismatch: 'Ответ TenderHub не соответствует контракту API.',
  response_too_large: 'Ответ TenderHub больше допустимого предела.',
  source_changed: 'Данные TenderHub менялись во время каждой попытки выгрузки: согласованного снимка нет.',
  external_identity_conflict: 'Этот тендер TenderHub уже связан с другим тендером портала.',
  content_rejected_by_db: 'База отклонила содержимое выгрузки при проверке целостности.',
  cancelled: 'Выгрузка отменена.',
};

export const captureFailureText = (c: ICalculationCapture): string | null =>
  c.failure ? (FAILURE[c.failure.code] ?? `Код ошибки: ${c.failure.code}`) : null;

export const failureText = (code: string | null | undefined): string => (code ? (FAILURE[code] ?? code) : '');

// 1234567.5 → «1 234 567,5»: неразрывные узкие пробелы между разрядами, десятичная запятая.
export const formatDecimal = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!m) return value;
  const whole = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
  return `${m[1]}${whole}${m[3] ? `,${m[3]}` : ''}`;
};

const CURRENCY_SIGN: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€', CNY: '¥' };

// Валюта показывается только подтверждённая источником (UNKNOWN — без знака).
export const formatMoney = (m: IMoney | null): string => {
  if (!m) return '—';
  const sign = CURRENCY_SIGN[m.currency];
  return `${formatDecimal(m.amount)}${sign ? ` ${sign}` : ''}${m.unit ? `/${m.unit}` : ''}`;
};

export const ATTEMPT_REASON: Record<string, string> = {
  markers_changed: 'шапка тендера до и после выгрузки различается',
  positions_count_mismatch: 'число позиций по маршрутам не сходится',
  items_count_mismatch: 'число строк не сходится с шапкой',
  position_duplicated: 'позиция встретилась на страницах дважды',
  position_sets_differ: 'наборы позиций маршрутов различаются',
  position_changed_between_routes: 'позиция изменилась между чтениями',
  position_items_count_mismatch: 'число строк позиции не сходится',
  item_without_position: 'строка без позиции',
  row_updated_during_capture: 'строки изменены после начала выгрузки',
};
