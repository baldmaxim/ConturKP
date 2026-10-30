import type { FC } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Header } from './Header';
import { OfficeProvider } from '../pages/admin/office/OfficeProvider';
import styles from './AppLayout.module.css';

export const AppLayout: FC = () => {
  const {me}=useAuth();
  return (
  <OfficeProvider key={me?.accessVersion ?? me?.id}>
    <Header />
    <main className={styles.main}>
      <Outlet />
    </main>
  </OfficeProvider>
);
};
