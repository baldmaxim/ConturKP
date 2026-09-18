import { useCallback, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { ToastItem } from '../components/ToastItem';
import { ToastContext, type IToast, type IToastApi, type IToastInput } from './toastContext';
import styles from './ToastProvider.module.css';

const MAX_TOASTS = 3;

interface IToastProviderProps {
  children: ReactNode;
}

/** Тосты: не больше трёх одновременно (BRAND.md §9.7). */
export const ToastProvider: FC<IToastProviderProps> = ({ children }) => {
  const [toasts, setToasts] = useState<IToast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((toast: IToastInput) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((items) => [...items, { ...toast, id }].slice(-MAX_TOASTS));
  }, []);

  const api = useMemo<IToastApi>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.host}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};
