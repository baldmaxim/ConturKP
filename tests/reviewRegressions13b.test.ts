// Регрессии Review 13-2 (docs/reviews/13-review-2.md). Написаны до исправления продукта; на коде 34e0af2 сценарии
// R13-05 падают, контроль S12-01 проходит и до, и после.
// R13-05: отпечаток содержимого этапа терял изменения записей, не ставших максимумом (`max(row_version + updated_at)`
// у вопросов). Сценарий ревью — первый вопрос изменён 32 раза, второй отправлен после прогона: прогон устарел, согласование
// и выпуск запрещены неснимаемым REVIEW_OUTDATED (и во второй линии БД); новый прогон и новый комплект — согласуются и
// выпускаются. Тот же класс: кандидат требования, созданный после прогона (без подтверждения), меняет полноту реестра —
// прогон устарел. Правка полей приложения прогон не устаревает (S12-01). Данные вымышленные.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { idem } from './helpers.ts';
import {
  acceptAll,
  approve,
  assembled,
  buildStage13,
  closeStage13,
  codes,
  filledDraft,
  notApplicable,
  release,
  rerunReview,
  TZ,
  view,
  type ICandidate13,
  type IStage13,
} from './approvalFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let st: IStage13;

const readyToApprove = async (): Promise<ICandidate13> => {
  let c = await assembled(st);
  await notApplicable(st, c.id, 'Прошлые события не влияют на комплект');
  c = await view(st, c.id);
  await acceptAll(st, c);
  return view(st, c.id);
};

const freshness = async (runId: string): Promise<{ outdated: boolean; reasons: string[] }> => {
  const r = await st.e.s.eng1.get(`/review-runs/${runId}`);
  expect(r.status, r.text).toBe(200);
  return r.body.freshness;
};

const gateProblem = async (candidateId: string): Promise<string | null> =>
  (await st.db.pool.query<{ p: string | null }>('SELECT candidate_gate_problem($1) AS p', [candidateId])).rows[0]!.p;

const question = async (text: string): Promise<{ id: string; etag: string }> => {
  const q = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/customer-questions`, { text }, { headers: idem() });
  expect(q.status, q.text).toBe(201);
  return { id: q.body.id as string, etag: q.headers.etag as string };
};

const patch = async (q: { id: string; etag: string }, body: Record<string, unknown>): Promise<{ id: string; etag: string; rowVersion: number }> => {
  const r = await st.e.s.eng1.patch(`/customer-questions/${q.id}`, body, { headers: { 'If-Match': q.etag } });
  expect(r.status, r.text).toBe(200);
  return { id: q.id, etag: r.headers.etag as string, rowVersion: Number(/:(\d+)"$/.exec(r.headers.etag as string)![1]) };
};

beforeAll(async () => {
  st = await buildStage13({ review: false });
});
afterAll(async () => {
  await closeStage13(st);
});

describe('R13-05 — изменение любой записи входа устаревает прогон', () => {
  it('сценарий ревью: первый вопрос изменён 32 раза, второй отправлен после прогона — прогон устарел, REVIEW_OUTDATED в API и БД; новый прогон и комплект — согласование 200, выпуск 201', async () => {
    let q1 = { ...(await question('Уточните класс бетона перекрытий (R13-05)')), rowVersion: 1 };
    const q2 = await question('Подтвердите срок поставки арматуры (R13-05)');
    for (let i = 0; i < 32; i += 1) q1 = await patch(q1, { text: `Уточните класс бетона перекрытий, вариант ${i + 1}` });
    expect(q1.rowVersion).toBe(33);
    const runId = await rerunReview(st);
    expect((await freshness(runId)).outdated).toBe(false);
    // После прогона меняется только второй вопрос (не максимум по версии).
    const sent = await patch(q2, { status: 'sent' });
    expect(sent.rowVersion).toBe(2);
    expect((await freshness(runId)).outdated).toBe(true);

    let c = await readyToApprove();
    expect(codes(c.gate.approve)).toEqual(['REVIEW_OUTDATED']);
    expect(c.gate.approve!.blockers.find((b) => b.code === 'REVIEW_OUTDATED')!.acceptable).toBe(false);
    expect(await gateProblem(c.id)).toBe('REVIEW_OUTDATED');
    const refused = await approve(st, c);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['REVIEW_OUTDATED']);

    // Новый прогон по изменённым вопросам, новый комплект: бизнес-пункт вопроса снимается риском, комплект согласуется.
    const second = await rerunReview(st);
    expect((await freshness(second)).outdated).toBe(false);
    c = await readyToApprove();
    expect(codes(c.gate.approve)).toEqual([]);
    expect(await gateProblem(c.id)).toBeNull();
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    const r = await release(st, await view(st, c.id, st.e.s.eng1), a.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
  });

  it('кандидат требования, созданный после прогона без подтверждения, меняет полноту реестра — прогон устарел, согласование 409', async () => {
    const runId = await rerunReview(st);
    expect((await freshness(runId)).outdated).toBe(false);
    const fragment = (await st.db.pool.query('SELECT id FROM evidence_fragment WHERE text = $1 ORDER BY id LIMIT 1', [TZ.paint])).rows[0].id as string;
    const cand = await st.e.s.eng1.post(
      `/requirement-registries/${st.registryId}/requirement-candidates`,
      { statement: 'Окраска фасада: колер по RAL (R13-05)', parameters: [], evidence: [{ fragmentId: fragment, role: 'supports' }] },
      { headers: idem() },
    );
    expect(cand.status, cand.text).toBe(201);
    expect((await freshness(runId)).outdated).toBe(true);
    const c = await readyToApprove();
    expect(codes(c.gate.approve)).toEqual(['REVIEW_OUTDATED']);
    expect(await gateProblem(c.id)).toBe('REVIEW_OUTDATED');
    expect((await approve(st, c)).status).toBe(409);
  });

  it('контроль S12-01: правка полей приложения прогон не устаревает', async () => {
    const runId = await rerunReview(st);
    await filledDraft(st, 'letter', 'Письмо КП (контроль R13-05)');
    expect((await freshness(runId)).outdated).toBe(false);
  });
});
