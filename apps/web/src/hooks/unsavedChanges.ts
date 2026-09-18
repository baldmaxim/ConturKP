import { useEffect, useId, useSyncExternalStore } from 'react';

// Реестр несохранённых форм: баннер обновления не предлагает перезагрузку, пока есть правки (BRAND.md §9.8).

const dirtyForms = new Set<string>();
const listeners = new Set<() => void>();

const notify = (): void => listeners.forEach((listener) => listener());

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const hasDirty = (): boolean => dirtyForms.size > 0;

/** Регистрирует форму как несохранённую, пока dirty = true. */
export const useUnsavedChanges = (dirty: boolean): void => {
  const id = useId();
  useEffect(() => {
    if (!dirty) {
      return undefined;
    }
    dirtyForms.add(id);
    notify();
    return () => {
      dirtyForms.delete(id);
      notify();
    };
  }, [dirty, id]);
};

export const useHasUnsavedChanges = (): boolean => useSyncExternalStore(subscribe, hasDirty, hasDirty);
