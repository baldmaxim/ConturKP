// Этап 09: «всё проверено» — только из полного прогона (I07, I18; задание «Выход»). Нераспознанная страница (A16) —
// неполная проверка; незавершённое задание и пустой реестр (A44) — не «замечаний нет»; положительный контроль: этап, где
// все проверки выполнены и замечаний нет, получает «Проверка завершена: замечаний нет»; изменение реестра после
// проверки — «устарела».
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { n } from '../scripts/tenderhub-fake.ts';
import { fakeItem, fakePosition, fakeTender } from '../scripts/tenderhub-fake-data.ts';
import { adminMember, captureNow, linkSource } from './calculationFixtures.ts';
import { createTestDb, drain, idem, makeApp, testConfig, TestClient, type ITestDb } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { buildStage09, checkOf, closeHub, etagOf, fakeModel, runReview, startRun, type IRunView, type IStage09 } from './reviewFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let st: IStage09;
let a16: IRunView;

const CLEAN = {
  tender: '7d1f0c8e-9999-4a6b-9c1d-0000000000c0',
  lamp: '7d1f0c8e-9999-4a6b-9c1d-0000000000c1',
  lampLine: '7d1f0c8e-9999-4a6b-9c1d-0000000000d1',
};
const LAMP_B = 'Светильники в коридорах — светодиодные, тип №2.';

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig(), { missingPage: true });
  a16 = await runReview(st);
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('A16: нераспознанная страница', () => {
  it('распознано 1 из 2 страниц — проверка обработки «неполно», прогон «с пробелами», «всё проверено» не показывается', () => {
    const p = checkOf(a16, 'processing');
    expect(p.outcome).toBe('incomplete');
    expect(p.reason).toMatch(/распознано 1 из 2 страниц/u);
    expect(p.counts.pagesMissing).toBe(1);
    expect(a16.status).toBe('completed_with_gaps');
    expect(a16.summary.kind).toBe('incomplete');
    // Остальные проверки выполнены на имеющемся тексте.
    expect(checkOf(a16, 'pd_uncertainty').outcome).toBe('failed');
  });
});

describe('положительный контроль и незавершённое задание', () => {
  let eng3: TestClient;
  let registryId: string;
  let worker: ReturnType<typeof workerWithChat>;
  let clean: IRunView;

  it('A44: реестр без требований и без прохода — «неполно» и замечание человеку, не «полное покрытие»', async () => {
    eng3 = st.s.eng3;
    const rev = await uploadDocument(db, st.config, eng3, st.s.stageB, 'ТЗ-Б.pdf');
    const run = await seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [LAMP_B] }] });
    await setWorkingSet(st.s.manager, st.s.stageB, [rev], true);
    const scope = await fixScope(st.s.manager, st.s.stageB);
    const reg = await st.s.manager.post(`/stages/${st.s.stageB}/requirement-registries`, { evidenceScopeId: scope, reason: 'Реестр Б' }, { headers: idem() });
    expect(reg.status, reg.text).toBe(201);
    registryId = reg.body.id;
    // Расчёт этапа Б: одна позиция со строкой, без дублей.
    st.hub.tenders.set(
      CLEAN.tender,
      fakeTender({
        id: CLEAN.tender,
        tender_number: 'TH-2026-0B',
        positions: [fakePosition(CLEAN.tender, CLEAN.lamp, { position_number: n('1'), work_name: 'Светильники коридоров', unit_code: 'шт', volume: n('4'), items_count: n('1'), commercial_total: n('200') })],
        items: [fakeItem(CLEAN.tender, CLEAN.lamp, CLEAN.lampLine, { boq_item_type: 'мат', description: 'Светильник светодиодный №2', unit_code: 'шт', quantity: n('4') })],
      }),
    );
    const bossB = await adminMember(db, st.s, makeApp(db, undefined, st.config), st.s.tenderB);
    await linkSource(bossB, st.s.stageB, CLEAN.tender);
    worker = workerWithChat(db, st.config, fakeModel(() => ({ ok: true, value: '{"hypotheses":[]}' })), 'test-worker-09-clean');
    const cap = await captureNow(db, worker, eng3, st.s.stageB);
    expect(cap.status).toBe('complete');
    await worker.scheduleFactExtraction();
    await drain(worker);
    const r = await startRun(st, eng3, st.s.stageB);
    await drain(worker);
    const v = (await eng3.get(`/review-runs/${r.id}`)).body as IRunView;
    expect(checkOf(v, 'registry').outcome).toBe('incomplete');
    expect(checkOf(v, 'coverage').outcome).toBe('not_applicable');
    expect(v.summary.kind).toBe('incomplete');
    const reg09 = (await eng3.get(`/stages/${st.s.stageB}/findings?kind=registry_incomplete`)).body.items;
    expect(reg09).toHaveLength(1);
    expect((await eng3.get(`/findings/${reg09[0].id}`)).body.detail).toMatch(/нет ни одного требования/u);
    // Требование, покрытие строкой, завершённый проход.
    const fragment = await fragmentIdOf(db.pool, run, LAMP_B);
    const c = await eng3.post(`/requirement-registries/${registryId}/requirement-candidates`, { statement: 'Светильники коридоров — тип №2', parameters: [{ name: 'Тип светильника', value: '№2', unit: null }], evidence: [{ fragmentId: fragment, role: 'supports' }] }, { headers: idem() });
    expect(c.status, c.text).toBe(201);
    const conf = await st.s.manager.post(`/requirement-candidates/${c.body.id}/confirm`, {}, { headers: { 'If-Match': await etagOf(st.s.manager, `/requirement-candidates/${c.body.id}`), ...idem() } });
    expect(conf.status, conf.text).toBe(200);
    const cov = await st.s.manager.post(
      `/requirement-revisions/${conf.body.revisionId}/coverage`,
      { state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: cap.revisionId, externalPositionId: CLEAN.lamp, externalItemId: CLEAN.lampLine, match: 'explicit_line' }] },
      { headers: idem() },
    );
    expect(cov.status, cov.text).toBe(201);
    const done = await st.s.manager.post(`/requirement-registries/${registryId}/reviews`, {}, { headers: idem() });
    expect(done.status, done.text).toBe(201);
  });

  it('незавершённое задание: прогон в очереди — «выполняется», итога нет', async () => {
    const r = await startRun(st, eng3, st.s.stageB);
    const queued = (await eng3.get(`/review-runs/${r.id}`)).body as IRunView;
    expect(queued.status).toBe('queued');
    expect(queued.summary.kind).toBe('running');
    expect(queued.checks.every((x) => x.outcome === null)).toBe(true);
    // Повторный запуск при активном прогоне — тот же прогон, не второй.
    const again = await startRun(st, eng3, st.s.stageB);
    expect(again).toMatchObject({ id: r.id, reused: true });
    await drain(worker);
    clean = (await eng3.get(`/review-runs/${r.id}`)).body as IRunView;
  });

  it('все проверки выполнены, замечаний и гипотез нет — «Проверка завершена: замечаний нет»', async () => {
    expect(clean.status, JSON.stringify(clean.checks.map((c) => [c.code, c.outcome, c.reason]))).toBe('completed');
    expect(clean.checks.every((c) => c.outcome === 'passed' || c.outcome === 'not_applicable')).toBe(true);
    expect(checkOf(clean, 'parameters').outcome).toBe('passed');
    expect(checkOf(clean, 'model_hypotheses').outcome).toBe('passed');
    expect(clean.summary).toEqual({ kind: 'clean', text: 'Проверка завершена: замечаний нет' });
    // Замечание A44 этой проверкой больше не обнаружено, но система его не закрывает — закрывает человек.
    const regFinding = (await eng3.get(`/stages/${st.s.stageB}/findings?kind=registry_incomplete`)).body.items[0];
    expect(regFinding.status).toBe('open');
    expect(regFinding.lastRunId).not.toBe(clean.id);
  });

  it('после проверки изменилось покрытие — прогон «устарел», а не «замечаний нет»', async () => {
    const reqs = (await eng3.get(`/requirement-registries/${registryId}/requirements`)).body.items as { currentRevisionId: string }[];
    const cov = await st.s.manager.post(`/requirement-revisions/${reqs[0]!.currentRevisionId}/coverage`, { state: 'uncovered' }, { headers: idem() });
    expect(cov.status, cov.text).toBe(201);
    const v = (await eng3.get(`/review-runs/${clean.id}`)).body as IRunView;
    expect(v.freshness.outdated).toBe(true);
    expect(v.freshness.reasons.join(' ')).toMatch(/реестр требований, покрытие или записи этапа/u);
    expect(v.summary.kind).toBe('outdated');
  });
});
