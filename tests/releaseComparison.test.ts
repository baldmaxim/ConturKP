// Этап 15: сравнение двух выпусков через API на настоящем worker и LibreOffice (проект §8–§12; проверки задания:
// сравнение после переиндексации, новое имя того же документа, новые файлы вне области; A10, A13, A14, A23). Выпуски —
// тестовые, данные поддельные: поддельный TenderHub, синтетические документы и письмо. Тесты идут по порядку.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNKER_VERSION } from '../packages/core/src/index.ts';
import { createVersion } from '../packages/db/src/index.ts';
import { buildStage13, buildStageContent, closeStage13, notApplicable, PLASTER_LINE, requirementOf, rerunReview, TZ, type IStage13 } from './approvalFixtures.ts';
import { captureNow, linkSource } from './calculationFixtures.ts';
import { decide, E, effectMap, lineageOf, unitOf, units, v2Tender, type IEcon } from './economicsFixtures.ts';
import { act, draftOf, fieldOf } from './formsFixtures.ts';
import { auditRows, drain, idem, type TestClient } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess, unlinkMail } from './mailFixtures.ts';
import { completeDraft } from './releaseFixtures.ts';
import { buildIndex, fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';
import { released, type IReleased } from './sendFixtures.ts';
import { n } from '../scripts/tenderhub-fake.ts';

interface ISide {
  ref: string | null;
  sha256: string | null;
  label: string | null;
  note: string | null;
  value?: unknown;
}
interface IItem {
  id: string;
  ordinal: number;
  section: string;
  change: string;
  subjectType: string;
  closed: boolean;
  left: ISide | null;
  right: ISide | null;
  detail: Record<string, unknown>;
  evidence: { type: string; id: string }[];
  reason: { version: number; reasonStatus: string; rationale: string | null; restricted: boolean; fragmentIds: string[] } | null;
  reasonVersion: number;
  reasonStatus: string;
}
interface IComparison {
  id: string;
  status: string;
  resultSha256: string;
  left: { releaseId: string; candidateSeq: number; stage: { id: string } };
  right: { releaseId: string; candidateSeq: number; stage: { id: string } };
  sections: Record<string, { left: number; right: number; unchanged: number; changes: Record<string, number>; unavailable?: string }>;
  calculation: { state: string; comparisonId: string | null; totals: Record<string, { left: string; right: string; delta: string }> | null; reasons: Record<string, number> | null; remainder: { measure: string; amount: string }[] | null; outdated: boolean };
  interval: { from: string; to: string; empty: boolean };
  reasons: { unknown: number; hypothesis: number; confirmed: number };
  can: { setReason: boolean };
}

let st: IStage13;
let a: IReleased;
let b: IReleased;
let cmp: IComparison;
let mailbox: string;
const ids = { lateRev: '', newRev: '', outRev: '', newRun: '', letterRevision: '', letterMessage: '', mailFragment: '', newFragment: '' };

const NEW_REQ = 'Монтаж ограждений балконов выполняется из нержавеющей стали.';
const LATE_TEXT = 'Грунты основания — суглинки тугопластичные.';
const LETTER_TEXT = 'Заказчик просит предусмотреть охрану площадки в ночное время.';
const lateBytes = Buffer.from(`%PDF-1.4\n% геология ${randomBytes(6).toString('hex')}\n`, 'utf8');

const uploadBytes = async (client: TestClient, name: string, bytes: Buffer) => {
  const r = await client.post(`/stages/${st.e.s.stageA}/imports?name=${encodeURIComponent(name)}`, bytes, { headers: { 'Content-Type': 'application/octet-stream', ...idem() } });
  expect(r.status, r.text).toBe(202);
  await drain(st.e.worker);
  const batch = await client.get(`/imports/${r.body.id}`);
  return batch.body.items[0] as { status: string; documentRevisionId: string };
};

const compare = async (leftId: string, rightId: string, client: TestClient = st.e.s.eng1) => client.post(`/tenders/${st.e.s.tenderA}/release-comparisons`, { leftReleaseId: leftId, rightReleaseId: rightId }, { headers: idem() });
const read = async (id: string, client: TestClient = st.e.s.eng1): Promise<IComparison> => {
  const r = await client.get(`/release-comparisons/${id}`);
  expect(r.status, r.text).toBe(200);
  return r.body as IComparison;
};
const items = async (id: string, section: string, client: TestClient = st.e.s.eng1): Promise<IItem[]> => {
  const r = await client.get(`/release-comparisons/${id}/items?section=${section}&limit=200`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as IItem[];
};
const reason = (item: IItem, body: Record<string, unknown>, client: TestClient = st.e.s.eng1, version = item.reasonVersion) =>
  client.put(`/release-comparison-items/${item.id}/reason`, body, { headers: { 'If-Match': `"${item.id}:${version}"` } });

beforeAll(async () => {
  st = await buildStage13();
  mailbox = await createMailbox(st.e.s.admin, 'tender-in@contractor.example.test', 'Тендерный отдел');
  await setMailAccess(st.e.s.admin, mailbox, st.e.s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
  await setMailAccess(st.e.s.admin, mailbox, st.e.s.ids.manager, ['mail.read']);
  // До первого выпуска: документ получен, но не распознан и в набор источников не включён.
  ids.lateRev = (await uploadBytes(st.e.s.eng1, 'Геология.pdf', lateBytes)).documentRevisionId;
  a = await released(st, 'test');

  // ---- Между выпусками
  ids.newRev = await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Изменение ТЗ № 1.pdf');
  ids.newRun = await seedEvidenceRun(st.db.pool, ids.newRev, { pages: [{ blocks: [NEW_REQ] }] });
  ids.outRev = await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Реклама поставщика.pdf');
  // То же содержимое под новым именем — не новый документ (A14); затем оно распознано (поздно).
  const copy = await uploadBytes(st.e.s.eng1, 'Геология (копия с Яндекс Диска).pdf', lateBytes);
  expect(copy).toMatchObject({ status: 'duplicate', documentRevisionId: ids.lateRev });
  await seedEvidenceRun(st.db.pool, ids.lateRev, { pages: [{ blocks: [LATE_TEXT] }] });
  const letter = await importEml(st.e.s.eng1, st.e.worker, mailbox, eml({ subject: 'Охрана площадки: закрытая тема', text: LETTER_TEXT, date: new Date().toUTCString() }), { direction: 'inbound' });
  expect(letter.status).toBe('done');
  ids.letterRevision = letter.revisionId!;
  ids.letterMessage = letter.messageId!;
  await linkMail(st.e.s.eng1, letter.messageId!, st.e.s.tenderA, st.e.s.stageA);
  // Расчёт: те же итоги, другое количество и цена строки штукатурки (110 × 12 → 120 × 11).
  const t = v2Tender();
  const line = t.items.find((x) => x.id === PLASTER_LINE)!;
  line.quantity = n('120');
  line.base_quantity = n('120');
  line.unit_rate = n('11');
  st.e.hub.tenders.set(E.v2, t);
  const cap = await captureNow(st.db, st.e.worker, st.e.s.eng1, st.e.s.stageA);
  expect(cap.status, JSON.stringify(cap.failure)).toBe('complete');
  // Новый набор источников, снимок и реестр (требования переносятся); новое требование и покрытие.
  await setWorkingSet(st.e.s.manager, st.e.s.stageA, [st.tzRev, ids.newRev, ids.lateRev], true);
  const scope2 = await fixScope(st.e.s.manager, st.e.s.stageA);
  const reg = await st.e.s.manager.post(`/stages/${st.e.s.stageA}/requirement-registries`, { evidenceScopeId: scope2, reason: 'Реестр после изменения ТЗ' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  const reg2 = { e: st.e, registryId: reg.body.id as string };
  ids.newFragment = await fragmentIdOf(st.db.pool, ids.newRun, NEW_REQ);
  await requirementOf(reg2, 'Ограждения балконов — из нержавеющей стали', ids.newFragment);
  ids.mailFragment = (await st.db.pool.query<{ id: string }>('SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 ORDER BY ordinal LIMIT 1', [ids.letterRevision])).rows[0]!.id;
  await requirementOf(reg2, 'Охрана площадки в ночное время', ids.mailFragment);
  const paint = (await st.db.pool.query<{ id: string }>("SELECT id FROM requirement_revision WHERE registry_id = $1 AND status = 'confirmed' AND statement LIKE 'Окраска%'", [reg2.registryId])).rows[0]!.id;
  const cov = await st.e.s.manager.post(`/requirement-revisions/${paint}/coverage`, { state: 'uncovered', reason: 'Отдельной строки окраски в расчёте нет' }, { headers: idem() });
  expect(cov.status, cov.text).toBe(201);
  // Проход реестра: справочный текст геологии — «не требование».
  const marked = await st.e.s.manager.post(`/requirement-registries/${reg2.registryId}/marks`, { mark: 'not_requirement', reason: 'справочные данные изысканий', selector: { kind: 'document_revision', documentRevisionId: ids.lateRev } }, { headers: idem() });
  expect(marked.status, marked.text).toBe(201);
  const pass = await st.e.s.manager.post(`/requirement-registries/${reg2.registryId}/reviews`, {}, { headers: idem() });
  expect(pass.status, pass.text).toBe(201);
  await st.e.worker.scheduleFactExtraction();
  await drain(st.e.worker);
  const q = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/customer-questions`, { text: 'Подтвердите марку стали ограждений' }, { headers: idem() });
  expect(q.status, q.text).toBe(201);
  expect((await st.e.s.eng1.patch(`/customer-questions/${q.body.id}`, { status: 'sent' }, { headers: { 'If-Match': q.headers.etag as string } })).status).toBe(200);
  const d = await draftOf(st.e.s.eng1, st.drafts.letter);
  expect((await act(st.e.s.eng1, st.drafts.letter, 'subject', fieldOf(d, 'subject').etag, { action: 'set', value: 'Строительство объекта с учётом изменения ТЗ № 1', bases: [] })).status).toBe(200);
  if ((await draftOf(st.e.s.eng1, st.drafts.letter)).status !== 'complete') await completeDraft(st.e.s.eng1, st.drafts.letter);
  await rerunReview(st);
  b = await released(st, 'test');
}, 900_000);
afterAll(async () => closeStage13(st));

describe('сравнение двух выпусков одного этапа', () => {
  it('стороны упорядочены по времени выпуска независимо от порядка в запросе; результат готов и неизменен', async () => {
    const r = await compare(b.releaseId, a.releaseId);
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'ready', left: { releaseId: a.releaseId }, right: { releaseId: b.releaseId }, methodVersion: 'release-compare/15-1' });
    cmp = await read(r.body.id as string);
    expect(cmp.resultSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(cmp.interval.empty).toBe(false);
    expect((await compare(a.releaseId, a.releaseId)).status).toBe(400);
    expect((await compare(a.releaseId, '7d1f0c8e-1010-4a6b-9c1d-ffffffffffff')).status).toBe(400);
    expect((await st.db.pool.query("UPDATE release_comparison SET summary = '{}'::jsonb WHERE id = $1", [cmp.id]).then(() => 'ok', (e: { code?: string }) => e.code))).toBe('55000');
    expect((await st.db.pool.query("INSERT INTO release_comparison_item (comparison_id, ordinal, section, change, subject_type, item_key) VALUES ($1, 9999, 'sources', 'added', 'document_revision', 'x')", [cmp.id]).then(() => 'ok', (e: { code?: string }) => e.code))).toBe('55000');
  });

  it('источники: новый документ и письмо — «добавлено»; ТЗ без изменений строк не даёт', async () => {
    const list = await items(cmp.id, 'sources');
    const added = list.filter((i) => i.change === 'added');
    expect(added.map((i) => i.right!.ref).sort()).toEqual([ids.newRev, ids.lateRev, ids.letterRevision].sort());
    expect(added.find((i) => i.right!.ref === ids.newRev)).toMatchObject({ subjectType: 'document_revision', closed: false, right: { label: expect.stringContaining('Изменение ТЗ № 1') }, evidence: [{ type: 'document_revision', id: ids.newRev }] });
    expect(added.find((i) => i.right!.ref === ids.letterRevision)).toMatchObject({ subjectType: 'mail_message_revision', right: { label: 'Охрана площадки: закрытая тема' } });
    expect(list.some((i) => i.left?.ref === st.tzRev || i.right?.ref === st.tzRev)).toBe(false);
    expect(cmp.sections.sources).toMatchObject({ left: 1, right: 4, unchanged: 1, changes: { added: 3 } });
  });

  it('получено между выпусками: в области, вне области (с решением руководителя), поздно распознано, то же содержимое под новым именем', async () => {
    const list = await items(cmp.id, 'received');
    const by = (change: string) => list.filter((i) => i.change === change);
    expect(by('in_scope').map((i) => i.right!.ref).sort()).toEqual([ids.newRev, ids.letterRevision].sort());
    const out = by('out_of_scope');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subjectType: 'document_revision', right: { ref: ids.outRev, label: expect.stringContaining('Реклама поставщика') }, detail: { disposition: 'not_applicable', decisionId: expect.any(String) } });
    const late = by('late_recognized');
    expect(late).toHaveLength(1);
    expect(late[0]!.right).toMatchObject({ ref: ids.lateRev, label: expect.stringContaining('Геология') });
    const renamed = by('same_content_new_name');
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ subjectType: 'document_occurrence', right: { ref: ids.lateRev, note: expect.stringContaining('Геология (копия с Яндекс Диска).pdf') } });
    // Файл вне области не стал ни источником выпуска, ни требованием.
    expect((await items(cmp.id, 'sources')).some((i) => i.right?.ref === ids.outRev)).toBe(false);
    expect(JSON.stringify(await items(cmp.id, 'requirements'))).not.toContain('Реклама');
  });

  it('требования: новые — «добавлено», изменённое покрытие — отдельно, перенесённое без изменений строк не даёт', async () => {
    const list = await items(cmp.id, 'requirements');
    expect(list.filter((i) => i.change === 'added').map((i) => i.right!.label).sort()).toEqual([expect.stringContaining('Ограждения балконов'), expect.stringContaining('Охрана площадки')]);
    const cov = list.filter((i) => i.change === 'coverage_changed');
    // Покрытие с новым реестром не переносится: у перенесённого требования оценки нет — это видно, а не скрыто.
    expect(cov).toHaveLength(2);
    expect(cov.find((i) => i.left!.label!.includes('Окраска фасада'))).toMatchObject({ detail: { leftCoverage: null, rightCoverage: 'uncovered' } });
    expect(cov.find((i) => i.left!.label!.includes('Штукатурка'))).toMatchObject({ detail: { leftCoverage: 'covered', rightCoverage: null } });
    // Формулировки перенесённых требований те же: «изменено» нет.
    expect(list.some((i) => i.change === 'changed' || i.change === 'removed')).toBe(false);
    expect(cmp.sections.requirements).toMatchObject({ left: 2, right: 4, unchanged: 0, changes: { added: 2, coverage_changed: 2 } });
  });

  it('вопросы, решения, приложения: открытый вопрос, решения по удержаниям, изменённые файл и поле', async () => {
    const questions = await items(cmp.id, 'questions');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ change: 'opened', subjectType: 'customer_question', right: { label: 'Подтвердите марку стали ограждений' } });
    const decisions = await items(cmp.id, 'decisions');
    expect(decisions.filter((i) => i.subjectType === 'decision' && i.change === 'added').length).toBeGreaterThan(0);
    expect(decisions.filter((i) => i.subjectType === 'hold_decision' && i.change === 'added').length).toBeGreaterThan(0);
    const apps = await items(cmp.id, 'applications');
    const field = apps.find((i) => i.subjectType === 'field_version')!;
    expect(field).toMatchObject({ change: 'changed', detail: { fieldKey: 'subject' }, right: { value: 'Строительство объекта с учётом изменения ТЗ № 1' } });
    expect(field.left!.value).not.toBe(field.right!.value);
    const file = apps.filter((i) => i.subjectType === 'candidate_file' && i.change === 'changed');
    expect(file.length).toBeGreaterThan(0);
    expect(file[0]!.left!.sha256).not.toBe(file[0]!.right!.sha256);
    expect(apps.every((i) => i.evidence.length > 0)).toBe(true);
  });

  it('расчёт: сравнение ревизий этапа 10 — вклады сходятся с общей разницей, причины единиц «не установлены», остаток показан', async () => {
    const c = cmp.calculation;
    expect(c).toMatchObject({ state: 'compared', comparisonId: expect.any(String), outdated: false });
    expect(c.reasons!.unknown).toBeGreaterThan(0);
    expect(c.reasons!.confirmed).toBe(0);
    expect(c.remainder!.length).toBeGreaterThan(0);
    const calc = await st.e.s.eng1.get(`/comparisons/${c.comparisonId}`);
    expect(calc.status, calc.text).toBe(200);
    expect(calc.body.status).toBe('ready');
    expect(c.totals!.cost).toMatchObject({ delta: '0' });
    // Пары позиций двух выгрузок инженер ещё не подтвердил: строка штукатурки — «добавлено» и «снято», итог сходится.
    const all = await units(st.e.s.eng1, c.comparisonId!);
    const plaster = all.filter((u) => u.title.includes('Штукатурка'));
    expect(plaster.map((u) => u.kind).sort()).toEqual(['added', 'removed']);
    // Инженер подтверждает пары — сравнение расчёта устарело; новый запуск раскладывает изменение по факторам.
    const lineage = await lineageOf(st.e.s.eng1, c.comparisonId!);
    const proposed = lineage.body.items.filter((x) => x.status === 'proposed').map((x) => ({ fromPositionId: x.fromPositionId, toPositionId: x.toPositionId, status: 'confirmed' as const }));
    expect(proposed.length).toBeGreaterThan(0);
    expect((await decide(st.e.s.eng1, c.comparisonId!, lineage.etag, proposed)).status).toBe(201);
    expect((await read(cmp.id)).calculation.outdated).toBe(true);
    const next = await compare(a.releaseId, b.releaseId);
    expect(next.status, next.text).toBe(201);
    const fresh = await read(next.body.id as string);
    expect(fresh.calculation).toMatchObject({ state: 'compared', outdated: false });
    expect(fresh.calculation.comparisonId).not.toBe(c.comparisonId);
    expect(fresh.resultSha256).not.toBe(cmp.resultSha256);
    // Количество 110 → 120 и цена 12 → 11 при том же итоге: два ненулевых вклада, сумма — ноль (A20).
    const matched = unitOf(await units(st.e.s.eng1, fresh.calculation.comparisonId!), E.q.A);
    expect(effectMap(matched, 'cost')).toMatchObject({ volume: '120', unit_rate: '-120' });
    expect(fresh.calculation.totals!.cost).toMatchObject({ delta: '0' });
    expect(fresh.sections).toEqual(cmp.sections);
    cmp = fresh;
  });
});

describe('доказательства и статус причины (I11, A23)', () => {
  it('у вывода причина «не установлена», пока её не записал человек; «подтверждена» — только с основанием, которое автор читает', async () => {
    const item = (await items(cmp.id, 'requirements')).find((i) => i.change === 'added' && i.right!.label!.includes('Ограждения'))!;
    expect(item).toMatchObject({ reasonStatus: 'unknown', reasonVersion: 0, reason: null });
    expect(cmp.reasons.confirmed).toBe(0);
    expect((await reason(item, { reasonKind: 'document', reasonStatus: 'confirmed', rationale: 'Изменение ТЗ № 1', fragmentIds: [], decisionIds: [] })).status).toBe(400);
    expect((await reason(item, { reasonKind: 'document', reasonStatus: 'hypothesis', fragmentIds: [], decisionIds: [] })).status).toBe(400);
    const hyp = await reason(item, { reasonKind: 'document', reasonStatus: 'hypothesis', rationale: 'Вероятно, изменение ТЗ', fragmentIds: [], decisionIds: [] });
    expect(hyp.status, hyp.text).toBe(200);
    expect(hyp.body).toMatchObject({ version: 1, reason: { reasonStatus: 'hypothesis' } });
    const stale = await reason(item, { reasonKind: 'document', reasonStatus: 'confirmed', rationale: 'Изменение ТЗ № 1', fragmentIds: [ids.newFragment], decisionIds: [] });
    expect(stale.status).toBe(412);
    const ok = await reason(item, { reasonKind: 'document', reasonStatus: 'confirmed', rationale: 'Изменение ТЗ № 1: новое требование к ограждениям', fragmentIds: [ids.newFragment], decisionIds: [] }, st.e.s.eng1, 1);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ version: 2, reason: { reasonStatus: 'confirmed', fragmentIds: [ids.newFragment] } });
    const after = (await items(cmp.id, 'requirements')).find((i) => i.id === item.id)!;
    expect(after).toMatchObject({ reasonStatus: 'confirmed', reasonVersion: 2, reason: { rationale: expect.stringContaining('ограждениям'), restricted: false } });
    expect((await read(cmp.id)).reasons).toMatchObject({ confirmed: 1 });
    const history = await st.e.s.eng1.get(`/release-comparison-items/${item.id}/reasons`);
    expect((history.body.items as { version: number; reasonStatus: string }[]).map((x) => [x.version, x.reasonStatus])).toEqual([[2, 'confirmed'], [1, 'hypothesis']]);
    // Версии причины неизменны; пояснение в журнал не копируется.
    expect((await st.db.pool.query("UPDATE release_comparison_reason SET rationale = 'x' WHERE item_id = $1", [item.id]).then(() => 'ok', (e: { code?: string }) => e.code))).not.toBe('ok');
    expect(JSON.stringify(await auditRows(st.db.pool, "action = 'release.comparison.reason.set'"))).not.toContain('ограждениям');
  });

  it('основание вне снимков сторон или чужое — отказ; вторая линия повторяет', async () => {
    const item = (await items(cmp.id, 'received')).find((i) => i.change === 'out_of_scope')!;
    const foreign = (await st.db.pool.query<{ id: string }>('SELECT id FROM decision WHERE tender_id <> $1 LIMIT 1', [st.e.s.tenderA])).rows[0];
    if (foreign) expect((await reason(item, { reasonKind: 'internal_decision', reasonStatus: 'confirmed', rationale: 'Чужое решение', fragmentIds: [], decisionIds: [foreign.id] })).body.current).toMatchObject({ reason: 'basis_out_of_scope' });
    const decisionId = item.detail.decisionId as string;
    const ok = await reason(item, { reasonKind: 'internal_decision', reasonStatus: 'confirmed', rationale: 'Реклама поставщика к комплекту не относится', fragmentIds: [], decisionIds: [decisionId] });
    expect(ok.status, ok.text).toBe(200);
    expect((await st.db.pool.query("INSERT INTO release_comparison_reason (tender_id, comparison_id, item_id, version, reason_kind, reason_status, rationale, actor_user_id) VALUES ($1, $2, $3, 2, 'document', 'confirmed', 'без основания', $4)", [st.e.s.tenderA, cmp.id, item.id, st.e.s.ids.eng1]).then(() => 'ok', (e: { code?: string }) => e.code))).toBe('23514');
    expect((await st.db.pool.query("INSERT INTO release_comparison_reason (tender_id, comparison_id, item_id, version, reason_kind, reason_status, rationale, actor_user_id) VALUES ($1, $2, $3, 2, 'document', 'hypothesis', 'чужой', $4)", [st.e.s.tenderA, cmp.id, item.id, st.e.s.ids.eng3]).then(() => 'ok', (e: { code?: string }) => e.code))).toBe('42501');
  });
});

describe('закрытость выводов (I05, I13, R13-02)', () => {
  it('без mail.read письмо и требование по письму закрыты: ни темы, ни текста; причина по закрытому основанию — без пояснения', async () => {
    const mailReq = (await items(cmp.id, 'requirements')).find((i) => i.right?.label?.includes('Охрана площадки'))!;
    const set = await reason(mailReq, { reasonKind: 'answer', reasonStatus: 'confirmed', rationale: 'Письмо заказчика об охране площадки', fragmentIds: [ids.mailFragment], decisionIds: [] });
    expect(set.status, set.text).toBe(200);
    for (const section of ['sources', 'requirements', 'received']) {
      const own = await items(cmp.id, section);
      const other = await items(cmp.id, section, st.e.s.eng2);
      expect(other).toHaveLength(own.length);
      expect(JSON.stringify(other)).not.toMatch(/Охрана площадки|закрытая тема|ночное время/u);
      const closed = other.filter((i) => i.closed);
      expect(closed.length).toBeGreaterThan(0);
      for (const c of closed) expect(c).toMatchObject({ left: null, right: null, detail: {}, evidence: [] });
    }
    const hidden = (await items(cmp.id, 'requirements', st.e.s.eng2)).find((i) => i.id === mailReq.id)!;
    expect(hidden).toMatchObject({ closed: true, reasonStatus: 'confirmed', reason: { rationale: null, restricted: true, fragmentIds: [] } });
    const history = await st.e.s.eng2.get(`/release-comparison-items/${mailReq.id}/reasons`);
    expect(JSON.stringify(history.body)).not.toContain('охране площадки');
    // Закрытый вывод причину не принимает; закрытое основание — тоже.
    expect((await reason(hidden, { reasonKind: 'document', reasonStatus: 'hypothesis', rationale: 'Не вижу, но объясняю', fragmentIds: [], decisionIds: [] }, st.e.s.eng2, hidden.reasonVersion)).body.current).toMatchObject({ reason: 'restricted_item' });
    const open = (await items(cmp.id, 'requirements', st.e.s.eng2)).find((i) => !i.closed && i.change === 'coverage_changed')!;
    expect((await reason(open, { reasonKind: 'answer', reasonStatus: 'confirmed', rationale: 'По письму', fragmentIds: [ids.mailFragment], decisionIds: [] }, st.e.s.eng2)).body.current).toMatchObject({ reason: 'restricted_fragments' });
  });

  it('не участник тендера не видит ни выпусков, ни сравнения, ни выводов; руководитель без права сравнивает как участник', async () => {
    const outsider = st.e.s.eng3;
    expect((await outsider.get(`/tenders/${st.e.s.tenderA}/release-comparisons`)).status).toBe(404);
    expect((await outsider.get(`/release-comparisons/${cmp.id}`)).status).toBe(404);
    expect((await outsider.get(`/release-comparisons/${cmp.id}/items`)).status).toBe(404);
    expect((await compare(a.releaseId, b.releaseId, outsider)).status).toBe(404);
    const anyItem = (await items(cmp.id, 'applications'))[0]!;
    expect((await outsider.get(`/release-comparison-items/${anyItem.id}/reasons`)).status).toBe(404);
    expect((await reason(anyItem, { reasonKind: 'unknown', reasonStatus: 'unknown', fragmentIds: [], decisionIds: [] }, outsider)).status).toBe(404);
    const list = await st.e.s.manager.get(`/tenders/${st.e.s.tenderA}/releases`);
    expect(list.status, list.text).toBe(200);
    expect((list.body.items as { id: string }[]).map((x) => x.id)).toEqual([a.releaseId, b.releaseId]);
    expect(list.body.canCompare).toBe(true);
  });
});

describe('сравнение после переиндексации и нового распознавания (I15, A10)', () => {
  it('новая версия индекса, удаление прежней и новый OCR того же файла результат не меняют: тот же хэш и те же выводы', async () => {
    const before = await items(cmp.id, 'sources');
    await buildIndex(st.db, st.e.worker);
    await seedEvidenceRun(st.db.pool, st.tzRev, { pages: [{ blocks: [TZ.plaster, 'Окраска фасада выполняется в два слоя (исправленное распознавание).'] }] });
    await createVersion(st.db.pool, { chunkerVersion: CHUNKER_VERSION, embedding: null, createdBy: null });
    await buildIndex(st.db, st.e.worker);
    await st.e.worker.maintain();
    await drain(st.e.worker);
    expect((await st.db.pool.query("SELECT count(*)::int AS n FROM search_index_version WHERE status = 'retired'")).rows[0].n).toBeGreaterThan(0);
    // Позднейшие изменения текущего состояния тоже не влияют: связь письма снята, получен новый документ, по событиям
    // выпущенного комплекта принято решение — входы сравнения закреплены в выпусках и неизменяемых событиях.
    await unlinkMail(st.e.s.eng1, ids.letterMessage, st.e.s.tenderA);
    await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Документ после второго выпуска.pdf');
    await drain(st.e.worker);
    await notApplicable(st, b.candidate.id, 'Поздний документ на выпущенный комплект не влияет');
    const again = await compare(a.releaseId, b.releaseId);
    expect(again.status, again.text).toBe(201);
    expect(again.body.id).not.toBe(cmp.id);
    const second = await read(again.body.id as string);
    expect(second.resultSha256).toBe(cmp.resultSha256);
    expect(second.sections).toEqual(cmp.sections);
    const strip = (list: IItem[]) => list.map((i) => ({ change: i.change, subjectType: i.subjectType, left: i.left?.ref ?? null, right: i.right?.ref ?? null, label: i.right?.label ?? i.left?.label ?? null }));
    expect(strip(await items(second.id, 'sources'))).toEqual(strip(before));
    // Прежнее сравнение читается как было; доказательство открывается.
    expect((await read(cmp.id)).resultSha256).toBe(cmp.resultSha256);
    expect((await st.e.s.eng1.get(`/document-revisions/${ids.newRev}/content`)).status).toBe(200);
  });
});

describe('сравнение выпусков разных этапов', () => {
  it('новая редакция ТЗ — «редакция изменена»; то же требование узнаётся по содержанию, изменённое — как новое и снятое; расчёт сравнивается между этапами', async () => {
    const stage2 = await st.e.s.manager.post(`/tenders/${st.e.s.tenderA}/stages`, { title: 'Этап A2' }, { headers: idem() });
    expect(stage2.status, stage2.text).toBe(201);
    const stageId = stage2.body.id as string;
    await linkSource(st.e.boss, stageId, E.v2, 2);
    const cap = await captureNow(st.db, st.e.worker, st.e.s.eng1, stageId);
    expect(cap.status, JSON.stringify(cap.failure)).toBe('complete');
    const e2: IEcon = { ...st.e, s: { ...st.e.s, stageA: stageId }, rev1: cap.revisionId as string, rev2: cap.revisionId as string };
    const st2 = await buildStageContent(st.db, e2, {
      templates: { letterRevision: st.letterRevision, conditionsRevision: st.conditionsRevision },
      tz: { plaster: TZ.plaster, paint: 'Окраска фасада выполняется в три слоя.' },
    });
    const c = await released(st2, 'test');
    const r = await compare(c.releaseId, a.releaseId);
    expect(r.status, r.text).toBe(201);
    const x = await read(r.body.id as string);
    expect(x.left.releaseId).toBe(a.releaseId);
    expect(x.left).toMatchObject({ restricted: false, manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(x.right).toMatchObject({ releaseId: c.releaseId, stage: { id: stageId } });
    expect(x.left.stage.id).toBe(st.e.s.stageA);
    const sources = await items(x.id, 'sources');
    const tz = sources.find((i) => i.change === 'revision_changed')!;
    expect(tz).toMatchObject({ subjectType: 'document_revision', left: { ref: st.tzRev, label: expect.stringContaining('ТЗ') }, right: { ref: st2.tzRev } });
    expect(tz.left!.sha256).not.toBe(tz.right!.sha256);
    const reqs = await items(x.id, 'requirements');
    expect(reqs.some((i) => (i.left?.label ?? i.right?.label ?? '').includes('Штукатурка'))).toBe(false);
    expect(reqs.find((i) => i.change === 'added')!.right!.label).toContain('в три слоя');
    expect(reqs.find((i) => i.change === 'removed')!.left!.label).toContain('в два слоя');
    expect(x.sections.requirements).toMatchObject({ unchanged: 1, changes: { added: 1, removed: 1 } });
    expect(x.calculation.state).toBe('compared');
    // Поля тех же форм сопоставлены: значения те же — строк нет.
    expect((await items(x.id, 'applications')).filter((i) => i.subjectType === 'field_version')).toEqual([]);
    expect((await st.e.s.eng1.get(`/tenders/${st.e.s.tenderA}/releases`)).body.items).toHaveLength(3);
  });
});
