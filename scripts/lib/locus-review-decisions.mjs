// Owner review is separate from corpus/import/freeze acceptance. No execution or automatic decisions.
import { fingerprint, fileUnitId } from './locus-review-fingerprint.mjs';
export { fingerprint, fileUnitId } from './locus-review-fingerprint.mjs';
const fail = code => { throw new Error(code); };
const hash = value => /^[a-f0-9]{64}$/u.test(value ?? '');
const text = value => typeof value === 'string' && value.trim().length > 0;
function checkPackage(pkg) {
  const { packageId, ...payload } = pkg;
  if (pkg.schemaVersion !== 1 || fingerprint(payload) !== packageId) fail('REVIEW_PACKAGE_TAMPERED');
}
export function createReviewPackage({ report, fileReview = { units: [], groups: [] } }) {
  if (!Array.isArray(report?.rows) || !Array.isArray(fileReview.units) || !Array.isArray(fileReview.groups)) fail('INVALID_REVIEW_PACKAGE_INPUT');
  const seen = new Set();
  const registry = report.rows.map(row => {
    const itemId = 'registry-' + fingerprint([row.sourceId, row.entryId]);
    if (seen.has(itemId)) fail('DUPLICATE_REVIEW_ID'); seen.add(itemId);
    return { itemId, fingerprint: fingerprint(row), row,
      targets: (row.targets ?? []).map(value => ({ ...value, fingerprint: fingerprint(value) })),
      originals: (row.originalCandidates ?? []).map(value => ({ ...value, fingerprint: fingerprint(value) })) };
  });
  const files = fileReview.units.map(unit => {
    const itemId = fileUnitId(unit); if (seen.has(itemId)) fail('DUPLICATE_REVIEW_ID'); seen.add(itemId);
    return { ...unit, itemId, fingerprint: fingerprint(unit) };
  });
  const filesByPath = new Map(files.map(f => [JSON.stringify([f.rootId, f.path]), f]));
  const grouped = new Set(), groupIds = new Set();
  const groups = fileReview.groups.map(group => {
    if (!text(group.groupId) || groupIds.has(group.groupId)) fail('DUPLICATE_REVIEW_GROUP'); groupIds.add(group.groupId);
    const members = (group.memberPaths ?? []).map(path => {
      const member = filesByPath.get(JSON.stringify([group.rootId, path]));
      if (!member || grouped.has(member.itemId)) fail('GROUP_MEMBER_MISSING_OR_OVERLAPPING'); grouped.add(member.itemId);
      return { itemId: member.itemId, fingerprint: member.fingerprint };
    }).sort((a, b) => a.itemId.localeCompare(b.itemId));
    if (!members.length) fail('EMPTY_REVIEW_GROUP');
    return { ...group, members, fingerprint: fingerprint({ ...group, members }) };
  });
  const scopes = new Map((report.scopeCatalog ?? []).map(s => [s.id, s]));
  for (const item of registry) {
    if (item.row.scope?.id) scopes.set(item.row.scope.id, item.row.scope);
    for (const target of item.targets) if (!scopes.has(target.scopeId)) scopes.set(target.scopeId, { id: target.scopeId });
  }
  const payload = { schemaVersion: 1, purpose: 'OWNER_REVIEW_PACKAGE_NOT_GATE_A',
    sourceSnapshots: { locusSnapshotId: report.locusSnapshotId, portalSnapshotId: report.portalSnapshotId, inputSha256: report.inputSha256 ?? {}, fileReviewInputs: fileReview.inputSha256 ?? {}, roots: fileReview.roots ?? [] },
    registry, files, groups, scopeCatalog: [...scopes.values()].sort((a, b) => a.id.localeCompare(b.id)), retirementAllowed: false };
  return { ...payload, packageId: fingerprint(payload) };
}
const empty = item => ({ itemId: item.itemId, fingerprint: item.fingerprint, action: null, reason: null, targetFingerprint: null, originalFingerprint: null, scopeId: item.row?.scope?.id ?? item.scopeId ?? null, scopeEvidenceRef: null });
export function createDecisionTemplate(pkg) {
  checkPackage(pkg);
  const covered = new Set(pkg.groups.flatMap(g => g.members.map(m => m.itemId)));
  return { schemaVersion: 1, kind: 'OWNER_REVIEW_DECISIONS', reviewPackageId: pkg.packageId, owner: { name: '', decidedAt: null },
    registry: pkg.registry.map(empty), files: pkg.files.filter(f => !covered.has(f.itemId)).map(empty),
    groups: pkg.groups.map(g => ({ itemId: g.groupId, fingerprint: g.fingerprint, action: null, reason: null, scopeId: null, scopeEvidenceRef: null })) };
}
export function validateReviewDecisions({ reviewPackage: pkg, decisions, approval = null, decisionSha256 = null }) {
  checkPackage(pkg);
  const issues = [], covered = new Set(), matches = [], withdrawals = [], imports = [], includedFiles = [], excludedFiles = [];
  const issue = (code, itemId = null) => issues.push({ code, itemId });
  if (decisions?.schemaVersion !== 1 || decisions?.kind !== 'OWNER_REVIEW_DECISIONS') fail('INVALID_DECISION_DOCUMENT');
  if (decisions.reviewPackageId !== pkg.packageId) issue('PACKAGE_CHANGED');
  const ownerValid = text(decisions.owner?.name) && Number.isFinite(Date.parse(decisions.owner?.decidedAt));
  const scopes = new Set(pkg.scopeCatalog.map(s => s.id));
  const registry = new Map(pkg.registry.map(x => [x.itemId, x])), files = new Map(pkg.files.map(x => [x.itemId, x])), groups = new Map(pkg.groups.map(x => [x.groupId, x]));
  const seen = new Set();
  function binding(decision, map) {
    if (!text(decision?.itemId) || seen.has(decision.itemId)) { issue('DUPLICATE_DECISION', decision?.itemId); return null; }
    seen.add(decision.itemId);
    const item = map.get(decision.itemId);
    if (!item) { issue('UNKNOWN_DECISION', decision.itemId); return null; }
    if (decision.fingerprint !== item.fingerprint) { issue('BINDING_CHANGED', decision.itemId); return null; }
    if (!decision.action || decision.action === 'DEFER') return null;
    if (!ownerValid) { issue('OWNER_METADATA_REQUIRED', decision.itemId); return null; }
    if (!text(decision.reason)) { issue('DECISION_REASON_REQUIRED', decision.itemId); return null; }
    return item;
  }
  for (const d of decisions.registry ?? []) {
    const item = binding(d, registry); if (!item) continue;
    const row = item.row;
    if (d.action === 'WITHDRAW') { withdrawals.push({ sourceId: row.sourceId, entryId: row.entryId, reason: d.reason }); covered.add(item.itemId); }
    else if (d.action === 'ACCEPT_MATCH') {
      const target = item.targets.find(t => t.fingerprint === d.targetFingerprint);
      if (!target || !target.inOwnScope || !row.scope?.id || target.scopeId !== row.scope.id) { issue('TARGET_NOT_OWN_SCOPE', item.itemId); continue; }
      if (!hash(row.sha256) || target.sha256 !== row.sha256 || target.bytes !== row.bytes) { issue('TARGET_ORIGINAL_MISMATCH', item.itemId); continue; }
      matches.push({ sourceId: row.sourceId, entryId: row.entryId, scopeId: target.scopeId, documentId: target.documentId, revisionId: target.revisionId }); covered.add(item.itemId);
    } else if (d.action === 'IMPORT_REQUIRED') {
      const original = d.originalFingerprint ? item.originals.find(o => o.fingerprint === d.originalFingerprint) : { sha256: row.sha256, bytes: row.bytes, path: row.readPath ?? row.originalPath };
      if (!original || !hash(original.sha256) || !Number.isSafeInteger(original.bytes) || original.bytes < 0) { issue('IMPORT_ORIGINAL_UNVERIFIED', item.itemId); continue; }
      if (!scopes.has(d.scopeId) || (row.scope?.id && row.scope.id !== d.scopeId) || (!row.scope?.id && !text(d.scopeEvidenceRef))) { issue('IMPORT_SCOPE_NOT_CONFIRMED', item.itemId); continue; }
      if (d.targetFingerprint) { issue('UNEXPECTED_EXISTING_TARGET', item.itemId); continue; }
      imports.push({ kind: 'registry', itemId: item.itemId, sourceId: row.sourceId, entryId: row.entryId, scopeId: d.scopeId, scopeEvidenceRef: d.scopeEvidenceRef, original, reason: d.reason }); covered.add(item.itemId);
    } else issue('INVALID_REGISTRY_ACTION', item.itemId);
  }
  const verifiedFile = file => hash(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && text(file.path);
  const fileScope = file => file.scopeId ?? file.scope?.id;
  function coverFile(file, d, groupId = null) {
    if (covered.has(file.itemId)) { issue('OVERLAPPING_FILE_DECISIONS', file.itemId); return; }
    if (d.action === 'INCLUDE_ORIGINAL') {
      if (!verifiedFile(file)) { issue('UNVERIFIED_FILE_INCLUDED', file.itemId); return; }
      if (!scopes.has(d.scopeId) || !text(d.scopeEvidenceRef) || (fileScope(file) && fileScope(file) !== d.scopeId)) { issue('FILE_SCOPE_NOT_CONFIRMED', file.itemId); return; }
      imports.push({ kind: 'file', itemId: file.itemId, rootId: file.rootId, groupId, scopeId: d.scopeId,
        scopeEvidenceRef: d.scopeEvidenceRef, original: { path: file.path, sha256: file.sha256, bytes: file.bytes }, reason: d.reason });
      includedFiles.push(file.itemId); covered.add(file.itemId);
    } else if (d.action === 'EXCLUDE_NON_CORPUS') { excludedFiles.push({ itemId: file.itemId, reason: d.reason }); covered.add(file.itemId); }
    else issue('INVALID_FILE_ACTION', file.itemId);
  }
  for (const d of decisions.groups ?? []) {
    const group = binding(d, groups); if (!group) continue;
    const members = group.members.map(member => files.get(member.itemId));
    if (d.action === 'INCLUDE_ORIGINAL') {
      if (members.some(file => fileScope(file) && fileScope(file) !== d.scopeId)) { issue('GROUP_SCOPE_MISMATCH', d.itemId); continue; }
      if (!scopes.has(d.scopeId) || !text(d.scopeEvidenceRef)) { issue('FILE_SCOPE_NOT_CONFIRMED', d.itemId); continue; }
      if (members.some(file => !verifiedFile(file))) { issue('UNVERIFIED_FILE_INCLUDED', d.itemId); continue; }
    }
    for (const file of members) coverFile(file, d, group.groupId);
  }
  for (const d of decisions.files ?? []) { const file = binding(d, files); if (file) coverFile(file, d); }
  const missing = [...pkg.registry, ...pkg.files].filter(x => !covered.has(x.itemId)).map(x => x.itemId);
  const coverageComplete = issues.length === 0 && missing.length === 0;
  const approvalValid = approval?.kind === 'OWNER_REVIEW_APPROVAL' && approval.reviewPackageId === pkg.packageId && hash(decisionSha256) && approval.decisionSha256 === decisionSha256 && approval.owner === decisions.owner?.name && text(approval.evidenceRef) && Date.parse(approval.approvedAt) >= Date.parse(decisions.owner?.decidedAt);
  const humanReviewed = coverageComplete && approvalValid === true;
  return { schemaVersion: 1, coverageComplete, humanReviewed, approvalValid: approvalValid === true, issues, missing,
    counts: { registry: pkg.registry.length, files: pkg.files.length, covered: covered.size, missing: missing.length }, withdrawals, imports, includedFiles, excludedFiles,
    importPlan: { schemaVersion: 1, purpose: 'OWNER_IMPORT_PROPOSALS_NOT_EXECUTION', operations: imports, ownerReviewed: humanReviewed, executable: false },
    reviewedCrosswalk: { schemaVersion: 2, locusSnapshotId: pkg.sourceSnapshots.locusSnapshotId, portalSnapshotId: pkg.sourceSnapshots.portalSnapshotId, scopes: [], documents: matches, humanReviewed },
    frozenPairAccepted: false, retirementAllowed: false };
}
export function reconcileReviewDecisions({ previousPackage, nextPackage, decisions }) {
  checkPackage(previousPackage); checkPackage(nextPackage);
  if (decisions.reviewPackageId !== previousPackage.packageId) fail('RECONCILE_SOURCE_PACKAGE_CHANGED');
  const next = createDecisionTemplate(nextPackage), invalidated = [], carried = [];
  next.owner = structuredClone(decisions.owner);
  for (const kind of ['registry', 'files', 'groups']) {
    const previous = new Map();
    for (const old of decisions[kind] ?? []) { if (previous.has(old.itemId)) fail('DUPLICATE_DECISION'); previous.set(old.itemId, old); }
    for (let i = 0; i < next[kind].length; i++) {
      const current = next[kind][i], old = previous.get(current.itemId); if (!old) continue;
      if (old.fingerprint === current.fingerprint) { next[kind][i] = structuredClone(old); if (old.action) carried.push({ kind, itemId: old.itemId }); }
      else if (old.action) invalidated.push({ kind: kind === 'groups' ? 'group' : kind, itemId: old.itemId, reason: 'BINDING_CHANGED' });
      previous.delete(current.itemId);
    }
    for (const old of previous.values()) if (old.action) invalidated.push({ kind: kind === 'groups' ? 'group' : kind, itemId: old.itemId, reason: 'REMOVED_FROM_NEW_SNAPSHOT' });
  }
  return { decisions: next, carried, invalidated, previousPackageId: previousPackage.packageId, nextPackageId: nextPackage.packageId, approval: null, humanReviewed: false, retirementAllowed: false };
}
