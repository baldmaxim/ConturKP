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
import { ADMIN_URL, buildScenario, makeApp, makeWorker, testConfig, type ITestDb } from './helpers.ts';

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

beforeAll(async () => {
  await setupDatabase(ADMIN_URL, name);
  // Каталог миграций этапа 05: 0001–0010 — ровно то, что применено на принятой базе stage-05.
  stage05Dir = mkdtempSync(join(tmpdir(), 'kontur-mig05-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 10)) {
    cpSync(join(MIGRATIONS_DIR, f), join(stage05Dir, f));
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
    // Данные «до обновления»: пользователи, тендеры, назначения, этапы — через API на схеме 0010.
    const app = makeApp(db, undefined, config);
    const s = await buildScenario(db, app);
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tender_stage');
    const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
    await m.connect();
    try {
      expect(await migrate(m, { testMode: true })).toEqual([11]);
      expect(await migrate(m, { testMode: true })).toEqual([]);
    } finally {
      await m.end();
    }
    expect(listMigrations().at(-1)!.name).toBe('0011_calculation.sql');
    expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tender_stage')).rows[0]!.n).toBe(before.rows[0]!.n);
    const row = await pool.query<{ status: string }>("SELECT status FROM integration_status WHERE system = 'tenderhub' AND component = 'TenderHubRevisionReader'");
    expect(row.rows).toEqual([{ status: 'BLOCKED_EXTERNAL' }]);
    const boss = await adminMember(db, s, app, s.tenderA);
    await linkSource(boss, s.stageA, TH.tender);
    const cap = await captureNow(db, makeWorker(db, config), s.eng1, s.stageA);
    expect(cap).toMatchObject({ status: 'complete' });
  });
});
