import type { FC, ReactNode } from 'react';
import { cx } from '../utils/cx';
import { Icon, type TIconName } from './Icon';
import styles from './Notice.module.css';

type TNoticeTone = 'info' | 'warning' | 'danger' | 'success';

const TONE_ICONS: Record<TNoticeTone, TIconName> = {
  info: 'info',
  warning: 'info',
  danger: 'circle-x',
  success: 'check',
};

interface INoticeProps {
  tone: TNoticeTone;
  children: ReactNode;
  action?: ReactNode;
  icon?: TIconName;
}

/** Встроенный баннер: иконка + текст на мягком фоне тона. */
export const Notice: FC<INoticeProps> = ({ tone, children, action, icon }) => (
  <div className={cx(styles.notice, styles[tone])} role={tone === 'danger' ? 'alert' : 'status'}>
    <Icon name={icon ?? TONE_ICONS[tone]} className={styles.icon} />
    <div className={styles.text}>{children}</div>
    {action ? <div className={styles.action}>{action}</div> : null}
  </div>
);
