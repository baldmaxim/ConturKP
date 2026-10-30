// Offline metadata pipeline. Never executes SQL or connects to an application database.
import { createHash } from 'node:crypto';
import { win32, posix } from 'node:path';
import { auditLocusCorpus } from './locus-corpus-audit.mjs';

const fail = code => { throw new Error(code); };
const tuple = (...parts) => JSON.stringify(parts);
const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const id = value => { if (!isId(value)) fail('INVALID_WORKFLOW_ID'); return value; };
const hash = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) fail('INVALID_WORKFLOW_HASH'); return value.toLowerCase(); };
const size = value => { const n = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value; if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_WORKFLOW_SIZE'); return n; };
const pathApi = value => /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? win32 : posix;
function absolute(value) {
  if (typeof value !== 'string' || !pathApi(value).isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail('ABSOLUTE_WORKFLOW_PATH_REQUIRED');
  return pathApi(value).resolve(value);
}
function normalized(value) {
  const result = absolute(value).normalize('NFC');
  return pathApi(value) === win32 ? result.replaceAll('/', '\\').toLowerCase().replace(/\\+$/u, '') : result.replace(/\/+$/u, '');
}
const within = (root, file) => {
  const a = normalized(root), b = normalized(file), separator = pathApi(root).sep;
  return b === a || b.startsWith(a + separator);
};
const rawSourceKey = root => 'source-' + createHash('sha256').update(root.normalize('NFC').replaceAll('/', '\\').toLowerCase()).digest('hex').slice(0, 24);
export const historySourceKey = root => rawSourceKey(absolute(root));

function decodeCopy(value) {
  if (value === '\\N') return null;
  const input = Buffer.from(value, 'utf8'), out = [];
  const escapes = { 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11, 92: 92 };
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== 92) { out.push(input[i]); continue; }
    if (++i >= input.length) fail('INVALID_COPY_ESCAPE');
    if (escapes[input[i]] !== undefined) { out.push(escapes[input[i]]); continue; }
    if (input[i] >= 48 && input[i] <= 55) {
      let octal = String.fromCharCode(input[i]);
      while (octal.length < 3 && input[i + 1] >= 48 && input[i + 1] <= 55) octal += String.fromCharCode(input[++i]);
      const byte = parseInt(octal, 8); if (byte > 255) fail('INVALID_COPY_ESCAPE'); out.push(byte); continue;
    }
    if (input[i] === 120) {
      let hex = '';
      while (hex.length < 2 && i + 1 < input.length && /[a-f0-9]/iu.test(String.fromCharCode(input[i + 1]))) hex += String.fromCharCode(input[++i]);
      if (!hex) fail('INVALID_COPY_ESCAPE'); out.push(parseInt(hex, 16)); continue;
    }
    out.push(input[i]);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(out)); }
  catch { fail('INVALID_COPY_UTF8'); }
}

export function parsePgCopy(text) {
  if (typeof text !== 'string') fail('INVALID_COPY_INPUT');
  const tables = Object.create(null);
  let table = null, columns = null;
  for (const line of text.split(/\r?\n/u)) {
    if (table) {
      if (line === '\\.') { table = null; columns = null; continue; }
      const values = line.split('\t'); if (values.length !== columns.length) fail('COPY_COLUMN_COUNT');
      tables[table].push(Object.fromEntries(columns.map((column, i) => [column, decodeCopy(values[i])])));
      continue;
    }
    if (!line.startsWith('COPY ')) continue; // other SQL is data, never executed
    const match = /^COPY (public\.[a-z_][a-z0-9_]*) \(([a-z0-9_, ]+)\) FROM stdin;$/u.exec(line);
    if (!match) fail('UNSUPPORTED_COPY_HEADER');
    table = match[1]; columns = match[2].split(',').map(c => c.trim());
    if (tables[table]) fail('DUPLICATE_COPY_TABLE');
    if (new Set(columns).size !== columns.length || columns.some(c => !/^[a-z_][a-z0-9_]*$/u.test(c))) fail('INVALID_COPY_COLUMNS');
    tables[table] = [];
  }
  if (table) fail('UNTERMINATED_COPY');
  return tables;
}

function index(rows, key) {
  if (!Array.isArray(rows)) fail('PORTAL_TABLE_REQUIRED');
  const result = new Map();
  for (const row of rows) { const value = id(row[key]); if (result.has(value)) fail('DUPLICATE_PORTAL_ROW'); result.set(value, row); }
  return result;
}
function portalMetadata(tables) {
  const blobs = index(tables['public.blob'], 'sha256'), contracts = index(tables['public.contract'], 'id');
  const documents = index(tables['public.document'], 'id'), revisions = index(tables['public.document_revision'], 'id');
  const entries = [];
  for (const revision of revisions.values()) {
    if (revision.contract_id === null) continue;
    const document = documents.get(revision.document_id), blob = blobs.get(revision.blob_sha256);
    if (!document || !blob || !contracts.has(revision.contract_id)) fail('INVALID_PORTAL_REFERENCE');
    if (document.contract_id !== revision.contract_id) fail('PORTAL_SCOPE_INCONSISTENT');
    const sha256 = hash(blob.sha256), bytes = size(blob.size_bytes);
    const storageKey = `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    if (blob.storage_key !== storageKey) fail('INVALID_BLOB_STORAGE_KEY');
    entries.push({ scopeId: id(revision.contract_id), documentId: id(revision.document_id), revisionId: id(revision.id), sha256, bytes, storageKey });
  }
  return entries;
}
export function preparePortalReads({ tables, filesRoot }) {
  const root = absolute(filesRoot), entries = portalMetadata(tables), files = Object.create(null);
  for (const entry of entries) files[entry.revisionId] = { fileId: entry.revisionId, sourceId: entry.scopeId, path: pathApi(root).join(root, ...entry.storageKey.split('/')), size: entry.bytes };
  return { registry: { files }, sourceCatalog: { sources: [...new Set(entries.map(e => e.scopeId))].sort().map(sourceId => ({ sourceId, roots: [root] })) } };
}
export function buildPortalInventory({ tables, physical, backup }) {
  const entries = portalMetadata(tables);
  auditLocusCorpus({ locus: physical });
  const reads = new Map(physical.documents.map(d => [d.entryId, d]));
  const expected = new Map(entries.map(d => [d.revisionId, d]));
  if (reads.size !== physical.documents.length) fail('DUPLICATE_PHYSICAL_REVISION');
  for (const [key, read] of reads) if (!expected.has(key) || read.sourceId !== expected.get(key).scopeId) fail('PHYSICAL_SCOPE_MISMATCH');
  let mismatches = 0, unknown = 0;
  const documents = entries.map(entry => {
    const read = reads.get(entry.revisionId);
    if (!read || read.sha256 === null || read.bytes === null) unknown++;
    else if (read.sha256 !== entry.sha256 || read.bytes !== entry.bytes) mismatches++;
    return { scopeId: entry.scopeId, documentId: entry.documentId, revisionId: entry.revisionId, sha256: read?.sha256 ?? null, bytes: read?.bytes ?? null };
  });
  const snapshotId = 'backup-' + hash(backup?.dump?.sha256), capturedAt = backup?.finishedAt;
  const portal = { schemaVersion: 1, system: 'portal', snapshotId, capturedAt, complete: false,
    errors: ['BACKUP_SNAPSHOT_ONLY', 'LIVE_STATE_NOT_FROZEN', ...(mismatches ? ['BACKUP_BLOB_MISMATCH'] : []), ...(unknown ? ['BACKUP_BLOB_UNVERIFIED'] : [])], documents,
    physicalBlobVerification: { checked: entries.length - unknown, mismatches, unknown } };
  auditLocusCorpus({ locus: physical, portal });
  return portal;
}
function registryIndex(registry) {
  if (!registry?.files || typeof registry.files !== 'object' || Array.isArray(registry.files)) fail('INVALID_WORKFLOW_REGISTRY');
  const result = new Map();
  for (const [key, row] of Object.entries(registry.files)) {
    const identity = tuple(id(row.sourceId), id(row.fileId ?? key));
    if (result.has(identity)) fail('DUPLICATE_REGISTRY_ID');
    result.set(identity, { ...row, path: absolute(row.path) });
  }
  return result;
}
function configuredRoots(catalog) {
  if (!Array.isArray(catalog?.sources)) fail('INVALID_WORKFLOW_SOURCES');
  const roots = new Map();
  for (const source of catalog.sources) {
    const key = id(source.sourceId); if (roots.has(key) || !Array.isArray(source.roots)) fail('INVALID_WORKFLOW_SOURCES');
    roots.set(key, source.roots.map(absolute));
  }
  return roots;
}
function bindingFolders(bindings, roots) {
  if (!Array.isArray(bindings)) fail('HISTORY_BINDINGS_REQUIRED');
  const anchors = new Map();
  for (const list of roots.values()) for (const root of list) {
    const api = pathApi(root);
    for (let current = root; ; current = api.dirname(current)) {
      for (const candidate of [current, current.replace(/[\\/]+$/u, '')]) {
        const key = rawSourceKey(candidate), previous = anchors.get(key);
        if (previous && normalized(previous) !== normalized(current)) fail('AMBIGUOUS_HISTORY_ANCHOR');
        anchors.set(key, current);
      }
      if (api.dirname(current) === current) break;
    }
  }
  const folders = [];
  for (const binding of bindings) {
    const folder = binding.folder_path;
    if (typeof folder !== 'string' || !folder || win32.isAbsolute(folder) || posix.isAbsolute(folder) || /[:\u0000-\u001f]/u.test(folder) || folder.split(/[\\/]/u).includes('..')) fail('INVALID_HISTORY_FOLDER');
    const anchor = anchors.get(binding.source_key);
    if (!anchor) continue;
    const path = pathApi(anchor).join(anchor, ...folder.split(/[\\/]/u));
    if (!within(anchor, path)) fail('INVALID_HISTORY_FOLDER');
    folders.push({ path, scopeId: id(binding.contract_id), bindingId: id(binding.id), sourceKey: binding.source_key });
  }
  return folders;
}

export function buildCorpusCandidates({ locus, registry, portal, sourceCatalog, bindings }) {
  auditLocusCorpus({ locus, portal });
  const raw = registryIndex(registry), roots = configuredRoots(sourceCatalog), folders = bindingFolders(bindings, roots);
  if (raw.size !== locus.documents.length) fail('REGISTRY_INVENTORY_MISMATCH');
  const byBlob = new Map();
  for (const target of portal.documents) {
    if (target.sha256 === null || target.bytes === null) continue;
    const key = tuple(target.sha256, target.bytes);
    if (!byBlob.has(key)) byBlob.set(key, []);
    byBlob.get(key).push(target);
  }
  const classification = [], links = [], counts = Object.create(null);
  for (const source of locus.documents) {
    const original = raw.get(tuple(source.sourceId, source.entryId)); if (!original) fail('REGISTRY_INVENTORY_MISMATCH');
    const row = { sourceId: source.sourceId, entryId: source.entryId };
    if (source.sha256 === null || source.bytes === null) row.status = 'SOURCE_NOT_HASHED';
    else if (!(roots.get(source.sourceId) ?? []).some(root => within(root, original.path))) row.status = 'SCOPE_UNMAPPED';
    else {
      // Scope comes ONLY from the original's folder binding, before the hash target lookup.
      const matches = folders.filter(folder => within(folder.path, original.path));
      const depth = matches.length ? Math.max(...matches.map(m => normalized(m.path).length)) : 0;
      const specific = matches.filter(m => normalized(m.path).length === depth);
      const scopes = new Set(specific.map(m => m.scopeId));
      const candidates = byBlob.get(tuple(source.sha256, source.bytes)) ?? [];
      if (scopes.size !== 1) { row.status = scopes.size ? 'SCOPE_AMBIGUOUS' : 'SCOPE_UNMAPPED'; row.sameBlobCandidates = candidates.length; }
      else {
        row.scopeId = [...scopes][0];
        row.scopeEvidence = specific.map(m => ({ bindingId: m.bindingId, sourceKey: m.sourceKey }));
        const scoped = candidates.filter(c => c.scopeId === row.scopeId);
        if (scoped.length === 1) {
          const target = scoped[0];
          const link = { sourceId: source.sourceId, entryId: source.entryId, scopeId: row.scopeId, documentId: target.documentId, revisionId: target.revisionId };
          links.push(link); Object.assign(row, link); row.status = 'SCOPED_HASH_CANDIDATE';
        } else if (scoped.length) row.status = 'TARGET_AMBIGUOUS';
        else if (candidates.length) { row.status = 'BLOB_ONLY_IN_OTHER_SCOPE'; row.sameBlobCandidates = candidates.length; }
        else row.status = 'NO_EQUAL_BLOB_IN_BACKUP_CONTRACTS';
      }
    }
    counts[row.status] = (counts[row.status] ?? 0) + 1; classification.push(row);
  }
  return { classification, counts, anchoredBindings: folders.length,
    crosswalk: { schemaVersion: 2, locusSnapshotId: locus.snapshotId, portalSnapshotId: portal.snapshotId, scopes: [], documents: links,
      mappingBasis: 'CANDIDATE_EXISTING_CONTRACT_HISTORY_BINDING_ROOT_AND_HASH', humanReviewed: false } };
}
export function buildStagingPlan({ locus, registry, classification }) {
  const raw = registryIndex(registry), documents = new Map(locus.documents.map(d => [tuple(d.sourceId, d.entryId), d]));
  const files = new Map(), identities = new Set();
  for (const row of classification) {
    const key = tuple(id(row.sourceId), id(row.entryId)); if (identities.has(key)) fail('DUPLICATE_CLASSIFICATION'); identities.add(key);
    if (row.status !== 'NO_EQUAL_BLOB_IN_BACKUP_CONTRACTS') continue;
    const source = documents.get(key), original = raw.get(key); if (!source || !original) fail('REGISTRY_INVENTORY_MISMATCH');
    const sha256 = hash(source.sha256), bytes = size(source.bytes);
    if (files.has(sha256) && files.get(sha256).bytes !== bytes) fail('HASH_SIZE_CONFLICT');
    if (!files.has(sha256)) files.set(sha256, { sha256, bytes, sourceId: row.sourceId, sourcePath: original.path, logicalEntries: [] });
    files.get(sha256).logicalEntries.push({ sourceId: row.sourceId, entryId: row.entryId, candidateScopeId: id(row.scopeId) });
  }
  return { schemaVersion: 1, target: 'ISOLATED_BLOB_STAGING_ONLY', sourceSnapshotId: locus.snapshotId, files: [...files.values()],
    totalBytes: [...files.values()].reduce((n, f) => n + f.bytes, 0), logicalEntries: [...files.values()].reduce((n, f) => n + f.logicalEntries.length, 0), retirementAllowed: false, documentsRegistered: false };
}
