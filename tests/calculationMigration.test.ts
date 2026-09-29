// Этап 06: обновление схемы с актуального состояния этапа 05 (миграции 0001–0010 и данные) до 0011.
// Раннер применяет только новый файл; данные этапов 00–05 не меняются; выгрузка работает на обновлённой базе.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, dropDatabase, listMigrations, migrate, MIGRATIONS_DIR, setupDatabase, type Pool } from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { ADMIN_URL, createUser, makeApp, makeWorker, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';

const name = `kontur_kp_test_upgrade_${Date.now().toString(36)}`;
const urlFor = (user: string): string => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = '';
  u.pathname = `/${name}`;
  return u.toString();
};

let pool: Pool;
let hub: IFakeTenderHub;
let stage05Dir: string;
let stage06Dir: string;

beforeAll(async () => {
  await setupDatabase(ADMIN_URL, name);
  // Каталог миграций этапа 05: 0001–0010 — ровно то, что применено на принятой базе stage-05.
  stage05Dir = mkdtempSync(join(tmpdir(), 'kontur-mig05-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 10)) {
    cpSync(join(MIGRATIONS_DIR, f), join(stage05Dir, f));
  }
  // Каталог этапа 06 (0001–0011): обновление проверяется ровно до 0011, поздние миграции — отдельным шагом.
  stage06Dir = mkdtempSync(join(tmpdir(), 'kontur-mig06-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 11)) {
    cpSync(join(MIGRATIONS_DIR, f), join(stage06Dir, f));
  }
  const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
  await m.connect();
  try {
    expect(await migrate(m, { testMode: true, dir: stage05Dir })).toHaveLength(10);
  } finally {
    await m.end();
  }
  pool = createPool(urlFor('kontur_app'), 5);
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.tenders.set(TH.tender, standardTender());
});
afterAll(async () => {
  await hub.close();
  await pool.end();
  await dropDatabase(ADMIN_URL, name);
});

describe('обновление схемы 0010 → 0011 (ADR-002 §5)', () => {
  it('на базе с данными этапов 02–05 применяется только 0011; данные целы; выгрузка работает', async () => {
    const db = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool, drop: async () => undefined } as ITestDb;
    const config = tenderHubConfig(testConfig(), hub);
    await new BlobStore(config.storageRoot).ensureDirs();
    // Данные «до обновления»: пользователи, тендеры, назначения, этапы — прямо в БД на схеме 0010.
    // Код приложения работает только на актуальной схеме (сервер при расхождении не стартует, checkSchema),
    // поэтому API до обновления не вызывается; вход и выгрузка — после него.
    const users = {
      admin: await createUser(pool, 'admin', ['admin'], 'Администратор'),
      manager: await createUser(pool, 'manager', ['manager'], 'Руководитель'),
      eng1: await createUser(pool, 'eng1', ['engineer'], 'Инженер 1'),
    };
    const tenderA = (await pool.query<{ id: string }>("INSERT INTO tender (code, title, created_by) VALUES ('A-1', 'Тендер A-1', $1) RETURNING id", [users.admin])).rows[0]!.id;
    for (const [userId, role] of [[users.manager, 'manager'], [users.eng1, 'engineer']] as const) {
      await pool.query('INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, $3, $4)', [tenderA, userId, role, users.admin]);
    }
    const stageA = (await pool.query<{ id: string }>("INSERT INTO tender_stage (tender_id, seq, title, created_by) VALUES ($1, 1, 'Этап A1', $2) RETURNING id", [tenderA, users.manager]))
      .rows[0]!.id;
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tender_stage');
    const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
    await m.connect();
    try {
      expect(await migrate(m, { testMode: true, dir: stage06Dir })).toEqual([11]);
      expect(await migrate(m, { testMode: true, dir: stage06Dir })).toEqual([]);
      // Последующие миграции (0012 — этап 06a) применяются поверх 0011 на тех же данных.
      expect(await migrate(m, { testMode: true })).toEqual(listMigrations().filter((f) => f.version > 11).map((f) => f.version));
    } finally {
      await m.end();
    }
    expect(listMigrations(stage06Dir).at(-1)!.name).toBe('0011_calculation.sql');
    expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tender_stage')).rows[0]!.n).toBe(before.rows[0]!.n);
    const row = await pool.query<{ status: string }>("SELECT status FROM integration_status WHERE system = 'tenderhub' AND component = 'TenderHubRevisionReader'");
    expect(row.rows).toEqual([{ status: 'BLOCKED_EXTERNAL' }]);
    const app = makeApp(db, undefined, config);
    const login = async (name: string): Promise<TestClient> => {
      const c = new TestClient(app);
      expect((await c.login(name)).status).toBe(200);
      return c;
    };
    const s = { admin: await login('admin'), eng1: await login('eng1'), tenderA, stageA } as unknown as IScenario;
    const boss = await adminMember(db, s, app, s.tenderA);
    await linkSource(boss, s.stageA, TH.tender);
    const cap = await captureNow(db, makeWorker(db, config), s.eng1, s.stageA);
    expect(cap).toMatchObject({ status: 'complete' });
  });
});
