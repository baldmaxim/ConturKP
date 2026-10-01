// R08-02 (Review 08-1): отрицательный security-тест производного текста. Открытое supports + закрытое clarifies,
// формулировка содержит уникальный секрет из clarifies: пользователь без права на источник clarifies не видит
// секрета ни в реестре, ни в карточке, ни в ревизиях, кандидатах, правках, решениях, допущениях, вопросах,
// покрытии и сведениях о конфликте. Политика — замыкание закрытости (requirementTaint.ts): закрытое основание
// любой роли и всё, из чего текст мог быть унаследован, скрывает производные поля.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContract, grantCreator, linkContract, setAccess, uploadMain } from './contractFixtures.ts';
import { createTestDb, idem, testConfig, type ITestDb, type TestClient } from './helpers.ts';
import { buildStage08, confirm, etag, propose, supports, type IStage08 } from './requirementFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet } from './searchFixtures.ts';

const SECRET = 'КЛЮЧ-58213';
const CLARIFIES = `Особое условие: бетон фасадных колонн по шифру ${SECRET}, сведения закрытые.`;

let db: ITestDb;
let st: IStage08;
const config = testConfig();
const ids = {} as Record<'contract' | 'contractFrag' | 'registry' | 'c0' | 'c0b' | 'c1' | 'c3' | 'r1' | 'r2' | 'r3' | 'decision' | 'assumption' | 'question', string>;

const ok = async (p: Promise<{ status: number; text: string; body: Record<string, unknown> }>, status = 201) => {
  const r = await p;
  expect(r.status, r.text).toBe(status);
  return r.body;
};

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage08(db, config);
  const { s } = st;
  await grantCreator(s.admin, s.ids.manager);
  ids.contract = await createContract(s.manager, 'Д-08-R2');
  await setAccess(s.admin, ids.contract, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
  const rev = (await uploadMain(s.manager, ids.contract)).revisionId;
  const run = await seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [CLARIFIES] }] });
  ids.contractFrag = await fragmentIdOf(db.pool, run, CLARIFIES);
  await linkContract(s.manager, ids.contract, s.tenderA);
  await setWorkingSet(s.manager, s.stageA, [st.docRev, rev], true);
  const scope = await fixScope(s.manager, s.stageA);
  ids.registry = (await ok(s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scope, reason: 'ТЗ и договор' }, { headers: idem() }))).id as string;
  const mixed = [...supports(st.frag.facade), { fragmentId: ids.contractFrag, role: 'clarifies' }];

  // Требование R1: открытое supports + закрытое clarifies, секрет — в формулировке, параметре, области, обосновании.
  const c1 = await propose(s.manager, ids.registry, `Фасадные колонны — бетон по шифру ${SECRET}`, mixed, {
    parameters: [{ name: 'Шифр бетона', value: SECRET }],
    objectScope: { section: `секция ${SECRET}` },
    rationale: `Уточнено договором: ${SECRET}`,
  });
  ids.c1 = c1.id;
  ids.r1 = (await ok(confirm(s.manager, c1.id), 200)).requirementId as string;

  // Правка кандидата: у новой версии только открытое основание, текст скопирован из закрытого — R2.
  ids.c0 = (await propose(s.manager, ids.registry, `Колонны — шифр ${SECRET}`, mixed)).id;
  ids.c0b = (await propose(s.manager, ids.registry, `Колонны — шифр ${SECRET} (правка)`, supports(st.frag.facade), { derivedFromCandidateId: ids.c0 })).id;
  ids.r2 = (await ok(confirm(s.manager, ids.c0b), 200)).requirementId as string;

  // Кандидат изменения R1 только с открытым основанием.
  ids.c3 = (await propose(s.manager, ids.registry, `Изменить ${SECRET} на В40`, supports(st.frag.facade), { targetRequirementId: ids.r1 })).id;

  // Решение, допущение, вопрос и покрытие по R1 — без закрытых оснований, но с повтором секрета.
  ids.decision = (await ok(s.manager.post(`/requirements/${ids.r1}/decisions`, { statement: `Принять ${SECRET}`, rationale: `Согласно ${SECRET}` }, { headers: idem() }))).decisionId as string;
  ids.assumption = (await ok(s.manager.post(`/stages/${s.stageA}/assumptions`, { statement: `Допускаем ${SECRET}`, requirementId: ids.r1 }, { headers: idem() }))).id as string;
  ids.question = (await ok(s.manager.post(`/stages/${s.stageA}/customer-questions`, { text: `Подтвердите ${SECRET}`, requirementId: ids.r1 }, { headers: idem() }))).id as string;
  const r1 = await s.manager.get(`/requirements/${ids.r1}`);
  await ok(s.manager.post(`/requirement-revisions/${r1.body.currentRevisionId}/coverage`, { state: 'covered', reason: `Учтено: ${SECRET}`, objects: [{ type: 'manual_confirmation', note: `${SECRET} в смете` }] }, { headers: idem() }));

  // Открытое требование R3 с конфликтом параметра против R1.
  const c = await propose(s.manager, ids.registry, 'Фасадные колонны — бетон по шифру ОТКРЫТО-1', supports(st.frag.waterproofing), { parameters: [{ name: 'Шифр бетона', value: 'ОТКРЫТО-1' }] });
  ids.r3 = (await ok(confirm(s.manager, c.id, { conflictNote: 'Расходится с другим требованием реестра' }), 200)).requirementId as string;
});
afterAll(async () => {
  await db.drop();
});

// Все ответы API этапа 08, где мог бы оказаться производный текст R1.
const surfaces = (client: TestClient) => [
  `/stages/${st.s.stageA}/requirement-registry`,
  `/requirement-registries/${ids.registry}/requirements`,
  `/requirement-registries/${ids.registry}/candidates`,
  `/requirement-registries/${ids.registry}/candidates?status=proposed`,
  `/requirement-registries/${ids.registry}/candidates?status=superseded`,
  `/requirements/${ids.r1}`,
  `/requirements/${ids.r2}`,
  `/requirements/${ids.r3}`,
  `/requirement-candidates/${ids.c0}`,
  `/requirement-candidates/${ids.c0b}`,
  `/requirement-candidates/${ids.c1}`,
  `/requirement-candidates/${ids.c3}`,
  `/stages/${st.s.stageA}/assumptions`,
  `/assumptions/${ids.assumption}`,
  `/stages/${st.s.stageA}/customer-questions`,
  `/requirement-registries/${ids.registry}/fragments`,
].map(async (path) => {
  const r = await client.get(path);
  return { path, status: r.status, text: r.text, body: r.body };
});

describe('R08-02: закрытое clarifies скрывает производный текст', () => {
  it('без права на источник clarifies секрета нет ни в одном ответе API этапа 08', async () => {
    for (const r of await Promise.all(surfaces(st.s.eng1))) {
      expect(r.status, r.path).toBe(200);
      expect(r.text, r.path).not.toContain(SECRET);
      expect(r.text, r.path).not.toContain('сведения закрытые');
    }
  });

  it('контроль: с правом на источник секрет виден — тест проверяет реальные поля', async () => {
    const seen = (await Promise.all(surfaces(st.s.manager))).filter((r) => r.text.includes(SECRET)).map((r) => r.path);
    expect(seen).toEqual(expect.arrayContaining([`/requirements/${ids.r1}`, `/requirements/${ids.r2}`, `/requirement-candidates/${ids.c3}`, `/assumptions/${ids.assumption}`]));
    const card = (await st.s.manager.get(`/requirements/${ids.r1}`)).body;
    expect(card).toMatchObject({ visible: true, statement: `Фасадные колонны — бетон по шифру ${SECRET}` });
    expect(card.decisions[0]).toMatchObject({ visible: true, statement: `Принять ${SECRET}` });
    expect(card.questions[0]).toMatchObject({ visible: true, text: `Подтвердите ${SECRET}` });
    expect(card.coverage[0]).toMatchObject({ visible: true, reason: `Учтено: ${SECRET}` });
  });

  it('оболочка: требование, его ревизии, решение, допущение, вопрос и покрытие — без текста, статусы и коды видны', async () => {
    const card = (await st.s.eng1.get(`/requirements/${ids.r1}`)).body;
    expect(card).toMatchObject({ visible: false, restricted: true, statement: null, parameters: null, objectScope: null, status: 'confirmed', coverageState: 'covered' });
    expect(card.evidenceCounts).toEqual({ supports: 1, clarifies: 1 });
    expect(card.revisions[0]).toMatchObject({ visible: false, statement: null, reason: null });
    // Открытое основание по-прежнему читается по правам источника; закрытое — нет.
    const ev = card.revisions[0].evidence as { role: string; restricted: boolean; text: string | null }[];
    expect(ev.find((e) => e.role === 'supports')).toMatchObject({ restricted: false });
    expect(ev.find((e) => e.role === 'clarifies')).toMatchObject({ restricted: true, text: null });
    expect(card.decisions[0]).toMatchObject({ visible: false, statement: null, rationale: null });
    expect(card.assumptions[0]).toMatchObject({ visible: false, statement: null });
    expect(card.questions[0]).toMatchObject({ visible: false, text: null, answerNote: null, status: 'draft' });
    expect(card.coverage[0]).toMatchObject({ visible: false, state: 'covered', reason: null, objects: [], objectCount: 1 });
    expect((await st.s.eng1.get(`/assumptions/${ids.assumption}`)).body).toMatchObject({ visible: false, statement: null, revisions: [] });
  });

  it('наследование: правка закрытого кандидата и кандидат изменения закрытого требования скрыты, хотя их основания открыты', async () => {
    const r2 = (await st.s.eng1.get(`/requirements/${ids.r2}`)).body;
    expect(r2.revisions[0].evidence.every((e: { restricted: boolean }) => !e.restricted)).toBe(true);
    expect(r2).toMatchObject({ visible: false, statement: null });
    expect((await st.s.eng1.get(`/requirement-candidates/${ids.c0b}`)).body).toMatchObject({ visible: false, statement: null, derivedFromCandidateId: ids.c0 });
    expect((await st.s.eng1.get(`/requirement-candidates/${ids.c3}`)).body).toMatchObject({ visible: false, statement: null, targetRequirementId: ids.r1 });
  });

  it('конфликт с закрытым требованием показан кодом, без имени параметра', async () => {
    const r3 = (await st.s.eng1.get(`/requirements/${ids.r3}`)).body;
    const code = (await st.s.eng1.get(`/requirements/${ids.r1}`)).body.code;
    expect(r3).toMatchObject({ visible: true, conflictNote: 'Расходится с другим требованием реестра', conflicts: [{ requirementId: ids.r1, code, parameter: null }] });
    expect((await st.s.manager.get(`/requirements/${ids.r3}`)).body.conflicts).toEqual([{ requirementId: ids.r1, code, parameter: 'шифр бетона' }]);
    expect((await st.s.eng1.get(`/requirements/${ids.r1}`)).body.conflicts).toEqual([{ requirementId: ids.r3, code: r3.code, parameter: null }]);
  });

  it('команды над скрытым объектом — 409 restricted_fragments: правка, допущение и вопрос к закрытому требованию', async () => {
    const tries = [
      st.s.eng1.post(`/requirement-registries/${ids.registry}/requirement-candidates`, { statement: 'Правка', evidence: supports(st.frag.facade), targetRequirementId: ids.r1 }, { headers: idem() }),
      st.s.eng1.post(`/requirement-registries/${ids.registry}/requirement-candidates`, { statement: 'Правка', evidence: supports(st.frag.facade), derivedFromCandidateId: ids.c3 }, { headers: idem() }),
      st.s.eng1.post(`/stages/${st.s.stageA}/assumptions`, { statement: 'Допущение', requirementId: ids.r1 }, { headers: idem() }),
      st.s.eng1.post(`/stages/${st.s.stageA}/customer-questions`, { text: 'Вопрос', requirementId: ids.r1 }, { headers: idem() }),
    ];
    for (const r of await Promise.all(tries)) {
      expect(r.status, r.text).toBe(409);
      expect(r.body.current.reason).toBe('restricted_fragments');
    }
    const q = await st.s.eng1.patch(`/customer-questions/${ids.question}`, { status: 'sent' }, { headers: { 'If-Match': `"${ids.question}:1"` } });
    expect(q.status).toBe(409);
  });

  it('руководитель без права на источник не подтверждает, не отклоняет, не оценивает и не решает по скрытому объекту', async () => {
    await setAccess(st.s.admin, ids.contract, st.s.ids.manager, ['contract.link']);
    try {
      expect((await st.s.manager.get(`/requirements/${ids.r1}`)).body).toMatchObject({ visible: false, statement: null });
      const tag = await etag(st.s.manager, `/requirement-candidates/${ids.c3}`);
      const r1 = (await st.s.manager.get(`/requirements/${ids.r1}`)).body;
      const tries = [
        st.s.manager.post(`/requirement-candidates/${ids.c3}/confirm`, {}, { headers: { 'If-Match': tag, ...idem() } }),
        st.s.manager.post(`/requirement-candidates/${ids.c3}/reject`, { reason: 'нет' }, { headers: { 'If-Match': tag } }),
        st.s.manager.post(`/requirement-revisions/${r1.currentRevisionId}/coverage`, { state: 'uncovered', reason: 'нет' }, { headers: idem() }),
        st.s.manager.post(`/requirements/${ids.r1}/decisions`, { statement: 'Решение', rationale: 'Основание' }, { headers: idem() }),
        st.s.manager.post(`/requirements/${ids.r3}/decisions`, { statement: 'Решение', rationale: 'Основание', supersedesDecisionId: ids.decision }, { headers: idem() }),
      ];
      for (const r of await Promise.all(tries)) {
        expect([404, 409], r.text).toContain(r.status);
        if (r.status === 409) expect(r.body.current.reason).toBe('restricted_fragments');
      }
      expect((await st.s.manager.get(`/requirement-candidates/${ids.c3}`)).body.status).toBe('proposed');
    } finally {
      await setAccess(st.s.admin, ids.contract, st.s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
    }
  });
});
