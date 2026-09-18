// Регрессии по ревью 02-1 (docs/reviews/02-review-1.md): R02-01…R02-04.
import argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_AUDIT_ACTIONS, hashPassword, needsRehash, verifyPassword } from '../packages/core/src/index.ts';
import { auditRows, buildScenario, createTestDb, createUser, idem, makeApp, TestClient, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let app: ReturnType<typeof makeApp>;
let s: IScenario;

beforeAll(async () => {
  db = await createTestDb();
  app = makeApp(db);
  s = await buildScenario(db, app);
});
afterAll(async () => db.drop());

const userEtag = async (admin: TestClient, id: string): Promise<string> => {
  const list = await admin.get('/admin/users');
  const u = list.body.items.find((x: { id: string }) => x.id === id);
  return `"${id}:${u.rowVersion}"`;
};

describe('R02-01: повтор по ключу идемпотентности не обходит отзыв доступа', () => {
  it('после снятия назначения повтор создания этапа — 404 без сохранённых данных, отказ в журнале', async () => {
    const mgrId = await createUser(db.pool, 'mgr.replay', ['manager']);
    const mgr = new TestClient(app);
    await mgr.login('mgr.replay');
    const t = await s.admin.get(`/tenders/${s.tenderB}`);
    const add = await s.admin.put(`/tenders/${s.tenderB}/members/${mgrId}`, { memberRole: 'manager' }, { headers: { 'If-Match': t.headers.etag } });
    // руководитель на тендере уже есть — назначаем второго руководителя тендера
    expect(add.status).toBe(200);

    const headers = idem();
    const body = { title: 'Закрытый этап для повтора' };
    const created = await mgr.post(`/tenders/${s.tenderB}/stages`, body, { headers });
    expect(created.status).toBe(201);
    const removed = await s.admin.delete(`/tenders/${s.tenderB}/members/${mgrId}`, { headers: { 'If-Match': add.headers.etag } });
    expect(removed.status).toBe(200);
    expect((await mgr.get(`/stages/${created.body.id}`)).status).toBe(404);

    const replay = await mgr.post(`/tenders/${s.tenderB}/stages`, body, { headers });
    expect(replay.status).toBe(404);
    expect(replay.headers['idempotent-replayed']).toBeUndefined();
    expect(JSON.stringify(replay.body)).not.toContain('Закрытый этап для повтора');
    const denied = await auditRows(db.pool, "actor_user_id = $1 AND action = 'stage.create' AND outcome = 'denied'", [mgrId]);
    expect(denied).toHaveLength(1);
  });

  it('после снятия глобальной роли повтор — 404', async () => {
    const mgrId = await createUser(db.pool, 'mgr.role', ['manager']);
    const mgr = new TestClient(app);
    await mgr.login('mgr.role');
    const t = await s.admin.get(`/tenders/${s.tenderA}`);
    expect((await s.admin.put(`/tenders/${s.tenderA}/members/${mgrId}`, { memberRole: 'manager' }, { headers: { 'If-Match': t.headers.etag } })).status).toBe(200);
    const headers = idem();
    const body = { title: 'Этап до снятия роли' };
    expect((await mgr.post(`/tenders/${s.tenderA}/stages`, body, { headers })).status).toBe(201);
    const r = await s.admin.patch(`/admin/users/${mgrId}`, { roles: ['engineer'] }, { headers: { 'If-Match': await userEtag(s.admin, mgrId) } });
    expect(r.status).toBe(200);
    const replay = await mgr.post(`/tenders/${s.tenderA}/stages`, body, { headers });
    expect(replay.status).toBe(404);
    expect(JSON.stringify(replay.body)).not.toContain('Этап до снятия роли');
  });

  it('администратор без роли admin не получает повтор создания пользователя — 403', async () => {
    const a2 = await createUser(db.pool, 'admin.replay', ['admin']);
    const c = new TestClient(app);
    await c.login('admin.replay');
    const headers = idem();
    const body = { login: 'created.by.replay', displayName: 'Созданный', roles: ['engineer'], password: 'synthetic-password-1' };
    expect((await c.post('/admin/users', body, { headers })).status).toBe(201);
    expect((await s.admin.patch(`/admin/users/${a2}`, { roles: ['manager'] }, { headers: { 'If-Match': await userEtag(s.admin, a2) } })).status).toBe(200);
    const replay = await c.post('/admin/users', body, { headers });
    expect(replay.status).toBe(403);
    expect(JSON.stringify(replay.body)).not.toContain('created.by.replay');
  });

  it('при сохранённых правах повтор по-прежнему возвращает исходный результат', async () => {
    const headers = idem();
    const a = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'Повтор с правами' }, { headers });
    const b = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'Повтор с правами' }, { headers });
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
  });
});

describe('R02-02: журнал тендера не раскрывает содержимое этапов администратору без назначения', () => {
  it('администратор видит только административные события; руководитель — все', async () => {
    const read = await s.eng1.get(`/stages/${s.stageA}`);
    const upd = await s.eng1.patch(
      `/stages/${s.stageA}`,
      { title: 'Секретное новое название', submissionDeadline: '2026-11-01T09:00:00Z' },
      { headers: { 'If-Match': read.headers.etag } },
    );
    expect(upd.status).toBe(200);
    expect((await s.admin.get(`/stages/${s.stageA}`)).status).toBe(404);

    const all: { action: string }[] = [];
    let cursor: string | null = null;
    do {
      const page = await s.admin.get(`/tenders/${s.tenderA}/audit-events?limit=50${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      all.push(...page.body.items);
      cursor = page.body.nextCursor;
    } while (cursor);
    const text = JSON.stringify(all);
    expect(text).not.toContain('Этап A1');
    expect(text).not.toContain('Секретное новое название');
    expect(text).not.toContain('2026-11-01');
    expect(all.every((e) => ADMIN_AUDIT_ACTIONS.includes(e.action))).toBe(true);
    expect(all.map((e) => e.action)).toContain('tender.member.assign');

    const mgr = await s.manager.get(`/tenders/${s.tenderA}/audit-events?limit=200`);
    const actions = mgr.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['stage.create', 'stage.update']));
    expect(JSON.stringify(mgr.body)).toContain('Секретное новое название');
  });

  it('администратор, назначенный руководителем тендера, видит полный журнал', async () => {
    const owner = await createUser(db.pool, 'owner.mgr', ['admin', 'manager']);
    const c = new TestClient(app);
    await c.login('owner.mgr');
    const t = await s.admin.get(`/tenders/${s.tenderA}`);
    expect((await s.admin.put(`/tenders/${s.tenderA}/members/${owner}`, { memberRole: 'manager' }, { headers: { 'If-Match': t.headers.etag } })).status).toBe(200);
    const r = await c.get(`/tenders/${s.tenderA}/audit-events?limit=200`);
    expect(r.body.items.map((e: { action: string }) => e.action)).toContain('stage.update');
  });
});

describe('R02-03: параллельное снятие ролей не оставляет ноль администраторов', () => {
  const activeAdmins = async (): Promise<number> =>
    (
      await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM app_user u JOIN user_role r ON r.user_id = u.id WHERE r.role = 'admin' AND u.status = 'active'",
      )
    ).rows[0]!.n;

  const race = async (a: () => Promise<{ status: number }>, b: () => Promise<{ status: number }>): Promise<number[]> => {
    // Держим блокировку набора администраторов, пока оба запроса не встанут в ожидание,
    // затем отпускаем: запросы выполняются строго друг за другом.
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('kontur_kp_admin_set'))");
    const pending = Promise.all([a(), b()]);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      waiting = (await holder.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0]!.n;
    }
    expect(waiting).toBe(2);
    await holder.query('COMMIT');
    await holder.end();
    return (await pending).map((r) => r.status).sort();
  };

  it('два администратора снимают роль друг у друга: один запрос — 409, администратор остаётся', async () => {
    // В этой базе администраторы: admin, admin.replay (роль снята), owner.mgr. Приводим к двум.
    const a1 = await createUser(db.pool, 'race.a1', ['admin']);
    const a2 = await createUser(db.pool, 'race.a2', ['admin']);
    for (const login of ['owner.mgr', 'admin']) {
      const id = (await db.pool.query<{ id: string }>('SELECT id FROM app_user WHERE login = $1', [login])).rows[0]!.id;
      const c = new TestClient(app);
      await c.login('race.a1');
      expect((await c.patch(`/admin/users/${id}`, { roles: login === 'admin' ? ['manager'] : ['manager'] }, { headers: { 'If-Match': await userEtag(c, id) } })).status).toBe(200);
    }
    expect(await activeAdmins()).toBe(2);
    const c1 = new TestClient(app);
    const c2 = new TestClient(app);
    await c1.login('race.a1');
    await c2.login('race.a2');
    const e1 = await userEtag(c1, a2);
    const e2 = await userEtag(c2, a1);
    const statuses = await race(
      () => c1.patch(`/admin/users/${a2}`, { roles: ['manager'] }, { headers: { 'If-Match': e1 } }),
      () => c2.patch(`/admin/users/${a1}`, { status: 'disabled' }, { headers: { 'If-Match': e2 } }),
    );
    expect(statuses).toEqual([200, 409]);
    expect(await activeAdmins()).toBe(1);
  });
});

describe('R02-04: формат хэшей совместим с пакетом argon2 в обе стороны', () => {
  it('хэш портала проверяется пакетом argon2, в том числе с символами + и /', async () => {
    let sawStdAlphabet = false;
    for (let i = 0; i < 12; i += 1) {
      const password = `synthetic-password-${i}`;
      const h = await hashPassword(password);
      expect(h).not.toMatch(/[-_](?=[^$]*$)/);
      if (/[+/]/.test(h.split('$').slice(-2).join(''))) sawStdAlphabet = true;
      expect(await argon2.verify(h, password)).toBe(true);
      expect(await argon2.verify(h, 'wrong-password')).toBe(false);
      expect(needsRehash(h)).toBe(false);
    }
    expect(sawStdAlphabet).toBe(true);
  });

  it('хэш пакета argon2 (другой порядок параметров) проверяется порталом', async () => {
    const h1 = await argon2.hash('synthetic-password-a', { type: argon2.argon2id });
    const h2 = await argon2.hash('synthetic-password-b', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    expect(await verifyPassword('synthetic-password-a', h1)).toBe(true);
    expect(await verifyPassword('synthetic-password-b', h2)).toBe(true);
    expect(await verifyPassword('wrong', h2)).toBe(false);
    expect(needsRehash(h1)).toBe(true); // другие параметры
  });

  it('прежний base64url-хэш проверяется и переписывается при входе без смены версии строки', async () => {
    let legacy = '';
    for (let i = 0; i < 30 && !/[-_]/.test(legacy.split('$').slice(-2).join('')); i += 1) {
      legacy = (await hashPassword('correct-horse-battery')).replace(/\+/g, '-').replace(/\//g, '_');
    }
    expect(legacy.split('$').slice(-2).join('')).toMatch(/[-_]/);
    expect(await verifyPassword('correct-horse-battery', legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);

    const id = await createUser(db.pool, 'legacy.hash', ['engineer']);
    await db.pool.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [id, legacy]);
    const before = (await db.pool.query<{ row_version: number }>('SELECT row_version FROM app_user WHERE id = $1', [id])).rows[0]!.row_version;
    expect((await new TestClient(app).login('legacy.hash')).status).toBe(200);
    const after = (await db.pool.query<{ password_hash: string; row_version: number }>('SELECT password_hash, row_version FROM app_user WHERE id = $1', [id])).rows[0]!;
    expect(after.password_hash).not.toBe(legacy);
    expect(needsRehash(after.password_hash)).toBe(false);
    expect(await argon2.verify(after.password_hash, 'correct-horse-battery')).toBe(true);
    expect(after.row_version).toBe(before);
  });
});
