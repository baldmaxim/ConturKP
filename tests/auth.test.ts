// Вход, сессии, CSRF/Origin (ADR-006 §11–12).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, Clock, createTestDb, createUser, idem, makeApp, PASSWORD, TestClient, testConfig, type ITestDb } from './helpers.ts';

let db: ITestDb;
let clock: Clock;
let app: ReturnType<typeof makeApp>;
let adminId: string;

beforeAll(async () => {
  db = await createTestDb();
  clock = new Clock();
  app = makeApp(db, clock);
  adminId = await createUser(db.pool, 'boss', ['admin', 'manager'], 'Руководитель');
  await createUser(db.pool, 'worker1', ['engineer']);
});
afterAll(async () => db.drop());

describe('вход', () => {
  it('успешный вход ставит HttpOnly-cookie сессии и читаемую CSRF-cookie с SameSite=Strict', async () => {
    const c = new TestClient(app);
    const r = await c.login('boss');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ login: 'boss', roles: ['admin', 'manager'] });
    const cookies = r.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((x) => x.startsWith('kkp_session='))!;
    const csrf = cookies.find((x) => x.startsWith('kkp_csrf='))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Strict/);
    expect(csrf).not.toMatch(/HttpOnly/);
    expect(csrf).toMatch(/SameSite=Strict/);
    const token = c.cookies.get('kkp_session')!;
    const stored = await db.pool.query('SELECT count(*)::int AS n FROM session WHERE token_hash = $1::bytea', [Buffer.from(token)]);
    expect(stored.rows[0].n).toBe(0); // в БД только хэш
  });

  it('Secure-cookie при TLS', async () => {
    const tlsApp = makeApp(db, clock, testConfig({ tls: { certFile: 'x', keyFile: 'y' }, allowedOrigins: ['https://kontur.local'] }));
    const r = await new TestClient(tlsApp).req('post', '/api/v1/auth/login', { body: { login: 'boss', password: PASSWORD }, origin: 'https://kontur.local' });
    expect(r.status).toBe(200);
    expect((r.headers['set-cookie'] as unknown as string[]).every((x) => /Secure/.test(x))).toBe(true);
    expect(r.headers['strict-transport-security']).toBeDefined();
  });

  it('неверный пароль и несуществующий логин дают одинаковый 401 и запись в журнале', async () => {
    const a = await new TestClient(app).login('boss', 'wrong-password-123');
    const b = await new TestClient(app).login('nobody', 'wrong-password-123');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.detail).toBe(b.body.detail);
    const rows = await auditRows(db.pool, "action = 'auth.login' AND outcome = 'denied'");
    expect(rows.map((r) => r.details.login)).toEqual(expect.arrayContaining(['boss', 'nobody']));
    expect(JSON.stringify(rows)).not.toContain('wrong-password-123');
  });

  it('перебор ограничивается 429', async () => {
    await createUser(db.pool, 'target', ['engineer']);
    const c = new TestClient(app);
    for (let i = 0; i < 5; i += 1) expect((await c.login('target', `bad-password-${i}`)).status).toBe(401);
    expect((await c.login('target')).status).toBe(429);
    clock.advanceMinutes(16);
    expect((await c.login('target')).status).toBe(200);
  });

  it('вход с чужого Origin отклоняется', async () => {
    const r = await new TestClient(app).req('post', '/api/v1/auth/login', { body: { login: 'boss', password: PASSWORD }, origin: 'http://evil.example' });
    expect(r.status).toBe(403);
  });

  it('открытой регистрации нет', async () => {
    const c = new TestClient(app);
    for (const path of ['/auth/register', '/users', '/auth/signup']) {
      expect((await c.post(path, { login: 'new', password: 'x'.repeat(16) })).status).toBe(404);
    }
    const admin = await new TestClient(app).post('/admin/users', { login: 'x', displayName: 'x', roles: ['admin'], password: 'x'.repeat(16) }, { headers: idem() });
    expect(admin.status).toBe(401);
  });
});

describe('CSRF и Origin', () => {
  it('изменяющий запрос без CSRF-токена, с чужим токеном или без Origin — 403', async () => {
    const c = new TestClient(app);
    await c.login('boss');
    const body = { code: 'CSRF-1', title: 'x' };
    expect((await c.post('/tenders', body, { headers: idem(), csrf: false })).status).toBe(403);
    expect((await c.post('/tenders', body, { headers: { ...idem(), 'X-CSRF-Token': 'forged' }, csrf: false })).status).toBe(403);
    expect((await c.post('/tenders', body, { headers: idem(), origin: null })).status).toBe(403);
    expect((await c.post('/tenders', body, { headers: idem(), origin: 'http://evil.example' })).status).toBe(403);
    const ok = await c.post('/tenders', body, { headers: idem() });
    expect(ok.status).toBe(201);
    const rows = await auditRows(db.pool, "actor_user_id = $1 AND outcome = 'denied' AND details->>'check' IN ('csrf', 'origin')", [adminId]);
    expect(rows.length).toBe(4);
  });

  it('CSRF-токен одной сессии не подходит к другой', async () => {
    const a = new TestClient(app);
    const b = new TestClient(app);
    await a.login('boss');
    await b.login('boss');
    const r = await a.post('/tenders', { code: 'CSRF-2', title: 'x' }, { headers: { ...idem(), 'X-CSRF-Token': b.cookies.get('kkp_csrf')! }, csrf: false });
    expect(r.status).toBe(403);
  });
});

describe('жизненный цикл сессии', () => {
  it('выход отзывает сессию', async () => {
    const c = new TestClient(app);
    await c.login('worker1');
    const token = c.cookies.get('kkp_session')!;
    expect((await c.post('/auth/logout')).status).toBe(204);
    expect(c.cookies.has('kkp_session')).toBe(false);
    c.cookies.set('kkp_session', token);
    expect((await c.get('/me')).status).toBe(401);
  });

  it('сессия истекает по неактивности и по абсолютному сроку', async () => {
    const idle = new TestClient(app);
    await idle.login('worker1');
    clock.advanceMinutes(29);
    expect((await idle.get('/me')).status).toBe(200);
    clock.advanceMinutes(29);
    expect((await idle.get('/me')).status).toBe(200); // активность продлевает
    clock.advanceMinutes(31);
    expect((await idle.get('/me')).status).toBe(401);

    const abs = new TestClient(app);
    await abs.login('worker1');
    for (let i = 0; i < 50; i += 1) {
      clock.advanceMinutes(29);
      await abs.get('/me');
    }
    expect((await abs.get('/me')).status).toBe(401); // 24 ч абсолютного срока прошли
  });

  it('отключение пользователя и сброс пароля отзывают его сессии', async () => {
    const id = await createUser(db.pool, 'temp', ['engineer']);
    const admin = new TestClient(app);
    await admin.login('boss');
    const user = new TestClient(app);
    await user.login('temp');
    expect((await user.get('/me')).status).toBe(200);
    const dis = await admin.patch(`/admin/users/${id}`, { status: 'disabled' }, { headers: { 'If-Match': `"${id}:1"` } });
    expect(dis.status).toBe(200);
    expect((await user.get('/me')).status).toBe(401);
    expect((await user.login('temp')).status).toBe(401);
    const en = await admin.patch(`/admin/users/${id}`, { status: 'active' }, { headers: { 'If-Match': dis.headers.etag } });
    expect((await user.login('temp')).status).toBe(200);
    const reset = await admin.post(`/admin/users/${id}/password`, { password: 'new-password-12345' }, { headers: { 'If-Match': en.headers.etag } });
    expect(reset.status).toBe(200);
    expect((await user.get('/me')).status).toBe(401);
    expect((await user.login('temp', 'new-password-12345')).status).toBe(200);
  });

  it('смена своего пароля требует текущий и отзывает другие сессии', async () => {
    await createUser(db.pool, 'changer', ['engineer']);
    const a = new TestClient(app);
    const b = new TestClient(app);
    await a.login('changer');
    await b.login('changer');
    expect((await a.post('/me/password', { currentPassword: 'wrong-current-1', newPassword: 'another-password-1' })).status).toBe(403);
    expect((await a.post('/me/password', { currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await a.post('/me/password', { currentPassword: PASSWORD, newPassword: 'another-password-1' })).status).toBe(204);
    expect((await a.get('/me')).status).toBe(200);
    expect((await b.get('/me')).status).toBe(401);
  });

  it('нельзя снять последнего администратора', async () => {
    const admin = new TestClient(app);
    await admin.login('boss');
    const me = await admin.get('/admin/users');
    const boss = me.body.items.find((u: { login: string }) => u.login === 'boss');
    const r = await admin.patch(`/admin/users/${adminId}`, { roles: ['manager'] }, { headers: { 'If-Match': `"${adminId}:${boss.rowVersion}"` } });
    expect(r.status).toBe(409);
  });
});
