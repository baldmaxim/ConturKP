import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { exportLocusRegistry } from '../scripts/lib/locus-registry-export.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, 'kontur-locus-export-'));
  t.after(() => {
    const actual = realpathSync(dir);
    assert.equal(dirname(actual), parent);
    assert(basename(actual).startsWith('kontur-locus-export-'));
    rmSync(actual, { recursive: true });
  });
  const sourceRoot = join(dir, 'source');
  mkdirSync(sourceRoot);
  const file = join(sourceRoot, 'original.pdf');
  writeFileSync(file, 'original bytes');
  return { dir, file, sourceRoot, input: {
    registry: { files: { f1: { fileId: 'f1', sourceId: 's1', path: file, size: 14 } } },
    sourceCatalog: { sources: [{ sourceId: 's1', roots: [sourceRoot] }] },
    snapshotId: 'S1', maxBytes: 1024, maxDurationMs: 10000, concurrency: 2,
  } };
}

test('hashes real bytes without modifying source and never calls an indexed registry a complete corpus', async t => {
  const f = fixture(t), before = readFileSync(f.file);
  const r = await exportLocusRegistry(f.input);
  assert.equal(r.system, 'locus'); assert.equal(r.complete, false);
  assert.equal(r.documents[0].sha256, createHash('sha256').update(before).digest('hex'));
  assert.equal(r.documents[0].bytes, before.length);
  assert.equal(r.statistics.hashed, 1); assert(r.errors.includes('INDEXED_ENTRIES_ONLY'));
  assert.deepEqual(readFileSync(f.file), before);
});

test('unknown source stays visible with no digest instead of being silently excluded', async t => {
  const f = fixture(t); f.input.registry.files.f1.sourceId = 'unconfigured';
  const r = await exportLocusRegistry(f.input);
  assert.equal(r.documents.length, 1); assert.equal(r.documents[0].sha256, null);
  assert.equal(r.observations[0].status, 'SOURCE_NOT_CONFIGURED');
});

test('a source cannot read an original from another configured source root', async t => {
  const f = fixture(t), other = join(f.dir, 'other'); mkdirSync(other);
  const hidden = join(other, 'secret.pdf'); writeFileSync(hidden, 'must not read');
  f.input.sourceCatalog.sources.push({ sourceId: 's2', roots: [other] });
  f.input.registry.files.f1.path = hidden;
  const r = await exportLocusRegistry(f.input);
  assert.equal(r.documents[0].sha256, null); assert.equal(r.observations[0].status, 'OUTSIDE_SOURCE_ROOT');
});

test('sibling path with a shared name prefix is outside the source root', async t => {
  const f = fixture(t), other = f.sourceRoot + '-outside'; mkdirSync(other);
  f.input.registry.files.f1.path = join(other, 'x.pdf'); writeFileSync(f.input.registry.files.f1.path, 'outside');
  const r = await exportLocusRegistry(f.input); assert.equal(r.observations[0].status, 'OUTSIDE_SOURCE_ROOT');
});

test('missing originals remain unknown rather than hashing cache text or an empty buffer', async t => {
  const f = fixture(t); f.input.registry.files.f1.path = join(f.sourceRoot, 'absent.pdf');
  const r = await exportLocusRegistry(f.input); assert.equal(r.documents[0].sha256, null); assert.equal(r.documents[0].bytes, null);
  assert.equal(r.observations[0].status, 'ORIGINAL_UNAVAILABLE');
});

test('actual size is captured and changed registry metadata is reported', async t => {
  const f = fixture(t); f.input.registry.files.f1.size = 999;
  const r = await exportLocusRegistry(f.input); assert.equal(r.documents[0].bytes, 14);
  assert.equal(r.observations[0].registrySizeChanged, true); assert(r.errors.includes('REGISTRY_SIZE_CHANGED'));
});

test('byte budget leaves remaining identities unverified and records the limit', async t => {
  const f = fixture(t); f.input.maxBytes = 1;
  const r = await exportLocusRegistry(f.input); assert.equal(r.statistics.hashed, 0);
  assert.equal(r.documents[0].sha256, null); assert.equal(r.observations[0].status, 'BYTE_BUDGET');
});

test('identical files retain separate logical identities', async t => {
  const f = fixture(t); f.input.registry.files.f2 = { ...f.input.registry.files.f1, fileId: 'f2' };
  const r = await exportLocusRegistry(f.input); assert.equal(r.documents.length, 2); assert.equal(r.statistics.hashed, 2);
  assert.equal(r.documents[0].sha256, r.documents[1].sha256); assert.notEqual(r.documents[0].entryId, r.documents[1].entryId);
});

test('duplicate logical IDs are rejected before traversal', async t => {
  const f = fixture(t); f.input.registry.files.f2 = { ...f.input.registry.files.f1 };
  await assert.rejects(exportLocusRegistry(f.input), /DUPLICATE_SOURCE_ID/);
});

test('relative original paths and invalid resource limits are rejected', async t => {
  const f = fixture(t); f.input.registry.files.f1.path = 'relative.pdf';
  await assert.rejects(exportLocusRegistry(f.input), /ABSOLUTE_ORIGINAL_PATH_REQUIRED/);
  f.input.registry.files.f1.path = f.file; f.input.maxBytes = -1;
  await assert.rejects(exportLocusRegistry(f.input), /INVALID_EXPORT_LIMIT/);
});

test('a junction escaping the declared root is rejected before reading its file', async t => {
  const f = fixture(t), outside = join(f.dir, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'x.pdf'), 'outside');
  const link = join(f.sourceRoot, 'link'); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.input.registry.files.f1.path = join(link, 'x.pdf');
  const r = await exportLocusRegistry(f.input); assert.equal(r.documents[0].sha256, null);
  assert.equal(r.observations[0].status, 'OUTSIDE_REAL_SOURCE_ROOT');
});


test('parallel readers reserve one shared byte budget', async t => {
  const f = fixture(t); f.input.registry.files.f2 = { ...f.input.registry.files.f1, fileId: 'f2' }; f.input.maxBytes = 14;
  const r = await exportLocusRegistry(f.input); assert.equal(r.statistics.hashed, 1); assert.equal(r.statistics.statuses.BYTE_BUDGET, 1);
});

test('CLI exports a partial registry, preserves inputs, and uses exit2', t => {
  const f = fixture(t), registry = join(f.dir, 'registry.json'), sources = join(f.dir, 'sources.json'), output = join(f.dir, 'export.json');
  writeFileSync(registry, JSON.stringify(f.input.registry)); writeFileSync(sources, JSON.stringify(f.input.sourceCatalog));
  const before = readFileSync(f.file);
  const r = spawnSync(process.execPath, ['scripts/ops/locus-export-registry.mjs', '--registry', registry, '--sources', sources, '--out', output], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  const report = JSON.parse(readFileSync(output, 'utf8')); assert.equal(report.complete, false); assert.equal(report.statistics.hashed, 1);
  assert.deepEqual(readFileSync(f.file), before); assert(!r.stdout.includes(f.file));
});

test('CLI refuses an output inside a declared source root', t => {
  const f = fixture(t), registry = join(f.dir, 'registry.json'), sources = join(f.dir, 'sources.json');
  writeFileSync(registry, JSON.stringify(f.input.registry)); writeFileSync(sources, JSON.stringify(f.input.sourceCatalog));
  const r = spawnSync(process.execPath, ['scripts/ops/locus-export-registry.mjs', '--registry', registry, '--sources', sources, '--out', join(f.sourceRoot, 'new.json')], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert(r.stderr.includes('OUTPUT_INSIDE_SOURCE_ROOT')); assert(!r.stderr.includes(f.sourceRoot));
});

test('CLI refuses to overwrite an input', t => {
  const f = fixture(t), registry = join(f.dir, 'registry.json'), sources = join(f.dir, 'sources.json');
  writeFileSync(registry, JSON.stringify(f.input.registry)); writeFileSync(sources, JSON.stringify(f.input.sourceCatalog));
  const before = readFileSync(registry);
  const r = spawnSync(process.execPath, ['scripts/ops/locus-export-registry.mjs', '--registry', registry, '--sources', sources, '--out', registry], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.deepEqual(readFileSync(registry), before);
});


test('CLI detects an output inside the physical source when its configured root is an alias', t => {
  const f = fixture(t), alias = join(f.dir, 'source-alias');
  symlinkSync(f.sourceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.input.sourceCatalog.sources[0].roots = [alias];
  const registry = join(f.dir, 'registry.json'), sources = join(f.dir, 'sources.json');
  writeFileSync(registry, JSON.stringify(f.input.registry)); writeFileSync(sources, JSON.stringify(f.input.sourceCatalog));
  const r = spawnSync(process.execPath, ['scripts/ops/locus-export-registry.mjs', '--registry', registry, '--sources', sources, '--out', join(f.sourceRoot, 'alias-output.json')], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert(r.stderr.includes('OUTPUT_INSIDE_SOURCE_ROOT'));
});


test('elapsed time budget leaves later entries unverified rather than silently dropping them', async t => {
  const f = fixture(t); f.input.registry.files.f2 = { ...f.input.registry.files.f1, fileId: 'f2' };
  f.input.concurrency = 1; f.input.maxDurationMs = 10;
  f.input.onProgress = async progress => { if (progress.processed === 1) await new Promise(resolve => setTimeout(resolve, 20)); };
  const r = await exportLocusRegistry(f.input); assert.equal(r.documents.length, 2);
  assert.equal(r.observations[1].status, 'TIME_BUDGET'); assert.equal(r.documents[1].sha256, null);
  assert(r.errors.includes('TIME_BUDGET')); assert.equal(r.complete, false);
});
