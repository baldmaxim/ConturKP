// Этап 08a, граф фактов D-018 (D-028): инварианты БД миграции 0023 (docs/architecture/08a-fact-graph-design.md §9)
// прямым SQL — вторая линия держит их без кода; и обновление схемы 0022 → 0023 на данных этапов 08 и 08a.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, dropDatabase, migrate, MIGRATIONS_DIR, setupDatabase } from '../packages/db/src/index.ts';
import { createContract, grantCreator, uploadMain } from './contractFixtures.ts';
import { ADMIN_URL, buildScenario, createTestDb, drain, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildMailScope, type IMailScope } from './mailFixtures.ts';
import { buildStage08, workerWithChat } from './requirementFixtures.ts';
import { seedEvidenceRun, uploadDocument } from './searchFixtures.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let m: IMailScope;
const config = testConfig();
const ids = {} as Record<'run' | 'xrun' | 'fact' | 'otherFact' | 'contractFact' | 'fragment' | 'otherFragment' | 'descFragment' | 'revision' | 'document' | 'contractId' | 'serviceUser', string>;

const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
const q = (sql: string, params: unknown[] = []) => code(db.pool.query(sql, params));
const tx = async (fn: (c: pg.PoolClient) => Promise<unknown>): Promise<string> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (process.env.KONTUR_TEST_LOG) process.stderr.write(`tx: ${(e as Error).message}\n`);
    return (e as { code?: string }).code ?? String(e);
  } finally {
    c.release();
  }
};
const asOwner = async (sql: string, params: unknown[] = []): Promise<string> => {
  const c = new pg.Client({ connectionString: db.migratorUrl });
  await c.connect();
  try {
    return await code(c.query(sql, params));
  } finally {
    await c.end();
  }
};
const XRUN_INSERT = `INSERT INTO fact_extraction_run (recognition_run_id, document_revision_id, document_id, tender_id, contract_id, rules_version, document_kind,
  document_number, classify_method, fragments_scanned, facts_found, coverage) VALUES ($1, $2, $3, $4, $5, $6, 'other', '', 'none', 0, 0, '{}')`;

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = workerWithChat(db, config, null);
  const rev = await uploadDocument(db, config, s.eng1, s.stageA, 'Договор 1.pdf');
  const run = await seedEvidenceRun(db.pool, rev, {
    pages: [{ blocks: ['Договор подряда № 1 от 01.01.2026', '3.1. Аванс в размере 20% от цены договора.', { text: 'Описание модели: аванс 20%.', origin: 'model_description' }] }],
  });
  const other = await uploadDocument(db, config, s.eng3, s.stageB, 'Договор Б.pdf');
  await seedEvidenceRun(db.pool, other, { pages: [{ blocks: ['Договор подряда № 2 от 01.01.2026', '6.1. Гарантийный срок составляет 3 года.'] }] });
  await grantCreator(s.admin, s.ids.manager);
  ids.contractId = await createContract(s.manager, 'Д-СХЕМА');
  const main = await uploadMain(s.manager, ids.contractId, 'договор.pdf');
  await seedEvidenceRun(db.pool, main.revisionId, { pages: [{ blocks: ['Договор подряда № Д-С от 01.01.2026', '3.1. Аванс в размере 15% от цены договора.'] }] });
  await worker.scheduleFactExtraction();
  await drain(worker);
  ids.run = run;
  ids.revision = rev;
  ids.document = (await db.pool.query('SELECT document_id FROM document_revision WHERE id = $1', [rev])).rows[0].document_id;
  const x = await db.pool.query('SELECT x.id, f.id AS fact FROM fact_extraction_run x JOIN evidence_fact f ON f.extraction_run_id = x.id WHERE x.recognition_run_id = $1', [run]);
  ids.xrun = x.rows[0].id;
  ids.fact = x.rows[0].fact;
  ids.otherFact = (await db.pool.query("SELECT f.id FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id WHERE x.tender_id = $1", [s.tenderB])).rows[0].id;
  ids.contractFact = (await db.pool.query('SELECT f.id FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id WHERE x.contract_id = $1', [ids.contractId])).rows[0].id;
  ids.fragment = (await db.pool.query("SELECT id FROM evidence_fragment WHERE run_id = $1 AND text LIKE '3.1.%'", [run])).rows[0].id;
  ids.descFragment = (await db.pool.query("SELECT id FROM evidence_fragment WHERE run_id = $1 AND origin = 'model_description'", [run])).rows[0].id;
  ids.otherFragment = (await db.pool.query("SELECT id FROM evidence_fragment WHERE tender_id = $1 AND text LIKE '6.1.%'", [s.tenderB])).rows[0].id;
  // Сервисная учётная запись модели: решение по факту она принять не может (I12).
  ids.serviceUser = (await db.pool.query("INSERT INTO app_user (kind, service_kind, login, display_name) VALUES ('service', 'model', 'model.facts', 'Модель') RETURNING id")).rows[0].id;
  // Вложение письма с завершённым локальным распознаванием (этап 07): из него факты не извлекаются.
  m = await buildMailScope(s, makeWorker(db, config, 'fact-schema-mail'), () => uploadDocument(db, config, s.eng1, s.stageA, 'тз-А.pdf'), (r, text) => seedEvidenceRun(db.pool, r, { pages: [{ blocks: [text] }] }));
});
afterAll(async () => {
  await db.drop();
});

describe('инвариант 1: неизменяемость прочитанного', () => {
  it('прогон извлечения, факт, основание и решение не меняются и не удаляются — роль приложения и владелец схемы', async () => {
    for (const table of ['fact_extraction_run', 'evidence_fact', 'evidence_fact_fragment']) {
      expect(await q(`UPDATE ${table} SET created_xact = created_xact`)).toBe('42501');
      expect(await q(`DELETE FROM ${table}`)).toBe('42501');
      expect(await asOwner(`UPDATE ${table} SET created_xact = created_xact`)).toBe('55000');
      expect(await asOwner(`DELETE FROM ${table}`)).toBe('55000');
    }
    expect(await asOwner('UPDATE evidence_fact_type SET title = title')).toBe('55000');
    expect(await q("INSERT INTO evidence_fact_type (code, title, fate, normative_source) VALUES ('x_type', 'x', 'economics', 'x')")).toBe('42501');
  });
});

describe('инвариант 2 (I06): основание — фрагмент того же прогона письменного происхождения', () => {
  const withFact = (fragmentId: string) =>
    tx(async (c) => {
      const x = await c.query(`${XRUN_INSERT} RETURNING id`, [ids.run, ids.revision, ids.document, s.tenderA, null, 'rules/test-' + Math.random().toString(36).slice(2)]);
      const f = await c.query("INSERT INTO evidence_fact (extraction_run_id, fact_type, raw_value, normalized, normalized_key, unit, condition, clause_ref, amends) VALUES ($1, 'advance_percent', 'аванс', '{\"percent\":20}', '[[\"percent\",20]]', '%', '', '3.1', false) RETURNING id", [x.rows[0].id]);
      await c.query('INSERT INTO evidence_fact_fragment (evidence_fact_id, fragment_id, ordinal) VALUES ($1, $2, 1)', [f.rows[0].id, fragmentId]);
    });
  it('фрагмент того же прогона — допустим; другого прогона и описание модели — отказ', async () => {
    expect(await withFact(ids.fragment)).toBe('ok');
    expect(await withFact(ids.otherFragment)).toBe('23514');
    expect(await withFact(ids.descFragment)).toBe('23514');
  });
});

describe('инвариант 3: факт — только в транзакции своего прогона и не без основания', () => {
  it('факт к готовому прогону извлечения позже — отказ; факт без основания — отказ на COMMIT', async () => {
    expect(await q("INSERT INTO evidence_fact (extraction_run_id, fact_type, raw_value, normalized, normalized_key, unit, condition, clause_ref, amends) VALUES ($1, 'vat_rate', 'НДС', '{}', '[]', '%', '', '', false)", [ids.xrun])).toBe('55000');
    const bare = await tx(async (c) => {
      const x = await c.query(`${XRUN_INSERT} RETURNING id`, [ids.run, ids.revision, ids.document, s.tenderA, null, 'rules/bare']);
      await c.query("INSERT INTO evidence_fact (extraction_run_id, fact_type, raw_value, normalized, normalized_key, unit, condition, clause_ref, amends) VALUES ($1, 'vat_rate', 'НДС', '{}', '[]', '%', '', '', false)", [x.rows[0].id]);
    });
    expect(bare).toBe('23514');
  });

  it('прогон извлечения: владелец — владелец документа; вложения писем — нет; один прогон на версию правил', async () => {
    expect(await tx((c) => c.query(XRUN_INSERT, [ids.run, ids.revision, ids.document, s.tenderB, null, 'rules/owner']))).toBe('23514');
    expect(await tx((c) => c.query(XRUN_INSERT, [ids.run, ids.revision, ids.document, null, ids.contractId, 'rules/owner2']))).toBe('23514');
    const att = await db.pool.query('SELECT rr.id, rr.document_revision_id, v.document_id FROM recognition_run rr JOIN document_revision v ON v.id = rr.document_revision_id WHERE rr.id = $1', [m.attRun]);
    const a = att.rows[0];
    expect(await tx((c) => c.query(XRUN_INSERT, [a.id, a.document_revision_id, a.document_id, s.tenderA, null, 'rules/att']))).toBe('23514');
    expect((await db.pool.query('SELECT 1 FROM fact_extraction_run WHERE recognition_run_id = $1', [m.attRun])).rowCount).toBe(0);
    expect(await tx((c) => c.query(XRUN_INSERT, [ids.run, ids.revision, ids.document, s.tenderA, null, 'rules/1-kontur']))).toBe('23505');
  });
});

describe('инвариант 4: решение человека — о двух фактах одного владельца', () => {
  const decide = (factId: string, otherId: string, tenderId: string | null, contractId: string | null, userId: string) =>
    q("INSERT INTO fact_decision (tender_id, contract_id, fact_id, other_fact_id, kind, reason, decided_by) VALUES ($1, $2, $3, $4, 'distinct', 'тест', $5)", [tenderId, contractId, factId, otherId, userId]);
  it('другой владелец, тот же факт, автор-сервис — отказ', async () => {
    const other = (await db.pool.query("SELECT f.id FROM evidence_fact f JOIN fact_extraction_run x ON x.id = f.extraction_run_id WHERE x.tender_id = $1 AND f.id <> $2 LIMIT 1", [s.tenderA, ids.fact])).rows[0].id as string;
    expect(await decide(ids.fact, ids.otherFact, s.tenderA, null, s.ids.manager)).toBe('23514');
    expect(await decide(ids.fact, ids.contractFact, s.tenderA, null, s.ids.manager)).toBe('23514');
    expect(await decide(ids.fact, ids.fact, s.tenderA, null, s.ids.manager)).toBe('23514');
    expect(await decide(ids.fact, other, s.tenderA, null, ids.serviceUser)).toBe('42501');
    expect(await decide(ids.fact, other, s.tenderA, null, s.ids.manager)).toBe('ok');
  });
});

describe('инварианты 5–6: состояние и замечание', () => {
  it('состояние — у факта своего владельца; перекрыт ⇔ причина; удаление запрещено', async () => {
    expect(await q("UPDATE fact_state SET tender_id = $2 WHERE evidence_fact_id = $1", [ids.fact, s.tenderB])).toBe('23514');
    expect(await q("UPDATE fact_state SET status = 'superseded', superseded_reason = NULL WHERE evidence_fact_id = $1", [ids.fact])).toBe('23514');
    expect(await q("UPDATE fact_state SET status = 'superseded', superseded_reason = 'amendment', superseded_by_fact_id = $2 WHERE evidence_fact_id = $1", [ids.fact, ids.otherFact])).toBe('23514');
    expect(await q('DELETE FROM fact_state WHERE evidence_fact_id = $1', [ids.fact])).toBe('42501');
    expect(await asOwner('DELETE FROM fact_state WHERE evidence_fact_id = $1', [ids.fact])).toBe('55000');
  });

  it('замечание: только open → resolved; закрытое неизменно; содержание не меняется', async () => {
    const r = await db.pool.query(
      "INSERT INTO fact_remark (tender_id, remark_key, kind, fact_ids, document_ids, message) VALUES ($1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'value_conflict', $2::uuid[], '{}', 'тест') RETURNING id",
      [s.tenderA, [ids.fact]],
    );
    const id = r.rows[0].id;
    expect(await q("UPDATE fact_remark SET message = 'иначе' WHERE id = $1", [id])).toBe('55000');
    expect(await q("UPDATE fact_remark SET status = 'resolved', resolved_at = now() WHERE id = $1", [id])).toBe('ok');
    expect(await q("UPDATE fact_remark SET status = 'open', resolved_at = NULL WHERE id = $1", [id])).toBe('55000');
    expect(await q('DELETE FROM fact_remark WHERE id = $1', [id])).toBe('42501');
  });
});

describe('обновление схемы 0022 → 0023', () => {
  it('данные этапа 08 переживают 0023; на обновлённой базе извлечение и граф работают', async () => {
    const name = `kontur_kp_test_upgrade23_${Date.now().toString(36)}`;
    const urlFor = (user: string): string => {
      const u = new URL(ADMIN_URL);
      u.username = user;
      u.password = '';
      u.pathname = `/${name}`;
      return u.toString();
    };
    const migrateTo = async (max: number): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), `kontur-mig23-${max}-`));
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
    const up: ITestDb = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
    try {
      expect(await migrateTo(22)).toBe(22);
      const s08 = await buildStage08(up, config);
      const before = (await up.pool.query('SELECT count(*)::int AS n FROM requirement_registry')).rows[0].n;
      expect(await migrateTo(23)).toBe(1);
      expect((await up.pool.query('SELECT count(*)::int AS n FROM requirement_registry')).rows[0].n).toBe(before);
      expect((await up.pool.query('SELECT count(*)::int AS n FROM evidence_fact_type')).rows[0].n).toBe(13);
      const w = workerWithChat(up, config, null, 'upgrade-23');
      expect(await w.scheduleFactExtraction()).toBeGreaterThan(0);
      await drain(w);
      const g = await s08.s.eng1.get(`/tenders/${s08.s.tenderA}/fact-graph`);
      expect(g.status, g.text).toBe(200);
      expect(g.body.graphHash).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      await up.pool.end();
      await dropDatabase(ADMIN_URL, name);
    }
  });
});
