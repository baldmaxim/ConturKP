// Every discovered file remains in a ledger. Categories are suggestions, never owner decisions.
import { win32, posix } from 'node:path';
import { fingerprint } from './locus-review-fingerprint.mjs';
const api = path => win32.isAbsolute(path) && (path[1] === ':' || path.startsWith(String.fromCharCode(92, 92))) ? win32 : posix;
const hash = value => /^[a-f0-9]{64}$/u.test(value ?? '');
export function classifyDataFile(root, path) {
  const relativePath = api(path).relative(root, path).replaceAll(String.fromCharCode(92), '/');
  const parts = relativePath.toLowerCase().split('/'), extension = api(path).extname(path).toLowerCase();
  if (parts[0] === 'md-cache' && extension === '.md') return 'DERIVED_MD_CACHE_CANDIDATE';
  if (parts[0] === 'ocr-cache' && ['.json', '.traineddata'].includes(extension)) return 'OCR_CACHE_CANDIDATE';
  if (parts[0] === 'qdrant' && ['', '.dat', '.json', '.bin', '.mmap', '.info', '.mappings', '.versions', '.deleted'].includes(extension)) return 'INDEX_STATE_CANDIDATE';
  const state = parts.at(-1);
  if (parts[0] === 'state' && (/^(?:app-state|evidence)\.sqlite(?:-shm|-wal)?$/u.test(state) || /^(?:agent-runs|audit-runs|chunks|jobs|manifest|source-summaries|vectors)\.json$/u.test(state) || /^manifest\.json\..*\.tmp$/u.test(state) || state === 'daily-agent.lock')) return 'RUNTIME_STATE_CANDIDATE';
  return 'POTENTIAL_ORIGINAL';
}
export function buildFileReview({ walk, unindexedFiles = [], folderDepth = 1, inputSha256 = {} }) {
  if (!Number.isInteger(folderDepth) || folderDepth < 0 || folderDepth > 8 || !Array.isArray(walk?.roots) || !Array.isArray(walk.entries)) throw new Error('INVALID_FILE_REVIEW_INPUT');
  const roots = new Map(walk.roots.map(r => [r.rootId, r])), units = [], seen = new Set();
  function add(row, kind) {
    const root = roots.get(row.rootId); if (!root) throw new Error('FILE_REVIEW_ROOT_UNKNOWN');
    const dialect = api(row.path), relativePath = dialect.relative(root.path, row.path).replaceAll(String.fromCharCode(92), '/');
    if (relativePath === '..' || relativePath.startsWith('../') || dialect.isAbsolute(relativePath)) throw new Error('FILE_REVIEW_PATH_ESCAPE');
    const id = JSON.stringify([row.rootId, row.path]); if (seen.has(id)) return; seen.add(id);
    const category = row.type === 'walk_error' ? 'UNRESOLVED_WALK_ERROR' : root.kind === 'data_metadata' ? classifyDataFile(root.path, row.path) : 'UNINDEXED_SOURCE_FILE';
    units.push({ rootId: row.rootId, path: row.path, relativePath, kind, category, extension: row.type === 'walk_error' ? '(error)' : dialect.extname(row.path).toLowerCase() || '(none)',
      bytes: row.bytes ?? null, sha256: hash(row.sha256) ? row.sha256 : null, mtimeNs: row.mtimeNs ?? null, ctimeNs: row.ctimeNs ?? null, identity: row.identity ?? null, errorCode: row.errorCode ?? null });
  }
  for (const row of walk.entries) if (row.type === 'file' && roots.get(row.rootId)?.kind === 'data_metadata') add(row, 'active_data');
  const entryMap = new Map();
  for (const row of walk.entries) if (row.type === 'file') {
    if (!entryMap.has(row.path)) entryMap.set(row.path, []); entryMap.get(row.path).push(row);
  }
  for (const file of unindexedFiles) {
    const candidates = entryMap.get(file.path) ?? [];
    if (!candidates.length) throw new Error('UNINDEXED_FILE_NOT_IN_WALK');
    for (const row of candidates) if (roots.get(row.rootId)?.kind === 'originals') add(row, 'unindexed_source');
  }
  for (const error of walk.errors ?? []) add({ rootId: error.rootId, path: error.path, type: 'walk_error', errorCode: error.code }, 'walk_error');
  const groups = new Map(), census = new Map();
  for (const file of units) {
    const folder = file.relativePath.split('/').slice(0, -1).slice(0, folderDepth).join('/') || '.';
    const selector = { rootId: file.rootId, folder, extension: file.extension, category: file.category, kind: file.kind };
    const groupId = 'group-' + fingerprint(selector);
    if (!groups.has(groupId)) groups.set(groupId, { ...selector, groupId, memberPaths: [], totalBytes: 0, hashedFiles: 0 });
    const group = groups.get(groupId); group.memberPaths.push(file.path); group.totalBytes += file.bytes ?? 0; group.hashedFiles += file.sha256 ? 1 : 0;
    const key = JSON.stringify([file.rootId, file.relativePath.split('/')[0], file.extension, file.category]);
    if (!census.has(key)) census.set(key, { rootId: file.rootId, topFolder: file.relativePath.split('/')[0], extension: file.extension, category: file.category, files: 0, hashedFiles: 0, bytes: 0 });
    const row = census.get(key); row.files++; row.hashedFiles += file.sha256 ? 1 : 0; row.bytes += file.bytes ?? 0;
  }
  return { schemaVersion: 1, purpose: 'COMPLETE_FILE_DISPOSITION_LEDGER_NOT_GATE_A', roots: walk.roots, inputSha256, units,
    groups: [...groups.values()].map(g => ({ ...g, memberPaths: g.memberPaths.sort() })), census: [...census.values()],
    statistics: { totalUnits: units.length, activeDataFiles: units.filter(u => u.kind === 'active_data').length, unindexedSourceFiles: units.filter(u => u.kind === 'unindexed_source').length, walkErrors: units.filter(u => u.kind === 'walk_error').length, groups: groups.size,
      unhashedPotentialOriginals: units.filter(u => u.category === 'POTENTIAL_ORIGINAL' && !u.sha256).length },
    ownerDecisionsApplied: false, frozenPairAccepted: false, retirementAllowed: false };
}
