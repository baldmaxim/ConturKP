// Файловая часть резервной копии (этап 17, ADR-011 §7–11, проект §4): файлы хранилища по перечню снимка, манифест,
// сверка и восстановление в чистый каталог. Только node:fs внутри @kontur/storage (правило A38).
// Каталог копии: <BACKUP_ROOT>/kontur-<UTC>/ с db.dump, files/sha256/… и manifest.json — манифест пишется последним
// и атомарно, его наличие означает «копия завершена». Копия ничего не удаляет и не перезаписывает.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path, { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { retryTransientRename } from './deliveryFs.ts';
import { physicalPath } from './index.ts';

export const BACKUP_FORMAT = 'kontur.backup.v1';
export const MANIFEST_NAME = 'manifest.json';
export const DUMP_NAME = 'db.dump';

export interface IBackupFile {
  sha256: string;
  sizeBytes: number;
  storageKey: string;
}

export interface IBackupManifest {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  finishedAt: string;
  host: string;
  build: string | null;
  // Роль, снявшая копию: kontur_backup; kontur_migrator — только копия перед первым обновлением на этап 17.
  role: string;
  schema: { version: number; migrations: number };
  server: { versionNum: number };
  dump: { file: string; sizeBytes: number; sha256: string; tool: string; excludedTableData: string[] };
  files: { count: number; totalBytes: number; listSha256: string; copied: number; linked: number };
  blobs: Array<[string, number]>;
}

export class BackupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const KEY_RE = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/u;

// Ключ хранилища из БД проверяется до обращения к файлу: только форма sha256/<2>/<2>/<хэш> с тем же хэшем — путь
// из данных копии не выходит за пределы каталога.
export const checkedKey = (f: IBackupFile): string[] => {
  const m = KEY_RE.exec(f.storageKey);
  if (!m || m[3] !== f.sha256 || m[1] !== f.sha256.slice(0, 2) || m[2] !== f.sha256.slice(2, 4)) {
    throw new BackupError('bad_storage_key', `недопустимый ключ хранилища у объекта ${f.sha256.slice(0, 12)}…`);
  }
  return f.storageKey.split('/');
};

// SHA-256 перечня: отсортированные строки «sha256 размер». Одинаков у манифеста и у восстановленной базы.
export const blobListSha256 = (files: ReadonlyArray<{ sha256: string; sizeBytes: number }>): string => {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0))) h.update(`${f.sha256} ${f.sizeBytes}\n`);
  return h.digest('hex');
};

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

const fileSha256 = async (p: string): Promise<{ sha256: string; size: number }> => {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(p)) {
    const b = chunk as Buffer;
    size += b.length;
    h.update(b);
  }
  return { sha256: h.digest('hex'), size };
};

// Путь внутри каталога (или совпадает) по правилам платформы — как у наблюдаемых папок (R08-05).
export const insidePath = (child: string, parent: string, p: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path): boolean => {
  const rel = p.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
};

const dirIdentity = async (dir: string): Promise<string | null> => {
  const st = await stat(dir, { bigint: true }).catch(() => null);
  return st === null || st.ino === 0n ? null : `${st.dev}:${st.ino}`;
};

const lineageOf = async (real: string): Promise<Set<string>> => {
  const ids = new Set<string>();
  for (let dir = real; ; dir = dirname(dir)) {
    const id = await dirIdentity(dir);
    if (id) ids.add(id);
    if (dirname(dir) === dir) return ids;
  }
};

// Каталоги пересекаются: один внутри другого по физическим путям или по идентичности каталогов (junction, 8.3, регистр).
export const pathsOverlap = async (a: string, b: string): Promise<boolean> => {
  const [pa, pb] = await Promise.all([physicalPath(a), physicalPath(b)]);
  if (insidePath(pa, pb) || insidePath(pb, pa)) return true;
  const [idA, idB] = await Promise.all([dirIdentity(pa), dirIdentity(pb)]);
  return (idB !== null && (await lineageOf(pa)).has(idB)) || (idA !== null && (await lineageOf(pb)).has(idA));
};

// Последняя завершённая копия (есть манифест) — источник жёстких ссылок для неизменных файлов.
export const latestCompleteBackup = async (backupRoot: string): Promise<string | null> => {
  const names = (await readdir(backupRoot).catch(() => [] as string[])).filter((n) => /^kontur-\d{8}T\d{6}Z$/u.test(n)).sort().reverse();
  for (const n of names) if (await exists(join(backupRoot, n, MANIFEST_NAME))) return join(backupRoot, n);
  return null;
};

export const backupDirName = (at: Date): string => `kontur-${at.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`;

// Копирование одного файла с хэшем на лету: временное имя → сверка → fsync → переименование. Только чтение — как в хранилище.
const copyVerified = async (src: string, dest: string, f: IBackupFile): Promise<void> => {
  const tmp = join(dirname(dest), `.${randomUUID()}.part`);
  const handle = await open(tmp, 'wx');
  const h = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      createReadStream(src),
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          h.update(chunk);
          handle.write(chunk).then(() => cb(), cb);
        },
      }),
    );
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new BackupError('blob_missing', `нет файла объекта ${f.sha256.slice(0, 12)}… в хранилище`);
    throw err;
  }
  await handle.close();
  if (size !== f.sizeBytes || h.digest('hex') !== f.sha256) {
    await rm(tmp, { force: true });
    throw new BackupError('blob_mismatch', `файл объекта ${f.sha256.slice(0, 12)}… не совпал с перечнем по размеру или SHA-256`);
  }
  await retryTransientRename(() => rename(tmp, dest), () => exists(dest));
  await chmod(dest, 0o444);
};

export interface ICopyResult {
  copied: number;
  linked: number;
  bytes: number;
}

// Файлы перечня снимка → <destDir>/files/sha256/…; неизменный файл прошлой копии связывается жёсткой ссылкой после
// сверки хэша, иначе копируется. Отсутствующий или несовпавший файл — отказ всей копии.
export const copyBackupFiles = async (o: { storageRoot: string; destDir: string; files: readonly IBackupFile[]; previousDir?: string | null }): Promise<ICopyResult> => {
  const root = await physicalPath(o.storageRoot);
  const result: ICopyResult = { copied: 0, linked: 0, bytes: 0 };
  for (const f of o.files) {
    const parts = checkedKey(f);
    const dest = join(o.destDir, 'files', ...parts);
    await mkdir(dirname(dest), { recursive: true });
    const prev = o.previousDir ? join(o.previousDir, 'files', ...parts) : null;
    if (prev && (await exists(prev))) {
      const got = await fileSha256(prev);
      if (got.sha256 === f.sha256 && got.size === f.sizeBytes) {
        try {
          await link(prev, dest);
          result.linked += 1;
          continue;
        } catch {
          // Другой том или файловая система без жёстких ссылок — обычная копия.
        }
      }
    }
    await copyVerified(join(root, ...parts), dest, f);
    result.copied += 1;
    result.bytes += f.sizeBytes;
  }
  return result;
};

export const writeManifest = async (dir: string, manifest: IBackupManifest): Promise<void> => {
  const tmp = join(dir, `${MANIFEST_NAME}.part`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await retryTransientRename(() => rename(tmp, join(dir, MANIFEST_NAME)), () => exists(join(dir, MANIFEST_NAME)));
};

export const readManifest = async (dir: string): Promise<IBackupManifest> => {
  const raw = await readFile(join(dir, MANIFEST_NAME), 'utf8').catch(() => {
    throw new BackupError('manifest_missing', 'в каталоге нет manifest.json: копия не завершена или каталог не тот');
  });
  const m = JSON.parse(raw) as IBackupManifest;
  if (m.format !== BACKUP_FORMAT || !Array.isArray(m.blobs) || typeof m.dump?.sha256 !== 'string') {
    throw new BackupError('manifest_invalid', `манифест не формата ${BACKUP_FORMAT}`);
  }
  const files = m.blobs.map(([sha256, sizeBytes]) => ({ sha256, sizeBytes }));
  if (blobListSha256(files) !== m.files.listSha256 || files.length !== m.files.count) {
    throw new BackupError('manifest_invalid', 'перечень файлов манифеста не совпал с его контрольной суммой');
  }
  return m;
};

export const manifestFiles = (m: IBackupManifest): IBackupFile[] =>
  m.blobs.map(([sha256, sizeBytes]) => ({ sha256, sizeBytes, storageKey: `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}` }));

export const fileDigest = fileSha256;

export interface IVerifyProblem {
  sha256: string;
  problem: 'missing' | 'size' | 'sha256';
}

// Сверка файлов копии с манифестом (SHA-256 каждого файла).
export const verifyBackupFiles = async (dir: string, m: IBackupManifest): Promise<IVerifyProblem[]> => {
  const problems: IVerifyProblem[] = [];
  for (const f of manifestFiles(m)) {
    const p = join(dir, 'files', ...checkedKey(f));
    if (!(await exists(p))) {
      problems.push({ sha256: f.sha256, problem: 'missing' });
      continue;
    }
    const got = await fileSha256(p);
    if (got.size !== f.sizeBytes) problems.push({ sha256: f.sha256, problem: 'size' });
    else if (got.sha256 !== f.sha256) problems.push({ sha256: f.sha256, problem: 'sha256' });
  }
  return problems;
};

// Восстановление файлов в пустой каталог хранилища (никогда — в рабочее): sha256/… с той же сверкой.
export const restoreBackupFiles = async (backupDir: string, m: IBackupManifest, targetRoot: string): Promise<number> => {
  await mkdir(join(targetRoot, 'sha256'), { recursive: true });
  await mkdir(join(targetRoot, 'tmp'), { recursive: true });
  await mkdir(join(targetRoot, 'derived'), { recursive: true });
  let n = 0;
  for (const f of manifestFiles(m)) {
    const parts = checkedKey(f);
    const dest = join(targetRoot, ...parts);
    await mkdir(dirname(dest), { recursive: true });
    await copyVerified(join(backupDir, 'files', ...parts), dest, f);
    n += 1;
  }
  return n;
};

// Каталог отсутствует или пуст.
export const isEmptyDir = async (dir: string): Promise<boolean> => {
  const names = await readdir(dir).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
  return names.length === 0;
};
