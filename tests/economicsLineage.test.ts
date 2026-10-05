// Этап 10, D-030 «Дополнение»: автоподтверждение source_lineage — только при совпадении экземпляра TenderHub
// (идентификатор из конфигурации TENDERHUB_INSTANCE_ID), тендера, версии и UUID позиции один к одному. Экземпляр не
// задан или различается (при одном адресе подключения) — пары остаются предложениями.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { compare, E, effectMap, lineageOf, unitOf, units, v1Tender } from './economicsFixtures.ts';
import { buildScenario, createTestDb, idem, makeApp, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { fakeModel } from './reviewFixtures.ts';

let db: ITestDb;
let hub: IFakeTenderHub;
let s: IScenario;
let boss: TestClient;
let base: ReturnType<typeof testConfig>;
const workers = new Map<string, WorkerRuntime>();

const workerFor = (instanceId: string | null): WorkerRuntime => {
  const key = instanceId ?? 'none';
  if (!workers.has(key)) workers.set(key, workerWithChat(db, tenderHubConfig(base, hub, { instanceId }), fakeModel(), `w10-${key}`));
  return workers.get(key)!;
};

const newStage = async (title: string): Promise<string> => {
  const r = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
};

// Две выгрузки одной версии тендера (вторая — с другим количеством штукатурки); экземпляр — из конфигурации worker.
const twoRevisions = async (stageId: string, first: string | null, second: string | null) => {
  hub.tenders.set(E.v1, v1Tender('100'));
  await linkSource(boss, stageId, E.v1, 1);
  const c1 = await captureNow(db, workerFor(first), s.eng1, stageId);
  hub.tenders.set(E.v1, v1Tender('120'));
  const c2 = await captureNow(db, workerFor(second), s.eng1, stageId);
  expect([c1.status, c2.status]).toEqual(['complete', 'complete']);
  expect(c2.revisionId).not.toBe(c1.revisionId);
  return { left: c1.revisionId as string, right: c2.revisionId as string };
};

beforeAll(async () => {
  db = await createTestDb();
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  base = testConfig();
  const config = tenderHubConfig(base, hub);
  await new BlobStore(config.storageRoot).ensureDirs();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  boss = await adminMember(db, s, app, s.tenderA);
});
afterAll(async () => {
  await hub.close();
  await db.drop();
});

describe('source_lineage (D-030 «Дополнение»)', () => {
  it('один экземпляр, тендер, версия и UUID: пары подтверждает система; экземпляр записан в выгрузку, адрес — отдельно', async () => {
    const { left, right } = await twoRevisions(s.stageA, 'th-main', 'th-main');
    const cap = await db.pool.query<{ source_instance_id: string; source_origin: string }>(
      'SELECT k.source_instance_id, k.source_origin FROM calculation_revision r JOIN calculation_capture k ON k.id = r.capture_id WHERE r.id = $1',
      [right],
    );
    expect(cap.rows[0]).toEqual({ source_instance_id: 'th-main', source_origin: new URL(hub.url).origin });
    expect((await s.eng1.get(`/calculation-revisions/${right}`)).body.source.instanceId).toBe('th-main');
    const c = await compare(s.eng1, s.stageA, left, right);
    expect(c.proposals).toMatchObject({ systemConfirmed: 6, proposed: 0 });
    const { body } = await lineageOf(s.eng1, c.id);
    expect(body.items).toHaveLength(6);
    expect(body.items.every((i) => i.method === 'source_lineage' && i.status === 'confirmed' && i.decidedBySystem && i.fromPositionId === i.toPositionId)).toBe(true);
    const list = await units(s.eng1, c.id);
    expect(list.every((u) => u.kind === 'matched')).toBe(true);
    // 100 → 120 м2 по 10: вклад объёма 200; по коэффициенту 1,2 — 240.
    expect(effectMap(unitOf(list, E.p.A), 'cost')).toEqual({ volume: '200' });
    expect(effectMap(unitOf(list, E.p.A), 'commercial')).toEqual({ volume: '240' });
  });

  it('экземпляр не задан: пары по UUID — только предложения', async () => {
    const stage = await newStage('Этап A2');
    const { left, right } = await twoRevisions(stage, null, null);
    const c = await compare(s.eng1, stage, left, right);
    expect(c.proposals).toMatchObject({ systemConfirmed: 0, proposed: 6 });
    const { body } = await lineageOf(s.eng1, c.id);
    expect(body.items.every((i) => i.method === 'source_lineage' && i.status === 'proposed' && !i.decidedBySystem)).toBe(true);
  });

  it('разные идентификаторы экземпляра при одном адресе подключения — тоже только предложения', async () => {
    const stage = await newStage('Этап A3');
    const { left, right } = await twoRevisions(stage, 'th-a', 'th-b');
    const origins = await db.pool.query<{ source_origin: string }>(
      'SELECT DISTINCT k.source_origin FROM calculation_revision r JOIN calculation_capture k ON k.id = r.capture_id WHERE r.id = ANY($1::uuid[])',
      [[left, right]],
    );
    expect(origins.rows).toHaveLength(1);
    const c = await compare(s.eng1, stage, left, right);
    expect(c.proposals).toMatchObject({ systemConfirmed: 0, proposed: 6 });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM position_lineage l JOIN app_user u ON u.id = l.decided_by WHERE u.kind = 'service' AND l.to_revision_id = $1", [right])).rows[0].n).toBe(0);
  });
});
