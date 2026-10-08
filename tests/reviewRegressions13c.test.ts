// Регрессии Review 13-3 (docs/reviews/13-review-3.md). Написаны до исправления продукта; на коде 917c266 сценарий R13-06
// падает, контроль S12-01 проходит и до, и после.
// R13-06: смена типа документа (`doc_type`, PATCH /documents/:id) после прогона меняет вид источника (`sourceKindOf`:
// «договор» → `fromContract` → проверка C07 и приоритет сторон конфликта), но события барьера не создаёт и в отпечаток
// v2 не входила. Теперь прогон устарел: карточка — неснимаемый REVIEW_OUTDATED, вторая линия БД отвергает прямую запись
// согласования, согласование — 409; новый прогон уже видит договорные требования; новый комплект согласуется и
// выпускается. Правка полей приложения прогон не устаревает (S12-01). Данные вымышленные.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  view,
  type ICandidate13,
  type IStage13,
} from './approvalFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let st: IStage13;
let documentId = '';

const readyToApprove = async (): Promise<ICandidate13> => {
  let c = await assembled(st);
  await notApplicable(st, c.id, 'Прошлые события не влияют на комплект');
  c = await view(st, c.id);
  await acceptAll(st, c);
  return view(st, c.id);
};

const runView = async (runId: string) => {
  const r = await st.e.s.eng1.get(`/review-runs/${runId}`);
  expect(r.status, r.text).toBe(200);
  return r.body as { freshness: { outdated: boolean; reasons: string[] }; checks: { code: string; outcome: string; counts: Record<string, number> }[] };
};

const probe = async (fn: (q: pg.PoolClient) => Promise<unknown>): Promise<string> => {
  const client = await st.db.pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    return 'ok';
  } catch (x) {
    return (x as { code?: string }).code ?? 'error';
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

const stageVersion = async (): Promise<number> => Number((await st.db.pool.query('SELECT input_version AS v FROM tender_stage WHERE id = $1', [st.e.s.stageA])).rows[0].v);

beforeAll(async () => {
  st = await buildStage13();
  documentId = (await st.db.pool.query('SELECT document_id AS id FROM document_revision WHERE id = $1', [st.tzRev])).rows[0].id as string;
});
afterAll(async () => {
  await closeStage13(st);
});

describe('R13-06 — смена типа документа после прогона', () => {
  it('тип ТЗ → «договор» после прогона: прогон устарел, REVIEW_OUTDATED в карточке и БД, согласование 409; новый прогон видит договорные требования; новый комплект — согласование 200, выпуск 201', async () => {
    const doc = await st.e.s.manager.get(`/documents/${documentId}`);
    expect(doc.status, doc.text).toBe(200);
    expect(doc.body.docType).not.toBe('contract');
    const runId = await rerunReview(st);
    const before = await runView(runId);
    expect(before.freshness.outdated).toBe(false);
    expect(before.checks.find((c) => c.code === 'obligations')!.outcome).toBe('not_applicable');
    const version = await stageVersion();
    const patched = await st.e.s.manager.patch(`/documents/${documentId}`, { docType: 'contract' }, { headers: { 'If-Match': doc.headers.etag as string } });
    expect(patched.status, patched.text).toBe(200);
    expect(await stageVersion()).toBe(version);
    expect((await runView(runId)).freshness.outdated).toBe(true);

    let c = await readyToApprove();
    expect(codes(c.gate.approve)).toEqual(['REVIEW_OUTDATED']);
    expect((await st.db.pool.query<{ p: string | null }>('SELECT candidate_gate_problem($1) AS p', [c.id])).rows[0]!.p).toBe('REVIEW_OUTDATED');
    expect(
      await probe(async (q) => {
        await q.query("INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, approved_by) VALUES ($1, $2, $3, $4, 0, '{}', $5)", [
          c.id, st.e.s.tenderA, st.e.s.stageA, c.contentHash, st.e.s.ids.manager,
        ]);
        await q.query("UPDATE release_candidate SET status = 'approved', row_version = row_version + 1 WHERE id = $1", [c.id]);
      }),
    ).toBe('23514');
    const refused = await approve(st, c);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['REVIEW_OUTDATED']);

    // Новый прогон: требования ТЗ теперь из договора — проверка договорных обязательств их видит.
    const second = await rerunReview(st);
    const after = await runView(second);
    expect(after.freshness.outdated).toBe(false);
    expect(after.checks.find((c) => c.code === 'obligations')!.outcome).not.toBe('not_applicable');
    c = await readyToApprove();
    expect(codes(c.gate.approve)).toEqual([]);
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    const r = await release(st, await view(st, c.id, st.e.s.eng1), a.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
  });

  it('контроль: переименование документа и правка полей приложения прогон не устаревают', async () => {
    const runId = await rerunReview(st);
    const doc = await st.e.s.manager.get(`/documents/${documentId}`);
    const renamed = await st.e.s.manager.patch(`/documents/${documentId}`, { title: 'ТЗ (переименовано)' }, { headers: { 'If-Match': doc.headers.etag as string } });
    expect(renamed.status, renamed.text).toBe(200);
    await filledDraft(st, 'letter', 'Письмо КП (контроль R13-06)');
    expect((await runView(runId)).freshness.outdated).toBe(false);
  });
});
