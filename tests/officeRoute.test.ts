// «Офис» в администрировании: GET /admin/office — только admin.audit; задания по тендерам без содержимого-доступа
// не раскрывают ни идентификатор, ни название; текст ошибки задания в ответ не попадает.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { officeSnapshot } from '../packages/db/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { buildScenario, Clock, createTestDb, createUser, idem, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
let chief: TestClient;
let tenderC = '';
const config = testConfig();
const SECRET_TEXT = 'office-secret-message-a51';

const insertJob = async (kind: string, status: 'queued' | 'running' | 'failed' | 'succeeded', o: { tenderId?: string | null; code?: string; finishedAgo?: string } = {}): Promise<void> => {
  await db.pool.query(
    `INSERT INTO job (kind, status, tender_id, lease_token, locked_by, locked_until, last_error_code, last_error_message, finished_at)
     VALUES ($1, $2, $3, CASE WHEN $2 = 'running' THEN gen_random_uuid() END, CASE WHEN $2 = 'running' THEN 'office-test' END,
             CASE WHEN $2 = 'running' THEN now() + interval '1 hour' END, $4, $5, CASE WHEN $2 IN ('failed', 'succeeded') THEN now() - $6::interval END)`,
    [kind, status, o.tenderId ?? null, o.code ?? null, o.code ? SECRET_TEXT : null, o.finishedAgo ?? '0 seconds'],
  );
};

beforeAll(async () => {
  db = await createTestDb();
  const app = createApp({ config, pool: db.pool, clock: new Clock().read, logError: () => undefined });
  s = await buildScenario(db, app);
  // Администратор с ролью руководителя, назначенный на третий тендер: его содержимое он видит, тендеры A и B — нет.
  const chiefId = await createUser(db.pool, 'chief', ['admin', 'manager'], 'Админ-руководитель');
  const created = await s.admin.post('/tenders', { code: 'C-1', title: 'Видимый тендер C' }, { headers: idem() });
  expect(created.status, created.text).toBe(201);
  tenderC = created.body.id as string;
  const member = await s.admin.put(`/tenders/${tenderC}/members/${chiefId}`, { memberRole: 'manager' }, { headers: { 'If-Match': created.headers.etag as string } });
  expect(member.status, member.text).toBe(200);
  chief = new TestClient(app);
  expect((await chief.login('chief')).status).toBe(200);

  await insertJob('review.run', 'queued', { tenderId: s.tenderA });
  await insertJob('review.run', 'queued', { tenderId: s.tenderA });
  await insertJob('recognition.import', 'running', { tenderId: tenderC });
  await insertJob('delivery.place', 'failed', { tenderId: s.tenderA, code: 'E_HIDDEN', finishedAgo: '5 minutes' });
  await insertJob('delivery.place', 'failed', { tenderId: tenderC, code: 'E_VISIBLE', finishedAgo: '1 minute' });
  await insertJob('delivery.place', 'failed', { tenderId: tenderC, code: 'E_OLD', finishedAgo: '30 hours' });
  await insertJob('index.build', 'queued');
  await insertJob('index.build', 'succeeded', { tenderId: tenderC, finishedAgo: '1 minute' });
  await db.pool.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ('office-fresh', 'worker', 1, now(), now()), ('office-stale', 'worker', 2, now(), now() - interval '10 minutes')");
});
afterAll(async () => {
  await db.drop();
});

type Item = { kind: string; status: string; tenderId: string | null; hidden: boolean; count: number; lastErrorCode: string | null; lastFailedAt: string | null };

describe('GET /admin/office', () => {
  it('инженер и руководитель без admin.audit — 403, аноним — 401', async () => {
    expect((await s.eng1.get('/admin/office')).status).toBe(403);
    expect((await s.manager.get('/admin/office')).status).toBe(403);
    expect((await new TestClient(createApp({ config, pool: db.pool, clock: new Clock().read, logError: () => undefined })).get('/admin/office')).status).toBe(401);
  });

  it('администратор: 200, группы по заданиям, сводка по workers', async () => {
    const res = await s.admin.get('/admin/office');
    expect(res.status, res.text).toBe(200);
    expect(Date.parse(res.body.at as string)).not.toBeNaN();
    expect(res.body.workersAlive).toBe(1);
    const items = res.body.items as Item[];
    // Успешное и старше суток в очередь офиса не входят.
    expect(items.some((i) => i.status === 'succeeded' || i.lastErrorCode === 'E_OLD')).toBe(false);
    expect(items.find((i) => i.kind === 'review.run' && i.status === 'queued')).toMatchObject({ count: 2, tenderId: null, hidden: true });
    expect(items.find((i) => i.kind === 'index.build')).toMatchObject({ status: 'queued', count: 1, tenderId: null, hidden: false });
    // Два отказа за сутки по закрытым для него тендерам A и C слились в одну группу; код — последнего по времени.
    const failedHidden = items.find((i) => i.kind === 'delivery.place' && i.hidden);
    expect(failedHidden).toMatchObject({ status: 'failed', count: 2, tenderId: null, lastErrorCode: 'E_VISIBLE' });
    expect(Date.parse(failedHidden!.lastFailedAt!)).not.toBeNaN();
  });

  it('администратор без доступа к содержимому не видит ни id, ни названия тендеров; текста ошибки нет ни у кого', async () => {
    for (const client of [s.admin, chief]) {
      const res = await client.get('/admin/office');
      expect(res.status, res.text).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(s.tenderA);
      expect(raw).not.toContain(s.tenderB);
      expect(raw).not.toContain('Тендер A-1');
      expect(raw).not.toContain(SECRET_TEXT);
      expect(raw).not.toMatch(/error_?message/iu);
      expect(Object.keys((res.body.items as Item[])[0]!).sort()).toEqual(['count', 'hidden', 'kind', 'lastErrorCode', 'lastFailedAt', 'status', 'tenderId']);
    }
    const adminRes = await s.admin.get('/admin/office');
    expect(adminRes.body.tenders).toEqual([]);
    expect((adminRes.body.items as Item[]).filter((i) => i.tenderId !== null)).toEqual([]);
  });

  it('с доступом к содержимому тендер виден по id и названию, чужой остаётся закрытым', async () => {
    const res = await chief.get('/admin/office');
    expect(res.status, res.text).toBe(200);
    expect(res.body.tenders).toEqual([{ id: tenderC, title: 'Видимый тендер C' }]);
    const items = res.body.items as Item[];
    expect(items.find((i) => i.kind === 'recognition.import')).toMatchObject({ status: 'running', tenderId: tenderC, hidden: false });
    expect(items.find((i) => i.kind === 'delivery.place' && !i.hidden)).toMatchObject({ status: 'failed', tenderId: tenderC, lastErrorCode: 'E_VISIBLE' });
    expect(items.find((i) => i.kind === 'delivery.place' && i.hidden)).toMatchObject({ tenderId: null, lastErrorCode: 'E_HIDDEN' });
  });

  it('снимок: пустой список видимых тендеров закрывает все тендеры', async () => {
    const snap = await officeSnapshot(db.pool, []);
    expect(snap.tenders).toEqual([]);
    expect(snap.items.filter((i) => i.tenderId !== null)).toEqual([]);
    expect(snap.items.filter((i) => i.hidden).reduce((n, i) => n + i.count, 0)).toBe(5);
  });
});
