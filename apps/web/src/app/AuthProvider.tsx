import { useCallback, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';
import { ApiError, isAbortError, setUnauthenticatedHandler } from '../api/client';
import { getMe, login as apiLogin, logout as apiLogout } from '../api/endpoints';
import type { IMe } from '../api/types';
import { AuthContext, type IAuthApi, type TAuthStatus } from './authContext';

interface IAuthState {
  status: TAuthStatus;
  me: IMe | null;
  error: unknown;
}

const ANONYMOUS: IAuthState = { status: 'anonymous', me: null, error: null };

interface IAuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: FC<IAuthProviderProps> = ({ children }) => {
  const [state, setState] = useState<IAuthState>({ status: 'loading', me: null, error: null });

  // Любой 401 от API сбрасывает сеанс; RequireAuth переводит на экран входа.
  useEffect(() => {
    setUnauthenticatedHandler(() => setState(ANONYMOUS));
    return () => setUnauthenticatedHandler(null);
  }, []);

  const loadMe = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const me = await getMe(signal);
      setState({ status: 'authenticated', me, error: null });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        setState(ANONYMOUS);
        return;
      }
      setState({ status: 'error', me: null, error });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadMe(controller.signal);
    return () => controller.abort();
  }, [loadMe]);

  const login = useCallback(async (loginName: string, password: string): Promise<void> => {
    const me = await apiLogin(loginName, password);
    setState({ status: 'authenticated', me, error: null });
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiLogout();
    } catch (error) {
      // 401 — сеанса уже нет; прочие ошибки показывает вызывающий.
      if (!(error instanceof ApiError && error.status === 401)) {
        throw error;
      }
    }
    setState(ANONYMOUS);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setState((prev) => (prev.status === 'error' ? { ...prev, status: 'loading' } : prev));
    await loadMe();
  }, [loadMe]);

  const api = useMemo<IAuthApi>(
    () => ({
      status: state.status,
      me: state.me,
      error: state.error,
      login,
      logout,
      refresh,
      can: (capability: string) => state.me?.capabilities.includes(capability) ?? false,
    }),
    [state, login, logout, refresh],
  );

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
};
