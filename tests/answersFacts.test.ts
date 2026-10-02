// Этап 08a: перекрытие по решению человека (AD-08a-1, вариант C временной трактовки). Факт этапа 08, заменённый человеком
// (`fact.supersede`), делает своё основание перекрытым: значение из него не выдаётся за текущее; основание действующего
// факта остаётся текущим.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';
import { buildStage08, supports, workerWithChat, type IStage08 } from './requirementFixtures.ts';
import { ScriptedChat, draftJson, ask, newDialog, type IAnswerStage } from './answerFixtures.ts';
import { buildIndex } from './searchFixtures.ts';

let db: ITestDb;
let st: IStage08;
let ans: IAnswerStage;
const config = testConfig();
const chat = new ScriptedChat();

const fact = async (displayValue: string, fragmentId: string): Promise<string> => {
  const c = await st.s.eng1.post(
    `/requirement-registries/${st.registryId}/fact-candidates`,
    { factKind: 'advance_payment', displayValue, normalizedValue: { value: Number.parseInt(displayValue, 10), unit: '%' }, unit: '%', evidence: supports(fragmentId) },
    { headers: idem() },
  );
  expect(c.status, c.text).toBe(201);
  const ok = await st.s.manager.post(`/fact-candidates/${c.body.id}/confirm`, {}, { headers: { 'If-Match': c.headers.etag, ...idem() } });
  expect(ok.status, ok.text).toBe(200);
  return ok.body.factId as string;
};

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage08(db, config);
  const worker = workerWithChat(db, config, chat);
  await buildIndex(db, worker);
  ans = { s: st.s, app: st.app, worker, chat, revisions: {}, runs: {} };
  // Аванс 30 % по ТЗ заменён человеком фактом по другому основанию.
  const old = await fact('30 %', st.frag.advance);
  const replacement = await fact('25 %', st.frag.note);
  const card = await st.s.manager.get(`/facts/${old}`);
  const sup = await st.s.manager.post(`/facts/${old}/supersede`, { replacementId: replacement, reason: 'Аванс изменён решением заказчика' }, { headers: { 'If-Match': card.headers.etag as string } });
  expect(sup.status, sup.text).toBe(200);
});
afterAll(async () => {
  await db.drop();
});

describe('перекрытие по решению человека (этап 08)', () => {
  it('основание заменённого факта — перекрыто: значение из него как текущее отклонено', async () => {
    chat.scenario = (input) => {
      if (input.task !== 'answer_draft') return null;
      const ev = (JSON.parse(input.user) as { evidence: { label: string; text: string; status: string }[] }).evidence;
      const advance = ev.find((e) => e.text.startsWith('Аванс составляет 30'))!;
      expect(advance.status).toBe('заменённая редакция: условие изменено более поздним документом');
      return draftJson([{ text: 'Аванс составляет 30 процентов цены договора.', kind: 'percentage', evidence: [advance.label] }]);
    };
    const d = await newDialog(st.s.eng1, { kind: 'tender', tenderId: st.s.tenderA, mode: 'working', stageId: st.s.stageA });
    const r = await ask(ans, st.s.eng1, d, 'Какой аванс по договору?');
    expect(r).toMatchObject({ answerStatus: 'incomplete_processing', incompleteReason: 'insufficient_evidence' });
    expect(r.answer!.droppedIssues).toMatchObject({ superseded_evidence: 1 });
    const note = await db.pool.query("SELECT e.version_note FROM answer_evidence e WHERE e.run_id = $1 AND e.fragment_id = $2", [r.id, st.frag.advance]);
    expect(note.rows[0]?.version_note).toBe('superseded');
  });
});
