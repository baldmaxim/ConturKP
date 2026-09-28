// Шлюз модели эмбеддингов (docs/contracts/adapters.md §4, ADR-012 §25). Провайдер только
// превращает тексты в векторы: область поиска, шаблон входа и кеш — забота портала, провайдер
// их не видит. Ошибки — без секретов; повторяемость указывает сам провайдер.

export type EmbeddingErrorCode = 'UNAVAILABLE' | 'TIMEOUT_UNKNOWN_OUTCOME' | 'AUTH_FAILED' | 'RATE_LIMITED' | 'CONTRACT_MISMATCH' | 'INVALID_DATA';

export interface IEmbeddingError {
  code: EmbeddingErrorCode;
  // Причина деградации смысловой ветки (ADR-012 §17): model_unavailable, dimension_mismatch, …
  reason: 'model_unavailable' | 'dimension_mismatch' | 'semantic_failed';
  message: string;
  retryable: boolean;
}

export type EmbeddingResult<T> = { ok: true; value: T } | { ok: false; error: IEmbeddingError };

export interface IEmbedOutput {
  vectors: number[][];
  dim: number;
}

export interface IModelProbe {
  model: string;
  dim: number;
  // Вектор фиксированной пробной строки: сверяется с сохранённым в версии индекса.
  probe: number[];
}

export interface IModelGatewayEmbeddings {
  readonly kind: 'openai_compatible' | 'fake';
  // Имя модели и ревизия из настройки: входят в отпечаток версии индекса.
  readonly model: string;
  readonly revision: string;
  readonly batchSize: number;
  embed(input: { texts: string[]; purpose: 'index' | 'query'; signal?: AbortSignal }): Promise<EmbeddingResult<IEmbedOutput>>;
  probe(signal?: AbortSignal): Promise<EmbeddingResult<IModelProbe>>;
}

export const embeddingError = (
  code: EmbeddingErrorCode,
  reason: IEmbeddingError['reason'],
  message: string,
  retryable: boolean,
): { ok: false; error: IEmbeddingError } => ({ ok: false, error: { code, reason, message, retryable } });

// Проверка ответа любой модели до записи (ADR-012 §6, §25): число векторов, конечные числа,
// одна размерность у всех, совпадение с ожидаемой и предел проекта.
export const validateVectors = (
  vectors: unknown,
  expectedCount: number,
  expectedDim: number | null,
  maxDim: number,
): EmbeddingResult<IEmbedOutput> => {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    return embeddingError('CONTRACT_MISMATCH', 'semantic_failed', `модель вернула ${Array.isArray(vectors) ? vectors.length : 0} векторов вместо ${expectedCount}`, false);
  }
  let dim: number | null = null;
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return embeddingError('INVALID_DATA', 'semantic_failed', 'вектор модели содержит не числа или пуст', false);
    }
    if (dim === null) dim = v.length;
    else if (v.length !== dim) return embeddingError('CONTRACT_MISMATCH', 'dimension_mismatch', 'векторы одной пачки разной размерности', false);
  }
  const d = dim ?? 0;
  if (d > maxDim) return embeddingError('CONTRACT_MISMATCH', 'dimension_mismatch', `размерность ${d} больше предела проекта ${maxDim}`, false);
  if (expectedDim !== null && d !== expectedDim) {
    return embeddingError('CONTRACT_MISMATCH', 'dimension_mismatch', `размерность ${d} вместо ожидаемой ${expectedDim}`, false);
  }
  return { ok: true, value: { vectors: vectors as number[][], dim: d } };
};
