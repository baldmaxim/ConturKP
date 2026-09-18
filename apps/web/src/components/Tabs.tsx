import type { FC, KeyboardEvent } from 'react';
import { cx } from '../utils/cx';
import { Icon, type TIconName } from './Icon';
import styles from './Tabs.module.css';

export interface ITab {
  id: string;
  label: string;
  icon: TIconName;
}

interface ITabsProps {
  tabs: ITab[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}

export const tabId = (id: string): string => `tab-${id}`;
export const tabPanelId = (id: string): string => `tabpanel-${id}`;

export const Tabs: FC<ITabsProps> = ({ tabs, active, onChange, label }) => {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === active);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) {
      event.preventDefault();
      onChange(next.id);
      document.getElementById(tabId(next.id))?.focus();
    }
  };

  return (
    <div className={styles.scroller}>
      <div className={styles.tabs} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={tabPanelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              className={cx(styles.tab, selected && styles.selected)}
              onClick={() => onChange(tab.id)}
            >
              <Icon name={tab.icon} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
