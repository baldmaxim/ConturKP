import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { auditRows, buildScenario, createTestDb, idem, makeApp, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
beforeAll(async () => { db = await createTestDb(); s = await buildScenario(db, makeApp(db)); });
afterAll(async () => { if (db) await db.drop(); });
const get = () => s.admin.get('/tenders/' + s.tenderA);
const patch = async (body: unknown) => { const t = await get(); return s.admin.patch('/tenders/' + s.tenderA, body, { headers: { 'If-Match': t.headers.etag } }); };

describe('архив тендеров', () => {
  it('новый действующий тендер не имеет результата', async () => {
    expect((await get()).body).toMatchObject({ status: 'active', outcome: null });
  });
  it('не придумывает результат при переносе в архив', async () => {
    expect((await patch({ status: 'archived' })).status).toBe(400);
    expect((await get()).body).toMatchObject({ status: 'active', outcome: null });
    expect((await patch({ status: 'active', outcome: 'won' })).status).toBe(400);
    expect((await patch({ status: 'archived', outcome: 'draw' })).status).toBe(400);
  });
  it('сохраняет проигранный тендер, этапы, назначения и область чтения', async () => {
    const before = await get();
    const r = await patch({ status: 'archived', outcome: 'lost' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'archived', outcome: 'lost', rowVersion: before.body.rowVersion + 1 });
    expect((await s.eng1.get('/stages/' + s.stageA)).status).toBe(200);
    expect((await s.eng1.get('/tenders')).body.items.find((t: { id: string }) => t.id === s.tenderA)).toMatchObject({ status: 'archived', outcome: 'lost' });
    expect((await s.eng3.get('/tenders')).body.items.some((t: { id: string }) => t.id === s.tenderA)).toBe(false);
    expect((await s.admin.get('/tenders/' + s.tenderA + '/members')).body.items).toHaveLength(3);
  });
  it('сохраняет выигрыш и пишет изменение результата в аудит', async () => {
    const r = await patch({ outcome: 'won' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'archived', outcome: 'won' });
    const rows = await auditRows(db.pool, "tender_id = $1 AND action = 'tender.update' AND outcome = 'allowed'", [s.tenderA]);
    expect(rows.at(-1)?.details).toMatchObject({ changes: { outcome: { from: 'lost', to: 'won' } } });
    expect((await patch({ outcome: null })).status).toBe(400);
  });
  it('устаревший запрос не перезаписывает результат', async () => {
    const t = await get();
    expect((await patch({ outcome: 'lost' })).status).toBe(200);
    const stale = await s.admin.patch('/tenders/' + s.tenderA, { outcome: 'won' }, { headers: { 'If-Match': t.headers.etag } });
    expect(stale.status).toBe(412);
    expect(stale.body.current).toMatchObject({ status: 'archived', outcome: 'lost' });
  });
  it('возвращает в действующие и очищает результат', async () => {
    const r = await patch({ status: 'active' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'active', outcome: null });
    expect((await patch({ status: 'archived' })).status).toBe(400);
  });
  it('сохраняет прежние права на архивирование', async () => {
    const t = await get();
    for (const client of [s.eng1, s.manager]) {
      const r = await client.patch('/tenders/' + s.tenderA, { status: 'archived', outcome: 'lost' }, { headers: { 'If-Match': t.headers.etag } });
      expect(r.status).toBe(403);
    }
    expect((await s.eng3.patch('/tenders/' + s.tenderA, { status: 'archived', outcome: 'lost' }, { headers: { 'If-Match': t.headers.etag } })).status).toBe(404);
  });
  it('миграция отмечает только прежний архив выигранным и защищает сочетания статуса и результата', async () => {
    const c = new pg.Client({ connectionString: db.migratorUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('CREATE TEMP TABLE tender (id int PRIMARY KEY, status text NOT NULL, row_version int NOT NULL, updated_at timestamptz NOT NULL)');
      await c.query("INSERT INTO tender VALUES (1,'active',7,'2026-01-01'),(2,'archived',9,'2026-01-01')");
      const migration = readFileSync(new URL('../docs/migrations/0055_tender_outcome.sql', import.meta.url), 'utf8');
      await c.query(migration);
      expect((await c.query('SELECT id,status,outcome,row_version FROM tender ORDER BY id')).rows).toEqual([
        { id: 1, status: 'active', outcome: null, row_version: 7 },
        { id: 2, status: 'archived', outcome: 'won', row_version: 10 },
      ]);
      await c.query('SAVEPOINT invalid');
      await expect(c.query("UPDATE tender SET outcome = 'won' WHERE id = 1")).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK TO SAVEPOINT invalid');
      await expect(c.query('UPDATE tender SET outcome = NULL WHERE id = 2')).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    } finally { await c.end(); }
  });
});
