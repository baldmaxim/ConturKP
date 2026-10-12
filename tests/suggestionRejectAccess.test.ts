// Этап 15a, S15a-01 (найдено инвентаризацией S15-14): отклонение гипотезы модели возвращало её текст и обоснование без
// проверки, читает ли пользователь основания гипотезы. Чтение прогона те же поля закрывает по читаемости фрагментов.
// Гипотеза строится по требованию из письма: инженер 1 читает ящик, инженер 2 — участник тендера без `mail.read`.
// Модель поддельная: проверяется механизм прав, а не качество гипотез.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { buildStage09, closeHub, fakeModel, requirement, startRun, type IStage09 } from './reviewFixtures.ts';

let db: ITestDb;
let st: IStage09;
let runId: string;
interface ISuggestion {
  id: string;
  status: string;
  restricted: boolean;
  title: string;
  rationale: string | null;
  evidence: { fragmentId: string | null }[];
}
let open: ISuggestion;

const view = async (client = st.s.eng1): Promise<{ suggestions: ISuggestion[] }> => {
  const v = await client.get(`/review-runs/${runId}`);
  expect(v.status, v.text).toBe(200);
  return v.body as { suggestions: ISuggestion[] };
};

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig());
  // Требование с единственным основанием — письмо; слов, общих с позициями расчёта, в формулировке нет: поддельная модель
  // предлагает гипотезу «возможно, не отражено».
  await requirement(st, 'Дератизация подвала', [], [st.frag.letter]);
  const worker = workerWithChat(db, st.config, fakeModel(null), 'test-worker-15a-suggestion');
  runId = (await startRun(st, st.s.eng1)).id;
  await drain(worker);
  const found = (await view()).suggestions.find((s) => s.status === 'open' && s.evidence.some((e) => e.fragmentId === st.frag.letter));
  expect(found, 'гипотеза с основанием из письма').toBeDefined();
  open = found!;
}, 300_000);
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

it('чтение прогона закрывает гипотезу тому, кто не читает письмо (контроль)', async () => {
  expect(open).toMatchObject({ restricted: false });
  expect(open.title).toMatch(/возможно, не отражено/u);
  expect(open.rationale).toBeTruthy();
  const hidden = (await view(st.s.eng2)).suggestions.find((s) => s.id === open.id)!;
  expect(hidden).toMatchObject({ restricted: true, rationale: null, title: 'Гипотеза модели (основания недоступны)' });
});

it('отклонить гипотезу без права читать её основания нельзя: 409 restricted_fragments, текста гипотезы в ответе нет', async () => {
  const r = await st.s.eng2.post(`/model-suggestions/${open.id}/reject`, { reason: 'не относится к расчёту этапа' }, { headers: idem() });
  expect(r.status, r.text).toBe(409);
  expect(r.body.current).toMatchObject({ reason: 'restricted_fragments' });
  expect(JSON.stringify(r.body)).not.toContain(open.title);
  expect(JSON.stringify(r.body)).not.toContain(open.rationale!);
  expect((await view()).suggestions.find((s) => s.id === open.id)!.status).toBe('open');
});

it('тот, кто читает основания, отклоняет гипотезу как раньше (контроль)', async () => {
  const r = await st.s.eng1.post(`/model-suggestions/${open.id}/reject`, { reason: 'позиция учтена в разделе электрики' }, { headers: idem() });
  expect(r.status, r.text).toBe(200);
  expect(r.body).toMatchObject({ id: open.id, status: 'rejected', restricted: false, decisionReason: 'позиция учтена в разделе электрики' });
});
