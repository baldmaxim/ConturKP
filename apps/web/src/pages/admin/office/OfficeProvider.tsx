import { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { ApiError, isAbortError } from '../../../api/client';
import { getAdminOffice } from '../../../api/endpoints';
import { useAuth } from '../../../hooks/useAuth';
import { OfficeContext, EMPTY_OFFICE } from './officeContext';
import { buildOffice, STALE_AFTER_MS, type IOfficeView } from './officeModel';
import { officeStatus } from './officeStatus';

interface IState { data: IOfficeView | null; error: unknown; loading: boolean; receivedAt: number }

/** Один опрос на всю оболочку. Ошибка снимается только успешным ответом; повторная попытка не оживляет старые данные. */
const AuthorizedOfficeProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [state, setState] = useState<IState>({ data: null, error: null, loading: true, receivedAt: 0 });
  const [now, setNow] = useState(Date.now);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback((): void => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => {
      if (controller.signal.aborted || request.current !== controller) return;
      controller.abort();
      request.current = null;
      setState((previous) => ({ ...previous, loading: false, error: new Error('Офис не ответил за 15 секунд.') }));
    }, 15_000);
    setNow(Date.now());
    setState((previous) => ({ ...previous, loading: true }));
    void getAdminOffice(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        const receivedAt = Date.now();
        setNow(receivedAt);
        setState({ data, error: null, loading: false, receivedAt });
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          const denied = error instanceof ApiError && (error.status === 401 || error.status === 403);
          setState((previous) => ({ ...previous, data: denied ? null : previous.data, loading: false, error }));
        }
      },
    ).finally(() => { clearTimeout(timeout);if (request.current === controller) request.current = null; });
  }, []);

  useEffect(() => {
    reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 5000);
    const onVisible = (): void => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      request.current?.abort();
      request.current = null;
    };
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, []);

  const office = useMemo(() => state.data ? buildOffice(state.data) : null, [state.data]);
  const stale = state.data !== null && (Boolean(state.error) || now - state.receivedAt > STALE_AFTER_MS);
  const value = useMemo(() => ({ ...state, office, stale, status: officeStatus(state.data, office, stale, state.error), reload }), [state, office, stale, reload]);
  return <OfficeContext.Provider value={value}>{children}</OfficeContext.Provider>;
};

/** При смене пользователя весь снимок уничтожается; без admin.audit запросов и старых данных нет. */
export const OfficeProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const { me, can } = useAuth();
  return me && can('admin.audit')
    ? <AuthorizedOfficeProvider key={me.id}>{children}</AuthorizedOfficeProvider>
    : <OfficeContext.Provider value={EMPTY_OFFICE}>{children}</OfficeContext.Provider>;
};
