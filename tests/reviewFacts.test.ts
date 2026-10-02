// Этап 09: разногласие и граф фактов D-018 (D-029 В-09-1, В-09-2). Конфликт значений графа в снимке — замечание с
// обеими сторонами (факты и их фрагменты); приоритет только подсказывает и граф не меняет; решение человека по
// разногласию о фактах пишет и решение, и ребро графа одной транзакцией; без связи с фактами решения по графу нет.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';
import { buildStage09, checkOf, closeHub, cover, findings, line, requirement, RT, runReview, type IRunView, type IStage09 } from './reviewFixtures.ts';

let db: ITestDb;
let st: IStage09;
let run: IRunView;

const SUPPLY = ['Договор поставки № П-9 от 01.02.2026', '3.1. Аванс составляет 25% от цены договора.'];
const AMENDMENT = ['Дополнительное соглашение № 1 к договору поставки № П-9 от 01.02.2026', 'Пункт 3.1 договора изложить в новой редакции: «Аванс составляет 15% от цены договора».'];

const graphFacts = async () => {
  const g = await st.s.manager.get(`/tenders/${st.s.tenderA}/fact-graph`);
  expect(g.status, g.text).toBe(200);
  return g.body as { facts: { id: string; type: string; rawValue: string; state: { status: string; decidedBy: string } | null }[]; decisions: { kind: string; factId: string; otherFactId: string }[] };
};

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig(), {
    extraDocs: [
      { name: 'Договор поставки.pdf', blocks: SUPPLY },
      { name: 'ДС-1 без даты.pdf', blocks: AMENDMENT },
    ],
  });
  const lamp = await requirement(st, 'Светильники в коридорах — тип №1', [{ name: 'Тип светильника', value: '№1' }], [st.frag.lamp]);
  await cover(st, lamp.revisionId, { state: 'covered', objects: [line(st, RT.lamp, RT.lampLine)] });
  run = await runReview(st);
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('конфликт значений графа D-018', () => {
  it('допсоглашение без даты: аванс 25% и 15% в конфликте — замечание с фактами и цитатами обеих сторон', async () => {
    expect(checkOf(run, 'source_conflicts').outcome).toBe('failed');
    const f = (await findings(st)).find((x) => x.kind === 'source_conflict' && x.title.startsWith('Размер аванса'))!;
    expect(f, JSON.stringify((await findings(st)).map((x) => x.title))).toBeTruthy();
    expect(f.severity).toBe('major');
    // Оба документа — вида «прочее»: приоритет не различает; дата приоритетом не является.
    expect(f.suggestedSide).toBeNull();
    const d = (await st.s.eng1.get(`/findings/${f.id}`)).body;
    expect(d.graphFacts.left).toHaveLength(1);
    expect(d.graphFacts.right).toHaveLength(1);
    const quotes = d.evidence.filter((e: { type: string }) => e.type === 'fragment').map((e: { fragment: { text: string } }) => e.fragment.text);
    expect(quotes).toEqual(expect.arrayContaining([SUPPLY[1], AMENDMENT[1]]));
    // Граф прогоном не меняется: оба факта по-прежнему в конфликте.
    const g = await graphFacts();
    expect(g.facts.filter((x) => x.type === 'advance_percent').map((x) => x.state?.status)).toEqual(['conflict', 'conflict']);
  });

  it('решение по разногласию о фактах: без выбора значения — отказ; инженер — 403; руководитель — решение и ребро графа одной транзакцией', async () => {
    const f = (await findings(st)).find((x) => x.kind === 'source_conflict' && x.title.startsWith('Размер аванса'))!;
    const disc = await st.s.eng1.post(`/findings/${f.id}/discrepancy`, { topic: 'Размер аванса' }, { headers: idem() });
    expect(disc.status, disc.text).toBe(201);
    const dId = disc.body.discrepancy.id as string;
    const facts = disc.body.graphFacts as { left: string[]; right: string[] };
    const g0 = await graphFacts();
    const fifteen = g0.facts.find((x) => x.type === 'advance_percent' && x.rawValue.includes('15'))!.id;
    const decide = (client: typeof st.s.manager, body: object) => client.post(`/discrepancies/${dId}/decisions`, body, { headers: idem() });
    const base = { statement: 'Действует аванс 15% по допсоглашению', rationale: 'Допсоглашение подписано позже по письму заказчика' };
    expect((await decide(st.s.eng1, { ...base, graph: { kind: 'prevails', prevailingFactId: fifteen } })).status).toBe(403);
    const none = await decide(st.s.manager, base);
    expect(none.status, none.text).toBe(409);
    expect(none.body.current.reason).toBe('graph_decision_required');
    // Чужой факт — отказ, и ничего не записано (транзакция откатывается целиком).
    const wrong = await decide(st.s.manager, { ...base, graph: { kind: 'prevails', prevailingFactId: '00000000-0000-4000-8000-000000000001' } });
    expect(wrong.status).toBe(409);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM decision WHERE decision_type = 'discrepancy_decision'")).rows[0].n).toBe(0);
    const ok = await decide(st.s.manager, { ...base, graph: { kind: 'prevails', prevailingFactId: fifteen } });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.factDecisionId).toBeTruthy();
    const g = await graphFacts();
    const advance = g.facts.filter((x) => x.type === 'advance_percent');
    expect(advance.find((x) => x.id === fifteen)!.state!.status).toBe('active');
    expect(advance.find((x) => x.id !== fifteen)!.state).toMatchObject({ status: 'superseded', decidedBy: 'human' });
    expect(g.decisions).toEqual([expect.objectContaining({ kind: 'prevails', factId: fifteen, otherFactId: [...facts.left, ...facts.right].find((x) => x !== fifteen) })]);
    // Решение записано вместе с ребром: одна строка каждого вида.
    const counts = await db.pool.query("SELECT (SELECT count(*)::int FROM decision WHERE decision_type = 'discrepancy_decision') AS d, (SELECT count(*)::int FROM fact_decision) AS f");
    expect(counts.rows[0]).toEqual({ d: 1, f: 1 });
    const view = (await st.s.eng1.get(`/findings/${f.id}`)).body;
    expect(view.discrepancy.decisions).toEqual([expect.objectContaining({ type: 'discrepancy_decision', statement: base.statement })]);
    // Решение по разногласию замечание не закрывает: его закрывает человек отдельно (I12, §10).
    expect(view.status).toBe('open');
  });

  it('стороны без фактов: решение по графу не создаётся', async () => {
    const lamp = (await findings(st)).find((x) => x.kind === 'parameter_mismatch')!;
    const disc = await st.s.eng1.post(`/findings/${lamp.id}/discrepancy`, { topic: 'Светильник' }, { headers: idem() });
    const dId = disc.body.discrepancy.id as string;
    const withGraph = await st.s.manager.post(`/discrepancies/${dId}/decisions`, { statement: 'Применять №2', rationale: 'письмо', graph: { kind: 'distinct' } }, { headers: idem() });
    expect(withGraph.status).toBe(409);
    expect(withGraph.body.current.reason).toBe('no_fact_link');
    const plain = await st.s.manager.post(`/discrepancies/${dId}/decisions`, { statement: 'Применять №2', rationale: 'письмо' }, { headers: idem() });
    expect(plain.status, plain.text).toBe(201);
    expect(plain.body.factDecisionId).toBeNull();
    expect((await db.pool.query('SELECT count(*)::int AS n FROM fact_decision')).rows[0].n).toBe(1);
  });
});

describe('приоритет источников (D-029 В-09-1)', () => {
  it('порядок по умолчанию; меняет только руководитель с причиной; приоритет не меняет граф', async () => {
    const cur = await st.s.eng1.get(`/tenders/${st.s.tenderA}/source-priority`);
    expect(cur.status, cur.text).toBe(200);
    expect(cur.body.isDefault).toBe(true);
    expect(cur.body.kinds.map((k: { kind: string }) => k.kind)).toEqual(['contract', 'tz', 'qa_answer', 'customer_letter', 'pd_rd', 'minutes', 'negotiation_speech', 'other']);
    const kinds = ['tz', 'contract', 'qa_answer', 'customer_letter', 'pd_rd', 'minutes', 'negotiation_speech', 'other'];
    expect((await st.s.eng1.post(`/tenders/${st.s.tenderA}/source-priority`, { kinds, reason: 'ТЗ важнее' }, { headers: idem() })).status).toBe(403);
    expect((await st.s.manager.post(`/tenders/${st.s.tenderA}/source-priority`, { kinds: kinds.slice(0, 7), reason: 'неполный' }, { headers: idem() })).status).toBe(400);
    const before = await graphFacts();
    const ok = await st.s.manager.post(`/tenders/${st.s.tenderA}/source-priority`, { kinds, reason: 'По этому тендеру ТЗ выше договора' }, { headers: idem() });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body).toMatchObject({ isDefault: false, revisions: [expect.objectContaining({ seq: 1, reason: 'По этому тендеру ТЗ выше договора', createdBy: 'Руководитель' })] });
    expect(await graphFacts()).toEqual(before);
    // Новый прогон закрепляет ревизию приоритета.
    const r = await runReview(st);
    expect((r.inputs.priority as { kind: string }[]).map((p) => p.kind)).toEqual(kinds);
    expect(r.inputs.priorityRevisionId).toBe(ok.body.revisions[0].id);
  });
});
