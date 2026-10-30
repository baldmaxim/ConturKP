import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stageCorpusBlobs, verifyCorpusStaging } from '../scripts/lib/locus-staging.mjs';

function sample(t) {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(join(parent, 'kontur-locus-stage-'));
  t.after(() => { const actual = realpathSync(dir); assert.equal(dirname(actual), parent); assert(basename(actual).startsWith('kontur-locus-stage-')); rmSync(actual, { recursive: true, force: true }); });
  const sourceRoot = join(dir, 'source'); mkdirSync(sourceRoot); const sourcePath = join(sourceRoot, 'source.pdf');
  const content = Buffer.from('real fixture original'); writeFileSync(sourcePath, content);
  const sha256 = createHash('sha256').update(content).digest('hex'), storeRoot = join(dir, 'staging');
  return { dir, sourcePath, content, storeRoot, spacePolicy: { warnFreeBytes: 0, stopFreeBytes: 0 }, sourceCatalog: { sources: [{ sourceId: 's', roots: [sourceRoot] }] },
    plan: { schemaVersion: 1, target: 'ISOLATED_BLOB_STAGING_ONLY', files: [{ sha256, bytes: content.length, sourceId: 's', sourcePath, logicalEntries: [{ sourceId: 's', entryId: 'f', candidateScopeId: 'A' }] }] } };
}

test('copy and independent readback verify content, preserve source, and never register a portal document', async t => {
  const f = sample(t); const copied = await stageCorpusBlobs(f);
  assert.equal(copied.copiedBlobs, 1); assert.equal(copied.failedBlobs, 0); assert.equal(copied.documentsRegistered, false);
  const checked = await verifyCorpusStaging(f); assert.equal(checked.verified, 1); assert.equal(checked.failures, 0);
  assert.deepEqual(readFileSync(f.sourcePath), f.content); assert.equal(copied.retirementAllowed, false);
});
test('changed source content cannot be reported as a successful copy of the planned blob', async t => {
  const f = sample(t); writeFileSync(f.sourcePath, Buffer.alloc(f.content.length, 120));
  const r = await stageCorpusBlobs(f); assert.equal(r.copiedBlobs, 0); assert.equal(r.failedBlobs, 1);
});
test('independent readback detects corruption instead of trusting the first copy receipt', async t => {
  const f = sample(t); await stageCorpusBlobs(f); const h = f.plan.files[0].sha256;
  const path = join(f.storeRoot, 'sha256', h.slice(0, 2), h.slice(2, 4), h); chmodSync(path, 0o600); writeFileSync(path, 'corrupt');
  const r = await verifyCorpusStaging(f); assert.equal(r.verified, 0); assert.equal(r.failures, 1);
});
test('outside-source path is rejected before creating the staging store', async t => {
  const f = sample(t); const outside = join(f.dir, 'outside.pdf'); writeFileSync(outside, f.content); f.plan.files[0].sourcePath = outside;
  await assert.rejects(stageCorpusBlobs(f), /INVALID_STAGING_SOURCE/); assert.equal(existsSync(f.storeRoot), false);
});
test('existing staging store is not reused or overwritten by a new copy run', async t => {
  const f = sample(t); await stageCorpusBlobs(f);
  await assert.rejects(stageCorpusBlobs(f), /EEXIST/); assert.equal((await verifyCorpusStaging(f)).verified, 1);
});
test('duplicate planned blobs and repeated logical identities are rejected', async t => {
  const f = sample(t); f.plan.files.push({ ...f.plan.files[0] });
  await assert.rejects(stageCorpusBlobs(f), /DUPLICATE_STAGING_BLOB/); assert.equal(existsSync(f.storeRoot), false);
  f.plan.files[1].sha256 = 'b'.repeat(64);
  await assert.rejects(stageCorpusBlobs(f), /DUPLICATE_STAGING_IDENTITY/); assert.equal(existsSync(f.storeRoot), false);
});
test('a physical alias cannot place a staging store inside an original source root', async t => {
  const f = sample(t), alias = join(f.dir, 'alias'); symlinkSync(join(f.dir, 'source'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.storeRoot = join(alias, 'new-store'); await assert.rejects(stageCorpusBlobs(f), /STAGING_INSIDE_SOURCE/);
  assert.equal(existsSync(f.storeRoot), false);
});


test('committed staging CLI independently verifies files, refuses to overwrite a receipt and preserves the store', async t => {
  const f = sample(t); await stageCorpusBlobs(f); const plan = join(f.dir, 'plan.json'), output = join(f.dir, 'verified.json');
  writeFileSync(plan, JSON.stringify(f.plan));
  const args = ['scripts/ops/locus-stage.mjs', '--verify-only', '--plan', plan, '--store', f.storeRoot, '--out', output];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, 'utf8')); assert.equal(report.verified, 1); assert.equal(report.failures, 0);
  const before = readFileSync(output); assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
  assert.deepEqual(readFileSync(output), before); assert.equal((await verifyCorpusStaging(f)).verified, 1);
});
