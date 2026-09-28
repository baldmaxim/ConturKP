// Источник данных расчёта TenderHub. Один доменный адаптер, транспорт подменяемый (D-016):
// ITenderHubSource реализует официальный API; прямое чтение БД TenderHub (read-only роль или реплика,
// одна транзакция REPEATABLE READ) встало бы рядом той же формой, но на этапе 06 не реализуется —
// доступ владельцем не подтверждён.
import type { TenderHubHttpClient } from './http.ts';
import { parseJsonWithLexemes } from './lexeme.ts';
import {
  envelopeData,
  parseBoqItems,
  parseBrief,
  parseOverview,
  parsePositionsPage,
  parsePositionsWithCosts,
  RowIssues,
  type ISourceBoqItem,
  type ISourceBrief,
  type ISourceOverview,
  type ISourcePositionCosts,
  type ISourcePositionPaged,
} from './schema.ts';
import { thError, type IRawResponse } from './types.ts';

export type TenderHubTransport = 'api';

export interface IRead<T> {
  value: T;
  raws: IRawResponse[];
}

export interface ITenderHubSource {
  readonly transport: TenderHubTransport;
  brief(search: string, signal?: AbortSignal): Promise<IRead<ISourceBrief[]>>;
  overview(tenderId: string, signal?: AbortSignal): Promise<IRead<ISourceOverview>>;
  // Все страницы курсора: одна страница — не полный расчёт.
  positions(tenderId: string, signal?: AbortSignal): Promise<IRead<ISourcePositionPaged[]>>;
  positionsWithCosts(tenderId: string, signal?: AbortSignal): Promise<IRead<ISourcePositionCosts[]>>;
  boqItems(tenderId: string, signal?: AbortSignal): Promise<IRead<ISourceBoqItem[]>>;
  // Документированные поля, которых не было в ответах: сверка с развёрнутой сборкой (R-06).
  missingFields(): Record<string, number>;
}

// Размер страницы — максимум контракта (1–200).
export const POSITIONS_PAGE_LIMIT = 200;
// Предел числа страниц: 200 × 1000 = 200 тыс. позиций; дальше — не контракт, а зацикленный курсор.
const MAX_PAGES = 1000;

const enc = encodeURIComponent;

export class TenderHubApiSource implements ITenderHubSource {
  readonly transport = 'api' as const;
  private readonly http: TenderHubHttpClient;
  private readonly issues = new RowIssues();

  constructor(http: TenderHubHttpClient) {
    this.http = http;
  }

  missingFields(): Record<string, number> {
    return this.issues.missingReport();
  }

  private parse(raw: IRawResponse): unknown {
    return parseJsonWithLexemes(raw.body.toString('utf8'));
  }

  async brief(search: string, signal?: AbortSignal): Promise<IRead<ISourceBrief[]>> {
    const raw = await this.http.get('brief', `/api/v1/tenders/brief?search=${enc(search)}`, signal ? { signal } : {});
    const { data } = envelopeData(this.parse(raw), 'brief');
    const value = parseBrief(data, this.issues);
    this.issues.fail('brief');
    return { value, raws: [raw] };
  }

  async overview(tenderId: string, signal?: AbortSignal): Promise<IRead<ISourceOverview>> {
    const raw = await this.http.get('overview', `/api/v1/tenders/${enc(tenderId)}/overview`, signal ? { signal } : {});
    const { data } = envelopeData(this.parse(raw), 'overview');
    const value = parseOverview(data, this.issues);
    this.issues.fail('overview');
    return { value, raws: [raw] };
  }

  async positions(tenderId: string, signal?: AbortSignal): Promise<IRead<ISourcePositionPaged[]>> {
    const raws: IRawResponse[] = [];
    const value: ISourcePositionPaged[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES) throw thError('CONTRACT_MISMATCH', 'contract_mismatch', `positions: больше ${MAX_PAGES} страниц`, false, { route: 'positions' });
      const path = `/api/v1/tenders/${enc(tenderId)}/positions?limit=${POSITIONS_PAGE_LIMIT}${cursor ? `&cursor=${enc(cursor)}` : ''}`;
      const raw = await this.http.get('positions', path, signal ? { signal } : {});
      raws.push(raw);
      const env = envelopeData(this.parse(raw), 'positions');
      value.push(...parsePositionsPage(env.data, this.issues, page));
      this.issues.fail('positions');
      if (!env.nextCursor) break;
      if (seenCursors.has(env.nextCursor)) {
        throw thError('CONTRACT_MISMATCH', 'contract_mismatch', 'positions: курсор повторился — страницы зациклены', false, { route: 'positions' });
      }
      seenCursors.add(env.nextCursor);
      cursor = env.nextCursor;
    }
    return { value, raws };
  }

  async positionsWithCosts(tenderId: string, signal?: AbortSignal): Promise<IRead<ISourcePositionCosts[]>> {
    // Кэш маршрута — 30 с; Cache-Control: no-cache сбрасывает его, иначе снимок мог бы смешать времена.
    const raw = await this.http.get('positions_with_costs', `/api/v1/tenders/${enc(tenderId)}/positions/with-costs`, {
      noCache: true,
      ...(signal ? { signal } : {}),
    });
    const { data } = envelopeData(this.parse(raw), 'positions/with-costs');
    const value = parsePositionsWithCosts(data, this.issues);
    this.issues.fail('positions/with-costs');
    return { value, raws: [raw] };
  }

  async boqItems(tenderId: string, signal?: AbortSignal): Promise<IRead<ISourceBoqItem[]>> {
    const raw = await this.http.get('boq_items_full', `/api/v1/tenders/${enc(tenderId)}/boq-items-full`, signal ? { signal } : {});
    const { data } = envelopeData(this.parse(raw), 'boq-items-full');
    const value = parseBoqItems(data, this.issues);
    this.issues.fail('boq-items-full');
    return { value, raws: [raw] };
  }
}
