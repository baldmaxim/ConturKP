import type { FC } from 'react';
import { cx } from '../utils/cx';
import { Icon, type TIconName } from './Icon';
import styles from './Badge.module.css';

export type TBadgeTone = 'neutral' | 'muted' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

interface IBadgeProps {
  label: string;
  icon: TIconName;
  tone?: TBadgeTone;
}

/** Бейдж статуса: подпись + иконка + цвет (цвет не единственный носитель смысла). */
export const Badge: FC<IBadgeProps> = ({ label, icon, tone = 'neutral' }) => (
  <span className={cx(styles.badge, styles[tone])} title={label}>
    <Icon name={icon} size={16} />
    <span className={styles.text}>{label}</span>
  </span>
);
