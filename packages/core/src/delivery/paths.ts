// Пути размещения (этап 14; D-034; проект §6; A38). Корень и служебная папка — абсолютные пути (UNC, буква диска или
// POSIX); сегменты папки выпуска и путей файлов — по правилам, общим для Windows и сетевых ресурсов. Имена из данных
// (код тендера) очищаются; пути файлов из манифеста не переименовываются — недопустимый путь отказывает размещение.

export const DELIVERY_SEGMENT_MAX = 120;
export const DELIVERY_REL_MAX = 240;
export const DELIVERY_ROOT_MAX = 400;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FORBIDDEN = /[/\\:*?"<>|]/;
const hasControl = (s: string): boolean => [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

// Проблема сегмента или null.
export const segmentProblem = (seg: string): string | null => {
  if (seg.length === 0) return 'пустое имя';
  if (seg === '.' || seg === '..') return `недопустимое имя «${seg}»`;
  if (seg.length > DELIVERY_SEGMENT_MAX) return `имя длиннее ${DELIVERY_SEGMENT_MAX} знаков`;
  if (hasControl(seg)) return 'управляющий символ в имени';
  if (FORBIDDEN.test(seg)) return 'недопустимый символ в имени';
  if (seg !== seg.trim()) return 'пробел в начале или в конце имени';
  if (seg.endsWith('.')) return 'точка в конце имени';
  if (RESERVED.test(seg)) return 'зарезервированное имя Windows';
  return null;
};

// Путь относительно корня (разделитель «/»): проблема или null.
export const relativePathProblem = (rel: string): string | null => {
  if (rel.length === 0) return 'пустой путь';
  if (rel.length > DELIVERY_REL_MAX) return `путь длиннее ${DELIVERY_REL_MAX} знаков`;
  if (rel.includes('\\')) return 'обратная косая черта в пути';
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return 'абсолютный путь';
  for (const seg of rel.split('/')) {
    const p = segmentProblem(seg);
    if (p) return p;
  }
  return null;
};

// Очистка имени из данных: запрещённое — «_», крайние пробелы и конечные точки — прочь, зарезервированное — с «_».
export const sanitizeSegment = (raw: string, fallback: string): string => {
  let s = [...raw.normalize('NFC')].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f || FORBIDDEN.test(ch) ? '_' : ch)).join('');
  s = s.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (s === '' || s === '.' || s === '..') s = fallback;
  // Обрезка по кодовым точкам (не разрывая суррогатную пару) до предела в единицах UTF-16.
  while (s.length > DELIVERY_SEGMENT_MAX) s = [...s].slice(0, -1).join('');
  s = s.replace(/[. ]+$/, '');
  if (s === '') s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
};

// Папка выпуска относительно корня (D-034 В-14-4): <код тендера>/Этап <N>/Выпуск <№ комплекта> <8 знаков ID>.
export const releaseFolderPath = (p: { tenderCode: string; stageSeq: number; candidateSeq: number; releaseId: string }): string =>
  [sanitizeSegment(p.tenderCode, 'Тендер'), `Этап ${p.stageSeq}`, `Выпуск ${p.candidateSeq} ${p.releaseId.replace(/-/g, '').slice(0, 8)}`].join('/');

type RootStyle = 'unc' | 'drive' | 'posix';

const rootStyle = (p: string): RootStyle | null => {
  if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(p)) return 'unc';
  if (/^[a-zA-Z]:[\\/]/.test(p)) return 'drive';
  if (p.startsWith('/')) return 'posix';
  return null;
};

// Абсолютный путь корня или служебной папки: проблема или null.
export const rootPathProblem = (p: string): string | null => {
  if (p.length === 0 || p.length > DELIVERY_ROOT_MAX) return 'пустой или слишком длинный путь';
  if (hasControl(p)) return 'управляющий символ в пути';
  const style = rootStyle(p);
  if (!style) return 'путь не абсолютный: нужен UNC (\\\\сервер\\ресурс\\…), буква диска (X:\\…) или /…';
  const body = style === 'unc' ? p.slice(2) : style === 'drive' ? p.slice(3) : p.slice(1);
  for (const seg of body.split(/[\\/]/).filter((s) => s !== '')) {
    if (seg === '.' || seg === '..') return 'сегмент «.» или «..» в пути';
    if (style !== 'posix' && /[*?"<>|:]/.test(seg)) return 'недопустимый символ в пути';
  }
  return null;
};

// Нормализованная форма пути для сравнения вложенности: «/» как разделитель, без хвостового «/»; у путей Windows —
// без учёта регистра.
const normalizeForCompare = (p: string): string => {
  const style = rootStyle(p);
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (style === 'unc') s = `/${s}`;
  return style === 'posix' ? s : s.toLowerCase();
};

// child лежит внутри parent (или совпадает с ним).
export const isPathInside = (child: string, parent: string): boolean => {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  return c === p || c.startsWith(`${p}/`);
};
