// Пакет OOXML (DOCX, XLSX) — ZIP с частями XML. Читаются только нужные части и только в пределах
// (A38): имена проверяются до распаковки, выход за корень, ссылки и шифрование — отказ, размер
// считается по фактически распакованным байтам, отношение сжатия ограничено (защита от zip-бомбы).
// Внешние связи (TargetMode="External") не загружаются никогда.
import { safeRelativePath } from '@kontur/core';
import yauzl from 'yauzl';
import { LocalRecognitionError, type ILocalLimits } from './types.ts';
import { decodeXmlBytes, elements, MalformedXmlError, parseXmlTree, UnsafeXmlError, type IXmlNode } from './xml.ts';

interface IPartEntry {
  entry: yauzl.Entry;
  path: string;
}

export interface IOoxmlPackage {
  // Нормализованные пути частей в нижнем регистре → исходный путь.
  has: (path: string) => boolean;
  read: (path: string) => Promise<Buffer>;
  readXml: (path: string) => Promise<IXmlNode>;
  close: () => void;
}

export interface IRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const corrupt = (detail: string): LocalRecognitionError => new LocalRecognitionError('file_corrupt', `пакет OOXML повреждён: ${detail}`);
const unsafe = (detail: string): LocalRecognitionError => new LocalRecognitionError('unsafe_package', `пакет OOXML небезопасен: ${detail}`);

export const openOoxmlPackage = async (bytes: Buffer, limits: ILocalLimits): Promise<IOoxmlPackage> => {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, autoClose: false }, (err, z) =>
      err || !z ? reject(corrupt(err?.message.slice(0, 200) ?? 'архив не открывается')) : resolve(z),
    );
  });
  const parts = new Map<string, IPartEntry>();
  await new Promise<void>((resolve, reject) => {
    zip.on('error', (err: Error) => reject(corrupt(err.message.slice(0, 200))));
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      try {
        if (parts.size >= limits.maxZipEntries) throw new LocalRecognitionError('too_large', `в пакете больше ${limits.maxZipEntries} частей`);
        const raw = entry.fileName as unknown as Buffer;
        const name = (entry.generalPurposeBitFlag & 0x800) !== 0 ? raw.toString('utf8') : raw.toString('latin1');
        if (!name.endsWith('/')) {
          const safe = safeRelativePath(name);
          if (!safe.ok) throw unsafe(`имя части выходит за корень (${safe.detail})`);
          if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) throw unsafe('часть — символическая ссылка');
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw unsafe('зашифрованная часть');
          const key = safe.path.toLowerCase();
          if (parts.has(key)) throw corrupt('две части с одним именем');
          parts.set(key, { entry, path: safe.path });
        }
        zip.readEntry();
      } catch (err) {
        zip.close();
        reject(err);
      }
    });
    zip.readEntry();
  });
  let unzipped = 0;
  const read = async (path: string): Promise<Buffer> => {
    const part = parts.get(path.toLowerCase());
    if (!part) throw corrupt(`нет части ${path}`);
    const { entry } = part;
    if (entry.uncompressedSize > limits.maxPartBytes) throw new LocalRecognitionError('too_large', `часть ${path} больше предела`);
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) {
      throw unsafe(`отношение сжатия части ${path} выше ${limits.maxCompressionRatio}`);
    }
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      zip.openReadStream(entry, (err, s) => (err || !s ? reject(corrupt(err?.message.slice(0, 200) ?? 'нет потока части')) : resolve(s)));
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      unzipped += chunk.length;
      // Фактический размер, а не заголовок: заголовок ZIP может лгать.
      if (size > limits.maxPartBytes || unzipped > limits.maxUnzippedBytes) {
        (stream as unknown as { destroy: () => void }).destroy();
        throw new LocalRecognitionError('too_large', 'распакованный объём пакета больше предела');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const readXml = async (path: string): Promise<IXmlNode> => {
    const buf = await read(path);
    try {
      return parseXmlTree(decodeXmlBytes(buf));
    } catch (err) {
      if (err instanceof UnsafeXmlError) throw unsafe(err.message);
      if (err instanceof MalformedXmlError) throw corrupt(`${path}: ${err.message}`);
      throw err;
    }
  };
  return {
    has: (path) => parts.has(path.toLowerCase()),
    read,
    readXml,
    close: () => zip.close(),
  };
};

// Разбор части в дереве с приведением ошибок к кодам отказа.
export const parsePartXml = (path: string, bytes: Buffer): IXmlNode => {
  try {
    return parseXmlTree(decodeXmlBytes(bytes));
  } catch (err) {
    if (err instanceof UnsafeXmlError) throw unsafe(err.message);
    if (err instanceof MalformedXmlError) throw corrupt(`${path}: ${err.message}`);
    throw err;
  }
};

// Путь связанной части относительно части-источника; выход за корень пакета — отказ.
export const resolvePartPath = (sourcePart: string, target: string): string => {
  const base = target.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  const segments = [...base];
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) throw unsafe('связь выходит за корень пакета');
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  return segments.join('/');
};

const relsPathOf = (part: string): string => {
  const dir = part.split('/').slice(0, -1);
  const name = part.split('/').pop() ?? '';
  return [...dir, '_rels', `${name}.rels`].filter((s) => s !== '').join('/');
};

// Связи части. Внешние связи отмечаются и никогда не загружаются.
export const readRelationships = async (pkg: IOoxmlPackage, part: string): Promise<IRelationship[]> => {
  const path = part === '' ? '_rels/.rels' : relsPathOf(part);
  if (!pkg.has(path)) return [];
  const root = await pkg.readXml(path);
  return elements(root, 'pr:Relationship').map((r) => ({
    id: r.attrs.Id ?? '',
    type: r.attrs.Type ?? '',
    target: r.attrs.Target ?? '',
    external: (r.attrs.TargetMode ?? '').toLowerCase() === 'external',
  }));
};

// Главная часть пакета по связи officeDocument; запасной путь — стандартный.
export const mainPart = async (pkg: IOoxmlPackage, fallback: string): Promise<string> => {
  const rels = await readRelationships(pkg, '');
  const main = rels.find((r) => !r.external && r.type.endsWith('/officeDocument'));
  const path = main ? resolvePartPath('', main.target) : fallback;
  if (!pkg.has(path)) throw new LocalRecognitionError('unsupported_structure', 'в пакете нет главной части документа');
  return path;
};
