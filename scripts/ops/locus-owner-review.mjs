import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from '../lib/locus-registry-export.mjs';
import { buildOwnerReview, renderOwnerReview } from '../lib/locus-owner-review.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
try {
  const names = ['registry', 'locus', 'portal', 'classification', 'tables', 'sources', 'out-dir'];
  const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(k => [k, { type: 'string' }])), 'portal-root': { type: 'string', multiple: true } }, strict: true });
  if (names.some(k => !values[k]) || !values['portal-root']?.length) throw new Error('OWNER_REVIEW_USAGE');
  const inputSha256 = {}, data = {};
  for (const key of names.filter(k => k !== 'out-dir')) { const raw = await readFile(values[key]); inputSha256[key] = sha(raw); data[key] = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u, '')); }
  const output = await physicalPath(resolve(values['out-dir']));
  for (const root of (data.sources.sources ?? []).flatMap(s => s.roots)) if (withinRoot(await physicalPath(root), output)) throw new Error('OUTPUT_INSIDE_SOURCE');
  for (const path of values['portal-root']) {
    if (!isAbsolute(path)) throw new Error('ABSOLUTE_PORTAL_ROOT_REQUIRED');
    const root = await physicalPath(path); if (withinRoot(root, output) || withinRoot(output, root)) throw new Error('OUTPUT_INSIDE_PORTAL');
  }
  const report = buildOwnerReview(data); report.inputSha256 = inputSha256;
  report.implementationSha256 = sha(await readFile(new URL('../lib/locus-owner-review.mjs', import.meta.url)));
  report.cliSha256 = sha(await readFile(new URL(import.meta.url)));
  await mkdir(output);
  const raw = JSON.stringify(report, null, 2) + '\n', html = renderOwnerReview(report);
  await writeFile(resolve(output, 'owner-review.private.json'), raw, { flag: 'wx' });
  await writeFile(resolve(output, 'owner-review.private.html'), html, { flag: 'wx' });
  await writeFile(resolve(output, 'SHA256SUMS.private.txt'), `${sha(raw)}  owner-review.private.json\n${sha(html)}  owner-review.private.html\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...report.summary, humanReviewed: false, signableAsGateA: false, retirementAllowed: false }));
} catch (error) { console.error(JSON.stringify({ error: /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'OWNER_REVIEW_IO_ERROR' })); process.exitCode = 1; }
