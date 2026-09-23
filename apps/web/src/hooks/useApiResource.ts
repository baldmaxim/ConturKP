import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { isAbortError } from '../api/client';
import { pendingState, viewOf, type IKeyedState } from './keyedState';

export interface IApiResource<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * Загружает ресурс при монтировании и при смене key; отменяет устаревшие запросы.
 * key — строка, однозначно задающая запрос (например, id тендера).
 *
 * Данные принадлежат ключу **синхронно, на этапе render**: результат отдаётся только тогда,
 * когда он получен по текущему ключу. Очистки в эффекте недостаточно — эффект выполняется
 * после render и commit, поэтому один кадр успевал показать данные прежнего объекта как
 * данные нового. Для портала доказательств это прямая ложь (R04-14, R04-15).
 * Повторная загрузка тем же ключом (reload) данные сохраняет: поллинг не мигает пустым экраном.
 */
export const useApiResource = <T>(loader: (signal: AbortSignal) => Promise<T>, key: string): IApiResource<T> => {
  const [state, setState] = useState<IKeyedState<T>>(() => pendingState<T>(key));
  const [token, setToken] = useState(0);
  // Актуальный loader без перезапуска эффекта на каждом рендере.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keyRef = useRef(key);
  keyRef.current = key;

  // Состояние чужого ключа не существует для текущего render: ни данных, ни ошибки, идёт загрузка.
  const current = viewOf(state, key);

  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => (prev.key === key ? { ...prev, error: null, loading: true } : pendingState<T>(key)));
    loaderRef.current(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setState({ key, data: result, error: null, loading: false });
        }
      },
      (reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) {
          return;
        }
        // Ошибка тоже принадлежит ключу; данные того же ключа при повторной загрузке остаются.
        setState((prev) => ({ key, data: prev.key === key ? prev.data : null, error: reason, loading: false }));
      },
    );
    return () => controller.abort();
  }, [key, token]);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  const setData = useCallback<Dispatch<SetStateAction<T | null>>>((value) => {
    setState((prev) => {
      const base = prev.key === keyRef.current ? prev : pendingState<T>(keyRef.current);
      const next = typeof value === 'function' ? (value as (p: T | null) => T | null)(base.data) : value;
      return { ...base, data: next };
    });
  }, []);

  return { data: current.data, error: current.error, loading: current.loading, reload, setData };
};
