import type { FC, ReactNode } from 'react';
import { Icon, type TIconName } from './Icon';
import styles from './EmptyState.module.css';

interface IEmptyStateProps {
  icon: TIconName;
  title: string;
  text?: string;
  action?: ReactNode;
}

/** Пустое состояние: иконка 32, заголовок, пояснение с областью и одно действие (BRAND.md §9.9). */
export const EmptyState: FC<IEmptyStateProps> = ({ icon, title, text, action }) => (
  <div className={styles.empty}>
    <Icon name={icon} size={32} className={styles.icon} />
    <h2 className={styles.title}>{title}</h2>
    {text ? <p className={styles.text}>{text}</p> : null}
    {action ? <div className={styles.action}>{action}</div> : null}
  </div>
);
