import { parseArgs } from 'node:util';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from '../lib/locus-registry-export.mjs';
import { validateStagingPlan, stageCorpusBlobs, verifyCorpusStaging } from '../lib/locus-staging.mjs';

try {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, sources: { type: 'string' }, store: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' }, 'verify-only': { type: 'boolean' } }, strict: true });
  if (!values.plan || !values.store || !values.out || (!values['verify-only'] && !values.sources)) throw new Error('STAGING_USAGE');
  const raw = await readFile(values.plan), plan = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u, '')); validateStagingPlan(plan);
  const sourceRaw = values.sources ? await readFile(values.sources) : null;
  const sourceCatalog = sourceRaw ? JSON.parse(sourceRaw.toString('utf8').replace(/^\uFEFF/u, '')) : undefined;
  const output = resolve(values.out), storeRoot = resolve(values.store), physicalOut = await physicalPath(output);
  if (withinRoot(await physicalPath(storeRoot), physicalOut)) throw new Error('OUTPUT_INSIDE_STAGING');
  for (const source of sourceCatalog?.sources ?? []) for (const root of source.roots ?? []) if (withinRoot(await physicalPath(root), physicalOut)) throw new Error('OUTPUT_INSIDE_SOURCE');
  try { await lstat(output); throw new Error('OUTPUT_EXISTS'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  const implementationBytes = await readFile(new URL('../lib/locus-staging.mjs', import.meta.url));
  const implementationSha256 = createHash('sha256').update(implementationBytes).digest('hex');
  const options = { plan, sourceCatalog, storeRoot, concurrency: values.concurrency === undefined ? 3 : Number(values.concurrency) };
  const report = values['verify-only'] ? await verifyCorpusStaging(options) : await stageCorpusBlobs(options);
  const digest = value => createHash('sha256').update(value).digest('hex');
  report.inputSha256 = { plan: digest(raw), ...(sourceRaw ? { sources: digest(sourceRaw) } : {}) };
  if (digest(await readFile(new URL('../lib/locus-staging.mjs', import.meta.url))) !== implementationSha256) throw new Error('IMPLEMENTATION_CHANGED_DURING_RUN');
  report.implementationSha256 = implementationSha256;
  report.cliSha256 = digest(await readFile(new URL(import.meta.url)));
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ mode: report.mode, copiedBlobs: report.copiedBlobs, verified: report.verified, failures: report.failures ?? report.failedBlobs, bytes: report.bytes, retirementAllowed: false }));
  process.exitCode = (report.failures ?? report.failedBlobs) ? 2 : 0;
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : ['EEXIST', 'ENOENT', 'EACCES'].includes(error?.code) ? error.code : 'STAGING_WORKFLOW_FAILED';
  console.error(JSON.stringify({ error: code })); process.exitCode = 1;
}
