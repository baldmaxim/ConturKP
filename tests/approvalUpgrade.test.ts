// Обновление схемы этапа 13 до последней миграции с прогоном, вход которого закреплён прежним отпечатком содержимого
// (Review 13-2 R13-05, 13-3 R13-06): с 0035 — отпечаток v1 (так закрепляла передача 13-2), с 0036 — отпечаток v2 (передача
// 13-3). Данные переживают обновление; такой прогон устарел: карточка — неснимаемый REVIEW_OUTDATED с причиной
// «закреплён прежним отпечатком», вторая линия БД — REVIEW_OUTDATED, свежесть прогона — с той же причиной. Путь
// «новый прогон → новый комплект → согласование → выпуск» проходит. Прежнее закрепление воспроизводится правкой
// закреплённой строки суперпользователем с выключенными триггерами (session_replication_role = replica): так выглядят
// данные, записанные прежним кодом; продукт этого не делает.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPool, dropDatabase, migrate, MIGRATIONS_DIR, setupDatabase } from '../packages/db/src/index.ts';
import { ADMIN_URL, drain, idem, type ITestDb } from './helpers.ts';
import { addClosureTables, addQuestionOrigin, dropClosureTables, dropQuestionOrigin } from './legacySchema.ts';
import { acceptAll, approve, assembled, buildStage13, closeStage13, codes, notApplicable, release, rerunReview, view, type ICandidate13, type IStage13 } from './approvalFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const LATEST = Math.max(...readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))));

// Прежний отпечаток, которым закреплял вход код схемы `from`.
const LEGACY: Record<number, string> = {
  35: 'stage_content_fingerprint(r.stage_id, r.registry_id)',
  36: 'stage_content_fingerprint_v2(r.stage_id, r.registry_id, r.evidence_scope_id)',
};

const upgradeCase = (from: number) => async () => {
  const name = `kontur_kp_test_upgrade${from}_${Date.now().toString(36)}`;
  const urlFor = (user: string | null): string => {
    const u = new URL(ADMIN_URL);
    if (user) {
      u.username = user;
      u.password = '';
    }
    u.pathname = `/${name}`;
    return u.toString();
  };
  const migrateTo = async (max: number): Promise<number> => {
    const dir = mkdtempSync(join(tmpdir(), `kontur-mig${from}-${max}-`));
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
  let st: IStage13 | undefined;
  try {
    expect(await migrateTo(from)).toBe(from);
    await addQuestionOrigin(urlFor('kontur_migrator'));
    await addClosureTables(urlFor('kontur_migrator'));
    st = await buildStage13({ db: up });
    const stage = st;
    const su = new pg.Client({ connectionString: urlFor(null) });
    await su.connect();
    try {
      await su.query("SET session_replication_role = 'replica'");
      const r = await su.query(`UPDATE review_run_input i SET content_fingerprint = ${LEGACY[from]} FROM review_run r WHERE r.id = i.run_id AND i.run_id = $1`, [stage.run.id]);
      expect(r.rowCount).toBe(1);
    } finally {
      await su.query("SET session_replication_role = 'origin'").catch(() => undefined);
      await su.end();
    }
    // Комплект собран на прежней схеме (карточка этапа 13 читается уже после обновления).
    const created = await stage.e.s.eng1.post(`/stages/${stage.e.s.stageA}/release-candidates`, { mode: 'test', draftIds: [stage.drafts.letter, stage.drafts.conditions] }, { headers: idem() });
    expect(created.status, created.text).toBe(201);
    await drain(stage.e.worker);
    await dropQuestionOrigin(urlFor('kontur_migrator'));
    await dropClosureTables(urlFor('kontur_migrator'));
    expect(await migrateTo(LATEST)).toBe(LATEST - from);

    const readyToApprove = async (id?: string): Promise<ICandidate13> => {
      let c = id ? await view(stage, id) : await assembled(stage);
      await notApplicable(stage, c.id, 'Прошлые события не влияют на комплект');
      c = await view(stage, c.id);
      await acceptAll(stage, c);
      return view(stage, c.id);
    };
    const c = await readyToApprove(created.body.id as string);
    expect(c.status).toBe('ready_for_approval');
    expect(codes(c.gate.approve)).toEqual(['REVIEW_OUTDATED']);
    expect(c.gate.approve!.blockers.find((b) => b.code === 'REVIEW_OUTDATED')!.items[0]!.title).toContain('прежним отпечатком');
    expect((await stage.e.s.eng1.get(`/review-runs/${stage.run.id}`)).body.freshness.reasons.join(' ')).toContain('прежним отпечатком');
    expect((await up.pool.query<{ p: string | null }>('SELECT candidate_gate_problem($1) AS p', [c.id])).rows[0]!.p).toBe('REVIEW_OUTDATED');
    const refused = await approve(stage, c);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['REVIEW_OUTDATED']);

    const runId = await rerunReview(stage);
    expect((await stage.e.s.eng1.get(`/review-runs/${runId}`)).body.freshness.outdated).toBe(false);
    const fresh = await readyToApprove();
    expect(codes(fresh.gate.approve)).toEqual([]);
    const a = await approve(stage, fresh);
    expect(a.status, a.text).toBe(200);
    const rel = await release(stage, await view(stage, fresh.id, stage.e.s.eng1), a.body.approval.id as string);
    expect(rel.status, rel.text).toBe(201);
  } finally {
    await closeStage13(st);
    await up.pool.end().catch(() => undefined);
    await dropDatabase(ADMIN_URL, name);
  }
};

describe('обновление схемы этапа 13 до последней миграции', () => {
  it('с 0035: вход, закреплённый отпечатком v1, устарел — REVIEW_OUTDATED с причиной в карточке, свежести и второй линии; новый прогон и комплект — согласование и выпуск', upgradeCase(35));
  it('с 0036: вход, закреплённый отпечатком v2 (без вида документа), устарел так же; новый прогон и комплект — согласование и выпуск', upgradeCase(36));
});
