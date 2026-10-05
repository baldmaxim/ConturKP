// Этап 08a: инварианты БД ответного ядра (docs/architecture/08a-answer-core-design.md §9) прямым SQL — вторая линия
// держит их без кода API; и обновление схемы 0021 → 0022 на данных этапа 08.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, dropDatabase, markAnswerRunning, migrate, MIGRATIONS_DIR, setupDatabase } from '../packages/db/src/index.ts';
import { ADMIN_URL, createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { ask, askQuestion, buildAnswerStage, newDialog, workingContext, type IAnswerStage } from './answerFixtures.ts';
import { buildStage08, workerWithChat } from './requirementFixtures.ts';
import { buildIndex, searchBody } from './searchFixtures.ts';

let db: ITestDb;
let st: IAnswerStage;
const config = testConfig();
const ids = {} as Record<'dialog' | 'run' | 'fragment' | 'foreignFragment', string>;

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
// Прогон в состоянии running внутри транзакции (как у worker под арендой).
const withRunning = (fn: (c: pg.PoolClient, runId: string) => Promise<unknown>) =>
  tx(async (c) => {
    const dialog = await newDialog(st.s.eng1, workingContext(st));
    const runId = await askQuestion(st.s.eng1, dialog, 'Чем облицован фасад?');
    await markAnswerRunning(c, runId);
    await fn(c, runId);
  });

beforeAll(async () => {
  db = await createTestDb();
  st = await buildAnswerStage(db, config, { 'ТЗ.pdf': { pages: [{ blocks: ['Фасад облицовывается керамогранитом толщиной 10 мм.'] }] } });
  ids.dialog = await newDialog(st.s.eng1, workingContext(st));
  ids.run = (await ask(st, st.s.eng1, ids.dialog, 'Чем облицован фасад?')).id;
  ids.fragment = (await db.pool.query("SELECT id FROM evidence_fragment WHERE text LIKE 'Фасад облицовывается%'")).rows[0].id;
  // Фрагмент другого тендера — вне области любого прогона этапа A.
  const other = await db.pool.query('SELECT id FROM evidence_fragment WHERE tender_id IS DISTINCT FROM $1 LIMIT 1', [st.s.tenderA]);
  ids.foreignFragment = other.rows[0]?.id ?? randomUUID();
});
afterAll(async () => {
  await db.drop();
});

describe('инварианты 1–3: диалог и сообщения', () => {
  it('1. диалог и сообщения неизменяемы — для роли приложения и владельца схемы', async () => {
    // Первая линия — у роли приложения нет UPDATE/DELETE (42501); вторая — триггер (55000) и для владельца схемы.
    expect(await q("UPDATE dialog SET title = 'x' WHERE id = $1", [ids.dialog])).toBe('42501');
    expect(await q('DELETE FROM dialog_message WHERE dialog_id = $1', [ids.dialog])).not.toBe('ok');
    expect(await asOwner("UPDATE dialog_message SET text = 'x' WHERE dialog_id = $1", [ids.dialog])).toBe('55000');
    expect(await asOwner('DELETE FROM dialog WHERE id = $1', [ids.dialog])).not.toBe('ok');
  });

  it('2. вопрос пишет только автор; номер — следующий', async () => {
    const next = (await db.pool.query('SELECT max(seq) + 1 AS n FROM dialog_message WHERE dialog_id = $1', [ids.dialog])).rows[0].n;
    expect(await q("INSERT INTO dialog_message (dialog_id, seq, role, text, created_by) VALUES ($1, $2, 'user', 'чужой', $3)", [ids.dialog, next, st.s.ids.eng2])).toBe('42501');
    expect(await q("INSERT INTO dialog_message (dialog_id, seq, role, text, created_by) VALUES ($1, $2, 'user', 'пропуск', $3)", [ids.dialog, next + 5, st.s.ids.eng1])).toBe('23514');
    // Диалог без права читать тендер не создаётся.
    expect(await q("INSERT INTO dialog (context_kind, tender_id, stage_id, mode, title, created_by) VALUES ('tender', $1, $2, 'working', 't', $3)", [st.s.tenderA, st.s.stageA, st.s.ids.eng3])).toBe('42501');
  });

  it('3. сообщение ответа — только в транзакции завершения своего прогона', async () => {
    const next = (await db.pool.query('SELECT max(seq) + 1 AS n FROM dialog_message WHERE dialog_id = $1', [ids.dialog])).rows[0].n;
    expect(await q("INSERT INTO dialog_message (dialog_id, seq, role, text, answer_run_id) VALUES ($1, $2, 'assistant', 'подложный ответ', $3)", [ids.dialog, next, ids.run])).not.toBe('ok');
  });
});

describe('инварианты 4–7: прогон ответа', () => {
  it('4. один незавершённый прогон на диалог', async () => {
    const dialog = await newDialog(st.s.eng1, workingContext(st));
    const runId = await askQuestion(st.s.eng1, dialog, 'Чем облицован фасад?');
    const run = (await db.pool.query('SELECT * FROM answer_run WHERE id = $1', [runId])).rows[0];
    const search = await st.s.eng1.post('/search', searchBody(st.s.tenderA, st.s.stageA, 'фасад'), { headers: idem() });
    const result = await tx(async (c) => {
      const m = await c.query<{ id: string }>("INSERT INTO dialog_message (dialog_id, seq, role, text, created_by) VALUES ($1, 2, 'user', 'второй', $2) RETURNING id", [dialog, st.s.ids.eng1]);
      await c.query(
        `INSERT INTO answer_run (dialog_id, seq, question_message_id, search_run_id, requested_by, plan, planner_version, prompt_version, prompt_sha256, verifier_mode)
         VALUES ($1, 2, $2, $3, $4, '{}', 'p', 'p', $5, 'off')`,
        [dialog, m.rows[0]!.id, search.body.searchRunId, st.s.ids.eng1, run.prompt_sha256],
      );
    });
    expect(result).toBe('23505');
    await drain(st.worker);
  });

  it('5. завершённый прогон неизменен; переход только по машине состояний', async () => {
    expect(await q("UPDATE answer_run SET answer_status = 'citations_disagree', row_version = row_version + 1 WHERE id = $1", [ids.run])).toBe('55000');
    expect(await asOwner("UPDATE answer_run SET status = 'failed', failure_code = 'x', row_version = row_version + 1 WHERE id = $1", [ids.run])).toBe('55000');
    expect(await q('DELETE FROM answer_run WHERE id = $1', [ids.run])).not.toBe('ok');
    const dialog = await newDialog(st.s.eng1, workingContext(st));
    const runId = await askQuestion(st.s.eng1, dialog, 'Чем облицован фасад?');
    expect(
      await q(
        "UPDATE answer_run SET status = 'completed', answer_status = 'confirmed_by_citations', verification_level = 'hard_checks', started_at = now(), finished_at = now(), row_version = row_version + 1 WHERE id = $1",
        [runId],
      ),
    ).toBe('55000');
    await drain(st.worker);
  });

  it('6. completed без сообщения ответа — отказ на COMMIT; причина неполноты — только у неполноты', async () => {
    expect(
      await withRunning((c, runId) =>
        c.query(
          "UPDATE answer_run SET status = 'completed', answer_status = 'confirmed_by_citations', verification_level = 'hard_checks', finished_at = now(), row_version = row_version + 1 WHERE id = $1",
          [runId],
        ),
      ),
    ).toBe('23514');
    expect(
      await withRunning((c, runId) =>
        c.query(
          "UPDATE answer_run SET status = 'completed', answer_status = 'confirmed_by_citations', incomplete_reason = 'model_failed', verification_level = 'hard_checks', finished_at = now(), row_version = row_version + 1 WHERE id = $1",
          [runId],
        ),
      ),
    ).toBe('23514');
  });

  it('7. прогон поиска другого контекста не принимается', async () => {
    const dialog = await newDialog(st.s.eng1, workingContext(st));
    const otherStage = await st.s.manager.post(`/tenders/${st.s.tenderA}/stages`, { title: 'Этап A2' }, { headers: idem() });
    const search = await st.s.eng1.post('/search', searchBody(st.s.tenderA, otherStage.body.id, 'фасад'), { headers: idem() });
    expect(search.status, search.text).toBe(200);
    const result = await tx(async (c) => {
      const m = await c.query<{ id: string }>("INSERT INTO dialog_message (dialog_id, seq, role, text, created_by) VALUES ($1, 1, 'user', 'вопрос', $2) RETURNING id", [dialog, st.s.ids.eng1]);
      await c.query(
        `INSERT INTO answer_run (dialog_id, seq, question_message_id, search_run_id, requested_by, plan, planner_version, prompt_version, prompt_sha256, verifier_mode)
         VALUES ($1, 1, $2, $3, $4, '{}', 'p', 'p', repeat('a', 64), 'off')`,
        [dialog, m.rows[0]!.id, search.body.searchRunId, st.s.ids.eng1],
      );
    });
    expect(result).toBe('23514');
  });
});

describe('инварианты 8–11: пакет, утверждения, словарь', () => {
  it('8. основание пакета — фрагмент области прогона поиска; происхождение — как у фрагмента', async () => {
    expect(await withRunning((c, runId) => c.query("INSERT INTO answer_evidence (run_id, label, ordinal, fragment_id, origin, version_note, reason) VALUES ($1, 'E1', 1, $2, 'recognized_text', 'current', 'x')", [runId, ids.foreignFragment]))).toBe('23514');
    expect(await withRunning((c, runId) => c.query("INSERT INTO answer_evidence (run_id, label, ordinal, fragment_id, origin, version_note, reason) VALUES ($1, 'E1', 1, $2, 'model_description', 'current', 'x')", [runId, ids.fragment]))).toBe('23514');
    expect(await withRunning((c, runId) => c.query("INSERT INTO answer_evidence (run_id, label, ordinal, fragment_id, origin, version_note, reason) SELECT $1, 'E1', 1, id, origin, 'current', 'x' FROM evidence_fragment WHERE id = $2", [runId, ids.fragment]))).toBe('ok');
  });

  it('9. текст утверждения — только у показанного; показанное цитирует только пакет; хэш — от текста', async () => {
    const sha = '0'.repeat(64);
    const insert = (shown: boolean, text: string | null, labels: string[], status: string, hash = sha) =>
      withRunning(async (c, runId) => {
        await c.query("INSERT INTO answer_evidence (run_id, label, ordinal, fragment_id, origin, version_note, reason) SELECT $1, 'E1', 1, id, origin, 'current', 'x' FROM evidence_fragment WHERE id = $2", [runId, ids.fragment]);
        await c.query(
          `INSERT INTO answer_claim (run_id, claim_no, kind, text_sha256, text, labels, check_status, final_status, shown)
           VALUES ($1, 1, 'fact', $2, $3, $4, $5, $6, $7)`,
          [runId, hash, text, labels, shown ? 'passed' : 'unsupported', status, shown],
        );
      });
    expect(await insert(false, 'непроверенный текст', ['E1'], 'unsupported')).toBe('23514');
    expect(await insert(true, null, ['E1'], 'supported')).toBe('23514');
    expect(await insert(true, 'Фасад — керамогранит', ['E7'], 'supported')).toBe('23514');
    expect(await insert(true, 'Фасад — керамогранит', ['E1'], 'supported')).toBe('23514');
    expect(await insert(false, null, ['E1'], 'contradicted')).toBe('ok');
  });

  it('10. пакет и утверждения — только пока прогон выполняется', async () => {
    expect(await q("INSERT INTO answer_evidence (run_id, label, ordinal, fragment_id, origin, version_note, reason) SELECT $1, 'E9', 9, id, origin, 'current', 'x' FROM evidence_fragment WHERE id = $2", [ids.run, ids.fragment])).toBe('55000');
    expect(await q("INSERT INTO answer_claim (run_id, claim_no, kind, text_sha256, labels, check_status, final_status, shown) VALUES ($1, 9, 'fact', repeat('0', 64), '{}', 'unsupported', 'unsupported', false)", [ids.run])).toBe('55000');
    expect(await q("UPDATE answer_evidence SET version_note = 'current' WHERE run_id = $1", [ids.run])).toBe('42501');
    expect(await asOwner("UPDATE answer_claim SET shown = false WHERE run_id = $1", [ids.run])).toBe('55000');
  });

  it('11. словарь статусов ответа отделён от результатов проверки; «не предусмотрено» ядро не присваивает', async () => {
    for (const status of ['passed', 'failed', 'incomplete', 'checked']) {
      expect(await withRunning((c, runId) => c.query('UPDATE answer_run SET answer_status = $2, row_version = row_version + 1 WHERE id = $1', [runId, status]))).toBe('23514');
    }
    for (const status of ['not_provided', 'confirmed_discrepancy']) {
      expect(
        await withRunning(async (c, runId) => {
          await c.query("INSERT INTO dialog_message (dialog_id, seq, role, text, answer_run_id) SELECT dialog_id, (SELECT max(seq) + 1 FROM dialog_message m WHERE m.dialog_id = r.dialog_id), 'assistant', 'x', id FROM answer_run r WHERE id = $1", [runId]);
          await c.query("UPDATE answer_run SET status = 'completed', answer_status = $2, verification_level = 'none', finished_at = now(), row_version = row_version + 1 WHERE id = $1", [runId, status]);
        }),
      ).toBe('23514');
    }
  });
});

describe('обновление схемы 0021 → 0022', () => {
  it('данные этапа 08 переживают 0022; на обновлённой базе диалог и ответ работают', async () => {
    const name = `kontur_kp_test_upgrade22_${Date.now().toString(36)}`;
    const urlFor = (user: string): string => {
      const u = new URL(ADMIN_URL);
      u.username = user;
      u.password = '';
      u.pathname = `/${name}`;
      return u.toString();
    };
    const migrateTo = async (max: number): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), `kontur-mig22-${max}-`));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
      const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
      await m.connect();
      try {
        return (await migrate(m, { testMode: true, dir })).length;
      } finally {
        await m.end();
      }
    };
    await setupDatabase(ADMIN_URL, name);
    const up: ITestDb = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
    try {
      expect(await migrateTo(21)).toBe(21);
      const s08 = await buildStage08(up, config);
      const before = (await up.pool.query('SELECT count(*)::int AS n FROM requirement_registry')).rows[0].n;
      expect(await migrateTo(22)).toBe(1);
      expect((await up.pool.query('SELECT count(*)::int AS n FROM requirement_registry')).rows[0].n).toBe(before);
      // Код работает на последней схеме: граф фактов 0023 и проверки 0024–0025 — следом (их обновление проверяют factGraphSchema
      // и reviewSchema).
      expect(await migrateTo(25)).toBe(3);
      const worker = workerWithChat(up, config, null, 'upgrade-worker');
      await buildIndex(up, worker);
      const d = await s08.s.eng1.post('/dialogs', { context: { kind: 'tender', tenderId: s08.s.tenderA, mode: 'working', stageId: s08.s.stageA } }, { headers: idem() });
      expect(d.status, d.text).toBe(201);
      const qq = await s08.s.eng1.post(`/dialogs/${d.body.id}/messages`, { text: 'Чем облицован фасад?' }, { headers: idem() });
      expect(qq.status, qq.text).toBe(201);
      await drain(worker);
      expect((await s08.s.eng1.get(`/answer-runs/${qq.body.runId}`)).body).toMatchObject({ status: 'completed', answerStatus: 'incomplete_processing', incompleteReason: 'model_disabled' });
    } finally {
      await up.pool.end();
      await dropDatabase(ADMIN_URL, name);
    }
  });
});
