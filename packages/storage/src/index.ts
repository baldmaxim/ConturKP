// Хранилище оригиналов по содержимому (ADR-003): sha256/<2>/<2>/<хэш>, запись без перезаписи.
// Поток пишется во временный файл того же тома с подсчётом SHA-256 и размера, затем fsync
// и создание целевого имени жёсткой ссылкой: link не заменяет существующий файл (EEXIST —
// то же содержимое уже есть, дедупликация). Файл получает атрибут «только чтение».
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { chmod, link, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

export const HEAD_BYTES = 64;

export interface IStoredBlob {
  sha256: string;
  sizeBytes: number;
  storageKey: string;
  created: boolean;
  head: Buffer;
}

// Существующий объект не совпал с ожидаемым содержимым: дальше работать с ним нельзя (ADR-003 §2).
export class StorageCorruptionError extends Error {
  readonly sha256: string;
  constructor(sha256: string, detail: string) {
    super(`хранилище повреждено: объект ${sha256} ${detail}`);
    this.sha256 = sha256;
  }
}

export class BlobLimitError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`размер превышает лимит ${limit} байт`);
    this.limit = limit;
  }
}

export const storageKeyOf = (sha256: string): string => {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('некорректный sha256');
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
};

const TMP_MAX_AGE_MS = 24 * 3600_000;

// Физический путь каталога, который может ещё не существовать: realpath ближайшего существующего предка и оставшиеся
// компоненты. Путь из конфигурации может идти через junction, символическую ссылку или короткое имя Windows (8.3);
// на Windows создание каталогов через путь с junction давало ENOENT (Review 08-4, R08-05).
export const physicalPath = async (p: string): Promise<string> => {
  const rest: string[] = [];
  for (let cur = resolve(p); ; ) {
    try {
      return join(await realpath(cur), ...rest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = dirname(cur);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === cur) throw err;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
};

export class BlobStore {
  // Путь из конфигурации — для сообщений и до инициализации.
  readonly root: string;
  // Физический корень (R03-06, R08-05): все операции хранилища после `physicalRoot()` / `ensureDirs()` идут по нему, а не
  // через junction или ссылку из конфигурации; по нему же — проверки пересечения с наблюдаемыми папками.
  private canonical: string | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  canonicalRoot(): string {
    return this.canonical ?? this.root;
  }

  // Физический корень без создания каталогов: пересечение с папкой проверяется до любой записи.
  async physicalRoot(): Promise<string> {
    this.canonical ??= await physicalPath(this.root);
    return this.canonical;
  }

  pathOf(sha256: string): string {
    return join(this.canonicalRoot(), ...storageKeyOf(sha256).split('/'));
  }

  // Путь принадлежит хранилищу (для исключения из сканирования наблюдаемых папок).
  // Сравнение — с физическим корнем, если он уже определён.
  contains(path: string): boolean {
    const p = resolve(path);
    const root = this.canonicalRoot();
    return p === root || p.startsWith(root + sep) || p === this.root || p.startsWith(this.root + sep);
  }

  // Каталоги создаются по физическому пути: ни один `mkdir` не проходит через junction или ссылку из конфигурации.
  async ensureDirs(): Promise<void> {
    const base = await this.physicalRoot();
    await mkdir(join(base, 'sha256'), { recursive: true });
    await mkdir(join(base, 'tmp'), { recursive: true });
    await mkdir(join(base, 'derived'), { recursive: true });
    this.canonical = await realpath(base);
  }

  // При старте процесса: каталоги и очистка временных файлов старше суток (ADR-003 §3).
  async init(): Promise<void> {
    await this.ensureDirs();
    const now = Date.now();
    for (const name of await readdir(join(this.canonicalRoot(), 'tmp'))) {
      const p = join(this.canonicalRoot(), 'tmp', name);
      const s = await stat(p).catch(() => null);
      if (s && now - s.mtimeMs > TMP_MAX_AGE_MS) await rm(p, { force: true });
    }
  }

  // destroyOnLimit = false — источник не разрушается при превышении лимита (HTTP-запрос дочитывается
  // вызывающим, чтобы клиент получил ответ 413, а не обрыв соединения).
  async putStream(source: Readable, maxBytes: number, destroyOnLimit = true): Promise<IStoredBlob> {
    const tmp = join(this.canonicalRoot(), 'tmp', `${randomUUID()}.part`);
    const hash = createHash('sha256');
    const handle = await open(tmp, 'wx');
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > maxBytes) {
          if (destroyOnLimit) source.destroy();
          throw new BlobLimitError(maxBytes);
        }
        if (head.length < HEAD_BYTES) head = Buffer.concat([head, buf.subarray(0, HEAD_BYTES - head.length)]);
        hash.update(buf);
        await handle.write(buf);
      }
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw err;
    }
    await handle.close();
    const sha256 = hash.digest('hex');
    const target = this.pathOf(sha256);
    await mkdir(dirname(target), { recursive: true });
    let created = true;
    try {
      await link(tmp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        await rm(tmp, { force: true });
        throw err;
      }
      created = false;
      // Объект уже есть: по ADR-003 сверяются и размер, и хэш содержимого (R03-08).
      const existing = await stat(target);
      if (existing.size !== size) {
        await rm(tmp, { force: true });
        throw new StorageCorruptionError(sha256, `имеет размер ${existing.size} вместо ${size}`);
      }
      if (!(await this.verify(sha256))) {
        await rm(tmp, { force: true });
        throw new StorageCorruptionError(sha256, 'не совпадает по SHA-256 с ожидаемым содержимым');
      }
    }
    // Жёсткая ссылка делит атрибуты с временным именем: сначала убираем его, затем «только чтение».
    await rm(tmp, { force: true });
    if (created) await chmod(target, 0o444);
    return { sha256, sizeBytes: size, storageKey: storageKeyOf(sha256), created, head };
  }

  openRead(sha256: string): ReadStream {
    return createReadStream(this.pathOf(sha256));
  }

  async exists(sha256: string): Promise<boolean> {
    return stat(this.pathOf(sha256)).then(
      () => true,
      () => false,
    );
  }

  // Пересчёт хэша файла хранилища (целостность, ADR-003 §7).
  async verify(sha256: string): Promise<boolean> {
    const hash = createHash('sha256');
    for await (const chunk of this.openRead(sha256)) hash.update(chunk as Buffer);
    return hash.digest('hex') === sha256;
  }
}
export * from './ocrModels.ts';
export * from './deliveryFs.ts';
export * from './backup.ts';
