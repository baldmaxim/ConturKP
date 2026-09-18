import type { FC } from 'react';
import { Icon } from './Icon';
import styles from './LoadingState.module.css';

interface ILoadingStateProps {
  label?: string;
}

export const LoadingState: FC<ILoadingStateProps> = ({ label = 'Загрузка…' }) => (
  <div className={styles.loading} role="status">
    <Icon name="loader-circle" className={styles.spinner} />
    <span>{label}</span>
  </div>
);
