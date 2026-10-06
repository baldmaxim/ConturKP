// Пакеты OOXML для генерации файлов выпуска (этап 12; ADR-013): определение формата по содержимому, безопасное
// открытие (пределы размера и числа частей), текст абзацев DOCX и ячеек XLSX, детерминированная запись ZIP.
import PizZip from 'pizzip';

export type OfficeFormat = 'docx' | 'xlsx' | 'doc' | 'pdf';

export class OfficeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const MEDIA_TYPES: Record<OfficeFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  pdf: 'application/pdf',
};

const MAX_PARTS = 5000;
const MAX_UNZIPPED = 256 * 1024 * 1024;

export const openPackage = (bytes: Buffer): PizZip => {
  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch (err) {
    throw new OfficeError('package_unreadable', `файл не открывается как пакет OOXML: ${(err as Error).message.slice(0, 200)}`);
  }
  const files = Object.values(zip.files);
  if (files.length > MAX_PARTS) throw new OfficeError('package_too_large', `частей пакета больше ${MAX_PARTS}`);
  const total = files.reduce((s, f) => s + (f._data?.uncompressedSize ?? 0), 0);
  if (total > MAX_UNZIPPED) throw new OfficeError('package_too_large', 'распакованный пакет больше 256 МБ');
  return zip;
};

// Формат по содержимому, а не по имени: PDF — сигнатура, DOC — составной файл OLE, DOCX/XLSX — главная часть пакета.
export const detectFormat = (bytes: Buffer): OfficeFormat | null => {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'doc';
  if (bytes.subarray(0, 2).toString('latin1') !== 'PK') return null;
  let types: string;
  try {
    types = openPackage(bytes).file('[Content_Types].xml')?.asText() ?? '';
  } catch {
    return null;
  }
  if (types.includes('wordprocessingml.document.main+xml')) return 'docx';
  if (types.includes('spreadsheetml.sheet.main+xml')) return 'xlsx';
  return null;
};

export const decodeXml = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/gu, (_, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );

export const encodeXml = (s: string): string => s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

// Части DOCX с текстом, которые обрабатывает генератор: тело, колонтитулы, сноски.
export const docxTextParts = (zip: PizZip): string[] =>
  Object.keys(zip.files)
    .filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/u.test(n))
    .sort();

// Абзацы части DOCX: текст всех w:t абзаца подряд (плейсхолдер может быть разорван Word на несколько фрагментов).
export const docxParagraphTexts = (xml: string): string[] =>
  [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/gu)].map((p) => [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map((t) => decodeXml(t[1]!)).join(''));

export const DOCX_PART_TITLE = (part: string): string =>
  part === 'word/document.xml' ? 'текст' : part.includes('header') ? 'верхний колонтитул' : part.includes('footer') ? 'нижний колонтитул' : 'сноски';

// Общие строки XLSX: индекс → текст (все фрагменты r/t подряд).
export const sharedStrings = (zip: PizZip): string[] => {
  const xml = zip.file('xl/sharedStrings.xml')?.asText() ?? '';
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/gu)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((t) => decodeXml(t[1]!)).join(''));
};

export interface ISheetRef {
  name: string;
  part: string;
}

// Листы книги в порядке книги с частями пакета (по связям workbook.xml.rels).
export const sheets = (zip: PizZip): ISheetRef[] => {
  const wb = zip.file('xl/workbook.xml')?.asText() ?? '';
  const rels = zip.file('xl/_rels/workbook.xml.rels')?.asText() ?? '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/gu)].map((m) => [/Id="([^"]+)"/u.exec(m[0])?.[1] ?? '', /Target="([^"]+)"/u.exec(m[0])?.[1] ?? '']));
  return [...wb.matchAll(/<sheet\b[^>]*\/?>/gu)].map((m) => {
    const name = decodeXml(/name="([^"]*)"/u.exec(m[0])?.[1] ?? '');
    const rid = /r:id="([^"]+)"/u.exec(m[0])?.[1] ?? '';
    const t = (target.get(rid) ?? '').replace(/^\/?xl\//u, '').replace(/^\//u, '');
    return { name, part: `xl/${t}` };
  });
};

export interface ICellText {
  sheet: string;
  part: string;
  ref: string;
  text: string;
  style: number | null;
  shared: number | null;
}

// Ячейки листов с текстом (общие строки и строки внутри ячейки).
export const cellTexts = (zip: PizZip): ICellText[] => {
  const sst = sharedStrings(zip);
  const out: ICellText[] = [];
  for (const sh of sheets(zip)) {
    const xml = zip.file(sh.part)?.asText() ?? '';
    for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const attrs = m[1] ?? '';
      const ref = /\br="([A-Z]+\d+)"/u.exec(attrs)?.[1] ?? '';
      const style = /\bs="(\d+)"/u.exec(attrs)?.[1];
      const type = /\bt="([a-zA-Z]+)"/u.exec(attrs)?.[1];
      const body = m[2] ?? '';
      if (type === 's') {
        const idx = Number(/<v>(\d+)<\/v>/u.exec(body)?.[1] ?? NaN);
        if (Number.isInteger(idx) && sst[idx] !== undefined) out.push({ sheet: sh.name, part: sh.part, ref, text: sst[idx]!, style: style ? Number(style) : null, shared: idx });
      } else if (type === 'inlineStr') {
        const text = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((t) => decodeXml(t[1]!)).join('');
        out.push({ sheet: sh.name, part: sh.part, ref, text, style: style ? Number(style) : null, shared: null });
      } else if (/<v>[\s\S]*?<\/v>/u.test(body)) {
        out.push({ sheet: sh.name, part: sh.part, ref, text: decodeXml(/<v>([\s\S]*?)<\/v>/u.exec(body)![1]!), style: style ? Number(style) : null, shared: null });
      }
    }
  }
  return out;
};

// Детерминированная запись: одинаковые части — одинаковые байты (дата записи — константа в локальном времени ZIP).
export const writePackage = (zip: PizZip): Buffer => {
  const fixed = new Date(1980, 0, 1, 0, 0, 0);
  for (const f of Object.values(zip.files)) f.date = fixed;
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
};
