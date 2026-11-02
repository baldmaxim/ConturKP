import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from '../lib/locus-registry-export.mjs';
import { inventoryRoots, validateFreezeRoots } from '../lib/locus-freeze.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
try {
  const { values } = parseArgs({ options: { roots: { type: 'string' }, 'out-dir': { type: 'string' }, 'portal-root': { type: 'string', multiple: true }, 'max-bytes': { type: 'string' }, 'max-ms': { type: 'string' } }, strict: true });
  if (!values.roots || !values['out-dir'] || !values['portal-root']?.length) throw new Error('FREEZE_USAGE');
  for (const key of ['max-bytes', 'max-ms']) if (values[key] !== undefined && (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1)) throw new Error('INVALID_FREEZE_LIMIT');
  const raw = await readFile(values.roots), catalog = JSON.parse(raw.toString('utf8')); validateFreezeRoots(catalog.roots);
  if (!values['portal-root'].every(p => isAbsolute(p))) throw new Error('ABSOLUTE_PORTAL_ROOT_REQUIRED');
  const output = await physicalPath(resolve(values['out-dir']));
  for (const path of [...catalog.roots.map(r => r.path), ...values['portal-root']]) {
    const protectedRoot = await physicalPath(path);
    if (withinRoot(protectedRoot, output) || withinRoot(output, protectedRoot)) throw new Error('OUTPUT_OVERLAPS_PROTECTED_ROOT');
  }
  const implementation = new URL('../lib/locus-freeze.mjs', import.meta.url), implementationSha256 = sha(await readFile(implementation));
  const cliSha256 = sha(await readFile(new URL(import.meta.url)));
  await mkdir(output);
  const progress = await open(resolve(output, 'progress.private.jsonl'), 'wx');
  let report;
  try {
    report = await inventoryRoots({ roots: catalog.roots, maxBytes: values['max-bytes'] === undefined ? undefined : Number(values['max-bytes']), maxDurationMs: values['max-ms'] === undefined ? undefined : Number(values['max-ms']),
      onProgress: async state => { await progress.write(JSON.stringify({ at: new Date().toISOString(), ...state }) + '\n'); } });
  } finally { await progress.close(); }
  if (sha(await readFile(implementation)) !== implementationSha256 || sha(await readFile(values.roots)) !== sha(raw)) throw new Error('INPUT_OR_IMPLEMENTATION_CHANGED');
  report.inputSha256 = sha(raw); report.implementationSha256 = implementationSha256; report.cliSha256 = cliSha256;
  await writeFile(resolve(output, 'inventory.private.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ complete: report.complete, ...report.statistics, errors: report.errors.length, contentSnapshotPreserved: false, retirementAllowed: false }));
  process.exitCode = report.complete ? 0 : 2;
} catch (error) { console.error(JSON.stringify({ error: /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'FREEZE_IO_ERROR' })); process.exitCode = 1; }
