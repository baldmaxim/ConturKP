import { useId, useLayoutEffect, useRef, useState, type FC, type KeyboardEvent } from 'react';
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
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const hintId = useId();
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const scroller = scrollerRef.current;
    const list = tabsRef.current;
    if (!container || !scroller || !list) return;

    const updateScroll = (): void => {
      // Compare with the whole container so the arrows do not keep themselves visible.
      const overflow = list.scrollWidth > container.clientWidth + 1;
      const left = overflow && scroller.scrollLeft > 1;
      const right = overflow && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
      setScroll((previous) => previous.overflow === overflow && previous.left === left && previous.right === right
        ? previous : { overflow, left, right });
    };
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      if ((delta > 0 && scroller.scrollLeft < maxScroll - 1) || (delta < 0 && scroller.scrollLeft > 1)) {
        event.preventDefault();
        scroller.scrollBy({ left: delta * scale, behavior: 'instant' });
      }
    };
    const observer = new ResizeObserver(updateScroll);
    observer.observe(container);
    observer.observe(scroller);
    observer.observe(list);
    scroller.addEventListener('scroll', updateScroll, { passive: true });
    // React's wheel listener is passive; the native listener lets us consume only handled scrolling.
    container.addEventListener('wheel', onWheel, { passive: false });
    updateScroll();
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', updateScroll);
      container.removeEventListener('wheel', onWheel);
    };
  }, [tabs]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const selected = tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (!scroller || !selected) return;
    const viewport = scroller.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    const inset = scroll.overflow ? 20 : 0;
    const delta = tab.left < viewport.left + inset ? tab.left - viewport.left - inset
      : tab.right > viewport.right - inset ? tab.right - viewport.right + inset : 0;
    if (delta) scroller.scrollBy({ left: delta, behavior: 'instant' });
  }, [active, tabs, scroll.overflow]);

  const scrollByPage = (direction: number): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({
      left: direction * scroller.clientWidth * 0.8,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  };

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
      document.getElementById(tabId(next.id))?.focus({ preventScroll: true });
    }
  };

  return (
    <div className={styles.container} ref={containerRef}>
      {scroll.overflow ? (
        <button
          type="button"
          className={cx(styles.scrollButton, styles.scrollLeft)}
          aria-label="Прокрутить вкладки влево"
          aria-controls={listId}
          title="Предыдущие разделы — можно прокручивать колёсиком"
          disabled={!scroll.left}
          onClick={() => scrollByPage(-1)}
        >
          <Icon name="chevron-right" />
        </button>
      ) : null}
      <div ref={scrollerRef} className={cx(styles.scroller, scroll.left && styles.moreLeft, scroll.right && styles.moreRight)}>
        <div ref={tabsRef} id={listId} className={styles.tabs} role="tablist" aria-label={label} aria-describedby={scroll.overflow ? hintId : undefined} onKeyDown={onKeyDown}>
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
      {scroll.overflow ? (
        <>
          <button
            type="button"
            className={styles.scrollButton}
            aria-label="Прокрутить вкладки вправо"
            aria-controls={listId}
            title="Ещё разделы справа — можно прокручивать колёсиком"
            disabled={!scroll.right}
            onClick={() => scrollByPage(1)}
          >
            <Icon name="chevron-right" />
          </button>
          <span id={hintId} className={styles.hint}>Прокручивайте разделы колёсиком или кнопками по краям.</span>
        </>
      ) : null}
    </div>
  );
};
