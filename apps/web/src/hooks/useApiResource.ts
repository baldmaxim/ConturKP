import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { isAbortError } from '../api/client';

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
 * Данные принадлежат ключу: при смене key прежний результат немедленно перестаёт быть
 * текущим и очищается. Иначе экран показывал бы данные прежнего объекта как данные нового —
 * для доказательств это прямая ложь (R04-14, R04-15). Повторная загрузка тем же ключом
 * (reload) данные сохраняет: поллинг не должен мигать пустым экраном.
 */
export const useApiResource = <T>(loader: (signal: AbortSignal) => Promise<T>, key: string): IApiResource<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(0);
  // Актуальный loader без перезапуска эффекта на каждом рендере.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const shownKey = useRef(key);

  useEffect(() => {
    const controller = new AbortController();
    if (shownKey.current !== key) {
      shownKey.current = key;
      setData(null);
    }
    setLoading(true);
    setError(null);
    loaderRef
      .current(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) {
          return;
        }
        setError(reason);
        setLoading(false);
      });
    return () => controller.abort();
  }, [key, token]);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  return { data, error, loading, reload, setData };
};
