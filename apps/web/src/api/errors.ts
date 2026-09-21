import { ApiError } from './client';

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'Сеанс завершён. Войдите снова.',
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  NOT_FOUND: 'Объект не найден или нет доступа.',
  PRECONDITION_REQUIRED: 'Сервер не получил версию объекта. Обновите страницу и повторите.',
  VERSION_CONFLICT: 'Объект изменён другим пользователем. Перечитайте данные.',
  VALIDATION_FAILED: 'Проверьте заполнение полей.',
  IDEMPOTENCY_KEY_REUSED: 'Повторная отправка с другими данными отклонена. Отправьте форму ещё раз.',
  RATE_LIMITED: 'Слишком много запросов. Подождите немного и повторите.',
  STATE_CONFLICT: 'Действие недоступно в текущем состоянии объекта.',
  INTERNAL: 'Ошибка на сервере.',
};

export const errorCode = (error: unknown): string | null => (error instanceof ApiError ? error.code : null);

export const hasCode = (error: unknown, code: string): boolean => errorCode(error) === code;

/** Понятное пользователю сообщение об ошибке API. */
export const describeError = (error: unknown): string => {
  if (!(error instanceof ApiError)) {
    return 'Непредвиденная ошибка в интерфейсе. Обновите страницу.';
  }
  if (error.isNetwork) {
    return 'Нет связи с сервером. Проверьте сеть и повторите.';
  }
  const problem = error.problem;
  const code = problem?.code ?? '';
  const base = MESSAGES[code] ?? `Ошибка ${error.status}.`;
  // Для конфликта состояния сервер объясняет причину в detail — она важнее общей фразы.
  const text = code === 'STATE_CONFLICT' && problem?.detail ? problem.detail : base;
  if (error.status >= 500 && problem?.requestId) {
    return `${text} Код запроса: ${problem.requestId}.`;
  }
  return text;
};

/** Ошибки полей из VALIDATION_FAILED: ключ — последний сегмент пути. */
export const fieldErrorsOf = (error: unknown): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!(error instanceof ApiError) || !error.problem?.errors) {
    return result;
  }
  for (const item of error.problem.errors) {
    const segments = item.path.split(/[./]/).filter(Boolean);
    const key = segments[segments.length - 1] ?? item.path;
    if (!(key in result)) {
      result[key] = item.message;
    }
  }
  return result;
};

/** Текущий объект из 412 VERSION_CONFLICT, если сервер его прислал. */
export const conflictCurrent = <T>(error: unknown, guard: (value: unknown) => value is T): T | null => {
  if (!(error instanceof ApiError) || error.code !== 'VERSION_CONFLICT') {
    return null;
  }
  const current = error.problem?.current;
  return guard(current) ? current : null;
};

/** Блокирующие редакции из 409 STATE_CONFLICT заморозки состава: сервер называет каждую. */
export const stateConflictCurrent = (error: unknown): unknown => {
  if (!(error instanceof ApiError) || error.code !== 'STATE_CONFLICT') {
    return null;
  }
  return error.problem?.current ?? null;
};
