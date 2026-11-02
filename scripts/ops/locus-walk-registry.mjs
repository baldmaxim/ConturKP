// Derive the indexed logical denominator from a full filesystem read; never approves mappings.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from '../lib/locus-registry-export.mjs';
import { enrichDerivedHeaders } from '../lib/locus-derived-provenance.mjs';
import { deriveFullWalkRegistry, mergeRelocatedWalk } from '../lib/locus-owner-review.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
try {
  const { values } = parseArgs({ options: { walk: { type: 'string' }, registry: { type: 'string' }, sources: { type: 'string' }, replacement: { type: 'string' }, relocation: { type: 'string' }, 'derived-copies': { type: 'string' }, 'out-dir': { type: 'string' }, 'portal-root': { type: 'string', multiple: true } }, strict: true });
  if (['walk', 'registry', 'sources', 'out-dir'].some(k => !values[k]) || !values['portal-root']?.length || !!values.relocation !== !!values.replacement) throw new Error('WALK_REGISTRY_USAGE');
  const inputSha256 = {}, data = {};
  for (const k of ['walk', 'registry', 'sources', 'replacement', 'relocation', 'derived-copies']) if (values[k]) { const raw = await readFile(values[k]); inputSha256[k] = sha(raw); data[k] = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u, '')); }
  const output = await physicalPath(resolve(values['out-dir']));
  const walk = data.relocation ? mergeRelocatedWalk({ base: data.walk, replacement: data.replacement, relocation: data.relocation }) : data.walk;
  for (const path of [...walk.roots.map(r => r.path), ...values['portal-root']]) {
    if (!isAbsolute(path)) throw new Error('ABSOLUTE_ROOT_REQUIRED');
    const root = await physicalPath(path); if (withinRoot(root, output) || withinRoot(output, root)) throw new Error('OUTPUT_OVERLAPS_PROTECTED_ROOT');
  }
  const result = deriveFullWalkRegistry({ registry: data.registry, walk, sourceCatalog: data.sources, snapshotId: 'full-walk-' + sha(JSON.stringify(inputSha256)), relocations: data.relocation ? [data.relocation] : [], derivedCopies: data['derived-copies'] });
  if (data['derived-copies']) result.inventory = await enrichDerivedHeaders({ inventory: result.inventory, walk });
  const missingRows = result.inventory.observations.filter(r => r.status === 'ORIGINAL_UNVERIFIED');
  const networkRecoverySummary = { rows: missingRows.length, withCandidates: missingRows.filter(r => r.originalCandidates?.length).length, withSingleCandidateSha: missingRows.filter(r => r.originalCandidates?.length && new Set(r.originalCandidates.map(c => c.sha256)).size === 1).length, withDeclaredSizeMatch: missingRows.filter(r => r.originalCandidates?.some(c => c.declaredSizeMatches)).length, candidatePaths: missingRows.reduce((n, r) => n + (r.originalCandidates?.length ?? 0), 0), relationsApproved: 0 };
  const mdRows = result.inventory.observations.filter(r => r.status === 'DERIVED_COPY_REQUIRES_ORIGINAL');
  const derivedProvenanceSummary = { rows: mdRows.length, headerVerified: mdRows.filter(r => r.headerStatus === 'VERIFIED_MD_HEADER_ONLY').length, withPdfDocxCandidates: mdRows.filter(r => r.originalCandidates?.length).length, withSingleCandidateSha: mdRows.filter(r => r.originalCandidates?.length && new Set(r.originalCandidates.map(c => c.sha256)).size === 1).length, originalCandidatePaths: mdRows.reduce((n, r) => n + (r.originalCandidates?.length ?? 0), 0), relationsApproved: 0 };
  await mkdir(output);
  const files = { 'inventory.private.json': result.inventory, 'unindexed-source-candidates.private.json': { files: result.unindexedOriginals, originalAuthenticity: 'UNREVIEWED_NOT_ALL_FILES_ARE_CONTRACTS', registeredInPortal: false }, 'composite-walk.private.json': walk };
  await writeFile(resolve(output, 'source-footprint.private.json'), JSON.stringify(result.sourceFootprint, null, 2) + '\n', { flag: 'wx' });
  const outputSha256 = { 'source-footprint.private.json': sha(await readFile(resolve(output, 'source-footprint.private.json'))) };
  for (const [name, value] of Object.entries(files)) { const raw = JSON.stringify(value, null, 2) + '\n'; await writeFile(resolve(output, name), raw, { flag: 'wx' }); outputSha256[name] = sha(raw); }
  const receipt = { inputSha256, outputSha256, logicalRegistryDenominator: result.logicalRegistryDenominator, unindexedSourceCandidates: result.unindexedOriginals.length, derivedProvenanceSummary, networkRecoverySummary, sourceFootprint: result.sourceFootprint,
    implementationSha256: sha(await readFile(new URL('../lib/locus-owner-review.mjs', import.meta.url))), derivedProvenanceImplementationSha256: sha(await readFile(new URL('../lib/locus-derived-provenance.mjs', import.meta.url))), cliSha256: sha(await readFile(new URL(import.meta.url))), retirementAllowed: false };
  await writeFile(resolve(output, 'receipt.private.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...result.inventory.statistics, unindexedSourceCandidates: result.unindexedOriginals.length, derivedProvenanceSummary, networkRecoverySummary, complete: false, retirementAllowed: false }));
} catch (error) { console.error(JSON.stringify({ error: /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'WALK_REGISTRY_IO_ERROR' })); process.exitCode = 1; }
