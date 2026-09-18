import type { ButtonHTMLAttributes, FC } from 'react';
import { cx } from '../utils/cx';
import { Icon, type TIconName } from './Icon';
import styles from './Button.module.css';

export type TButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerFilled';

interface IButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: TButtonVariant;
  icon?: TIconName;
  /** Ждём ответа сервера: кнопка заблокирована, показывается индикатор. */
  loading?: boolean;
  /** Только иконка: подпись обязательна через aria-label. */
  iconOnly?: boolean;
}

export const Button: FC<IButtonProps> = ({
  variant = 'secondary',
  icon,
  loading = false,
  iconOnly = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}) => (
  <button
    {...rest}
    type={type}
    className={cx(styles.button, styles[variant], iconOnly && styles.iconOnly, className)}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
  >
    {loading ? <Icon name="loader-circle" className={styles.spinner} /> : icon ? <Icon name={icon} /> : null}
    {iconOnly ? null : <span>{children}</span>}
  </button>
);
