import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
function fixture(t) {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(join(parent, 'kontur-locus-backup-'));
  t.after(() => { assert.equal(dirname(realpathSync(dir)), parent); assert(basename(dir).startsWith('kontur-locus-backup-')); rmSync(dir, { recursive: true, force: true }); });
  return { dir, backup: join(dir, 'backup'), receipt: join(dir, 'receipt.json') };
}
test('backup wrapper refuses missing read-only environment before creating files or contacting DB', t => {
  const f = fixture(t), env = { ...process.env, BACKUP_DATABASE_URL: '', STORAGE_ROOT: '', BACKUP_ROOT: '' };
  const r = spawnSync(process.execPath, ['scripts/ops/locus-portal-backup.mjs', '--backup-root', f.backup, '--receipt', f.receipt], { encoding: 'utf8', env });
  assert.equal(r.status, 1); assert(r.stderr.includes('BACKUP_ENV_REQUIRED')); assert.equal(existsSync(f.backup), false); assert.equal(existsSync(f.receipt), false);
});
test('backup wrapper refuses a different destination before DB connection and discloses no supplied credential', t => {
  const f = fixture(t), env = { ...process.env, BACKUP_DATABASE_URL: 'postgresql://fixture:private-test-value@127.0.0.1:1/never-connect', STORAGE_ROOT: join(f.dir, 'storage'), BACKUP_ROOT: join(f.dir, 'configured') };
  const r = spawnSync(process.execPath, ['scripts/ops/locus-portal-backup.mjs', '--backup-root', f.backup, '--receipt', f.receipt], { encoding: 'utf8', env });
  assert.equal(r.status, 1); assert(r.stderr.includes('BACKUP_ROOT_NOT_CONFIRMED')); assert(!r.stderr.includes('private-test-value'));
  assert.equal(existsSync(f.backup), false); assert.equal(existsSync(f.receipt), false);
});
