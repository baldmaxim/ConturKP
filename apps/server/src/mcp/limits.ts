// Объём ответа, страницы и лимит вызовов инструментов (проект §7). Числа — решение исполнителя этапа 16.
import { McpToolError } from './session.ts';

export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 50;
export const FRAGMENT_TEXT_MAX = 2000;
export const RESPONSE_MAX_BYTES = 64 * 1024;

export const pageSize = (limit: number | undefined): number => Math.min(Math.max(limit ?? PAGE_DEFAULT, 1), PAGE_MAX);

export const cutText = (text: string | null | undefined, max = FRAGMENT_TEXT_MAX): { text: string | null; truncated: boolean } =>
  text === null || text === undefined ? { text: null, truncated: false } : text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };

// Курсор — смещение в упорядоченном списке, привязанное к инструменту и области: чужой или испорченный не принимается.
export const encodeCursor = (tool: string, scopeKey: string, offset: number): string => Buffer.from(JSON.stringify({ t: tool, s: scopeKey, o: offset }), 'utf8').toString('base64url');

export const decodeCursor = (tool: string, scopeKey: string, cursor: string | undefined): number => {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; s?: unknown; o?: unknown };
    if (v.t === tool && v.s === scopeKey && typeof v.o === 'number' && Number.isInteger(v.o) && v.o >= 0 && v.o <= 1_000_000) return v.o;
  } catch {
    // ниже — общий отказ
  }
  throw new McpToolError('invalid_request', 'курсор не относится к этому инструменту и области');
};

export interface IPage<T> {
  items: T[];
  nextCursor: string | null;
}

// Страница из упорядоченного списка; если она не помещается в предел ответа — урезается, курсор указывает на остаток.
export const paginate = <T>(tool: string, scopeKey: string, all: readonly T[], cursor: string | undefined, limit: number | undefined, budgetBytes = RESPONSE_MAX_BYTES - 4096): IPage<T> => {
  const offset = decodeCursor(tool, scopeKey, cursor);
  const size = pageSize(limit);
  const items: T[] = [];
  let bytes = 0;
  for (const item of all.slice(offset, offset + size)) {
    const b = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (items.length > 0 && bytes + b > budgetBytes) break;
    items.push(item);
    bytes += b;
  }
  const next = offset + items.length;
  return { items, nextCursor: next < all.length ? encodeCursor(tool, scopeKey, next) : null };
};

// Лимит вызовов на токен: скользящие окна минуты и часа в памяти процесса server (он один, ADR-001).
export class CallLimiter {
  private readonly calls = new Map<string, number[]>();
  private readonly perMinute: number;
  private readonly perHour: number;
  constructor(perMinute: number, perHour: number) {
    this.perMinute = perMinute;
    this.perHour = perHour;
  }
  take(tokenId: string, now: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const list = (this.calls.get(tokenId) ?? []).filter((t) => now - t < 3_600_000);
    const lastMinute = list.filter((t) => now - t < 60_000);
    if (lastMinute.length >= this.perMinute) {
      this.calls.set(tokenId, list);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - lastMinute[0]!)) / 1000)) };
    }
    if (list.length >= this.perHour) {
      this.calls.set(tokenId, list);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((3_600_000 - (now - list[0]!)) / 1000)) };
    }
    list.push(now);
    this.calls.set(tokenId, list);
    return { ok: true };
  }
}
