import { useEffect, useRef } from 'react';

/**
 * Вызывает tick каждые intervalMs, пока active = true и вкладка браузера видима.
 * Останавливается при размонтировании (уход со страницы) и при active = false.
 */
export const usePolling = (active: boolean, tick: () => void, intervalMs = 3000): void => {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        tickRef.current();
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
};
