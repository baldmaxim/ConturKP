import type { FC, ReactNode } from 'react';
import { AppLink } from './AppLink';
import { Icon } from './Icon';
import styles from './PageHeader.module.css';

interface IPageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  back?: { to: string; label: string };
  actions?: ReactNode;
}

export const PageHeader: FC<IPageHeaderProps> = ({ title, subtitle, back, actions }) => (
  <div className={styles.header}>
    {back ? (
      <AppLink to={back.to} className={styles.back}>
        <Icon name="arrow-left" size={16} />
        <span>{back.label}</span>
      </AppLink>
    ) : null}
    <div className={styles.row}>
      <div className={styles.titles}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  </div>
);
