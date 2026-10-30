import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parsePgCopy, preparePortalReads, buildPortalInventory, buildCorpusCandidates, buildStagingPlan, historySourceKey } from '../scripts/lib/locus-corpus-workflow.mjs';

const hash = 'a'.repeat(64);
function sample() {
  const root = 'C:\\contracts';
  const locus = { schemaVersion: 1, system: 'locus', snapshotId: 'L', capturedAt: '2026-10-30T10:00:00Z', complete: false, errors: ['INDEX_ONLY'], documents: [{ sourceId: 's', entryId: 'f', sha256: hash, bytes: 7 }] };
  const portal = { schemaVersion: 1, system: 'portal', snapshotId: 'P', capturedAt: locus.capturedAt, complete: false, errors: ['BACKUP_ONLY'], documents: [{ scopeId: 'A', documentId: 'd', revisionId: 'r', sha256: hash, bytes: 7 }] };
  const registry = { files: { f: { fileId: 'f', sourceId: 's', path: root + '\\one\\file.pdf', size: 7 } } };
  const sourceCatalog = { sources: [{ sourceId: 's', roots: [root] }] };
  const bindings = [{ id: 'binding', source_key: historySourceKey(root), folder_path: 'one', contract_id: 'A' }];
  return { root, locus, portal, registry, sourceCatalog, bindings };
}

const copy = (columns, rows, table = 'public.contract') => `COPY ${table} (${columns}) FROM stdin;\n${rows}\n\\.\n`;

test('COPY parses Unicode, tabs/newlines, null and escaped backslashes without SQL execution', () => {
  const sql = 'SELECT dangerous_instruction();\n' + copy('id, title, note, path', 'a\tДоговор\\tА\\nстрока\t\\N\tC:\\\\root');
  const r = parsePgCopy(sql)['public.contract'][0];
  assert.equal(r.title, 'Договор\tА\nстрока'); assert.equal(r.note, null); assert.equal(r.path, 'C:\\root');
});
test('COPY octal and hex escapes decode UTF8 bytes', () => {
  const r = parsePgCopy(copy('title', '\\303\\251\\x21'))['public.contract'][0]; assert.equal(r.title, 'é!');
});
test('COPY rejects truncated blocks, duplicate tables and wrong column counts', () => {
  assert.throws(() => parsePgCopy('COPY public.contract (id) FROM stdin;\nx\n'), /UNTERMINATED_COPY/);
  assert.throws(() => parsePgCopy(copy('id', 'x') + copy('id', 'y')), /DUPLICATE_COPY_TABLE/);
  assert.throws(() => parsePgCopy(copy('id, title', 'x')), /COPY_COLUMN_COUNT/);
});
test('COPY rejects invalid UTF8 escape sequences', () => { assert.throws(() => parsePgCopy(copy('id', '\\377')), /INVALID_COPY_UTF8/); });

function portalTables() {
  return { 'public.contract': [{ id: 'A' }], 'public.document': [{ id: 'd', contract_id: 'A' }],
    'public.document_revision': [{ id: 'r', document_id: 'd', contract_id: 'A', blob_sha256: hash }],
    'public.blob': [{ sha256: hash, size_bytes: '7', storage_key: `sha256/aa/aa/${hash}` }] };
}

test('portal read plan comes from contract revision and content-addressed storage, not document name', () => {
  const r = preparePortalReads({ tables: portalTables(), filesRoot: 'C:\\backup\\files' });
  assert.equal(r.registry.files.r.sourceId, 'A'); assert.equal(r.registry.files.r.size, 7);
  assert(r.registry.files.r.path.endsWith(hash)); assert.equal(r.sourceCatalog.sources.length, 1);
});
test('portal metadata cannot assign a document revision to another contract', () => {
  const t = portalTables(); t['public.document_revision'][0].contract_id = 'B'; t['public.contract'].push({ id: 'B' });
  assert.throws(() => preparePortalReads({ tables: t, filesRoot: 'C:\\backup' }), /PORTAL_SCOPE_INCONSISTENT/);
});
test('portal inventory retains physical mismatches and missing reads as incomplete', () => {
  const physical = sample().locus; physical.documents = [{ sourceId: 'A', entryId: 'r', sha256: 'b'.repeat(64), bytes: 7 }];
  const r = buildPortalInventory({ tables: portalTables(), physical, backup: { finishedAt: '2026-10-29T23:32:00Z', dump: { sha256: hash } } });
  assert.equal(r.complete, false); assert.equal(r.documents[0].scopeId, 'A'); assert.equal(r.physicalBlobVerification.mismatches, 1);
  physical.documents = [];
  assert.equal(buildPortalInventory({ tables: portalTables(), physical, backup: { finishedAt: '2026-10-29T23:32:00Z', dump: { sha256: hash } } }).documents[0].sha256, null);
});

test('candidate scope is derived from a binding before selecting any equal target blob', () => {
  const f = sample(); const r = buildCorpusCandidates(f);
  assert.equal(r.classification[0].scopeId, 'A'); assert.equal(r.crosswalk.documents[0].scopeId, 'A');
  assert.equal(r.classification[0].status, 'SCOPED_HASH_CANDIDATE'); assert.equal(r.crosswalk.humanReviewed, false);
});
test('same SHA available only in a foreign contract never becomes a crosswalk link', () => {
  const f = sample(); f.portal.documents[0].scopeId = 'B'; const r = buildCorpusCandidates(f);
  assert.equal(r.classification[0].scopeId, 'A');
  assert.equal(r.classification[0].status, 'BLOB_ONLY_IN_OTHER_SCOPE'); assert.equal(r.crosswalk.documents.length, 0);
});
test('a foreign equal SHA cannot displace the equal SHA in the independently derived contract', () => {
  const f = sample(); f.portal.documents.unshift({ ...f.portal.documents[0], scopeId: 'B', documentId: 'foreign', revisionId: 'foreign' });
  const r = buildCorpusCandidates(f); assert.equal(r.crosswalk.documents[0].revisionId, 'r'); assert.equal(r.crosswalk.documents[0].scopeId, 'A');
});
test('more specific folder wins, ties across contracts remain ambiguous', () => {
  const f = sample(); f.bindings.push({ id: 'parent', source_key: historySourceKey(f.root), folder_path: '.', contract_id: 'B' });
  assert.equal(buildCorpusCandidates(f).classification[0].scopeId, 'A');
  f.bindings.push({ ...f.bindings[0], id: 'other', contract_id: 'B' });
  const r = buildCorpusCandidates(f); assert.equal(r.classification[0].status, 'SCOPE_AMBIGUOUS'); assert.equal(r.crosswalk.documents.length, 0);
});
test('an unanchored source key and traversal folder cannot manufacture source scope', () => {
  const f = sample(); f.bindings[0].source_key = 'unanchored'; assert.equal(buildCorpusCandidates(f).classification[0].status, 'SCOPE_UNMAPPED');
  f.bindings[0].source_key = historySourceKey(f.root); f.bindings[0].folder_path = '..\\outside';
  assert.throws(() => buildCorpusCandidates(f), /INVALID_HISTORY_FOLDER/);
});
test('hashed records outside their own configured source root do not acquire another source scope', () => {
  const f = sample(); f.sourceCatalog.sources[0].roots = ['C:\\different'];
  assert.equal(buildCorpusCandidates(f).crosswalk.documents.length, 0);
});
test('unknown hash entries stay in classification and cannot appear in a staging plan', () => {
  const f = sample(); f.locus.documents[0].sha256 = null; const result = buildCorpusCandidates(f);
  assert.equal(result.classification.length, 1); assert.equal(result.classification[0].status, 'SOURCE_NOT_HASHED');
  assert.equal(buildStagingPlan({ ...f, classification: result.classification }).files.length, 0);
});
test('staging plan deduplicates bytes while retaining all logical entries and their scoped provenance', () => {
  const f = sample(); f.portal.documents = [];
  f.locus.documents.push({ ...f.locus.documents[0], entryId: 'f2' }); f.registry.files.f2 = { ...f.registry.files.f, fileId: 'f2' };
  const result = buildCorpusCandidates(f); const plan = buildStagingPlan({ ...f, classification: result.classification });
  assert.equal(plan.files.length, 1); assert.equal(plan.files[0].logicalEntries.length, 2); assert.equal(plan.files[0].logicalEntries[1].candidateScopeId, 'A');
  assert.equal(plan.totalBytes, 7); assert.equal(plan.logicalEntries, 2); assert.equal(plan.retirementAllowed, false);
});
test('a foreign-only match is retained for review and excluded from automatic staging', () => {
  const f = sample(); f.portal.documents[0].scopeId = 'B'; const result = buildCorpusCandidates(f);
  assert.equal(buildStagingPlan({ ...f, classification: result.classification }).files.length, 0);
});


test('CLI analyzes foreign-scope evidence end to end, writes provenance and refuses an existing output directory', t => {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(join(parent, 'kontur-locus-flow-'));
  t.after(() => { const actual = realpathSync(dir); assert.equal(dirname(actual), parent); assert(basename(actual).startsWith('kontur-locus-flow-')); rmSync(actual, { recursive: true }); });
  const f = sample(), tables = portalTables();
  tables['public.contract'].push({ id: 'B' }); tables['public.document'][0].contract_id = 'B'; tables['public.document_revision'][0].contract_id = 'B';
  tables['public.contract_history_binding'] = f.bindings;
  const physical = { ...f.locus, documents: [{ sourceId: 'B', entryId: 'r', sha256: hash, bytes: 7 }] };
  const inputs = { tables, manifest: { dump: { sha256: hash }, finishedAt: f.locus.capturedAt }, 'portal-physical': physical, locus: f.locus, registry: f.registry, sources: f.sourceCatalog };
  const args = ['scripts/ops/locus-corpus-workflow.mjs', 'analyze'];
  for (const [key, value] of Object.entries(inputs)) { const file = join(dir, key + '.json'); writeFileSync(file, JSON.stringify(value)); args.push('--' + key, file); }
  const output = join(dir, 'result'); args.push('--out-dir', output);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(result.status, 2, result.stderr);
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.classification.BLOB_ONLY_IN_OTHER_SCOPE, 1); assert.equal(summary.crosswalkCandidateCount, 0); assert.equal(summary.comparisonSummary.matched, 0);
  assert.equal(JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8')).inputSha256.locus.length, 64);
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
});
