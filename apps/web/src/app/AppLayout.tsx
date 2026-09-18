import type { FC } from 'react';
import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import styles from './AppLayout.module.css';

export const AppLayout: FC = () => (
  <>
    <Header />
    <main className={styles.main}>
      <Outlet />
    </main>
  </>
);
