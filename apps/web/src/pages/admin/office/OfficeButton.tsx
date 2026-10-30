import type { FC } from 'react';
import { AppLink } from '../../../components/AppLink';
import { cx } from '../../../utils/cx';
import { officeStatusLabel } from './officeStatus';
import { useOffice } from './useOffice';
import { VoxelAgent } from './VoxelAgent';
import styles from './OfficeButton.module.css';

export const OfficeButton: FC<{ active: boolean }> = ({ active }) => {
  const { office, status, stale } = useOffice();
  const label = officeStatusLabel(status, office);
  return (
    <AppLink to="/office" className={cx(styles.button, active && styles.active)} aria-current={active ? 'page' : undefined} aria-label={`Офис: ${label}`} title={`Офис: ${label}`} data-status={status}>
      <VoxelAgent status={status} frozen={stale} />
      <span className={styles.copy}><span className={styles.name}>Офис</span><span className={styles.status}><span className={styles.dot} /><span className={styles.label}>{label}</span></span></span>
    </AppLink>
  );
};
