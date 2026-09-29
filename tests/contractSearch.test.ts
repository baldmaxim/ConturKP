// Этап 06a: регрессия изоляции «тендер ↔ договор» в поиске и цитировании (D-017, D-022 OD-3, ADR-012 §24).
// Договор ищется в контексте contract только с contract.read; в тендерном контексте единица договора
// ищется, только если она в области (составе этапа или снимке) и у пользователя есть contract.read —
// иначе она исключается до ранжирования и видна лишь числом. Связь область не расширяет ни в одну сторону.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSearch, createContract, grantCreator, hitTexts, linkContract, setAccess, uploadContractDocument, uploadContractRevision, uploadMain } from './contractFixtures.ts';
import { auditRows, buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { buildIndex, fixScope, fragmentIdOf, reviewBody, searchBody, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
let worker: ReturnType<typeof makeWorker>;
let c1: string;
let c2: string;
// Снимок этапа A с единицей договора — общий для блоков ниже.
let scope1: string;
const ids = {} as Record<'c1Main' | 'c1MainDoc' | 'c1Addendum' | 'c2Main' | 'tenderA' | 'tenderB' | 'runC1Main' | 'runC1Add' | 'runC2', string>;

const config = testConfig();

const T = {
  c1Main: 'Аванс по договору подряда составляет 30 процентов цены договора.',
  c1Addendum: 'Дополнительным соглашением аванс по договору увеличен до 40 процентов.',
  c1MainV2: 'Аванс по договору подряда составляет 50 процентов цены договора.',
  c2Main: 'Неустойка по второму договору подряда составляет 0,5 процента в день.',
  tenderA: 'Техническое задание тендера: аванс заказчиком не предусмотрен, фасад кирпичный.',
  tenderB: 'Документация тендера Б: аванс 10 процентов, неустойка по договору подряда.',
};

const search = async (client: TestClient, body: object) => {
  const r = await client.post('/search', body, { headers: idem() });
  expect(r.status, r.text).toBe(200);
  return r.body;
};

const contractTexts = [T.c1Main, T.c1Addendum, T.c1MainV2, T.c2Main];
const leaked = (texts: string[]): string[] => texts.filter((t) => contractTexts.some((c) => t.includes(c.slice(0, 40))));

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  worker = makeWorker(db, config);
  await grantCreator(s.admin, s.ids.manager);
  c1 = await createContract(s.manager, 'П-1');
  c2 = await createContract(s.manager, 'П-2');
  for (const c of [c1, c2]) await setAccess(s.admin, c, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
  const m1 = await uploadMain(s.manager, c1, 'договор-П1.pdf', fakePdf('П-1 основной'));
  ids.c1Main = m1.revisionId;
  ids.c1MainDoc = m1.documentId;
  const add = await uploadContractDocument(s.manager, c1, 'дс-1.pdf', fakePdf('П-1 дс'), { role: 'addendum', mainDocumentId: m1.documentId });
  ids.c1Addendum = add.body.revisionId as string;
  ids.c2Main = (await uploadMain(s.manager, c2, 'договор-П2.pdf', fakePdf('П-2 основной'))).revisionId;
  ids.tenderA = await uploadDocument(db, config, s.eng1, s.stageA, 'тз-А.pdf');
  ids.tenderB = await uploadDocument(db, config, s.eng3, s.stageB, 'док-Б.pdf');
  ids.runC1Main = await seedEvidenceRun(db.pool, ids.c1Main, { pages: [{ blocks: [T.c1Main] }] });
  ids.runC1Add = await seedEvidenceRun(db.pool, ids.c1Addendum, { pages: [{ blocks: [T.c1Addendum] }] });
  ids.runC2 = await seedEvidenceRun(db.pool, ids.c2Main, { pages: [{ blocks: [T.c2Main] }] });
  await seedEvidenceRun(db.pool, ids.tenderA, { pages: [{ blocks: [T.tenderA] }] });
  await seedEvidenceRun(db.pool, ids.tenderB, { pages: [{ blocks: [T.tenderB] }] });
  await buildIndex(db, worker);
  await setAccess(s.admin, c1, s.ids.eng1, ['contract.read']);
});
afterAll(async () => {
  await db.drop();
});

describe('контекст contract (ADR-012 §24)', () => {
  it('ищет только текущий корпус договора: основной документ и допсоглашение, без тендеров и чужого договора', async () => {
    const r = await contractSearch(s.manager, c1, 'аванс договор подряда');
    expect(r.status, r.text).toBe(200);
    expect(r.body.context).toMatchObject({ kind: 'contract', contractId: c1, tenderId: null });
    const texts = hitTexts(r.body);
    expect(texts).toEqual(expect.arrayContaining([T.c1Main, T.c1Addendum]));
    expect(texts).not.toContain(T.tenderA);
    expect(texts).not.toContain(T.tenderB);
    expect(texts).not.toContain(T.c2Main);
    const other = await contractSearch(s.manager, c1, 'неустойка');
    expect(hitTexts(other.body)).toEqual([]);
    expect(other.body.emptyMessage).toContain('не найдено в области');
  });

  it('без выдачи — 404, администратор договоров без contract.read — 403', async () => {
    expect((await contractSearch(s.eng2, c1, 'аванс')).status).toBe(404);
    expect((await contractSearch(s.eng3, c1, 'аванс')).status).toBe(404);
    expect((await contractSearch(s.admin, c1, 'аванс')).status).toBe(403);
    const denied = await auditRows(db.pool, "action = 'search.run' AND outcome = 'denied' AND actor_user_id = $1", [s.ids.admin]);
    expect(denied.length).toBeGreaterThan(0);
  });

  it('договор без распознанного текста существует, а поиск честно пуст', async () => {
    const c3 = await createContract(s.manager, 'П-3');
    await uploadMain(s.manager, c3, 'скан.pdf', fakePdf('скан без текста'));
    const r = await contractSearch(s.manager, c3, 'аванс');
    expect(r.status, r.text).toBe(200);
    expect(r.body.scope).toMatchObject({ units: 0, revisionsWithoutRun: 1 });
    expect(hitTexts(r.body)).toEqual([]);
  });
});

describe('договор в тендерном контексте (D-022 OD-3)', () => {

  it('документ договора не находится поиском по тендеру без включения в состав — даже при связи и праве', async () => {
    await linkContract(s.manager, c1, s.tenderA);
    await setWorkingSet(s.manager, s.stageA, [ids.tenderA]);
    const b = await search(s.eng1, searchBody(s.tenderA, s.stageA, 'аванс договор подряда'));
    expect(leaked(hitTexts(b))).toEqual([]);
    expect(b.scope.excludedByAcl).toBe(0);
  });

  it('несвязанный договор в состав этапа не включается', async () => {
    const sets = (await s.manager.get(`/stages/${s.stageA}/source-sets`)).body.items[0].revisions;
    const draft = sets.find((r: { status: string }) => r.status === 'draft');
    const put = await s.manager.put(
      `/source-set-revisions/${draft.id}/items`,
      { items: [{ documentRevisionId: ids.tenderA, inclusion: 'included' }, { documentRevisionId: ids.c2Main, inclusion: 'included' }] },
      { headers: { 'If-Match': `"${draft.id}:${draft.rowVersion}"` } },
    );
    expect(put.status).toBe(400);
    // Кандидаты — только из действующе связанного и читаемого договора.
    const candidates = (await s.eng1.get(`/stages/${s.stageA}/contract-candidates`)).body.items.map((c: { documentRevisionId: string }) => c.documentRevisionId);
    expect(candidates.sort()).toEqual([ids.c1Main, ids.c1Addendum].sort());
    expect((await s.eng2.get(`/stages/${s.stageA}/contract-candidates`)).body.items).toEqual([]);
  });

  it('включённая единица договора: с правом — находится, без права — исключена до ранжирования и видна только числом', async () => {
    await setWorkingSet(s.eng1, s.stageA, [ids.tenderA, ids.c1Main]);
    const withRight = await search(s.eng1, searchBody(s.tenderA, s.stageA, 'аванс договор подряда'));
    expect(hitTexts(withRight)).toContain(T.c1Main);
    expect(hitTexts(withRight)).not.toContain(T.c1Addendum);
    expect(withRight.fused.items.find((h: { text: string }) => h.text === T.c1Main)).toMatchObject({ contractId: c1 });
    const without = await search(s.eng2, searchBody(s.tenderA, s.stageA, 'аванс договор подряда'));
    expect(leaked(hitTexts(without))).toEqual([]);
    expect(without.scope.excludedByAcl).toBe(1);
    expect(without.fused.items.every((h: { contractId: string | null }) => h.contractId === null)).toBe(true);
    const audit = await auditRows(db.pool, "action = 'search.run' AND entity_id = $1", [without.searchRunId]);
    expect(audit[0]!.details).toMatchObject({ excludedByAcl: 1 });
    // Состав этапа без права показывает элемент договора только как факт.
    const items = (await s.eng2.get(`/stages/${s.stageA}/source-sets`)).body.items[0].latestItems;
    // Без права элемент — только факт: ни названия, ни документа, ни идентификатора договора.
    expect(items.find((i: { documentRevisionId: string }) => i.documentRevisionId === ids.c1Main)).toMatchObject({ contractId: null, restricted: true, documentTitle: null, documentId: null });
  });

  it('снимок: включение в снимок права не даёт; с правом — находится', async () => {
    const sets = (await s.eng1.get(`/stages/${s.stageA}/source-sets`)).body.items[0].revisions;
    const draft = sets.find((r: { status: string }) => r.status === 'draft');
    const f = await s.eng1.post(`/source-set-revisions/${draft.id}/freeze`, {}, { headers: { 'If-Match': `"${draft.id}:${draft.rowVersion}"`, ...idem() } });
    expect(f.status, f.text).toBe(200);
    scope1 = await fixScope(s.eng1, s.stageA);
    const eng1 = await search(s.eng1, reviewBody(s.tenderA, scope1, 'аванс договор подряда'));
    expect(hitTexts(eng1)).toContain(T.c1Main);
    const eng2 = await search(s.eng2, reviewBody(s.tenderA, scope1, 'аванс договор подряда'));
    expect(leaked(hitTexts(eng2))).toEqual([]);
    expect(eng2.scope.excludedByAcl).toBe(1);
    const view2 = await s.eng2.get(`/evidence-scopes/${scope1}`);
    expect(view2.body.items.find((i: { restricted: boolean }) => i.restricted)).toMatchObject({ contractId: null, documentTitle: null, recognitionRunId: null });
    expect(JSON.stringify(view2.body)).not.toContain(c1);
    const view1 = await s.eng1.get(`/evidence-scopes/${scope1}`);
    expect(view1.body.items.find((i: { contractId: string | null }) => i.contractId === c1)).toMatchObject({ restricted: false, documentTitle: 'договор-П1.pdf' });
  });

  it('цитата, прогон и оригинал договора без права — 404 даже для единицы из снимка', async () => {
    const fragmentId = await fragmentIdOf(db.pool, ids.runC1Main, T.c1Main);
    expect((await s.eng2.get(`/evidence/${fragmentId}`)).status).toBe(404);
    expect((await s.eng2.get(`/recognition-runs/${ids.runC1Main}`)).status).toBe(404);
    expect((await s.eng2.get(`/document-revisions/${ids.c1Main}/content`)).status).toBe(404);
    expect((await s.eng1.get(`/evidence/${fragmentId}`)).status).toBe(200);
  });

  it('право отозвано после построения индекса и поиска: прогон не читается, новый поиск исключает единицу', async () => {
    const before = await search(s.eng1, reviewBody(s.tenderA, scope1, 'аванс договор подряда'));
    expect(hitTexts(before)).toContain(T.c1Main);
    await setAccess(s.admin, c1, s.ids.eng1, []);
    const reread = await s.eng1.get(`/search-runs/${before.searchRunId}`);
    expect(reread.status).toBe(409);
    expect(reread.body.current).toMatchObject({ reason: 'scope_changed' });
    const after = await search(s.eng1, reviewBody(s.tenderA, scope1, 'аванс договор подряда'));
    expect(leaked(hitTexts(after))).toEqual([]);
    expect(after.scope.excludedByAcl).toBe(1);
    expect((await s.eng1.get(`/evidence/${await fragmentIdOf(db.pool, ids.runC1Main, T.c1Main)}`)).status).toBe(404);
    expect((await contractSearch(s.eng1, c1, 'аванс')).status).toBe(404);
    await setAccess(s.admin, c1, s.ids.eng1, ['contract.read']);
  });

  it('новая редакция не подменяет старую в историческом снимке; корпус договора — текущая редакция', async () => {
    const v2 = await uploadContractRevision(s.manager, ids.c1MainDoc, 'договор-П1.pdf', fakePdf('П-1 основной, редакция 2'));
    expect(v2.status, v2.text).toBe(201);
    await seedEvidenceRun(db.pool, v2.body.revisionId, { pages: [{ blocks: [T.c1MainV2] }] });
    await buildIndex(db, worker);
    const historical = hitTexts(await search(s.eng1, reviewBody(s.tenderA, scope1, 'аванс договор подряда')));
    expect(historical).toContain(T.c1Main);
    expect(historical).not.toContain(T.c1MainV2);
    const current = hitTexts((await contractSearch(s.eng1, c1, 'аванс договор подряда')).body);
    expect(current).toContain(T.c1MainV2);
    expect(current).not.toContain(T.c1Main);
  });
});

describe('связь не расширяет область ни в одну сторону (D-017, ADR-008 §10)', () => {
  it('подтверждение связи не меняет исторический снимок тендера', async () => {
    await setWorkingSet(s.eng3, s.stageB, [ids.tenderB], true);
    const scopeB = await fixScope(s.eng3, s.stageB);
    const before = (await db.pool.query('SELECT content_hash FROM evidence_scope WHERE id = $1', [scopeB])).rows[0];
    await linkContract(s.manager, c1, s.tenderB);
    await setAccess(s.admin, c1, s.ids.eng3, ['contract.read']);
    expect((await db.pool.query('SELECT content_hash FROM evidence_scope WHERE id = $1', [scopeB])).rows[0]).toEqual(before);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM evidence_scope_item WHERE scope_id = $1', [scopeB])).rows[0].n).toBe(1);
    // Связанный и читаемый договор в поиск тендера Б не попадает, пока его не включили в состав.
    const b = await search(s.eng3, reviewBody(s.tenderB, scopeB, 'аванс договор подряда'));
    expect(leaked(hitTexts(b))).toEqual([]);
    const w = await search(s.eng3, searchBody(s.tenderB, s.stageB, 'аванс договор подряда'));
    expect(leaked(hitTexts(w))).toEqual([]);
  });

  it('документы тендера не попадают в поиск по договору, связанному с этим тендером', async () => {
    const texts = hitTexts((await contractSearch(s.manager, c1, 'документация тендера аванс неустойка')).body);
    expect(texts).not.toContain(T.tenderB);
    expect(texts).not.toContain(T.tenderA);
  });

  it('архив связи: рабочий состав исключает единицы договора, исторический снимок воспроизводим, заморозка — отказ', async () => {
    const link = (await s.manager.get(`/contracts/${c1}/tenders`)).body.items.find((l: { tenderId: string }) => l.tenderId === s.tenderA);
    const arch = await s.manager.post(`/contract-tender-links/${link.id}/archive`, { reason: 'договор закрыт' }, { headers: { 'If-Match': `"${link.id}:${link.rowVersion}"` } });
    expect(arch.status, arch.text).toBe(200);
    const historical = await search(s.eng1, reviewBody(s.tenderA, scope1, 'аванс договор подряда'));
    expect(hitTexts(historical)).toContain(T.c1Main);
    // Новый черновик копирует замороженный состав вместе с редакцией договора.
    const d = await s.eng1.post(`/stages/${s.stageA}/source-set-revisions`, {}, { headers: idem() });
    expect(d.status, d.text).toBe(201);
    const w = await search(s.eng1, searchBody(s.tenderA, s.stageA, 'аванс договор подряда'));
    expect(leaked(hitTexts(w))).toEqual([]);
    expect(w.scope.excludedByAcl).toBe(1);
    const again = await s.eng1.put(
      `/source-set-revisions/${d.body.id}/items`,
      { items: [{ documentRevisionId: ids.tenderA, inclusion: 'included' }, { documentRevisionId: ids.c1Addendum, inclusion: 'included' }] },
      { headers: { 'If-Match': d.headers.etag as string } },
    );
    expect(again.status).toBe(400);
    const f = await s.eng1.post(`/source-set-revisions/${d.body.id}/freeze`, {}, { headers: { 'If-Match': d.headers.etag as string, ...idem() } });
    expect(f.status).toBe(409);
    expect(f.body.current).toMatchObject({ reason: 'contract_link_archived' });
  });
});

