import { readFileSync } from 'node:fs';
import { createDecisionTemplate } from './locus-review-decisions.mjs';
export function renderDecisionForm(pkg) {
  const template = createDecisionTemplate(pkg);
  const scopeName = scope => scope ? [scope.number ? '№ ' + scope.number : '', scope.title ?? scope.id,
    scope.archived || scope.status === 'archived' ? 'АРХИВ' : scope.status ?? 'Статус неизвестен'].filter(Boolean).join(' · ') : 'Договор не установлен';
  const size = bytes => Number.isSafeInteger(bytes) ? bytes + ' байт' : 'Размер не проверен';
  const scopes = pkg.scopeCatalog.map(s => ({ value: s.id, label: scopeName(s) }));
  // Count every candidate revision, not only the preselected target: aliases must never enter bulk acceptance.
  const uses = new Map();
  for (const item of pkg.registry) for (const id of new Set(item.targets.map(t => t.revisionId))) uses.set(id, (uses.get(id) ?? 0) + 1);
  const registry = pkg.registry.map(item => {
    const row = item.row, own = item.targets.filter(t => t.inOwnScope && t.scopeId === row.scope?.id);
    const target = own.length === 1 ? own[0] : null;
    const aliases = Math.max(row.reuseCount ?? 0, ...item.targets.map(t => uses.get(t.revisionId) ?? 0));
    const eligible = !!target && row.scope.status === 'active' && !row.scope.archived && target.scopeStatus === 'active' && !target.archived &&
      !row.registrySizeChanged && aliases <= 1 && /^[a-f0-9]{64}$/u.test(row.sha256 ?? '') &&
      target.sha256 === row.sha256 && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && target.bytes === row.bytes;
    const path = row.readPath ?? row.originalPath ?? row.entryId;
    const targetDetails = item.targets.map(t => [t.inOwnScope ? 'Своя редакция' : 'Чужая редакция', t.scopeTitle ?? t.scopeId,
      'Роль: ' + (t.contractRole ?? 'не указана'), 'Редакция ' + (t.revisionSeq ?? '?'),
      t.archived || t.scopeStatus === 'archived' ? 'АРХИВ' : t.scopeStatus, size(t.bytes), 'SHA: ' + t.sha256].filter(Boolean).join(' · '));
    return { itemId: item.itemId, weight: 1, label: path.split(/[\\/]/u).at(-1),
      info: [scopeName(row.scope), path, row.classification, 'SHA: ' + (row.sha256 ?? 'НЕ ПРОВЕРЕН'), size(row.bytes),
        'Алиасы: ' + aliases, row.registrySizeChanged ? 'РАЗМЕР ИЗМЕНИЛСЯ: ' + row.declaredBytes + ' → ' + row.observedBytes : '',
        'Идентичность: ' + row.sourceId + ' / ' + row.entryId, ...targetDetails].filter(Boolean).join('\n'),
      search: JSON.stringify(row), singleOwnTarget: target?.fingerprint ?? null, bulkEligible: eligible,
      targets: item.targets.map(t => ({ value: t.fingerprint,
        label: [t.inOwnScope ? 'СВОЯ' : 'ЧУЖАЯ', t.scopeTitle ?? t.scopeId, 'Роль: ' + (t.contractRole ?? 'не указана'),
          'Редакция ' + (t.revisionSeq ?? '?'), t.archived || t.scopeStatus === 'archived' ? 'АРХИВ' : t.scopeStatus,
          size(t.bytes), 'SHA: ' + t.sha256].filter(Boolean).join(' · '), disabled: !t.inOwnScope })),
      originals: item.originals.map(o => ({ value: o.fingerprint, label: o.path + ' · ' + size(o.bytes) + ' · SHA: ' + o.sha256 })) };
  });
  const byId = new Map(pkg.files.map(f => [f.itemId, f]));
  const fileInfo = f => [f.path, size(f.bytes), 'SHA: ' + (f.sha256 ?? 'НЕ ПРОВЕРЕН')].join(' · ');
  const groups = pkg.groups.map(g => ({ itemId: g.groupId, weight: g.members.length, label: g.rootId + ' / ' + g.folder + ' / ' + g.extension,
    info: g.category + ': ' + g.members.length + ' файлов; ' + size(g.totalBytes) + '; с SHA: ' + (g.hashedFiles ?? '?'),
    membersText: g.members.map(m => fileInfo(byId.get(m.itemId))).join('\n'),
    search: JSON.stringify([g.rootId, g.folder, g.extension, g.category, g.memberPaths]) }));
  const grouped = new Set(pkg.groups.flatMap(g => g.members.map(m => m.itemId)));
  const files = pkg.files.filter(f => !grouped.has(f.itemId)).map(f => ({ itemId: f.itemId, weight: 1, label: f.path, info: f.category + '\n' + fileInfo(f), search: JSON.stringify(f) }));
  const data = JSON.stringify({ packageId: pkg.packageId, template, registry, groups, files, scopes, total: pkg.registry.length + pkg.files.length })
    .replaceAll('<', '\\u003c').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return readFileSync(new URL('../templates/locus-review-decisions.html', import.meta.url), 'utf8').replace('__DATA__', () => data);
}
