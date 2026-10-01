// Этап 08: полнота реестра (OD-08-7, Р-08-7: 10 обязательных тестов) и ветка доказательств Q&A (Р-08-1).
// Единица — фрагмент снимка; пакетные отметки разворачиваются в конкретные ID; total = reviewed +
// explicitly_not_requirement + unreviewed; завершение при unreviewed > 0 невозможно; новый реестр — явно,
// прежний не меняется. Q&A получает фрагменты от неизменяемой ревизии, входит в снимок, но не в поиск.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, idem, makeWorker, testConfig, type ITestDb } from './helpers.ts';
import { postManifest, qaManifest } from './mailFixtures.ts';
import { buildStage08, confirmedRequirement, propose, supports, type IStage08 } from './requirementFixtures.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let st: IStage08;
const config = testConfig();

const counts = async (registryId = st.registryId) => (await st.s.eng1.get(`/requirement-registries/${registryId}/completeness`)).body.counts;
const states = async (registryId = st.registryId) =>
  new Map(((await st.s.eng1.get(`/requirement-registries/${registryId}/fragments`)).body.items as { fragmentId: string; state: string }[]).map((i) => [i.fragmentId, i.state]));
const mark = (registryId: string, selector: object, m = 'not_requirement', reason: string | null = 'справочный текст', client = st.s.eng1) =>
  client.post(`/requirement-registries/${registryId}/marks`, { mark: m, reason, selector }, { headers: idem() });

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage08(db, config);
});
afterAll(async () => {
  await db.drop();
});

describe('состояния фрагментов (Р-08-7)', () => {
  it('изначально все фрагменты unreviewed; total = reviewed + not + unreviewed', async () => {
    const c = await counts();
    expect(c).toMatchObject({ total_units: 5, reviewed_units: 0, covered_units: 0, explicit_not_requirement_units: 0, unreviewed_units: 5, empty_units: 0 });
  });

  it('фрагмент под кандидатом или требованием — covered; только под фактом — reviewed', async () => {
    await confirmedRequirement(st, 'Фасад — клинкерный кирпич', [st.frag.facade]);
    await propose(st.s.eng2, st.registryId, 'Гидроизоляция обмазочная', supports(st.frag.waterproofing));
    const f = await st.s.eng1.post(`/requirement-registries/${st.registryId}/fact-candidates`, { factKind: 'advance_payment', displayValue: '30 %', normalizedValue: { value: 30 }, evidence: supports(st.frag.advance) }, { headers: idem() });
    expect(f.status, f.text).toBe(201);
    const s = await states();
    expect(s.get(st.frag.facade)).toBe('covered');
    expect(s.get(st.frag.waterproofing)).toBe('covered');
    expect(s.get(st.frag.advance)).toBe('reviewed');
    expect(s.get(st.frag.note)).toBe('unreviewed');
    const c = await counts();
    expect(c).toMatchObject({ total_units: 5, reviewed_units: 3, covered_units: 2, explicit_not_requirement_units: 0, unreviewed_units: 2 });
    expect(c.total_units).toBe(c.reviewed_units + c.explicit_not_requirement_units + c.unreviewed_units);
  });

  it('«не требование» — с причиной; явный список фрагментов; снятие возвращает в unreviewed', async () => {
    expect((await mark(st.registryId, { kind: 'fragments', fragmentIds: [st.frag.note] }, 'not_requirement', null)).status).toBe(400);
    const r = await mark(st.registryId, { kind: 'fragments', fragmentIds: [st.frag.note] });
    expect(r.status, r.text).toBe(201);
    expect(r.body.fragmentIds).toEqual([st.frag.note]);
    expect((await states()).get(st.frag.note)).toBe('explicitly_not_requirement');
    const cl = await mark(st.registryId, { kind: 'fragments', fragmentIds: [st.frag.note] }, 'cleared', null);
    expect(cl.status, cl.text).toBe(201);
    expect((await states()).get(st.frag.note)).toBe('unreviewed');
    const hist = await db.pool.query('SELECT seq, mark FROM registry_fragment_mark WHERE fragment_id = $1 ORDER BY seq', [st.frag.note]);
    expect(hist.rows).toEqual([{ seq: 1, mark: 'not_requirement' }, { seq: 2, mark: 'cleared' }]);
  });

  it('пакет по странице PDF разворачивается в фрагменты этой страницы', async () => {
    const r = await mark(st.registryId, { kind: 'page', documentRevisionId: st.docRev, pageIndex: 1 });
    expect(r.status, r.text).toBe(201);
    expect([...r.body.fragmentIds].sort()).toEqual([st.frag.roof, st.frag.advance].sort());
    const batch = await db.pool.query('SELECT selector_kind, fragment_count FROM registry_mark_batch WHERE id = $1', [r.body.batchId]);
    expect(batch.rows[0]).toEqual({ selector_kind: 'page', fragment_count: 2 });
    const s = await states();
    // Связь важнее отметки: фрагмент под фактом остаётся reviewed.
    expect(s.get(st.frag.advance)).toBe('reviewed');
    expect(s.get(st.frag.roof)).toBe('explicitly_not_requirement');
  });

  it('завершение прохода при unreviewed > 0 — 409; инженер не завершает; после пакета по документу — запись с счётчиками', async () => {
    const early = await st.s.manager.post(`/requirement-registries/${st.registryId}/reviews`, {}, { headers: idem() });
    expect(early.status).toBe(409);
    expect(early.body.current).toMatchObject({ reason: 'unreviewed', unreviewed: 1 });
    expect((await st.s.eng1.post(`/requirement-registries/${st.registryId}/reviews`, {}, { headers: idem() })).status).toBe(403);
    const doc = await mark(st.registryId, { kind: 'document_revision', documentRevisionId: st.docRev });
    expect(doc.status, doc.text).toBe(201);
    expect(doc.body.fragmentIds).toHaveLength(5);
    const done = await st.s.manager.post(`/requirement-registries/${st.registryId}/reviews`, {}, { headers: idem() });
    expect(done.status, done.text).toBe(201);
    expect(done.body.counts).toMatchObject({ total_units: 5, unreviewed_units: 0, covered_units: 2 });
    expect(done.body.counts.total_units).toBe(done.body.counts.reviewed_units + done.body.counts.explicit_not_requirement_units);
  });
});

describe('новый снимок и новый реестр (Р-08-6)', () => {
  let reg2: string;
  let before: Record<string, number>;

  it('новый реестр создаётся явно; прежний не меняется; новые фрагменты — unreviewed, отметки не переносятся', async () => {
    before = await counts();
    const doc = await uploadDocument(db, config, st.s.eng1, st.s.stageA, 'смета-пояснения.pdf');
    await seedEvidenceRun(db.pool, doc, { pages: [{ blocks: ['Вентиляция должна быть приточно-вытяжной.'] }] });
    // Чертёж, у которого распознано только описание модели (I06): единица без допустимых фрагментов —
    // технический статус no_fragments, а не тихое исчезновение из прохода.
    const bare = await uploadDocument(db, config, st.s.eng1, st.s.stageA, 'чертёж-без-текста.pdf');
    await seedEvidenceRun(db.pool, bare, { pages: [{ blocks: [{ text: 'Описание модели: план этажа', origin: 'model_description' }] }] });
    await setWorkingSet(st.s.manager, st.s.stageA, [st.docRev, doc, bare], true);
    const scope = await fixScope(st.s.manager, st.s.stageA);
    const reg = await st.s.manager.post(`/stages/${st.s.stageA}/requirement-registries`, { evidenceScopeId: scope, reason: 'Добавлен документ' }, { headers: idem() });
    expect(reg.status, reg.text).toBe(201);
    reg2 = reg.body.id;
    expect(reg.body).toMatchObject({ seq: 2, previousRegistryId: st.registryId, active: true });
    const view = (await st.s.eng1.get(`/stages/${st.s.stageA}/requirement-registry`)).body;
    expect(view.registries.map((r: { seq: number; active: boolean }) => [r.seq, r.active])).toEqual([
      [2, true],
      [1, false],
    ]);
    const c2 = await counts(reg2);
    // Подтверждённое требование перенесено (covered), отметки и кандидаты — нет.
    expect(c2).toMatchObject({ total_units: 6, covered_units: 1, unreviewed_units: 5, empty_units: 1 });
    expect(await counts(st.registryId)).toEqual(before);
    const units = (await st.s.eng1.get(`/requirement-registries/${reg2}/completeness`)).body.units as { technicalStatus: string; unit: { documentRevisionId: string } | null }[];
    expect(units.find((u) => u.unit?.documentRevisionId === bare)?.technicalStatus).toBe('no_fragments');
    // Отметки в прежнем реестре больше не ставятся.
    expect((await mark(st.registryId, { kind: 'fragments', fragmentIds: [st.frag.note] })).status).toBe(409);
  });

  it('Q&A: фрагменты вопроса и ответа от ревизии; входят в снимок и полноту; цитата — участнику; в поиск не попадают (Р-08-1)', async () => {
    const imp = await postManifest(st.s.eng1, st.s.tenderA, 'qa', qaManifest([{ no: '1', question: 'Какой класс бетона плиты?', answer: 'Бетон плиты B30.' }]));
    expect([200, 201, 202], imp.text).toContain(imp.status);
    await makeWorker(db, config).runOnce();
    const frags = await db.pool.query<{ id: string; origin: string; text: string; qa_item_revision_id: string }>(
      "SELECT id, origin, text, qa_item_revision_id FROM evidence_fragment WHERE source_unit_type = 'qa_item_revision' ORDER BY ordinal",
    );
    expect(frags.rows.map((f) => [f.origin, f.text])).toEqual([
      ['qa_question', 'Какой класс бетона плиты?'],
      ['qa_answer', 'Бетон плиты B30.'],
    ]);
    const cite = await st.s.eng2.get(`/evidence/${frags.rows[1]!.id}`);
    expect(cite.status, cite.text).toBe(200);
    expect(cite.body.qa).toMatchObject({ itemNo: '1', part: 'answer' });
    expect((await st.s.eng3.get(`/evidence/${frags.rows[1]!.id}`)).status).toBe(404);
    // Новый снимок включает ревизию Q&A; реестр № 3 — её фрагменты в проходе.
    const scope = await fixScope(st.s.manager, st.s.stageA);
    const items = (await st.s.eng1.get(`/evidence-scopes/${scope}`)).body.items as { unitType: string; qaItemNo: string | null }[];
    expect(items.filter((i) => i.unitType === 'qa_item_revision')).toEqual([expect.objectContaining({ qaItemNo: '1' })]);
    const reg3 = await st.s.manager.post(`/stages/${st.s.stageA}/requirement-registries`, { evidenceScopeId: scope, reason: 'Ответы заказчика' }, { headers: idem() });
    expect(reg3.status, reg3.text).toBe(201);
    const qaRev = frags.rows[0]!.qa_item_revision_id;
    const m = await mark(reg3.body.id, { kind: 'qa_item_revision', qaItemRevisionId: qaRev });
    expect(m.status, m.text).toBe(201);
    expect([...m.body.fragmentIds].sort()).toEqual(frags.rows.map((f) => f.id).sort());
    // Ответ заказчика — основание факта; вопрос участника — нет (И-08-11).
    const ok = await st.s.eng1.post(`/requirement-registries/${reg3.body.id}/fact-candidates`, { factKind: 'estimate_total', displayValue: 'B30', normalizedValue: { text: 'B30' }, evidence: supports(frags.rows[1]!.id) }, { headers: idem() });
    expect(ok.status, ok.text).toBe(201);
    const bad = await st.s.eng1.post(`/requirement-registries/${reg3.body.id}/fact-candidates`, { factKind: 'estimate_total', displayValue: 'B30', normalizedValue: { text: 'B30' }, evidence: supports(frags.rows[0]!.id) }, { headers: idem() });
    expect(bad.status).toBe(409);
    // Индекс поиска Q&A не содержит.
    const idx = await db.pool.query("SELECT count(*)::int AS n FROM search_index_unit u JOIN qa_item_revision r ON r.id = u.source_unit_id");
    expect(idx.rows[0].n).toBe(0);
  });

  it('изменение ответа — новая ревизия Q&A с новыми фрагментами; прежние не меняются', async () => {
    const before = await db.pool.query("SELECT id, text FROM evidence_fragment WHERE origin = 'qa_answer' ORDER BY created_at");
    const imp = await postManifest(st.s.eng1, st.s.tenderA, 'qa', qaManifest([{ no: '1', question: 'Какой класс бетона плиты?', answer: 'Бетон плиты B35.' }]));
    expect([200, 201, 202], imp.text).toContain(imp.status);
    await makeWorker(db, config).runOnce();
    const after = await db.pool.query("SELECT id, text FROM evidence_fragment WHERE origin = 'qa_answer' ORDER BY created_at");
    expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
    expect(after.rows.map((r) => r.text)).toEqual(['Бетон плиты B30.', 'Бетон плиты B35.']);
  });
});
