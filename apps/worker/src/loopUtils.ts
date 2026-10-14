// Вспомогательные функции циклов worker (этап 17, проект §3): прерываемая пауза и защита шлюзов модели.
export const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

// Методы шлюзов модели, после которых проверяется остановка: прерванный вызов возвращает «недоступна»,
// и без проверки обработчик записал бы ложную деградацию модели (S17-04).
// after — учёт результата вызова (статус модели в integration_status), только если задание не остановлено.
export const guardGateway = <T extends object>(inner: T | null, methods: readonly string[], check: () => void, after?: (out: unknown) => Promise<void>): T | null =>
  inner === null
    ? null
    : new Proxy(inner, {
        get: (target, prop, receiver) => {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          if (!methods.includes(String(prop))) return value.bind(target);
          return async (...args: unknown[]) => {
            const out: unknown = await value.apply(target, args);
            check();
            if (after) await after(out).catch(() => undefined);
            return out;
          };
        },
      });
