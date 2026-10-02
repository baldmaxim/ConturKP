// Скан наблюдаемой папки (state-machines §1.1, §3; A13–A15, A38).
// Папка должна лежать внутри разрешённого корня (realpath при каждом скане); ссылки не открываются;
// хранилище и его производные каталоги не сканируются. Файл импортируется, только когда размер
// и время изменения не менялись INTAKE_STABILITY_SECONDS и не изменились во время копирования.
// Удаление файла из папки ничего не удаляет. Успешный скан — полный проход без файлов,
// ожидающих стабильности.
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path, { dirname, join, relative, resolve, sep, type PlatformPath } from 'node:path';
import { classifyFile, safeRelativePath } from '@kontur/core';
import {
  createBatch,
  emitStageEvents,
  finalizeBatchIfDone,
  getChannel,
  insertBlob,
  loadFileStates,
  markExpanded,
  markImported,
  markMissing,
  markScanResult,
  observeFile,
  type INewItem,
} from '@kontur/db';
import { BlobLimitError, physicalPath, type IStoredBlob } from '@kontur/storage';
import { RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';
import { assertUnchanged, openVerifiedFile, SourceChangedError, UnsafeSourceError } from './safeRead.ts';
import { addItem } from './imports.ts';

const TEMP_NAME = /^(~\$|\.~lock)|\.(tmp|part|partial|crdownload|download)$/i;
const SKIP_DIRS = new Set(['.kontur', '$recycle.bin', 'system volume information']);
const MAX_FILES = 20_000;
const MAX_DEPTH = 20;

interface IFound {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  symlink: boolean;
}

// Путь внутри каталога (или совпадает с ним) по правилам платформы: на Windows `relative` не различает регистр и
// разделители, на POSIX различает регистр. Сравнение префиксом строки на Windows давало ложное «снаружи» (R08-05).
export const insidePath = (child: string, parent: string, p: Pick<PlatformPath, 'relative' | 'isAbsolute' | 'sep'> = path): boolean => {
  const rel = p.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
};

// Физическая идентичность каталога: устройство и номер файла. Не зависит от записи пути — регистра, коротких имён 8.3,
// junction и ссылок. Номер 0 (файловая система его не сообщает) и недоступный по правам предок идентичности не дают:
// сравнение по пути (`insidePath`) остаётся в силе.
const dirIdentity = async (dir: string): Promise<string | null> => {
  const st = await stat(dir, { bigint: true }).catch(() => null);
  return st === null || st.ino === 0n ? null : `${st.dev}:${st.ino}`;
};

// `real` — физический путь: каталог и все его предки по identity, от него вверх до корня тома.
const lineageOf = async (real: string): Promise<Set<string>> => {
  const ids = new Set<string>();
  for (let dir = real; ; dir = dirname(dir)) {
    const id = await dirIdentity(dir);
    if (id) ids.add(id);
    if (dirname(dir) === dir) return ids;
  }
};

// Один каталог внутри другого: по физическим путям и по идентичности каталогов — пересечение находится, как бы ни были
// записаны пути в конфигурации.
const overlaps = async (a: string, b: string): Promise<boolean> => {
  if (insidePath(a, b) || insidePath(b, a)) return true;
  const [idA, idB] = await Promise.all([dirIdentity(a), dirIdentity(b)]);
  return (idB !== null && (await lineageOf(a)).has(idB)) || (idA !== null && (await lineageOf(b)).has(idA));
};

export class IntakeRootError extends Error {}

// Проверка корня: папка существует, realpath внутри одного из разрешённых корней и не пересекается с хранилищем.
// Хранилище сравнивается по физическому пути (`physicalPath`: realpath ближайшего существующего предка): путь из
// конфигурации может быть junction, ссылкой или иной записью того же каталога, а сам каталог хранилища может ещё не
// существовать — проверка ничего не создаёт и идёт до подготовки хранилища (R03-06, R08-05).
export const resolveChannelRoot = async (locator: string, roots: string[], storageRoot: string): Promise<string> => {
  if (roots.length === 0) throw new IntakeRootError('intake_root_not_configured');
  const real = await realpath(resolve(locator));
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => null)));
  if (!realRoots.some((r) => r !== null && insidePath(real, r))) throw new IntakeRootError('outside_intake_root');
  const store = await physicalPath(storageRoot);
  if (await overlaps(real, store)) throw new IntakeRootError('overlaps_storage');
  return real;
};

const walk = async (root: string, skip: (abs: string) => boolean): Promise<IFound[]> => {
  const out: IFound[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    const handle = await opendir(dir);
    for await (const d of handle) {
      const abs = join(dir, d.name);
      if (skip(abs)) continue;
      const st = await lstat(abs);
      const rel = relative(root, abs).split(sep).join('/');
      if (st.isSymbolicLink()) {
        out.push({ rel, abs, size: 0, mtimeMs: Math.trunc(st.mtimeMs), symlink: true });
      } else if (st.isDirectory()) {
        if (!SKIP_DIRS.has(d.name.toLowerCase())) await visit(abs, depth + 1);
      } else if (st.isFile() && !TEMP_NAME.test(d.name)) {
        out.push({ rel, abs, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), symlink: false });
      }
      if (out.length >= MAX_FILES) break;
    }
  };
  await visit(root, 0);
  return out;
};

export const handleIntakeScan = async (ctx: IJobContext): Promise<void> => {
  const channelId = String(ctx.job.payload.channelId);
  const startedAt = new Date();
  const channel = await getChannel(ctx.pool, channelId);
  if (!channel || !channel.active || channel.kind !== 'watched_folder') return;

  let root: string;
  let files: IFound[];
  try {
    // Пересечение — с физическим корнем хранилища, с первого скана и до любой записи в хранилище: путь из конфигурации
    // может быть junction, ссылкой, коротким именем или иным регистром того же каталога (R03-06, R08-05).
    root = await resolveChannelRoot(channel.locator, ctx.config.intakeRoots, await ctx.store.physicalRoot());
    files = await walk(root, (abs) => ctx.store.contains(abs));
  } catch (err) {
    const code = err instanceof IntakeRootError ? err.message : 'share_unavailable';
    await ctx.withLease((client) => markScanResult(client, channelId, { startedAt, pendingUnstable: 0, errorCode: code }));
    // Недоступная шара — повтор с задержкой; ошибка конфигурации — тоже повтор (администратор может исправить).
    throw new RetryableJobError(code, code === 'share_unavailable' ? 'папка канала недоступна' : 'папка канала вне разрешённого корня');
  }

  // Подготовка хранилища — по физическому пути. Отказ не остаётся «отсутствием ошибки»: канал получает код
  // `storage_unavailable`, задание — ошибку для повтора (R08-05).
  try {
    await ctx.store.ensureDirs();
  } catch (err) {
    await ctx.withLease((client) => markScanResult(client, channelId, { startedAt, pendingUnstable: 0, errorCode: 'storage_unavailable' }));
    throw err;
  }

  const states = await loadFileStates(ctx.pool, channelId);
  const stableMs = ctx.config.intakeStabilitySeconds * 1000;
  // blob — метаданные записанного содержимого; строка в БД появится под арендой (R03-09).
  const items: { item: Omit<INewItem, 'batchId'>; found: IFound; sha: string | null; blob: (IStoredBlob & { mediaType: string }) | null }[] = [];
  let pendingUnstable = 0;

  for (const f of files) {
    ctx.throwIfStopped();
    const prev = states.get(f.rel);
    const same = prev && prev.size_bytes === f.size && prev.mtime_ms === f.mtimeMs && !prev.missing_since;
    if (same && prev.imported_size === f.size && prev.imported_mtime === f.mtimeMs) continue;
    if (!same || Date.now() - prev.unchanged_since.getTime() < stableMs) {
      pendingUnstable += 1;
      continue;
    }
    const observedName = f.rel.split('/').pop() ?? f.rel;
    const safe = safeRelativePath(f.rel);
    const base = { tenderId: channel.tender_id, memberPath: f.rel, observedName };
    if (f.symlink || !safe.ok) {
      items.push({ item: { ...base, status: 'rejected', rejectReason: 'path_traversal', rejectDetail: f.symlink ? 'ссылка не открывается' : (safe.ok ? '' : safe.detail) }, found: f, sha: null, blob: null });
      continue;
    }
    // Путь проверяется заново непосредственно перед чтением, и читается открытый дескриптор,
    // а не путь (R03-07). «Нестабильным» считается только сбой чтения исходного файла;
    // ошибки хранилища и БД — сбой задания, а не молчаливое откладывание.
    let verified;
    try {
      verified = await openVerifiedFile(f.abs, root, { size: f.size, mtimeMs: f.mtimeMs });
    } catch (err) {
      if (err instanceof UnsafeSourceError) {
        items.push({ item: { ...base, status: 'rejected', rejectReason: 'path_traversal', rejectDetail: err.message }, found: f, sha: null, blob: null });
      } else if (err instanceof SourceChangedError || ['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes((err as NodeJS.ErrnoException).code ?? '')) {
        pendingUnstable += 1;
      } else {
        throw err;
      }
      continue;
    }
    let sourceError: NodeJS.ErrnoException | null = null;
    const source = verified.handle.createReadStream({ autoClose: false });
    source.on('error', (e: NodeJS.ErrnoException) => {
      sourceError = e;
    });
    try {
      const stored = await ctx.store.putStream(source, ctx.config.limits.maxEntryBytes);
      await assertUnchanged(verified, stored.sizeBytes);
      const verdict = classifyFile(f.rel, stored.head, stored.sizeBytes);
      const item: Omit<INewItem, 'batchId'> =
        verdict.kind === 'document'
          ? { ...base, status: 'pending', blobSha: stored.sha256, sizeBytes: stored.sizeBytes }
          : {
              ...base,
              status: 'rejected',
              rejectReason: verdict.kind === 'archive' ? 'type_not_allowed' : verdict.reason,
              rejectDetail: verdict.kind === 'archive' ? 'архивы в наблюдаемой папке не распаковываются; загрузите архив через портал' : verdict.detail,
              blobSha: stored.sha256,
              sizeBytes: stored.sizeBytes,
            };
      const mediaType = verdict.kind === 'rejected' ? 'application/octet-stream' : verdict.mediaType;
      // Строка blob пишется только под действующей арендой, вместе с партией (R03-09).
      items.push({ item, found: f, sha: stored.sha256, blob: { ...stored, mediaType } });
    } catch (err) {
      const code = (sourceError as NodeJS.ErrnoException | null)?.code;
      if (err instanceof BlobLimitError) {
        items.push({ item: { ...base, status: 'rejected', rejectReason: 'size_limit', rejectDetail: 'файл больше лимита' }, found: f, sha: null, blob: null });
      } else if (err instanceof SourceChangedError || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
        // Исходный файл занят копированием, исчез или изменился при чтении.
        pendingUnstable += 1;
      } else {
        throw err;
      }
    } finally {
      await verified.handle.close().catch(() => undefined);
    }
  }

  await ctx.complete(async (client) => {
    // Состояние файлов пишется только под действующей арендой, вместе с результатом скана.
    for (const f of files) await observeFile(client, channelId, f.rel, f.size, f.mtimeMs);
    if (items.length > 0) {
      const batchId = await createBatch(client, {
        tenderId: channel.tender_id,
        stageId: null,
        sourceKind: 'watched_folder',
        channelId,
        uploadName: null,
        uploadSha: null,
        createdBy: null,
      });
      // Момент «поступил» для папки — регистрация сканом: событие партии до регистрации элементов.
      await emitStageEvents(client, { tenderId: channel.tender_id, stageIds: null, eventType: 'import_accepted', refType: 'import_batch', refId: batchId, actorUserId: null });
      for (const x of items) {
        if (x.blob) {
          await insertBlob(client, { sha256: x.blob.sha256, sizeBytes: x.blob.sizeBytes, mediaType: x.blob.mediaType, storageKey: x.blob.storageKey });
        }
        await addItem(client, { ...x.item, batchId });
        await markImported(client, channelId, x.found.rel, x.found.size, x.found.mtimeMs, x.sha);
      }
      await markExpanded(client, batchId);
      await finalizeBatchIfDone(client, batchId);
    }
    await markMissing(client, channelId, files.map((f) => f.rel));
    await markScanResult(client, channelId, { startedAt, pendingUnstable, errorCode: null });
  });
};

// Терминальная ошибка скана фиксируется как ошибка канала в той же транзакции (R03-05).
export const intakeScanHandler: IJobHandlerSpec = {
  run: handleIntakeScan,
  onTerminalFailure: async (client, ctx, failure) => {
    await markScanResult(client, String(ctx.job.payload.channelId), { startedAt: new Date(), pendingUnstable: 0, errorCode: failure.code });
  },
};
