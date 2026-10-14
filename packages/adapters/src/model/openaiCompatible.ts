// Локальный провайдер (ADR-009 §5, OD-08-2): OpenAI-совместимый POST {baseUrl}/chat/completions — LM Studio,
// llama.cpp server. Адрес — только loopback или LAN (D-013); ключ, если задан, — только в заголовке.
// Инструментов у модели нет; температура 0 — ответ как можно более воспроизводим.
import { isLocalModelUrl } from '../embeddings/openaiCompatible.ts';
import { describeNetworkError, operationGuard, readTextLimited, type IOperationGuard } from '../netCause.ts';
import { chatError, type ChatModelResult, type IChatCompleteInput, type IChatCompletion, type IModelGatewayChat } from './types.ts';

export interface IOpenAiCompatibleChatOptions {
  baseUrl: string;
  model: string;
  revision: string;
  apiKey: string | null;
  timeoutMs: number;
  maxInputChars: number;
  maxOutputTokens: number;
  jsonMode: 'none' | 'json_object';
  fetchImpl?: typeof fetch;
  // Предел тела ответа (этап 17): большой ответ не читается в память целиком.
  maxResponseBytes?: number;
}

export const CHAT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class OpenAiCompatibleChat implements IModelGatewayChat {
  readonly providerId = 'openai_compatible' as const;
  readonly model: string;
  readonly version: string;
  readonly maxInputChars: number;
  readonly inferenceConfig: Record<string, unknown>;
  private readonly o: IOpenAiCompatibleChatOptions;

  constructor(o: IOpenAiCompatibleChatOptions) {
    if (!isLocalModelUrl(o.baseUrl)) throw new Error('адрес модели должен быть loopback или LAN (D-013)');
    this.o = o;
    this.model = o.model;
    this.version = o.revision;
    this.maxInputChars = o.maxInputChars;
    this.inferenceConfig = { temperature: 0, maxOutputTokens: o.maxOutputTokens, jsonMode: o.jsonMode, maxInputChars: o.maxInputChars };
  }

  // Тайм-аут и отмена действуют до конца чтения и разбора тела (R17-01): сервер, отдавший заголовки и не
  // дописавший JSON, иначе держал бы вызов, а с ним GPU-задание и остановку worker.
  async complete(input: IChatCompleteInput): Promise<ChatModelResult<IChatCompletion>> {
    const guard = operationGuard(this.o.timeoutMs, input.signal);
    try {
      return await this.request(input, guard);
    } finally {
      guard.dispose();
    }
  }

  private interrupted(guard: IOperationGuard, err: unknown, phase: 'request' | 'body'): ChatModelResult<IChatCompletion> {
    if (guard.timedOut()) return chatError('TIMEOUT_UNKNOWN_OUTCOME', `модель не ответила за ${this.o.timeoutMs} мс`, true);
    if (guard.cancelled()) return chatError('UNAVAILABLE', 'запрос к модели отменён', true);
    return phase === 'request'
      ? chatError('UNAVAILABLE', `модель недоступна: ${describeNetworkError(err)}`, true)
      : chatError('UNAVAILABLE', `модель оборвала ответ: ${describeNetworkError(err)}`, true);
  }

  private async request(input: IChatCompleteInput, guard: IOperationGuard): Promise<ChatModelResult<IChatCompletion>> {
    const startedAt = new Date();
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.o.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          temperature: 0,
          max_tokens: this.o.maxOutputTokens,
          stream: false,
          ...(this.o.jsonMode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: guard.signal,
      });
    } catch (err) {
      return this.interrupted(guard, err, 'request');
    }
    if (res.status === 401 || res.status === 403) return chatError('AUTH_FAILED', `модель отказала в доступе: HTTP ${res.status}`, false);
    if (res.status === 429) return chatError('RATE_LIMITED', 'модель перегружена: HTTP 429', true);
    if (res.status >= 500) return chatError('UNAVAILABLE', `модель недоступна: HTTP ${res.status}`, true);
    if (!res.ok) return chatError('CONTRACT_MISMATCH', `неожиданный ответ модели: HTTP ${res.status}`, false);
    const limit = this.o.maxResponseBytes ?? CHAT_MAX_RESPONSE_BYTES;
    let text: string | null;
    try {
      text = await readTextLimited(res, limit);
    } catch (err) {
      return this.interrupted(guard, err, 'body');
    }
    if (text === null) return chatError('TRUNCATED', `ответ модели больше ${Math.round(limit / 1024 / 1024)} МиБ — не принят`, false);
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return chatError('CONTRACT_MISMATCH', 'ответ сервера модели — не JSON', false);
    }
    const choice = (body as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] }).choices?.[0];
    // Ответ обрезан лимитом токенов: его JSON неполон — причина называется прямо (этап 17, проект §7.2).
    if (choice?.finish_reason === 'length') return chatError('TRUNCATED', 'ответ модели обрезан лимитом токенов (finish_reason=length): увеличьте MODEL_MAX_OUTPUT_TOKENS', false);
    const content = choice?.message?.content;
    if (typeof content !== 'string') return chatError('CONTRACT_MISMATCH', 'в ответе модели нет choices[0].message.content', false);
    const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
    return {
      ok: true,
      value: {
        content,
        startedAt,
        finishedAt: new Date(),
        promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null,
        completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null,
      },
    };
  }
}
