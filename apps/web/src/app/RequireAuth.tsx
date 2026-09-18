import type { FC, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Button } from '../components/Button';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { useAuth } from '../hooks/useAuth';
import styles from './RequireAuth.module.css';

interface IRequireAuthProps {
  children: ReactNode;
}

/** Пускает только после входа; иначе — на экран входа с возвратом на исходный адрес. */
export const RequireAuth: FC<IRequireAuthProps> = ({ children }) => {
  const { status, error, refresh } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className={styles.center}>
        <LoadingState label="Проверяем сеанс…" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className={styles.center}>
        <ErrorState error={error} onRetry={() => void refresh()} />
        <Button variant="ghost" onClick={() => window.location.assign('/login')}>
          Перейти ко входу
        </Button>
      </div>
    );
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <>{children}</>;
};
