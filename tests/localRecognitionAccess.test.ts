// Права и поиск для локального распознавания (этап 05a, OD-3, D-022, D-024): договорные результаты —
// только с contract.read (тест 12), отзыв права после индексации закрывает выдачу сразу (тест 13),
// распознавание не расширяет область снимка (тест 14), историческая выдача остаётся на своём прогоне
// (тест 11), попадание несёт движок, итог и якорь (A43).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSearch, createContract, grantCreator, setAccess, uploadMain } from './contractFixtures.ts';
import { auditRows, buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import * as fx from './localFixtures.ts';
import { completeLocalRun, descriptorOf, insertLocalRun } from './localRecognitionFixtures.ts';
import { buildIndex, fixScope, reviewBody, searchBody, setWorkingSet } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let worker: ReturnType<typeof makeWorker>;
const config = testConfig();
let contractId: string;
let contractRevision: string;
let runId: string;

const upload = async (name: string, body: Buffer, stage = s.stageA): Promise<string> => {
  const up = await s.eng1.post(`/stages/${stage}/imports?name=${encodeURIComponent(name)}`, body, { headers: { 'Content-Type': 'application/octet-stream', ...idem() } });
  expect(up.status, up.text).toBe(202);
  await drain(worker);
  return (await s.eng1.get(`/imports/${up.body.id}`)).body.items[0].documentRevisionId as string;
};
const autoPass = async (): Promise<void> => {
  await worker.scheduleLocalRecognition();
  await drain(worker);
};
type Hit = { text: string; engine: string; runOutcome: string; locator: Record<string, unknown> | null; recognitionRunId: string };
const hitsOf = (body: { fused: { items: Hit[] } | null }): Hit[] => body.fused?.items ?? [];

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
  await grantCreator(s.admin, s.ids.manager);
  contractId = await createContract(s.manager, 'Л-15');
  await setAccess(s.admin, contractId, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
  await setAccess(s.admin, contractId, s.ids.eng1, ['contract.read']);
  // Инженер 2 ведёт договор, но содержимого не читает (D-022 OD-2, интерпретация 4).
  await setAccess(s.admin, contractId, s.ids.eng2, ['contract.manage']);
  contractRevision = (await uploadMain(s.manager, contractId, 'договор-Л15.docx', fx.uniqueCopy(fx.contractDocx(), 'zip'))).revisionId;
  await autoPass();
  runId = (await s.manager.get(`/document-revisions/${contractRevision}/recognition-runs`)).body.items[0].id;
  await buildIndex(db, worker);
});
afterAll(async () => db.drop());

describe('договор: contract.read (OD-3, тест 12)', () => {
  it('распознавание договора автоматическое; с contract.read — текст, якорь, движок и итог в выдаче (A43)', async () => {
    const run = (await s.manager.get(`/recognition-runs/${runId}`)).body;
    expect(run).toMatchObject({ engine: 'local_ocr', status: 'complete', trigger: 'auto', tenderId: null });
    const r = await contractSearch(s.eng1, contractId, 'цена договора 245 000 000');
    expect(r.status, r.text).toBe(200);
    const hit = hitsOf(r.body).find((h) => h.text.includes('245 000 000'))!;
    expect(hit).toMatchObject({ engine: 'local_ocr', runOutcome: 'complete', locator: { kind: 'docx_paragraph', part: 'body', block: 4 } });
    expect(r.body.scope).toMatchObject({ localUnits: 1, localNeedsReview: 0 });
    const evidence = (await s.eng1.get(`/evidence/${(hit as unknown as { fragmentId: string }).fragmentId}`)).body;
    expect(evidence).toMatchObject({ runEngine: 'local_ocr', unitKind: 'docx_body', bboxNorm: null, locator: { kind: 'docx_paragraph' } });
  });

  it('команда по договору — как приём RDWeb в 06a: редакция видна с contract.read, запуск — с contract.manage', async () => {
    // Ведение без чтения: редакции не видно — 404 без раскрытия существования (интерпретация 4 этапа 06a).
    expect((await s.eng2.post(`/document-revisions/${contractRevision}/local-recognitions`, {}, { headers: idem() })).status).toBe(404);
    expect((await s.eng2.get(`/recognition-runs/${runId}`)).status).toBe(404);
    expect((await contractSearch(s.eng2, contractId, 'цена договора')).status).not.toBe(200);
    // Чтение без ведения: команда запрещена.
    expect((await s.eng1.post(`/document-revisions/${contractRevision}/local-recognitions`, {}, { headers: idem() })).status).toBe(403);
    // Чтение и ведение: повтор той же идентичности, ответ без качества и текста.
    const cmd = await s.manager.post(`/document-revisions/${contractRevision}/local-recognitions`, {}, { headers: idem() });
    expect(cmd.status, cmd.text).toBe(200);
    expect(cmd.body).toMatchObject({ reused: true, run: { id: runId } });
    expect(cmd.body.run.quality).toBeUndefined();
    // Журнал команды — без названия документа и текста (интерпретация 9 этапа 06a).
    const audit = await auditRows(db.pool, "action = 'recognition.local.request' AND entity_id = $1", [runId]);
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.map((a) => a.details))).not.toMatch(/договор-Л15|245 000 000/);
  });

  it('без выдачи по договору команда не проходит; распознавание права чтения не выдаёт', async () => {
    const r = await s.eng3.post(`/document-revisions/${contractRevision}/local-recognitions`, {}, { headers: idem() });
    expect([403, 404]).toContain(r.status);
    const caps = (await s.eng2.get(`/contracts/${contractId}`)).body.capabilities as string[];
    expect(caps).not.toContain('contract.read');
  });

  it('отзыв contract.read после индексации сразу закрывает выдачу (тест 13)', async () => {
    const before = await contractSearch(s.eng1, contractId, 'аванс цены договора');
    expect(before.status).toBe(200);
    await setAccess(s.admin, contractId, s.ids.eng1, []);
    const after = await contractSearch(s.eng1, contractId, 'аванс цены договора');
    expect(after.status).not.toBe(200);
    expect((await s.eng1.get(`/recognition-runs/${runId}/fragments`)).status).toBe(404);
  });
});

describe('область и история (тесты 11, 14)', () => {
  it('распознавание не расширяет снимок и текущую область само (тест 14)', async () => {
    const inSet = await upload('Смета-в-составе.xlsx', fx.uniqueCopy(fx.smetaStromynkaXlsx(), 'zip'));
    await autoPass();
    await setWorkingSet(s.eng1, s.stageA, [inSet], true);
    const scope = await fixScope(s.eng1, s.stageA);
    const itemsBefore = (await s.eng1.get(`/evidence-scopes/${scope}`)).body.items;
    // Новый документ этапа распознаётся, но в состав и в снимок сам не попадает.
    const outside = await upload('Договор-вне-состава.docx', fx.uniqueCopy(fx.contractDocx(), 'zip'));
    await autoPass();
    expect((await s.eng1.get(`/document-revisions/${outside}/recognition-runs`)).body.items[0].status).toBe('complete');
    expect((await s.eng1.get(`/evidence-scopes/${scope}`)).body.items).toEqual(itemsBefore);
    await buildIndex(db, worker);
    const working = await s.eng1.post('/search', searchBody(s.tenderA, s.stageA, 'цена договора 245 000 000'), { headers: idem() });
    expect(working.status, working.text).toBe(200);
    expect(hitsOf(working.body).some((h) => h.text.includes('245 000 000'))).toBe(false);
    const review = await s.eng1.post('/search', reviewBody(s.tenderA, scope, 'цена договора 245 000 000'), { headers: idem() });
    expect(hitsOf(review.body).some((h) => h.text.includes('245 000 000'))).toBe(false);
  });

  it('историческая выдача остаётся на прогоне снимка; текущая — на новом предпочтительном (тест 11)', async () => {
    const rev = await upload('Смета-история.xlsx', fx.uniqueCopy(fx.smetaStromynkaXlsx(), 'zip'));
    await autoPass();
    const first = (await s.eng1.get(`/document-revisions/${rev}/recognition-runs`)).body.items[0].id as string;
    await setWorkingSet(s.eng1, s.stageA, [rev], true);
    const scope = await fixScope(s.eng1, s.stageA);
    // Новая версия распознавателя дала другой текст той же редакции.
    const next = await insertLocalRun(db.pool, rev, descriptorOf('xlsx', { recognizerVersion: '2' }), s.ids.eng1);
    await completeLocalRun(db.pool, next, [{ kind: 'xlsx_sheet', label: 'Лист 1' }], ['Монолитные работы каркаса пересчитаны: 101 000 000']);
    await buildIndex(db, worker);
    const review = await s.eng1.post('/search', reviewBody(s.tenderA, scope, 'монолитные железобетонные работы'), { headers: idem() });
    expect(review.status, review.text).toBe(200);
    expect(hitsOf(review.body).every((h) => h.recognitionRunId === first)).toBe(true);
    expect(hitsOf(review.body).some((h) => h.text.includes('98 500 000'))).toBe(true);
    const current = await s.eng1.post('/search', searchBody(s.tenderA, s.stageA, 'монолитные работы каркаса'), { headers: idem() });
    expect(hitsOf(current.body).some((h) => h.recognitionRunId === next && h.text.includes('101 000 000'))).toBe(true);
    expect(hitsOf(current.body).some((h) => h.recognitionRunId === first)).toBe(false);
  });
});
