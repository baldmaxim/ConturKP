import { restrictManagerPermissions } from './roleFixtures.ts';
// «Офис» в администрировании: GET /admin/office — по office.read; задания по тендерам без содержимого-доступа
// не раскрывают ни идентификатор, ни название; текст ошибки задания в ответ не попадает.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failRun, officeSnapshot, officeDiagnostics } from '../packages/db/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { buildScenario, Clock, createTestDb, createUser, idem, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { completeLocalRun, descriptorOf, insertLocalRun, newRevision, startRunSql } from './localRecognitionFixtures.ts';

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
  // Руководитель с ограниченным общим просмотром: видит назначенный C, но не A/B.
  const chiefId = await createUser(db.pool, 'chief', ['admin', 'manager'], 'Админ-руководитель');
  await restrictManagerPermissions(s.admin, chiefId, ['tender.read.all']);
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
  it('текущие задачи и прогресс не раскрывают закрытый тендер', async () => {
    await db.pool.query(`UPDATE job SET progress='{"phase":"processing","completed":3,"total":10,"unit":"pages"}'::jsonb WHERE status='running'`);
    const hidden=await s.admin.get('/admin/office'),visible=await chief.get('/admin/office');
    expect(hidden.body.tasks).toContainEqual({id:null,kind:'recognition.import',tenderId:null,hidden:true,count:1,progress:null});
    expect(visible.body.tasks).toContainEqual(expect.objectContaining({kind:'recognition.import',tenderId:tenderC,hidden:false,progress:expect.objectContaining({completed:3,total:10})}));
  });
  it('инженер без office.read — 403, руководитель — 200, аноним — 401', async () => {
    expect((await s.eng1.get('/admin/office')).status).toBe(403);
    expect((await s.manager.get('/admin/office')).status).toBe(200);
    expect((await s.manager.get('/admin/operations')).status).toBe(403);
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

  it('успешный повтор снимает тревогу только того же задания; новая ошибка остаётся', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO job(kind,dedupe_key,status,last_error_code,finished_at) VALUES
        ('mailhub.fetch','office-retry','failed','E_RECOVERED',now()-interval '10 minutes'),
        ('mailhub.fetch','office-retry','succeeded',NULL,now()-interval '5 minutes'),
        ('mailhub.fetch','office-retry','failed','E_NEW',now()-interval '1 minute'),
        ('mailhub.fetch','office-unrelated','failed','E_UNRELATED',now()-interval '8 minutes')`);
      const failed = (await officeSnapshot(client, [])).items.filter((item) => item.kind === 'mailhub.fetch' && item.status === 'failed');
      expect(failed).toEqual([expect.objectContaining({ count: 2, lastErrorCode: 'E_NEW' })]);
      expect((await client.query("SELECT count(*)::int AS n FROM job WHERE last_error_code='E_RECOVERED'")).rows[0].n).toBe(1);
    } finally { await client.query('ROLLBACK');client.release(); }
  });

  it('успешный новый распознаватель снимает тревогу прежнего прогона той же редакции', async () => {
    const revision = await newRevision(db.pool, { tenderId: s.tenderA, format: 'xlsx', userId: s.ids.eng1 });
    const failedRun = await insertLocalRun(db.pool, revision.revisionId, descriptorOf('xlsx'), s.ids.eng1);
    await startRunSql(db.pool, failedRun);await failRun(db.pool, failedRun, 'too_large', 'лимит ячеек');
    await db.pool.query(`INSERT INTO job(kind,payload,status,last_error_code,finished_at)
      VALUES('recognition.local',$1::jsonb,'failed','too_large',clock_timestamp())`, [JSON.stringify({ runId: failedRun })]);
    expect((await officeSnapshot(db.pool, [])).items.some((item) => item.kind === 'recognition.local' && item.status === 'failed')).toBe(true);
    const recovered = await insertLocalRun(db.pool, revision.revisionId, descriptorOf('xlsx', { config: { parser: 'xlsx', parserVersion: 2 } }), s.ids.eng1);
    await completeLocalRun(db.pool, recovered, [{ kind: 'xlsx_sheet' }], ['Работы 120']);
    expect((await officeSnapshot(db.pool, [])).items.some((item) => item.kind === 'recognition.local' && item.status === 'failed')).toBe(false);
    expect((await db.pool.query('SELECT status FROM recognition_run WHERE id=$1', [failedRun])).rows[0].status).toBe('failed');
  });

  it('сводка не повторяет сканирование большой истории для каждого отказа', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO job(kind,dedupe_key,status,finished_at)
        SELECT 'office.load','office-load:'||n,'succeeded',now()-interval '5 minutes' FROM generate_series(1,120000) n`);
      await client.query(`INSERT INTO job(kind,dedupe_key,status,last_error_code,finished_at)
        SELECT 'office.load',CASE WHEN n%2=1 THEN 'office-load:'||n ELSE 'office-missing:'||n END,
               'failed','E_LOAD',now()-interval '10 minutes' FROM generate_series(1,2000) n`);
      // Временной запас существенно больше измеренного на рабочей базе; старый запрос
      // сканировал всю историю по каждому отказу и не укладывался даже в тайм-аут интерфейса.
      await client.query("SET LOCAL statement_timeout='5s'");
      const snap = await officeSnapshot(client, []);
      expect(snap.items.find((item) => item.kind === 'office.load')).toMatchObject({ status: 'failed', count: 1000, lastErrorCode: 'E_LOAD' });
      const diagnostics = await officeDiagnostics(client, [], ['office.load']);
      expect(diagnostics).toMatchObject({ total: 1000, hidden: 0, limit: 50, truncated: true });
      expect(diagnostics.entries).toHaveLength(50);
      expect((await client.query("SELECT count(*)::int AS n FROM job WHERE kind='office.load'")).rows[0].n).toBe(122000);
    } finally { await client.query('ROLLBACK');client.release(); }
  }, 30_000);
});

describe('диагностика «Офиса» по запросу', () => {
  it('сохраняет ограничения доступа и проверяет фильтр', async () => {
    expect((await s.eng1.get('/admin/office/diagnostics')).status).toBe(403);
    expect((await new TestClient(createApp({ config, pool: db.pool, clock: new Clock().read, logError: () => undefined })).get('/admin/office/diagnostics')).status).toBe(401);
    for (const query of ['kinds=', 'kinds=bad%0Akind', 'kinds[]=review.run', `kinds=${Array.from({ length: 21 }, (_, i) => `kind.${i}`).join(',')}`]) expect((await chief.get(`/admin/office/diagnostics?${query}`)).status).toBe(400);
  });
  it('отдаёт подробности только доступных отказов без текста ошибки и payload', async () => {
    const res = await chief.get('/admin/office/diagnostics?kinds=delivery.place');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ total: 2, hidden: 1, limit: 50, truncated: false });
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ tenderId: tenderC, kind: 'delivery.place', errorCode: 'E_VISIBLE' });
    expect(Object.keys(res.body.entries[0]).sort()).toEqual(['attempts', 'errorCode', 'failedAt', 'jobId', 'kind', 'maxAttempts', 'tenderId']);
    const hiddenIds = (await db.pool.query("SELECT id FROM job WHERE kind='delivery.place' AND tender_id=$1", [s.tenderA])).rows.map((row) => row.id as string);
    for (const secret of [SECRET_TEXT, s.tenderA, s.tenderB, ...hiddenIds]) expect(res.text).not.toContain(secret);
    const admin = await s.admin.get('/admin/office/diagnostics?kinds=delivery.place');
    expect(admin.body).toMatchObject({ total: 2, hidden: 2, entries: [] });
    expect((await chief.get('/admin/office/diagnostics?kinds=no.such.kind')).body).toMatchObject({ total: 0, entries: [] });
  });
});
