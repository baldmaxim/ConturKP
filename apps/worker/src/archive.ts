// Разбор ZIP (A38): имена проверяются до распаковки; ссылки, шифрование, выход за корень
// отклоняются; размер считается по фактически распакованным байтам, а не по заголовку.
// Вложенные архивы не распаковываются. Имена без флага UTF-8 декодируются как CP866
// (архивы, созданные в русской Windows).
import type { Readable } from 'node:stream';
import { safeRelativePath } from '@kontur/core';
import yauzl from 'yauzl';

export type ArchiveEntry =
  | { kind: 'file'; memberPath: string; declaredSize: number; compressedSize: number; open: () => Promise<Readable> }
  | { kind: 'rejected'; memberPath: string; reason: 'path_traversal' | 'type_not_allowed' | 'corrupt'; detail: string };

const decodeName = (raw: Buffer, flags: number): string =>
  (flags & 0x800) !== 0 ? raw.toString('utf8') : new TextDecoder('ibm866').decode(raw);

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export class ArchiveOpenError extends Error {}

// Итерирует элементы центрального каталога; обработка каждого — в onEntry (последовательно).
export const readZip = async (path: string, onEntry: (e: ArchiveEntry) => Promise<'continue' | 'stop'>): Promise<void> => {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, autoClose: true }, (err, z) =>
      err || !z ? reject(new ArchiveOpenError(err?.message ?? 'не удалось открыть архив')) : resolve(z),
    );
  });
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const done = (err?: Error): void => {
      if (finished) return;
      finished = true;
      zip.close();
      if (err) reject(err);
      else resolve();
    };
    zip.on('error', (err: Error) => done(new ArchiveOpenError(err.message)));
    zip.on('end', () => done());
    zip.on('entry', (entry: yauzl.Entry) => {
      const rawName = entry.fileName as unknown as Buffer;
      const name = decodeName(rawName, entry.generalPurposeBitFlag);
      const handle = async (): Promise<'continue' | 'stop'> => {
        if (name.endsWith('/') || name.endsWith('\\')) return 'continue';
        const safe = safeRelativePath(name);
        if (!safe.ok) return onEntry({ kind: 'rejected', memberPath: name, reason: 'path_traversal', detail: safe.detail });
        const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
        if (mode === S_IFLNK) return onEntry({ kind: 'rejected', memberPath: safe.path, reason: 'path_traversal', detail: 'символическая ссылка' });
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          return onEntry({ kind: 'rejected', memberPath: safe.path, reason: 'type_not_allowed', detail: 'зашифрованный элемент' });
        }
        return onEntry({
          kind: 'file',
          memberPath: safe.path,
          declaredSize: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          open: () =>
            new Promise<Readable>((res, rej) => {
              zip.openReadStream(entry, (err, stream) => (err || !stream ? rej(err ?? new Error('нет потока')) : res(stream)));
            }),
        });
      };
      handle().then(
        (next) => (next === 'stop' ? done() : zip.readEntry()),
        (err: unknown) => done(err instanceof Error ? err : new Error(String(err))),
      );
    });
    zip.readEntry();
  });
};
