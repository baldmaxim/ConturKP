// Проверка относительных путей элементов архива и наблюдаемой папки (A38):
// никакого выхода за корень, абсолютных путей, имён устройств и управляющих символов.

export type PathVerdict = { ok: true; path: string } | { ok: false; detail: string };

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const safeRelativePath = (raw: string): PathVerdict => {
  if (raw.length === 0 || raw.length > 1000) return { ok: false, detail: 'пустой или слишком длинный путь' };
  for (const ch of raw) {
    if (ch.charCodeAt(0) < 0x20) return { ok: false, detail: 'управляющий символ в имени' };
  }
  const unified = raw.replaceAll('\\', '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return { ok: false, detail: 'абсолютный путь' };
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return { ok: false, detail: 'пустой путь' };
  for (const part of parts) {
    if (part === '..') return { ok: false, detail: 'выход за корень (..)' };
    if (WINDOWS_DEVICE.test(part)) return { ok: false, detail: `имя устройства Windows: ${part}` };
    if (/[<>:"|?*]/.test(part)) return { ok: false, detail: 'недопустимый символ в имени' };
  }
  return { ok: true, path: parts.join('/') };
};

// Ключ группировки редакций по имени файла: без каталога, в нижнем регистре, пробелы схлопнуты.
export const nameKeyOf = (path: string): string =>
  (path.split('/').pop() ?? path).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
