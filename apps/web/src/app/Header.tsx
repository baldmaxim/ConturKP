import { useEffect, useState, type FC } from 'react';
import { useLocation } from 'react-router-dom';
import { describeError } from '../api/errors';
import { AppLink } from '../components/AppLink';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { ChangePasswordDialog } from '../pages/ChangePasswordDialog';
import { ApiTokensDialog } from '../pages/mcp/ApiTokensDialog';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { cx } from '../utils/cx';
import styles from './Header.module.css';

const MENU_ID = 'app-mobile-menu';

export const Header: FC = () => {
  const { me, can, logout } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const showAdmin = can('admin.users') || can('admin.audit') || can('admin.contract');
  const showContracts = me?.contractsAvailable ?? false;
  const showMail = me?.mailAvailable ?? false;
  // Этап 11: шаблоны и формулировки — пользователям с содержательной ролью (D-031 В-11-3).
  const showForms = (me?.roles ?? []).some((r) => r === 'manager' || r === 'engineer');
  const path = location.pathname;
  const tendersActive = path === '/' || path.startsWith('/tenders') || path.startsWith('/stages');
  const contractsActive = path.startsWith('/contracts') || path.startsWith('/contract-documents');
  const adminActive = path.startsWith('/admin');
  const mailActive = path.startsWith('/mail') || path.startsWith('/mailboxes');
  const formsActive = path.startsWith('/forms');

  useEffect(() => {
    setMenuOpen(false);
  }, [path]);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
    } catch (error) {
      toast.push({ kind: 'error', text: `Не удалось выйти: ${describeError(error)}` });
      setLoggingOut(false);
    }
  };

  const openPassword = (): void => {
    setMenuOpen(false);
    setPasswordOpen(true);
  };

  const openTokens = (): void => {
    setMenuOpen(false);
    setTokensOpen(true);
  };

  const navLinks = (
    <>
      <AppLink to="/" className={cx(styles.navLink, tendersActive && styles.active)} aria-current={tendersActive ? 'page' : undefined}>
        <Icon name="briefcase" />
        <span>Тендеры</span>
      </AppLink>
      {showContracts ? (
        <AppLink to="/contracts" className={cx(styles.navLink, contractsActive && styles.active)} aria-current={contractsActive ? 'page' : undefined}>
          <Icon name="file-signature" />
          <span>Договоры</span>
        </AppLink>
      ) : null}
      {showMail ? (
        <AppLink to="/mail" className={cx(styles.navLink, mailActive && styles.active)} aria-current={mailActive ? 'page' : undefined}>
          <Icon name="mail" />
          <span>Почта</span>
        </AppLink>
      ) : null}
      {showForms ? (
        <AppLink to="/forms" className={cx(styles.navLink, formsActive && styles.active)} aria-current={formsActive ? 'page' : undefined}>
          <Icon name="scroll-text" />
          <span>Шаблоны</span>
        </AppLink>
      ) : null}
      {showAdmin ? (
        <AppLink to="/admin" className={cx(styles.navLink, adminActive && styles.active)} aria-current={adminActive ? 'page' : undefined}>
          <Icon name="users" />
          <span>Администрирование</span>
        </AppLink>
      ) : null}
    </>
  );

  return (
    <header className={styles.appBar}>
      <div className={styles.inner}>
        <AppLink to="/" className={styles.brand} aria-label="Контур КП — к списку тендеров">
          <Logo collapsible />
        </AppLink>
        <nav className={styles.nav} aria-label="Разделы портала">
          {navLinks}
        </nav>
        <div className={styles.actions}>
          <span className={styles.user} title={me?.login}>
            {me?.displayName}
          </span>
          <ThemeSwitcher compact />
          <Button variant="ghost" icon="message-square" iconOnly aria-label="Доступ для чат-клиентов" title="Доступ для чат-клиентов" onClick={openTokens} />
          <Button variant="ghost" icon="key-round" iconOnly aria-label="Сменить пароль" title="Сменить пароль" onClick={openPassword} />
          <Button variant="ghost" icon="log-out" loading={loggingOut} onClick={() => void handleLogout()}>
            Выйти
          </Button>
        </div>
        <Button
          className={styles.menuButton}
          variant="ghost"
          icon={menuOpen ? 'x' : 'menu'}
          iconOnly
          aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
          aria-expanded={menuOpen}
          aria-controls={MENU_ID}
          onClick={() => setMenuOpen((open) => !open)}
        />
      </div>
      {menuOpen ? (
        <div id={MENU_ID} className={styles.menuPanel}>
          <div className={styles.menuUser}>
            <span className={styles.menuName}>{me?.displayName}</span>
            <span className={styles.menuLogin}>{me?.login}</span>
          </div>
          <nav className={styles.menuNav} aria-label="Разделы портала">
            {navLinks}
          </nav>
          <ThemeSwitcher />
          <div className={styles.menuActions}>
            <Button icon="message-square" onClick={openTokens}>
              Доступ для чат-клиентов
            </Button>
            <Button icon="key-round" onClick={openPassword}>
              Сменить пароль
            </Button>
            <Button icon="log-out" loading={loggingOut} onClick={() => void handleLogout()}>
              Выйти
            </Button>
          </div>
        </div>
      ) : null}
      {passwordOpen ? <ChangePasswordDialog onClose={() => setPasswordOpen(false)} /> : null}
      {tokensOpen ? <ApiTokensDialog onClose={() => setTokensOpen(false)} /> : null}
    </header>
  );
};
