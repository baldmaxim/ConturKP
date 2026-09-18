// Миграции (ADR-002), bootstrap (ADR-006 §11), конфигурация без секретов, /ready и перезапуск (ADR-011).
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapRefused, bootstrapOwner } from '../apps/server/src/bootstrap.ts';
import { ConfigError, configReport, loadConfig } from '../packages/config/src/index.ts';
import { beat, checkSchema, listMigrations, migrate, MIGRATIONS_DIR, MigrationError, setupDatabase, dropDatabase } from '../packages/db/src/index.ts';
import { ADMIN_URL, Clock, createTestDb, makeApp, PASSWORD, TestClient, testConfig, type ITestDb } from './helpers.ts';

let db: ITestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db.drop());

const migratorClient = async (url: string): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

describe('миграции', () => {
  it('пустая БД мигрирует до актуальной версии, повторный запуск ничего не делает', async () => {
    const c = await migratorClient(db.migratorUrl);
    try {
      expect(await migrate(c, { testMode: true })).toEqual([]);
      const s = await checkSchema(c);
      expect(s).toMatchObject({ ok: true, dbVersion: listMigrations().length });
      const tables = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
        [['app_user', 'user_role', 'session', 'tender', 'tender_member', 'tender_stage', 'audit_event', 'idempotency_record', 'process_heartbeat', 'schema_migration']],
      );
      expect(tables.rows[0]?.n).toBe(10);
    } finally {
      await c.end();
    }
  });

  it('изменённый уже применённый файл миграции — ошибка запуска', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kontur-mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const first = listMigrations(dir)[0]!;
    writeFileSync(join(dir, first.name), `${first.sql}\n-- правка задним числом\n`);
    const c = await migratorClient(db.migratorUrl);
    try {
      await expect(migrate(c, { testMode: true, dir })).rejects.toThrow(/изменена/);
      const s = await checkSchema(c, listMigrations(dir));
      expect(s.ok).toBe(false);
    } finally {
      await c.end();
    }
  });

  it('в тестовом режиме база без «test» в имени не мигрируется', async () => {
    const name = 'kontur_kp_devcheck';
    await setupDatabase(ADMIN_URL, name);
    const u = new URL(ADMIN_URL);
    u.username = 'kontur_migrator';
    u.pathname = `/${name}`;
    const c = await migratorClient(u.toString());
    try {
      await expect(migrate(c, { testMode: true })).rejects.toBeInstanceOf(MigrationError);
    } finally {
      await c.end();
      await dropDatabase(ADMIN_URL, name);
    }
  });

  it('роль приложения не выполняет DDL', async () => {
    await expect(db.pool.query('CREATE TABLE hack (id int)')).rejects.toThrow(/permission denied/);
    await expect(db.pool.query('DROP TABLE audit_event')).rejects.toThrow(/must be owner|permission denied/);
  });
});

describe('bootstrap руководителя', () => {
  it('создаёт первого администратора-руководителя; повтор отклоняется', async () => {
    await expect(bootstrapOwner(db.pool, { login: 'owner', displayName: 'Владелец', password: 'short', roles: ['admin', 'manager'] })).rejects.toBeInstanceOf(BootstrapRefused);
    const id = await bootstrapOwner(db.pool, { login: 'owner', displayName: 'Владелец', password: PASSWORD, roles: ['admin', 'manager'] });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    await expect(bootstrapOwner(db.pool, { login: 'owner2', displayName: 'Второй', password: PASSWORD, roles: ['admin'] })).rejects.toThrow(/уже существует/);
    const audit = await db.pool.query("SELECT principal_kind, details FROM audit_event WHERE action = 'user.bootstrap'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].principal_kind).toBe('system');
    const c = new TestClient(makeApp(db));
    const r = await c.login('owner');
    expect(r.body.roles).toEqual(['admin', 'manager']);
  });
});

describe('конфигурация', () => {
  const base = {
    KONTUR_ENV: 'development',
    DATABASE_URL: 'postgresql://kontur_app:s3cr3t-value@127.0.0.1:5432/kontur',
    STORAGE_ROOT: 'C:/data/kontur',
    ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
    TENDERHUB_API_KEY: 'th-secret-key-value',
  };

  it('отчёт показывает только «задано / не задано», без значений', () => {
    const report = JSON.stringify(configReport(base));
    expect(report).not.toContain('s3cr3t-value');
    expect(report).not.toContain('th-secret-key-value');
    expect(report).not.toContain('C:/data/kontur');
    expect(configReport(base).find((l) => l.name === 'TENDERHUB_API_KEY')?.state).toBe('задано');
    expect(configReport(base).find((l) => l.name === 'LOCALAI_TOKEN')?.state).toBe('не задано');
  });

  it('ошибки конфигурации не содержат значений секретов', () => {
    try {
      loadConfig({ ...base, KONTUR_ENV: 'prod', SESSION_IDLE_MINUTES: '-1' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain('s3cr3t-value');
    }
  });

  it('без TLS — только loopback; LAN-адрес и production требуют TLS', () => {
    expect(loadConfig(base).httpHost).toBe('127.0.0.1');
    expect(() => loadConfig({ ...base, HTTP_HOST: '0.0.0.0' })).toThrow(/TLS/);
    expect(() => loadConfig({ ...base, KONTUR_ENV: 'production' })).toThrow(/TLS/);
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: 'http://192.168.1.10' })).toThrow(/loopback/);
    const lan = loadConfig({ ...base, HTTP_HOST: '0.0.0.0', TLS_CERT_FILE: 'c.pem', TLS_KEY_FILE: 'k.pem', ALLOWED_ORIGINS: 'https://kontur.lan' });
    expect(lan.tls).not.toBeNull();
  });
});

describe('health / ready', () => {
  it('/health без аутентификации; /ready 503 без heartbeat worker и 200 со свежим heartbeat', async () => {
    const app = makeApp(db);
    const c = new TestClient(app);
    expect((await c.get('/health')).body).toEqual({ status: 'ok' });
    const before = await c.get('/ready');
    expect(before.status).toBe(503);
    expect(before.body.checks).toMatchObject({ database: { ok: true }, schema: { ok: true }, storage: { ok: true }, worker: { ok: false } });
    await beat(db.pool, { processId: 'worker:test', kind: 'worker', pid: 1, startedAt: new Date() });
    const after = await c.get('/ready');
    expect(after.status).toBe(200);
    expect(after.body.ready).toBe(true);
    expect(JSON.stringify(after.body)).not.toContain('kontur_app');
  });

  it('/ready 503 при недоступном хранилище и при несовпадении схемы', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kontur-')), 'not-a-dir');
    writeFileSync(file, 'x');
    const bad = new TestClient(makeApp(db, new Clock(), testConfig({ storageRoot: file })));
    const r = await bad.get('/ready');
    expect(r.status).toBe(503);
    expect(r.body.checks.storage.ok).toBe(false);
    const owner = await migratorClient(db.migratorUrl);
    try {
      await owner.query("UPDATE schema_migration SET sha256 = 'tampered' WHERE version = 1");
      const s = await new TestClient(makeApp(db)).get('/ready');
      expect(s.body.checks.schema.ok).toBe(false);
      const restored = listMigrations()[0]!.sha256;
      await owner.query('UPDATE schema_migration SET sha256 = $1 WHERE version = 1', [restored]);
    } finally {
      await owner.end();
    }
  });
});

describe('перезапуск', () => {
  it('после перезапуска приложения данные и сессия сохраняются, повторная миграция пуста', async () => {
    const clock = new Clock();
    const first = makeApp(db, clock);
    const c = new TestClient(first);
    expect((await c.login('owner')).status).toBe(200);
    const created = await c.post('/tenders', { code: 'RST-1', title: 'До перезапуска' }, { headers: { 'Idempotency-Key': 'restart-key-1' } });
    expect(created.status).toBe(201);

    const m = await migratorClient(db.migratorUrl);
    try {
      expect(await migrate(m, { testMode: true })).toEqual([]);
    } finally {
      await m.end();
    }
    const second = makeApp(db, clock);
    const again = new TestClient(second);
    for (const [k, v] of c.cookies) again.cookies.set(k, v);
    const t = await again.get(`/tenders/${created.body.id}`);
    expect(t.status).toBe(200);
    expect(t.body.title).toBe('До перезапуска');
    const replay = await again.post('/tenders', { code: 'RST-1', title: 'До перезапуска' }, { headers: { 'Idempotency-Key': 'restart-key-1' } });
    expect(replay.body.id).toBe(created.body.id);
  });
});
