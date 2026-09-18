import { useSyncExternalStore } from 'react';
import { getThemeMode, setThemeMode, subscribeThemeMode, type TThemeMode } from './themeStore';

export const useThemeMode = (): [TThemeMode, (mode: TThemeMode) => void] => {
  const mode = useSyncExternalStore(subscribeThemeMode, getThemeMode, getThemeMode);
  return [mode, setThemeMode];
};
