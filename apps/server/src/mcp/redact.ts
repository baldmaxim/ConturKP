// Вырезание секретов и внутренних адресов из результата инструмента (I17, ADR-010). Текст источников — данные: если в
// документе или письме оказался токен, строка подключения или закрытый ключ, чат-клиент получает отметку вместо значения.
import type { IAppConfig } from '@kontur/config';

export const REDACTED = '[скрыто]';

const PATTERNS: RegExp[] = [
  // Токены портала и заголовки авторизации.
  /kkp_[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // Строка подключения с паролем: скрывается вся строка.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s@"']+@[^\s"']+/gi,
  // Закрытые ключи PEM.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // Распространённые виды ключей доступа.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Пары «имя секрета = значение».
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|пароль)\s*[:=]\s*[^\s,;"']{4,}/gi,
];

// Внутренние адреса и пути из настроек установки: в ответах чат-клиенту им не место.
const internalValues = (config: IAppConfig): string[] => {
  const found = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v) && !v.startsWith('http://localhost') && v.length >= 12) found.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(config, 0);
  if (config.storageRoot) found.add(config.storageRoot);
  if (config.databaseUrl) found.add(config.databaseUrl);
  return [...found].sort((a, b) => b.length - a.length);
};

export interface IRedactor {
  (value: unknown): { value: unknown; redactions: number };
}

export const createRedactor = (config: IAppConfig): IRedactor => {
  const internal = internalValues(config);
  const text = (s: string, count: { n: number }): string => {
    let out = s;
    for (const v of internal) {
      if (out.includes(v)) {
        count.n += out.split(v).length - 1;
        out = out.split(v).join(REDACTED);
      }
    }
    for (const p of PATTERNS) {
      out = out.replace(p, () => {
        count.n += 1;
        return REDACTED;
      });
    }
    return out;
  };
  const walk = (v: unknown, count: { n: number }): unknown => {
    if (typeof v === 'string') return text(v, count);
    if (Array.isArray(v)) return v.map((x) => walk(x, count));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, count)]));
    return v;
  };
  return (value) => {
    const count = { n: 0 };
    return { value: walk(value, count), redactions: count.n };
  };
};
