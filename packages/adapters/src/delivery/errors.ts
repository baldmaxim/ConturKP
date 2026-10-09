// Ошибки адаптера размещения (этап 14; contracts/adapters.md §1, §7). Текст — без секретов и без полных путей
// пользователя: код, операция и признак повторяемости. Исход неизвестен — только после операции, меняющей состояние.

export type DeliveryErrorCode =
  | 'FORBIDDEN'
  | 'ROOT_NOT_FOUND'
  | 'STAGING_NOT_FOUND'
  | 'NOT_FOUND'
  | 'CROSS_DEVICE'
  | 'NO_SPACE'
  | 'UNAVAILABLE'
  | 'TIMEOUT_UNKNOWN_OUTCOME'
  | 'CONFLICT'
  | 'INVALID_PATH';

const RETRYABLE: ReadonlySet<DeliveryErrorCode> = new Set(['UNAVAILABLE', 'TIMEOUT_UNKNOWN_OUTCOME']);

export class DeliveryAdapterError extends Error {
  readonly code: DeliveryErrorCode;
  readonly retryable: boolean;
  constructor(code: DeliveryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

export class DeliveryTimeoutError extends Error {
  constructor(op: string) {
    super(`истёк срок ожидания операции ${op}`);
  }
}

const NETWORK = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EIO', 'EBUSY', 'EAGAIN', 'EPIPE', 'UNKNOWN']);

// Ошибка ОС → код адаптера. mutating — операция меняет состояние (тогда истечение срока — неизвестный исход).
export const deliveryErrorOf = (err: unknown, op: string, mutating: boolean): DeliveryAdapterError => {
  if (err instanceof DeliveryAdapterError) return err;
  if (err instanceof DeliveryTimeoutError) {
    return mutating ? new DeliveryAdapterError('TIMEOUT_UNKNOWN_OUTCOME', `${op}: истёк срок ожидания, исход неизвестен`) : new DeliveryAdapterError('UNAVAILABLE', `${op}: истёк срок ожидания`);
  }
  const code = (err as NodeJS.ErrnoException | null)?.code ?? '';
  if (code === 'ENOSPC' || code === 'EDQUOT') return new DeliveryAdapterError('NO_SPACE', `${op}: нет места в назначении`);
  if (code === 'EACCES' || code === 'EPERM') return new DeliveryAdapterError('FORBIDDEN', `${op}: нет прав в назначении`);
  if (code === 'ENOENT') return new DeliveryAdapterError('NOT_FOUND', `${op}: путь не найден`);
  if (code === 'EXDEV') return new DeliveryAdapterError('CROSS_DEVICE', `${op}: служебная папка и корень на разных томах`);
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return new DeliveryAdapterError('CONFLICT', `${op}: на этом месте уже есть файл или папка`);
  if (NETWORK.has(code)) return new DeliveryAdapterError('UNAVAILABLE', `${op}: назначение недоступно (${code})`);
  return new DeliveryAdapterError('UNAVAILABLE', `${op}: ошибка назначения${code ? ` (${code})` : ''}`);
};

// Операция со сроком ожидания: сама операция не прерывается (файловые операции не отменяются), но её исход больше не ждут.
export const withTimeout = async <T>(op: string, ms: number, fn: () => Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeliveryTimeoutError(op)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
