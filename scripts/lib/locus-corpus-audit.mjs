// Этап 19: сравнение объявленных снимков. Не открывает БД, не переносит файлы и не управляет сервисами.
export class LocusPreflightInputError extends Error {
  constructor(code) { super(code); this.name = 'LocusPreflightInputError'; this.code = code; }
}
const fail = code => { throw new LocusPreflightInputError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => {
  if (typeof value !== 'string' || !value.length || value !== value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_ID');
  return value;
};
const tuple = (...parts) => JSON.stringify(parts);
const digest = value => {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) fail('INVALID_HASH');
  return value.toLowerCase();
};
const bytes = value => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_BYTES');
  return value;
};
function inventory(input, system) {
  if (!record(input) || input.schemaVersion !== 1 || input.system !== system || typeof input.complete !== 'boolean' || !Array.isArray(input.errors) || !input.errors.every(error => typeof error === 'string') || !Array.isArray(input.documents)) fail('INVALID_INVENTORY');
  if (typeof input.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(input.capturedAt) || !Number.isFinite(Date.parse(input.capturedAt))) fail('INVALID_CAPTURE_TIME');
  const identities = new Set(), revisions = new Set();
  const documents = input.documents.map(raw => {
    if (!record(raw)) fail('INVALID_DOCUMENT');
    const value = system === 'locus'
      ? { sourceId: id(raw.sourceId), entryId: id(raw.entryId), sha256: digest(raw.sha256), bytes: bytes(raw.bytes) }
      : { scopeId: id(raw.scopeId), documentId: id(raw.documentId), revisionId: id(raw.revisionId), sha256: digest(raw.sha256), bytes: bytes(raw.bytes) };
    const key = system === 'locus' ? tuple(value.sourceId, value.entryId) : tuple(value.documentId, value.revisionId);
    if (identities.has(key) || (system === 'portal' && revisions.has(value.revisionId))) fail(system === 'locus' ? 'DUPLICATE_SOURCE_ID' : 'DUPLICATE_TARGET_ID');
    identities.add(key); if (system === 'portal') revisions.add(value.revisionId);
    return value;
  });
  return { snapshotId: id(input.snapshotId), capturedAt: input.capturedAt, complete: input.complete, errorCount: input.errors.length, documents };
}
function mapping(input) {
  if (!record(input) || ![1, 2].includes(input.schemaVersion) || !Array.isArray(input.scopes) || !Array.isArray(input.documents)) fail('INVALID_CROSSWALK');
  const scopes = new Map(), documents = new Map();
  for (const raw of input.scopes) {
    if (!record(raw)) fail('INVALID_SCOPE_MAPPING');
    const source = id(raw.sourceId), target = id(raw.scopeId);
    if (scopes.has(source)) fail('DUPLICATE_SCOPE_MAPPING');
    scopes.set(source, target);
  }
  for (const raw of input.documents) {
    if (!record(raw)) fail('INVALID_DOCUMENT_MAPPING');
    if (input.schemaVersion === 2 && raw.scopeId === undefined) fail('INVALID_DOCUMENT_SCOPE_MAPPING');
    const value = { sourceId: id(raw.sourceId), entryId: id(raw.entryId), documentId: id(raw.documentId), revisionId: id(raw.revisionId), ...(input.schemaVersion === 2 ? { scopeId: id(raw.scopeId) } : {}) };
    const key = tuple(value.sourceId, value.entryId);
    if (documents.has(key)) fail('DUPLICATE_MAPPING');
    documents.set(key, value);
  }
  if (input.schemaVersion === 2 && input.scopes.length) fail('V2_SCOPES_MUST_BE_EMPTY');
  return { version: input.schemaVersion, locusSnapshotId: id(input.locusSnapshotId), portalSnapshotId: id(input.portalSnapshotId), scopes, documents };
}

export function auditLocusCorpus(input) {
  const locus = inventory(input?.locus, 'locus');
  const portal = input.portal == null ? null : inventory(input.portal, 'portal');
  const result = {
    schemaVersion: 1, mode: 'OFFLINE_MANIFEST_COMPARISON', comparison: 'NOT_RUN',
    liveVerification: 'NOT_RUN', retirementAllowed: false,
    snapshots: { locus: locus.snapshotId, portal: portal?.snapshotId ?? null },
    summary: {
      locusEntries: locus.documents.length, portalEntries: portal?.documents.length ?? null,
      sourceHashesUnverified: locus.documents.filter(value => value.sha256 === null).length,
      matched: null, notMatched: null, issueCount: 0,
    },
    issues: [],
  };
  const issue = (code, detail = {}) => result.issues.push({ code, ...detail });
  const finish = comparison => { result.comparison = comparison; result.summary.issueCount = result.issues.length; return result; };
  let incomplete = false;
  if (!locus.complete || locus.errorCount) { issue('SOURCE_INCOMPLETE', { errorCount: locus.errorCount }); incomplete = true; }
  if (!locus.documents.length) { issue('EMPTY_SOURCE'); incomplete = true; }
  if (!portal) { issue('PORTAL_INVENTORY_REQUIRED'); return finish('NOT_RUN'); }
  if (!portal.complete || portal.errorCount) { issue('TARGET_INCOMPLETE', { errorCount: portal.errorCount }); incomplete = true; }
  if (input.crosswalk == null) { issue('CROSSWALK_REQUIRED'); return finish('NOT_RUN'); }
  const crosswalk = mapping(input.crosswalk);
  if (crosswalk.locusSnapshotId !== locus.snapshotId || crosswalk.portalSnapshotId !== portal.snapshotId) {
    issue('CROSSWALK_SNAPSHOT_MISMATCH'); return finish('INCOMPLETE');
  }
  const sources = new Map(locus.documents.map(value => [tuple(value.sourceId, value.entryId), value]));
  const targets = new Map(portal.documents.map(value => [tuple(value.documentId, value.revisionId), value]));
  const targetUse = new Map();
  for (const [key, value] of crosswalk.documents) {
    if (!sources.has(key)) issue('UNKNOWN_SOURCE_MAPPING', { source: { sourceId: value.sourceId, entryId: value.entryId } });
    const target = tuple(value.documentId, value.revisionId);
    targetUse.set(target, (targetUse.get(target) ?? 0) + 1);
  }
  const reused = new Set([...targetUse].filter(([, count]) => count > 1).map(([key]) => key));
  for (const key of reused) issue('TARGET_REUSED', { target: JSON.parse(key), mappings: targetUse.get(key) });
  result.summary.matched = 0;
  for (const [key, source] of sources) {
    const identity = { sourceId: source.sourceId, entryId: source.entryId };
    const link = crosswalk.documents.get(key);
    if (!link) { issue('SOURCE_UNMAPPED', { source: identity }); continue; }
    const scope = crosswalk.version === 2 ? link.scopeId : crosswalk.scopes.get(source.sourceId);
    if (!scope) { issue('SOURCE_SCOPE_UNMAPPED', { source: identity }); continue; }
    const targetKey = tuple(link.documentId, link.revisionId), target = targets.get(targetKey);
    if (!target) { issue('TARGET_REVISION_NOT_FOUND', { source: identity }); continue; }
    if (reused.has(targetKey)) continue;
    let valid = true;
    if (target.scopeId !== scope) { issue('TARGET_SCOPE_MISMATCH', { source: identity }); valid = false; }
    if (source.sha256 === null || target.sha256 === null) { issue('ORIGINAL_HASH_UNVERIFIED', { source: identity }); valid = false; incomplete = true; }
    else if (source.sha256 !== target.sha256) { issue('CONTENT_HASH_MISMATCH', { source: identity }); valid = false; }
    if (source.bytes === null || target.bytes === null) { issue('ORIGINAL_SIZE_UNVERIFIED', { source: identity }); valid = false; incomplete = true; }
    else if (source.bytes !== target.bytes) { issue('CONTENT_SIZE_MISMATCH', { source: identity }); valid = false; }
    if (valid) result.summary.matched++;
  }
  result.summary.notMatched = locus.documents.length - result.summary.matched;
  return finish(incomplete ? 'INCOMPLETE' : result.issues.length ? 'DIFFERENCES' : 'MATCH');
}
