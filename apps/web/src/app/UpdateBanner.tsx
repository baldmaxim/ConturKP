import { useState, type FC } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { useHasUnsavedChanges } from '../hooks/unsavedChanges';
import styles from './UpdateBanner.module.css';

/**
 * «Доступна новая версия портала» (BRAND.md §9.8): registerType 'prompt', без автоматической
 * перезагрузки. После «Позже» баннер вернётся при следующем открытии портала.
 */
export const UpdateBanner: FC = () => {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const hasUnsaved = useHasUnsavedChanges();
  const [updating, setUpdating] = useState(false);

  if (!needRefresh) {
    return null;
  }

  const update = (): void => {
    setUpdating(true);
    void updateServiceWorker(true);
  };

  return (
    <div className={styles.banner} role="status">
      <Icon name="refresh-cw" className={styles.icon} />
      <p className={styles.text}>
        {hasUnsaved ? 'Доступна новая версия портала. Сохраните изменения, затем обновите.' : 'Доступна новая версия портала.'}
      </p>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={() => setNeedRefresh(false)}>
          Позже
        </Button>
        <Button variant="primary" onClick={update} disabled={hasUnsaved} loading={updating}>
          Обновить
        </Button>
      </div>
    </div>
  );
};
