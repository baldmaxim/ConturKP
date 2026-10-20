import { useEffect, useMemo, useRef, useState, type FC, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { reducedMotion } from '../hooks/useAppNavigate';
import { cx } from '../utils/cx';
import type { IPoint } from '../utils/menuAim';
import { MenuPanel, type TMenuAnchor } from './MenuPanel';
import type { IMenuAction, TMenuEntry } from './menuTypes';
import styles from './ContextMenu.module.css';

/** Мигание выбранного пункта перед закрытием, как в macOS (= --duration-base). */
const BLINK_MS = 200;

interface IContextMenuProps {
  /** Точка щелчка в координатах окна (clientX / clientY). */
  point: IPoint;
  entries: TMenuEntry[];
  onClose: () => void;
}

const stopNativeMenu = (event: MouseEvent): void => {
  event.preventDefault();
  event.stopPropagation();
};

/**
 * Контекстное меню по правой кнопке в духе macOS: подменю по наведению с «невидимым треугольником»,
 * стрелки / Enter / Esc, выбор отпусканием правой кнопки, мигание выбранного пункта.
 * Закрывается щелчком вне меню, прокруткой, сменой размера и уходом из окна.
 */
export const ContextMenu: FC<IContextMenuProps> = ({ point, entries, onClose }) => {
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [openedAt] = useState(() => performance.now());
  const [blinkingId, setBlinkingId] = useState<string | null>(null);
  const blinkTimer = useRef<number | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const anchor = useMemo<TMenuAnchor>(() => ({ kind: 'point', point }), [point]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (): void => onCloseRef.current();
    const outside = (event: Event): boolean => !(event.target instanceof Node && layerRef.current?.contains(event.target));
    const onPointerDown = (event: PointerEvent): void => {
      if (outside(event)) {
        close();
      }
    };
    const onScroll = (event: Event): void => {
      if (outside(event)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.clearTimeout(blinkTimer.current);
      if (previous?.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  const select = (entry: IMenuAction): void => {
    if (blinkingId !== null) {
      return;
    }
    // Действие — сразу, в обработчике щелчка: буфер обмена и новая вкладка требуют жеста пользователя.
    entry.onSelect();
    if (reducedMotion()) {
      onCloseRef.current();
      return;
    }
    setBlinkingId(entry.id);
    blinkTimer.current = window.setTimeout(() => onCloseRef.current(), BLINK_MS);
  };

  return createPortal(
    <div ref={layerRef} className={cx(styles.layer, blinkingId !== null && styles.locked)} onContextMenu={stopNativeMenu}>
      <MenuPanel
        entries={entries}
        anchor={anchor}
        panelRef={panelRef}
        byKeyboard={false}
        blinkingId={blinkingId}
        openedAt={openedAt}
        onSelect={select}
      />
    </div>,
    document.body,
  );
};
