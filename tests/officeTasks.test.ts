import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../apps/server/src/app.ts';
import { buildScenario, Clock, createTestDb, createUser, idem, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb, s: IScenario, chief: TestClient, anonymous: TestClient;
let tender = '', visibleJob = '', hiddenJob = '', sharedJob = '', failedJob = '', doneJob = '', expiredJob = '';
const secret = 'private-office-payload-and-message-20261026';
const insert = async (kind: string, status: string, tenderId: string | null = null, expired = false): Promise<string> => {
  const row = (await db.pool.query(`INSERT INTO job(kind,status,tender_id,payload,lease_token,locked_until,last_error_code,last_error_message,finished_at,progress,run_after)
    VALUES($1,$2,$3,$4::jsonb,CASE WHEN $2='running' THEN gen_random_uuid() END,
      CASE WHEN $2='running' THEN now()+$5::interval END,CASE WHEN $2='failed' THEN 'OFFICE_TEST_ERROR' END,
      CASE WHEN $2='failed' THEN $6 END,CASE WHEN $2 IN('failed','succeeded','cancelled') THEN now() END,
      CASE WHEN $2='running' THEN '{"phase":"processing","completed":4,"total":10,"unit":"files"}'::jsonb END,now()+interval '5 minutes') RETURNING id`,
    [kind, status, tenderId, JSON.stringify({ secret }), expired ? '-1 minute' : '1 hour', secret])).rows[0];
  return row.id;
};

beforeAll(async () => {
  db = await createTestDb();
  const app = createApp({ config: testConfig(), pool: db.pool, clock: new Clock().read, logError: () => undefined });
  s = await buildScenario(db, app);anonymous = new TestClient(app);
  const chiefId = await createUser(db.pool, 'office-detail-chief', ['admin', 'engineer'], 'Доступ к задачам');
  const created = await s.admin.post('/tenders', { code: 'OFFICE-DETAIL', title: 'Разрешённый тендер' }, { headers: idem() });
  expect(created.status).toBe(201);tender = created.body.id;
  const member = await s.admin.put(`/tenders/${tender}/members/${chiefId}`, { memberRole: 'engineer' }, { headers: { 'If-Match': created.headers.etag as string } });
  expect(member.status).toBe(200);
  chief = new TestClient(app);expect((await chief.login('office-detail-chief')).status).toBe(200);
  visibleJob = await insert('history.verify', 'running', tender);
  hiddenJob = await insert('history.verify', 'running', s.tenderA);
  sharedJob = await insert('history.scan', 'queued');
  failedJob = await insert('history.verify', 'failed', tender);
  doneJob = await insert('history.verify', 'succeeded', tender);
  expiredJob = await insert('history.verify', 'running', tender, true);
});
afterAll(async () => { await db.drop(); });

describe('подробности задач офиса', () => {
  it('требует admin.audit для списка и каждой отдельной задачи', async () => {
    for (const path of ['/admin/office/tasks', `/admin/office/tasks/${sharedJob}`]) {
      expect((await anonymous.get(path)).status).toBe(401);
      expect((await s.eng1.get(path)).status).toBe(403);
    }
  });

  it('возвращает текущие этапы, прогресс и сроки очереди без полезной нагрузки', async () => {
    const response = await chief.get('/admin/office/tasks?kinds=history.verify,history.scan');
    expect(response.status, response.text).toBe(200);
    const rows = response.body.items;
    expect(rows.find((j: { id: string }) => j.id === visibleJob)).toMatchObject({ kind: 'history.verify', tenderId: tender, tenderTitle: 'Разрешённый тендер', progress: { completed: 4, total: 10 } });
    expect(rows.find((j: { id: string }) => j.id === sharedJob).nextCheckAt).toBeTruthy();
    expect(rows.find((j: { id: string }) => j.id === failedJob).errorCode).toBe('OFFICE_TEST_ERROR');
    expect(rows.some((j: { id: string }) => j.id === doneJob)).toBe(false);
    expect(response.body.counts.succeeded).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(JSON.stringify(response.body)).not.toMatch(/payload|last_error_message|locked_by|lease_token/);
    expect(rows[0].status).toBe('running');
  });

  it('не раскрывает закрытые тендеры и индивидуальные задания', async () => {
    const list = await chief.get('/admin/office/tasks?kinds=history.verify');
    expect(list.body.hidden).toBe(1);
    expect(JSON.stringify(list.body)).not.toContain(hiddenJob);
    expect(JSON.stringify(list.body)).not.toContain(s.tenderA);
    expect((await chief.get(`/admin/office/tasks/${hiddenJob}`)).status).toBe(404);
    expect((await chief.get(`/admin/office/tasks?tender=${s.tenderA}`)).status).toBe(404);
    const hidden = await chief.get('/admin/office/tasks?tender=hidden&kinds=history.verify');
    expect(hidden.status).toBe(200);expect(hidden.body.items).toEqual([]);expect(hidden.body.hidden).toBe(1);
  });

  it('применяет выбор тендера, вида и состояния к одному и тому же списку', async () => {
    const response = await chief.get(`/admin/office/tasks?tender=${tender}&kinds=history.verify&status=failed`);
    expect(response.status, response.text).toBe(200);
    expect(response.body.total).toBe(1);expect(response.body.items[0].id).toBe(failedJob);
    const general = await s.admin.get('/admin/office/tasks?tender=none&kinds=history.scan');
    expect(general.body.items.map((j: { id: string }) => j.id)).toContain(sharedJob);
    expect(general.body.hidden).toBe(0);
  });

  it('позволяет провалиться в завершённую задачу и не выдаёт просроченный прогресс за актуальный', async () => {
    const completed = await chief.get('/admin/office/tasks?status=succeeded&kinds=history.verify');
    expect(completed.body.items.map((j: { id: string }) => j.id)).toContain(doneJob);
    const detail = await chief.get(`/admin/office/tasks/${visibleJob}`);
    expect(detail.status).toBe(200);expect(detail.body.task.progress).toMatchObject({ phase: 'processing', completed: 4 });
    expect(detail.body.task.createdAt).toEqual(expect.any(String));
    expect((await chief.get(`/admin/office/tasks/${expiredJob}`)).body.task.progress).toBeNull();
    expect((await chief.get('/admin/office/tasks/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('делит длинный список на страницы без потери заданий', async () => {
    await db.pool.query("INSERT INTO job(kind,status) SELECT 'office.pagination','queued' FROM generate_series(1,55)");
    const first = await chief.get('/admin/office/tasks?kinds=office.pagination');
    const second = await chief.get('/admin/office/tasks?kinds=office.pagination&offset=50');
    expect(first.body.total).toBe(55);expect(first.body.items).toHaveLength(50);expect(first.body.hasMore).toBe(true);
    expect(second.body.items).toHaveLength(5);expect(second.body.hasMore).toBe(false);
    expect(new Set([...first.body.items, ...second.body.items].map((j: { id: string }) => j.id)).size).toBe(55);
  });

  it.each(['kinds=', 'kinds[]=history.scan', 'tender=invalid', 'status=invalid', 'status=queued&status=failed', 'offset=-1', 'offset=1.5', 'payload=1'])('отклоняет некорректный фильтр %s', async query => {
    expect((await chief.get(`/admin/office/tasks?${query}`)).status).toBe(400);
  });
});
