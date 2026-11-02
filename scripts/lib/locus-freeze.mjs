// Full filesystem walk, independent of the Locus index. Reads originals; never writes roots.
import { open, lstat, stat, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, basename } from 'node:path';
import { classifyDataFile } from './locus-file-review.mjs';
import { withinRoot } from './locus-registry-export.mjs';

const fail = code => { throw new Error(code); };
const sameFile = (a, b) => a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino && a.dev === b.dev;
const metadata = s => ({ bytes: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), identity: `${s.dev}:${s.ino}` });
export function validateFreezeRoots(roots) {
  if (!Array.isArray(roots) || !roots.length) fail('ROOTS_REQUIRED');
  const ids = new Set();
  for (const root of roots) {
    if (!root || typeof root.rootId !== 'string' || !root.rootId || ids.has(root.rootId) || !isAbsolute(root.path ?? '') || !['originals', 'data_metadata'].includes(root.kind)) fail('INVALID_FREEZE_ROOT');
    ids.add(root.rootId);
  }
}
export async function inventoryRoots({ roots, maxBytes = 100 * 1024 ** 3, maxEntries = 100000, maxDurationMs = 3600000, onProgress }) {
  validateFreezeRoots(roots);
  if (![maxBytes, maxEntries, maxDurationMs].every(n => Number.isSafeInteger(n) && n > 0)) fail('INVALID_FREEZE_LIMIT');
  const startedAt = new Date().toISOString(), deadline = Date.now() + maxDurationMs;
  const entries = [], errors = [], cache = new Map();
  const statistics = { files: 0, directories: 0, hashedFiles: 0, hashedBytes: 0, uniquePathsRead: 0, metadataOnlyFiles: 0 };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), maxDurationMs); timer.unref();
  let reservedBytes = 0, lastProgress = 0, halted = false;
  const issue = (rootId, path, code) => errors.push({ rootId, path, code });
  function budget(rootId, path) {
    if (halted) return false;
    if (Date.now() >= deadline) { issue(rootId, path, 'TIME_BUDGET'); halted = true; return false; }
    if (entries.length >= maxEntries) { issue(rootId, path, 'ENTRY_BUDGET'); halted = true; return false; }
    return true;
  }
  async function progress() {
    if (onProgress && Date.now() - lastProgress > 1000) { lastProgress = Date.now(); await onProgress({ ...statistics, errors: errors.length, elapsedMs: Date.now() - Date.parse(startedAt) }); }
  }
  async function visit(root, path, canonicalRoot) {
    if (!budget(root.rootId, path)) return;
    const row = { rootId: root.rootId, path, type: 'unknown' }; entries.push(row);
    let handle;
    try {
      const link = await lstat(path, { bigint: true });
      if (link.isSymbolicLink()) fail('SYMLINK_NOT_FOLLOWED');
      const actual = await realpath(path);
      if (!withinRoot(canonicalRoot, actual)) fail('ROOT_PATH_ESCAPE');
      Object.assign(row, metadata(link));
      if (link.isDirectory()) {
        row.type = 'directory'; statistics.directories++;
        const names = (await readdir(path)).sort();
        for (const name of names) { if (halted) break; await visit(root, join(path, name), canonicalRoot); }
        const afterDirectory = await lstat(path, { bigint: true });
        if (await realpath(path) !== actual || afterDirectory.isSymbolicLink() || !sameFile(link, afterDirectory)) fail('DIRECTORY_CHANGED');
      } else if (link.isFile()) {
        row.type = 'file'; statistics.files++;
        if (root.kind === 'data_metadata') {
          row.dataClassification = classifyDataFile(root.path, path);
          if (row.dataClassification !== 'POTENTIAL_ORIGINAL') { row.hashStatus = 'DATA_METADATA_ONLY'; statistics.metadataOnlyFiles++; return; }
        }
        if (/^\.env(?:\.|$)|^.*\.env$|^.*\.(?:key|pem|pfx)$/iu.test(basename(path))) fail('SENSITIVE_FILE_NOT_READ');
        const previous = cache.get(actual);
        if (previous && sameFile(previous.stat, link)) {
          row.sha256 = previous.sha256; row.hashStatus = 'VERIFIED_SAME_PATH'; statistics.hashedFiles++; return;
        }
        if (reservedBytes + Number(link.size) > maxBytes) fail('BYTE_BUDGET');
        reservedBytes += Number(link.size);
        handle = await open(actual, 'r'); const before = await handle.stat({ bigint: true });
        if (!sameFile(link, before) || !before.isFile()) fail('FILE_CHANGED_BEFORE_READ');
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false, signal: controller.signal })) { hash.update(chunk); bytes += chunk.length; await progress(); }
        const after = await handle.stat({ bigint: true });
        if (!sameFile(before, after) || bytes !== Number(before.size) || await realpath(path) !== actual || !sameFile(before, await lstat(path, { bigint: true }))) fail('FILE_CHANGED_DURING_READ');
        row.sha256 = hash.digest('hex'); row.hashStatus = 'VERIFIED_BYTES';
        cache.set(actual, { stat: after, sha256: row.sha256 });
        statistics.hashedFiles++; statistics.hashedBytes += bytes; statistics.uniquePathsRead++;
      } else fail('UNSUPPORTED_FILE_TYPE');
    } catch (error) {
      row.sha256 = null; row.hashStatus = 'UNVERIFIED';
      const code = error?.name === 'AbortError' ? 'TIME_BUDGET' : /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'WALK_IO_ERROR';
      issue(root.rootId, path, code);
    } finally { await handle?.close(); await progress(); }
  }
  try {
    for (const root of roots) {
      if (halted) { issue(root.rootId, root.path, 'NOT_VISITED_BUDGET'); continue; }
      try {
        if (!(await stat(root.path)).isDirectory()) fail('ROOT_NOT_DIRECTORY');
        await visit(root, root.path, await realpath(root.path));
      } catch (error) { issue(root.rootId, root.path, ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'ROOT_UNAVAILABLE'); }
    }
  } finally { clearTimeout(timer); }
  return { schemaVersion: 1, purpose: 'FULL_WALK_HASHES_NOT_ACCEPTED_FROZEN_PAIR', startedAt, finishedAt: new Date().toISOString(), roots, entries, errors, statistics,
    complete: errors.length === 0, contentSnapshotPreserved: false, atomicFilesystemSnapshot: false, D046Compliance: 'NOT_PROVEN', retirementAllowed: false };
}
export function compareFreezePair({ first, second, backup, cutover = '2026-10-30T11:44:35.000Z', maxWindowMs = 2 * 60 * 60 * 1000 }) {
  const issues = [];
  if (!Number.isSafeInteger(maxWindowMs) || maxWindowMs < 1 || maxWindowMs > 4 * 60 * 60 * 1000) fail('INVALID_FREEZE_WINDOW_LIMIT');
  if (first?.schemaVersion !== 1 || second?.schemaVersion !== 1 || !Array.isArray(first?.entries) || !Array.isArray(second?.entries)) fail('INVALID_FREEZE_INVENTORY');
  validateFreezeRoots(first.roots); validateFreezeRoots(second.roots);
  for (const report of [first, second]) {
    const originals = new Set(report.roots.filter(r => r.kind === 'originals').map(r => r.rootId));
    if (report.entries.some(e => e.type === 'file' && (originals.has(e.rootId) || e.dataClassification === 'POTENTIAL_ORIGINAL') && !/^[a-f0-9]{64}$/u.test(e.sha256 ?? ''))) issues.push('UNVERIFIED_ORIGINAL');
    if (report.roots.some(r => !report.entries.some(e => e.rootId === r.rootId && e.path === r.path && e.type === 'directory'))) issues.push('ROOT_NOT_VISITED');
  }
  if (!first.complete || !second.complete || first.errors?.length || second.errors?.length) issues.push('INCOMPLETE_WALK');
  if (JSON.stringify(first.roots) !== JSON.stringify(second.roots)) issues.push('ROOT_CATALOG_CHANGED');
  const key = e => JSON.stringify([e.rootId, e.path]);
  const index = rows => { const map = new Map(); for (const e of rows) { if (map.has(key(e))) fail('DUPLICATE_WALK_ENTRY'); map.set(key(e), e); } return map; };
  const left = index(first.entries), right = index(second.entries), differences = [];
  for (const k of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(k), b = right.get(k);
    if (!a || !b || a.type !== b.type || a.identity !== b.identity || (a.type === 'file' && (a.bytes !== b.bytes || a.mtimeNs !== b.mtimeNs || a.sha256 !== b.sha256))) differences.push(k);
  }
  if (differences.length) issues.push('FILES_CHANGED');
  const t = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
  const start = t(first.startedAt), firstEnd = t(first.finishedAt), secondStart = t(second.startedAt), end = t(second.finishedAt), cutoff = t(cutover);
  if (![start, firstEnd, secondStart, end, cutoff].every(Number.isFinite) || start > firstEnd || firstEnd > secondStart || secondStart > end) issues.push('INVALID_WALK_TIMELINE');
  if (!(start > cutoff)) issues.push('FIRST_WALK_NOT_AFTER_CUTOVER');
  if (!Number.isFinite(end - start) || end - start > maxWindowMs) issues.push('FREEZE_WINDOW_EXCEEDED');
  if (!/^[a-f0-9]{64}$/u.test(backup?.dump?.sha256 ?? '') || !(t(backup?.createdAt) >= t(first.finishedAt) && t(backup?.finishedAt) >= t(backup?.createdAt) && t(backup?.finishedAt) <= t(second.startedAt) && t(backup?.createdAt) > t(cutover))) issues.push('BACKUP_NOT_BRACKETED_AFTER_CUTOVER');
  return { schemaVersion: 1, stableHashesAndBackupWindow: issues.length === 0, maxWindowMs, issues, differences, contentSnapshotPreserved: false, D046Compliance: 'NOT_PROVEN', frozenPairAccepted: false, retirementAllowed: false };
}
