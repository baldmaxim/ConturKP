// Этап 09: гипотезы модели отдельно от правил (ADR-009, I11, I12; D-029 В-09-5). Отказ модели и невалидный ответ —
// проверка гипотез «ошибка» или «неполно», результаты программных проверок сохраняются, весь прогон «с пробелами»;
// модель не настроена — то же; ложная цитата отбрасывается; гипотеза становится замечанием только решением человека.
// Модель поддельная: проверяется механизм, а не качество.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, drain, idem, makeApp, testConfig, TestClient, type ITestDb } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { buildStage09, checkOf, closeHub, cover, fakeModel, findings, line, requirement, RT, startRun, type IRunView, type IStage09 } from './reviewFixtures.ts';
import type { FakeChatScript } from '../packages/adapters/src/index.ts';

let db: ITestDb;
let st: IStage09;

const runWith = async (script: FakeChatScript | null, client: TestClient = st.s.eng1): Promise<IRunView> => {
  const worker = workerWithChat(db, st.config, fakeModel(script), `test-worker-09-model-${Math.random().toString(36).slice(2, 8)}`);
  const r = await startRun(st, client);
  await drain(worker);
  const v = await client.get(`/review-runs/${r.id}`);
  expect(v.status, v.text).toBe(200);
  return v.body as IRunView;
};

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig());
  const lamp = await requirement(st, 'Светильники в коридорах — тип №1', [{ name: 'Тип светильника', value: '№1' }], [st.frag.lamp]);
  await cover(st, lamp.revisionId, { state: 'covered', objects: [line(st, RT.lamp, RT.lampLine)] });
  // Требование без похожей позиции: эвристика поддельной модели предлагает гипотезу «не отражено».
  await requirement(st, 'Молниезащита кровли по ТЗ', [], [st.frag.pd]);
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('отказ и невалидный ответ модели', () => {
  it('модель отказала: гипотез нет, правила выполнены, прогон «с пробелами»', async () => {
    const v = await runWith(() => ({ ok: false, error: { code: 'AUTH_FAILED', message: 'нет доступа к модели', retryable: false } }));
    expect(checkOf(v, 'model_hypotheses')).toMatchObject({ outcome: 'error', reason: expect.stringMatching(/AUTH_FAILED/u) });
    expect(v.status).toBe('completed_with_gaps');
    expect(v.suggestions).toEqual([]);
    // Результаты программных проверок сохранены (D-029 В-09-5).
    expect(checkOf(v, 'parameters').outcome).toBe('failed');
    expect(v.findings.unsettled).toBeGreaterThan(0);
    expect(v.summary.kind).toBe('incomplete');
  });

  it('ответ не JSON — пробел охвата, не «пройдено»', async () => {
    const v = await runWith(() => ({ ok: true, value: 'согласовано, всё хорошо' }));
    expect(checkOf(v, 'model_hypotheses')).toMatchObject({ outcome: 'incomplete', reason: expect.stringMatching(/не прошли проверку/u) });
    expect(v.status).toBe('completed_with_gaps');
  });

  it('ложная цитата отбрасывается до записи', async () => {
    const fake = '00000000-0000-4000-8000-000000000000';
    const v = await runWith(() => ({ ok: true, value: JSON.stringify({ hypotheses: [{ title: 'Выдуманное расхождение', rationale: 'нет', left: { fragmentId: fake }, right: null }] }) }));
    expect(checkOf(v, 'model_hypotheses')).toMatchObject({ outcome: 'passed', counts: expect.objectContaining({ dropped: 1, hypotheses: 0 }) });
    expect(v.suggestions).toEqual([]);
  });

  it('модель не настроена: проверка гипотез «неполно», прогон «с пробелами»', async () => {
    const config = { ...st.config, chatModel: { ...st.config.chatModel, provider: 'none' as const } };
    const eng = new TestClient(makeApp(db, undefined, config));
    expect((await eng.login('eng1')).status).toBe(200);
    const r = await startRun(st, eng);
    await drain(st.worker);
    const v = (await eng.get(`/review-runs/${r.id}`)).body as IRunView;
    expect(v.inputs.promptVersion).toBeNull();
    expect(checkOf(v, 'model_hypotheses')).toMatchObject({ outcome: 'incomplete', reason: 'модель не настроена: гипотезы не построены' });
    expect(v.status).toBe('completed_with_gaps');
  });
});

describe('гипотезы — только предложения человеку', () => {
  let v: IRunView;

  it('гипотеза записана как предложение; замечания модель не создаёт', async () => {
    const before = (await findings(st)).length;
    v = await runWith(null);
    expect(checkOf(v, 'model_hypotheses').outcome).toBe('failed');
    expect(v.suggestions).toEqual([expect.objectContaining({ status: 'open', title: expect.stringMatching(/возможно, не отражено/u) })]);
    expect((await findings(st)).length).toBe(before);
    expect(v.summary.kind).toBe('incomplete');
  });

  it('принимает человек: замечание происхождения «гипотеза», критичность — выбор человека; повторное принятие — отказ', async () => {
    const s = v.suggestions[0]!;
    const ok = await st.s.eng2.post(`/model-suggestions/${s.id}/accept`, { severity: 'minor', reason: 'проверить молниезащиту в смете' }, { headers: idem() });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body).toMatchObject({ origin: 'model_suggestion', kind: 'model_hypothesis', severity: 'minor', confidence: 'low', status: 'open' });
    expect(ok.body.events[0]).toMatchObject({ kind: 'created', actor: 'Инженер 2' });
    const again = await st.s.eng1.post(`/model-suggestions/${s.id}/accept`, { severity: 'major', reason: null }, { headers: idem() });
    expect(again.status).toBe(409);
    const runNow = (await st.s.eng1.get(`/review-runs/${v.id}`)).body as IRunView;
    expect(runNow.suggestions[0]).toMatchObject({ status: 'accepted', findingId: ok.body.id });
  });

  it('отклонение — с причиной; гипотезу чужого тендера не видно', async () => {
    const v2 = await runWith(null);
    const s = v2.suggestions.find((x) => x.status === 'open')!;
    expect((await st.s.eng3.post(`/model-suggestions/${s.id}/reject`, { reason: 'чужой тендер' }, { headers: idem() })).status).toBe(404);
    const r = await st.s.eng1.post(`/model-suggestions/${s.id}/reject`, { reason: 'молниезащита не в объёме подрядчика' }, { headers: idem() });
    expect(r.status, r.text).toBe(200);
    expect(r.body.status).toBe('rejected');
  });
});
