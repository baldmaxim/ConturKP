import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDataFile, buildFileReview } from '../scripts/lib/locus-file-review.mjs';
import { createReviewPackage, createDecisionTemplate, validateReviewDecisions } from '../scripts/lib/locus-review-decisions.mjs';
test('PDF and unknown JSON in active data are potential originals, never hidden by a cache directory name', () => {
  assert.equal(classifyDataFile('/data', '/data/uploads/a.pdf'), 'POTENTIAL_ORIGINAL');
  assert.equal(classifyDataFile('/data', '/data/ocr-cache/a.pdf'), 'POTENTIAL_ORIGINAL');
  assert.equal(classifyDataFile('/data', '/data/state/upload.json'), 'POTENTIAL_ORIGINAL');
  assert.equal(classifyDataFile('/data', '/data/md-cache/x/a.md'), 'DERIVED_MD_CACHE_CANDIDATE');
});
test('all active and unindexed files enter exact groups and cannot disappear from owner coverage', () => {
  const walk = { roots: [{ rootId: 'd', path: '/data', kind: 'data_metadata' }, { rootId: 's', path: '/source', kind: 'originals' }], entries: [
    { rootId: 'd', path: '/data/uploads/a.pdf', type: 'file', bytes: 5 }, { rootId: 'd', path: '/data/md-cache/a.md', type: 'file', bytes: 2 },
    { rootId: 's', path: '/source/extra.pdf', type: 'file', bytes: 3, sha256: 'a'.repeat(64) }], errors: [] };
  const fileReview = buildFileReview({ walk, unindexedFiles: [{ path: '/source/extra.pdf' }] });
  assert.equal(fileReview.units.length, 3); assert.equal(fileReview.statistics.unhashedPotentialOriginals, 1);
  assert.equal(fileReview.groups.reduce((n, g) => n + g.memberPaths.length, 0), 3);
  const pkg = createReviewPackage({ report: { rows: [], locusSnapshotId: 'l', portalSnapshotId: 'p' }, fileReview });
  const d = createDecisionTemplate(pkg); assert.equal(d.groups.length, 3); assert.equal(d.files.length, 0);
  assert.equal(validateReviewDecisions({ reviewPackage: pkg, decisions: d }).missing.length, 3);
});
test('a group addition changes its fingerprint and cannot inherit prior owner approval', () => {
  const root = { rootId: 'r', path: '/data', kind: 'data_metadata' };
  const f = { rootId: 'r', path: '/data/md-cache/a.md', type: 'file', bytes: 1 };
  const one = buildFileReview({ walk: { roots: [root], entries: [f], errors: [] } });
  const two = buildFileReview({ walk: { roots: [root], entries: [f, { ...f, path: '/data/md-cache/b.md' }], errors: [] } });
  const report = { rows: [] }, a = createReviewPackage({ report, fileReview: one }), b = createReviewPackage({ report, fileReview: two });
  assert.notEqual(a.groups[0].fingerprint, b.groups[0].fingerprint);
});
