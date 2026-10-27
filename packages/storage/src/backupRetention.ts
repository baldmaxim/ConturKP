// Retention owns only complete kontur-* backup directories. It never removes storage blobs by hash.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { BackupError, backupDirName, blobListSha256, fileDigest, pathsOverlap, readManifest, type IBackupManifest } from './backup.ts';

const POINT = /^kontur-\d{8}T\d{6}Z$/u;
const SHA = /^[a-f0-9]{64}$/u;
const LOCK = '.kontur-operations.lock';
const FORMAT = 'kontur.backup-retention.v1';
const fail = (message: string): never => { throw new BackupError('backup_retention', message); };
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

export interface IRetentionPolicy {
  format: typeof FORMAT;
  backupRoot: string;
  journalFile: string;
  daily: number;
  monthly: number;
  timeZone: 'Europe/Moscow';
  verified: { name: string; dumpSha256: string; blobListSha256: string; verifiedAt: string };
  pins: Array<{ name: string; until: string; reason: string }>;
}
export interface IRetentionPoint { name: string; createdAt: string }
export interface IRetentionSelection {
  keep: Array<IRetentionPoint & { reasons: string[] }>;
  remove: IRetentionPoint[];
}
export const retentionDay = (at: string | Date): string => {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return fail('недопустимая дата');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

export const selectRetentionPoints = (points: IRetentionPoint[], policy: Pick<IRetentionPolicy, 'daily' | 'monthly' | 'verified' | 'pins'>, now = new Date()): IRetentionSelection => {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(policy.daily) || policy.daily < 1 || policy.daily > 366 ||
      !Number.isInteger(policy.monthly) || policy.monthly < 0 || policy.monthly > 120) return fail('недопустимый срок хранения');
  const names = new Set<string>();
  for (const p of points) {
    if (names.has(p.name) || !POINT.test(p.name) || !Number.isFinite(Date.parse(p.createdAt)) || Date.parse(p.createdAt) > now.getTime()) {
      return fail(`повтор, неверное время или имя точки: ${p.name}`);
    }
    names.add(p.name);
  }
  if (!names.has(policy.verified.name)) return fail('последняя проверенная точка отсутствует');
  const sorted = [...points].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.name.localeCompare(a.name));
  const reasons = new Map<string, string[]>();
  const keep = (p: IRetentionPoint, why: string): void => { reasons.set(p.name, [...(reasons.get(p.name) ?? []), why]); };
  const days = new Set<string>();
  for (const p of sorted) {
    const day = retentionDay(p.createdAt);
    if (days.size < policy.daily && !days.has(day)) { days.add(day); keep(p, `daily:${day}`); }
  }
  const [year, month] = retentionDay(now).split('-').map(Number);
  for (let i = 1; i <= policy.monthly; i++) {
    const d = new Date(Date.UTC(year!, month! - 1 - i, 1));
    const bucket = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const p = sorted.find(p => retentionDay(p.createdAt).startsWith(bucket));
    if (p) keep(p, `monthly:${bucket}`);
  }
  keep(sorted.find(p => p.name === policy.verified.name)!, 'restore-verified');
  for (const pin of policy.pins) {
    if (!POINT.test(pin.name) || !Number.isFinite(Date.parse(pin.until)) || !pin.reason?.trim()) return fail('неверное временное закрепление');
    if (Date.parse(pin.until) <= now.getTime()) continue;
    const p = sorted.find(p => p.name === pin.name);
    if (!p) return fail(`закреплённая точка отсутствует: ${pin.name}`);
    keep(p, `pin:${pin.until}:${pin.reason}`);
  }
  return {
    keep: sorted.filter(p => reasons.has(p.name)).map(p => ({ name: p.name, createdAt: p.createdAt, reasons: reasons.get(p.name)! })),
    remove: sorted.filter(p => !reasons.has(p.name)).map(p => ({ name: p.name, createdAt: p.createdAt })),
  };
};

const physicalDirectory = async (dir: string): Promise<void> => {
  // 8.3 spellings are valid physical paths. Reject reparse ancestors rather than comparing spellings.
  for (let current = resolve(dir); ; current = dirname(current)) {
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) fail(`нужен физический каталог без junction/symlink: ${dir}`);
    if (dirname(current) === current) break;
  }
};

// No age-based lock breaking: a failed process requires an operator to check its PID before removing the lock.
export const withBackupOperation = async <T>(root: string, operation: string, action: () => Promise<T>): Promise<T> => {
  await physicalDirectory(root);
  const file = join(root, LOCK);
  const token = randomUUID();
  const h = await open(file, 'wx').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EEXIST') throw new BackupError('backup_busy', `backup/restore/очистка уже выполняется; блокировка ${file}`);
    throw err;
  });
  try {
    await h.writeFile(JSON.stringify({ token, operation, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    await h.sync();
    return await action();
  } finally {
    await h.close();
    const owner = JSON.parse(await readFile(file, 'utf8')) as { token: string };
    if (owner.token !== token) fail('владелец блокировки изменился; блокировка сохранена');
    await unlink(file);
  }
};

export const readRetentionPolicy = async (file: string): Promise<IRetentionPolicy> => {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink()) return fail('конфигурация должна быть обычным файлом');
  const p = JSON.parse(await readFile(file, 'utf8')) as IRetentionPolicy;
  if (p.format !== FORMAT || p.timeZone !== 'Europe/Moscow' || !isAbsolute(p.backupRoot ?? '') || !isAbsolute(p.journalFile ?? '') ||
      !Array.isArray(p.pins) || !p.verified || !POINT.test(p.verified.name) || !SHA.test(p.verified.dumpSha256) || !SHA.test(p.verified.blobListSha256) ||
      !Number.isFinite(Date.parse(p.verified.verifiedAt))) return fail('неверная конфигурация хранения');
  if (await pathsOverlap(p.journalFile, p.backupRoot) || await pathsOverlap(file, p.backupRoot)) return fail('журнал и конфигурация должны лежать вне каталога копий');
  return p;
};

const journal = async (p: IRetentionPolicy, event: Record<string, unknown>): Promise<void> => {
  await mkdir(dirname(p.journalFile), { recursive: true });
  const h = await open(p.journalFile, 'a');
  try { await h.writeFile(JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); await h.sync(); }
  finally { await h.close(); }
};

interface IFile {
  file: string; id: string; size: number; mtime: bigint; nlink: number; mode: number;
}
interface IPoint extends IRetentionPoint { dir: string; id: string; manifest: IBackupManifest; manifestHash: string; files: IFile[] }
const identity = (s: { dev: bigint; ino: bigint }): string => `${s.dev}:${s.ino}`;

const walk = async (dir: string): Promise<IFile[]> => {
  const out: IFile[] = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    for (const e of await readdir(current, { withFileTypes: true })) {
      const file = join(current, e.name);
      const s = await lstat(file, { bigint: true });
      if (s.isSymbolicLink()) return fail(`ссылка внутри точки: ${file}`);
      if (s.isDirectory()) pending.push(file);
      else if (s.isFile() && s.ino !== 0n) out.push({ file, id: identity(s), size: Number(s.size), mtime: s.mtimeNs, nlink: Number(s.nlink), mode: Number(s.mode) & 0o777 });
      else return fail(`необычный файл в точке: ${file}`);
    }
  }
  return out;
};

const inspectPoint = async (root: string, name: string, now: Date): Promise<IPoint> => {
  const dir = join(root, name);
  await physicalDirectory(dir);
  const id = identity(await lstat(dir, { bigint: true }));
  const manifestPath = join(dir, 'manifest.json');
  const ms = await lstat(manifestPath);
  if (!ms.isFile() || ms.isSymbolicLink()) return fail(`необычный манифест: ${name}`);
  const manifestHash = hash(await readFile(manifestPath));
  const m = await readManifest(dir);
  if (!Number.isFinite(Date.parse(m.createdAt)) || !Number.isFinite(Date.parse(m.finishedAt)) ||
      Date.parse(m.createdAt) > Date.parse(m.finishedAt) || Date.parse(m.finishedAt) > now.getTime() ||
      backupDirName(new Date(m.createdAt)) !== name || m.dump.file !== 'db.dump' || !SHA.test(m.dump.sha256) ||
      !Number.isSafeInteger(m.dump.sizeBytes) || m.dump.sizeBytes <= 0) return fail(`неверное время или дамп точки: ${name}`);
  const expected = new Map<string, number>([['manifest.json', ms.size], ['db.dump', m.dump.sizeBytes]]);
  let bytes = 0;
  const shas = new Set<string>();
  for (const [sha, size] of m.blobs) {
    if (!SHA.test(sha) || shas.has(sha) || !Number.isSafeInteger(size) || size < 0) return fail(`неверный blob в ${name}`);
    shas.add(sha); bytes += size;
    expected.set(join('files', 'sha256', sha.slice(0, 2), sha.slice(2, 4), sha), size);
  }
  if (bytes !== m.files.totalBytes || shas.size !== m.files.count || blobListSha256(m.blobs.map(([sha256, sizeBytes]) => ({ sha256, sizeBytes }))) !== m.files.listSha256) {
    return fail(`неверный перечень файлов ${name}`);
  }
  const files = await walk(dir);
  for (const f of files) {
    const rel = f.file.slice(dir.length + 1);
    if (expected.has(rel)) {
      if (expected.get(rel) !== f.size) return fail(`размер файла изменён: ${f.file}`);
      expected.delete(rel);
    } else if (!/^\.[a-f0-9-]{36}\.part$/u.test(basename(f.file))) return fail(`посторонний файл в точке: ${f.file}`);
  }
  if (expected.size) return fail(`в ${name} отсутствуют файлы: ${expected.size}`);
  return { name, dir, id, createdAt: m.createdAt, manifest: m, manifestHash, files };
};

export interface IPruneOptions {
  policyFile: string;
  backupRoot: string;
  storageRoot: string;
  completedPoint: string;
  apply?: boolean;
  now?: Date;
  // Only runBackup's in-memory result can supply this; the CLI always verifies file hashes.
  freshlyVerifiedManifest?: IBackupManifest;
  expectedRemoveNames?: string[];
  log?: (line: string) => void;
}
export interface IPruneResult extends IRetentionSelection { ignored: string[]; removed: string[]; reclaimableFileBytes: number; applied: boolean }

export const pruneBackupPoints = async (o: IPruneOptions): Promise<IPruneResult> => {
  const p = await readRetentionPolicy(o.policyFile);
  if (resolve(p.backupRoot).toLowerCase() !== resolve(o.backupRoot).toLowerCase() || await pathsOverlap(p.backupRoot, o.storageRoot) ||
      await pathsOverlap(p.journalFile, o.storageRoot) || await pathsOverlap(o.policyFile, o.storageRoot)) return fail('каталоги конфигурации, копий и рабочего хранилища пересекаются или не совпадают');
  return withBackupOperation(p.backupRoot, o.apply ? 'retention-apply' : 'retention-plan', async () => {
    const now = o.now ?? new Date();
    const points: IPoint[] = [];
    const ignored: string[] = [];
    const policyHash = hash(await readFile(o.policyFile));
    for (const e of await readdir(p.backupRoot, { withFileTypes: true })) {
      if (e.name === LOCK && e.isFile()) continue;
      if ((await lstat(join(p.backupRoot, e.name))).isSymbolicLink()) return fail(`ссылка в корне копий: ${e.name}`);
      if (!POINT.test(e.name) || !e.isDirectory()) { ignored.push(e.name); continue; }
      points.push(await inspectPoint(p.backupRoot, e.name, now));
      o.log?.(`проверен состав точки ${points.length}: ${e.name}`);
    }
    const selection = selectRetentionPoints(points, p, now);
    if (o.expectedRemoveNames && JSON.stringify([...o.expectedRemoveNames].sort()) !== JSON.stringify(selection.remove.map(x => x.name).sort())) {
      return fail('перечень удаления отличается от согласованного плана');
    }
    const newest = selection.keep[0];
    if (!newest || newest.name !== o.completedPoint) return fail('последняя успешная точка изменилась; очистка отменена');
    const latest = points.find(x => x.name === newest.name)!;
    const verified = points.find(x => x.name === p.verified.name)!;
    if (verified.manifest.dump.sha256 !== p.verified.dumpSha256 || verified.manifest.files.listSha256 !== p.verified.blobListSha256) return fail('контрольные суммы проверенной точки изменились');
    const removeNames = new Set(selection.remove.map(x => x.name));
    const groups = new Map<string, { files: IFile[]; keeper: IFile | undefined }>();
    for (const point of points) for (const f of point.files) {
      const group = groups.get(f.id) ?? { files: [], keeper: undefined };
      group.files.push(f);
      if (!removeNames.has(point.name)) group.keeper ??= f;
      groups.set(f.id, group);
    }
    let reclaimableFileBytes = 0;
    for (const g of groups.values()) {
      const f = g.files[0]!;
      if (g.files.some(x => x.nlink !== f.nlink || x.size !== f.size || x.mode !== f.mode) || f.nlink < g.files.length) return fail('группы жёстких ссылок изменились');
      const touchesRemoval = g.files.some(x => selection.remove.some(p => x.file.startsWith(join(o.backupRoot, p.name) + (process.platform === 'win32' ? '\\' : '/'))));
      if (touchesRemoval && f.nlink > g.files.length) return fail(`у удаляемой точки есть жёсткая ссылка за пределами известных точек: ${f.file}`);
      if (!g.keeper && f.nlink === g.files.length) reclaimableFileBytes += f.size;
    }
    const result: IPruneResult = { ...selection, ignored, removed: [], reclaimableFileBytes, applied: Boolean(o.apply) };
    const runId = randomUUID();
    await journal(p, { event: 'plan', runId, apply: Boolean(o.apply), completedPoint: o.completedPoint, policy: { daily: p.daily, monthly: p.monthly }, ...result });
    if (!o.apply) return result;
    const dump = await fileDigest(join(latest.dir, 'db.dump'));
    if (dump.size !== latest.manifest.dump.sizeBytes || dump.sha256 !== latest.manifest.dump.sha256) return fail('последний дамп не совпадает с манифестом');
    const fresh = o.freshlyVerifiedManifest;
    if (!fresh || JSON.stringify(fresh) !== JSON.stringify(latest.manifest) || now.getTime() - Date.parse(fresh.finishedAt) > 60 * 60 * 1000) {
      o.log?.('проверка SHA-256 файлов последней точки перед очисткой');
      let done = 0;
      for (const [sha, size] of latest.manifest.blobs) {
        const got = await fileDigest(join(latest.dir, 'files', 'sha256', sha.slice(0, 2), sha.slice(2, 4), sha));
        if (got.sha256 !== sha || got.size !== size) return fail('файлы последней точки не прошли SHA-256');
        if (++done % 2000 === 0) o.log?.(`проверено SHA-256: ${done}/${latest.manifest.blobs.length}`);
      }
    }
    await journal(p, { event: 'validated', runId, newest: newest.name, verified: p.verified.name });
    try {
      for (const point of points.filter(x => removeNames.has(x.name))) {
        await physicalDirectory(p.backupRoot);
        if (hash(await readFile(o.policyFile)) !== policyHash) return fail('правила хранения изменились во время очистки');
        if (identity(await lstat(point.dir, { bigint: true })) !== point.id || hash(await readFile(join(point.dir, 'manifest.json'))) !== point.manifestHash) return fail('точка изменена перед удалением');
        const check = await walk(point.dir);
        const before = new Map(point.files.map(x => [x.file, x]));
        if (check.length !== before.size || check.some(x => { const old = before.get(x.file); return !old || old.id !== x.id || old.size !== x.size || old.mtime !== x.mtime; })) return fail('файлы изменились перед удалением');
        await journal(p, { event: 'deleting', runId, point: point.name, manifestSha256: point.manifestHash });
        // A partial deletion must never retain a manifest advertising a restorable point.
        await rename(join(point.dir, 'manifest.json'), join(point.dir, 'manifest.retention-deleting.json'));
        await rm(point.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        result.removed.push(point.name);
        await journal(p, { event: 'deleted', runId, point: point.name });
        o.log?.(`удалена старая точка: ${point.name}`);
      }
    } finally {
      // On Windows rm may clear READONLY on a shared NTFS file. Restore the surviving aliases' modes.
      for (const g of groups.values()) {
        const candidates = g.keeper ? [g.keeper] : g.files;
        for (const f of candidates) {
          const s = await stat(f.file, { bigint: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
          if (!s) continue;
          if (identity(s) !== f.id || Number(s.size) !== f.size || s.mtimeNs !== f.mtime) return fail('сохраняемый файл изменён во время очистки');
          if ((Number(s.mode) & 0o777) !== f.mode) await chmod(f.file, f.mode);
          break;
        }
      }
    }
    await journal(p, { event: 'complete', runId, removed: result.removed, kept: result.keep.map(x => x.name), ignored });
    return result;
  }).catch(async (err: unknown) => {
    await journal(p, { event: 'failure', error: err instanceof Error ? err.message : 'unknown' }).catch(() => undefined);
    throw err;
  });
};

// Called only after runRestoreCheck has passed DB restore, all blob hashes and the DB/manifest list comparison.
export const recordVerifiedBackup = async (policyFile: string, backupDir: string, m: IBackupManifest): Promise<void> => {
  const p = await readRetentionPolicy(policyFile);
  if (resolve(dirname(backupDir)).toLowerCase() !== resolve(p.backupRoot).toLowerCase() || !POINT.test(basename(backupDir))) return fail('проверенная точка относится к другому корню');
  const old = await readManifest(join(p.backupRoot, p.verified.name));
  if (Date.parse(m.createdAt) < Date.parse(old.createdAt)) return;
  p.verified = { name: basename(backupDir), dumpSha256: m.dump.sha256, blobListSha256: m.files.listSha256, verifiedAt: new Date().toISOString() };
  const tmp = `${policyFile}.${randomUUID()}.tmp`;
  const h = await open(tmp, 'wx');
  try { await h.writeFile(JSON.stringify(p, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
  await rename(tmp, policyFile);
  await journal(p, { event: 'restore-verified', point: p.verified.name });
};
