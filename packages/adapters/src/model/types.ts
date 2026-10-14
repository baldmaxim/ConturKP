// Шлюз генеративной модели (docs/contracts/adapters.md §8, ADR-009, OD-08-2). Провайдер получает только
// инструкции сервера и текст фрагментов как данные; область, права и проверка ответа — забота портала.
// Ошибки — без секретов; повторяемость указывает сам провайдер.
import type { AnalysisTask } from '@kontur/core';

// TRUNCATED — ответ обрезан лимитом токенов или слишком велик (этап 17): не «невалидный JSON», а названная причина.
export type ChatModelErrorCode = 'UNAVAILABLE' | 'TIMEOUT_UNKNOWN_OUTCOME' | 'AUTH_FAILED' | 'RATE_LIMITED' | 'CONTRACT_MISMATCH' | 'TRUNCATED';

export interface IChatModelError {
  code: ChatModelErrorCode;
  message: string;
  retryable: boolean;
}

export type ChatModelResult<T> = { ok: true; value: T } | { ok: false; error: IChatModelError };

export interface IChatCompletion {
  content: string;
  startedAt: Date;
  finishedAt: Date;
  promptTokens: number | null;
  completionTokens: number | null;
}

// Задачи шлюза: извлечение кандидатов (этап 08) и ответное ядро (этап 08a) — черновик и необязательная проверка.
// Этап 09: гипотезы расхождений (C12) — только предложения человеку.
// Этап 10: гипотезы причин изменений стоимости — только предложения человеку.
export type ChatTask = AnalysisTask | 'answer_draft' | 'answer_verify' | 'review_hypotheses' | 'change_reasons' | 'form_suggestions';

export interface IChatCompleteInput {
  task: ChatTask;
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface IModelGatewayChat {
  // Провайдер, модель и версия входят в контракт прогона и в ключ повтора (OD-08-2).
  readonly providerId: 'fake' | 'openai_compatible';
  readonly model: string;
  readonly version: string;
  readonly maxInputChars: number;
  // Настройки вывода — часть ключа повтора: изменение даёт новый прогон.
  readonly inferenceConfig: Record<string, unknown>;
  complete(input: IChatCompleteInput): Promise<ChatModelResult<IChatCompletion>>;
}

export const chatError = (code: ChatModelErrorCode, message: string, retryable: boolean): { ok: false; error: IChatModelError } => ({
  ok: false,
  error: { code, message, retryable },
});
