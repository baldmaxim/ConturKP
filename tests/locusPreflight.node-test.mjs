// Этап 19: автономная сверка объявленных описями оригиналов. Только синтетические данные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditLocusCorpus } from '../scripts/lib/locus-corpus-audit.mjs';

const a = 'a'.repeat(64), b = 'b'.repeat(64);
const sample = () => ({
  locus: { schemaVersion: 1, system: 'locus', snapshotId: 'L1', capturedAt: '2026-10-30T10:00:00Z', complete: true, errors: [], documents: [{ sourceId: 'contract-A', entryId: 'file-1', sha256: a, bytes: 42 }] },
  portal: { schemaVersion: 1, system: 'portal', snapshotId: 'P1', capturedAt: '2026-10-30T10:01:00Z', complete: true, errors: [], documents: [{ scopeId: 'contract-P', documentId: 'doc-1', revisionId: 'rev-1', sha256: a, bytes: 42 }] },
  crosswalk: { schemaVersion: 1, locusSnapshotId: 'L1', portalSnapshotId: 'P1', scopes: [{ sourceId: 'contract-A', scopeId: 'contract-P' }], documents: [{ sourceId: 'contract-A', entryId: 'file-1', documentId: 'doc-1', revisionId: 'rev-1' }] },
});
const has = (result, code) => result.issues.some(issue => issue.code === code);
const run = fixture => auditLocusCorpus(fixture);

test('exact identities, scope, SHA and bytes match declared snapshots; retirement is never authorized', () => {
  const r = run(sample());
  assert.equal(r.comparison, 'MATCH'); assert.equal(r.summary.matched, 1);
  assert.equal(r.retirementAllowed, false); assert.equal(r.liveVerification, 'NOT_RUN');
});
test('additional portal originals are preserved and do not become deletion candidates', () => {
  const f = sample(); f.portal.documents.push({ ...f.portal.documents[0], documentId: 'extra', revisionId: 'extra' });
  const r = run(f); assert.equal(r.comparison, 'MATCH'); assert.equal(r.summary.portalEntries, 2); assert.equal(r.summary.matched, 1);
});
test('identical bytes in another scope do not prove coverage', () => {
  const f = sample(); f.portal.documents[0].scopeId = 'other-contract';
  const r = run(f); assert(has(r, 'TARGET_SCOPE_MISMATCH')); assert.equal(r.summary.matched, 0);
});
test('matching blob without explicit crosswalk does not cover an original', () => {
  const f = sample(); f.crosswalk.documents = [];
  const r = run(f); assert(has(r, 'SOURCE_UNMAPPED')); assert.equal(r.summary.matched, 0);
});
test('two logical originals with identical bytes require both identities to be mapped', () => {
  const f = sample(); f.locus.documents.push({ ...f.locus.documents[0], entryId: 'file-2' });
  const r = run(f); assert.equal(r.summary.locusEntries, 2); assert.equal(r.summary.matched, 1); assert(has(r, 'SOURCE_UNMAPPED'));
});
test('reusing one target revision for two originals fails closed', () => {
  const f = sample(); f.locus.documents.push({ ...f.locus.documents[0], entryId: 'file-2' }); f.crosswalk.documents.push({ ...f.crosswalk.documents[0], entryId: 'file-2' });
  const r = run(f); assert(has(r, 'TARGET_REUSED')); assert.equal(r.summary.matched, 0);
});
test('content digest mismatch is not hidden by matching names or sizes', () => {
  const f = sample(); f.portal.documents[0].sha256 = b;
  const r = run(f); assert(has(r, 'CONTENT_HASH_MISMATCH')); assert.equal(r.summary.matched, 0);
});
test('byte length mismatch prevents coverage even with equal declared digests', () => {
  const f = sample(); f.portal.documents[0].bytes++;
  const r = run(f); assert(has(r, 'CONTENT_SIZE_MISMATCH')); assert.equal(r.summary.matched, 0);
});
test('incomplete Locus enumeration never passes', () => { const f = sample(); f.locus.complete = false; const r = run(f); assert.equal(r.comparison, 'INCOMPLETE'); assert(has(r, 'SOURCE_INCOMPLETE')); });
test('incomplete portal enumeration never passes', () => { const f = sample(); f.portal.complete = false; const r = run(f); assert.equal(r.comparison, 'INCOMPLETE'); assert(has(r, 'TARGET_INCOMPLETE')); });
test('enumeration errors remain visible even when the complete flag was supplied', () => { const f = sample(); f.locus.errors = ['unreadable source']; const r = run(f); assert.equal(r.comparison, 'INCOMPLETE'); assert(has(r, 'SOURCE_INCOMPLETE')); });
test('empty corpus is not a vacuous successful migration', () => { const f = sample(); f.locus.documents = []; f.portal.documents = []; f.crosswalk.documents = []; const r = run(f); assert.equal(r.comparison, 'INCOMPLETE'); assert(has(r, 'EMPTY_SOURCE')); });
test('legacy path-derived IDs cannot substitute for an unknown original digest', () => { const f = sample(); f.locus.documents[0].sha256 = null; const r = run(f); assert.equal(r.comparison, 'INCOMPLETE'); assert.equal(r.summary.matched, 0); assert(has(r, 'ORIGINAL_HASH_UNVERIFIED')); });
test('missing byte count is not interpreted as zero', () => { const f = sample(); f.locus.documents[0].bytes = null; const r = run(f); assert.equal(r.comparison, 'INCOMPLETE'); assert(has(r, 'ORIGINAL_SIZE_UNVERIFIED')); });
test('without a portal export the result is NOT_RUN, not a claim that every original is absent', () => { const r = auditLocusCorpus({ locus: sample().locus }); assert.equal(r.comparison, 'NOT_RUN'); assert.equal(r.summary.matched, null); assert(has(r, 'PORTAL_INVENTORY_REQUIRED')); });
test('without a crosswalk no match is inferred', () => { const f = sample(); delete f.crosswalk; const r = run(f); assert.equal(r.comparison, 'NOT_RUN'); assert(has(r, 'CROSSWALK_REQUIRED')); });
test('crosswalk for another snapshot is not silently reused', () => { const f = sample(); f.crosswalk.locusSnapshotId = 'old'; const r = run(f); assert.equal(r.comparison, 'INCOMPLETE'); assert.equal(r.summary.matched, null); assert(has(r, 'CROSSWALK_SNAPSHOT_MISMATCH')); });
test('unknown source mappings cannot make the crosswalk look complete', () => { const f = sample(); f.crosswalk.documents.push({ ...f.crosswalk.documents[0], entryId: 'nonexistent', revisionId: 'other' }); const r = run(f); assert(has(r, 'UNKNOWN_SOURCE_MAPPING')); assert.notEqual(r.comparison, 'MATCH'); });
test('duplicate source identities are rejected instead of overwritten in a Map', () => { const f = sample(); f.locus.documents.push({ ...f.locus.documents[0] }); assert.throws(() => run(f), /DUPLICATE_SOURCE_ID/); });
test('duplicate target identities are rejected', () => { const f = sample(); f.portal.documents.push({ ...f.portal.documents[0] }); assert.throws(() => run(f), /DUPLICATE_TARGET_ID/); });
test('invalid digest and unsafe byte count fail validation', () => { const f = sample(); f.locus.documents[0].sha256 = 'path-sha1'; assert.throws(() => run(f), /INVALID_HASH/); f.locus.documents[0].sha256 = a; f.locus.documents[0].bytes = Number.MAX_SAFE_INTEGER + 1; assert.throws(() => run(f), /INVALID_BYTES/); });
test('snapshot timestamps require a timezone', () => { const f = sample(); f.locus.capturedAt = '2026-10-30T10:00:00'; assert.throws(() => run(f), /INVALID_CAPTURE_TIME/); });
test('hex digest letter case does not change content identity', () => { const f = sample(); f.portal.documents[0].sha256 = a.toUpperCase(); assert.equal(run(f).comparison, 'MATCH'); });
test('identity tuple encoding does not conflate delimiters inside identifiers', () => {
  const f = sample(); f.locus.documents = [{ ...f.locus.documents[0], sourceId: 'x:y', entryId: 'z' }, { ...f.locus.documents[0], sourceId: 'x', entryId: 'y:z' }];
  f.portal.documents.push({ ...f.portal.documents[0], documentId: 'doc-2', revisionId: 'rev-2' });
  f.crosswalk.scopes = [{ sourceId: 'x:y', scopeId: 'contract-P' }, { sourceId: 'x', scopeId: 'contract-P' }];
  f.crosswalk.documents = f.locus.documents.map((d, i) => ({ sourceId: d.sourceId, entryId: d.entryId, documentId: `doc-${i + 1}`, revisionId: `rev-${i + 1}` }));
  assert.equal(run(f).summary.matched, 2);
});

const cli = resolve('scripts/ops/locus-preflight.mjs');
const files = t => {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(join(parent, 'kontur-stage19-'));
  t.after(() => { const actual = realpathSync(dir); assert.equal(dirname(actual), parent); assert(basename(actual).startsWith('kontur-stage19-')); rmSync(actual, { recursive: true }); });
  const f = sample(), paths = {};
  for (const key of ['locus', 'portal', 'crosswalk']) { paths[key] = join(dir, key + '.json'); writeFileSync(paths[key], JSON.stringify(f[key])); }
  return { dir, paths, f };
};
test('CLI compares files without modifying inputs and never authorizes retirement', t => {
  const { dir, paths } = files(t), before = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
  const output = join(dir, 'report.json');
  const r = spawnSync(process.execPath, [cli, '--locus', paths.locus, '--portal', paths.portal, '--crosswalk', paths.crosswalk, '--out', output], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); const report = JSON.parse(readFileSync(output, 'utf8')); assert.equal(report.comparison, 'MATCH'); assert.equal(report.retirementAllowed, false);
  for (const [k, p] of Object.entries(paths)) assert.equal(readFileSync(p, 'utf8'), before[k]);
});
test('CLI source-only inspection returns2 with a NOT_RUN report', t => { const { dir, paths } = files(t), output = join(dir, 'report.json'); const r = spawnSync(process.execPath, [cli, '--locus', paths.locus, '--out', output], { encoding: 'utf8' }); assert.equal(r.status, 2, r.stderr); assert.equal(JSON.parse(readFileSync(output, 'utf8')).comparison, 'NOT_RUN'); });
test('CLI refuses to overwrite an existing output or an input file', t => { const { paths } = files(t), before = readFileSync(paths.locus, 'utf8'); const r = spawnSync(process.execPath, [cli, '--locus', paths.locus, '--out', paths.locus], { encoding: 'utf8' }); assert.equal(r.status, 1); assert.equal(readFileSync(paths.locus, 'utf8'), before); });
test('CLI validation errors disclose no supplied values and do not produce a success report', t => { const { dir, paths, f } = files(t); f.locus.documents[0].sha256 = 'private-token-value'; writeFileSync(paths.locus, JSON.stringify(f.locus)); const output = join(dir, 'report.json'); const r = spawnSync(process.execPath, [cli, '--locus', paths.locus, '--out', output], { encoding: 'utf8' }); assert.equal(r.status, 1); assert(!r.stderr.includes('private-token-value')); assert(!existsSync(output)); });


test('v2 maps two originals of one Locus source into different contract scopes', () => {
  const f = sample(); f.locus.documents.push({ ...f.locus.documents[0], entryId: 'file-2' });
  f.portal.documents.push({ ...f.portal.documents[0], scopeId: 'contract-Q', documentId: 'doc-2', revisionId: 'rev-2' });
  f.crosswalk.schemaVersion = 2; f.crosswalk.scopes = [];
  f.crosswalk.documents[0].scopeId = 'contract-P';
  f.crosswalk.documents.push({ sourceId: 'contract-A', entryId: 'file-2', scopeId: 'contract-Q', documentId: 'doc-2', revisionId: 'rev-2' });
  const r = run(f); assert.equal(r.comparison, 'MATCH'); assert.equal(r.summary.matched, 2);
});

test('v2 requires each original scope even if a source-wide mapping exists', () => {
  const f = sample(); f.crosswalk.schemaVersion = 2;
  assert.throws(() => run(f), /INVALID_DOCUMENT_SCOPE_MAPPING/);
});

test('v2 rejects bytes that match only inside another contract', () => {
  const f = sample(); f.crosswalk.schemaVersion = 2; f.crosswalk.scopes = []; f.crosswalk.documents[0].scopeId = 'other-contract';
  const r = run(f); assert.equal(r.summary.matched, 0); assert(has(r, 'TARGET_SCOPE_MISMATCH'));
});

test('v2 still rejects one target revision reused for multiple source identities', () => {
  const f = sample(); f.crosswalk.schemaVersion = 2; f.crosswalk.scopes = []; f.crosswalk.documents[0].scopeId = 'contract-P';
  f.locus.documents.push({ ...f.locus.documents[0], entryId: 'file-2' });
  f.crosswalk.documents.push({ ...f.crosswalk.documents[0], entryId: 'file-2' });
  const r = run(f); assert.equal(r.summary.matched, 0); assert(has(r, 'TARGET_REUSED'));
});

test('v2 rejects invalid scope identifiers', () => {
  const f = sample(); f.crosswalk.schemaVersion = 2; f.crosswalk.documents[0].scopeId = 'bad\nscope';
  assert.throws(() => run(f), /INVALID_ID/);
});


test('v2 rejects a contradictory source-wide scopes array instead of ignoring it', () => {
  const f = sample(); f.crosswalk.schemaVersion = 2;
  f.crosswalk.documents[0].scopeId = 'contract-P'; f.crosswalk.scopes[0].scopeId = 'other-contract';
  assert.throws(() => run(f), /V2_SCOPES_MUST_BE_EMPTY/);
});

test('v2 rejects even a consistent legacy scopes array so it cannot imply unverified coverage', () => {
  const f = sample(); f.crosswalk.schemaVersion = 2; f.crosswalk.documents[0].scopeId = 'contract-P';
  assert.throws(() => run(f), /V2_SCOPES_MUST_BE_EMPTY/);
});
