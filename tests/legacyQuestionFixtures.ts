// Review 16-2 (R16-02): база прежней версии — схема 0040 с вопросами, которые вёл код передачи 16-1. Данные и аудит
// пишет код HEAD теми же командами API: на схеме 0040 охранник вопроса историю связей с требованиями не ведёт, так что
// строки и записи аудита получаются той же формы, что у прежнего кода. Колонки, которые читает расчёт видимости HEAD,
// добавляются на время подготовки и убираются перед обновлением (legacySchema.ts). Сценарий ревьюера с настоящим
// кодом 054cff4 — в архиве Review 16-2 (`reviewer16Legacy.test.ts`).
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect } from 'vitest';
import { formatEtag } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, migrate, MIGRATIONS_DIR, setupDatabase } from '../packages/db/src/index.ts';
import { createContract, grantCreator, linkContract, setAccess, uploadMain } from './contractFixtures.ts';
import { ADMIN_URL, idem, testConfig, type ITestDb, type TestClient } from './helpers.ts';
import { addQuestionOrigin, dropQuestionOrigin } from './legacySchema.ts';
import { buildStage08, confirm, propose, supports, type IStage08 } from './requirementFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet } from './searchFixtures.ts';

export const LATEST_MIGRATION = Math.max(...readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))));

export interface ILegacyStage {
  db: ITestDb;
  st: IStage08;
  // Требование с основанием из договора, который читает только руководитель; инженер 1 договор не читает.
  closedRequirement: string;
  openRequirement: string;
  // Обновление до последней миграции: возвращает число применённых миграций.
  upgrade: () => Promise<number>;
  close: () => Promise<void>;
}

export const buildLegacyStage = async (label: string, secret: string): Promise<ILegacyStage> => {
  const name = `kontur_kp_test_legacy${label}_${Date.now().toString(36)}`;
  const urlFor = (user: string): string => {
    const u = new URL(ADMIN_URL);
    u.username = user;
    u.password = '';
    u.pathname = `/${name}`;
    return u.toString();
  };
  const migrateTo = async (max: number): Promise<number> => {
    const dir = mkdtempSync(join(tmpdir(), `kontur-legacy-${label}-${max}-`));
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
  const db: ITestDb = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
  const close = async (): Promise<void> => {
    await db.pool.end().catch(() => undefined);
    await dropDatabase(ADMIN_URL, name);
  };
  try {
    expect(await migrateTo(40)).toBe(40);
    await addQuestionOrigin(db.migratorUrl, false);
    const st = await buildStage08(db, testConfig());
    const { s } = st;
    await grantCreator(s.admin, s.ids.manager);
    const contract = await createContract(s.manager, `Д-16-${label}`);
    await setAccess(s.admin, contract, s.ids.manager, ['contract.read', 'contract.link', 'contract.manage']);
    const rev = (await uploadMain(s.manager, contract)).revisionId;
    const clause = `Закрытое условие ${secret}`;
    const fragment = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, rev, { pages: [{ blocks: [clause] }] }), clause);
    await linkContract(s.manager, contract, s.tenderA);
    await setWorkingSet(s.manager, s.stageA, [st.docRev, rev], true);
    const scope = await fixScope(s.manager, s.stageA);
    const registry = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scope, reason: 'База прежней версии' }, { headers: idem() });
    expect(registry.status, registry.text).toBe(201);
    const requirement = async (statement: string, evidence: object[]): Promise<string> => {
      const r = await confirm(s.manager, (await propose(s.manager, registry.body.id as string, statement, evidence)).id);
      expect(r.status, r.text).toBe(200);
      return r.body.requirementId as string;
    };
    const closedRequirement = await requirement(`Условие ${secret}`, [...supports(st.frag.facade), { fragmentId: fragment, role: 'clarifies' }]);
    const openRequirement = await requirement('Кровля плоская с внутренним водостоком', supports(st.frag.roof));
    const upgrade = async (): Promise<number> => {
      await dropQuestionOrigin(db.migratorUrl, false);
      const columns = await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'customer_question' AND column_name IN ('source_proposal_id', 'basis_requirement_ids', 'basis_unknown')");
      expect(columns.rowCount).toBe(0);
      return migrateTo(LATEST_MIGRATION);
    };
    return { db, st, closedRequirement, openRequirement, upgrade, close };
  } catch (e) {
    await close();
    throw e;
  }
};

// Команды прежней версии над вопросом: те же маршруты API, версия строки — из базы.
export const legacyQuestion = async (client: TestClient, stageId: string, body: Record<string, unknown>): Promise<string> => {
  const r = await client.post(`/stages/${stageId}/customer-questions`, body, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
};
export const legacyPatch = async (db: ITestDb, client: TestClient, id: string, body: Record<string, unknown>) => {
  const version = Number((await db.pool.query<{ v: string }>('SELECT row_version AS v FROM customer_question WHERE id = $1', [id])).rows[0]!.v);
  return client.patch(`/customer-questions/${id}`, body, { headers: { 'If-Match': formatEtag(id, version) } });
};
