// Разрешённые типы файлов (A38): тип определяется по сигнатуре содержимого и сверяется
// с расширением. Исполняемые файлы, скрипты, SVG и неподдерживаемые архивы отклоняются.

export type FileVerdict =
  | { kind: 'document'; mediaType: string }
  | { kind: 'archive'; mediaType: 'application/zip' }
  | { kind: 'rejected'; reason: 'type_not_allowed' | 'corrupt'; detail: string };

const startsWith = (head: Buffer, bytes: number[]): boolean => bytes.every((b, i) => head[i] === b);
const ascii = (head: Buffer, text: string): boolean => head.subarray(0, text.length).toString('latin1') === text;

export const extensionOf = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
};

const ZIP_DOCUMENTS: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

const OLE_DOCUMENTS: Record<string, string> = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  msg: 'application/vnd.ms-outlook',
};

// Текстовые форматы без сигнатуры: проверяется отсутствие нулевых байтов в начале файла.
const TEXT_DOCUMENTS: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  eml: 'message/rfc822',
};

const IMAGES: { ext: string[]; magic: number[]; mediaType: string }[] = [
  { ext: ['png'], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mediaType: 'image/png' },
  { ext: ['jpg', 'jpeg'], magic: [0xff, 0xd8, 0xff], mediaType: 'image/jpeg' },
  { ext: ['tif', 'tiff'], magic: [0x49, 0x49, 0x2a, 0x00], mediaType: 'image/tiff' },
  { ext: ['tif', 'tiff'], magic: [0x4d, 0x4d, 0x00, 0x2a], mediaType: 'image/tiff' },
  { ext: ['bmp'], magic: [0x42, 0x4d], mediaType: 'image/bmp' },
];

const FORBIDDEN_EXT = new Set(['exe', 'dll', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'msi', 'scr', 'lnk', 'svg', 'hta', 'jar', 'sh']);

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06];

const reject = (reason: 'type_not_allowed' | 'corrupt', detail: string): FileVerdict => ({ kind: 'rejected', reason, detail });

// head — первые байты файла (не меньше 16, если файл длиннее), size — полный размер.
export const classifyFile = (name: string, head: Buffer, size: number): FileVerdict => {
  const ext = extensionOf(name);
  if (size === 0) return reject('corrupt', 'пустой файл');
  if (FORBIDDEN_EXT.has(ext)) return reject('type_not_allowed', `тип .${ext} запрещён`);
  if (startsWith(head, [0x4d, 0x5a])) return reject('type_not_allowed', 'исполняемый файл');
  if (ascii(head, 'Rar!') || startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return reject('type_not_allowed', 'архив RAR/7z не поддерживается; поддерживается ZIP');
  }
  if (ascii(head, '%PDF-')) {
    return ext === 'pdf' ? { kind: 'document', mediaType: 'application/pdf' } : reject('type_not_allowed', `PDF с расширением .${ext || '—'}`);
  }
  if (ext === 'pdf') return reject('corrupt', 'файл .pdf без сигнатуры PDF');
  if (startsWith(head, ZIP_MAGIC) || startsWith(head, ZIP_EMPTY_MAGIC)) {
    if (ext === 'zip') return { kind: 'archive', mediaType: 'application/zip' };
    const doc = ZIP_DOCUMENTS[ext];
    return doc ? { kind: 'document', mediaType: doc } : reject('type_not_allowed', `ZIP-контейнер с расширением .${ext || '—'}`);
  }
  if (ext === 'zip' || ZIP_DOCUMENTS[ext]) return reject('corrupt', `файл .${ext} без сигнатуры ZIP`);
  if (startsWith(head, OLE_MAGIC)) {
    const doc = OLE_DOCUMENTS[ext];
    return doc ? { kind: 'document', mediaType: doc } : reject('type_not_allowed', `OLE-контейнер с расширением .${ext || '—'}`);
  }
  if (OLE_DOCUMENTS[ext]) return reject('corrupt', `файл .${ext} без сигнатуры OLE`);
  if (ascii(head, '{\\rtf')) return ext === 'rtf' ? { kind: 'document', mediaType: 'application/rtf' } : reject('type_not_allowed', 'RTF с другим расширением');
  if (ascii(head, 'AC10') && ext === 'dwg') return { kind: 'document', mediaType: 'image/vnd.dwg' };
  for (const img of IMAGES) {
    if (startsWith(head, img.magic)) {
      return img.ext.includes(ext) ? { kind: 'document', mediaType: img.mediaType } : reject('type_not_allowed', `изображение с расширением .${ext || '—'}`);
    }
  }
  const text = TEXT_DOCUMENTS[ext];
  if (text) {
    return head.includes(0) ? reject('corrupt', `.${ext} содержит двоичные данные`) : { kind: 'document', mediaType: text };
  }
  return reject('type_not_allowed', ext ? `тип .${ext} не поддерживается` : 'файл без расширения');
};

// HTML и изображения выдаются без исполнения активного содержимого (A38): см. заголовки выдачи.
export const isActiveContentType = (mediaType: string): boolean => mediaType === 'text/html' || mediaType === 'message/rfc822' || mediaType === 'application/xml';
