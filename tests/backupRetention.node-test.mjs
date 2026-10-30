import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, link, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDirName, blobListSha256 } from '../packages/storage/src/backup.ts';
import { retentionDay, selectRetentionPoints, pruneBackupPoints, withBackupOperation, recordVerifiedBackup } from '../packages/storage/src/backupRetention.ts';

const now = new Date('2026-10-26T12:00:00Z');
const sha = x => createHash('sha256').update(x).digest('hex');
const point = at => ({ name: backupDirName(new Date(at)), createdAt: at });
const calendarPolicy = verified => ({ daily: 7, monthly: 3, verified: { name: verified }, pins: [] });

test('Moscow day boundary, latest daily point and missed days', () => {
  assert.equal(retentionDay('2026-10-25T21:00:00Z'), '2026-10-26');
  const p = [point('2026-10-26T01:00:00Z'), point('2026-10-25T22:00:00Z'), point('2026-09-01T01:00:00Z')];
  const result = selectRetentionPoints(p, calendarPolicy(p[0].name), now);
  assert.deepEqual(result.remove.map(x => x.name), [p[1].name]);
  assert.equal(result.keep.length, 2);
});

test('previous calendar months, year boundary, deduplication and verified protection', () => {
  const p = ['2026-01-01', '2025-12-30', '2025-12-01', '2025-11-29', '2025-10-20', '2025-08-01'].map(x => point(x + 'T01:00:00Z'));
  const policy = { ...calendarPolicy(p[5].name), daily: 1 };
  const result = selectRetentionPoints(p, policy, new Date('2026-01-02T01:00:00Z'));
  assert.deepEqual(result.remove.map(x => x.name), [p[2].name]);
  assert.equal(result.keep.length, 5);
});

test('expired pins expire; missing active pins, future clock, missing verified point and bad counts fail closed', () => {
  const p = [point('2026-10-26T01:00:00Z'), point('2026-10-20T01:00:00Z')];
  const policy = { ...calendarPolicy(p[0].name), daily: 1, monthly: 0, pins: [{ name: p[1].name, until: '2026-10-25T01:00:00Z', reason: 'pre-update' }] };
  assert.equal(selectRetentionPoints(p, policy, now).remove.length, 1);
  assert.throws(() => selectRetentionPoints(p, { ...policy, daily: 0 }, now));
  assert.throws(() => selectRetentionPoints(p, { ...policy, verified: { name: 'missing' } }, now));
  assert.throws(() => selectRetentionPoints(p, { ...policy, pins: [{ name: 'kontur-20261018T010000Z', until: '2026-11-01T01:00:00Z', reason: 'update' }] }, now));
  assert.throws(() => selectRetentionPoints(p, policy, new Date('2026-10-01T01:00:00Z')));
});

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'kontur-retention-test-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(temp, 'backups');
  const storage = join(temp, 'storage');
  await mkdir(root); await mkdir(storage);
  const blob = Buffer.from('immutable content shared by all backup points');
  const blobSha = sha(blob);
  let first;
  const points = [];
  for (let day = 18; day <= 26; day++) {
    const at = `2026-10-${day}T01:00:00.000Z`;
    const name = backupDirName(new Date(at));
    const dir = join(root, name);
    const dataDir = join(dir, 'files', 'sha256', blobSha.slice(0, 2), blobSha.slice(2, 4));
    await mkdir(dataDir, { recursive: true });
    const blobFile = join(dataDir, blobSha);
    if (first) await link(first, blobFile); else { await writeFile(blobFile, blob); first = blobFile; }
    const dump = Buffer.from(`database dump ${day}`);
    await writeFile(join(dir, 'db.dump'), dump);
    const m = {
      format: 'kontur.backup.v1', createdAt: at, finishedAt: `2026-10-${day}T01:00:01.000Z`, host: 'test', build: null, role: 'kontur_backup',
      schema: { version: 53, migrations: 53 }, server: { versionNum: 180000 },
      dump: { file: 'db.dump', sizeBytes: dump.length, sha256: sha(dump), tool: 'test', excludedTableData: [] },
      files: { count: 1, totalBytes: blob.length, listSha256: blobListSha256([{ sha256: blobSha, sizeBytes: blob.length }]), copied: first === blobFile ? 1 : 0, linked: first === blobFile ? 0 : 1 },
      blobs: [[blobSha, blob.length]],
    };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
    points.push({ name, dir, manifest: m, blobFile });
  }
  await chmod(first, 0o444);
  const latest = points.at(-1);
  const policy = {
    format: 'kontur.backup-retention.v1', backupRoot: root, journalFile: join(temp, 'logs', 'retention.jsonl'), daily: 7, monthly: 3, timeZone: 'Europe/Moscow',
    verified: { name: latest.name, dumpSha256: latest.manifest.dump.sha256, blobListSha256: latest.manifest.files.listSha256, verifiedAt: now.toISOString() }, pins: [],
  };
  const policyFile = join(temp, 'policy.json');
  await writeFile(policyFile, JSON.stringify(policy));
  const options = { policyFile, backupRoot: root, storageRoot: storage, completedPoint: latest.name, now };
  return { temp, root, storage, points, latest, policy, policyFile, options, blob, first };
}

test('dry run leaves every point and content in place; service folder is ignored', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'history-perf-db-20261026'));
  await writeFile(join(f.root, 'history-perf-db-20261026', 'db.dump'), 'private service dump');
  const r = await pruneBackupPoints(f.options);
  assert.equal(r.keep.length, 7); assert.equal(r.remove.length, 2); assert.equal(r.removed.length, 0);
  assert.deepEqual(r.ignored, ['history-perf-db-20261026']);
  assert.equal((await readdir(f.root)).length, 10);
  assert.deepEqual(await readFile(f.latest.blobFile), f.blob);
});

test('apply removes only old full points; remaining hardlinks, data and READONLY mode survive', async t => {
  const f = await fixture(t);
  const before = await lstat(f.latest.blobFile, { bigint: true });
  const r = await pruneBackupPoints({ ...f.options, apply: true });
  assert.equal(r.removed.length, 2); assert.equal((await readdir(f.root)).length, 7);
  const after = await lstat(f.latest.blobFile, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.nlink, 7n);
  assert.equal(after.mode & 0o777n, before.mode & 0o777n);
  assert.deepEqual(await readFile(f.latest.blobFile), f.blob);
  const records = (await readFile(f.policy.journalFile, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(records.filter(x => x.event === 'deleted').map(x => x.point).sort(), f.points.slice(0, 2).map(x => x.name).sort());
  assert.equal(records.at(-1).event, 'complete');
});

test('corrupt latest dump cancels all deletion', async t => {
  const f = await fixture(t);
  await writeFile(join(f.latest.dir, 'db.dump'), Buffer.from('x'.repeat(f.latest.manifest.dump.sizeBytes)));
  await assert.rejects(pruneBackupPoints({ ...f.options, apply: true }), /дамп/u);
  assert.equal((await readdir(f.root)).length, 9);
});

test('initial cleanup refuses any difference from the reviewed deletion list', async t => {
  const f = await fixture(t);
  await assert.rejects(pruneBackupPoints({ ...f.options, apply: true, expectedRemoveNames: [f.points[0].name] }), /согласованного плана/u);
  assert.equal((await readdir(f.root)).length, 9);
});

test('corrupt latest blob cancels all deletion, including unchanged-size corruption', async t => {
  const f = await fixture(t);
  await chmod(f.latest.blobFile, 0o666);
  await writeFile(f.latest.blobFile, Buffer.alloc(f.blob.length, 65));
  await assert.rejects(pruneBackupPoints({ ...f.options, apply: true }), /SHA-256/u);
  assert.equal((await readdir(f.root)).length, 9);
});

test('partial backup, changed completed point and storage overlap fail before deletion', async t => {
  const f = await fixture(t);
  await assert.rejects(pruneBackupPoints({ ...f.options, completedPoint: f.points[0].name, apply: true }), /последняя/u);
  await assert.rejects(pruneBackupPoints({ ...f.options, storageRoot: f.root, apply: true }), /пересекаются/u);
  await mkdir(join(f.root, 'kontur-20261026T020000Z'));
  await assert.rejects(pruneBackupPoints({ ...f.options, apply: true }));
  assert.equal((await readdir(f.root)).length, 10);
});

test('directory junction outside backup root is refused and outside content survives', async t => {
  const f = await fixture(t);
  const outside = join(f.temp, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep');
  await symlink(outside, join(f.points[0].dir, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(pruneBackupPoints({ ...f.options, apply: true }), /ссылк/u);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal((await readdir(f.root)).length, 9);
});

test('hardlinks outside known snapshots prevent deletion and preserve external mode', async t => {
  const f = await fixture(t);
  const outside = join(f.temp, 'external-copy'); await link(f.first, outside);
  const before = await lstat(outside);
  await assert.rejects(pruneBackupPoints({ ...f.options, apply: true }), /за пределами/u);
  assert.equal((await readdir(f.root)).length, 9);
  assert.equal((await lstat(outside)).mode, before.mode);
});

test('backup/restore lock blocks pruning and is released after a failed operation', async t => {
  const f = await fixture(t);
  await assert.rejects(withBackupOperation(f.root, 'backup', async () => {
    await assert.rejects(pruneBackupPoints({ ...f.options, apply: true }), { code: 'backup_busy' });
    throw new Error('simulated failed backup');
  }), /simulated failed backup/u);
  assert.equal((await readdir(f.root)).length, 9);
  assert.equal((await pruneBackupPoints(f.options)).remove.length, 2);
});

test('last restore-verified point updates atomically and never moves backward in time', async t => {
  const f = await fixture(t);
  f.policy.verified = { ...f.policy.verified, name: f.points[0].name, dumpSha256: f.points[0].manifest.dump.sha256 };
  await writeFile(f.policyFile, JSON.stringify(f.policy));
  await withBackupOperation(f.root, 'restore', () => recordVerifiedBackup(f.policyFile, f.latest.dir, f.latest.manifest));
  assert.equal(JSON.parse(await readFile(f.policyFile, 'utf8')).verified.name, f.latest.name);
  await withBackupOperation(f.root, 'restore', () => recordVerifiedBackup(f.policyFile, f.points[0].dir, f.points[0].manifest));
  assert.equal(JSON.parse(await readFile(f.policyFile, 'utf8')).verified.name, f.latest.name);
});
