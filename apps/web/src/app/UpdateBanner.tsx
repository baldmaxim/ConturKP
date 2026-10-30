import { useEffect, useMemo, useSyncExternalStore, type FC } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { useHasUnsavedChanges } from '../hooks/unsavedChanges';
import { AppVersionMonitor } from '../utils/appVersion';
import styles from './UpdateBanner.module.css';

/**
 * «Доступна новая версия портала» (BRAND.md §9.8): registerType 'prompt', без автоматической
 * перезагрузки. После «Позже» баннер вернётся при следующем открытии портала.
 */
export const UpdateBanner: FC = () => {
  const monitor = useMemo(() => new AppVersionMonitor(
    document.querySelector('meta[name="app-build"]')?.getAttribute('content') ?? '',
  ), []);
  const availableVersion = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot, () => null);
  const hasUnsaved = useHasUnsavedChanges();

  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') void monitor.check(); };
    check();
    const interval = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [monitor]);

  if (!availableVersion) {
    return null;
  }

  const returnTo = window.location.pathname + window.location.search + window.location.hash;

  return (
    <div className={styles.banner} role="status">
      <Icon name="refresh-cw" className={styles.icon} />
      <p className={styles.text}>
        {hasUnsaved ? 'Доступна новая версия портала. Сохраните изменения, затем обновите.' : 'Доступна новая версия портала.'}
      </p>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={monitor.dismiss}>
          Позже
        </Button>
        <form action="/api/ui-update" method="get" onSubmit={(event) => { if (hasUnsaved) event.preventDefault(); }}>
          <input type="hidden" name="returnTo" value={returnTo} />
          <Button type="submit" variant="primary" disabled={hasUnsaved}>
            Обновить
          </Button>
        </form>
      </div>
    </div>
  );
};
