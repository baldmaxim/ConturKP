// Этап 08: видимость производного текста (Р-08-5, OD-08-4) — 7 обязательных тестов, защищённые основания
// договора и письма, отзыв права, администратор без права на источник, вход модели по правам запустившего.
// Формулировка видна целиком, только если пользователь читает все основания supports; иначе — оболочка.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContract, grantCreator, linkContract, setAccess, uploadMain } from './contractFixtures.ts';
import { createTestDb, idem, makeWorker, testConfig, type ITestDb } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { buildStage08, confirm, propose, supports, T, workerWithChat, type IStage08 } from './requirementFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet } from './searchFixtures.ts';

let db: ITestDb;
let st: IStage08;
const config = testConfig();
const SECRET = {
  contract: 'Подрядчик обязан выполнить работы до 1 декабря 2026 года, неустойка 0,3 процента в день.',
  mail: 'Кровля должна быть из профнастила С-44, цвет RAL 7024 — решение заказчика.',
};
const ids = {} as Record<'contract' | 'contractRev' | 'contractFrag' | 'box' | 'mailFrag' | 'registry' | 'rOpen' | 'rContract' | 'rMail' | 'rMix', string>;

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage08(db, config);
  const { s } = st;
  const worker = makeWorker(db, config);
  await grantCreator(s.admin, s.ids.manager);
  ids.contract = await createContract(s.manager, 'Д-08');
  await setAccess(s.admin, ids.contract, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
  ids.contractRev = (await uploadMain(s.manager, ids.contract)).revisionId;
  const run = await seedEvidenceRun(db.pool, ids.contractRev, { pages: [{ blocks: [SECRET.contract] }] });
  ids.contractFrag = await fragmentIdOf(db.pool, run, SECRET.contract);
  await linkContract(s.manager, ids.contract, s.tenderA);
  ids.box = await createMailbox(s.admin, 'tender08@contractor.example.test', 'Ящик 08');
  await setMailAccess(s.admin, ids.box, s.ids.manager, ['mail.read', 'mail.import', 'mail.link']);
  const m = await importEml(s.manager, worker, ids.box, eml({ messageId: 'm08@example.test', subject: 'Кровля', text: SECRET.mail }));
  await linkMail(s.manager, m.messageId!, s.tenderA, s.stageA);
  ids.mailFrag = (await db.pool.query("SELECT id FROM evidence_fragment WHERE source_unit_type = 'mail_message_revision' AND text LIKE 'Кровля должна%'")).rows[0].id;
  await setWorkingSet(s.manager, s.stageA, [st.docRev, ids.contractRev], true);
  const scope = await fixScope(s.manager, s.stageA);
  const reg = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scope, reason: 'Договор и письмо' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  ids.registry = reg.body.id;
  const make = async (statement: string, evidence: object[]) => {
    const c = await propose(s.manager, ids.registry, statement, evidence);
    const r = await confirm(s.manager, c.id);
    expect(r.status, r.text).toBe(200);
    return r.body.requirementId as string;
  };
  ids.rOpen = await make('Фасад — клинкер', supports(st.frag.facade));
  ids.rContract = await make('Срок — до 1 декабря 2026, неустойка 0,3 %', supports(ids.contractFrag));
  ids.rMail = await make('Кровля — профнастил С-44 RAL 7024', supports(ids.mailFrag));
  ids.rMix = await make('Гидроизоляция обмазочная', [...supports(st.frag.waterproofing), { fragmentId: ids.contractFrag, role: 'clarifies' }]);
});
afterAll(async () => {
  await db.drop();
});

const view = async (who: 'eng1' | 'manager', id: string) => (await st.s[who].get(`/requirements/${id}`)).body;

describe('видимость формулировки (Р-08-5)', () => {
  it('1. только открытые основания — полный текст виден', async () => {
    expect(await view('eng1', ids.rOpen)).toMatchObject({ visible: true, restricted: false, statement: 'Фасад — клинкер' });
  });

  it('2. основание договора без contract.read — оболочка без текста', async () => {
    const r = await view('eng1', ids.rContract);
    expect(r).toMatchObject({ code: expect.stringMatching(/^R-/u), status: 'confirmed', visible: false, restricted: true, statement: null, parameters: null, objectScope: null });
    expect(r.evidenceCounts).toEqual({ supports: 1 });
    expect(r.revisions[0]).toMatchObject({ visible: false, statement: null });
    expect(r.revisions[0].evidence[0]).toMatchObject({ restricted: true, text: null, origin: null });
    expect(await view('manager', ids.rContract)).toMatchObject({ visible: true, statement: 'Срок — до 1 декабря 2026, неустойка 0,3 %' });
  });

  it('3. основание письма без mail.read — оболочка без текста', async () => {
    expect(await view('eng1', ids.rMail)).toMatchObject({ visible: false, restricted: true, statement: null });
    expect(await view('manager', ids.rMail)).toMatchObject({ visible: true });
  });

  it('4–5. отзыв права скрывает текст без изменения требования; возврат — снова открывает', async () => {
    const before = (await db.pool.query('SELECT current_revision_id, row_version FROM requirement WHERE id = $1', [ids.rContract])).rows[0];
    await setAccess(st.s.admin, ids.contract, st.s.ids.eng1, ['contract.read']);
    expect(await view('eng1', ids.rContract)).toMatchObject({ visible: true, statement: 'Срок — до 1 декабря 2026, неустойка 0,3 %' });
    await setAccess(st.s.admin, ids.contract, st.s.ids.eng1, []);
    expect(await view('eng1', ids.rContract)).toMatchObject({ visible: false, statement: null });
    expect((await db.pool.query('SELECT current_revision_id, row_version FROM requirement WHERE id = $1', [ids.rContract])).rows[0]).toEqual(before);
    await setAccess(st.s.admin, ids.contract, st.s.ids.eng1, ['contract.read']);
    expect(await view('eng1', ids.rContract)).toMatchObject({ visible: true });
    await setAccess(st.s.admin, ids.contract, st.s.ids.eng1, []);
  });

  it('6. оболочка не содержит производных данных: ни формулировки, ни текста оснований, ни причин', async () => {
    const list = await st.s.eng1.get(`/requirement-registries/${ids.registry}/requirements`);
    const card = await st.s.eng1.get(`/requirements/${ids.rContract}`);
    const cands = await st.s.eng1.get(`/requirement-registries/${ids.registry}/candidates`);
    for (const body of [list.text, card.text, cands.text]) {
      expect(body).not.toContain('декабря');
      expect(body).not.toContain('неустойка');
      expect(body).not.toContain('RAL 7024');
      expect(body).not.toContain('профнастила С-44, цвет');
    }
  });

  it('7. цитата не открывается через требование: GET /evidence — по правам источника', async () => {
    expect((await st.s.eng1.get(`/evidence/${ids.contractFrag}`)).status).toBe(404);
    expect((await st.s.eng1.get(`/evidence/${ids.mailFrag}`)).status).toBe(404);
    expect((await st.s.manager.get(`/evidence/${ids.contractFrag}`)).status).toBe(200);
  });

  it('закрытое clarifies не скрывает формулировку, но само не показывается', async () => {
    const r = await view('eng1', ids.rMix);
    expect(r).toMatchObject({ visible: true, restricted: true, statement: 'Гидроизоляция обмазочная' });
    const ev = r.revisions[0].evidence as { role: string; text: string | null; restricted: boolean }[];
    expect(ev.find((e) => e.role === 'clarifies')).toMatchObject({ restricted: true, text: null });
    expect(ev.find((e) => e.role === 'supports')).toMatchObject({ restricted: false, text: T.waterproofing });
  });
});

describe('закрытые источники и права', () => {
  it('администратор без назначения и права на источник не видит ни реестра, ни требований, ни цитат', async () => {
    expect((await st.s.admin.get(`/stages/${st.s.stageA}/requirement-registry`)).status).toBe(404);
    expect((await st.s.admin.get(`/requirements/${ids.rOpen}`)).status).toBe(404);
    expect((await st.s.admin.get(`/evidence/${ids.contractFrag}`)).status).toBe(404);
    expect((await st.s.eng3.get(`/requirements/${ids.rOpen}`)).status).toBe(404);
  });

  it('нельзя цитировать или подтверждать то, что не читаешь; отметка полноты закрытого фрагмента — 409', async () => {
    const r = await st.s.eng1.post(`/requirement-registries/${ids.registry}/requirement-candidates`, { statement: 'x', evidence: supports(ids.contractFrag) }, { headers: idem() });
    expect(r.status).toBe(409);
    expect(r.body.current.reason).toBe('restricted_fragments');
    const m = await st.s.eng1.post(`/requirement-registries/${ids.registry}/marks`, { mark: 'not_requirement', reason: 'x', selector: { kind: 'fragments', fragmentIds: [ids.contractFrag] } }, { headers: idem() });
    expect(m.status).toBe(409);
  });

  it('вход модели — только то, что читает запустивший; результат чужого прогона скрыт, если вход закрыт', async () => {
    const chat = (await import('../packages/adapters/src/index.ts')).FakeChat;
    const w = workerWithChat(db, config, new chat({ maxInputChars: config.chatModel.maxInputChars, revision: config.chatModel.revision }));
    const mine = await st.s.eng1.post(`/requirement-registries/${ids.registry}/analysis-runs`, { task: 'requirement_extraction' }, { headers: idem() });
    expect(mine.status, mine.text).toBe(201);
    expect(mine.body.excludedByAccess).toBe(2);
    const inputs = (await db.pool.query('SELECT fragment_id FROM analysis_run_input WHERE run_id = $1', [mine.body.id])).rows.map((x) => x.fragment_id);
    expect(inputs).not.toContain(ids.contractFrag);
    expect(inputs).not.toContain(ids.mailFrag);
    const full = await st.s.manager.post(`/requirement-registries/${ids.registry}/analysis-runs`, { task: 'requirement_extraction' }, { headers: idem() });
    expect(full.status).toBe(201);
    expect(full.body.excludedByAccess).toBe(0);
    for (let i = 0; i < 5; i += 1) await w.runOnce();
    expect((await st.s.eng1.get(`/analysis-runs/${full.body.id}`)).body).toMatchObject({ resultVisible: false, result: null });
    expect((await st.s.manager.get(`/analysis-runs/${full.body.id}`)).body.resultVisible).toBe(true);
    // Кандидаты модели по закрытым основаниям инженеру видны оболочкой.
    const cands = (await st.s.eng1.get(`/requirement-registries/${ids.registry}/candidates?runId=${full.body.id}`)).body.items as { visible: boolean; statement: string | null }[];
    expect(cands.some((c) => !c.visible && c.statement === null)).toBe(true);
  });

  it('факт из письма: основание — текст письма; инженеру без mail.read — оболочка значения', async () => {
    const f = await st.s.manager.post(`/requirement-registries/${ids.registry}/fact-candidates`, { factKind: 'contract_party', displayValue: 'Заказчик — ООО «Северный»', normalizedValue: { name: 'ООО «Северный»' }, evidence: supports(ids.mailFrag) }, { headers: idem() });
    expect(f.status, f.text).toBe(201);
    const seen = (await st.s.eng1.get(`/fact-candidates/${f.body.id}`)).body;
    expect(seen).toMatchObject({ visible: false, displayValue: null, normalizedValue: null });
  });
});
