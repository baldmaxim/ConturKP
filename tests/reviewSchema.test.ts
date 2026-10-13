// Этап 09: инварианты БД миграции 0024 (09-review-checks-design.md §9) прямым SQL — вторая линия держит их без кода;
// устная реплика и подсказка переговоров не становятся согласием (A03); обновление схемы 0023 → 0025 на данных 08a.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, dropDatabase, migrate, MIGRATIONS_DIR, setupDatabase } from '../packages/db/src/index.ts';
import { ADMIN_URL, createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { negotiationManifest, postManifest } from './mailFixtures.ts';
import { addQuestionOrigin } from './legacySchema.ts';
import { buildStage08, workerWithChat } from './requirementFixtures.ts';
import { buildStage09, closeHub, cover, findings, line, requirement, RT, runReview, type IStage09 } from './reviewFixtures.ts';
import { fixScope } from './searchFixtures.ts';

let db: ITestDb;
let st: IStage09;
const ids = {} as Record<'run' | 'finding' | 'registryFinding' | 'speech' | 'hint' | 'service' | 'discrepancy', string>;

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

beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig());
  const lamp = await requirement(st, 'Светильники в коридорах — тип №1', [{ name: 'Тип светильника', value: '№1' }], [st.frag.lamp]);
  await cover(st, lamp.revisionId, { state: 'covered', objects: [line(st, RT.lamp, RT.lampLine)] });
  // Переговоры: реплика и подсказка агента (A03), затем новый снимок с транскрипцией.
  const neg = await postManifest(
    st.s.eng1,
    st.s.tenderA,
    'negotiation',
    negotiationManifest('r1', [
      { no: 1, speaker: 'S1', text: 'Рассмотрим замену светильника на №2.' },
      { no: 2, speaker: 'S2', kind: 'hint', text: 'Добиться согласия заказчика на №2.' },
    ]),
  );
  expect(neg.status, neg.text).toBe(201);
  await fixScope(st.s.manager, st.s.stageA);
  ids.speech = (await db.pool.query("SELECT id FROM evidence_fragment WHERE origin = 'negotiation_speech' LIMIT 1")).rows[0].id;
  ids.hint = (await db.pool.query("SELECT id FROM evidence_fragment WHERE origin = 'negotiation_hint' LIMIT 1")).rows[0].id;
  const run = await runReview(st);
  ids.run = run.id;
  const all = await findings(st);
  ids.finding = all.find((f) => f.kind === 'parameter_mismatch')!.id;
  ids.registryFinding = all.find((f) => f.kind === 'registry_incomplete')!.id;
  const d = await st.s.eng1.post(`/findings/${ids.finding}/discrepancy`, { topic: 'Светильник' }, { headers: idem() });
  expect(d.status, d.text).toBe(201);
  ids.discrepancy = d.body.discrepancy.id;
  ids.service = (await db.pool.query("INSERT INTO app_user (kind, service_kind, login, display_name) VALUES ('service', 'model', 'model.review', 'Модель') RETURNING id")).rows[0].id;
});
afterAll(async () => {
  await closeHub(st);
  await db.drop();
});

describe('прогон: закреплённые входы, итог по исходам', () => {
  it('завершённый прогон неизменен; входы неизменны; удаления нет', async () => {
    expect(await q("UPDATE review_run SET status = 'running' WHERE id = $1", [ids.run])).toBe('55000');
    expect(await q("UPDATE review_run SET rules_version = 'x' WHERE id = $1", [ids.run])).toBe('55000');
    expect(await q('DELETE FROM review_run WHERE id = $1', [ids.run])).toBe('42501');
    // Неизменяемые таблицы: у роли приложения нет UPDATE (первая преграда), триггер — вторая.
    expect(await q("UPDATE review_check_result SET outcome = 'passed' WHERE run_id = $1", [ids.run])).toBe('42501');
  });

  it('«завершён» — только со всеми исходами и без пробелов; исход пишет только выполняющийся прогон', async () => {
    const r = await st.s.eng1.post(`/stages/${st.s.stageA}/review-runs`, {}, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    const id = r.body.id as string;
    expect(await q("INSERT INTO review_check_result (run_id, check_code, outcome) VALUES ($1, 'processing', 'passed')", [id])).toBe('23514');
    expect(await q("UPDATE review_run SET status = 'completed', finished_at = now() WHERE id = $1", [id])).toBe('23514');
    expect(await q("UPDATE review_run SET status = 'running', started_at = now() WHERE id = $1", [id])).toBe('ok');
    expect(await q("INSERT INTO review_check_result (run_id, check_code, outcome) VALUES ($1, 'processing', 'incomplete')", [id])).toBe('23514');
    const allPassed = (c: pg.PoolClient) => c.query("INSERT INTO review_check_result (run_id, check_code, outcome) SELECT $1, code, 'passed' FROM review_check WHERE code <> 'model_hypotheses'", [id]);
    // Неполная проверка гипотез — «завершён» отвергается в конце транзакции.
    expect(
      await tx(async (c) => {
        await allPassed(c);
        await c.query("INSERT INTO review_check_result (run_id, check_code, outcome, reason) VALUES ($1, 'model_hypotheses', 'incomplete', 'нет модели')", [id]);
        await c.query("UPDATE review_run SET status = 'completed', finished_at = now() WHERE id = $1", [id]);
      }),
    ).toBe('23514');
    // Не все проверки — тоже отказ.
    expect(await tx(async (c) => {
      await allPassed(c);
      await c.query("UPDATE review_run SET status = 'completed', finished_at = now() WHERE id = $1", [id]);
    })).toBe('23514');
    expect(await tx(async (c) => {
      await allPassed(c);
      await c.query("INSERT INTO review_check_result (run_id, check_code, outcome, reason) VALUES ($1, 'model_hypotheses', 'incomplete', 'нет модели')", [id]);
      await c.query("UPDATE review_run SET status = 'completed_with_gaps', finished_at = now() WHERE id = $1", [id]);
    })).toBe('ok');
    await drain(st.worker);
  });
});

describe('замечание: журнал, переходы, авторы', () => {
  it('содержание неизменно; изменение без события — отказ в конце транзакции; удаления нет', async () => {
    expect(await q("UPDATE finding SET title = 'иначе' WHERE id = $1", [ids.finding])).toBe('55000');
    expect(await q("UPDATE finding SET severity = 'critical' WHERE id = $1", [ids.finding])).toBe('23514');
    expect(await q("UPDATE finding SET status = 'rejected' WHERE id = $1", [ids.finding])).toBe('23514');
    expect(await q('DELETE FROM finding WHERE id = $1', [ids.finding])).toBe('42501');
    expect(await q("UPDATE finding_event SET reason = 'x' WHERE finding_id = $1", [ids.finding])).toBe('42501');
  });

  const event = (c: pg.PoolClient, findingId: string, kind: string, to: string, actor: string | null, extra: { reason?: string; decision?: string; sie?: string } = {}) =>
    c.query(
      `INSERT INTO finding_event (finding_id, tender_id, seq, event_kind, to_value, reason, actor_kind, actor_user_id, decision_id, stage_input_event_id)
       VALUES ($1, $2, (SELECT max(seq) + 1 FROM finding_event WHERE finding_id = $1), $3, $4, $5, $6, $7, $8, $9)`,
      [findingId, st.s.tenderA, kind, to, extra.reason ?? null, actor ? 'human' : 'system', actor, extra.decision ?? null, extra.sie ?? null],
    );

  it('«решено» — только с решением; система не меняет статус кроме «устарело»; модель (сервис) не ведёт замечания', async () => {
    expect(await tx((c) => event(c, ids.finding, 'status', 'resolved', st.s.ids.eng1!, { reason: 'x' }))).toBe('23514');
    expect(await tx((c) => event(c, ids.finding, 'status', 'rejected', null, { reason: 'x' }))).toBe('42501');
    expect(await tx((c) => event(c, ids.finding, 'severity', 'critical', ids.service))).toBe('42501');
    // Человек с правом: событие и изменение в одной транзакции.
    expect(
      await tx(async (c) => {
        await event(c, ids.finding, 'severity', 'critical', st.s.ids.eng1!);
        await c.query("UPDATE finding SET severity = 'critical', row_version = row_version + 1 WHERE id = $1", [ids.finding]);
      }),
    ).toBe('ok');
    // Машина состояний §10: «открыто → отклонено» (с причиной) допускается, «отклонено → открыто» — нет.
    expect(
      await tx(async (c) => {
        await event(c, ids.finding, 'status', 'rejected', st.s.ids.eng1!, { reason: 'не проблема' });
        await c.query("UPDATE finding SET status = 'rejected', row_version = row_version + 1 WHERE id = $1", [ids.finding]);
      }),
    ).toBe('ok');
    expect(
      await tx(async (c) => {
        await event(c, ids.finding, 'status', 'open', st.s.ids.eng1!);
        await c.query("UPDATE finding SET status = 'open', row_version = row_version + 1 WHERE id = $1", [ids.finding]);
      }),
    ).toBe('23514');
  });

  it('принятие риска: решение руководителя, не для технических замечаний; инженер — отказ', async () => {
    const decision = (c: pg.PoolClient, findingId: string, by: string) =>
      c.query(
        `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
         VALUES ($1, $2, 'finding', $3, 'finding_risk_acceptance', 'риск', 'причина', $4)`,
        [st.s.tenderA, st.s.stageA, findingId, by],
      );
    expect(await tx((c) => decision(c, ids.finding, st.s.ids.eng1!))).toBe('42501');
    expect(await tx((c) => decision(c, ids.registryFinding, st.s.ids.manager!))).toBe('23514');
    expect(await tx((c) => decision(c, ids.finding, st.s.ids.manager!))).toBe('ok');
  });

  it('конфликт источников — только с обеими сторонами; одно действующее замечание на условие', async () => {
    const key = 'a'.repeat(64);
    const insert = (c: pg.PoolClient, k: string, kind: string) =>
      c.query(
        `WITH f AS (INSERT INTO finding (tender_id, stage_id, finding_key, kind, origin, title, severity, confidence, created_by, created_input_version)
                    VALUES ($1, $2, $3, $4, 'human', 'конфликт', 'major', 'low', $5, 0) RETURNING id)
         INSERT INTO finding_event (finding_id, tender_id, seq, event_kind, to_value, actor_kind, actor_user_id) SELECT id, $1, 1, 'created', 'open', 'human', $5 FROM f`,
        [st.s.tenderA, st.s.stageA, k, kind, st.s.ids.eng1],
      );
    expect(await tx((c) => insert(c, key, 'source_conflict'))).toBe('23514');
    expect(await tx((c) => insert(c, key, 'human'))).toBe('ok');
    expect(await tx((c) => insert(c, key, 'human'))).toBe('23505');
    // Правило ставит критичность только по таблице владельца.
    expect(
      await q(
        `INSERT INTO finding (tender_id, stage_id, finding_key, kind, check_code, origin, title, severity, confidence, first_run_id, created_input_version)
         VALUES ($1, $2, $3, 'coverage_gap', 'coverage', 'rule', 'x', 'critical', 'high', $4, 0)`,
        [st.s.tenderA, st.s.stageA, 'b'.repeat(64), ids.run],
      ),
    ).toBe('23514');
  });
});

describe('оси разногласия (I08, I09, A03)', () => {
  const axis = (c: pg.PoolClient, value: string, axisName: string, by: string, bases: [string, string][]) =>
    c
      .query(
        `INSERT INTO discrepancy_status_event (discrepancy_id, tender_id, seq, axis, value, reason, actor_user_id)
         VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM discrepancy_status_event WHERE discrepancy_id = $1), $3, $4, 'причина', $5) RETURNING id`,
        [ids.discrepancy, st.s.tenderA, axisName, value, by],
      )
      .then(async (r) => {
        for (const [type, id] of bases) {
          const col = type === 'fragment' ? 'fragment_id' : type === 'mail_message_revision' ? 'mail_message_revision_id' : 'document_revision_id';
          await c.query(`INSERT INTO discrepancy_basis (event_id, tender_id, basis_type, ${col}) VALUES ($1, $2, $3, $4)`, [r.rows[0].id, st.s.tenderA, type, id]);
        }
      });

  it('A03: подсказка переговоров — не основание; реплика даёт не больше «обсуждено устно»', async () => {
    expect(await tx((c) => axis(c, 'discussed_orally', 'customer_position', st.s.ids.eng1!, [['fragment', ids.hint]]))).toBe('23514');
    expect(await tx((c) => axis(c, 'agreed_in_writing', 'customer_position', st.s.ids.eng1!, [['fragment', ids.speech]]))).toBe('23514');
    expect(await tx((c) => axis(c, 'discussed_orally', 'customer_position', st.s.ids.eng1!, [['fragment', ids.speech]]))).toBe('ok');
    // То же через API: первая линия.
    const api = await st.s.eng1.post(`/discrepancies/${ids.discrepancy}/status-events`, { axis: 'customer_position', value: 'agreed_in_writing', reason: 'на встрече', bases: [{ type: 'fragment', id: ids.speech }] }, { headers: idem() });
    expect(api.status).toBe(409);
    expect(api.body.current.reason).toBe('written_basis_required');
    const hint = await st.s.eng1.post(`/discrepancies/${ids.discrepancy}/status-events`, { axis: 'customer_position', value: 'discussed_orally', reason: 'агент', bases: [{ type: 'fragment', id: ids.hint }] }, { headers: idem() });
    expect(hint.status).toBe(409);
    expect(hint.body.current.reason).toBe('hint_not_basis');
  });

  it('значение — из словаря оси; письменное основание для согласия; закрепление — документом нужного вида; автор — человек с правом', async () => {
    expect(await tx((c) => axis(c, 'reflected', 'customer_position', st.s.ids.eng1!, []))).toBe('23514');
    expect(await tx((c) => axis(c, 'agreed_in_writing', 'customer_position', st.s.ids.eng1!, [['mail_message_revision', st.mailRevisionId]]))).toBe('ok');
    expect(await tx((c) => axis(c, 'fixed_in_contract', 'documents', st.s.ids.eng1!, [['fragment', st.frag.lamp]]))).toBe('23514');
    expect(await tx((c) => axis(c, 'fixed_in_contract', 'documents', st.s.ids.eng1!, [['fragment', st.frag.power]]))).toBe('ok');
    expect(await tx((c) => axis(c, 'reflected', 'calculation', ids.service, []))).toBe('42501');
    expect(await q('UPDATE discrepancy_status_event SET value = $2 WHERE discrepancy_id = $1', [ids.discrepancy, 'unknown'])).toBe('42501');
  });
});

describe('зависимости, инвалидация, приоритет, гипотезы', () => {
  it('зависимости и отметки неизменяемы; отметка — по событию своего этапа', async () => {
    expect(await q('UPDATE evidence_dependency SET depends_on_type = $1 WHERE dependent_id = $2', ['fragment', ids.finding])).toBe('42501');
    const otherStageEvent = (await db.pool.query('SELECT id FROM stage_input_event WHERE stage_id = $1 LIMIT 1', [st.s.stageB])).rows[0]?.id ?? null;
    if (otherStageEvent) {
      expect(
        await q("INSERT INTO evidence_invalidation (tender_id, stage_id, dependent_type, dependent_id, stage_input_event_id, mode, reason) VALUES ($1, $2, 'finding', $3, $4, 'exact', 'x')", [
          st.s.tenderA,
          st.s.stageA,
          ids.finding,
          otherStageEvent,
        ]),
      ).toBe('23514');
    }
    expect((await db.pool.query("SELECT count(*)::int AS n FROM evidence_dependency WHERE dependent_type = 'finding' AND dependent_id = $1", [ids.finding])).rows[0].n).toBeGreaterThan(0);
  });

  it('приоритет: ревизии меняет руководитель; восемь видов ровно по разу', async () => {
    const kinds = ['contract', 'tz', 'qa_answer', 'customer_letter', 'pd_rd', 'minutes', 'negotiation_speech', 'other'];
    const ins = (by: string, k: string[]) => q('INSERT INTO source_priority_revision (tender_id, seq, kinds, reason, created_by) VALUES ($1, 1, $2, $3, $4)', [st.s.tenderA, k, 'причина', by]);
    expect(await ins(st.s.ids.eng1!, kinds)).toBe('42501');
    expect(await ins(st.s.ids.manager!, [...kinds.slice(0, 7), 'tz'])).toBe('23514');
    expect(await ins(st.s.ids.manager!, kinds)).toBe('ok');
  });

  it('гипотезу пишет только выполняющийся прогон с моделью; принимает человек с правом', async () => {
    expect(
      await q("INSERT INTO model_suggestion (tender_id, stage_id, run_id, request_id, kind, title, rationale) VALUES ($1, $2, $3, $4, 'discrepancy_hypothesis', 't', 'r')", [
        st.s.tenderA,
        st.s.stageA,
        ids.run,
        'c'.repeat(64),
      ]),
    ).toBe('23514');
  });
});

describe('обновление схемы 0023 → 0025', () => {
  it('данные этапов 08 и 08a переживают 0024 и 0025; на обновлённой базе прогон проверки работает', async () => {
    const name = `kontur_kp_test_upgrade24_${Date.now().toString(36)}`;
    const urlFor = (user: string): string => {
      const u = new URL(ADMIN_URL);
      u.username = user;
      u.password = '';
      u.pathname = `/${name}`;
      return u.toString();
    };
    const migrateTo = async (max: number): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), `kontur-mig24-${max}-`));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
      const mc = new pg.Client({ connectionString: urlFor('kontur_migrator') });
      await mc.connect();
      try {
        return (await migrate(mc, { testMode: true, dir })).length;
      } finally {
        await mc.end();
      }
    };
    const config = testConfig();
    await setupDatabase(ADMIN_URL, name);
    const up: ITestDb = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
    try {
      expect(await migrateTo(23)).toBe(23);
      await addQuestionOrigin(up.migratorUrl);
      const s08 = await buildStage08(up, config);
      const before = (await up.pool.query('SELECT count(*)::int AS n FROM requirement_registry')).rows[0].n;
      expect(await migrateTo(25)).toBe(2);
      expect((await up.pool.query('SELECT count(*)::int AS n FROM requirement_registry')).rows[0].n).toBe(before);
      expect((await up.pool.query('SELECT count(*)::int AS n FROM review_check')).rows[0].n).toBe(12);
      const r = await s08.s.eng1.post(`/stages/${s08.s.stageA}/review-runs`, {}, { headers: idem() });
      expect(r.status, r.text).toBe(201);
      await drain(workerWithChat(up, config, null, 'upgrade-24'));
      const v = await s08.s.eng1.get(`/review-runs/${r.body.id}`);
      expect(v.status, v.text).toBe(200);
      expect(v.body.status).toBe('completed_with_gaps');
      expect(v.body.checks.find((c: { code: string }) => c.code === 'model_hypotheses').outcome).toBe('incomplete');
    } finally {
      await up.pool.end();
      await dropDatabase(ADMIN_URL, name);
    }
  });
});
