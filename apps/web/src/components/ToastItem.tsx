import { useEffect, useRef, useState, type FC } from 'react';
import type { IToast } from '../app/toastContext';
import { cx } from '../utils/cx';
import { Button } from './Button';
import { Icon, type TIconName } from './Icon';
import styles from './ToastItem.module.css';

const AUTO_HIDE_MS = 5000;

const ICONS: Record<IToast['kind'], TIconName> = {
  success: 'check',
  info: 'info',
  error: 'circle-x',
};

interface IToastItemProps {
  toast: IToast;
  onDismiss: (id: number) => void;
}

/** Успех и информация скрываются через 5 с (пауза при наведении и фокусе); ошибки — до закрытия. */
export const ToastItem: FC<IToastItemProps> = ({ toast, onDismiss }) => {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(AUTO_HIDE_MS);

  useEffect(() => {
    if (toast.kind === 'error' || paused) {
      return undefined;
    }
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt));
    };
  }, [paused, toast.id, toast.kind, onDismiss]);

  return (
    <div
      className={cx(styles.toast, styles[toast.kind])}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon name={ICONS[toast.kind]} className={styles.icon} />
      <p className={styles.text}>{toast.text}</p>
      <Button variant="ghost" icon="x" iconOnly aria-label="Закрыть уведомление" onClick={() => onDismiss(toast.id)} />
    </div>
  );
};
