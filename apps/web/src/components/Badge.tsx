import type { FC } from 'react';
import { cx } from '../utils/cx';
import { Icon, type TIconName } from './Icon';
import styles from './Badge.module.css';

export type TBadgeTone = 'neutral' | 'muted' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

interface IBadgeProps {
  label: string;
  icon: TIconName;
  tone?: TBadgeTone;
  /** Пунктирная рамка: неполная обработка и незавершённые состояния (BRAND.md §4.6). */
  dashed?: boolean;
}

/** Бейдж статуса: подпись + иконка + цвет (цвет не единственный носитель смысла). */
export const Badge: FC<IBadgeProps> = ({ label, icon, tone = 'neutral', dashed = false }) => (
  <span className={cx(styles.badge, styles[tone], dashed && styles.dashed)} title={label}>
    <Icon name={icon} size={16} />
    <span className={styles.text}>{label}</span>
  </span>
);
