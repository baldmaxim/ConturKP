import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inventoryRoots, compareFreezePair } from '../scripts/lib/locus-freeze.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(join(parent, 'kontur-locus-freeze-'));
  t.after(() => { assert.equal(dirname(realpathSync(dir)), parent); assert(basename(dir).startsWith('kontur-locus-freeze-')); rmSync(dir, { recursive: true, force: true }); });
  const originals = join(dir, 'originals'); mkdirSync(originals);
  return { dir, originals, roots: [{ rootId: 's', path: originals, kind: 'originals' }] };
}
test('full walk includes unindexed originals and hashes actual bytes without writing into roots', async t => {
  const f = fixture(t); mkdirSync(join(f.originals, 'nested')); writeFileSync(join(f.originals, 'nested', 'not-in-registry.pdf'), 'actual');
  const result = await inventoryRoots(f);
  assert.equal(result.complete, true); assert.equal(result.statistics.hashedFiles, 1);
  const file = result.entries.find(x => x.type === 'file');
  assert.equal(file.sha256, createHash('sha256').update('actual').digest('hex'));
  assert.equal(result.contentSnapshotPreserved, false); assert.equal(result.retirementAllowed, false);
  assert.equal(readFileSync(file.path, 'utf8'), 'actual');
});
test('metadata-only active data cache is never claimed to be a verified original', async t => {
  const f = fixture(t); mkdirSync(join(f.originals, 'md-cache')); writeFileSync(join(f.originals, 'md-cache', 'cache.md'), 'OCR is not original');
  const result = await inventoryRoots({ roots: [{ ...f.roots[0], kind: 'data_metadata' }] });
  assert.equal(result.statistics.hashedFiles, 0); assert.equal(result.entries.find(x => x.type === 'file').hashStatus, 'DATA_METADATA_ONLY');
});
test('missing root remains an explicit completeness failure and does not disappear from the denominator', async t => {
  const f = fixture(t); const result = await inventoryRoots({ roots: [...f.roots, { rootId: 'missing', path: join(f.dir, 'absent'), kind: 'originals' }] });
  assert.equal(result.complete, false); assert.equal(result.roots.length, 2); assert.equal(result.errors[0].code, 'ENOENT');
});
test('directory junction cannot read a foreign original through the declared root', async t => {
  const f = fixture(t); const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'foreign.pdf'), 'foreign');
  symlinkSync(outside, join(f.originals, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await inventoryRoots(f); assert.equal(result.complete, false);
  assert(result.errors.some(x => x.code === 'SYMLINK_NOT_FOLLOWED')); assert.equal(result.statistics.hashedFiles, 0);
});
test('byte and entry limits leave visible errors rather than a truncated complete inventory', async t => {
  const f = fixture(t); writeFileSync(join(f.originals, 'big.pdf'), 'too big');
  const limited = await inventoryRoots({ ...f, maxBytes: 1 });
  assert.equal(limited.complete, false); assert(limited.errors.some(x => x.code === 'BYTE_BUDGET'));
  const entries = await inventoryRoots({ ...f, maxEntries: 1 });
  assert.equal(entries.complete, false); assert(entries.errors.some(x => x.code === 'ENTRY_BUDGET'));
});
test('freeze pair requires unchanged SHA and a fresh complete backup bracketed by both checks', async t => {
  const f = fixture(t); writeFileSync(join(f.originals, 'a.pdf'), 'same');
  const first = await inventoryRoots(f), second = structuredClone(first);
  first.startedAt = '2026-10-30T11:59:00.000Z'; first.finishedAt = '2026-10-30T12:00:00.000Z'; second.startedAt = '2026-10-30T12:10:00.000Z'; second.finishedAt = '2026-10-30T12:12:00.000Z';
  const backup = { createdAt: '2026-10-30T12:01:00.000Z', finishedAt: '2026-10-30T12:09:00.000Z', dump: { sha256: 'a'.repeat(64) } };
  const args = { first, second, backup, cutover: '2026-10-30T11:44:35.000Z' };
  assert.equal(compareFreezePair(args).stableHashesAndBackupWindow, true);
  assert.equal(compareFreezePair(args).retirementAllowed, false);
  assert.equal(compareFreezePair(args).frozenPairAccepted, false); // bytes not preserved, owner/coverage not proven
  const changed = structuredClone(second); changed.entries.find(x => x.type === 'file').sha256 = 'b'.repeat(64);
  assert.equal(compareFreezePair({ ...args, second: changed }).stableHashesAndBackupWindow, false);
  assert.equal(compareFreezePair({ ...args, backup: { ...backup, createdAt: '2026-10-30T11:00:00Z' } }).stableHashesAndBackupWindow, false);
  assert.equal(compareFreezePair({ ...args, first: { ...first, complete: false } }).stableHashesAndBackupWindow, false);
});
test('changed root catalog cannot masquerade as the same pair', async t => {
  const f = fixture(t); const first = await inventoryRoots(f); const second = structuredClone(first); second.roots[0].rootId = 'other';
  assert(compareFreezePair({ first, second }).issues.includes('ROOT_CATALOG_CHANGED'));
});

test('matching null hashes never qualify as a verified original pair', async t => {
  const f = fixture(t); writeFileSync(join(f.originals, 'a.pdf'), 'a');
  const first = await inventoryRoots(f); first.entries.find(e => e.type === 'file').sha256 = null;
  assert(compareFreezePair({ first, second: structuredClone(first) }).issues.includes('UNVERIFIED_ORIGINAL'));
});

test('CLI rejects invalid limits before creating output files', t => {
  const f = fixture(t), input = join(f.dir, 'roots.json'), output = join(f.dir, 'bad-output');
  writeFileSync(input, JSON.stringify({ roots: f.roots }));
  const result = spawnSync(process.execPath, ['scripts/ops/locus-freeze.mjs', '--roots', input, '--out-dir', output, '--portal-root', join(f.dir, 'portal'), '--max-bytes', 'not-a-number'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(existsSync(output), false);
});
test('CLI reports unavailable roots as partial and never overwrites previous output', t => {
  const f = fixture(t), input = join(f.dir, 'roots.json'), output = join(f.dir, 'out');
  writeFileSync(input, JSON.stringify({ roots: [{ ...f.roots[0], path: join(f.dir, 'missing') }] }));
  const args = ['scripts/ops/locus-freeze.mjs', '--roots', input, '--out-dir', output, '--portal-root', join(f.dir, 'portal')];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(result.status, 2, result.stderr);
  const raw = readFileSync(join(output, 'inventory.private.json')); const report = JSON.parse(raw);
  assert.equal(report.complete, false); assert.equal(report.contentSnapshotPreserved, false);
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1); assert.deepEqual(readFileSync(join(output, 'inventory.private.json')), raw);
});
test('CLI refuses an output alias inside portal data before any write', t => {
  const f = fixture(t), input = join(f.dir, 'roots.json'), portal = join(f.dir, 'portal'), alias = join(f.dir, 'alias'); mkdirSync(portal);
  symlinkSync(portal, alias, process.platform === 'win32' ? 'junction' : 'dir'); writeFileSync(input, JSON.stringify({ roots: f.roots }));
  const output = join(alias, 'out');
  const result = spawnSync(process.execPath, ['scripts/ops/locus-freeze.mjs', '--roots', input, '--out-dir', output, '--portal-root', portal], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(existsSync(output), false);
});

test('R19A-05 rejects a first walk begun before cutover or a two-week gap', async t => {
 const f=fixture(t);writeFileSync(join(f.originals,'a.pdf'),'a');const first=await inventoryRoots(f),second=structuredClone(first);
 first.startedAt='2026-10-23T12:00:00Z';first.finishedAt='2026-10-30T12:00:00Z';second.startedAt='2026-10-30T12:10:00Z';second.finishedAt='2026-10-30T12:12:00Z';
 const backup={createdAt:'2026-10-30T12:01:00Z',finishedAt:'2026-10-30T12:09:00Z',dump:{sha256:'a'.repeat(64)}};
 assert.equal(compareFreezePair({first,second,backup}).stableHashesAndBackupWindow,false);
 first.startedAt='2026-10-30T11:59:00Z';second.startedAt='2026-11-13T12:10:00Z';second.finishedAt='2026-11-13T12:12:00Z';
 assert.equal(compareFreezePair({first,second,backup}).stableHashesAndBackupWindow,false);
});
test('R19A-01 noncache PDF in active data is hashed instead of disappearing behind metadata-only mode', async t => {
 const f=fixture(t);mkdirSync(join(f.originals,'uploads'));writeFileSync(join(f.originals,'uploads','original.pdf'),'real');
 const r=await inventoryRoots({roots:[{...f.roots[0],kind:'data_metadata'}]});
 assert.equal(r.statistics.hashedFiles,1);assert.equal(r.entries.find(e=>e.type==='file').sha256,createHash('sha256').update('real').digest('hex'));
});
