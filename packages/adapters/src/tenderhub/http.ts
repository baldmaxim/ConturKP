// HTTP-транспорт официального API TenderHub (README/ENDPOINTS архива ApiTenderHub):
// заголовок X-API-Key и никогда не Authorization (ключ в Bearer уходит в JWT-ветку и даёт 401);
// Accept-Encoding: gzip; лимит запросов в минуту на ключ (по умолчанию 120 у источника);
// 429 без Retry-After — ждём следующее минутное окно. Только GET: побочных эффектов нет.
import { thError, type IRawResponse, type TenderHubError } from './types.ts';

export interface ITenderHubHttpOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  // Собственный предел ниже лимита источника: ключ может использоваться и другими клиентами.
  rateLimitPerMinute: number;
  maxResponseBytes: number;
  // Сколько раз один запрос ждёт окно после 429, прежде чем отдать RATE_LIMITED наверх.
  rateLimitWaits: number;
  windowMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Базовый адрес: https, либо http только на loopback (локальный Go BFF и тесты). Без учётных данных в URL.
export const tenderHubBaseUrlProblem = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'некорректный адрес';
  }
  if (url.username || url.password) return 'учётные данные в адресе недопустимы';
  if (url.search || url.hash) return 'адрес без параметров запроса и якоря';
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127\./u.test(host);
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && loopback) return null;
  return 'только https (http допустим лишь для loopback)';
};

interface IProblem {
  code?: unknown;
  detail?: unknown;
  title?: unknown;
}

const problemOf = (body: Buffer): IProblem => {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as IProblem) : {};
  } catch {
    return {};
  }
};

const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');

export class TenderHubHttpClient {
  private readonly o: Required<Omit<ITenderHubHttpOptions, 'fetchImpl' | 'sleep' | 'now' | 'windowMs'>> & {
    windowMs: number;
    fetchImpl: typeof fetch;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    now: () => number;
  };
  // Моменты отправленных запросов в текущем окне (скользящее окно).
  private readonly sent: number[] = [];

  constructor(o: ITenderHubHttpOptions) {
    const problem = tenderHubBaseUrlProblem(o.baseUrl);
    if (problem) throw new Error(`TENDERHUB_URL: ${problem}`);
    if (!o.apiKey) throw new Error('TENDERHUB_API_KEY не задан');
    this.o = {
      ...o,
      baseUrl: o.baseUrl.replace(/\/+$/u, ''),
      windowMs: o.windowMs ?? 60_000,
      fetchImpl: o.fetchImpl ?? fetch,
      sleep: o.sleep ?? defaultSleep,
      now: o.now ?? Date.now,
    };
  }

  // Ждёт место в скользящем окне собственного лимита.
  private async throttle(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.o.now();
      while (this.sent.length > 0 && now - this.sent[0]! >= this.o.windowMs) this.sent.shift();
      if (this.sent.length < this.o.rateLimitPerMinute) {
        this.sent.push(now);
        return;
      }
      await this.o.sleep(this.o.windowMs - (now - this.sent[0]!) + 5, signal);
    }
  }

  async get(route: IRawResponse['route'], path: string, o: { noCache?: boolean; signal?: AbortSignal } = {}): Promise<IRawResponse> {
    for (let waited = 0; ; waited += 1) {
      const r = await this.once(route, path, o);
      if (r.status !== 429) return this.accept(r);
      // 429: лимит ключа в минуту. Retry-After источник не отдаёт — ждём полное окно.
      if (waited >= this.o.rateLimitWaits) {
        throw thError('RATE_LIMITED', 'rate_limited', 'TenderHub: превышен лимит запросов для ключа (429)', true, { route });
      }
      await this.o.sleep(this.o.windowMs, o.signal);
    }
  }

  private async once(route: IRawResponse['route'], path: string, o: { noCache?: boolean; signal?: AbortSignal }): Promise<IRawResponse> {
    await this.throttle(o.signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
    const onAbort = (): void => controller.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.o.fetchImpl(`${this.o.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            'X-API-Key': this.o.apiKey,
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            ...(o.noCache ? { 'Cache-Control': 'no-cache' } : {}),
          },
          // Переход на другой адрес унёс бы ключ туда: редирект — ошибка, а не следование.
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (err) {
        if (o.signal?.aborted) throw o.signal.reason;
        if (controller.signal.aborted) {
          throw thError('TIMEOUT_UNKNOWN_OUTCOME', 'timeout', `TenderHub не ответил за ${this.o.timeoutMs} мс`, true, { route });
        }
        throw thError('UNAVAILABLE', 'unavailable', `TenderHub недоступен: ${(err as Error).name}`, true, { route });
      }
      const body = await this.readBody(res, route, controller.signal, o.signal);
      return {
        route,
        path,
        status: res.status,
        contentEncoding: res.headers.get('content-encoding'),
        sourceDate: res.headers.get('date'),
        receivedAt: new Date(this.o.now()).toISOString(),
        body,
      };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
  }

  // Тело читается потоком с пределом: gzip распаковывает fetch, предел считается по распакованным байтам.
  private async readBody(res: Response, route: IRawResponse['route'], timeout: AbortSignal, outer?: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (!res.body) return Buffer.alloc(0);
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > this.o.maxResponseBytes) {
          await res.body.cancel().catch(() => undefined);
          throw thError('CONTRACT_MISMATCH', 'response_too_large', `ответ TenderHub больше ${this.o.maxResponseBytes} байт`, false, { route });
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (err) {
      if ((err as { error?: unknown }).error) throw err;
      if (outer?.aborted) throw outer.reason;
      if (timeout.aborted) {
        throw thError('TIMEOUT_UNKNOWN_OUTCOME', 'timeout', `TenderHub не дослал ответ за ${this.o.timeoutMs} мс`, true, { route });
      }
      throw thError('UNAVAILABLE', 'connection_lost', 'TenderHub оборвал передачу ответа', true, { route });
    }
    return Buffer.concat(chunks);
  }

  // Классы ответов по разделу «Ошибки и диагностика» README: повторяются только 429, сеть и 5xx,
  // кроме 503 ENDPOINT_DISABLED («не обходить»). 401/403/404 — терминальные.
  private accept(r: IRawResponse): IRawResponse {
    if (r.status >= 200 && r.status < 300) return r;
    const p = problemOf(r.body);
    const code = textOf(p.code);
    const detail = textOf(p.detail) || textOf(p.title);
    let err: TenderHubError;
    if (r.status === 401) {
      // Два разных 401: «invalid API key» — ключ отозван или просрочен; «invalid or expired token» —
      // запрос ушёл в JWT-ветку без X-API-Key (адаптер так не делает, это прокси или сборка).
      const expired = /invalid or expired token/iu.test(detail) || /invalid or expired token/iu.test(r.body.toString('utf8'));
      err = expired
        ? thError('AUTH_FAILED', 'auth_header_rejected', 'TenderHub не увидел X-API-Key (401 invalid or expired token)', false, { route: r.route })
        : thError('AUTH_FAILED', 'auth_failed', 'TenderHub отклонил ключ: отозван, просрочен или неверен (401 invalid API key)', false, { route: r.route });
    } else if (r.status === 403) {
      err =
        code === 'API_KEY_TENDER_DENIED'
          ? thError('FORBIDDEN', 'forbidden_tender', 'тендер вне списка разрешённых для ключа (403 API_KEY_TENDER_DENIED)', false, { route: r.route })
          : thError('FORBIDDEN', 'forbidden_scope', 'у ключа нет области «Чтение тендеров и смет» (403 API_KEY_SCOPE_DENIED)', false, { route: r.route });
    } else if (r.status === 404) {
      err = thError('NOT_FOUND', 'not_found', 'тендер не найден или маршрута нет в развёрнутой сборке TenderHub (404)', false, { route: r.route });
    } else if (r.status === 503 && code === 'ENDPOINT_DISABLED') {
      err = thError('UNAVAILABLE', 'endpoint_disabled', 'эндпоинт выключен администратором TenderHub (503 ENDPOINT_DISABLED)', false, { route: r.route });
    } else if (r.status >= 500) {
      err = thError('UNAVAILABLE', 'unavailable', `TenderHub недоступен (HTTP ${r.status})`, true, { route: r.route });
    } else {
      err = thError('CONTRACT_MISMATCH', 'contract_mismatch', `неожиданный ответ TenderHub (HTTP ${r.status})`, false, { route: r.route });
    }
    throw err;
  }
}
