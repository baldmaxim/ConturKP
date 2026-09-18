import type { FC } from 'react';
import { cx } from '../utils/cx';
import styles from './Logo.module.css';

interface ILogoProps {
  /** На узких экранах (<390 px) показывать только знак. */
  collapsible?: boolean;
  size?: 'header' | 'large';
}

/**
 * Логотип под активную тему: оба варианта в разметке, лишний скрыт CSS по data-theme
 * (<picture media> не видит выбор пользователя), BRAND.md §2.6.
 */
export const Logo: FC<ILogoProps> = ({ collapsible = false, size = 'header' }) => (
  <span className={cx(styles.logo, styles[size], collapsible && styles.collapsible)}>
    <span className={styles.wordmark}>
      <img className={styles.logoLight} src="/kontur-kp-logo-light.svg" alt="Контур КП" width={391} height={96} />
      <img className={styles.logoDark} src="/kontur-kp-logo-dark.svg" alt="Контур КП" width={391} height={96} />
    </span>
    {collapsible ? (
      <img className={styles.mark} src="/kontur-kp-favicon.svg" alt="Контур КП" width={512} height={512} />
    ) : null}
  </span>
);
