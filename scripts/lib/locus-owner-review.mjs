import { resolve, relative, isAbsolute, basename } from 'node:path';
import { withinRoot, validateLocusRegistryExport } from './locus-registry-export.mjs';
// Unsigned human review proposal. Does not register, exclude or approve any identity.
const fail = code => { throw new Error(code); };
const key = row => JSON.stringify([row.sourceId, row.entryId ?? row.fileId]);
function index(rows) {
  const result = new Map();
  for (const row of rows) { const k = key(row); if (result.has(k)) fail('DUPLICATE_REVIEW_ID'); result.set(k, row); }
  return result;
}
export function buildOwnerReview({ registry, locus, portal, classification, tables }) {
  if (!registry?.files || !Array.isArray(locus?.documents) || !Array.isArray(portal?.documents) || !Array.isArray(classification)) fail('INVALID_REVIEW_INPUT');
  const raw = index(Object.entries(registry.files).map(([id, value]) => ({ ...value, entryId: value.fileId ?? id })));
  const sources = index(locus.documents), classes = index(classification);
  if (raw.size !== sources.size || sources.size !== classes.size || [...raw.keys()].some(k => !sources.has(k) || !classes.has(k))) fail('REVIEW_DENOMINATOR_MISMATCH');
  const contracts = new Map((tables?.['public.contract'] ?? []).map(x => [x.id, x]));
  const documents = new Map((tables?.['public.document'] ?? []).map(x => [x.id, x]));
  const revisions = new Map((tables?.['public.document_revision'] ?? []).map(x => [x.id, x]));
  const reuse = new Map();
  for (const row of classification) if (row.status === 'SCOPED_HASH_CANDIDATE') {
    if (!row.revisionId || !row.documentId || !row.scopeId) fail('INVALID_REVIEW_CANDIDATE');
    reuse.set(row.revisionId, (reuse.get(row.revisionId) ?? 0) + 1);
  }
  const provenance = index(locus.observations ?? []);
  const summary = { total: raw.size, reusedTargetRevisions: [...reuse.values()].filter(n => n > 1).length,
    logicalRowsReusingRevision: [...reuse.values()].filter(n => n > 1).reduce((a, b) => a + b, 0), archivedScopeRows: 0 };
  const rows = [...sources].map(([k, source]) => {
    const original = raw.get(k), c = classes.get(k), contract = contracts.get(c.scopeId);
    summary[c.status] = (summary[c.status] ?? 0) + 1;
    const scope = c.scopeId ? { id: c.scopeId, title: contract?.title ?? null, number: contract?.number ?? null, status: contract?.status ?? 'UNKNOWN', archived: contract?.status === 'archived' } : null;
    if (scope?.archived) summary.archivedScopeRows++;
    const targets = source.sha256 === null || source.bytes === null ? [] : portal.documents.filter(t => t.sha256 === source.sha256 && t.bytes === source.bytes).map(t => {
      const doc = documents.get(t.documentId), rev = revisions.get(t.revisionId), targetScope = contracts.get(t.scopeId);
      return { scopeId: t.scopeId, scopeTitle: targetScope?.title ?? null, scopeStatus: targetScope?.status ?? 'UNKNOWN', archived: targetScope?.status === 'archived',
        inOwnScope: t.scopeId === c.scopeId, documentId: t.documentId, revisionId: t.revisionId, contractRole: doc?.contract_role ?? null,
        mainDocumentId: doc?.main_document_id ?? null, revisionSeq: rev?.revision_seq ?? null, sha256: t.sha256, bytes: t.bytes };
    });
    if (c.status === 'SCOPED_HASH_CANDIDATE' && !targets.some(t => t.inOwnScope && t.documentId === c.documentId && t.revisionId === c.revisionId)) fail('REVIEW_CANDIDATE_NOT_IN_OWN_SCOPE');
    return { sourceId: source.sourceId, entryId: source.entryId, originalPath: original.path, readPath: provenance.get(k)?.readPath ?? original.path, sha256: source.sha256, bytes: source.bytes, classification: c.status,
      scope, scopeEvidence: c.scopeEvidence ?? [], targets, declaredBytes: provenance.get(k)?.declaredBytes ?? null, observedBytes: provenance.get(k)?.observedBytes ?? null, registrySizeChanged: provenance.get(k)?.registrySizeChanged === true, provenanceStatus: provenance.get(k)?.status ?? null, derivedDocumentName: provenance.get(k)?.documentHeader?.documentName ?? null, derivedHeaderStatus: provenance.get(k)?.headerStatus ?? null, derivedSha256: provenance.get(k)?.derivedSha256 ?? null, originalCandidates: provenance.get(k)?.originalCandidates ?? [], proposedTarget: c.status === 'SCOPED_HASH_CANDIDATE' ? { scopeId: c.scopeId, documentId: c.documentId, revisionId: c.revisionId } : null,
      acceptedTarget: null, reuseCount: c.revisionId ? reuse.get(c.revisionId) ?? 0 : 0,
      proposedAction: c.status === 'SOURCE_NOT_HASHED' ? 'FIND_VERIFIED_ORIGINAL_OR_OWNER_WITHDRAWAL' : c.status === 'SCOPED_HASH_CANDIDATE' ? 'OWNER_REVIEW_OWN_SCOPE_MATCH' : 'REGISTER_IN_OWN_SCOPE_AFTER_OWNER_DECISION',
      decision: null, decisionReason: null, decidedBy: null, decidedAt: null };
  });
  return { schemaVersion: 1, purpose: 'UNSIGNED_OWNER_REVIEW_PROPOSAL', locusSnapshotId: locus.snapshotId, portalSnapshotId: portal.snapshotId,
    portalCapturedAt: portal.capturedAt ?? null, summary, rows, humanReviewed: false, signableAsGateA: false, importedDocuments: 0, retirementAllowed: false };
}
const escape = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function renderOwnerReview(report) {
  const cell = x => `<td>${escape(x)}</td>`;
  const rows = report.rows.map(row => `<tr data-kind="${escape(row.classification)}">${[
    row.sourceId + ' / ' + row.entryId, row.classification + (row.registrySizeChanged ? '\nРАЗМЕР ИЗМЕНИЛСЯ: ' + row.declaredBytes + ' → ' + row.observedBytes : ''), row.originalPath + (row.readPath !== row.originalPath ? '\nФактический путь: ' + row.readPath : '') + (row.provenanceStatus ? '\n' + row.provenanceStatus : '') + (row.derivedDocumentName ? '\nИмя по MD (не утверждено): ' + row.derivedDocumentName : ''), row.sha256 ?? ('НЕ ПРОВЕРЕН' + (row.derivedSha256 ? '\nSHA MD-копии: ' + row.derivedSha256 : '')), row.bytes,
    row.scope ? `${row.scope.title ?? row.scope.id} / ${row.scope.status}${row.scope.archived ? ' / АРХИВНЫЙ' : ''}` : 'Область не установлена',
    row.targets.map(t => `${t.inOwnScope ? 'СВОЯ' : 'ЧУЖАЯ'}: ${t.scopeTitle ?? t.scopeId} / ${t.scopeStatus} / ${t.contractRole ?? '?'} / ${t.documentId} / ${t.revisionId} / ред.${t.revisionSeq ?? '?'}`).join('\n'),
    row.reuseCount > 1 ? `${row.reuseCount} исходных записей на предложенную редакцию` : '', row.originalCandidates.map(c => `${c.path} / ${c.sha256} / ${c.bytes} байт / НЕ УТВЕРЖДЕНО`).join('\n'), row.proposedAction, 'РЕШЕНИЯ НЕТ'
  ].map(cell).join('')}</tr>`).join('\n');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>19-A: таблица владельца</title><style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:7px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{position:sticky;top:0;background:#eef}input{padding:10px;width:70%}.note{background:#fff2c7;padding:12px}</style><h1>19-A: предварительная таблица решений владельца</h1><p class="note">Не является подписью или окончательным планом импорта. humanReviewed=false; все решения пусты. SHA/область кандидата требуют проверки, чужая область не засчитывается. До согласованной заморозки и свежего backup не подписывать как гейт A.</p><p>Всего исходных записей: ${report.rows.length}. Повторных редакций: ${report.summary.reusedTargetRevisions} для ${report.summary.logicalRowsReusingRevision} записей. Архивных исходных областей: ${report.summary.archivedScopeRows}. Снимок портала: ${escape(report.portalSnapshotId)}, ${escape(report.portalCapturedAt)}.</p><label>Фильтр <input id="filter" placeholder="Статус, путь, договор или идентичность"></label><table><thead><tr>${['Идентичность', 'Класс', 'Исходный путь', 'SHA оригинала', 'Байт', 'Исходная область', 'Предлагаемые редакции и роли', 'Алиасы', 'Кандидаты оригиналов (не утверждены)', 'Что требуется', 'Решение владельца'].map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table><script>document.getElementById('filter').addEventListener('input',e=>{const q=e.target.value.toLocaleLowerCase();for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLocaleLowerCase().includes(q)});</script></html>`;
}

const pathKey = p => process.platform === 'win32' ? resolve(p).normalize('NFC').toLowerCase() : resolve(p).normalize('NFC');
export function mergeRelocatedWalk({ base, replacement, relocation }) {
  if (relocation?.decisionRef !== 'docs/decisions.md#D-048' || !isAbsolute(relocation.oldRoot ?? '') || !isAbsolute(relocation.newRoot ?? '')) fail('OWNER_RELOCATION_REQUIRED');
  if (replacement.roots?.length !== 1 || pathKey(replacement.roots[0].path) !== pathKey(relocation.newRoot)) fail('RELOCATION_ROOT_MISMATCH');
  const next = replacement.roots[0], prior = base.roots.find(r => r.rootId === next.rootId);
  if (!prior || pathKey(prior.path) !== pathKey(relocation.oldRoot)) fail('RELOCATION_ROOT_MISMATCH');
  return { schemaVersion: 1, purpose: 'COMPOSITE_BASELINE_NOT_FROZEN_PAIR', startedAt: [base.startedAt, replacement.startedAt].sort()[0], finishedAt: [base.finishedAt, replacement.finishedAt].sort().at(-1),
    roots: base.roots.map(r => r.rootId === next.rootId ? next : r), entries: [...base.entries.filter(e => e.rootId !== next.rootId), ...replacement.entries],
    errors: [...base.errors.filter(e => e.rootId !== next.rootId), ...replacement.errors],
    complete: false, contentSnapshotPreserved: false, atomicFilesystemSnapshot: false, ownerRelocation: relocation, retirementAllowed: false };
}
export function deriveFullWalkRegistry({ registry, walk, sourceCatalog, snapshotId, relocations = [], derivedCopies }) {
  const { entries: raw, roots } = validateLocusRegistryExport({ registry, sourceCatalog, snapshotId });
  if (walk?.schemaVersion !== 1 || !Array.isArray(walk.entries) || !Array.isArray(walk.roots)) fail('INVALID_FULL_WALK');
  for (const r of relocations) if (r.decisionRef !== 'docs/decisions.md#D-048' || !isAbsolute(r.oldRoot ?? '') || !isAbsolute(r.newRoot ?? '') || !Array.isArray(r.sourceIds)) fail('OWNER_RELOCATION_REQUIRED');
  const derivedIds = new Set();
  if (derivedCopies) {
    if (derivedCopies.authority !== 'DIRECT_OWNER_REPLY_IN_CURRENT_CHAT' || derivedCopies.kind !== 'DERIVED_MD_COPIES_REQUIRE_PDF_DOCX' || !Array.isArray(derivedCopies.identities)) fail('OWNER_DERIVED_COPY_DECISION_REQUIRED');
    for (const item of derivedCopies.identities) {
      const k = key(item);
      if (derivedIds.has(k) || !raw.some(r => key(r) === k && /\.md$/iu.test(r.path))) fail('INVALID_DERIVED_COPY_IDENTITY');
      derivedIds.add(k);
    }
  }
  const originals = new Set(walk.roots.filter(r => r.kind === 'originals').map(r => r.rootId));
  const paths = new Map(), registeredPaths = new Set();
  for (const e of walk.entries) if (e.type === 'file' && originals.has(e.rootId)) {
    const k = pathKey(e.path); if (!paths.has(k)) paths.set(k, []); paths.get(k).push(e);
  }
  const documents = [], observations = [], statuses = {};
  for (const row of raw) {
    let actualPath = row.path, status, sha256 = null, bytes = null, derivedSha256 = null;
    let originalCandidates = [];
    const mappings = relocations.filter(r => r.sourceIds.includes(row.sourceId) && withinRoot(r.oldRoot, row.path));
    if (mappings.length > 1) fail('AMBIGUOUS_OWNER_RELOCATION');
    if (mappings.length) {
      const mapping = mappings[0]; actualPath = resolve(mapping.newRoot, relative(mapping.oldRoot, row.path));
      if (!withinRoot(mapping.newRoot, actualPath)) fail('RELOCATION_PATH_ESCAPE');
    }
    registeredPaths.add(pathKey(actualPath));
    const matches = paths.get(pathKey(actualPath)) ?? [];
    if (!(roots.get(row.sourceId) ?? []).some(root => withinRoot(root, row.path))) status = 'SOURCE_NOT_CONFIGURED';
    else if (derivedIds.has(key(row))) {
      status = 'DERIVED_COPY_REQUIRES_ORIGINAL';
      if (matches.length && matches.every(e => /^[a-f0-9]{64}$/u.test(e.sha256 ?? '')) && new Set(matches.map(e => e.sha256)).size === 1) derivedSha256 = matches[0].sha256;
      const allowedRootIds = new Set(matches.map(e => e.rootId));
      const stem = p => basename(p).normalize('NFC').toLocaleLowerCase('ru').replace(/\.md$/u, '').replace(/\.(?:pdf|docx)$/u, '');
      originalCandidates = [...paths.values()].flatMap(rows => rows.filter(e => allowedRootIds.has(e.rootId) && /\.(?:pdf|docx)$/iu.test(e.path) && stem(e.path) === stem(actualPath) && /^[a-f0-9]{64}$/u.test(e.sha256 ?? '')).slice(0, 1)).map(e => ({ path: e.path, sha256: e.sha256, bytes: e.bytes, approved: false, matchRule: 'SAME_BASENAME_IN_CONFIRMED_SOURCE_ROOT_ONLY' }));
    }
    else if (!matches.length || matches.some(e => !/^[a-f0-9]{64}$/u.test(e.sha256 ?? ''))) status = 'ORIGINAL_UNVERIFIED';
    else if (new Set(matches.map(e => `${e.sha256}:${e.bytes}`)).size !== 1) status = 'PATH_CHANGED_BETWEEN_ROOTS';
    else { status = 'HASHED_FROM_FULL_WALK'; sha256 = matches[0].sha256; bytes = matches[0].bytes; }
    if (status === 'ORIGINAL_UNVERIFIED') {
      const allowedRootIds = new Set(walk.roots.filter(r => r.kind === 'originals' && r.sourceIds?.includes(row.sourceId)).map(r => r.rootId));
      const allowedPaths = [...(roots.get(row.sourceId) ?? []), ...mappings.map(r => r.newRoot)];
      originalCandidates = [...paths.values()].flatMap(rows => {
        const eligible = rows.filter(e => allowedRootIds.has(e.rootId) && allowedPaths.some(root => withinRoot(root, e.path)) && basename(e.path).normalize('NFC').toLocaleLowerCase('ru') === basename(actualPath).normalize('NFC').toLocaleLowerCase('ru'));
        if (!eligible.length || eligible.some(e => !/^[a-f0-9]{64}$/u.test(e.sha256 ?? '')) || new Set(eligible.map(e => `${e.sha256}:${e.bytes}`)).size !== 1) return [];
        const e = eligible[0];
        return [{ path: e.path, sha256: e.sha256, bytes: e.bytes, approved: false, scopeConfirmed: false, declaredSizeMatches: e.bytes === row.declaredSize, matchRule: 'SAME_BASENAME_IN_CONFIGURED_SOURCE_NOT_APPROVED' }];
      });
    }
    const declaredBytes = Number.isSafeInteger(row.declaredSize) ? row.declaredSize : null;
    const observedBytes = matches.length && new Set(matches.map(e => e.bytes)).size === 1 && Number.isSafeInteger(matches[0].bytes) ? matches[0].bytes : null;
    const registrySizeChanged = declaredBytes !== null && observedBytes !== null && declaredBytes !== observedBytes;
    documents.push({ sourceId: row.sourceId, entryId: row.entryId, sha256, bytes });
    observations.push({ sourceId: row.sourceId, entryId: row.entryId, declaredPath: row.path, readPath: actualPath, status, declaredBytes, observedBytes, registrySizeChanged, ownerRelocated: mappings.length === 1, originalCandidates, ...(derivedIds.has(key(row)) ? { derivedSha256, originalCandidates } : {}) });
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  const unindexedOriginals = [...paths].filter(([k]) => !registeredPaths.has(k)).map(([, rows]) => ({ path: rows[0].path, rootIds: [...new Set(rows.map(r => r.rootId))],
    sha256: new Set(rows.map(r => r.sha256)).size === 1 ? rows[0].sha256 : null, bytes: rows[0].bytes, ownerDisposition: null, registeredInPortal: false }));
  const verifiedByHash = new Map(); let verifiedPathBytes = 0;
  for (const rows of paths.values()) {
    if (rows.some(e => !/^[a-f0-9]{64}$/u.test(e.sha256 ?? '') || !Number.isSafeInteger(e.bytes) || e.bytes < 0) || new Set(rows.map(e => `${e.sha256}:${e.bytes}`)).size !== 1) continue;
    const file = rows[0]; verifiedPathBytes += file.bytes;
    if (verifiedByHash.has(file.sha256) && verifiedByHash.get(file.sha256) !== file.bytes) fail('FULL_WALK_HASH_SIZE_CONFLICT');
    verifiedByHash.set(file.sha256, file.bytes);
  }
  const sourceFootprint = { uniqueSourcePaths: paths.size, verifiedPathBytes, verifiedUniqueBlobs: verifiedByHash.size, verifiedUniqueBlobBytes: [...verifiedByHash.values()].reduce((a, b) => a + b, 0), authenticity: 'CANDIDATES_NOT_APPROVED_ORIGINALS' };
  return { inventory: { schemaVersion: 1, system: 'locus', snapshotId, capturedAt: walk.finishedAt, complete: false,
    errors: ['FULL_WALK_NOT_FROZEN_PAIR', ...(observations.some(o => o.registrySizeChanged) ? ['REGISTRY_SIZE_CHANGED'] : []), ...(walk.errors?.length ? ['FULL_WALK_ERRORS'] : [])], documents, observations,
    statistics: { entries: documents.length, statuses }, retirementAllowed: false }, unindexedOriginals, sourceFootprint, logicalRegistryDenominator: documents.length, retirementAllowed: false };
}
