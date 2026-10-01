// Этап 08: покрытие (Р-08-2, решение по расхождениям: 9 обязательных тестов). Оценка ревизии требования с
// собственной историей и 1..N типизированными объектами; комплексная расценка — позиция без строки (A05);
// новая ревизия расчёта этапа — needs_review от системы; оценка не меняет ревизию требования. Расчёт —
// поддельный TenderHub (VERIFIED_FIXTURE), ревизии provisional: X-01 этапом 08 не снимается.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { createTestDb, idem, makeWorker, testConfig, type ITestDb, type TestClient } from './helpers.ts';
import { buildStage08, confirmedRequirement, type IStage08 } from './requirementFixtures.ts';

let db: ITestDb;
let st: IStage08;
let hub: IFakeTenderHub;
let worker: WorkerRuntime;
let boss: TestClient;
let calc1: string;

const record = (client: TestClient, revisionId: string, body: object) => client.post(`/requirement-revisions/${revisionId}/coverage`, body, { headers: idem() });
const card = async (requirementId: string) => (await st.s.eng1.get(`/requirements/${requirementId}`)).body;

beforeAll(async () => {
  db = await createTestDb();
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.tenders.set(TH.tender, standardTender());
  const config = tenderHubConfig(testConfig(), hub);
  await new BlobStore(config.storageRoot).ensureDirs();
  st = await buildStage08(db, config);
  worker = makeWorker(db, config);
  boss = await adminMember(db, st.s, st.app, st.s.tenderA);
  await linkSource(boss, st.s.stageA, TH.tender);
  const cap = await captureNow(db, worker, st.s.eng1, st.s.stageA);
  expect(cap.status).toBe('complete');
  calc1 = cap.revisionId as string;
});
afterAll(async () => {
  await hub.close();
  await db.drop();
});

describe('покрытие ревизии требования (Р-08-2)', () => {
  it('одно требование + один объект: явная строка расчёта → covered; оценивает только requirement.confirm', async () => {
    const r = await confirmedRequirement(st, 'Бетон плиты — B30', [st.frag.facade]);
    const body = { state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.p1, externalItemId: TH.l2, match: 'explicit_line' }] };
    expect((await record(st.s.eng1, r.revisionId, body)).status).toBe(403);
    const ok = await record(st.s.manager, r.revisionId, body);
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.coverageState).toBe('covered');
    expect(ok.body.coverage[0]).toMatchObject({ seq: 1, state: 'covered', origin: 'human', objects: [expect.objectContaining({ type: 'calculation_revision', match: 'explicit_line', positionName: null })] });
    // Ревизия требования при этом не меняется.
    expect(ok.body.seq).toBe(1);
    expect(ok.body.currentRevisionId).toBe(r.revisionId);
  });

  it('A05: комплексная расценка — позиция без строки (complex_rate) покрывает требование', async () => {
    const r = await confirmedRequirement(st, 'Гидроизоляция плиты — обмазочная', [st.frag.waterproofing]);
    const ok = await record(st.s.manager, r.revisionId, { state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.p1, match: 'complex_rate' }] });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.coverage[0].objects[0]).toMatchObject({ match: 'complex_rate', externalItemId: null });
    // complex_rate со строкой и explicit_line без строки — нарушение формы.
    const bad1 = await record(st.s.manager, r.revisionId, { state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.p1, externalItemId: TH.l1, match: 'complex_rate' }] });
    const bad2 = await record(st.s.manager, r.revisionId, { state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.p1, match: 'explicit_line' }] });
    expect(bad1.status).toBe(409);
    expect(bad2.status).toBe(409);
    // Позиции нет в содержимом ревизии — отказ.
    const missing = await record(st.s.manager, r.revisionId, { state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.l1, match: 'complex_rate' }] });
    expect(missing.status).toBe(409);
  });

  it('несколько объектов: partial (строка + фрагмент), covered (строка + решение + ручное подтверждение)', async () => {
    const r = await confirmedRequirement(st, 'Кровля — профнастил С-44 с утеплением', [st.frag.roof]);
    const d = await st.s.manager.post(`/requirements/${r.requirementId}/decisions`, { statement: 'Утепление учесть в комплексной расценке', rationale: 'по ТЗ' }, { headers: idem() });
    expect(d.status).toBe(201);
    const p = await record(st.s.manager, r.revisionId, {
      state: 'partial',
      reason: 'утепление не найдено',
      objects: [
        { type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.p3, externalItemId: TH.l3, match: 'explicit_line' },
        { type: 'evidence_fragment', fragmentId: st.frag.roof },
      ],
    });
    expect(p.status, p.text).toBe(201);
    const c = await record(st.s.manager, r.revisionId, {
      state: 'covered',
      objects: [
        { type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.p3, externalItemId: TH.l3, match: 'explicit_line' },
        { type: 'decision', decisionId: d.body.decisionId },
        { type: 'manual_confirmation', note: 'Утепление входит в расценку по согласованию' },
      ],
    });
    expect(c.status, c.text).toBe(201);
    expect(c.body.coverage.map((x: { seq: number; state: string; objectCount: number }) => [x.seq, x.state, x.objectCount])).toEqual([
      [1, 'partial', 2],
      [2, 'covered', 3],
    ]);
  });

  it('uncovered и not_applicable — без объектов; not_applicable — с причиной; covered без объекта — отказ', async () => {
    const r = await confirmedRequirement(st, 'Озеленение территории', [st.frag.note]);
    expect((await record(st.s.manager, r.revisionId, { state: 'uncovered' })).status).toBe(201);
    expect((await record(st.s.manager, r.revisionId, { state: 'not_applicable' })).status).toBe(409);
    expect((await record(st.s.manager, r.revisionId, { state: 'not_applicable', reason: 'вне объёма подрядчика' })).status).toBe(201);
    expect((await record(st.s.manager, r.revisionId, { state: 'covered' })).status).toBe(409);
    expect((await record(st.s.manager, r.revisionId, { state: 'uncovered', objects: [{ type: 'manual_confirmation', note: 'x' }] })).status).toBe(409);
  });

  it('A → B → A: история оценок различима; прежние оценки не меняются', async () => {
    const r = await confirmedRequirement(st, 'Фасадные работы — по разделу АР', [st.frag.facade]);
    const obj = [{ type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.p1, match: 'complex_rate' }];
    await record(st.s.manager, r.revisionId, { state: 'covered', objects: obj });
    await record(st.s.manager, r.revisionId, { state: 'partial', reason: 'часть работ исключена', objects: obj });
    const last = await record(st.s.manager, r.revisionId, { state: 'covered', objects: obj });
    expect(last.body.coverage.map((x: { seq: number; state: string }) => [x.seq, x.state])).toEqual([
      [1, 'covered'],
      [2, 'partial'],
      [3, 'covered'],
    ]);
    expect(new Set(last.body.coverage.map((x: { id: string }) => x.id)).size).toBe(3);
  });

  it('объект заменён (решение) или ревизия требования новая: прежняя оценка и её объекты остаются в истории', async () => {
    const r = await confirmedRequirement(st, 'Монолит — по проекту КЖ', [st.frag.facade]);
    const d1 = await st.s.manager.post(`/requirements/${r.requirementId}/decisions`, { statement: 'Монолит — B25', rationale: 'проект' }, { headers: idem() });
    await record(st.s.manager, r.revisionId, { state: 'covered', objects: [{ type: 'decision', decisionId: d1.body.decisionId }] });
    const d2 = await st.s.manager.post(`/requirements/${r.requirementId}/decisions`, { statement: 'Монолит — B30', rationale: 'уточнение', supersedesDecisionId: d1.body.decisionId }, { headers: idem() });
    expect(d2.status).toBe(201);
    const c = await card(r.requirementId);
    expect(c.decisions.find((x: { id: string }) => x.id === d1.body.decisionId).status).toBe('superseded');
    expect(c.coverage[0].objects[0]).toMatchObject({ type: 'decision', decisionId: d1.body.decisionId });
    // Покрытие оценивается только у текущей ревизии требования.
    const other = await record(st.s.manager, (await confirmedRequirement(st, 'Другое', [st.frag.note])).revisionId, { state: 'uncovered' });
    expect(other.status).toBe(201);
  });

  it('новая ревизия расчёта этапа: covered/partial с прежней ревизией расчёта получают needs_review от системы', async () => {
    const reqs = (await st.s.eng1.get(`/requirement-registries/${st.registryId}/requirements`)).body.items as { id: string; coverageState: string | null; code: string }[];
    const withCalc = await db.pool.query<{ requirement_revision_id: string }>(
      `SELECT DISTINCT c.requirement_revision_id FROM requirement_coverage c JOIN requirement_coverage_object o ON o.coverage_id = c.id
        WHERE o.object_type = 'calculation_revision' AND c.state IN ('covered', 'partial')
          AND NOT EXISTS (SELECT 1 FROM requirement_coverage n WHERE n.supersedes_coverage_id = c.id)`,
    );
    expect(withCalc.rows.length).toBeGreaterThan(0);
    hub.tenders.get(TH.tender)!.usd_rate = n('91');
    const cap = await captureNow(db, worker, st.s.eng1, st.s.stageA);
    expect(cap.revisionId).not.toBe(calc1);
    const after = (await st.s.eng1.get(`/requirement-registries/${st.registryId}/requirements`)).body.items as { id: string; coverageState: string | null; code: string }[];
    const flagged = after.filter((x) => x.coverageState === 'needs_review');
    expect(flagged.length).toBe(withCalc.rows.length);
    const sys = await db.pool.query("SELECT origin, assessed_by, trigger_calculation_revision_id FROM requirement_coverage WHERE state = 'needs_review'");
    expect(sys.rows.every((x) => x.origin === 'system' && x.assessed_by === null && x.trigger_calculation_revision_id === cap.revisionId)).toBe(true);
    // Не покрытые и неоценённые требования не трогаются.
    expect(after.filter((x) => x.coverageState === 'uncovered' || x.coverageState === 'not_applicable').length).toBe(reqs.filter((x) => x.coverageState === 'uncovered' || x.coverageState === 'not_applicable').length);
    // Ревизия расчёта — provisional: X-01 не снимается.
    expect((await db.pool.query('SELECT kind FROM calculation_revision WHERE id = $1', [cap.revisionId])).rows[0].kind).toBe('provisional');
  });
});
