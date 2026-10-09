// Реализация файловых операций размещения (этап 14; D-034) поверх файловой системы — для FsDeliveryTarget (@kontur/adapters).
// Перенос файла без замены — жёсткой ссылкой, как запись в хранилище: rename файла и на Windows, и на POSIX заменяет
// существующий файл.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { IDeliveryFs } from '@kontur/adapters';

const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM', 'EINVAL', 'EISDIR', 'UNKNOWN']);

// Windows: антивирус и индексатор кратко держат только что записанный файл или папку — rename отвечает EPERM, EACCES или
// EBUSY (так же поступает graceful-fs). Короткие повторы, около 2 с; если имя назначения уже занято, повтор не поможет —
// ошибка сразу (вызывающий отличает «папка выпуска уже есть»). На других системах повторов нет.
const TRANSIENT_WIN32 = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200, 250, 300, 400, 500];

export const retryTransientRename = async (
  op: () => Promise<void>,
  targetExists: () => Promise<boolean>,
  platform: NodeJS.Platform = process.platform,
  delays: readonly number[] = RENAME_RETRY_DELAYS_MS,
): Promise<void> => {
  for (let i = 0; ; i += 1) {
    try {
      await op();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (platform !== 'win32' || !TRANSIENT_WIN32.has(code) || i >= delays.length || (await targetExists())) throw err;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
};

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? false : Promise.reject(e)),
  );

const renameSafe = (from: string, to: string): Promise<void> => retryTransientRename(() => rename(from, to), () => exists(to));

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

export const nodeDeliveryFs = (): IDeliveryFs => ({
  stat: async (p) => {
    try {
      const s = await stat(p);
      return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, dev: s.dev };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  mkdir: async (p) => {
    await mkdir(p);
  },
  readdir: async (p) => readdir(p),
  writeFile: async (p, source, exclusive) => {
    const out = createWriteStream(p, { flags: exclusive ? 'wx' : 'w' });
    if (Buffer.isBuffer(source)) {
      await new Promise<void>((resolve, reject) => {
        out.on('error', reject);
        out.end(source, () => resolve());
      });
      return;
    }
    await pipeline(source, out);
  },
  hashFile: async (p) => {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(p)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return { sha256: hash.digest('hex'), size };
  },
  rename: async (from, to) => renameSafe(from, to),
  moveNoReplace: async (from, to) => {
    try {
      await link(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!LINK_UNSUPPORTED.has(code)) throw err;
      if (await exists(to)) throw Object.assign(new Error('EEXIST: имя занято'), { code: 'EEXIST' });
      await renameSafe(from, to);
      return;
    }
    await rm(from, RM);
  },
  remove: async (p) => rm(p, RM),
});
