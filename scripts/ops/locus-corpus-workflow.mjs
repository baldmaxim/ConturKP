// Reproducible offline workflow; pg_restore emits SQL to stdout, never to a database.
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from '../lib/locus-registry-export.mjs';
import { parsePgCopy, preparePortalReads, buildPortalInventory, buildCorpusCandidates, buildStagingPlan } from '../lib/locus-corpus-workflow.mjs';
import { auditLocusCorpus } from '../lib/locus-corpus-audit.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
try {
  const names = ['dump', 'manifest', 'pg-restore', 'tables', 'files-root', 'portal-physical', 'locus', 'registry', 'sources', 'out-dir'];
  const { values, positionals } = parseArgs({ options: Object.fromEntries(names.map(k => [k, { type: 'string' }])), allowPositionals: true, strict: true });
  const action = positionals[0];
  const required = { extract: ['dump', 'manifest', 'pg-restore', 'out-dir'], 'prepare-portal': ['tables', 'files-root', 'out-dir'], analyze: ['tables', 'manifest', 'portal-physical', 'locus', 'registry', 'sources', 'out-dir'] }[action];
  if (positionals.length !== 1 || !required || required.some(key => !values[key])) throw new Error('WORKFLOW_USAGE');
  const cliSha256 = digest(await readFile(new URL(import.meta.url)));
  const inputSha256 = {}, inputs = {};
  for (const key of required.filter(k => ['tables', 'manifest', 'portal-physical', 'locus', 'registry', 'sources'].includes(k))) {
    const bytes = await readFile(values[key]); inputSha256[key] = digest(bytes);
    inputs[key] = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  }
  const out = resolve(values['out-dir']), files = {}, protectedRoots = [];
  if (action === 'extract') {
    protectedRoots.push(dirname(resolve(values.dump)), dirname(resolve(values.manifest)));
    const h = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(values.dump)) { h.update(chunk); bytes += chunk.length; }
    const dumpSha = h.digest('hex');
    if (dumpSha !== inputs.manifest.dump?.sha256 || bytes !== inputs.manifest.dump?.sizeBytes) throw new Error('BACKUP_DUMP_MISMATCH');
    inputSha256.dump = dumpSha;
    const tables = ['blob', 'contract', 'document', 'document_revision', 'contract_history_binding', 'contract_history_entry', 'contract_history_import'];
    const { stdout } = await promisify(execFile)(values['pg-restore'], ['--data-only', '--no-owner', '--no-privileges', '--file=-', ...tables.map(t => '--table=' + t), resolve(values.dump)], { encoding: 'utf8', maxBuffer: 128 * 1024 ** 2, windowsHide: true });
    const parsed = parsePgCopy(stdout);
    if (tables.some(table => !Array.isArray(parsed['public.' + table]))) throw new Error('BACKUP_TABLE_MISSING');
    files['copy.private.sql'] = stdout; files['tables.private.json'] = json(parsed);
  } else if (action === 'prepare-portal') {
    protectedRoots.push(values['files-root']);
    const prepared = preparePortalReads({ tables: inputs.tables, filesRoot: values['files-root'] });
    files['registry.private.json'] = json(prepared.registry); files['sources.private.json'] = json(prepared.sourceCatalog);
  } else {
    protectedRoots.push(...(inputs.sources.sources ?? []).flatMap(s => s.roots ?? []));
    const portal = buildPortalInventory({ tables: inputs.tables, physical: inputs['portal-physical'], backup: inputs.manifest });
    const candidates = buildCorpusCandidates({ locus: inputs.locus, registry: inputs.registry, portal, sourceCatalog: inputs.sources, bindings: inputs.tables['public.contract_history_binding'] });
    const plan = buildStagingPlan({ locus: inputs.locus, registry: inputs.registry, classification: candidates.classification });
    const comparison = auditLocusCorpus({ locus: inputs.locus, portal, crosswalk: candidates.crosswalk });
    const summary = { classification: candidates.counts, anchoredBindings: candidates.anchoredBindings, crosswalkCandidateCount: candidates.crosswalk.documents.length,
      comparison: comparison.comparison, comparisonSummary: comparison.summary, comparisonIssueCodes: {},
      staging: { uniqueBlobs: plan.files.length, logicalEntries: plan.logicalEntries, bytes: plan.totalBytes },
      sourceByteAccounting: 'SUM_PER_REGISTRY_ENTRY_NOT_UNIQUE_FILES', humanReviewed: false, retirementAllowed: false };
    for (const issue of comparison.issues) summary.comparisonIssueCodes[issue.code] = (summary.comparisonIssueCodes[issue.code] ?? 0) + 1;
    files['portal.private.json'] = json(portal); files['classification.private.json'] = json(candidates.classification);
    files['crosswalk.private.json'] = json(candidates.crosswalk); files['staging-plan.private.json'] = json(plan);
    files['comparison.private.json'] = json(comparison); files['summary.json'] = json(summary);
  }
  const physicalOut = await physicalPath(out);
  for (const root of protectedRoots) if (withinRoot(await physicalPath(root), physicalOut)) throw new Error('OUTPUT_INSIDE_PROTECTED_ROOT');
  // Input validation, dump verification, SQL parsing and generation all finish before mkdir.
  await mkdir(out);
  const outputSha256 = {};
  for (const [name, content] of Object.entries(files)) { await writeFile(resolve(out, name), content, { flag: 'wx' }); outputSha256[name] = digest(content); }
  const implementationSha256 = {};
  for (const file of ['locus-corpus-workflow.mjs', 'locus-corpus-audit.mjs']) implementationSha256[file] = digest(await readFile(new URL('../lib/' + file, import.meta.url)));
  await writeFile(resolve(out, 'receipt.json'), json({ action, inputSha256, outputSha256, implementationSha256, cliSha256, retirementAllowed: false }), { flag: 'wx' });
  console.log(JSON.stringify({ action, files: Object.keys(files).length, retirementAllowed: false }));
  process.exitCode = action === 'analyze' ? 2 : 0;
} catch (error) {
  // Never disclose JSON fields, file paths or pg_restore stderr (which may contain private data).
  const code = /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : ['EEXIST', 'ENOENT', 'EACCES'].includes(error?.code) ? error.code : 'CORPUS_WORKFLOW_FAILED';
  console.error(JSON.stringify({ error: code })); process.exitCode = 1;
}
