// Этап 08a: закрытый ящик (D-027 AD-08a-4, D-025). Письмо — основание ответа только для того, кто читает ящик
// (`mail.read`) и тендер контекста. Без права письмо не входит в область поиска хода, и его текст не попадает ни в
// пакет, ни в ответ; отзыв права после ответа скрывает текст ответа и цитаты, а не только цитату письма.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { ask, draftJson, newDialog, ScriptedChat, workingContext, type IAnswerStage } from './answerFixtures.ts';
import { buildMailScope, MARK, setMailAccess, type IMailScope } from './mailFixtures.ts';
import { buildIndex, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let m: IMailScope;
let st: IAnswerStage;
const config = testConfig();
const chat = new ScriptedChat();
const QUESTION = 'Какая гидроизоляция фундаментной плиты согласована?';

// Модель цитирует письмо, если оно в пакете; иначе — документ тендера.
const citeMail = (user: string) => {
  const ev = (JSON.parse(user) as { evidence: { label: string; text: string }[] }).evidence;
  const mail = ev.find((e) => e.text.includes(MARK.m1.slice(0, 18)));
  const doc = ev.find((e) => e.text.includes('гидроизоляция фундамента обмазочная'));
  return mail
    ? draftJson([{ text: 'Гидроизоляция фундаментной плиты согласована заказчиком.', kind: 'fact', evidence: [mail.label] }])
    : draftJson([{ text: 'Гидроизоляция фундамента обмазочная.', kind: 'fact', evidence: [doc?.label ?? 'E1'] }]);
};

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  const worker = workerWithChat(db, config, chat);
  m = await buildMailScope(
    s,
    worker,
    () => uploadDocument(db, config, s.eng1, s.stageA, 'тз-А.pdf'),
    (rev, text) => seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [text] }] }),
  );
  await setWorkingSet(s.eng1, s.stageA, [m.tenderDoc, m.attRevision]);
  await buildIndex(db, worker);
  st = { s, app, worker, chat, revisions: {}, runs: {} };
  chat.scenario = (input) => (input.task === 'answer_draft' ? citeMail(input.user) : null);
});
afterAll(async () => {
  await db.drop();
});

const mailInPacket = async (runId: string): Promise<boolean> =>
  (
    await db.pool.query(
      'SELECT 1 FROM answer_evidence e JOIN evidence_fragment f ON f.id = e.fragment_id WHERE e.run_id = $1 AND f.mail_message_revision_id IS NOT NULL',
      [runId],
    )
  ).rowCount! > 0;

describe('закрытый ящик', () => {
  it('держатель mail.read получает ответ по письму этапа', async () => {
    const d = await newDialog(s.eng1, workingContext(st));
    const r = await ask(st, s.eng1, d, QUESTION);
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.citations.some((c) => (c.text ?? '').includes(MARK.m1.slice(0, 18)))).toBe(true);
    expect(await mailInPacket(r.id)).toBe(true);
  });

  it('участник тендера без доступа к ящику: письма нет ни в пакете, ни в ответе', async () => {
    const d = await newDialog(s.eng2, workingContext(st));
    const r = await ask(st, s.eng2, d, QUESTION);
    expect(await mailInPacket(r.id)).toBe(false);
    expect(JSON.stringify(r)).not.toContain(MARK.m1.slice(0, 18));
    expect(JSON.stringify((await s.eng2.get(`/dialogs/${d}`)).body)).not.toContain(MARK.m1.slice(0, 18));
  });

  it('mail.read отозван после ответа: текст ответа и цитаты скрыты, сообщение ответа — тоже', async () => {
    const d = await newDialog(s.manager, workingContext(st));
    const r = await ask(st, s.manager, d, QUESTION);
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(await mailInPacket(r.id)).toBe(true);
    await setMailAccess(s.admin, m.boxA, s.ids.manager!, ['mail.link']);
    try {
      const view = (await s.manager.get(`/dialogs/${d}`)).body;
      expect(JSON.stringify(view)).not.toContain(MARK.m1.slice(0, 18));
      expect(JSON.stringify(view)).not.toContain('согласована заказчиком');
      expect(view.runs[0]).toMatchObject({ answerStatus: 'confirmed_by_citations', answer: { visible: false, text: null, citations: [] } });
      expect(view.messages.find((x: { role: string }) => x.role === 'assistant')).toMatchObject({ hidden: true, text: null });
    } finally {
      await setMailAccess(s.admin, m.boxA, s.ids.manager!, ['mail.read', 'mail.link']);
    }
    expect((await s.manager.get(`/answer-runs/${r.id}`)).body.answer.visible).toBe(true);
  });
});
