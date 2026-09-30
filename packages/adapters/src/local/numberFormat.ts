// Отображение числа ячейки XLSX по коду формата. Правила детерминированы и входят в конфигурацию
// распознавателя (AD-05a-2): группы разрядов — через пробел, десятичный разделитель — запятая, дата —
// в виде ГГГГ-ММ-ДД, время — ЧЧ:ММ:СС. Формула не вычисляется: берётся сохранённое значение.
export const NUMBER_RENDERING_VERSION = 'ru-1';

// Встроенные форматы Excel (ECMA-376, часть 1, 18.8.30), которые встречаются в сметах.
const BUILTIN: Readonly<Record<number, string>> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

export const builtinFormat = (id: number): string | null => BUILTIN[id] ?? null;

interface ISection {
  prefix: string;
  suffix: string;
  pattern: string;
}

// Первая секция формата: литералы до и после числового шаблона; цвета, локали и отступы отбрасываются.
const firstSection = (code: string): ISection => {
  let prefix = '';
  let suffix = '';
  let pattern = '';
  let i = 0;
  let seenPattern = false;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === ';') break;
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      const lit = end < 0 ? code.slice(i + 1) : code.slice(i + 1, end);
      if (seenPattern) suffix += lit;
      else prefix += lit;
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < code.length) {
      if (seenPattern) suffix += code[i + 1];
      else prefix += code[i + 1];
      i += 2;
      continue;
    }
    if (ch === '[') {
      const end = code.indexOf(']', i + 1);
      const inner = end < 0 ? '' : code.slice(i + 1, end);
      if (/^(h+|m+|s+)$/i.test(inner)) pattern += inner;
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (ch === '_' || ch === '*') {
      if (ch === '_' && seenPattern) suffix += ' ';
      i += 2;
      continue;
    }
    if (/[0#?.,%Ee+\-/ yYmMdDhHsS:@]/.test(ch)) {
      if (ch === ' ' && !seenPattern) {
        prefix += ch;
      } else if (seenPattern && suffix !== '' && ch === ' ') {
        suffix += ch;
      } else {
        pattern += ch;
        seenPattern = true;
      }
      i += 1;
      continue;
    }
    if (seenPattern) suffix += ch;
    else prefix += ch;
    i += 1;
  }
  // Пробел между числом и литералом («98 500 000 руб.») сохраняется, а шаблон — без хвостовых пробелов.
  const gap = pattern.length > pattern.trimEnd().length && suffix !== '' ? ' ' : '';
  return { prefix, suffix: `${gap}${suffix}`.replace(/\s+$/, ''), pattern: pattern.trim() };
};

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

// Порядковый номер дня Excel → дата UTC. Система 1900 учитывает несуществующее 29.02.1900.
const excelDate = (serial: number, date1904: boolean): Date => {
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  const ms = Math.round((days - 25569) * 86400 * 1000);
  return new Date(ms);
};

const groupDigits = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const plainNumber = (value: number): string => {
  if (Number.isInteger(value)) return String(value);
  const s = String(Number(value.toPrecision(15)));
  return s.includes('e') ? s : s.replace('.', ',');
};

export const formatNumber = (raw: string, code: string | null, date1904: boolean): string => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  const fmt = code ?? 'General';
  if (fmt === 'General' || fmt === '@') return plainNumber(value);
  const s = firstSection(fmt);
  const p = s.pattern;
  const isDate = /[yYdD]/.test(p) || /[hHsS]/.test(p) || (/[mM]/.test(p) && !/[0#?]/.test(p));
  if (isDate) {
    const d = excelDate(value, date1904);
    const hasDate = /[yYdD]/.test(p) || (/[mM]/.test(p) && !/[hHsS:]/.test(p));
    const hasTime = /[hHsS:]/.test(p);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    return `${s.prefix}${hasDate && hasTime ? `${date} ${time}` : hasTime ? time : date}${s.suffix}`;
  }
  if (/[Ee][+-]/.test(p)) return `${s.prefix}${value.toExponential(Math.max(0, (p.split('.')[1]?.match(/[0#]/g) ?? []).length)).replace('.', ',')}${s.suffix}`;
  const percent = p.includes('%');
  const scaled = percent ? value * 100 : value;
  const decimals = (p.split('.')[1]?.match(/[0#?]/g) ?? []).length;
  const grouped = /[0#?][,\s][0#?]/.test(p);
  const abs = Math.abs(scaled).toFixed(decimals);
  const [intPart, fracPart] = abs.split('.');
  const body = `${grouped ? groupDigits(intPart ?? '0') : intPart ?? '0'}${fracPart ? `,${fracPart}` : ''}`;
  const sign = scaled < 0 && Number(abs) !== 0 ? '-' : '';
  return `${s.prefix}${sign}${body}${percent ? '%' : ''}${s.suffix}`;
};
