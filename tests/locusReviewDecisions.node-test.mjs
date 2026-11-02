import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReviewPackage, createDecisionTemplate, validateReviewDecisions, reconcileReviewDecisions } from '../scripts/lib/locus-review-decisions.mjs';
const h = 'a'.repeat(64);
function sample() {
  const target = { scopeId: 'A', documentId: 'd', revisionId: 'v', sha256: h, bytes: 10, inOwnScope: true };
  const report = { locusSnapshotId: 'l1', portalSnapshotId: 'p1', rows: [
    { sourceId: 's', entryId: 'a', sha256: h, bytes: 10, scope: { id: 'A' }, targets: [target], originalCandidates: [], classification: 'SCOPED_HASH_CANDIDATE' },
    { sourceId: 's', entryId: 'b', sha256: null, bytes: null, scope: null, targets: [], originalCandidates: [], classification: 'SOURCE_NOT_HASHED' }
  ] };
  return { report, fileReview: { units: [{ rootId: 'r', path: '/root/cache.json', relativePath: 'cache.json', sha256: null, bytes: 12, category: 'CACHE_CANDIDATE' }], groups: [] } };
}
function filled(pkg) {
  const d = createDecisionTemplate(pkg); d.owner = { name: 'Fixture Owner', decidedAt: '2026-11-02T10:00:00Z' };
  d.registry[0].action = 'ACCEPT_MATCH'; d.registry[0].targetFingerprint = pkg.registry[0].targets[0].fingerprint; d.registry[0].reason = 'Verified own source';
  d.registry[1].action = 'WITHDRAW'; d.registry[1].reason = 'Owner documents retirement';
  d.files[0].action = 'EXCLUDE_NON_CORPUS'; d.files[0].reason = 'Generated cache';
  return d;
}
function approve(pkg, d) {
  const decisionSha256 = createHash('sha256').update(JSON.stringify(d)).digest('hex');
  const approval = { kind: 'OWNER_REVIEW_APPROVAL', reviewPackageId: pkg.packageId, decisionSha256, owner: 'Fixture Owner', approvedAt: '2026-11-02T10:01:00Z', evidenceRef: 'owner-approval:fixture' };
  return { reviewPackage: pkg, decisions: d, approval, decisionSha256 };
}
test('empty template never reviews or covers records and keeps every file identity', () => {
  const pkg = createReviewPackage(sample()), d = createDecisionTemplate(pkg), result = validateReviewDecisions({ reviewPackage: pkg, decisions: d });
  assert.equal(d.registry.length, 2); assert.equal(d.files.length, 1); assert.equal(result.humanReviewed, false); assert.equal(result.coverageComplete, false);
  assert.equal(result.retirementAllowed, false);
});
test('complete owner decisions require a separate receipt bound to exact decision bytes before humanReviewed=true', () => {
  const pkg = createReviewPackage(sample()), d = filled(pkg);
  assert.equal(validateReviewDecisions({ reviewPackage: pkg, decisions: d }).humanReviewed, false);
  const result = validateReviewDecisions(approve(pkg, d));
  assert.equal(result.coverageComplete, true); assert.equal(result.humanReviewed, true); assert.equal(result.reviewedCrosswalk.documents.length, 1);
  assert.equal(result.withdrawals.length, 1); assert.equal(result.frozenPairAccepted, false); assert.equal(result.retirementAllowed, false);
});
test('same SHA in a foreign scope cannot be approved even by a complete owner document', () => {
  const f = sample(); f.report.rows[0].targets[0].scopeId = 'B'; f.report.rows[0].targets[0].inOwnScope = false;
  const pkg = createReviewPackage(f), result = validateReviewDecisions(approve(pkg, filled(pkg)));
  assert.equal(result.humanReviewed, false); assert(result.issues.some(x => x.code === 'TARGET_NOT_OWN_SCOPE'));
});
test('changing identity, original SHA or target invalidates the existing decision', () => {
  const pkg = createReviewPackage(sample()), d = filled(pkg);
  for (const mutate of [f => { f.report.rows[0].sha256 = 'b'.repeat(64); }, f => { f.report.rows[0].entryId = 'changed'; }, f => { f.report.rows[0].targets[0].revisionId = 'next'; }]) {
    const f = sample(); mutate(f); const next = createReviewPackage(f);
    const result = validateReviewDecisions({ reviewPackage: next, decisions: d }); assert.equal(result.humanReviewed, false); assert(result.issues.some(x => x.code === 'PACKAGE_CHANGED'));
  }
});
test('unknown, duplicate and overlapping decisions do not count as coverage', () => {
  const pkg = createReviewPackage(sample()), d = filled(pkg); d.registry.push({ ...d.registry[0] });
  assert(validateReviewDecisions({ reviewPackage: pkg, decisions: d }).issues.some(x => x.code === 'DUPLICATE_DECISION'));
  const other = filled(pkg); other.files.push({ itemId: 'unknown', fingerprint: 'a'.repeat(64), action: 'WITHDRAW', reason: 'no' });
  assert(validateReviewDecisions({ reviewPackage: pkg, decisions: other }).issues.some(x => x.code === 'UNKNOWN_DECISION'));
});
test('no unverified data file can be included by group or individual decision', () => {
  const pkg = createReviewPackage(sample()), d = filled(pkg); d.files[0].action = 'INCLUDE_ORIGINAL';
  assert(validateReviewDecisions({ reviewPackage: pkg, decisions: d }).issues.some(x => x.code === 'UNVERIFIED_FILE_INCLUDED'));
});
test('snapshot reconciliation carries only unchanged bindings and clears approval', () => {
  const pkg = createReviewPackage(sample()), d = filled(pkg), f = sample(); f.report.locusSnapshotId = 'l2'; f.report.rows[1].bytes = 5;
  const next = createReviewPackage(f), carried = reconcileReviewDecisions({ previousPackage: pkg, nextPackage: next, decisions: d });
  assert.equal(carried.decisions.registry[0].action, 'ACCEPT_MATCH'); assert.equal(carried.decisions.registry[1].action, null);
  assert.equal(carried.approval, null); assert.equal(carried.humanReviewed, false); assert.equal(carried.invalidated.length, 1);
});
test('group decisions bind exact membership and additions require renewed review', () => {
  const f = sample(); f.fileReview.groups = [{ groupId: 'g', rootId: 'r', extension: '.json', folder: '.', memberPaths: ['/root/cache.json'] }];
  const pkg = createReviewPackage(f), d = createDecisionTemplate(pkg); d.owner = { name: 'Fixture Owner', decidedAt: '2026-11-02T10:00:00Z' };
  d.groups[0].action = 'EXCLUDE_NON_CORPUS'; d.groups[0].reason = 'Generated state';
  assert.equal(d.files.length, 0);
  const changed = sample(); changed.fileReview.units.push({ rootId: 'r', path: '/root/new.json', relativePath: 'new.json', sha256: null, bytes: 4 });
  changed.fileReview.groups = [{ ...f.fileReview.groups[0], memberPaths: ['/root/cache.json', '/root/new.json'] }];
  const next = createReviewPackage(changed); const carried = reconcileReviewDecisions({ previousPackage: pkg, nextPackage: next, decisions: d });
  assert.equal(carried.decisions.groups[0].action, null); assert(carried.invalidated.some(x => x.kind === 'group'));
});
test('modified package payload cannot retain a stale package fingerprint', () => {
  const pkg = createReviewPackage(sample()); pkg.registry[0].row.sha256 = 'c'.repeat(64);
  assert.throws(() => validateReviewDecisions({ reviewPackage: pkg, decisions: createDecisionTemplate(pkg) }), /REVIEW_PACKAGE_TAMPERED/);
});

function fileFixture(grouped = false) {
  const input = sample();
  input.fileReview.units = [
    { rootId: 'r', path: '/root/one.pdf', sha256: h, bytes: 10 },
    { rootId: 'r', path: '/root/two.pdf', sha256: 'b'.repeat(64), bytes: 20 }
  ];
  if (grouped) input.fileReview.groups = [{ groupId: 'g', rootId: 'r', memberPaths: input.fileReview.units.map(f => f.path) }];
  const pkg = createReviewPackage(input), d = createDecisionTemplate(pkg);
  const base = filled(createReviewPackage(sample())); d.owner = base.owner; d.registry = base.registry;
  for (const row of grouped ? d.groups : d.files) Object.assign(row, { action: 'INCLUDE_ORIGINAL', reason: 'Checked original', scopeEvidenceRef: 'owner:contract-A' });
  return { pkg, d };
}

test('file or group inclusion without a contract cannot produce human review', () => {
  for (const grouped of [false, true]) {
    const { pkg, d } = fileFixture(grouped), result = validateReviewDecisions(approve(pkg, d));
    assert.equal(result.humanReviewed, false);
    assert.equal(result.imports.length, 0);
    assert(result.issues.some(i => i.code === 'FILE_SCOPE_NOT_CONFIRMED'));
  }
});

test('every included original creates a contract-bound import proposal with its exact bytes and source identity', () => {
  for (const grouped of [false, true]) {
    const { pkg, d } = fileFixture(grouped);
    for (const row of grouped ? d.groups : d.files) row.scopeId = 'A';
    const result = validateReviewDecisions(approve(pkg, d));
    assert.equal(result.humanReviewed, true);
    assert.equal(result.imports.length, 2);
    assert.deepEqual(result.imports.map(i => [i.scopeId, i.original.path, i.original.sha256, i.original.bytes]), [
      ['A', '/root/one.pdf', h, 10], ['A', '/root/two.pdf', 'b'.repeat(64), 20]
    ]);
    assert(result.imports.every(i => i.itemId && i.scopeEvidenceRef === 'owner:contract-A' && i.reason === 'Checked original'));
  }
});

test('file decisions reject unknown contracts, missing scope evidence and negative size', () => {
  for (const change of [d => { d.scopeId = 'unknown'; }, d => { d.scopeId = ['A', 'B']; }, d => { d.scopeEvidenceRef = null; }]) {
    const { pkg, d } = fileFixture();
    for (const row of d.files) { row.scopeId = 'A'; change(row); }
    assert.equal(validateReviewDecisions(approve(pkg, d)).humanReviewed, false);
  }
  const input = sample(); input.fileReview.units[0].sha256 = h; input.fileReview.units[0].bytes = -1;
  const pkg = createReviewPackage(input), d = filled(pkg);
  Object.assign(d.files[0], { action: 'INCLUDE_ORIGINAL', scopeId: 'A', scopeEvidenceRef: 'owner:A' });
  assert.equal(validateReviewDecisions(approve(pkg, d)).humanReviewed, false);
});

test('one group cannot include members with different known contracts', () => {
  const input = sample(); input.report.scopeCatalog = [{ id: 'A' }, { id: 'B' }];
  input.fileReview.units = [{ rootId: 'r', path: '/root/a.pdf', bytes: 10, sha256: h, scopeId: 'A' },
    { rootId: 'r', path: '/root/b.pdf', bytes: 10, sha256: h, scopeId: 'B' }];
  input.fileReview.groups = [{ groupId: 'g', rootId: 'r', memberPaths: input.fileReview.units.map(f => f.path) }];
  const pkg = createReviewPackage(input), d = createDecisionTemplate(pkg), base = filled(createReviewPackage(sample()));
  d.owner = base.owner; d.registry = base.registry;
  Object.assign(d.groups[0], { action: 'INCLUDE_ORIGINAL', scopeId: 'A', reason: 'Mixed group', scopeEvidenceRef: 'owner:A' });
  const result = validateReviewDecisions(approve(pkg, d));
  assert.equal(result.humanReviewed, false); assert.equal(result.imports.length, 0);
  assert(result.issues.some(i => i.code === 'GROUP_SCOPE_MISMATCH'));
});
