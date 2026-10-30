// Чтение оригиналов из старого индекса. Полной описью корпуса такой экспорт не является.
import { createHash } from 'node:crypto';
import { open, realpath, stat, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const validId = value => typeof value === 'string' && value.length > 0 && value === value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new Error(code); };
export function withinRoot(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'));
}

export async function exportLocusRegistry(options) {
  const { registry, sourceCatalog, snapshotId, onProgress } = options;
  const maxBytes = options.maxBytes ?? 2 * 1024 ** 3;
  const maxDurationMs = options.maxDurationMs ?? 600000;
  const concurrency = options.concurrency ?? 2;
  if (![maxBytes, maxDurationMs, concurrency].every(Number.isSafeInteger) || maxBytes < 1 || maxDurationMs < 1 || concurrency < 1 || concurrency > 4) fail('INVALID_EXPORT_LIMIT');
  if (!object(registry?.files) || !Array.isArray(sourceCatalog?.sources) || !validId(snapshotId)) fail('INVALID_REGISTRY_EXPORT_INPUT');
  const roots = new Map();
  for (const source of sourceCatalog.sources) {
    if (!validId(source.sourceId) || roots.has(source.sourceId) || !Array.isArray(source.roots) || !source.roots.every(p => typeof p === 'string' && isAbsolute(p))) fail('INVALID_SOURCE_CATALOG');
    roots.set(source.sourceId, source.roots.map(p => resolve(p)));
  }
  const identities = new Set();
  const entries = Object.entries(registry.files).map(([key, raw]) => {
    if (!object(raw) || !validId(raw.sourceId) || !validId(raw.fileId ?? key)) fail('INVALID_REGISTRY_ENTRY');
    if (typeof raw.path !== 'string' || !isAbsolute(raw.path) || /[\u0000-\u001f\u007f]/u.test(raw.path)) fail('ABSOLUTE_ORIGINAL_PATH_REQUIRED');
    const entry = { sourceId: raw.sourceId, entryId: raw.fileId ?? key, path: resolve(raw.path), declaredSize: raw.size };
    const identity = JSON.stringify([entry.sourceId, entry.entryId]);
    if (identities.has(identity)) fail('DUPLICATE_SOURCE_ID');
    identities.add(identity);
    return entry;
  });
  const startedAt = Date.now(), deadline = startedAt + maxDurationMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxDurationMs);
  const canonicalRoots = new Map();
  const documents = new Array(entries.length), observations = new Array(entries.length);
  let next = 0, reservedBytes = 0, processed = 0, hashed = 0, hashedBytes = 0;
  async function one(index) {
    const entry = entries[index];
    const doc = { sourceId: entry.sourceId, entryId: entry.entryId, sha256: null, bytes: null };
    const observation = { sourceId: entry.sourceId, entryId: entry.entryId, status: 'ORIGINAL_UNAVAILABLE' };
    documents[index] = doc; observations[index] = observation;
    let handle;
    try {
      if (Date.now() >= deadline) { observation.status = 'TIME_BUDGET'; return; }
      const candidates = roots.get(entry.sourceId);
      if (!candidates) { observation.status = 'SOURCE_NOT_CONFIGURED'; return; }
      const declaredRoot = candidates.find(root => withinRoot(root, entry.path));
      if (!declaredRoot) { observation.status = 'OUTSIDE_SOURCE_ROOT'; return; }
      if (!canonicalRoots.has(declaredRoot)) canonicalRoots.set(declaredRoot, realpath(declaredRoot));
      const canonicalRoot = await canonicalRoots.get(declaredRoot);
      const actualPath = await realpath(entry.path);
      if (!withinRoot(canonicalRoot, actualPath)) { observation.status = 'OUTSIDE_REAL_SOURCE_ROOT'; return; }
      const link = await lstat(entry.path);
      if (link.isSymbolicLink()) { observation.status = 'SYMLINK_ORIGINAL'; return; }
      handle = await open(actualPath, 'r');
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) { observation.status = 'NOT_REGULAR_FILE'; return; }
      const size = Number(before.size);
      if (!Number.isSafeInteger(size)) { observation.status = 'UNSAFE_SIZE'; return; }
      if (reservedBytes + size > maxBytes) { observation.status = 'BYTE_BUDGET'; return; }
      reservedBytes += size;
      if (controller.signal.aborted) { observation.status = 'TIME_BUDGET'; return; }
      const hash = createHash('sha256');
      let readBytes = 0;
      // Не закрывать FileHandle автоматически: stat после чтения относится к тому же файлу.
      for await (const chunk of handle.createReadStream({ autoClose: false, signal: controller.signal })) {
        readBytes += chunk.length;
        if (readBytes > size) { observation.status = 'CHANGED_DURING_READ'; return; }
        hash.update(chunk);
      }
      const after = await handle.stat({ bigint: true });
      const currentPath = await realpath(entry.path);
      const current = await stat(currentPath, { bigint: true });
      if (readBytes !== size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== current.ino || before.dev !== current.dev || before.size !== current.size || before.mtimeNs !== current.mtimeNs || currentPath !== actualPath) {
        observation.status = 'CHANGED_DURING_READ'; return;
      }
      doc.sha256 = hash.digest('hex'); doc.bytes = size;
      observation.status = 'HASHED';
      observation.registrySizeChanged = Number.isSafeInteger(entry.declaredSize) && entry.declaredSize !== size;
      hashed++; hashedBytes += size;
    } catch (error) {
      observation.status = controller.signal.aborted ? 'TIME_BUDGET' : 'ORIGINAL_UNAVAILABLE';
      observation.errorCode = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EIO'].includes(error?.code) ? error.code : 'READ_FAILED';
    } finally {
      if (handle) await handle.close().catch(() => {});
      processed++;
      if (onProgress) await onProgress({ processed, total: entries.length, hashed, hashedBytes });
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < entries.length) {
        const index = next++;
        await one(index);
      }
    }));
  } finally { clearTimeout(timer); }
  const statuses = {};
  for (const entry of observations) statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
  const errors = ['INDEXED_ENTRIES_ONLY', 'ACTIVE_DATA_ROOT_NOT_CONFIRMED'];
  for (const status of Object.keys(statuses)) if (status !== 'HASHED') errors.push(status);
  if (observations.some(o => o.registrySizeChanged)) errors.push('REGISTRY_SIZE_CHANGED');
  return {
    schemaVersion: 1, system: 'locus', snapshotId, capturedAt: new Date(startedAt).toISOString(),
    complete: false, errors, documents, observations,
    statistics: { entries: entries.length, hashed, hashedBytes, statuses, elapsedMs: Date.now() - startedAt },
    exportMode: 'INDEXED_ENTRIES_ONLY', corpusFrozen: false, activeDataRootVerified: false,
  };
}
