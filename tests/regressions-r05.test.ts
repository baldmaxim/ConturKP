// R05-01 (Review 05-1): состав снимка области доказательств неизменен на уровне БД (миграция 0010,
// data-model §4.3, state-machines §5.1). У kontur_app есть INSERT на evidence_scope и evidence_scope_item,
// поэтому проверяется сама БД: в зафиксированный снимок единицу не вставить, неполный состав и хэш,
// не совпадающий с составом, не фиксируются, параллельное создание одного состава не оставляет
// частично заполненного снимка.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvidenceScope, latestFrozenRevision, planEvidenceScope } from '../packages/db/src/index.ts';
import { buildScenario, createTestDb, idem, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig();
const ids: Record<string, string> = {};

const INSERT_ITEM = `INSERT INTO evidence_scope_item (scope_id, tender_id, unit_type, document_revision_id, recognition_run_id, inclusion_reason)
                     VALUES ($1, $2, 'document_recognition', $3, $4, 'source_set_included')`;

interface IScopeState {
  contentHash: string;
  // Хэш, пересчитанный БД по фактическому составу (evidence_scope_composition_hash).
  recomputed: string;
  items: { document_revision_id: string; recognition_run_id: string | null }[];
}

const scopeState = async (scopeId: string): Promise<IScopeState> => {
  const h = await db.pool.query<{ content_hash: string; recomputed: string }>(
    'SELECT content_hash, evidence_scope_composition_hash(id) AS recomputed FROM evidence_scope WHERE id = $1',
    [scopeId],
  );
  const items = await db.pool.query<{ document_revision_id: string; recognition_run_id: string | null }>(
    'SELECT document_revision_id, recognition_run_id FROM evidence_scope_item WHERE scope_id = $1 ORDER BY document_revision_id',
    [scopeId],
  );
  return { contentHash: h.rows[0]!.content_hash, recomputed: h.rows[0]!.recomputed, items: items.rows };
};

const scopesOf = async (stageId: string): Promise<number> =>
  (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM evidence_scope WHERE stage_id = $1', [stageId])).rows[0]!.n;

const connect = async (url: string): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

// План снимка по последней замороженной ревизии этапа — то же, что строит команда POST /evidence-scopes.
const scopeSpec = async (stageId: string) => {
  const base = (await latestFrozenRevision(db.pool, stageId))!;
  const plan = await planEvidenceScope(db.pool, { id: base.id, content_hash: base.content_hash! });
  return {
    stageId,
    tenderId: s.tenderA,
    sourceSetRevisionId: base.id,
    inputVersion: 0,
    contentHash: plan.contentHash,
    createdBy: s.ids.eng1,
    units: plan.units,
  };
};

// Ждёт, пока транзакция с этим pid встанет в ожидание чужой транзакции (уникальность снимка).
const waitBlocked = async (pid: number): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    const r = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'transactionid' AND NOT granted", [pid]);
    if (r.rows[0]!.n > 0) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`транзакция ${pid} не встала в ожидание`);
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  // Этап A1: три редакции с завершёнными прогонами, состав заморожен.
  for (const n of [1, 2, 3]) {
    ids[`rev${n}`] = await uploadDocument(db, config, s.eng1, s.stageA, `Раздел-${n}.pdf`);
    ids[`run${n}`] = await seedEvidenceRun(db.pool, ids[`rev${n}`]!, { pages: [{ blocks: [`Текст раздела ${n}`] }] });
  }
  await setWorkingSet(s.eng1, s.stageA, [ids.rev1!, ids.rev2!, ids.rev3!], true);
  // Этап A2 — для параллельного создания: две редакции, состав заморожен.
  const stage = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'Этап A2' }, { headers: idem() });
  expect(stage.status, stage.text).toBe(201);
  ids.stageC = stage.body.id;
  for (const n of [4, 5]) {
    ids[`rev${n}`] = await uploadDocument(db, config, s.eng1, ids.stageC!, `Раздел-${n}.pdf`);
    ids[`run${n}`] = await seedEvidenceRun(db.pool, ids[`rev${n}`]!, { pages: [{ blocks: [`Текст раздела ${n}`] }] });
  }
  await setWorkingSet(s.eng1, ids.stageC!, [ids.rev4!, ids.rev5!], true);
});
afterAll(async () => db.drop());

describe('R05-01: снимок области создаётся целиком и после фиксации не расширяется', () => {
  it('штатное создание снимка с несколькими единицами проходит; content_hash равен хэшу, пересчитанному БД по составу', async () => {
    const r = await s.eng1.post(`/stages/${s.stageA}/evidence-scopes`, {}, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    ids.scope = r.body.id;
    expect(r.body.items.map((i: { recognitionRunId: string }) => i.recognitionRunId).sort()).toEqual([ids.run1, ids.run2, ids.run3].sort());
    const state = await scopeState(ids.scope!);
    expect(state.items).toHaveLength(3);
    expect(state.recomputed).toBe(state.contentHash);
    expect(state.contentHash).toBe(r.body.contentHash);
  });

  it('повторное создание того же состава возвращает существующий снимок без изменения состава', async () => {
    const before = await scopeState(ids.scope!);
    const repeat = await s.eng1.post(`/stages/${s.stageA}/evidence-scopes`, {}, { headers: idem() });
    expect(repeat.status, repeat.text).toBe(200);
    expect(repeat.body).toMatchObject({ id: ids.scope, reused: true, contentHash: before.contentHash });
    // Слой данных напрямую: тот же состав — та же строка, created = false.
    expect(await createEvidenceScope(db.pool, await scopeSpec(s.stageA))).toEqual({ id: ids.scope, created: false });
    expect(await scopeState(ids.scope!)).toEqual(before);
    expect(await scopesOf(s.stageA)).toBe(1);
  });

  it('прямой INSERT допустимой единицы в зафиксированный снимок отклоняется БД; состав и content_hash не меняются', async () => {
    // Допустимые по правилам 0009 единицы: новый завершённый прогон включённой редакции и новая редакция этапа.
    ids.run1b = await seedEvidenceRun(db.pool, ids.rev1!, { pages: [{ blocks: ['Текст раздела 1, уточнённое распознавание'] }] });
    ids.rev6 = await uploadDocument(db, config, s.eng1, s.stageA, 'Раздел-6.pdf');
    ids.run6 = await seedEvidenceRun(db.pool, ids.rev6!, { pages: [{ blocks: ['Текст раздела 6'] }] });
    const before = await scopeState(ids.scope!);

    // Роль приложения: у неё есть INSERT, отказ даёт триггер печати транзакции создания.
    for (const [rev, run] of [
      [ids.rev1!, ids.run1b!],
      [ids.rev6!, ids.run6!],
    ] as const) {
      await expect(db.pool.query(INSERT_ITEM, [ids.scope, s.tenderA, rev, run])).rejects.toMatchObject({
        code: '55000',
        message: expect.stringMatching(/зафиксирован — единицы добавляются только в транзакции его создания/u),
      });
    }
    // Владелец таблиц (все права): отказ тот же — защита в триггерах, а не только в правах роли.
    const owner = await connect(db.migratorUrl);
    try {
      await expect(owner.query(INSERT_ITEM, [ids.scope, s.tenderA, ids.rev1, ids.run1b])).rejects.toMatchObject({ code: '55000' });
      await expect(owner.query('UPDATE evidence_scope_item SET recognition_run_id = $2 WHERE scope_id = $1 AND document_revision_id = $3', [ids.scope, ids.run1b, ids.rev1])).rejects.toThrow(
        /запрещена/u,
      );
      await expect(owner.query('DELETE FROM evidence_scope_item WHERE scope_id = $1', [ids.scope])).rejects.toThrow(/запрещена/u);
    } finally {
      await owner.end();
    }
    await expect(db.pool.query('UPDATE evidence_scope_item SET inclusion_reason = inclusion_reason WHERE scope_id = $1', [ids.scope])).rejects.toThrow(/permission denied/u);
    await expect(db.pool.query('DELETE FROM evidence_scope_item WHERE scope_id = $1', [ids.scope])).rejects.toThrow(/permission denied/u);

    expect(await scopeState(ids.scope!)).toEqual(before);
    expect(before.recomputed).toBe(before.contentHash);
  });

  it('в транзакции создания БД не фиксирует неполный состав, чужой хэш и снимок без единиц', async () => {
    // Новый состав этапа A1 (после прогона R1b и без редакции 6 — она не в основе): хэш ещё не занят.
    const spec = await scopeSpec(s.stageA);
    expect(spec.contentHash).not.toBe((await scopeState(ids.scope!)).contentHash);
    const units = spec.units;
    const c = await connect(db.appUrl);
    const insertScope = (hash: string) =>
      c.query<{ id: string }>(
        `INSERT INTO evidence_scope (stage_id, tender_id, source_set_revision_id, input_version, content_hash, created_by)
         VALUES ($1, $2, $3, 0, $4, $5) RETURNING id`,
        [spec.stageId, spec.tenderId, spec.sourceSetRevisionId, hash, spec.createdBy],
      );
    const insertUnits = (scopeId: string, list: typeof units) =>
      c.query(
        `INSERT INTO evidence_scope_item (scope_id, tender_id, unit_type, document_revision_id, recognition_run_id, inclusion_reason)
         SELECT $1, $2, 'document_recognition', u.rev, u.run, 'source_set_included' FROM unnest($3::uuid[], $4::uuid[]) AS u(rev, run)`,
        [scopeId, spec.tenderId, list.map((u) => u.documentRevisionId), list.map((u) => u.recognitionRunId)],
      );
    try {
      // Неполный состав: одна единица из трёх — отказ сразу после команды.
      await c.query('BEGIN');
      const partial = (await insertScope(spec.contentHash)).rows[0]!.id;
      await expect(insertUnits(partial, units.slice(0, 1))).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/состав неполон/u) });
      await c.query('ROLLBACK');

      // Полный состав, но хэш другого состава — отказ.
      await c.query('BEGIN');
      const forged = (await insertScope('f'.repeat(64))).rows[0]!.id;
      await expect(insertUnits(forged, units)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/content_hash не соответствует составу/u) });
      await c.query('ROLLBACK');

      // Снимок без единиц: отложенная проверка отклоняет COMMIT, строка не фиксируется.
      await c.query('BEGIN');
      await insertScope(spec.contentHash);
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/состав неполон/u) });

      // Досрочная проверка (SET CONSTRAINTS … IMMEDIATE) не открывает снимок: дописать единицу после неё нельзя.
      await c.query('BEGIN');
      const early = (await insertScope(spec.contentHash)).rows[0]!.id;
      await insertUnits(early, units);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      // Этап 05a: в снимок входит только предпочтительный прогон редакции (AD-05a-3, миграция 0014),
      // поэтому дописывается именно он — иначе раньше печати сработал бы охранник выбора прогона.
      await expect(c.query(INSERT_ITEM, [early, spec.tenderId, ids.rev1, ids.run1b])).rejects.toThrow(/evidence_scope_item_revision_key|content_hash не соответствует/u);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    expect(await scopesOf(s.stageA)).toBe(1);
  });

  it('новый состав создаёт новый неизменяемый снимок, прежний не меняется', async () => {
    const before = await scopeState(ids.scope!);
    const r = await s.eng1.post(`/stages/${s.stageA}/evidence-scopes`, {}, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    expect(r.body.id).not.toBe(ids.scope);
    const created = await scopeState(r.body.id);
    expect(created.items.map((i) => i.recognition_run_id).sort()).toEqual([ids.run1b, ids.run2, ids.run3].sort());
    expect(created.recomputed).toBe(created.contentHash);
    expect(await scopeState(ids.scope!)).toEqual(before);
    // И новый снимок после фиксации закрыт.
    await expect(db.pool.query(INSERT_ITEM, [r.body.id, s.tenderA, ids.rev6, ids.run6])).rejects.toMatchObject({ code: '55000' });
  });
});

describe('R05-01: параллельное создание одинакового снимка', () => {
  it('вторая транзакция ждёт первую и получает её снимок; до COMMIT частичный снимок никому не виден', async () => {
    const spec = await scopeSpec(ids.stageC!);
    const t1 = await connect(db.appUrl);
    const t2 = await connect(db.appUrl);
    try {
      await t1.query('BEGIN');
      const first = await createEvidenceScope(t1, spec);
      expect(first.created).toBe(true);
      // Снимок первой транзакции ещё не зафиксирован: ни строки, ни единиц другим не видно.
      expect(await scopesOf(ids.stageC!)).toBe(0);
      const pid2 = (await t2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await t2.query('BEGIN');
      const second = createEvidenceScope(t2, spec);
      await waitBlocked(pid2);
      await t1.query('COMMIT');
      expect(await second).toEqual({ id: first.id, created: false });
      await t2.query('COMMIT');
      const state = await scopeState(first.id);
      expect(state.items.map((i) => i.recognition_run_id).sort()).toEqual([ids.run4, ids.run5].sort());
      expect(state.recomputed).toBe(state.contentHash);
      expect(await scopesOf(ids.stageC!)).toBe(1);
    } finally {
      await t1.end();
      await t2.end();
    }
  });

  it('если первая транзакция откатилась, вторая создаёт снимок целиком сама', async () => {
    ids.run4b = await seedEvidenceRun(db.pool, ids.rev4!, { pages: [{ blocks: ['Текст раздела 4, уточнённое распознавание'] }] });
    const spec = await scopeSpec(ids.stageC!);
    const t1 = await connect(db.appUrl);
    const t2 = await connect(db.appUrl);
    try {
      await t1.query('BEGIN');
      const first = await createEvidenceScope(t1, spec);
      const pid2 = (await t2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await t2.query('BEGIN');
      const second = createEvidenceScope(t2, spec);
      await waitBlocked(pid2);
      await t1.query('ROLLBACK');
      const won = await second;
      expect(won.created).toBe(true);
      expect(won.id).not.toBe(first.id);
      await t2.query('COMMIT');
      const state = await scopeState(won.id);
      expect(state.items.map((i) => i.recognition_run_id).sort()).toEqual([ids.run4b, ids.run5].sort());
      expect(state.recomputed).toBe(state.contentHash);
      expect(await scopesOf(ids.stageC!)).toBe(2);
    } finally {
      await t1.end();
      await t2.end();
    }
  });

  it('две одновременные команды POST /evidence-scopes одного состава: один снимок 201, второй — 200 reused, состав полный', async () => {
    ids.run5b = await seedEvidenceRun(db.pool, ids.rev5!, { pages: [{ blocks: ['Текст раздела 5, уточнённое распознавание'] }] });
    const [a, b] = await Promise.all([
      s.eng1.post(`/stages/${ids.stageC}/evidence-scopes`, {}, { headers: idem() }),
      s.eng2.post(`/stages/${ids.stageC}/evidence-scopes`, {}, { headers: idem() }),
    ]);
    expect([a.status, b.status].sort(), `${a.text}\n${b.text}`).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    const state = await scopeState(a.body.id);
    expect(state.items.map((i) => i.recognition_run_id).sort()).toEqual([ids.run4b, ids.run5b].sort());
    expect(state.recomputed).toBe(state.contentHash);
    expect(await scopesOf(ids.stageC!)).toBe(3);
  });
});
