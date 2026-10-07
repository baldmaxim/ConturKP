// Регрессии Review 12-2 (docs/reviews/12-review-2.md). Написаны до исправления продукта; на коде f37a12c сценарий
// одновременных команд падает (взаимная блокировка, HTTP 500), последовательный контроль проходит и до, и после.
// R12-04: правка поля «заполненного» приложения и сборка комплекта с ним, наложенные во времени, выполняются
// последовательно — правка 200, сборка 201 или предусмотренный 409; внутренней ошибки нет. Правка приостанавливается
// штатно: тест держит ту же advisory-блокировку версии поля, которую правка берёт после блокировки приложения; через
// pg_stat_activity проверяется, что сборка действительно ждёт, затем правка продолжается. SQL продукта не подменяется.
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPgError } from '../apps/server/src/http/errors.ts';
import { buildEcon, closeEcon, type IEcon } from './economicsFixtures.ts';
import { act, createDraft, demoSchema, draftOf, fieldOf, fillAll, KP_FILLED } from './formsFixtures.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { completeDraft, requireConverter, SAMPLES, templateWithMarkedSample } from './releaseFixtures.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let db: ITestDb;
let e: IEcon;
let revisionId = '';

const filled = async (title: string): Promise<string> => {
  const d = await createDraft(e.s.eng1, e.s.stageA, revisionId, title);
  await fillAll(e.s.eng1, d.id, KP_FILLED);
  await completeDraft(e.s.eng1, d.id);
  return d.id;
};

// Сколько других сеансов этой БД ждут блокировку (строки, транзакции или advisory).
const waiting = async (): Promise<number> =>
  (
    await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
    )
  ).rows[0]!.n;

const until = async (cond: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  requireConverter();
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
  const doc = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
  await seedEvidenceRun(db.pool, doc, { pages: [{ blocks: ['Техническое задание.'] }] });
  await setWorkingSet(e.s.manager, e.s.stageA, [doc], true);
  await fixScope(e.s.manager, e.s.stageA);
  revisionId = (await templateWithMarkedSample(e.s.manager, { name: 'Письмо КП (Review 12-2)', schema: demoSchema('demo-kp-letter'), marked: SAMPLES.letterMarked, original: SAMPLES.letterOriginal })).revision.id;
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});
beforeEach(async () => {
  await drain(e.worker);
});

describe('R12-04 — правка поля и сборка комплекта одновременно', () => {
  it('контроль: последовательно — правка 200, затем сборка 409 drafts_not_complete', async () => {
    const d = await filled('Последовательно');
    const f = fieldOf(await draftOf(e.s.eng1, d), 'subject');
    expect((await act(e.s.eng1, d, 'subject', f.etag, { action: 'set', value: 'Новый предмет', bases: [] })).status).toBe(200);
    const r = await e.s.eng1.post(`/stages/${e.s.stageA}/release-candidates`, { mode: 'test', draftIds: [d] }, { headers: idem() });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('drafts_not_complete');
  });

  it('наложение: правка держит приложение, сборка ждёт — без взаимной блокировки и HTTP 500; правка 200, сборка 201 или 409', async () => {
    const d = await filled('Одновременно');
    const f = fieldOf(await draftOf(e.s.eng1, d), 'subject');
    const hold: pg.PoolClient = await db.pool.connect();
    let put: Promise<{ status: number; text: string }> | null = null;
    let post: Promise<{ status: number; text: string; body: { current?: { reason?: string } } }> | null = null;
    try {
      await hold.query('BEGIN');
      // Та же блокировка версии поля, что берёт правка после блокировки приложения (formDrafts.runFieldAction).
      await hold.query("SELECT pg_advisory_xact_lock(hashtext('draft_field_version'), hashtext($1::text))", [f.fieldId]);
      const before = await waiting();
      put = act(e.s.eng1, d, 'subject', f.etag, { action: 'set', value: 'Изменённый предмет', bases: [] }).then((r) => r);
      await until(async () => (await waiting()) >= before + 1, 'правка ждёт блокировку версии поля');
      post = e.s.eng1.post(`/stages/${e.s.stageA}/release-candidates`, { mode: 'test', draftIds: [d] }, { headers: idem() }).then((r) => r);
      await until(async () => (await waiting()) >= before + 2, 'сборка ждёт блокировку, занятую правкой');
    } finally {
      await hold.query('COMMIT').catch(() => undefined);
      hold.release();
    }
    const [p, c] = await Promise.all([put!, post!]);
    expect(p.status, p.text).toBe(200);
    expect([201, 409], c.text).toContain(c.status);
    if (c.status === 409) expect(c.body.current?.reason).toBe('drafts_not_complete');
    // Итог согласован: приложение в работе (правка прошла); собранного кандидата по прежнему значению нет.
    expect((await draftOf(e.s.eng1, d)).status).toBe('in_progress');
    if (c.status === 201) {
      await drain(e.worker);
      const v = (await e.s.eng1.get(`/release-candidates/${(c.body as unknown as { id: string }).id}`)).body as { current: boolean };
      expect(v.current).toBe(false);
    }
  });

  it('проигранная гонка с взаимной блокировкой — управляемый конфликт, а не внутренняя ошибка', () => {
    const err = fromPgError({ code: '40P01', message: 'deadlock detected' });
    expect(err?.status).toBe(409);
    expect(err?.code).toBe('STATE_CONFLICT');
  });
});
