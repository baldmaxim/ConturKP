// Фикстуры этапа 06: эталонный тендер поддельного TenderHub и помощники выгрузки. Данные синтетические.
import { expect } from 'vitest';
import type { IAppConfig } from '../packages/config/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { TH_KEY, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { createUser, drain, idem, TestClient, type IScenario, type ITestDb } from './helpers.ts';

export { PRECISE_RATE, standardTender, TH, TH_KEY } from '../scripts/tenderhub-fake.ts';

export const tenderHubConfig = (base: IAppConfig, hub: IFakeTenderHub, o: Partial<IAppConfig['tenderhub']> = {}): IAppConfig => ({
  ...base,
  tenderhub: { ...base.tenderhub, baseUrl: hub.url, apiKey: TH_KEY, rateLimitWindowMs: 50, ...o },
});

// Администратор-участник тендера: admin.tender нужен для связи этапа с TenderHub, а этап виден
// только участнику (ADR-006).
export const adminMember = async (db: ITestDb, s: IScenario, app: ConstructorParameters<typeof TestClient>[0], tenderId: string): Promise<TestClient> => {
  const id = await createUser(db.pool, `boss${tenderId.slice(0, 4)}`, ['admin', 'manager'], 'Администратор-руководитель');
  const card = await s.admin.get(`/tenders/${tenderId}`);
  const m = await s.admin.put(`/tenders/${tenderId}/members/${id}`, { memberRole: 'manager' }, { headers: { 'If-Match': card.headers.etag as string } });
  expect(m.status, m.text).toBe(200);
  const c = new TestClient(app);
  expect((await c.login(`boss${tenderId.slice(0, 4)}`)).status).toBe(200);
  return c;
};

export const linkSource = async (client: TestClient, stageId: string, externalTenderId: string, externalVersion: number | null = null) => {
  const cur = await client.get(`/stages/${stageId}/calculation-source`);
  expect(cur.status, cur.text).toBe(200);
  const r = await client.put(`/stages/${stageId}/calculation-source`, { externalTenderId, externalVersion }, { headers: { 'If-Match': cur.headers.etag as string } });
  expect(r.status, r.text).toBe(200);
  return r;
};

// Запрос выгрузки и выполнение заданий; повторы с задержкой ускоряются, пока очередь не опустеет.
export const captureNow = async (db: ITestDb, worker: WorkerRuntime, client: TestClient, stageId: string) => {
  const r = await client.post(`/stages/${stageId}/calculation-captures`, {}, { headers: idem() });
  expect(r.status, r.text).toBe(202);
  await runCaptures(db, worker);
  const done = await client.get(`/calculation-captures/${r.body.id}`);
  expect(done.status, done.text).toBe(200);
  return done.body;
};

export const runCaptures = async (db: ITestDb, worker: WorkerRuntime): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await drain(worker);
    const pending = await db.pool.query("SELECT 1 FROM job WHERE kind = 'calculation.capture' AND status = 'queued'");
    if ((pending.rowCount ?? 0) === 0) return;
    await db.pool.query("UPDATE job SET run_after = now() WHERE kind = 'calculation.capture' AND status = 'queued'");
  }
  throw new Error('выгрузки не завершились');
};
