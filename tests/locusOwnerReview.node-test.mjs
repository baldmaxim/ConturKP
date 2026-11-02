import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnerReview, renderOwnerReview, deriveFullWalkRegistry, mergeRelocatedWalk } from '../scripts/lib/locus-owner-review.mjs';
const h = 'a'.repeat(64);
function sample() {
  return { registry: { files: { a: { sourceId: 's', fileId: 'a', path: '/original/<script>.pdf' }, b: { sourceId: 's', fileId: 'b', path: '/original/b.pdf' }, c: { sourceId: 's', fileId: 'c', path: '/original/c.pdf' } } },
    locus: { snapshotId: 'l', documents: [{ sourceId: 's', entryId: 'a', sha256: h, bytes: 1 }, { sourceId: 's', entryId: 'b', sha256: h, bytes: 1 }, { sourceId: 's', entryId: 'c', sha256: null, bytes: null }] },
    portal: { snapshotId: 'p', capturedAt: '2026-10-29T23:00:00Z', documents: [{ scopeId: 'A', documentId: 'd', revisionId: 'r', sha256: h, bytes: 1 }, { scopeId: 'B', documentId: 'e', revisionId: 'q', sha256: h, bytes: 1 }] },
    tables: { 'public.contract': [{ id: 'A', title: 'Own', status: 'archived' }, { id: 'B', title: 'Foreign', status: 'active' }], 'public.document': [{ id: 'd', contract_id: 'A', contract_role: 'main', main_document_id: null }, { id: 'e', contract_id: 'B', contract_role: 'appendix' }], 'public.document_revision': [{ id: 'r', revision_seq: '2' }, { id: 'q', revision_seq: '1' }] },
    classification: [{ sourceId: 's', entryId: 'a', status: 'SCOPED_HASH_CANDIDATE', scopeId: 'A', documentId: 'd', revisionId: 'r' }, { sourceId: 's', entryId: 'b', status: 'SCOPED_HASH_CANDIDATE', scopeId: 'A', documentId: 'd', revisionId: 'r' }, { sourceId: 's', entryId: 'c', status: 'SOURCE_NOT_HASHED' }] };
}
test('all logical identities retained; reused revisions and archived contracts marked; decisions stay unsigned', () => {
  const f = sample(), before = JSON.stringify(f), result = buildOwnerReview(f);
  assert.equal(result.rows.length, 3); assert.equal(result.summary.reusedTargetRevisions, 1); assert.equal(result.summary.logicalRowsReusingRevision, 2);
  assert.equal(result.rows[0].scope.archived, true); assert.equal(result.rows[0].targets[0].contractRole, 'main');
  assert.equal(result.rows[0].reuseCount, 2); assert.equal(result.rows[2].decision, null);
  assert.equal(result.humanReviewed, false); assert.equal(result.signableAsGateA, false); assert.equal(JSON.stringify(f), before);
});
test('same hash in another contract remains foreign, never becomes an accepted link', () => {
  const f = sample(); f.classification[0] = { sourceId: 's', entryId: 'a', scopeId: 'C', status: 'BLOB_ONLY_IN_OTHER_SCOPE' }; f.tables['public.contract'].push({ id: 'C', status: 'active' });
  const row = buildOwnerReview(f).rows[0]; assert.equal(row.targets.length, 2); assert(row.targets.every(x => x.inOwnScope === false)); assert.equal(row.acceptedTarget, null);
});
test('missing and duplicate classification identities cannot silently shrink the registry', () => {
  const f = sample(); f.classification.pop(); assert.throws(() => buildOwnerReview(f), /REVIEW_DENOMINATOR_MISMATCH/);
  const g = sample(); g.classification[2] = g.classification[0]; assert.throws(() => buildOwnerReview(g), /DUPLICATE_REVIEW_ID/);
});
test('unknowns remain pending even if an unavailable document shares an indexed name', () => {
  const result = buildOwnerReview(sample()); assert.equal(result.summary.SOURCE_NOT_HASHED, 1);
  assert.equal(result.rows[2].sha256, null); assert.equal(result.rows[2].proposedAction, 'FIND_VERIFIED_ORIGINAL_OR_OWNER_WITHDRAWAL');
});
test('HTML escapes document names and does not expose an automatic signature or import action', () => {
  const html = renderOwnerReview(buildOwnerReview(sample())); assert(html.includes('&lt;script&gt;.pdf')); assert(!html.includes('<script>.pdf'));
  assert(html.includes('humanReviewed=false')); assert(html.includes('Не является подписью'));
});

test('full-walk derivation preserves every logical identity and does not bless cache or unconfigured paths', () => {
  const registry = { files: { a: { sourceId: 's', fileId: 'a', path: '/original/a.pdf' }, b: { sourceId: 's', fileId: 'b', path: '/cache/b.md' } } };
  const walk = { schemaVersion: 1, finishedAt: '2026-10-30T12:00:00Z', roots: [{ rootId: 'r', kind: 'originals' }, { rootId: 'c', kind: 'data_metadata' }], entries: [
    { rootId: 'r', type: 'file', path: '/original/a.pdf', sha256: h, bytes: 1 },
    { rootId: 'r', type: 'file', path: '/original/unindexed.pdf', sha256: h, bytes: 1 },
    { rootId: 'c', type: 'file', path: '/cache/b.md', sha256: h, bytes: 1 }], errors: [] };
  const result = deriveFullWalkRegistry({ registry, walk, sourceCatalog: { sources: [{ sourceId: 's', roots: ['/original'] }] }, snapshotId: 'new' });
  assert.equal(result.inventory.documents.length, 2); assert.equal(result.inventory.documents[0].sha256, h);
  assert.equal(result.inventory.documents[1].sha256, null); assert.equal(result.inventory.complete, false);
  assert.equal(result.sourceFootprint.verifiedPathBytes, 2); assert.equal(result.sourceFootprint.verifiedUniqueBlobBytes, 1);
  assert.equal(result.unindexedOriginals.length, 1); assert.equal(result.unindexedOriginals[0].path, '/original/unindexed.pdf');
});
test('conflicting full-walk hashes for one path remain unverified', () => {
  const file = { rootId: 'r', type: 'file', path: '/original/a.pdf', sha256: h, bytes: 1 };
  const result = deriveFullWalkRegistry({ registry: { files: { a: { sourceId: 's', path: '/original/a.pdf' } } }, walk: { schemaVersion: 1, finishedAt: '2026-10-30T12:00:00Z', roots: [{ rootId: 'r', kind: 'originals' }], entries: [file, { ...file, sha256: 'b'.repeat(64) }], errors: [] }, sourceCatalog: { sources: [{ sourceId: 's', roots: ['/original'] }] }, snapshotId: 'new' });
  assert.equal(result.inventory.documents[0].sha256, null); assert.equal(result.inventory.statistics.statuses.PATH_CHANGED_BETWEEN_ROOTS, 1);
});

test('owner-authorized relocation supplies physical bytes while preserving declared logical identity', () => {
  const args = { registry: { files: { a: { sourceId: 's', path: '/old/a.pdf' } } }, walk: { schemaVersion: 1, finishedAt: '2026-10-30T12:00:00Z', roots: [{ rootId: 'r', kind: 'originals' }], entries: [{ rootId: 'r', type: 'file', path: '/new/a.pdf', sha256: h, bytes: 1 }] }, sourceCatalog: { sources: [{ sourceId: 's', roots: ['/old'] }] }, snapshotId: 'new' };
  assert.equal(deriveFullWalkRegistry(args).inventory.documents[0].sha256, null);
  const relocation = { authority: 'DIRECT_OWNER_REPLY_IN_CURRENT_CHAT', decisionRef: 'docs/decisions.md#D-048', oldRoot: '/old', newRoot: '/new', sourceIds: ['s'] };
  const result = deriveFullWalkRegistry({ ...args, relocations: [relocation] });
  assert.equal(result.inventory.documents[0].sha256, h); assert.equal(result.inventory.observations[0].declaredPath, resolve('/old/a.pdf'));
  assert.equal(result.inventory.observations[0].readPath, resolve('/new/a.pdf'));
  assert.throws(() => deriveFullWalkRegistry({ ...args, relocations: [{ ...relocation, decisionRef: 'UNCONFIRMED' }] }), /OWNER_RELOCATION_REQUIRED/);
});

test('composite baseline replaces only the owner-confirmed root and keeps unrelated missing roots/errors', () => {
  const relocation = { authority: 'DIRECT_OWNER_REPLY_IN_CURRENT_CHAT', decisionRef: 'docs/decisions.md#D-048', oldRoot: '/old', newRoot: '/new', sourceIds: ['s'] };
  const base = { roots: [{ rootId: 'r', path: '/old', kind: 'originals' }, { rootId: 'other', path: '/missing', kind: 'originals' }], entries: [], errors: [{ rootId: 'r', code: 'ENOENT' }, { rootId: 'other', code: 'ENOENT' }], startedAt: '2026-10-30T12:00:00Z', finishedAt: '2026-10-30T12:10:00Z' };
  const replacement = { roots: [{ rootId: 'r', path: '/new', kind: 'originals' }], entries: [{ rootId: 'r', path: '/new/a.pdf' }], errors: [], startedAt: '2026-10-30T12:01:00Z', finishedAt: '2026-10-30T12:02:00Z' };
  const result = mergeRelocatedWalk({ base, replacement, relocation });
  assert.equal(result.errors.length, 1); assert.equal(result.errors[0].rootId, 'other');
  assert.equal(result.roots[0].path, '/new'); assert.equal(result.complete, false); assert.equal(result.contentSnapshotPreserved, false);
  assert.throws(() => mergeRelocatedWalk({ base, replacement, relocation: { ...relocation, decisionRef: 'UNCONFIRMED' } }), /OWNER_RELOCATION_REQUIRED/);
});

test('owner-confirmed OCR Markdown hashes cannot become original evidence; PDF candidates need human mapping', () => {
  const registry = { files: { a: { sourceId: 's', fileId: 'a', path: '/original/doc.pdf.md' } } };
  const walk = { schemaVersion: 1, finishedAt: '2026-10-30T12:00:00Z', roots: [{ rootId: 'r', kind: 'originals' }, { rootId: 'foreign', kind: 'originals' }], entries: [
    { rootId: 'r', type: 'file', path: '/original/doc.pdf.md', sha256: h, bytes: 3 },
    { rootId: 'r', type: 'file', path: '/original/doc.pdf', sha256: 'b'.repeat(64), bytes: 7 },
    { rootId: 'foreign', type: 'file', path: '/foreign/doc.pdf', sha256: 'c'.repeat(64), bytes: 7 }] };
  const args = { registry, walk, sourceCatalog: { sources: [{ sourceId: 's', roots: ['/original'] }] }, snapshotId: 'new', derivedCopies: { authority: 'DIRECT_OWNER_REPLY_IN_CURRENT_CHAT', kind: 'DERIVED_MD_COPIES_REQUIRE_PDF_DOCX', identities: [{ sourceId: 's', entryId: 'a' }] } };
  const result = deriveFullWalkRegistry(args); assert.equal(result.inventory.documents[0].sha256, null);
  const observation = result.inventory.observations[0]; assert.equal(observation.derivedSha256, h);
  assert.equal(observation.status, 'DERIVED_COPY_REQUIRES_ORIGINAL'); assert.equal(observation.originalCandidates.length, 1);
  assert.equal(observation.originalCandidates[0].path, '/original/doc.pdf'); assert.equal(observation.originalCandidates[0].approved, false);
  assert.throws(() => deriveFullWalkRegistry({ ...args, derivedCopies: { ...args.derivedCopies, authority: 'GUESS' } }), /OWNER_DERIVED_COPY_DECISION_REQUIRED/);
});

test('missing network originals get same-name proposals only from their configured source, without becoming verified', () => {
  const args = { registry: { files: { a: { sourceId: 's', fileId: 'a', path: '/source/old/doc.pdf', size: 1 } } }, walk: { schemaVersion: 1, finishedAt: '2026-10-30T12:00:00Z', roots: [{ rootId: 'own', kind: 'originals', sourceIds: ['s'] }, { rootId: 'foreign', kind: 'originals', sourceIds: ['other'] }], entries: [
    { rootId: 'own', type: 'file', path: '/source/new/doc.pdf', sha256: h, bytes: 1 },
    { rootId: 'foreign', type: 'file', path: '/foreign/doc.pdf', sha256: 'b'.repeat(64), bytes: 1 }] }, sourceCatalog: { sources: [{ sourceId: 's', roots: ['/source'] }] }, snapshotId: 'new' };
  const r = deriveFullWalkRegistry(args), row = r.inventory.observations[0]; assert.equal(r.inventory.documents[0].sha256, null);
  assert.equal(row.status, 'ORIGINAL_UNVERIFIED'); assert.equal((row.originalCandidates ?? []).length, 1);
  assert.equal(row.originalCandidates[0].path, '/source/new/doc.pdf'); assert.equal(row.originalCandidates[0].approved, false);
  assert.equal(row.originalCandidates[0].declaredSizeMatches, true);
});

test('R19A-04 preserves declared/observed sizes and mismatch in inventory and owner table', () => {
  const registry = { files: { a: { sourceId: 's', fileId: 'a', path: '/original/a.pdf', size: 100 } } };
  const args = { registry, sourceCatalog: { sources: [{ sourceId: 's', roots: ['/original'] }] }, snapshotId: 'size',
    walk: { schemaVersion: 1, finishedAt: '2026-11-02T10:00:00Z', roots: [{ rootId:'r',kind:'originals' }], entries: [{ rootId:'r',type:'file',path:'/original/a.pdf',sha256:h,bytes:200 }],errors:[] } };
  const result = deriveFullWalkRegistry(args);
  assert.equal(result.inventory.observations[0].registrySizeChanged,true);
  assert.equal(result.inventory.observations[0].declaredBytes,100);assert.equal(result.inventory.observations[0].observedBytes,200);
  assert(result.inventory.errors.includes('REGISTRY_SIZE_CHANGED'));
  const report = buildOwnerReview({registry,locus:result.inventory,portal:{snapshotId:'p',documents:[]},classification:[{sourceId:'s',entryId:'a',status:'NO_EQUAL_BLOB_IN_BACKUP_CONTRACTS',scopeId:'A'}],tables:{}});
  assert.equal(report.rows[0].registrySizeChanged,true);assert(renderOwnerReview(report).includes('РАЗМЕР ИЗМЕНИЛСЯ'));
});
test('R19A-04 relocated MD size is compared with indexed MD, never with a proposed PDF', () => {
  const r = deriveFullWalkRegistry({registry:{files:{a:{sourceId:'s',fileId:'a',path:'/old/a.md',size:100}}},sourceCatalog:{sources:[{sourceId:'s',roots:['/old']}]},snapshotId:'relocated',
    relocations:[{authority:'DIRECT_OWNER_REPLY_IN_CURRENT_CHAT',decisionRef:'docs/decisions.md#D-048',oldRoot:'/old',newRoot:'/new',sourceIds:['s']}],
    derivedCopies:{authority:'DIRECT_OWNER_REPLY_IN_CURRENT_CHAT',kind:'DERIVED_MD_COPIES_REQUIRE_PDF_DOCX',identities:[{sourceId:'s',entryId:'a'}]},
    walk:{schemaVersion:1,roots:[{rootId:'r',kind:'originals'}],entries:[{rootId:'r',type:'file',path:'/new/a.md',sha256:h,bytes:200},{rootId:'r',type:'file',path:'/new/a.pdf',sha256:'b'.repeat(64),bytes:900}],errors:[]}});
  assert.equal(r.inventory.documents[0].sha256,null);assert.equal(r.inventory.observations[0].observedBytes,200);assert.equal(r.inventory.observations[0].registrySizeChanged,true);
});
