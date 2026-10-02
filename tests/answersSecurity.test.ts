// Этап 08a: права ответного ядра (D-027 AD-08a-4). Диалог видит только автор — чужой и администратор получают 404;
// контекст — с правами поиска 05; права на основания перепроверяются в задании (после вопроса) и при каждом чтении:
// текст ответа по основанию, право на которое отозвано, не выдаётся, а сообщение ответа скрывается.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContract, grantCreator, linkContract, setAccess, uploadMain } from './contractFixtures.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { ask, askQuestion, buildAnswerStage, newDialog, workingContext, type IAnswerStage } from './answerFixtures.ts';
import { buildIndex, seedEvidenceRun, setWorkingSet } from './searchFixtures.ts';

let db: ITestDb;
let st: IAnswerStage;
let contractId: string;
const config = testConfig();
const SECRET = 'Неустойка подрядчика составляет 0,7% за каждый день просрочки по договору Д-СЕКРЕТ.';

beforeAll(async () => {
  db = await createTestDb();
  st = await buildAnswerStage(db, config, { 'ТЗ.pdf': { pages: [{ blocks: ['Фасад облицовывается керамогранитом толщиной 10 мм.'] }] } });
  // Договор, связанный с тендером, в рабочем составе этапа: его основание читает только держатель contract.read.
  await grantCreator(st.s.admin, st.s.ids.manager);
  contractId = await createContract(st.s.manager, 'Д-СЕКРЕТ');
  await setAccess(st.s.admin, contractId, st.s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
  const main = await uploadMain(st.s.manager, contractId, 'договор-секрет.pdf');
  await seedEvidenceRun(db.pool, main.revisionId, { pages: [{ blocks: [SECRET] }] });
  await linkContract(st.s.manager, contractId, st.s.tenderA);
  await setWorkingSet(st.s.manager, st.s.stageA, [...Object.values(st.revisions), main.revisionId]);
  await buildIndex(db, st.worker);
});
afterAll(async () => {
  await db.drop();
});

describe('диалог видит только автор', () => {
  it('другой участник тендера и администратор — 404 на диалог, прогон и вопрос; в их списках диалога нет', async () => {
    const d = await newDialog(st.s.eng1, workingContext(st));
    const r = await ask(st, st.s.eng1, d, 'Чем облицовывается фасад?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    for (const other of [st.s.eng2, st.s.manager, st.s.admin]) {
      expect((await other.get(`/dialogs/${d}`)).status).toBe(404);
      expect((await other.get(`/answer-runs/${r.id}`)).status).toBe(404);
      expect((await other.post(`/dialogs/${d}/messages`, { text: 'Чужой вопрос' }, { headers: idem() })).status).toBe(404);
      expect(((await other.get(`/dialogs?tenderId=${st.s.tenderA}`)).body.items as { id: string }[]).some((x) => x.id === d)).toBe(false);
    }
    expect(((await st.s.eng1.get(`/dialogs?stageId=${st.s.stageA}`)).body.items as { id: string }[]).map((x) => x.id)).toContain(d);
  });

  it('диалог в чужом тендере и по договору без contract.read не создаётся', async () => {
    const foreign = await st.s.eng3.post('/dialogs', { context: workingContext(st) }, { headers: idem() });
    expect(foreign.status).toBe(404);
    const contract = await st.s.eng1.post('/dialogs', { context: { kind: 'contract', contractId } }, { headers: idem() });
    expect([403, 404]).toContain(contract.status);
  });
});

describe('основания — по правам источника, сейчас', () => {
  it('отзыв contract.read после ответа: текст ответа и сообщение скрыты, статус и число утверждений видны', async () => {
    const d = await newDialog(st.s.manager, workingContext(st));
    const r = await ask(st, st.s.manager, d, 'Какая неустойка подрядчика за просрочку?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.text).toContain('0,7%');
    await setAccess(st.s.admin, contractId, st.s.ids.manager, ['contract.link']);
    try {
      const view = (await st.s.manager.get(`/dialogs/${d}`)).body;
      expect(JSON.stringify(view)).not.toContain('0,7%');
      expect(view.messages.find((m: { role: string }) => m.role === 'assistant')).toMatchObject({ hidden: true, text: null });
      expect(view.runs[0]).toMatchObject({ answerStatus: 'confirmed_by_citations', answer: { visible: false, text: null, citations: [], shownClaims: 1 } });
      const run = (await st.s.manager.get(`/answer-runs/${r.id}`)).body;
      expect(JSON.stringify(run)).not.toContain('Д-СЕКРЕТ');
    } finally {
      await setAccess(st.s.admin, contractId, st.s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
    }
    expect((await st.s.manager.get(`/answer-runs/${r.id}`)).body.answer.text).toContain('0,7%');
  });

  it('право отозвано между вопросом и выполнением задания: основание договора в пакет не попадает', async () => {
    const d = await newDialog(st.s.manager, workingContext(st));
    const runId = await askQuestion(st.s.manager, d, 'Какая неустойка подрядчика за просрочку?');
    await setAccess(st.s.admin, contractId, st.s.ids.manager, ['contract.link']);
    try {
      await drain(st.worker);
      const run = (await st.s.manager.get(`/answer-runs/${runId}`)).body;
      expect(run.answerStatus).not.toBe('confirmed_by_citations');
      expect(JSON.stringify(run)).not.toContain('0,7%');
      const packet = await db.pool.query('SELECT f.text FROM answer_evidence e JOIN evidence_fragment f ON f.id = e.fragment_id WHERE e.run_id = $1', [runId]);
      expect(packet.rows.map((p) => p.text)).not.toContain(SECRET);
      expect(run.coverage.excludedByAccess).toBeGreaterThan(0);
    } finally {
      await setAccess(st.s.admin, contractId, st.s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
    }
  });

  it('участник, у которого нет contract.read, получает ответ без основания договора', async () => {
    const d = await newDialog(st.s.eng1, workingContext(st));
    const r = await ask(st, st.s.eng1, d, 'Какая неустойка подрядчика за просрочку?');
    expect(JSON.stringify(r)).not.toContain('0,7%');
    expect(r.answerStatus).not.toBe('confirmed_by_citations');
  });
});
