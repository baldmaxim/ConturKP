// Stage 19-A backup via the accepted read-only backup implementation. No retention or service changes.
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { runBackup } from './backup-lib.ts';
import { findPgTools } from './pgTools.ts';
import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from '../lib/locus-registry-export.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
try {
  const { values } = parseArgs({ options: { 'backup-root': { type: 'string' }, receipt: { type: 'string' } }, strict: true });
  if (!values['backup-root'] || !values.receipt || !isAbsolute(values['backup-root']) || !isAbsolute(values.receipt)) throw new Error('BACKUP_USAGE');
  if (!process.env.BACKUP_DATABASE_URL || !process.env.STORAGE_ROOT || !process.env.BACKUP_ROOT) throw new Error('BACKUP_ENV_REQUIRED');
  const backupRoot = await physicalPath(values['backup-root']), configuredBackupRoot = await physicalPath(process.env.BACKUP_ROOT);
  if (backupRoot !== configuredBackupRoot) throw new Error('BACKUP_ROOT_NOT_CONFIRMED');
  const output = await physicalPath(values.receipt), storageRoot = await physicalPath(process.env.STORAGE_ROOT);
  if (withinRoot(storageRoot, output) || withinRoot(backupRoot, output)) throw new Error('BACKUP_RECEIPT_OVERLAPS_DATA');
  try { await lstat(output); throw new Error('BACKUP_RECEIPT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const implementationSha256 = sha(await readFile(new URL('./backup-lib.ts', import.meta.url))), cliSha256 = sha(await readFile(new URL(import.meta.url)));
  const run = (file, args) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 60000 }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout) })));
  const tool = await findPgTools({ platform: process.platform, env: process.env, run });
  if ('error' in tool) throw new Error('BACKUP_TOOLS_UNAVAILABLE');
  const result = await runBackup({ backupUrl: process.env.BACKUP_DATABASE_URL, storageRoot, backupRoot, tool, host: hostname(), build: null, env: process.env,
    log: line => console.log(`${new Date().toISOString()} ${line}`) });
  if (sha(await readFile(new URL('./backup-lib.ts', import.meta.url))) !== implementationSha256) throw new Error('BACKUP_IMPLEMENTATION_CHANGED');
  const manifestPath = resolve(result.dir, 'manifest.json');
  const receipt = { schemaVersion: 1, purpose: 'FRESH_PORTAL_BACKUP_NOT_ACCEPTED_FROZEN_PAIR', backupDir: result.dir, createdAt: result.manifest.createdAt, finishedAt: result.manifest.finishedAt,
    manifestSha256: sha(await readFile(manifestPath)), dump: result.manifest.dump, files: result.manifest.files, role: result.manifest.role, implementationSha256, cliSha256,
    retentionRun: false, servicesChanged: false, applicationCodeChanged: false, databaseWritesRequested: false, retirementAllowed: false };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ backupComplete: true, role: receipt.role, createdAt: receipt.createdAt, finishedAt: receipt.finishedAt, files: receipt.files.count, retentionRun: false, retirementAllowed: false }));
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : /^[a-z_]+$/u.test(error?.code ?? '') ? error.code : 'BACKUP_FAILED';
  console.error(JSON.stringify({ error: code })); process.exitCode = 1;
}
