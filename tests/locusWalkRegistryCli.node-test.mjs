import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
test('versioned CLIs read a new original, derive all identities, build an unsigned review and refuse portal output', t => {
  const parent = realpathSync(tmpdir()), dir = mkdtempSync(join(parent, 'kontur-locus-cli-'));
  t.after(() => { assert.equal(dirname(realpathSync(dir)), parent); assert(basename(dir).startsWith('kontur-locus-cli-')); rmSync(dir, { recursive: true, force: true }); });
  const source = join(dir, 'source'), portalRoot = join(dir, 'portal'); mkdirSync(source); mkdirSync(portalRoot);
  const original = join(source, 'a.pdf'), content = Buffer.from('fixture original'), h = createHash('sha256').update(content).digest('hex'); writeFileSync(original, content);
  function json(name, value) { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; }
  function run(script, args) { const r = spawnSync(process.execPath, ['scripts/ops/' + script, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); }
  const roots = json('roots.json', { roots: [{ rootId: 'r', path: source, kind: 'originals' }] }), walkDir = join(dir, 'walk');
  run('locus-freeze.mjs', ['--roots', roots, '--out-dir', walkDir, '--portal-root', portalRoot]);
  const registry = json('registry.json', { files: { a: { sourceId: 's', fileId: 'a', path: original } } });
  const sources = json('sources.json', { sources: [{ sourceId: 's', roots: [source] }] }), derived = join(dir, 'derived');
  run('locus-walk-registry.mjs', ['--walk', join(walkDir, 'inventory.private.json'), '--registry', registry, '--sources', sources, '--out-dir', derived, '--portal-root', portalRoot]);
  const inventoryPath = join(derived, 'inventory.private.json'), inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  assert.equal(inventory.documents.length, 1); assert.equal(inventory.documents[0].sha256, h); assert.equal(inventory.complete, false);
  assert.equal(JSON.parse(readFileSync(join(derived, 'source-footprint.private.json'), 'utf8')).verifiedUniqueBlobBytes, content.length);
  const portal = json('portal.json', { snapshotId: 'p', documents: [{ scopeId: 'A', documentId: 'd', revisionId: 'v', sha256: h, bytes: content.length }] });
  const classification = json('classification.json', [{ sourceId: 's', entryId: 'a', status: 'SCOPED_HASH_CANDIDATE', scopeId: 'A', documentId: 'd', revisionId: 'v' }]);
  const tables = json('tables.json', { 'public.contract': [{ id: 'A', status: 'archived' }], 'public.document': [{ id: 'd', contract_role: 'main' }], 'public.document_revision': [{ id: 'v', revision_seq: '1' }] });
  const reviewDir = join(dir, 'review'), args = ['--registry', registry, '--locus', inventoryPath, '--portal', portal, '--classification', classification, '--tables', tables, '--sources', sources, '--out-dir', reviewDir, '--portal-root', portalRoot];
  run('locus-owner-review.mjs', args);
  const review = JSON.parse(readFileSync(join(reviewDir, 'owner-review.private.json'), 'utf8'));
  assert.equal(review.rows[0].scope.archived, true); assert.equal(review.humanReviewed, false); assert.equal(review.rows[0].decision, null);
  const badArgs = [...args]; badArgs[badArgs.indexOf('--out-dir') + 1] = join(portalRoot, 'bad-output');
  assert.equal(spawnSync(process.execPath, ['scripts/ops/locus-owner-review.mjs', ...badArgs], { encoding: 'utf8' }).status, 1);
  assert.equal(existsSync(join(portalRoot, 'bad-output')), false); assert.deepEqual(readFileSync(original), content);
});
