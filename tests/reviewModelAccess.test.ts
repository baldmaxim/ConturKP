// Этап 09, Review 09-2: регрессия R09-04 — вход модели закреплён при запуске (R09-02), но права запустившего проверяются
// перед отправкой модели и перед каждой пачкой (ADR-006, I05, I17, R08-02): отзыв права на основание, закрытость по
// любой роли основания и наследованию текста, снятие с тендера, отключение пользователя. Модель — записывающая
// поддельная: проверяется фактический аргумент `IChatCompleteInput.user`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatModelResult, IChatCompleteInput, IChatCompletion, IModelGatewayChat } from '../packages/adapters/src/index.ts';
import { reviewUserContent } from '../packages/core/src/index.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb, type TestClient } from './helpers.ts';
import { etagOf, setMailAccess } from './mailFixtures.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { buildStage09, checkOf, closeHub, requirement, startRun, TXT, type IRunView, type IStage09 } from './reviewFixtures.ts';

// Модель с той же идентичностью, что закрепляет сервер (fake / fake-chat / test), записывает каждый запрос.
class RecordingChat implements IModelGatewayChat {
  readonly providerId = 'fake' as const;
  readonly model = 'fake-chat';
  readonly version = 'test';
  readonly inferenceConfig = { temperature: 0 };
  readonly calls: IChatCompleteInput[] = [];
  readonly maxInputChars: number;
  private readonly onCall: (n: number) => Promise<void>;
  constructor(maxInputChars = 100_000, onCall: (n: number) => Promise<void> = async () => undefined) {
    this.maxInputChars = maxInputChars;
    this.onCall = onCall;
  }
  async complete(input: IChatCompleteInput): Promise<ChatModelResult<IChatCompletion>> {
    this.calls.push(input);
    await this.onCall(this.calls.length);
    return { ok: true, value: { content: '{"hypotheses":[]}', startedAt: new Date(), finishedAt: new Date(), promptTokens: null, completionTokens: null } };
  }
}

let db: ITestDb;
let st: IStage09;
let box: string;
const req: Record<string, { requirementId: string; revisionId: string; code: string }> = {};
const LETTER = 'Согласовываем замену';

const sent = (chat: RecordingChat) => chat.calls.map((c) => c.user).join('\n');
const runRules = async (client: TestClient) => {
  const r = await startRun(st, client);
  const w = workerWithChat(db, st.config, new RecordingChat(), `rules-${r.id.slice(0, 8)}`);
  for (let i = 0; i < 20 && (await w.runOnce(['review.run'])); i += 1);
  expect((await db.pool.query("SELECT 1 FROM job WHERE kind = 'review.model' AND status = 'queued' AND payload->>'runId' = $1", [r.id])).rowCount).toBe(1);
  return r.id;
};
const runModel = async (runId: string, chat: RecordingChat, client: TestClient = st.s.manager): Promise<IRunView> => {
  await drain(workerWithChat(db, st.config, chat, `model-${runId.slice(0, 8)}`));
  const v = await client.get(`/review-runs/${runId}`);
  expect(v.status, v.text).toBe(200);
  return v.body as IRunView;
};
const mailAccess = (userId: string, caps: string[]) => setMailAccess(st.s.admin, box, userId, caps);

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig());
  box = (await db.pool.query<{ id: string }>('SELECT id FROM mailbox LIMIT 1')).rows[0]!.id;
  // R-0001 — основание ТЗ; R-0002 — основание письмо; R-0003 — основание ТЗ, «уточняет» — письмо (закрытость по роли).
  req.tz = await requirement(st, 'Молниезащита кровли по ТЗ', [], [st.frag.pd]);
  req.mail = await requirement(st, 'Светильник №2 по письму заказчика', [], [st.frag.letter]);
  const c = await st.s.eng1.post(
    `/requirement-registries/${st.registryId}/requirement-candidates`,
    { statement: 'Облицовка фасада клинкером', parameters: [], evidence: [{ fragmentId: st.frag.facade, role: 'supports' }, { fragmentId: st.frag.letter, role: 'clarifies' }] },
    { headers: idem() },
  );
  expect(c.status, c.text).toBe(201);
  const conf = await st.s.manager.post(`/requirement-candidates/${c.body.id}/confirm`, {}, { headers: { 'If-Match': await etagOf(st.s.manager, `/requirement-candidates/${c.body.id}`), ...idem() } });
  expect(conf.status, conf.text).toBe(200);
  req.clarified = { requirementId: conf.body.requirementId, revisionId: conf.body.revisionId, code: 'R-0003' };
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('R09-04: права запустившего проверяются перед моделью', () => {
  it('отзыв mail.read между заданиями правил и модели: закрытое требование не уходит в модель, C12 — неполно', async () => {
    const runId = await runRules(st.s.eng1);
    const pinned = (await db.pool.query('SELECT model_input FROM review_run_input WHERE run_id = $1', [runId])).rows[0].model_input;
    expect(JSON.stringify(pinned)).toContain(LETTER);
    await mailAccess(st.s.ids.eng1!, []);
    const own = await st.s.eng1.get(`/requirements/${req.mail!.requirementId}`);
    expect(own.status).toBe(200);
    expect(own.body.restricted).toBe(true);
    const chat = new RecordingChat();
    const v = await runModel(runId, chat);
    expect(chat.calls.length).toBe(1);
    expect(sent(chat)).not.toContain(LETTER);
    expect(sent(chat)).not.toContain('Светильник №2 по письму заказчика');
    expect(sent(chat)).toContain('Молниезащита кровли по ТЗ');
    const c12 = checkOf(v, 'model_hypotheses');
    expect(c12.outcome).toBe('incomplete');
    expect(c12.reason).toMatch(/недоступн/u);
    expect(c12.counts).toMatchObject({ restricted: 2, requirements: 1 });
    // Закреплённый вход не меняется (R09-02): права — текущие, вход — прежний.
    expect((await db.pool.query('SELECT model_input FROM review_run_input WHERE run_id = $1', [runId])).rows[0].model_input).toEqual(pinned);
    await mailAccess(st.s.ids.eng1!, ['mail.read', 'mail.import', 'mail.link']);
  });

  it('закрытость по любой роли основания (R08-02): «уточняет» письмом — требование в модель не уходит и при запуске', async () => {
    const runId = await runRules(st.s.eng2);
    const pinned = (await db.pool.query('SELECT model_input FROM review_run_input WHERE run_id = $1', [runId])).rows[0].model_input as { requirements: { code: string }[]; restricted: number };
    expect(pinned.requirements.map((r) => r.code)).toEqual([req.tz!.code]);
    expect(pinned.restricted).toBe(2);
    const chat = new RecordingChat();
    const v = await runModel(runId, chat);
    expect(sent(chat)).not.toContain(LETTER);
    expect(sent(chat)).not.toContain('Облицовка фасада клинкером');
    expect(checkOf(v, 'model_hypotheses')).toMatchObject({ outcome: 'incomplete', counts: expect.objectContaining({ restricted: 2, requirements: 1 }) });
  });

  it('права проверяются перед каждой пачкой: отзыв после первой пачки исключает закрытые требования следующих', async () => {
    const runId = await runRules(st.s.eng1);
    const pinned = (await db.pool.query('SELECT model_input FROM review_run_input WHERE run_id = $1', [runId])).rows[0].model_input as {
      requirements: { code: string }[];
      positions: unknown[];
    };
    expect(pinned.requirements.map((r) => r.code)).toEqual([req.tz!.code, req.mail!.code, req.clarified!.code]);
    // Предел модели — одна пачка на требование.
    const one = Math.max(...pinned.requirements.map((r) => reviewUserContent({ requirements: [r as never], positions: pinned.positions as never }).length));
    const two = reviewUserContent({ requirements: pinned.requirements.slice(0, 2) as never, positions: pinned.positions as never }).length;
    expect(one).toBeLessThan(two);
    const chat = new RecordingChat(one, async (n) => {
      if (n === 1) await mailAccess(st.s.ids.eng1!, []);
    });
    const v = await runModel(runId, chat);
    expect(chat.calls.length).toBe(1);
    expect(sent(chat)).toContain('Молниезащита кровли по ТЗ');
    expect(sent(chat)).not.toContain(LETTER);
    expect(checkOf(v, 'model_hypotheses')).toMatchObject({ outcome: 'incomplete', counts: expect.objectContaining({ restricted: 2 }) });
    await mailAccess(st.s.ids.eng1!, ['mail.read', 'mail.import', 'mail.link']);
  });

  it('запустивший снят с тендера: модель не вызывается, C12 — неполно с причиной', async () => {
    const runId = await runRules(st.s.eng2);
    const card = await st.s.admin.get(`/tenders/${st.s.tenderA}`);
    const del = await st.s.admin.delete(`/tenders/${st.s.tenderA}/members/${st.s.ids.eng2}`, { headers: { 'If-Match': card.headers.etag as string } });
    expect(del.status, del.text).toBe(200);
    const chat = new RecordingChat();
    const v = await runModel(runId, chat);
    expect(chat.calls.length).toBe(0);
    expect(checkOf(v, 'model_hypotheses')).toMatchObject({ outcome: 'incomplete', reason: expect.stringMatching(/не участник тендера/u) });
  });

  it('запустивший отключён: модель не вызывается, C12 — неполно с причиной', async () => {
    const runId = await runRules(st.s.eng1);
    const users = (await st.s.admin.get('/admin/users')).body.items as { id: string; rowVersion: number }[];
    const user = users.find((u) => u.id === st.s.ids.eng1)!;
    const off = await st.s.admin.patch(`/admin/users/${st.s.ids.eng1}`, { status: 'disabled' }, { headers: { 'If-Match': `"${user.id}:${user.rowVersion}"` } });
    expect(off.status, off.text).toBe(200);
    const chat = new RecordingChat();
    const v = await runModel(runId, chat);
    expect(chat.calls.length).toBe(0);
    expect(checkOf(v, 'model_hypotheses')).toMatchObject({ outcome: 'incomplete', reason: expect.stringMatching(/отключён/u) });
  });
});

void TXT;
