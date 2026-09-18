import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom';

type TStartViewTransition = (callback: () => void) => unknown;

const reducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** Обновляет DOM внутри View Transition, если браузер умеет; иначе — без анимации. */
export const withViewTransition = (update: () => void): void => {
  const start = (document as Document & { startViewTransition?: TStartViewTransition }).startViewTransition;
  if (typeof start !== 'function' || reducedMotion()) {
    update();
    return;
  }
  start.call(document, () => flushSync(update));
};

/** navigate() с кросс-фейдом страниц через View Transitions API. */
export const useAppNavigate = (): ((to: To, options?: NavigateOptions) => void) => {
  const navigate = useNavigate();
  return useCallback(
    (to: To, options?: NavigateOptions) => withViewTransition(() => void navigate(to, options)),
    [navigate],
  );
};
