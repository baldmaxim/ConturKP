// Состав источников этапа (state-machines §5): draft-ревизия, включение и исключение с причиной,
// событие source_set_changed, неизменность замороженной ревизии на уровне БД.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, seedRecognition, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig();
const revs: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  for (const [stage, name] of [
    [s.stageA, 'ТЗ.pdf'],
    [s.stageA, 'Договор.pdf'],
    [s.stageB, 'Чужой.pdf'],
  ] as const) {
    const c = stage === s.stageA ? s.eng1 : s.eng3;
    const r = await c.post(`/stages/${stage}/imports?name=${encodeURIComponent(name)}`, fakePdf(name), { headers: { 'Content-Type': 'application/octet-stream', ...idem() } });
    await drain(makeWorker(db, config));
    const b = (await c.get(`/imports/${r.body.id}`)).body;
    revs.push(b.items[0].documentRevisionId);
  }
});
afterAll(async () => db.drop());

describe('состав источников этапа', () => {
  it('draft-ревизия: включение и исключение с причиной, событие source_set_changed', async () => {
    const d = await s.eng1.post(`/stages/${s.stageA}/source-set-revisions`, {}, { headers: idem() });
    expect(d.status, d.text).toBe(201);
    expect(d.body).toMatchObject({ seq: 1, status: 'draft' });
    const second = await s.eng1.post(`/stages/${s.stageA}/source-set-revisions`, {}, { headers: idem() });
    expect(second.status).toBe(409);

    const noReason = await s.eng1.put(`/source-set-revisions/${d.body.id}/items`, { items: [{ documentRevisionId: revs[1], inclusion: 'excluded_not_applicable' }] }, { headers: { 'If-Match': d.headers.etag } });
    expect(noReason.status).toBe(400);
    const foreign = await s.eng1.put(`/source-set-revisions/${d.body.id}/items`, { items: [{ documentRevisionId: revs[2], inclusion: 'included' }] }, { headers: { 'If-Match': d.headers.etag } });
    expect(foreign.status).toBe(400);

    const before = (await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion;
    const ok = await s.eng1.put(
      `/source-set-revisions/${d.body.id}/items`,
      {
        items: [
          { documentRevisionId: revs[0], inclusion: 'included' },
          { documentRevisionId: revs[1], inclusion: 'excluded_not_applicable', reason: 'договор другого лота' },
        ],
      },
      { headers: { 'If-Match': d.headers.etag } },
    );
    expect(ok.status, ok.text).toBe(200);
    expect((await s.eng1.get(`/stages/${s.stageA}`)).body.inputVersion).toBe(before + 1);
    const ev = await s.eng1.get(`/stages/${s.stageA}/input-events`);
    expect(ev.body.items[0]).toMatchObject({ eventType: 'source_set_changed', refId: d.body.id });

    const stale = await s.eng2.put(`/source-set-revisions/${d.body.id}/items`, { items: [] }, { headers: { 'If-Match': d.headers.etag } });
    expect(stale.status).toBe(412);

    const view = (await s.eng2.get(`/stages/${s.stageA}/source-sets`)).body.items[0];
    expect(view.latestItems.map((i: { inclusion: string; reason: string | null }) => [i.inclusion, i.reason])).toEqual([
      ['excluded_not_applicable', 'договор другого лота'],
      ['included', null],
    ]);
  });

  it('чужой этап: чтение и изменение состава — 404', async () => {
    const view = (await s.eng1.get(`/stages/${s.stageA}/source-sets`)).body.items[0];
    const rev = view.revisions[0];
    expect((await s.eng3.get(`/stages/${s.stageA}/source-sets`)).status).toBe(404);
    expect((await s.eng3.put(`/source-set-revisions/${rev.id}/items`, { items: [] }, { headers: { 'If-Match': `"${rev.id}:${rev.rowVersion}"` } })).status).toBe(404);
  });

  it('замороженная ревизия не меняется даже в обход API (триггер)', async () => {
    const view = (await s.eng1.get(`/stages/${s.stageA}/source-sets`)).body.items[0];
    const rev = view.revisions[0].id;
    const { default: pg } = await import('pg');
    const owner = new pg.Client({ connectionString: db.migratorUrl });
    await owner.connect();
    try {
      // Охранное условие заморозки (миграция 0005) требует распознавания у включённых редакций;
      // здесь оно создаётся напрямую, потому что проверяется только защита БД, а не разбор архива.
      await seedRecognition(db.pool, revs[0]!);
      await owner.query(
        "UPDATE source_set_revision SET status = 'frozen', frozen_at = now(), frozen_by = $2, content_hash = 'test' WHERE id = $1",
        [rev, s.ids.eng1],
      );
      await expect(db.pool.query('DELETE FROM source_set_item WHERE source_set_revision_id = $1', [rev])).rejects.toThrow(/замороженной/);
      await expect(db.pool.query("UPDATE source_set_revision SET status = 'draft' WHERE id = $1", [rev])).rejects.toThrow(/frozen-after/);
    } finally {
      await owner.end();
    }
  });
});
