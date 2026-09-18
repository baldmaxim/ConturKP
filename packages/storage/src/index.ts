// Хранилище оригиналов по содержимому (ADR-003): sha256/<2>/<2>/<хэш>, запись без перезаписи.
// Поток пишется во временный файл того же тома с подсчётом SHA-256 и размера, затем fsync
// и создание целевого имени жёсткой ссылкой: link не заменяет существующий файл (EEXIST —
// то же содержимое уже есть, дедупликация). Файл получает атрибут «только чтение».
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { chmod, link, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

export const HEAD_BYTES = 64;

export interface IStoredBlob {
  sha256: string;
  sizeBytes: number;
  storageKey: string;
  created: boolean;
  head: Buffer;
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

export class BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  pathOf(sha256: string): string {
    return join(this.root, ...storageKeyOf(sha256).split('/'));
  }

  // Путь принадлежит хранилищу (для исключения из сканирования наблюдаемых папок).
  contains(path: string): boolean {
    const p = resolve(path);
    return p === this.root || p.startsWith(this.root + sep);
  }

  async ensureDirs(): Promise<void> {
    await mkdir(join(this.root, 'sha256'), { recursive: true });
    await mkdir(join(this.root, 'tmp'), { recursive: true });
    await mkdir(join(this.root, 'derived'), { recursive: true });
  }

  // При старте процесса: каталоги и очистка временных файлов старше суток (ADR-003 §3).
  async init(): Promise<void> {
    await this.ensureDirs();
    const now = Date.now();
    for (const name of await readdir(join(this.root, 'tmp'))) {
      const p = join(this.root, 'tmp', name);
      const s = await stat(p).catch(() => null);
      if (s && now - s.mtimeMs > TMP_MAX_AGE_MS) await rm(p, { force: true });
    }
  }

  // destroyOnLimit = false — источник не разрушается при превышении лимита (HTTP-запрос дочитывается
  // вызывающим, чтобы клиент получил ответ 413, а не обрыв соединения).
  async putStream(source: Readable, maxBytes: number, destroyOnLimit = true): Promise<IStoredBlob> {
    const tmp = join(this.root, 'tmp', `${randomUUID()}.part`);
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
      const existing = await stat(target);
      if (existing.size !== size) {
        await rm(tmp, { force: true });
        throw new Error(`хранилище повреждено: ${sha256} другого размера`);
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
