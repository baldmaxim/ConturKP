// R08-01: обновление схемы 0019 → 0020 на данных этапа 08. Существующие объекты покрытия по ревизии расчёта
// получают единицы и статус той же функцией, что и новые; прежняя оценка «покрыто» с несовпадением единиц не
// ломает миграцию и после обновления явно помечена; прежние конфликтующие требования видны как конфликт; новые
// записи проходят проверки 0020. Данные этапа 08 до 0020 пишутся SQL в форме 0019 (код HEAD уже знает 0020).
// R08-03: обновление 0020 → 0021 — ложный конфликт `100` / `100.0` исчезает, пояснение прежней ревизии остаётся в
// истории; записи, равные только без внутренних пробелов (`5x10` / `5 x 10`), после 0021 показываются конфликтом.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createRequirementCandidate, dropDatabase, migrate, MIGRATIONS_DIR, setupDatabase } from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { ADMIN_URL, idem, makeWorker, testConfig, type ITestDb } from './helpers.ts';
import { buildStage08, confirm, propose, supports, type IStage08 } from './requirementFixtures.ts';

const name = `kontur_kp_test_upgrade20_${Date.now().toString(36)}`;
const urlFor = (user: string): string => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = '';
  u.pathname = `/${name}`;
  return u.toString();
};

const migrateTo = async (max: number): Promise<number> => {
  const dir = mkdtempSync(join(tmpdir(), `kontur-mig20-${max}-`));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
  await m.connect();
  try {
    return (await migrate(m, { testMode: true, dir })).length;
  } finally {
    await m.end();
  }
};

let db: ITestDb;
let hub: IFakeTenderHub;
let st: IStage08;
let calc1: string;

beforeAll(async () => {
  await setupDatabase(ADMIN_URL, name);
  expect(await migrateTo(19)).toBe(19);
  db = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.tenders.set(TH.tender, standardTender());
  const config = tenderHubConfig(testConfig(), hub);
  await new BlobStore(config.storageRoot).ensureDirs();
  st = await buildStage08(db, config);
  const boss = await adminMember(db, st.s, st.app, st.s.tenderA);
  await linkSource(boss, st.s.stageA, TH.tender);
  const cap = await captureNow(db, makeWorker(db, config), st.s.eng1, st.s.stageA);
  expect(cap.status).toBe('complete');
  calc1 = cap.revisionId as string;
});
afterAll(async () => {
  await hub.close();
  await db.pool.end();
  await dropDatabase(ADMIN_URL, name);
});

// Подтверждение кандидата в форме 0019 (без conflict_note): требование, ревизия, основания ревизии.
const confirm19 = async (c: pg.PoolClient, candidateId: string, code: string): Promise<{ requirementId: string; revisionId: string }> => {
  const m = st.s.ids.manager;
  const cand = (await c.query('SELECT * FROM requirement_candidate WHERE id = $1', [candidateId])).rows[0];
  await c.query("UPDATE requirement_candidate SET status = 'confirmed', decided_by = $2, decided_at = now(), updated_at = now(), row_version = row_version + 1 WHERE id = $1", [candidateId, m]);
  const revisionId = (await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  const q = await c.query<{ id: string }>('INSERT INTO requirement (tender_id, stage_id, code, current_revision_id) VALUES ($1, $2, $3, $4) RETURNING id', [cand.tender_id, cand.stage_id, code, revisionId]);
  await c.query(
    `INSERT INTO requirement_revision (id, requirement_id, tender_id, stage_id, registry_id, seq, status, change_kind, candidate_id, statement, parameters,
                                       object_scope, authored_by, confirmed_by, content_sha256)
     VALUES ($1, $2, $3, $4, $5, 1, 'confirmed', 'confirmation', $6, $7, $8, $9, $10, $11, repeat('0', 64))`,
    [revisionId, q.rows[0]!.id, cand.tender_id, cand.stage_id, cand.registry_id, candidateId, cand.statement, JSON.stringify(cand.parameters), JSON.stringify(cand.object_scope), cand.created_by, m],
  );
  await c.query('INSERT INTO evidence_link (tender_id, fragment_id, role, requirement_revision_id, created_by) SELECT tender_id, fragment_id, role, $1, $2 FROM evidence_link WHERE requirement_candidate_id = $3', [revisionId, m, candidateId]);
  return { requirementId: q.rows[0]!.id, revisionId };
};

const tx = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};

const candidate = (statement: string, parameters: object[], fragmentId: string) =>
  tx((c) =>
    createRequirementCandidate(c, {
      tenderId: st.s.tenderA,
      stageId: st.s.stageA,
      registryId: st.registryId,
      userId: st.s.ids.eng1,
      statement,
      parameters: parameters as never,
      objectScope: {},
      rationale: null,
      evidence: [{ fragmentId, role: 'supports' }],
      targetRequirementId: null,
      derivedFromCandidateId: null,
    }),
  );

describe('обновление схемы 0019 → 0020 (R08-01)', () => {
  it('прежние оценки покрытия получают статус единиц, прежние конфликты видны; новые записи — по правилам 0020', async () => {
    // Данные 0019: «покрыто» с несовпадением единиц и два конфликтующих требования без пояснения.
    const c1 = await candidate('Утепление стен — 120 м²', [{ name: 'Площадь утепления', value: '120', unit: 'м²' }], st.frag.facade);
    const c2 = await candidate('Класс бетона — B30', [{ name: 'Класс бетона', value: 'B30', unit: null }], st.frag.waterproofing);
    const c3 = await candidate('Класс бетона — B40', [{ name: 'Класс бетона', value: 'B40', unit: null }], st.frag.roof);
    const r1 = await tx((c) => confirm19(c, c1, 'R-0001'));
    const r2 = await tx((c) => confirm19(c, c2, 'R-0002'));
    const r3 = await tx((c) => confirm19(c, c3, 'R-0003'));
    await tx(async (c) => {
      const cov = await c.query<{ id: string }>(
        "INSERT INTO requirement_coverage (tender_id, stage_id, requirement_revision_id, seq, state, origin, assessed_by) VALUES ($1, $2, $3, 1, 'covered', 'human', $4) RETURNING id",
        [st.s.tenderA, st.s.stageA, r1.revisionId, st.s.ids.manager],
      );
      await c.query(
        "INSERT INTO requirement_coverage_object (coverage_id, tender_id, object_type, calculation_revision_id, external_position_id, external_item_id, match) VALUES ($1, $2, 'calculation_revision', $3, $4, $5, 'explicit_line')",
        [cov.rows[0]!.id, st.s.tenderA, calc1, TH.p1, TH.l2],
      );
      await c.query("INSERT INTO requirement_coverage_object (coverage_id, tender_id, object_type, note) VALUES ($1, $2, 'manual_confirmation', 'проверено')", [cov.rows[0]!.id, st.s.tenderA]);
    });

    expect(await migrateTo(20)).toBe(1);

    const objects = await db.pool.query('SELECT object_type, requirement_units, calculation_unit, unit_status FROM requirement_coverage_object ORDER BY object_type');
    expect(objects.rows).toEqual([
      { object_type: 'calculation_revision', requirement_units: ['м2'], calculation_unit: 'м3', unit_status: 'mismatch' },
      { object_type: 'manual_confirmation', requirement_units: null, calculation_unit: null, unit_status: null },
    ]);
    // Неизменяемость объектов покрытия после заполнения восстановлена.
    const upd = await db.pool.query("UPDATE requirement_coverage_object SET unit_status = 'match' WHERE object_type = 'calculation_revision'").then(() => 'ok', (e: { code?: string }) => e.code);
    expect(upd).not.toBe('ok');

    const card1 = (await st.s.eng1.get(`/requirements/${r1.requirementId}`)).body;
    expect(card1).toMatchObject({ coverageState: 'covered', coverageUnitMismatch: true });
    expect(card1.coverage[0]).toMatchObject({ unitMismatch: true, unitMismatchReason: null });
    expect((await st.s.eng1.get(`/requirements/${r2.requirementId}`)).body).toMatchObject({ conflicts: [{ requirementId: r3.requirementId, code: 'R-0003', parameter: 'класс бетона' }], conflictNote: null });

    // Новая оценка — по правилам 0020: несовпадение без пояснения не принимается.
    const again = await st.s.manager.post(`/requirement-revisions/${r1.revisionId}/coverage`, { state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: TH.p1, externalItemId: TH.l2, match: 'explicit_line' }] }, { headers: idem() });
    expect(again.status).toBe(409);
    expect(again.body.current.reason).toBe('unit_mismatch');
  });

  it('0020 → 0021 (R08-03): ложный конфликт числа исчезает, пояснение остаётся в истории; новые подтверждения — по ключу 0021', async () => {
    const make = async (statement: string, name: string, value: string, unit: string | null, fragment: string, body: object = {}) => {
      const c = await propose(st.s.eng1, st.registryId, statement, supports(fragment), { parameters: [{ name, value, unit }] });
      return { candidateId: c.id, result: await confirm(st.s.manager, c.id, body) };
    };
    // На 0020: 100 и 100.0 мм — ложный конфликт, подтверждение только с пояснением; 5x10 и 5 x 10 — «равны».
    const a = await make('Толщина стены — 100 мм', 'Толщина стены', '100', 'мм', st.frag.facade);
    expect(a.result.status, a.result.text).toBe(200);
    const b = await make('Толщина стены — 100.0 мм', 'Толщина стены', '100.0', 'мм', st.frag.note);
    expect(b.result.status).toBe(409);
    const bNoted = await confirm(st.s.manager, b.candidateId, { conflictNote: 'ложный конфликт 0020' });
    expect(bNoted.status, bNoted.text).toBe(200);
    const g1 = await make('Сетка — 5x10', 'Шаг сетки', '5x10', null, st.frag.facade);
    const g2 = await make('Сетка — 5 x 10', 'Шаг сетки', '5 x 10', null, st.frag.note);
    expect([g1.result.status, g2.result.status]).toEqual([200, 200]);

    expect(await migrateTo(21)).toBe(1);

    const cardA = (await st.s.eng1.get(`/requirements/${a.result.body.requirementId}`)).body;
    const cardB = (await st.s.eng1.get(`/requirements/${bNoted.body.requirementId}`)).body;
    expect(cardA.conflicts).toEqual([]);
    expect(cardB).toMatchObject({ conflicts: [], conflictNote: 'ложный конфликт 0020' });
    // Внутренние пробелы текста больше не удаляются: конфликт становится видимым.
    const cardG2 = (await st.s.eng1.get(`/requirements/${g2.result.body.requirementId}`)).body;
    expect(cardG2.conflicts).toEqual([{ requirementId: g1.result.body.requirementId, code: expect.stringMatching(/^R-/u), parameter: 'шаг сетки' }]);
    // Новое подтверждение 100,00 мм — без пояснения.
    const c = await make('Толщина стены — 100,00 мм', 'Толщина стены', '100,00', 'мм', st.frag.roof);
    expect(c.result.status, c.result.text).toBe(200);
  });
});
