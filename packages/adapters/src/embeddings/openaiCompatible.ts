// Конкретный локальный провайдер (ADR-012 §25): OpenAI-совместимый POST {baseUrl}/embeddings
// локального сервера модели — LM Studio, llama.cpp server, Infinity, TEI; так же подключался
// Locus (RAG_EMBEDDINGS_BASE_URL / RAG_EMBEDDINGS_MODEL). Адрес — только loopback или LAN:
// облачного запасного пути нет (D-013). Ключ, если задан, уходит только в заголовок запроса.
import { MAX_EMBEDDING_DIM, PROBE_TEXT } from '@kontur/core';
import { describeNetworkError, operationGuard, readTextLimited, type IOperationGuard } from '../netCause.ts';
import { embeddingError, validateVectors, type EmbeddingResult, type IEmbedOutput, type IModelGatewayEmbeddings, type IModelProbe } from './types.ts';

// Предел тела ответа эмбеддингов (этап 17): пачка из 32 векторов по 4000 чисел — около 2 МиБ JSON.
export const EMBEDDINGS_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface IOpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  revision: string;
  apiKey: string | null;
  timeoutMs: number;
  batchSize: number;
  // Размерность из настройки, если известна заранее: иначе принимается первая полученная,
  // а дальше сверяется с версией индекса.
  expectedDim: number | null;
  fetchImpl?: typeof fetch;
}

const PRIVATE_V4 = [/^10\./u, /^127\./u, /^192\.168\./u, /^172\.(1[6-9]|2\d|3[01])\./u, /^169\.254\./u];

// Адрес модели — loopback или частная сеть. Имя без точки или в зонах .lan/.local/.internal
// считается локальным: проверить разрешение DNS здесь нечем, а публичные домены отсекаются.
export const isLocalModelUrl = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (PRIVATE_V4.some((re) => re.test(host))) return true;
  if (/^f[cd][0-9a-f]{2}:/u.test(host) || host.startsWith('fe80:')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host) || host.includes(':')) return false;
  return !host.includes('.') || /\.(lan|local|internal|home\.arpa)$/u.test(host);
};

export class OpenAiCompatibleEmbeddings implements IModelGatewayEmbeddings {
  readonly kind = 'openai_compatible' as const;
  readonly model: string;
  readonly revision: string;
  readonly batchSize: number;
  private readonly o: IOpenAiCompatibleOptions;

  constructor(o: IOpenAiCompatibleOptions) {
    if (!isLocalModelUrl(o.baseUrl)) throw new Error('адрес модели эмбеддингов должен быть loopback или LAN (D-013)');
    this.o = o;
    this.model = o.model;
    this.revision = o.revision;
    this.batchSize = o.batchSize;
  }

  // Тайм-аут и отмена действуют до конца чтения и разбора тела (R17-01): сервер, отдавший заголовки и не
  // дописавший JSON, иначе держал бы вызов, а с ним GPU-задание и остановку worker.
  async embed(input: { texts: string[]; purpose: 'index' | 'query'; signal?: AbortSignal }): Promise<EmbeddingResult<IEmbedOutput>> {
    if (input.texts.length === 0) return { ok: true, value: { vectors: [], dim: this.o.expectedDim ?? 0 } };
    const guard = operationGuard(this.o.timeoutMs, input.signal);
    try {
      return await this.request(input, guard);
    } finally {
      guard.dispose();
    }
  }

  private interrupted(guard: IOperationGuard, err: unknown, phase: 'request' | 'body'): EmbeddingResult<IEmbedOutput> {
    if (guard.timedOut()) return embeddingError('TIMEOUT_UNKNOWN_OUTCOME', 'model_unavailable', `модель не ответила за ${this.o.timeoutMs} мс`, true);
    if (guard.cancelled()) return embeddingError('UNAVAILABLE', 'model_unavailable', 'запрос к модели эмбеддингов отменён', true);
    return phase === 'request'
      ? embeddingError('UNAVAILABLE', 'model_unavailable', `модель недоступна: ${describeNetworkError(err)}`, true)
      : embeddingError('UNAVAILABLE', 'model_unavailable', `модель оборвала ответ: ${describeNetworkError(err)}`, true);
  }

  private async request(input: { texts: string[] }, guard: IOperationGuard): Promise<EmbeddingResult<IEmbedOutput>> {
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl.replace(/\/+$/u, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.o.model, input: input.texts, encoding_format: 'float' }),
        signal: guard.signal,
      });
    } catch (err) {
      return this.interrupted(guard, err, 'request');
    }
    if (res.status === 401 || res.status === 403) return embeddingError('AUTH_FAILED', 'model_unavailable', `модель отказала в доступе: HTTP ${res.status}`, false);
    if (res.status === 429) return embeddingError('RATE_LIMITED', 'model_unavailable', 'модель перегружена: HTTP 429', true);
    if (res.status >= 500) return embeddingError('UNAVAILABLE', 'model_unavailable', `модель недоступна: HTTP ${res.status}`, true);
    if (!res.ok) return embeddingError('CONTRACT_MISMATCH', 'semantic_failed', `неожиданный ответ модели: HTTP ${res.status}`, false);
    let body: unknown;
    try {
      const text = await readTextLimited(res, EMBEDDINGS_MAX_RESPONSE_BYTES);
      if (text === null) return embeddingError('CONTRACT_MISMATCH', 'semantic_failed', `ответ модели эмбеддингов больше ${EMBEDDINGS_MAX_RESPONSE_BYTES / 1024 / 1024} МиБ — не принят`, false);
      body = JSON.parse(text) as unknown;
    } catch (err) {
      if (err instanceof SyntaxError) return embeddingError('INVALID_DATA', 'semantic_failed', 'ответ модели — не JSON', false);
      return this.interrupted(guard, err, 'body');
    }
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return embeddingError('CONTRACT_MISMATCH', 'semantic_failed', 'в ответе модели нет data[]', false);
    // Порядок векторов — по полю index, а не по порядку элементов ответа.
    const ordered: unknown[] = new Array(data.length);
    for (const [i, item] of data.entries()) {
      const idx = typeof (item as { index?: unknown }).index === 'number' ? (item as { index: number }).index : i;
      if (idx < 0 || idx >= data.length || ordered[idx] !== undefined) {
        return embeddingError('CONTRACT_MISMATCH', 'semantic_failed', 'некорректные индексы векторов в ответе модели', false);
      }
      ordered[idx] = (item as { embedding?: unknown }).embedding;
    }
    return validateVectors(ordered, input.texts.length, this.o.expectedDim, MAX_EMBEDDING_DIM);
  }

  async probe(signal?: AbortSignal): Promise<EmbeddingResult<IModelProbe>> {
    const r = await this.embed({ texts: [PROBE_TEXT], purpose: 'index', ...(signal ? { signal } : {}) });
    if (!r.ok) return r;
    return { ok: true, value: { model: this.model, dim: r.value.dim, probe: r.value.vectors[0]! } };
  }
}
