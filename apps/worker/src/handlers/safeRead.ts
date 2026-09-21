// Безопасное чтение файла наблюдаемой папки (R03-07).
// Между обходом каталога и чтением путь можно подменить ссылкой или точкой повторного разбора
// на объект вне разрешённого корня. Поэтому непосредственно перед чтением путь проверяется
// заново, файл открывается один раз, и дальше читается именно этот дескриптор, а не путь.
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export class UnsafeSourceError extends Error {}
export class SourceChangedError extends Error {}

export interface IExpectedFile {
  size: number;
  mtimeMs: number;
}

export interface IVerifiedFile {
  handle: FileHandle;
  size: number;
  mtimeMs: number;
}

// Только для тестов гонки: выполняется между проверкой пути и открытием файла.
export interface IOpenHooks {
  beforeOpen?: () => Promise<void>;
}

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export const openVerifiedFile = async (
  abs: string,
  canonicalRoot: string,
  expected: IExpectedFile,
  hooks?: IOpenHooks,
): Promise<IVerifiedFile> => {
  const before = await lstat(abs);
  if (before.isSymbolicLink()) throw new UnsafeSourceError('путь является ссылкой');
  await hooks?.beforeOpen?.();
  const handle = await open(abs, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new UnsafeSourceError('открыт не обычный файл');
    // Физический путь проверяется после открытия: подмена каталога ссылкой видна именно здесь.
    const real = await realpath(abs);
    if (!inside(resolve(real), resolve(canonicalRoot))) {
      throw new UnsafeSourceError('физический путь файла вне разрешённого корня');
    }
    const after = await lstat(abs);
    if (after.isSymbolicLink()) throw new UnsafeSourceError('путь подменён ссылкой');
    if (opened.ino !== 0 && after.ino !== 0 && opened.ino !== after.ino) {
      throw new UnsafeSourceError('путь указывает на другой объект');
    }
    if (opened.size !== expected.size || Math.trunc(opened.mtimeMs) !== expected.mtimeMs) {
      throw new SourceChangedError('файл изменился между обходом и чтением');
    }
    return { handle, size: opened.size, mtimeMs: Math.trunc(opened.mtimeMs) };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
};

// Проверка после чтения — по тому же дескриптору: файл не менялся во время копирования.
export const assertUnchanged = async (file: IVerifiedFile, copiedBytes: number): Promise<void> => {
  const st = await file.handle.stat();
  if (st.size !== file.size || Math.trunc(st.mtimeMs) !== file.mtimeMs || copiedBytes !== file.size) {
    throw new SourceChangedError('файл изменился во время чтения');
  }
};
