import type { TOfficeRole } from './officeModel.js';

type THoverSource = 'scene' | 'badge' | 'popover';

/** Переход между персонажем, ярлыком и окном — одно наведение, включая промежуток между ними. */
export const createOfficeHover = (onChange: (role: TOfficeRole | null) => void) => {
  const sources = new Map<THoverSource, TOfficeRole>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: TOfficeRole | null = null;
  const cancel = (): void => { clearTimeout(timer);timer = undefined; };
  const emit = (role: TOfficeRole | null): void => {
    if (role !== current) { current = role;onChange(role); }
  };
  return {
    set(source: THoverSource, role: TOfficeRole | null): void {
      if (role) sources.set(source, role);else sources.delete(source);
      const next = sources.get('popover') ?? sources.get('badge') ?? sources.get('scene');
      if (next) { cancel();emit(next); }
      else if (!timer) timer = setTimeout(() => { timer = undefined;emit(null); }, 250);
    },
    clear(): void { cancel();sources.clear();emit(null); },
    dispose(): void { cancel();sources.clear();current = null; },
  };
};
