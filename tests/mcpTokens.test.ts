// Этап 16 (D-037; проект §3): персональные токены чат-клиентов — выпуск, показ один раз, срок 7 / 30 / 90 дней, не больше
// пяти действующих, отзыв владельцем и администратором, вторая линия БД (миграция 0040) и обновление схемы 0039 → 0040.
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenderCapabilities } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, MIGRATIONS_DIR, migrate, setupDatabase } from '../packages/db/src/index.ts';
import { ADMIN_URL, auditRows, buildScenario, createTestDb, makeApp, TestClient, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let app: ReturnType<typeof makeApp>;
let s: IScenario;

const issue = (client: TestClient, body: Record<string, unknown> = {}) => client.post('/me/api-tokens', { name: 'Рабочий ноутбук', clientKind: 'codex', ...body });
const list = async (client: TestClient) => (await client.get('/me/api-tokens')).body as { items: any[]; active: number; canIssue: boolean; maxActive: number };
const DENIED = ['42501', '55000', '23514'];
const sqlCode = async (sql: string, params: unknown[] = []): Promise<string | null> => {
  try {
    await db.pool.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};

beforeAll(async () => {
  db = await createTestDb();
  app = makeApp(db);
  s = await buildScenario(db, app);
}, 120_000);
afterAll(async () => db?.drop());

describe('выпуск и показ', () => {
  it('инженер выпускает токен: значение показано один раз, в БД — только хэш, в журнале и записях идемпотентности значения нет', async () => {
    const r = await issue(s.eng1);
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ name: 'Рабочий ноутбук', clientKind: 'codex', scopes: ['read'], lifetimeDays: 30, state: 'active', lastUsedAt: null, revokedAt: null });
    const token = r.body.token as string;
    expect(token).toMatch(/^kkp_[A-Za-z0-9_-]{43}$/);
    expect(r.body.prefix).toBe(token.slice(0, 8));
    expect(new Date(r.body.expiresAt).getTime() - new Date(r.body.createdAt).getTime()).toBe(30 * 24 * 3600 * 1000);
    const row = (await db.pool.query<{ token_sha256: string }>('SELECT token_sha256 FROM api_token WHERE id = $1', [r.body.id])).rows[0]!;
    expect(row.token_sha256).toBe(createHash('sha256').update(token).digest('hex'));
    const listed = await list(s.eng1);
    expect(listed).toMatchObject({ active: 1, canIssue: true, maxActive: 5 });
    expect(JSON.stringify(listed)).not.toContain(token);
    // Значение токена не осталось ни в одной таблице.
    for (const table of ['api_token', 'audit_event', 'idempotency_record']) {
      const dump = await db.pool.query<{ t: string }>(`SELECT coalesce(string_agg(x::text, ' '), '') AS t FROM ${table} x`);
      expect(dump.rows[0]!.t, table).not.toContain(token);
    }
    const audit = await auditRows(db.pool, "action = 'mcp.token.issue'");
    expect(audit.at(-1)).toMatchObject({ outcome: 'allowed', entity_id: r.body.id });
    expect(audit.at(-1)!.details).toEqual({ clientKind: 'codex', scopes: ['read'], lifetimeDays: 30 });
  });

  it('область propose и срок задаются явно; чужой срок, лишние поля и пустое название — отказ', async () => {
    const r = await issue(s.manager, { name: 'Cursor дома', clientKind: 'cursor', propose: true, lifetimeDays: 90 });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ clientKind: 'cursor', scopes: ['read', 'propose'], lifetimeDays: 90 });
    expect(new Date(r.body.expiresAt).getTime() - new Date(r.body.createdAt).getTime()).toBe(90 * 24 * 3600 * 1000);
    expect((await issue(s.manager, { lifetimeDays: 7 })).status).toBe(201);
    for (const bad of [{ lifetimeDays: 15 }, { lifetimeDays: 365 }, { name: '  ' }, { clientKind: 'chatgpt' }, { scopes: ['read', 'admin'] }, { propose: 'yes' }]) {
      expect((await issue(s.manager, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('администратор без роли инженера или руководителя токен не выпускает; без входа — 401; токен на /api/v1 не принимается', async () => {
    const denied = await issue(s.admin);
    expect(denied.status).toBe(403);
    expect((await list(s.admin)).canIssue).toBe(false);
    const anonymous = new TestClient(app);
    expect((await anonymous.get('/me/api-tokens')).status).toBe(401);
    const token = (await issue(s.eng2)).body.token as string;
    for (const path of ['/me', '/me/api-tokens', `/tenders/${s.tenderA}`]) {
      expect((await anonymous.get(path, { headers: { Authorization: `Bearer ${token}` } })).status, path).toBe(401);
    }
    expect((await anonymous.post('/me/api-tokens', { name: 'x', clientKind: 'other' }, { headers: { Authorization: `Bearer ${token}` } })).status).toBeGreaterThanOrEqual(401);
    expect((await list(s.eng2)).items).toHaveLength(1);
  });
});

describe('лимит и отзыв', () => {
  it('не больше пяти действующих токенов; после отзыва можно выпустить снова', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await issue(s.eng3, { name: `Токен ${i + 1}` });
      expect(r.status, r.text).toBe(201);
      ids.push(r.body.id as string);
    }
    const sixth = await issue(s.eng3, { name: 'Шестой' });
    expect(sixth.status).toBe(409);
    expect(sixth.body.current).toMatchObject({ reason: 'token_limit', max: 5 });
    const revoked = await s.eng3.delete(`/api-tokens/${ids[0]}`);
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body).toMatchObject({ id: ids[0], state: 'revoked' });
    expect(revoked.body.revokedAt).not.toBeNull();
    expect((await issue(s.eng3, { name: 'Снова пятый' })).status).toBe(201);
    expect((await list(s.eng3)).active).toBe(5);
  });

  it('чужой токен не виден и не отзывается; администратор отзывает чужой; повторный отзыв ничего не меняет', async () => {
    const mine = (await list(s.eng3)).items.find((t) => t.state === 'active')!;
    expect((await s.eng1.delete(`/api-tokens/${mine.id}`)).status).toBe(404);
    expect((await s.manager.delete(`/api-tokens/${mine.id}`)).status).toBe(404);
    const byAdmin = await s.admin.delete(`/api-tokens/${mine.id}`);
    expect(byAdmin.status, byAdmin.text).toBe(200);
    expect(byAdmin.body.state).toBe('revoked');
    expect(JSON.stringify(byAdmin.body)).not.toMatch(/kkp_[A-Za-z0-9_-]{43}/);
    const again = await s.eng3.delete(`/api-tokens/${mine.id}`);
    expect(again.status).toBe(200);
    expect(again.body.revokedAt).toBe(byAdmin.body.revokedAt);
    const audit = (await auditRows(db.pool, "action = 'mcp.token.revoke' AND outcome = 'allowed'")).filter((a) => a.entity_id === mine.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ ownerUserId: s.ids.eng3, byOwner: false });
  });
});

describe('вторая линия БД (миграция 0040)', () => {
  const insert = (o: { user?: string; days?: number; scopes?: string[]; sha?: string; revoked?: boolean } = {}) =>
    sqlCode(
      `INSERT INTO api_token (user_id, name, client_kind, token_sha256, token_prefix, scopes, lifetime_days, expires_at, revoked_at, revoked_by)
       VALUES ($1, 'прямая запись', 'other', $2, 'kkp_test', $3, $4, now() + make_interval(days => $4), $5, $6)`,
      [o.user ?? s.ids.eng1, o.sha ?? createHash('sha256').update(`${Math.random()}`).digest('hex'), o.scopes ?? ['read'], o.days ?? 30, o.revoked ? new Date() : null, o.revoked ? s.ids.eng1 : null],
    );

  it('срок, области, владелец и состояние проверяет БД', async () => {
    expect(await insert()).toBeNull();
    expect(await insert({ days: 15 })).toBe('23514');
    expect(await insert({ scopes: ['propose'] })).toBe('23514');
    expect(await insert({ scopes: ['read', 'approve'] })).toBe('23514');
    expect(await insert({ user: s.ids.admin })).toBe('42501');
    expect(await insert({ revoked: true })).toBe('55000');
    // Срок не равен созданию плюс выбранное число дней.
    expect(await sqlCode(`INSERT INTO api_token (user_id, name, client_kind, token_sha256, token_prefix, scopes, lifetime_days, expires_at)
                           VALUES ($1, 'долгий', 'other', $2, 'kkp_test', '{read}', 7, now() + interval '400 days')`, [s.ids.eng1, createHash('sha256').update('long').digest('hex')])).toBe('23514');
  });

  it('у пользователя не больше пяти действующих токенов и при прямой записи', async () => {
    // У инженера 3 после отзыва администратором четыре действующих: пятый проходит, шестой — нет.
    expect((await list(s.eng3)).active).toBe(4);
    expect(await insert({ user: s.ids.eng3 })).toBeNull();
    expect(await insert({ user: s.ids.eng3 })).toBe('55000');
    // Попытки чужого отзыва записаны в журнал как отказ.
    expect((await auditRows(db.pool, "action = 'mcp.token.revoke' AND outcome = 'denied'")).length).toBeGreaterThanOrEqual(2);
  });

  it('токен не правится и не удаляется; отзывает владелец или администратор, один раз', async () => {
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM api_token WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1", [s.ids.eng1])).rows[0]!.id;
    expect(DENIED).toContain(await sqlCode("UPDATE api_token SET scopes = '{read,propose}' WHERE id = $1", [id]));
    expect(DENIED).toContain(await sqlCode("UPDATE api_token SET expires_at = expires_at + interval '1 day', lifetime_days = 90 WHERE id = $1", [id]));
    expect(DENIED).toContain(await sqlCode('UPDATE api_token SET user_id = $2 WHERE id = $1', [id, s.ids.manager]));
    expect(DENIED).toContain(await sqlCode('DELETE FROM api_token WHERE id = $1', [id]));
    expect(await sqlCode('UPDATE api_token SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [id, s.ids.eng2])).toBe('42501');
    expect(await sqlCode('UPDATE api_token SET last_used_at = now() WHERE id = $1', [id])).toBeNull();
    expect(await sqlCode('UPDATE api_token SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [id, s.ids.eng1])).toBeNull();
    expect(await sqlCode('UPDATE api_token SET revoked_at = NULL, revoked_by = NULL WHERE id = $1', [id])).toBe('55000');
  });

  it('возможность mcp.propose — у инженера и руководителя тендера; БД и ядро совпадают', async () => {
    const dbCaps = async (user: string, tender: string) => (await db.pool.query<{ caps: string[] }>('SELECT tender_capabilities($1, $2) AS caps', [user, tender])).rows[0]!.caps;
    expect(await dbCaps(s.ids.eng1, s.tenderA)).toContain('mcp.propose');
    expect(await dbCaps(s.ids.manager, s.tenderA)).toContain('mcp.propose');
    expect(await dbCaps(s.ids.eng3, s.tenderA)).not.toContain('mcp.propose');
    expect(await dbCaps(s.ids.admin, s.tenderA)).not.toContain('mcp.propose');
    expect([...(await dbCaps(s.ids.eng1, s.tenderA))].sort()).toEqual([...tenderCapabilities(new Set(['engineer']), 'engineer')].sort());
    expect([...(await dbCaps(s.ids.manager, s.tenderA))].sort()).toEqual([...tenderCapabilities(new Set(['manager']), 'manager')].sort());
  });

  it('запись журнала от имени модели через MCP без пользователя не принимается', async () => {
    expect(await sqlCode("INSERT INTO audit_event (principal_kind, action, outcome) VALUES ('model_via_mcp', 'mcp.test', 'allowed')")).toBe('23514');
    expect(await sqlCode("INSERT INTO audit_event (principal_kind, on_behalf_of_user_id, action, outcome) VALUES ('model_via_mcp', $1, 'mcp.test', 'allowed')", [s.ids.eng1])).toBeNull();
  });
});

describe('обновление схемы 0039 → 0040', () => {
  it('данные прежних этапов переживают обновление; появляются таблицы токенов и предложений, возможность и статусы интеграций', async () => {
    const name = `kontur_kp_test_upgrade39_${Date.now().toString(36)}`;
    const urlFor = (user: string) => {
      const u = new URL(ADMIN_URL);
      u.username = user;
      u.password = '';
      u.pathname = `/${name}`;
      return u.toString();
    };
    const migrateTo = async (max: number): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), `kontur-mig39-${max}-`));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
      const mc = new pg.Client({ connectionString: urlFor('kontur_migrator') });
      await mc.connect();
      try {
        return (await migrate(mc, { testMode: true, dir })).length;
      } finally {
        await mc.end();
      }
    };
    await setupDatabase(ADMIN_URL, name);
    const pool = createPool(urlFor('kontur_app'), 3);
    try {
      expect(await migrateTo(39)).toBe(39);
      const old: ITestDb = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool, drop: async () => undefined };
      const before = await buildScenario(old, makeApp(old));
      const caps = async (user: string) => (await pool.query<{ caps: string[] }>('SELECT tender_capabilities($1, $2) AS caps', [user, before.tenderA])).rows[0]!.caps;
      expect(await caps(before.ids.eng1)).not.toContain('mcp.propose');
      const auditBefore = Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event')).rows[0]!.n);
      expect(auditBefore).toBeGreaterThan(0);
      const remaining = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > 39).length;
      expect(remaining).toBeGreaterThanOrEqual(1);
      expect(await migrateTo(9999)).toBe(remaining);
      expect(await caps(before.ids.eng1)).toContain('mcp.propose');
      expect(Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event')).rows[0]!.n)).toBe(auditBefore);
      const status = await pool.query<{ system: string; status: string }>("SELECT system, status FROM integration_status WHERE system IN ('mcp', 'codex', 'cursor') ORDER BY system");
      expect(status.rows).toEqual([{ system: 'codex', status: 'NOT_IMPLEMENTED' }, { system: 'cursor', status: 'NOT_IMPLEMENTED' }, { system: 'mcp', status: 'VERIFIED_FIXTURE' }]);
      // После обновления прежний пользователь выпускает токен обычной командой.
      const upgraded = makeApp(old);
      const eng = new TestClient(upgraded);
      expect((await eng.login('eng1')).status).toBe(200);
      expect((await eng.post('/me/api-tokens', { name: 'после обновления', clientKind: 'other' })).status).toBe(201);
    } finally {
      await pool.end();
      await dropDatabase(ADMIN_URL, name);
    }
  }, 300_000);
});
