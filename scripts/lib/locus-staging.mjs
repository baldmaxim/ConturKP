// Copies only into a new isolated BlobStore. Verification never writes into that store.
import { BlobStore, physicalPath } from '../../packages/storage/src/index.ts';
import { mkdir, realpath, lstat, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { withinRoot } from './locus-registry-export.mjs';

const fail = code => { throw new Error(code); };
const validId = value => typeof value === 'string' && value.length > 0 && value === value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
export function validateStagingPlan(plan) {
  if (plan?.schemaVersion !== 1 || plan.target !== 'ISOLATED_BLOB_STAGING_ONLY' || !Array.isArray(plan.files) || !plan.files.length) fail('INVALID_STAGING_PLAN');
  const blobs = new Set(), identities = new Set();
  let bytes = 0, logicalEntries = 0;
  for (const file of plan.files) {
    if (!/^[a-f0-9]{64}$/u.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !validId(file.sourceId) || typeof file.sourcePath !== 'string' || !isAbsolute(file.sourcePath) || !Array.isArray(file.logicalEntries) || !file.logicalEntries.length) fail('INVALID_STAGING_FILE');
    if (blobs.has(file.sha256)) fail('DUPLICATE_STAGING_BLOB'); blobs.add(file.sha256);
    for (const entry of file.logicalEntries) {
      if (!validId(entry.sourceId) || !validId(entry.entryId) || !validId(entry.candidateScopeId)) fail('INVALID_STAGING_IDENTITY');
      const key = JSON.stringify([entry.sourceId, entry.entryId]);
      if (identities.has(key)) fail('DUPLICATE_STAGING_IDENTITY'); identities.add(key); logicalEntries++;
    }
    bytes += file.bytes; if (!Number.isSafeInteger(bytes)) fail('INVALID_STAGING_TOTAL');
  }
  if (plan.totalBytes !== undefined && plan.totalBytes !== bytes) fail('INVALID_STAGING_TOTAL');
  if (plan.logicalEntries !== undefined && plan.logicalEntries !== logicalEntries) fail('INVALID_STAGING_TOTAL');
  return { bytes, logicalEntries };
}
function rootsFor(catalog) {
  if (!Array.isArray(catalog?.sources)) fail('INVALID_STAGING_SOURCES');
  const roots = new Map();
  for (const source of catalog.sources) {
    if (!validId(source.sourceId) || roots.has(source.sourceId) || !Array.isArray(source.roots) || !source.roots.every(p => typeof p === 'string' && isAbsolute(p))) fail('INVALID_STAGING_SOURCES');
    roots.set(source.sourceId, source.roots.map(p => resolve(p)));
  }
  return roots;
}
async function workers(files, concurrency, operation) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) fail('INVALID_STAGING_CONCURRENCY');
  const results = new Array(files.length); let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < files.length) { const index = next++; results[index] = await operation(files[index]); }
  }));
  return results;
}
export async function stageCorpusBlobs({ plan, sourceCatalog, storeRoot, concurrency = 3, onProgress, portalRoots, spacePolicy = { warnFreeBytes: 10 * 1024 ** 3, stopFreeBytes: 5 * 1024 ** 3 } }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) fail('INVALID_STAGING_CONCURRENCY');
  const totals = validateStagingPlan(plan), roots = rootsFor(sourceCatalog);
  if (typeof storeRoot !== 'string' || !isAbsolute(storeRoot)) fail('ABSOLUTE_STAGING_ROOT_REQUIRED');
  for (const file of plan.files) if (!(roots.get(file.sourceId) ?? []).some(root => withinRoot(root, file.sourcePath))) fail('INVALID_STAGING_SOURCE');
  const target = await physicalPath(storeRoot);
  for (const list of roots.values()) for (const root of list) if (withinRoot(await physicalPath(root), target)) fail('STAGING_INSIDE_SOURCE');
  if (!Array.isArray(portalRoots) || !portalRoots.length || !portalRoots.every(p => typeof p === 'string' && isAbsolute(p))) fail('PORTAL_ROOTS_REQUIRED');
  const canonicalPortalRoots = await Promise.all(portalRoots.map(physicalPath));
  for (const root of canonicalPortalRoots) if (withinRoot(root, target) || withinRoot(target, root)) fail('STAGING_INSIDE_PORTAL');
  await mkdir(target); // refuse an existing destination; no cleanup/pruning of previous stores
  const store = new BlobStore(target, spacePolicy);
  await store.ensureDirs();
  let copiedBlobs = 0, failedBlobs = 0, bytes = 0, processed = 0;
  const files = await workers(plan.files, concurrency, async file => {
    const row = { sha256: file.sha256, expectedBytes: file.bytes };
    try {
      const root = roots.get(file.sourceId).find(p => withinRoot(p, file.sourcePath));
      const actual = await realpath(file.sourcePath), canonicalRoot = await realpath(root);
      if (!withinRoot(canonicalRoot, actual) || (await lstat(file.sourcePath)).isSymbolicLink()) fail('INVALID_STAGING_SOURCE');
      const got = await store.putStream(createReadStream(actual), file.bytes);
      if (got.sha256 !== file.sha256 || got.sizeBytes !== file.bytes) fail('SOURCE_HASH_CHANGED');
      row.status = 'STAGED'; row.storageKey = got.storageKey; copiedBlobs++; bytes += got.sizeBytes;
    } catch (error) {
      row.status = 'FAILED'; row.errorCode = ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'STAGING_FAILED'; failedBlobs++;
    }
    processed++; if (onProgress) await onProgress({ processed, total: plan.files.length, copiedBlobs, failedBlobs, bytes });
    return row;
  });
  return { schemaVersion: 1, mode: 'ISOLATED_BLOB_STAGING_ONLY', plannedBlobs: plan.files.length, plannedLogicalEntries: totals.logicalEntries,
    copiedBlobs, failedBlobs, bytes, files, isolation: { portalRoots: canonicalPortalRoots, storeRoot: target }, documentsRegistered: false, recognitionRun: false, workingInstallationChanged: false, retirementAllowed: false };
}
export async function verifyCorpusStaging({ plan, storeRoot, concurrency = 3 }) {
  validateStagingPlan(plan);
  const root = await realpath(storeRoot);
  let verified = 0, bytes = 0, failures = 0;
  const files = await workers(plan.files, concurrency, async file => {
    const path = resolve(root, 'sha256', file.sha256.slice(0, 2), file.sha256.slice(2, 4), file.sha256);
    const row = { sha256: file.sha256, status: 'FAILED' };
    try {
      const actual = await realpath(path);
      if (!withinRoot(root, actual) || (await lstat(path)).isSymbolicLink()) fail('STAGING_PATH_ESCAPE');
      const before = await stat(actual, { bigint: true }); if (!before.isFile()) fail('STAGING_NOT_FILE');
      const hash = createHash('sha256'); let read = 0;
      for await (const chunk of createReadStream(actual)) { hash.update(chunk); read += chunk.length; }
      const after = await stat(actual, { bigint: true });
      if (read !== file.bytes || hash.digest('hex') !== file.sha256 || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino || await realpath(path) !== actual) fail('STAGING_READBACK_MISMATCH');
      row.status = 'VERIFIED'; verified++; bytes += read;
    } catch { failures++; }
    return row;
  });
  return { schemaVersion: 1, mode: 'INDEPENDENT_READBACK_OF_ISOLATED_STAGING', plannedBlobs: plan.files.length, verified, bytes, failures, files, retirementAllowed: false };
}
