import { useEffect, useId, useLayoutEffect, useRef, useState, type FC, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { cx } from '../utils/cx';
import { isAimingAtSubmenu, placeAtPoint, placeBeside, type IPoint, type IRect } from '../utils/menuAim';
import { Icon } from './Icon';
import type { IMenuAction, TMenuEntry } from './menuTypes';
import styles from './ContextMenu.module.css';

/** Сколько последних точек указателя помнить: треугольник строится от самой старой — дрожание руки не сбивает. */
const TRAIL_LENGTH = 3;
/** Указатель замер внутри треугольника — через столько мс выделение всё же переходит на пункт под ним. */
const AIM_DELAY = 300;
/** Отпускание правой кнопки раньше этого срока после открытия — не выбор (меню открылось нажатием). */
const RELEASE_GUARD = 250;

export type TMenuAnchor = { kind: 'point'; point: IPoint } | { kind: 'beside'; trigger: IRect; parent: IRect };

interface IOpenSubmenu {
  index: number;
  anchor: TMenuAnchor;
  /** Открыто клавиатурой: фокус и выделение первого пункта — в подменю. */
  byKeyboard: boolean;
  /** Номер открытия: новое открытие (в том числе клавиатурой того же подменю) пересоздаёт панель. */
  seq: number;
}

interface IMenuPanelProps {
  entries: TMenuEntry[];
  anchor: TMenuAnchor;
  panelRef: RefObject<HTMLDivElement | null>;
  /** Открыта клавиатурой: сразу выделить первый пункт. */
  byKeyboard: boolean;
  labelledBy?: string;
  blinkingId: string | null;
  openedAt: number;
  onSelect: (entry: IMenuAction) => void;
  /** ← в подменю: вернуться к родителю. У корневой панели нет. */
  onBack?: () => void;
}

const toRect = (element: Element): IRect => {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
};

const isEnabled = (entry: TMenuEntry | undefined): boolean => entry !== undefined && entry.kind !== 'separator' && !entry.disabled;

/** Следующий доступный пункт по кругу; from = null — от края списка. */
const step = (entries: TMenuEntry[], from: number | null, dir: 1 | -1): number | null => {
  const count = entries.length;
  const start = from ?? (dir === 1 ? -1 : count);
  for (let shift = 1; shift <= count; shift += 1) {
    const index = (((start + dir * shift) % count) + count) % count;
    if (isEnabled(entries[index])) {
      return index;
    }
  }
  return null;
};

/**
 * Панель меню. Открытое подменю рисуется соседней панелью, а не внутри: у панели backdrop-filter
 * (создаёт блок для позиционирования) и overflow (обрезал бы подменю).
 */
export const MenuPanel: FC<IMenuPanelProps> = ({ entries, anchor, panelRef, byKeyboard, labelledBy, blinkingId, openedAt, onSelect, onBack }) => {
  const baseId = useId();
  const [active, setActive] = useState<number | null>(() => (byKeyboard ? step(entries, null, 1) : null));
  const [open, setOpen] = useState<IOpenSubmenu | null>(null);
  const [position, setPosition] = useState<IPoint | null>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const trail = useRef<IPoint[]>([]);
  const pending = useRef<number | undefined>(undefined);

  // Позиция — до отрисовки: панель мерится прозрачной, затем встаёт на место без мигания.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const viewport = { width: document.documentElement.clientWidth, height: window.innerHeight };
    if (anchor.kind === 'point') {
      setPosition(placeAtPoint(anchor.point, size, viewport));
    } else {
      const inset = panel.clientTop + parseFloat(getComputedStyle(panel).paddingTop);
      setPosition(placeBeside(anchor.trigger, anchor.parent, size, viewport, inset));
    }
  }, [anchor, panelRef]);

  useEffect(() => {
    if (anchor.kind === 'point' || byKeyboard) {
      panelRef.current?.focus({ preventScroll: true });
    }
    return () => window.clearTimeout(pending.current);
    // Только при открытии панели.
  }, []);

  const clearPending = (): void => {
    window.clearTimeout(pending.current);
    pending.current = undefined;
  };

  const openSubmenu = (index: number, keyboard: boolean): void => {
    const panel = panelRef.current;
    const trigger = panel?.querySelector(`[data-menu-index="${index}"]`);
    if (!panel || !trigger || (open?.index === index && !keyboard)) {
      return;
    }
    const nextAnchor: TMenuAnchor = { kind: 'beside', trigger: toRect(trigger), parent: toRect(panel) };
    setOpen((current) => ({ index, anchor: nextAnchor, byKeyboard: keyboard, seq: (current?.seq ?? 0) + 1 }));
  };

  const closeSubmenu = (): void => {
    setOpen(null);
    panelRef.current?.focus({ preventScroll: true });
  };

  /** Наведение мышью: выделить пункт, у пункта с подменю — сразу открыть его. */
  const hover = (index: number | null): void => {
    clearPending();
    setActive(index);
    const entry = index === null ? undefined : entries[index];
    if (index !== null && entry?.kind === 'submenu' && !entry.disabled) {
      openSubmenu(index, false);
    } else {
      setOpen(null);
    }
  };

  /** Стрелки: выделить пункт; подменю открывается только → / Enter. */
  const highlight = (index: number | null): void => {
    clearPending();
    setActive(index);
    setOpen(null);
  };

  const choose = (index: number, keyboard: boolean): void => {
    const entry = entries[index];
    if (!entry || entry.kind === 'separator' || entry.disabled) {
      return;
    }
    if (entry.kind === 'submenu') {
      setActive(index);
      openSubmenu(index, keyboard);
      return;
    }
    onSelect(entry);
  };

  const onPointerEnter = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'touch') {
      panelRef.current?.focus({ preventScroll: true });
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch') {
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    const from = trail.current[0];
    trail.current = [...trail.current, point].slice(-TRAIL_LENGTH);
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-menu-index]') : null;
    const index = row ? Number(row.dataset.menuIndex) : null;
    const target = index !== null && isEnabled(entries[index]) ? index : null;
    if (target === active) {
      clearPending();
      return;
    }
    const submenu = subRef.current;
    const panel = panelRef.current;
    if (open && from && submenu && panel && isAimingAtSubmenu(from, point, toRect(submenu), toRect(panel))) {
      // Указатель внутри «невидимого треугольника» — идёт к подменю по диагонали через соседние пункты.
      // Они не перехватывают выделение; если рука остановилась — переключаемся по таймеру.
      clearPending();
      pending.current = window.setTimeout(() => hover(target), AIM_DELAY);
      return;
    }
    hover(target);
  };

  const onPointerLeave = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch') {
      return;
    }
    clearPending();
    trail.current = [];
    // Пункт с открытым подменю остаётся выделенным, пока подменю открыто (как в macOS).
    if (!open) {
      setActive(null);
    }
  };

  // macOS: нажал правую кнопку, довёл до пункта, отпустил — выбор.
  const onItemPointerUp = (event: PointerEvent<HTMLDivElement>, index: number): void => {
    if (event.button === 2 && index === active && performance.now() - openedAt > RELEASE_GUARD) {
      choose(index, false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const entry = active === null ? undefined : entries[active];
    switch (event.key) {
      case 'ArrowDown':
        highlight(step(entries, active, 1));
        break;
      case 'ArrowUp':
        highlight(step(entries, active, -1));
        break;
      case 'Home':
        highlight(step(entries, null, 1));
        break;
      case 'End':
        highlight(step(entries, null, -1));
        break;
      case 'ArrowRight':
        if (active !== null && entry?.kind === 'submenu' && !entry.disabled) {
          openSubmenu(active, true);
        }
        break;
      case 'ArrowLeft':
        onBack?.();
        break;
      case 'Enter':
      case ' ':
        if (active !== null) {
          choose(active, true);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const openEntry = open ? entries[open.index] : undefined;

  return (
    <>
      <div
        ref={panelRef}
        role="menu"
        aria-orientation="vertical"
        aria-labelledby={labelledBy}
        aria-activedescendant={active === null ? undefined : `${baseId}-${active}`}
        tabIndex={-1}
        className={cx(styles.panel, !position && styles.measuring)}
        style={position ? { left: position.x, top: position.y } : undefined}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        {entries.map((entry, index) =>
          entry.kind === 'separator' ? (
            <div key={entry.id} role="separator" className={styles.separator} />
          ) : (
            <div
              key={entry.id}
              id={`${baseId}-${index}`}
              role="menuitem"
              data-menu-index={index}
              aria-disabled={entry.disabled || undefined}
              aria-haspopup={entry.kind === 'submenu' ? 'menu' : undefined}
              aria-expanded={entry.kind === 'submenu' ? open?.index === index : undefined}
              className={cx(
                styles.item,
                active === index && styles.active,
                entry.disabled && styles.disabled,
                blinkingId === entry.id && styles.blink,
              )}
              onClick={() => choose(index, false)}
              onPointerUp={(event) => onItemPointerUp(event, index)}
            >
              <span className={styles.label}>{entry.label}</span>
              {entry.kind === 'submenu' ? <Icon name="chevron-right" size={16} className={styles.chevron} /> : null}
            </div>
          ),
        )}
      </div>
      {open && openEntry?.kind === 'submenu' ? (
        <MenuPanel
          key={`${open.index}:${open.seq}`}
          entries={openEntry.entries}
          anchor={open.anchor}
          panelRef={subRef}
          byKeyboard={open.byKeyboard}
          labelledBy={`${baseId}-${open.index}`}
          blinkingId={blinkingId}
          openedAt={openedAt}
          onSelect={onSelect}
          onBack={closeSubmenu}
        />
      ) : null}
    </>
  );
};
