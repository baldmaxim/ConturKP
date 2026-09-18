// Выбор темы: 'system' | 'light' | 'dark' (BRAND.md §11). Хранится в localStorage под 'kontur-kp:theme'.

export type TThemeMode = 'system' | 'light' | 'dark';
export type TResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'kontur-kp:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const readStored = (): TThemeMode => {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
};

const systemTheme = (): TResolvedTheme => {
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

let mode: TThemeMode = readStored();
const listeners = new Set<() => void>();

/** Ставит data-theme на <html> и синхронизирует <meta name="theme-color"> с --surface темы. */
const applyTheme = (): void => {
  const resolved: TResolvedTheme = mode === 'system' ? systemTheme() : mode;
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  const surface = getComputedStyle(root).getPropertyValue('--surface').trim();
  if (surface) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);
  }
};

export const getThemeMode = (): TThemeMode => mode;

export const setThemeMode = (next: TThemeMode): void => {
  mode = next;
  try {
    if (next === 'system') {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  } catch {
    // Хранилище недоступно (приватный режим) — выбор действует до перезагрузки.
  }
  applyTheme();
  listeners.forEach((listener) => listener());
};

export const subscribeThemeMode = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Следит за системной темой, пока выбран режим «Системная». Возвращает отписку. */
export const watchSystemTheme = (): (() => void) => {
  applyTheme();
  let media: MediaQueryList;
  try {
    media = window.matchMedia(DARK_QUERY);
  } catch {
    return () => undefined;
  }
  const onChange = (): void => {
    if (mode === 'system') {
      applyTheme();
    }
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};
