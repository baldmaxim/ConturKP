import { useState, type FC, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '../api/client';
import { describeError } from '../api/errors';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { Notice } from '../components/Notice';
import { TextField } from '../components/TextField';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { useAuth } from '../hooks/useAuth';
import styles from './LoginPage.module.css';

const safeFrom = (state: unknown): string => {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const from = (state as { from: unknown }).from;
    // Только внутренние пути портала: без открытого редиректа.
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login')) {
      return from;
    }
  }
  return '/';
};

const loginErrorText = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 401) {
    return 'Неверный логин или пароль.';
  }
  if (error instanceof ApiError && error.status === 429) {
    return 'Слишком много попыток входа. Подождите несколько минут и повторите.';
  }
  return describeError(error);
};

export const LoginPage: FC = () => {
  const { status, login } = useAuth();
  const location = useLocation();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'authenticated') {
    return <Navigate to={safeFrom(location.state)} replace />;
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!loginName.trim() || !password) {
      setError('Введите логин и пароль.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(loginName.trim(), password);
    } catch (reason) {
      setError(loginErrorText(reason));
      setPassword('');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.theme}>
        <ThemeSwitcher compact />
      </div>
      <main className={styles.main}>
        <div className={styles.card}>
          <Logo size="large" />
          <h1 className={styles.title}>Вход в портал</h1>
          <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <TextField
              label="Логин"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={loginName}
              onValueChange={setLoginName}
            />
            <TextField
              label="Пароль"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onValueChange={setPassword}
            />
            <Button variant="primary" type="submit" loading={submitting} className={styles.submit}>
              Войти
            </Button>
          </form>
          <p className={styles.hint}>Учётную запись выдаёт администратор портала.</p>
        </div>
      </main>
    </div>
  );
};
