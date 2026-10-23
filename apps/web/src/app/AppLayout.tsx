import type { FC } from 'react';
import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { OfficeProvider } from '../pages/admin/office/OfficeProvider';
import styles from './AppLayout.module.css';

export const AppLayout: FC = () => (
  <OfficeProvider>
    <Header />
    <main className={styles.main}>
      <Outlet />
    </main>
  </OfficeProvider>
);
