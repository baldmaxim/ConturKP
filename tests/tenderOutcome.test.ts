import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, idem, makeApp, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
beforeAll(async () => { db = await createTestDb(); s = await buildScenario(db, makeApp(db)); }, 180_000);
afterAll(async () => { await db?.drop(); });
let sequence = 0;
const fresh = async () => {
  const r = await s.admin.post('/tenders', { code: 'OUTCOME-' + ++sequence, title: 'Результат тендера' }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string; rowVersion: number };
};
const patch = (t: { id: string; rowVersion: number }, body: unknown) => s.admin.patch('/tenders/' + t.id, body, { headers: { 'If-Match': '"' + t.id + ':' + t.rowVersion + '"' } });
const stored = async (id: string) => (await db.pool.query('SELECT status,outcome,row_version FROM tender WHERE id=$1', [id])).rows[0];
const archived = async () => {
  const t = await fresh();
  await db.pool.query("UPDATE tender SET status='archived',outcome='won' WHERE id=$1", [t.id]);
  return t;
};

describe('результат тендера: схема 0055 и штатная архивация', () => {
  it('новый тендер явно возвращает outcome=null в карточке и списке', async () => {
    const t = await fresh();
    const card = await s.admin.get('/tenders/' + t.id);
    expect(card.status).toBe(200);
    expect(card.body.outcome).toBeNull();
    const list = await s.admin.get('/tenders');
    expect(list.body.items.find((x: { id: string }) => x.id === t.id).outcome).toBeNull();
  });
  it.each(['won', 'lost'] as const)('архивирует с результатом %s и сохраняет его в БД, карточке и списке', async outcome => {
    const t = await fresh();
    const r = await patch(t, { status: 'archived', outcome });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'archived', outcome, rowVersion: t.rowVersion + 1 });
    expect(await stored(t.id)).toMatchObject({ status: 'archived', outcome, row_version: t.rowVersion + 1 });
    expect((await s.admin.get('/tenders/' + t.id)).body.outcome).toBe(outcome);
    const list = await s.admin.get('/tenders');
    expect(list.body.items.find((x: { id: string }) => x.id === t.id)).toMatchObject({ status: 'archived', outcome });
  });
  it('без выбранного результата возвращает 400 до SQL и не меняет строку', async () => {
    const t = await fresh();
    const r = await patch(t, { status: 'archived' });
    expect(r.status, r.text).toBe(400);
    expect(r.body.code).toBe('VALIDATION_FAILED');
    expect(await stored(t.id)).toEqual({ status: 'active', outcome: null, row_version: t.rowVersion });
  });
  it('возвращает архивный тендер в работу и очищает прежний результат', async () => {
    const t = await archived();
    const r = await patch(t, { status: 'active' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'active', outcome: null, rowVersion: t.rowVersion + 1 });
    expect(await stored(t.id)).toMatchObject({ status: 'active', outcome: null });
    const audit = await db.pool.query("SELECT details FROM audit_event WHERE tender_id=$1 AND action='tender.update' ORDER BY id DESC LIMIT 1", [t.id]);
    expect(audit.rows[0].details.changes).toMatchObject({ status: { from: 'archived', to: 'active' }, outcome: { from: 'won', to: null } });
  });
  it('сохраняет результат при обычном редактировании архивной карточки', async () => {
    const t = await archived();
    const r = await patch(t, { title: 'Новое название' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ title: 'Новое название', status: 'archived', outcome: 'won' });
    expect(await stored(t.id)).toMatchObject({ status: 'archived', outcome: 'won' });
  });
  it('позволяет исправить won на lost в архиве и фиксирует изменение результата в аудите', async () => {
    const t = await archived();
    const r = await patch(t, { outcome: 'lost' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'archived', outcome: 'lost' });
    const audit = await db.pool.query("SELECT details FROM audit_event WHERE tender_id=$1 AND action='tender.update' ORDER BY id DESC LIMIT 1", [t.id]);
    expect(audit.rows[0].details.changes.outcome).toEqual({ from: 'won', to: 'lost' });
  });
  it('не принимает outcome у действующего тендера и откатывает весь запрос', async () => {
    const t = await fresh();
    const r = await patch(t, { title: 'Не должно сохраниться', outcome: 'won' });
    expect(r.status).toBe(400);
    expect(await stored(t.id)).toEqual({ status: 'active', outcome: null, row_version: t.rowVersion });
    expect((await s.admin.get('/tenders/' + t.id)).body.title).toBe('Результат тендера');
  });
  it('не принимает ненулевой результат одновременно с возвратом в работу', async () => {
    const t = await archived();
    const r = await patch(t, { status: 'active', outcome: 'lost' });
    expect(r.status).toBe(400);
    expect(await stored(t.id)).toMatchObject({ status: 'archived', outcome: 'won', row_version: t.rowVersion });
  });
  it.each([null, 'draw', ''])('не принимает некорректный результат архива %s', async outcome => {
    const t = await fresh();
    const r = await patch(t, { status: 'archived', outcome });
    expect(r.status).toBe(400);
    expect(await stored(t.id)).toMatchObject({ status: 'active', outcome: null, row_version: t.rowVersion });
  });
  it('проверяет ETag раньше изменения результата', async () => {
    const t = await fresh();
    const r = await patch({ ...t, rowVersion: t.rowVersion + 1 }, { status: 'archived', outcome: 'won' });
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('VERSION_CONFLICT');
    expect(await stored(t.id)).toMatchObject({ status: 'active', outcome: null, row_version: t.rowVersion });
  });
  it('не даёт инженеру или руководителю без admin.tender менять результат', async () => {
    const card = await s.admin.get('/tenders/' + s.tenderA);
    for (const client of [s.eng1, s.manager]) {
      const r = await client.patch('/tenders/' + s.tenderA, { status: 'archived', outcome: 'won' }, { headers: { 'If-Match': card.headers.etag as string } });
      expect(r.status, r.text).toBe(403);
    }
    expect(await stored(s.tenderA)).toMatchObject({ status: 'active', outcome: null });
  });
  it('сохраняет CHECK 0055 при прямой попытке записать несовместимую пару', async () => {
    const t = await fresh();
    await expect(db.pool.query("UPDATE tender SET status='archived' WHERE id=$1", [t.id])).rejects.toMatchObject({ code: '23514', constraint: 'tender_status_outcome_check' });
    await expect(db.pool.query("UPDATE tender SET outcome='won' WHERE id=$1", [t.id])).rejects.toMatchObject({ code: '23514', constraint: 'tender_status_outcome_check' });
    expect(await stored(t.id)).toMatchObject({ status: 'active', outcome: null });
  });
});
