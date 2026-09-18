import { useCallback, useRef } from 'react';
import { newUuid } from '../api/client';

interface IKeyState {
  key: string;
  fingerprint: string;
}

/**
 * Ключ идемпотентности на одну попытку пользователя: повтор той же отправки (например, после
 * сетевой ошибки) идёт с тем же ключом; изменённые данные или успешная отправка — новый ключ.
 */
export const useIdempotencyKey = (): { keyFor: (payload: unknown) => string; reset: () => void } => {
  const state = useRef<IKeyState | null>(null);

  const keyFor = useCallback((payload: unknown): string => {
    const fingerprint = JSON.stringify(payload);
    if (!state.current || state.current.fingerprint !== fingerprint) {
      state.current = { key: newUuid(), fingerprint };
    }
    return state.current.key;
  }, []);

  const reset = useCallback((): void => {
    state.current = null;
  }, []);

  return { keyFor, reset };
};
