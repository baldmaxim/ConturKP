// RDWeb Markdown is derivative data. Header names only propose originals; they never approve a relation.
import { open, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { withinRoot } from './locus-registry-export.mjs';
const pathKey = p => process.platform === 'win32' ? resolve(p).normalize('NFC').toLowerCase() : resolve(p).normalize('NFC');
const nameKey = p => basename(p).normalize('NFC').toLocaleLowerCase('ru');
export function parseDerivedHeader(text) {
  const header = String(text).replace(/^\uFEFF/u, '').split(/^## Page\b|^### BLOCK\b/mu)[0].slice(0, 65536);
  const name = /^# Document:\s*([^\r\n]+)$/mu.exec(header)?.[1]?.trim() ?? null;
  const path = /^Path:\s*([^\r\n]+)$/mu.exec(header)?.[1]?.trim() ?? null;
  const documentName = name && name.length <= 512 && !/[\\/:\u0000-\u001f]/u.test(name) && /\.(?:pdf|docx)$/iu.test(name) ? name : null;
  const relativePathHint = path && path.length <= 2048 && !/^[\\/]|[:\u0000-\u001f]/u.test(path) && !isAbsolute(path) && !path.split(/[\\/]/u).some(p => p.trim() === '..') ? path : null;
  return { documentName, relativePathHint, originalRelationApproved: false, authority: 'UNTRUSTED_DERIVED_DOCUMENT_HEADER' };
}
export async function enrichDerivedHeaders({ inventory, walk, maxTotalBytes = 2 * 1024 ** 3, maxFileBytes = 100 * 1024 ** 2 }) {
  if (![maxTotalBytes, maxFileBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('INVALID_MD_HEADER_LIMIT');
  const result = structuredClone(inventory), roots = new Map(walk.roots.filter(r => r.kind === 'originals').map(r => [r.rootId, r]));
  let reserved = 0;
  for (const row of result.observations) {
    if (row.status !== 'DERIVED_COPY_REQUIRES_ORIGINAL') continue;
    let handle;
    try {
      const matches = walk.entries.filter(e => e.type === 'file' && pathKey(e.path) === pathKey(row.readPath) && roots.has(e.rootId));
      if (!matches.length || !/^[a-f0-9]{64}$/u.test(row.derivedSha256 ?? '')) throw new Error('NO_VERIFIED_MD_BYTES');
      const path = await realpath(row.readPath), allowedIds = new Set(matches.map(e => e.rootId));
      const allowedRoots = await Promise.all([...allowedIds].map(id => realpath(roots.get(id).path)));
      if (!allowedRoots.some(root => withinRoot(root, path)) || (await lstat(row.readPath)).isSymbolicLink()) throw new Error('MD_PATH_ESCAPE');
      handle = await open(path, 'r'); const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(maxFileBytes) || reserved + Number(before.size) > maxTotalBytes) throw new Error('MD_HEADER_BYTE_BUDGET');
      reserved += Number(before.size);
      const hash = createHash('sha256'), chunks = []; let kept = 0, read = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk); read += chunk.length;
        if (kept < 65536) { const part = chunk.subarray(0, 65536 - kept); chunks.push(part); kept += part.length; }
      }
      const after = await handle.stat({ bigint: true });
      if (hash.digest('hex') !== row.derivedSha256 || read !== Number(before.size) || before.size !== after.size || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || await realpath(row.readPath) !== path) throw new Error('MD_HASH_CHANGED');
      const header = parseDerivedHeader(Buffer.concat(chunks).toString('utf8')); row.documentHeader = header;
      const candidates = walk.entries.filter(e => e.type === 'file' && allowedIds.has(e.rootId) && header.documentName && nameKey(e.path) === nameKey(header.documentName) && /^[a-f0-9]{64}$/u.test(e.sha256 ?? '') && Number.isSafeInteger(e.bytes));
      const paths = new Map();
      for (const e of candidates) {
        const key = pathKey(e.path), prior = paths.get(key);
        if (prior && (prior.sha256 !== e.sha256 || prior.bytes !== e.bytes)) throw new Error('ORIGINAL_CANDIDATE_CHANGED');
        paths.set(key, e);
      }
      const all = new Map((row.originalCandidates ?? []).map(c => [JSON.stringify([pathKey(c.path), c.sha256]), c]));
      for (const e of paths.values()) all.set(JSON.stringify([pathKey(e.path), e.sha256]), { path: e.path, sha256: e.sha256, bytes: e.bytes, approved: false, matchRule: 'UNTRUSTED_MD_HEADER_NAME_IN_CONFIRMED_SOURCE_ROOT' });
      row.originalCandidates = [...all.values()]; row.headerStatus = 'VERIFIED_MD_HEADER_ONLY';
    } catch (error) {
      row.headerStatus = /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'MD_HEADER_IO_ERROR';
    } finally { await handle?.close(); }
  }
  return result;
}
