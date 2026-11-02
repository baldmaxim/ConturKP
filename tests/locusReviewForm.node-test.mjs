import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createReviewPackage } from '../scripts/lib/locus-review-decisions.mjs';
import { renderDecisionForm } from '../scripts/lib/locus-review-form.mjs';

const hash = 'a'.repeat(64);
function row(id) {
  return { sourceId: 'source', entryId: id, originalPath: '/source/' + id + '.pdf', sha256: hash, bytes: 10,
    classification: 'SCOPED_HASH_CANDIDATE', scope: { id: 'A', title: 'Договор Альфа', number: '42', status: 'active', archived: false }, reuseCount: 1,
    targets: [{ scopeId: 'A', scopeTitle: 'Договор Альфа', scopeStatus: 'active', archived: false, inOwnScope: true,
      documentId: 'doc-' + id, revisionId: 'rev-' + id, revisionSeq: 3, contractRole: 'main', sha256: hash, bytes: 10 }], originalCandidates: [] };
}
function form(rows = [row('a')], fileReview) {
  const pkg = createReviewPackage({ report: { locusSnapshotId: 'l', portalSnapshotId: 'p', rows }, fileReview });
  const html = renderDecisionForm(pkg), raw = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1];
  class Element {
    constructor() { this.children = []; this.value = ''; this.checked = false; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    click() { return this.onclick?.(); }
  }
  const ids = new Map([...html.matchAll(/id="([^"]+)"/gu)].map(m => [m[1], new Element()]));
  ids.get('data').textContent = raw; ids.get('kind').value = 'registry';
  let blob;
  vm.runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], {
    document: { getElementById: id => ids.get(id), createElement: () => new Element() }, Blob,
    URL: { createObjectURL: b => { blob = b; return 'blob:fixture'; }, revokeObjectURL() {} },
    setTimeout: fn => fn(), alert: message => { throw Error(message); }
  });
  return { pkg, data: JSON.parse(raw), ids, export: async () => { ids.get('save').click(); return JSON.parse(await blob.text()); } };
}

test('form presents contract names, roles, revision numbers, SHA, size, archive and alias information', () => {
  const input = row('a'); input.reuseCount = 3; input.scope.archived = true; input.targets[0].archived = true;
  const f = form([input]), info = JSON.stringify(f.data.registry[0]);
  for (const value of ['Договор Альфа', 'main', 'Редакция 3', hash, '10 байт', 'АРХИВ', 'Алиасы: 3']) assert(info.includes(value), value);
  assert.equal(f.data.scopes[0].value, 'A'); assert(f.data.scopes[0].label.includes('Договор Альфа'));
});

test('file and group decisions offer a contract selector and scope evidence field', () => {
  const files = { units: [{ rootId: 'root', path: '/source/a.pdf', sha256: hash, bytes: 10 }],
    groups: [{ groupId: 'g', rootId: 'root', folder: '.', extension: '.pdf', memberPaths: ['/source/a.pdf'] }] };
  const f = form([row('a')], files); f.ids.get('kind').value = 'groups'; f.ids.get('kind').onchange();
  const controls = f.ids.get('rows').children[0].children[1];
  assert(controls.children.some(c => c.children.some(o => o.value === 'A' && o.textContent.includes('Договор Альфа'))));
  assert(controls.children.some(c => c.placeholder === 'Основание выбора договора'));
});

test('bulk acceptance uses one reason only for undecided single-own non-alias active unchanged rows across filtered pages', async () => {
  const rows = Array.from({ length: 105 }, (_, i) => row('safe-' + i));
  const aliases = [row('alias-a'), row('alias-b')]; aliases[1].targets[0].revisionId = aliases[0].targets[0].revisionId;
  const archived = row('archive'); archived.targets[0].archived = true;
  const drift = row('drift'); drift.registrySizeChanged = true;
  const declaredAlias = row('alias-declared'); declaredAlias.reuseCount = 2;
  const multiple = row('multiple'); multiple.targets.push({ ...multiple.targets[0], revisionId: 'rev-second' });
  const foreign = row('foreign'); foreign.targets[0].inOwnScope = false;
  const f = form([...rows, ...aliases, archived, drift, declaredAlias, multiple, foreign]);
  f.ids.get('owner').value = 'Fixture'; f.ids.get('at').value = '2026-11-02T10:00';
  f.ids.get('bulk-reason').value = 'Verified originals and contracts'; f.ids.get('bulk-apply').click();
  const d = await f.export();
  assert.equal(d.registry.filter(x => x.action === 'ACCEPT_MATCH').length, 105);
  assert(d.registry.slice(0, 105).every(x => x.reason === 'Verified originals and contracts' && x.targetFingerprint));
  assert(d.registry.slice(105).every(x => x.action === null));
});

test('bulk acceptance respects filter, requires a reason and never overwrites an existing decision', async () => {
  const f = form([row('a'), row('b')]);
  const control = f.ids.get('rows').children[0].children[1].children[0]; control.value = 'WITHDRAW'; control.onchange();
  assert.throws(() => f.ids.get('bulk-apply').click(), /основание/iu);
  f.ids.get('bulk-reason').value = 'Checked'; f.ids.get('filter').value = 'b.pdf'; f.ids.get('filter').oninput(); f.ids.get('bulk-apply').click();
  const d = await f.export(); assert.equal(d.registry[0].action, 'WITHDRAW'); assert.equal(d.registry[1].action, 'ACCEPT_MATCH');
});

test('choosing ACCEPT_MATCH fills the single own revision without manually entering a UUID', async () => {
  const f = form(); const action = f.ids.get('rows').children[0].children[1].children[0]; action.value = 'ACCEPT_MATCH'; action.onchange();
  const d = await f.export(); assert.equal(d.registry[0].targetFingerprint, f.pkg.registry[0].targets[0].fingerprint);
});

test('loading a BOM draft preserves the decision timestamp through the next save', async () => {
  const f = form(), draft = await f.export(); draft.owner = { name: 'Fixture', decidedAt: '2026-11-02T10:01:02.345Z' };
  f.ids.get('load').files = [{ text: async () => '\uFEFF' + JSON.stringify(draft) }];
  await f.ids.get('load').onchange(); assert(f.ids.get('at').value);
  assert.equal((await f.export()).owner.decidedAt, draft.owner.decidedAt);
});

test('loading an undecided template keeps the date empty instead of inventing an epoch date', async () => {
  const f = form(), draft = await f.export();
  f.ids.get('load').files = [{ text: async () => JSON.stringify(draft) }];
  await f.ids.get('load').onchange(); assert.equal(f.ids.get('at').value, ''); assert.equal((await f.export()).owner.decidedAt, null);
});
