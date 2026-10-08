// Обновление схемы 0035 → 0036 (Review 13-2, R13-05). Данные этапа 13 переживают 0036. Прогон, вход которого закреплён
// прежним отпечатком v1 (так закрепляла передача 13-2), после обновления устарел: карточка — неснимаемый REVIEW_OUTDATED
// с причиной «закреплён прежним отпечатком», вторая линия БД — REVIEW_OUTDATED, свежесть прогона — с той же причиной.
// Путь «новый прогон → новый комплект → согласование → выпуск» проходит. Закрепление v1 воспроизводится правкой
// закреплённой строки суперпользователем с выключенными триггерами (session_replication_role = replica): так выглядят
// данные, записанные кодом 13-2; продукт этого не делает.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, dropDatabase, migrate, MIGRATIONS_DIR, setupDatabase } from '../packages/db/src/index.ts';
import { ADMIN_URL, drain, idem, type ITestDb } from './helpers.ts';
import { acceptAll, approve, assembled, buildStage13, closeStage13, codes, notApplicable, release, rerunReview, view, type ICandidate13, type IStage13 } from './approvalFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const name = `kontur_kp_test_upgrade35_${Date.now().toString(36)}`;
const urlFor = (user: string): string => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = '';
  u.pathname = `/${name}`;
  return u.toString();
};
const migrateTo = async (max: number): Promise<number> => {
  const dir = mkdtempSync(join(tmpdir(), `kontur-mig35-${max}-`));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  const mc = new pg.Client({ connectionString: urlFor('kontur_migrator') });
  await mc.connect();
  try {
    return (await migrate(mc, { testMode: true, dir })).length;
  } finally {
    await mc.end();
  }
};

let up: ITestDb;
let st: IStage13;
let legacyCandidate = '';

beforeAll(async () => {
  await setupDatabase(ADMIN_URL, name);
  up = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
  expect(await migrateTo(35)).toBe(35);
  st = await buildStage13({ db: up });
  // Вход прогона, закреплённый прежним отпечатком v1 (функция 0035), — как его закрепила передача 13-2.
  const su = new pg.Client({ connectionString: (() => { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; return u.toString(); })() });
  await su.connect();
  try {
    await su.query("SET session_replication_role = 'replica'");
    const r = await su.query(
      `UPDATE review_run_input i SET content_fingerprint = stage_content_fingerprint(r.stage_id, r.registry_id)
         FROM review_run r WHERE r.id = i.run_id AND i.run_id = $1`,
      [st.run.id],
    );
    expect(r.rowCount).toBe(1);
  } finally {
    await su.query("SET session_replication_role = 'origin'").catch(() => undefined);
    await su.end();
  }
  // Комплект собран на схеме 0035 (карточка этапа 13 читается уже после обновления).
  const created = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/release-candidates`, { mode: 'test', draftIds: [st.drafts.letter, st.drafts.conditions] }, { headers: idem() });
  expect(created.status, created.text).toBe(201);
  await drain(st.e.worker);
  legacyCandidate = created.body.id as string;
  expect(await migrateTo(36)).toBe(1);
});
afterAll(async () => {
  await closeStage13(st);
  await up?.pool.end().catch(() => undefined);
  await dropDatabase(ADMIN_URL, name);
});

const readyToApprove = async (id?: string): Promise<ICandidate13> => {
  let c = id ? await view(st, id) : await assembled(st);
  await notApplicable(st, c.id, 'Прошлые события не влияют на комплект');
  c = await view(st, c.id);
  await acceptAll(st, c);
  return view(st, c.id);
};

describe('обновление схемы 0035 → 0036 (R13-05)', () => {
  it('прогон с входом, закреплённым отпечатком v1, после обновления устарел: REVIEW_OUTDATED с причиной в карточке, свежести и второй линии; новый прогон и комплект — согласование и выпуск', async () => {
    expect((await up.pool.query<{ f: string | null }>("SELECT to_regprocedure('stage_content_fingerprint_v2(uuid,uuid,uuid)')::text AS f")).rows[0]!.f).not.toBeNull();
    expect((await up.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM release_candidate WHERE id = $1', [legacyCandidate])).rows[0]!.n).toBe(1);
    const c = await readyToApprove(legacyCandidate);
    expect(c.status).toBe('ready_for_approval');
    expect(codes(c.gate.approve)).toEqual(['REVIEW_OUTDATED']);
    expect(c.gate.approve!.blockers.find((b) => b.code === 'REVIEW_OUTDATED')!.items[0]!.title).toContain('прежним отпечатком');
    expect((await st.e.s.eng1.get(`/review-runs/${st.run.id}`)).body.freshness.reasons.join(' ')).toContain('прежним отпечатком');
    expect((await up.pool.query<{ p: string | null }>('SELECT candidate_gate_problem($1) AS p', [c.id])).rows[0]!.p).toBe('REVIEW_OUTDATED');
    const refused = await approve(st, c);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['REVIEW_OUTDATED']);

    const runId = await rerunReview(st);
    expect((await st.e.s.eng1.get(`/review-runs/${runId}`)).body.freshness.outdated).toBe(false);
    const fresh = await readyToApprove();
    expect(codes(fresh.gate.approve)).toEqual([]);
    const a = await approve(st, fresh);
    expect(a.status, a.text).toBe(200);
    const r = await release(st, await view(st, fresh.id, st.e.s.eng1), a.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
  });
});
