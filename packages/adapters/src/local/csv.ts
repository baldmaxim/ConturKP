// CSV → одна логическая единица «таблица» (AD-05a-1). Фрагмент — запись; якорь — номер записи,
// столбцы, строка заголовка и физические строки файла (запись в кавычках может занимать несколько).
// Кодировка определяется строго: BOM, затем UTF-8 без ошибок, затем Windows-1251 без ошибок;
// иначе — явный отказ encoding_unsupported, а не текст с подменёнными символами. Управляющие символы
// в тексте таблицы — признак чужой кодировки или двоичных данных при любой кодировке.
// Разделитель — тот из «;», «,», табуляции, что даёт самое согласованное число столбцов.
import { splitFragmentText } from '../rdweb/import.ts';
import { normalizeLocalText, structuredUnitIssues, textMetrics } from './quality.ts';
import { LocalRecognitionError, type ILocalFragment, type ILocalLimits, type ILocalResult } from './types.ts';

interface IRecord {
  values: string[];
  lineFrom: number;
  lineTo: number;
}

const decode = (bytes: Uint8Array): { text: string; encoding: string } => {
  const strict = (label: string, data: Uint8Array): string => new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(data);
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: strict('utf-8', bytes.subarray(3)), encoding: 'utf-8-bom' };
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: strict('utf-16le', bytes.subarray(2)), encoding: 'utf-16le' };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: strict('utf-16be', bytes.subarray(2)), encoding: 'utf-16be' };
  } catch {
    throw new LocalRecognitionError('encoding_unsupported', 'кодировка CSV не совпадает с меткой BOM');
  }
  try {
    return { text: strict('utf-8', bytes), encoding: 'utf-8' };
  } catch {
    // Единственная допустимая однобайтовая кодировка — Windows-1251 (выгрузка Excel в русской Windows).
  }
  // Декодер Windows-1251 по стандарту WHATWG принимает любой байт, поэтому чужую однобайтовую
  // кодировку выдают управляющие символы C0 и C1 после декодирования: в тексте таблицы их нет.
  const text = strict('windows-1251', bytes);
  if (CONTROL.test(text)) throw new LocalRecognitionError('encoding_unsupported', 'CSV не в UTF-8 и не в Windows-1251');
  return { text, encoding: 'windows-1251' };
};

const CONTROL = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

// Разбор RFC 4180: кавычки, удвоенные кавычки, перевод строки внутри кавычек.
const parseRecords = (text: string, delimiter: string, maxRecords: number): { records: IRecord[]; unterminated: boolean } => {
  const records: IRecord[] = [];
  let values: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let recordLine = 1;
  const endField = (): void => {
    values.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = (): void => {
    endField();
    records.push({ values, lineFrom: recordLine, lineTo: line });
    values = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted && field === '') {
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      if (records.length > maxRecords) break;
      line += 1;
      recordLine = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field !== '' || values.length > 0 || quoted) endRecord();
  return { records, unterminated: quoted };
};

const DELIMITERS = [';', ',', '\t'] as const;

// Согласованность: число записей с самым частым (больше одного) числом полей среди первых 50.
const chooseDelimiter = (text: string): string | null => {
  let best: { d: string; score: number } | null = null;
  for (const d of DELIMITERS) {
    const { records } = parseRecords(text, d, 50);
    const counts = new Map<number, number>();
    for (const r of records.slice(0, 50)) if (r.values.length > 1) counts.set(r.values.length, (counts.get(r.values.length) ?? 0) + 1);
    const score = Math.max(0, ...counts.values());
    if (score > 0 && (!best || score > best.score)) best = { d, score };
  }
  return best?.d ?? null;
};

export const parseCsv = async (bytes: Buffer, limits: ILocalLimits): Promise<ILocalResult> => {
  if (bytes.length > limits.maxInputBytes) throw new LocalRecognitionError('too_large', `файл ${bytes.length} байт больше предела ${limits.maxInputBytes}`);
  const { text, encoding } = decode(bytes);
  if (text.includes('\u0000')) throw new LocalRecognitionError('file_corrupt', 'в CSV есть нулевые байты');
  if (CONTROL.test(text)) throw new LocalRecognitionError('encoding_unsupported', 'в тексте CSV есть управляющие символы: другая кодировка или двоичные данные');
  const delimiter = chooseDelimiter(text);
  const { records, unterminated } = parseRecords(text, delimiter ?? '\u0001', limits.maxCells);
  if (records.length > limits.maxCells) throw new LocalRecognitionError('too_large', 'записей CSV больше предела разбора');
  const nonEmpty = records.map((r, i) => ({ r, no: i + 1 })).filter(({ r }) => r.values.some((v) => v.trim() !== ''));
  const headerRow = nonEmpty[0]?.no ?? null;
  const fragments: ILocalFragment[] = [];
  let totalChars = 0;
  let cells = 0;
  for (const { r, no } of nonEmpty) {
    cells += r.values.length;
    if (cells > limits.maxCells) throw new LocalRecognitionError('too_large', 'ячеек CSV больше предела разбора');
    const cleaned = r.values.map((v) => v.replace(/\r\n|\r|\n/g, ' ').trim());
    const firstCol = cleaned.findIndex((v) => v !== '') + 1;
    let lastCol = cleaned.length;
    while (lastCol > 0 && cleaned[lastCol - 1] === '') lastCol -= 1;
    const body = normalizeLocalText(cleaned.slice(firstCol - 1, lastCol).join(' | '));
    totalChars += body.length;
    if (totalChars > limits.maxTotalTextChars) throw new LocalRecognitionError('too_large', 'текст CSV больше предела разбора');
    const parts = splitFragmentText(body, limits.maxFragmentChars);
    for (const [i, part] of parts.entries()) {
      fragments.push({
        unitIndex: 0,
        key: parts.length > 1 ? `r${no}#p${i + 1}` : `r${no}`,
        ordinal: fragments.length + 1,
        origin: 'document_text',
        text: part,
        locator: { kind: 'csv_rows', rowFrom: no, rowTo: no, colFrom: firstCol, colTo: lastCol, headerRow, lineFrom: r.lineFrom, lineTo: r.lineTo },
        warnings: parts.length > 1 ? ['text_split'] : [],
        partIndex: i,
        partTotal: parts.length,
      });
    }
  }
  const metrics = textMetrics(fragments.map((f) => f.text).join('\n'));
  // Незакрытая кавычка в конце — нарушена ожидаемая структура таблицы (OD-6): результат требует проверки.
  const issues = [...(unterminated ? ['unterminated_quote'] : []), ...structuredUnitIssues(metrics)].sort();
  return {
    units: [
      {
        index: 0,
        kind: 'csv_table',
        label: null,
        widthPx: null,
        heightPx: null,
        rotation: 0,
        status: fragments.length === 0 ? 'missing' : issues.length > 0 ? 'needs_review' : 'recognized',
        method: 'structured',
        metrics: { ...metrics, ocrConfidence: null, nativeChars: null },
        issues,
      },
    ],
    fragments,
    skipped: {},
    warnings: [],
    facts: { encoding, delimiter: delimiter === null ? 'none' : delimiter === '\t' ? 'tab' : delimiter, records: records.length },
  };
};
