// Права (ADR-006, A12, A25): чужой тендер недоступен, подмена роли в запросе не даёт прав руководителя.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, buildScenario, createTestDb, idem, makeApp, TestClient, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  db = await createTestDb();
  app = makeApp(db);
  s = await buildScenario(db, app);
});
afterAll(async () => db.drop());

describe('неаутентифицированный пользователь', () => {
  it('получает 401 на чтение и команды, отказ пишется в журнал', async () => {
    const anon = new TestClient(app);
    for (const path of ['/me', '/tenders', `/tenders/${s.tenderA}`, `/stages/${s.stageA}`, '/admin/users']) {
      const r = await anon.get(path);
      expect(r.status, path).toBe(401);
      expect(r.body.code).toBe('UNAUTHENTICATED');
      expect(r.headers['content-type']).toContain('application/problem+json');
    }
    const w = await anon.patch(`/stages/${s.stageA}`, { title: 'x' }, { headers: { 'If-Match': `"${s.stageA}:1"` } });
    expect(w.status).toBe(401);
    const rows = await auditRows(db.pool, "outcome = 'denied' AND actor_user_id IS NULL AND details->>'code' = 'UNAUTHENTICATED'");
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  it('поддельная cookie сессии не аутентифицирует', async () => {
    const forged = new TestClient(app);
    forged.cookies.set('kkp_session', 'forged-token-value');
    expect((await forged.get('/tenders')).status).toBe(401);
  });
});

describe('чужой тендер (A12)', () => {
  it('не виден в списке', async () => {
    const r = await s.eng3.get('/tenders');
    expect(r.status).toBe(200);
    const ids = r.body.items.map((t: { id: string }) => t.id);
    expect(ids).toContain(s.tenderB);
    expect(ids).not.toContain(s.tenderA);
  });

  it('карточка, этапы, участники, журнал и этап по ID — 404 без раскрытия данных', async () => {
    for (const path of [
      `/tenders/${s.tenderA}`,
      `/tenders/${s.tenderA}/stages`,
      `/tenders/${s.tenderA}/members`,
      `/tenders/${s.tenderA}/audit-events`,
      `/stages/${s.stageA}`,
    ]) {
      const r = await s.eng3.get(path);
      expect(r.status, path).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(r.body)).not.toContain('Тендер A-1');
      expect(JSON.stringify(r.body)).not.toContain('Этап A1');
    }
  });

  it('ответ на чужой ID не отличается от несуществующего', async () => {
    const foreign = await s.eng3.get(`/stages/${s.stageA}`);
    const missing = await s.eng3.get('/stages/00000000-0000-4000-8000-000000000000');
    expect(foreign.status).toBe(missing.status);
    expect({ ...foreign.body, requestId: '' }).toEqual({ ...missing.body, requestId: '' });
  });

  it('изменение и создание в чужом тендере — 404, данные не меняются', async () => {
    const p = await s.eng3.patch(`/stages/${s.stageA}`, { title: 'взлом' }, { headers: { 'If-Match': `"${s.stageA}:1"` } });
    expect(p.status).toBe(404);
    const c = await s.eng3.post(`/tenders/${s.tenderA}/stages`, { title: 'чужой' }, { headers: idem() });
    expect(c.status).toBe(404);
    const own = await s.eng1.get(`/stages/${s.stageA}`);
    expect(own.body.title).toBe('Этап A1');
    const stages = await s.eng1.get(`/tenders/${s.tenderA}/stages`);
    expect(stages.body.items).toHaveLength(1);
    const denied = await auditRows(db.pool, "actor_user_id = $1 AND outcome = 'denied' AND entity_id = $2", [s.ids.eng3, s.stageA]);
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });

  it('снятие с тендера сразу закрывает доступ', async () => {
    const t = await s.admin.get(`/tenders/${s.tenderB}`);
    const r = await s.admin.delete(`/tenders/${s.tenderB}/members/${s.ids.eng3}`, { headers: { 'If-Match': t.headers.etag } });
    expect(r.status).toBe(200);
    expect((await s.eng3.get(`/stages/${s.stageB}`)).status).toBe(404);
    const back = await s.admin.put(`/tenders/${s.tenderB}/members/${s.ids.eng3}`, { memberRole: 'engineer' }, { headers: { 'If-Match': r.headers.etag } });
    expect(back.status).toBe(200);
    expect((await s.eng3.get(`/stages/${s.stageB}`)).status).toBe(200);
  });
});

describe('подмена роли (A25)', () => {
  const spoof = {
    'X-Role': 'manager',
    'X-User-Role': 'manager',
    'X-Capabilities': 'stage.manage,admin.tender',
  };

  it('инженер не создаёт этап (право руководителя) даже с поддельными полями и заголовками', async () => {
    const r = await s.eng1.post(
      `/tenders/${s.tenderA}/stages`,
      { title: 'Этап инженера', role: 'manager', memberRole: 'manager', capabilities: ['stage.manage'] },
      { headers: { ...spoof, ...idem() } },
    );
    // Лишние поля отклоняются схемой только после проверки права: сначала 403.
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    const clean = await s.eng1.post(`/tenders/${s.tenderA}/stages`, { title: 'Этап инженера' }, { headers: { ...spoof, ...idem() } });
    expect(clean.status).toBe(403);
    const stages = await s.eng1.get(`/tenders/${s.tenderA}/stages`);
    expect(stages.body.items.map((x: { title: string }) => x.title)).not.toContain('Этап инженера');
  });

  it('инженер не назначает участников и не меняет себе роли', async () => {
    const t = await s.eng1.get(`/tenders/${s.tenderA}`);
    const assign = await s.eng1.put(`/tenders/${s.tenderA}/members/${s.ids.eng1}`, { memberRole: 'manager' }, { headers: { ...spoof, 'If-Match': t.headers.etag } });
    expect(assign.status).toBe(403);
    const self = await s.eng1.patch(`/admin/users/${s.ids.eng1}`, { roles: ['manager', 'admin'] }, { headers: { ...spoof, 'If-Match': `"${s.ids.eng1}:1"` } });
    expect(self.status).toBe(403);
    const me = await s.eng1.get('/me', { headers: spoof });
    expect(me.body.roles).toEqual(['engineer']);
    expect(me.body.capabilities).toEqual([]);
  });

  it('инженер не читает журнал тендера и администрирование', async () => {
    expect((await s.eng1.get(`/tenders/${s.tenderA}/audit-events`, { headers: spoof })).status).toBe(403);
    expect((await s.eng1.get('/admin/users', { headers: spoof })).status).toBe(403);
    expect((await s.eng1.get('/admin/audit-events', { headers: spoof })).status).toBe(403);
  });

  it('каждый отказ отражён в журнале с автором, объектом и требуемым правом', async () => {
    const rows = await auditRows(db.pool, "actor_user_id = $1 AND outcome = 'denied' AND details->>'code' = 'FORBIDDEN'", [s.ids.eng1]);
    const caps = rows.map((r) => r.details.capability);
    expect(caps).toEqual(expect.arrayContaining(['stage.manage', 'admin.tender', 'admin.users', 'audit.read', 'admin.audit']));
    const stageDenial = rows.find((r) => r.details.capability === 'stage.manage');
    expect(stageDenial?.tender_id).toBe(s.tenderA);
    expect(stageDenial?.entity_id).toBe(s.tenderA);
  });

  it('руководитель тендера создаёт этап — то же действие разрешено по роли', async () => {
    const r = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'Этап руководителя' }, { headers: idem() });
    expect(r.status).toBe(201);
    expect(r.body.seq).toBe(2);
  });
});

describe('администратор без назначения', () => {
  it('видит карточку и участников, но не содержимое тендера', async () => {
    expect((await s.admin.get(`/tenders/${s.tenderA}`)).status).toBe(200);
    expect((await s.admin.get(`/tenders/${s.tenderA}/members`)).status).toBe(200);
    expect((await s.admin.get(`/tenders/${s.tenderA}/stages`)).status).toBe(403);
    expect((await s.admin.get(`/stages/${s.stageA}`)).status).toBe(404);
  });

  it('снятие глобальной роли сразу лишает прав по назначению', async () => {
    const u = await s.admin.get('/admin/users');
    const eng2 = u.body.items.find((x: { login: string }) => x.login === 'eng2');
    const r = await s.admin.patch(`/admin/users/${s.ids.eng2}`, { roles: ['manager'] }, { headers: { 'If-Match': `"${s.ids.eng2}:${eng2.rowVersion}"` } });
    expect(r.status).toBe(200);
    expect((await s.eng2.get(`/stages/${s.stageA}`)).status).toBe(404);
    const back = await s.admin.patch(`/admin/users/${s.ids.eng2}`, { roles: ['engineer'] }, { headers: { 'If-Match': r.headers.etag } });
    expect(back.status).toBe(200);
    expect((await s.eng2.get(`/stages/${s.stageA}`)).status).toBe(200);
  });
});
