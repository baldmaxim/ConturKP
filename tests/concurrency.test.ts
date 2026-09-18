// Конкурентность и идемпотентность (ADR-005 §9–10, A24, I13, I14) и аудит правок.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, buildScenario, createTestDb, createUser, idem, makeApp, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db));
});
afterAll(async () => db.drop());

describe('устаревшая правка (stale edit)', () => {
  it('второй инженер с прежней версией получает 412 и текущее состояние; правка первого сохранена', async () => {
    const read1 = await s.eng1.get(`/stages/${s.stageA}`);
    const read2 = await s.eng2.get(`/stages/${s.stageA}`);
    expect(read1.headers.etag).toBe(read2.headers.etag);

    const first = await s.eng1.patch(`/stages/${s.stageA}`, { title: 'Правка инженера 1' }, { headers: { 'If-Match': read1.headers.etag } });
    expect(first.status).toBe(200);
    expect(first.body.rowVersion).toBe(read1.body.rowVersion + 1);

    const second = await s.eng2.patch(`/stages/${s.stageA}`, { title: 'Правка инженера 2' }, { headers: { 'If-Match': read2.headers.etag } });
    expect(second.status).toBe(412);
    expect(second.body.code).toBe('VERSION_CONFLICT');
    expect(second.body.current.title).toBe('Правка инженера 1');

    const now = await s.eng2.get(`/stages/${s.stageA}`);
    expect(now.body.title).toBe('Правка инженера 1');
    const failed = await auditRows(db.pool, "actor_user_id = $1 AND action = 'stage.update' AND outcome = 'failed'", [s.ids.eng2]);
    expect(failed[0]?.details.code).toBe('VERSION_CONFLICT');
  });

  it('без If-Match — 428, с чужим ETag — 412', async () => {
    const none = await s.eng1.patch(`/stages/${s.stageA}`, { title: 'без версии' });
    expect(none.status).toBe(428);
    expect(none.body.code).toBe('PRECONDITION_REQUIRED');
    const other = await s.eng1.patch(`/stages/${s.stageA}`, { title: 'чужой etag' }, { headers: { 'If-Match': `"${s.tenderA}:1"` } });
    expect(other.status).toBe(412);
  });

  it('параллельные правки с одной версией: ровно одна успешна', async () => {
    const read = await s.eng1.get(`/stages/${s.stageA}`);
    const results = await Promise.all([
      s.eng1.patch(`/stages/${s.stageA}`, { title: 'Параллельно 1' }, { headers: { 'If-Match': read.headers.etag } }),
      s.eng2.patch(`/stages/${s.stageA}`, { title: 'Параллельно 2' }, { headers: { 'If-Match': read.headers.etag } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  });

  it('устаревшая версия тендера при назначении — 412', async () => {
    const t = await s.admin.get(`/tenders/${s.tenderB}`);
    const upd = await s.admin.patch(`/tenders/${s.tenderB}`, { customerName: 'Заказчик' }, { headers: { 'If-Match': t.headers.etag } });
    expect(upd.status).toBe(200);
    const stale = await s.admin.put(`/tenders/${s.tenderB}/members/${s.ids.eng1}`, { memberRole: 'engineer' }, { headers: { 'If-Match': t.headers.etag } });
    expect(stale.status).toBe(412);
  });
});

describe('не больше двух инженеров на тендере', () => {
  it('третий инженер отклоняется, параллельные назначения не обходят ограничение', async () => {
    const extra = [await createUser(db.pool, 'eng4', ['engineer']), await createUser(db.pool, 'eng5', ['engineer'])];
    const t = await s.admin.get(`/tenders/${s.tenderA}`);
    const third = await s.admin.put(`/tenders/${s.tenderA}/members/${extra[0]}`, { memberRole: 'engineer' }, { headers: { 'If-Match': t.headers.etag } });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('STATE_CONFLICT');

    // Тендер B: один инженер (eng3). Два параллельных назначения на одной версии: одно 200, второе 412.
    const tb = await s.admin.get(`/tenders/${s.tenderB}`);
    const parallel = await Promise.all(
      extra.map((id) => s.admin.put(`/tenders/${s.tenderB}/members/${id}`, { memberRole: 'engineer' }, { headers: { 'If-Match': tb.headers.etag } })),
    );
    expect(parallel.map((r) => r.status).sort()).toEqual([200, 412]);
    const members = await s.admin.get(`/tenders/${s.tenderB}/members`);
    expect(members.body.items.filter((m: { memberRole: string }) => m.memberRole === 'engineer')).toHaveLength(2);
  });

  it('вторая линия в БД: триггер отклоняет третьего инженера в обход API', async () => {
    const eng6 = await createUser(db.pool, 'eng6', ['engineer']);
    await expect(
      db.pool.query('INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, $3, $4)', [s.tenderA, eng6, 'engineer', s.ids.admin]),
    ).rejects.toThrow(/два инженера/);
    await expect(
      db.pool.query('INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, $3, $4)', [s.tenderB, s.ids.eng1, 'manager', s.ids.admin]),
    ).rejects.toThrow(/ролью manager/);
  });
});

describe('идемпотентность команд', () => {
  it('повтор с тем же ключом возвращает тот же ответ без дубля', async () => {
    const headers = idem();
    const a = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'Идемпотентный' }, { headers });
    const b = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'Идемпотентный' }, { headers });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const list = await s.eng1.get(`/tenders/${s.tenderA}/stages`);
    expect(list.body.items.filter((x: { title: string }) => x.title === 'Идемпотентный')).toHaveLength(1);
  });

  it('тот же ключ с другим телом — 422', async () => {
    const headers = idem();
    expect((await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'K1' }, { headers })).status).toBe(201);
    const r = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'K2' }, { headers });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('параллельные повторы с одним ключом создают одну запись', async () => {
    const headers = idem();
    const rs = await Promise.all([1, 2, 3].map(() => s.admin.post('/tenders', { code: 'PAR-1', title: 'Параллельный' }, { headers })));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
  });

  it('команда создания без ключа отклоняется', async () => {
    const r = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'без ключа' });
    expect(r.status).toBe(400);
  });
});

describe('журнал действий', () => {
  it('правка фиксирует автора, объект, тендер и изменения', async () => {
    const read = await s.eng2.get(`/stages/${s.stageB}`).catch(() => null);
    expect(read?.status).toBe(404); // eng2 не участник B
    const r0 = await s.eng3.get(`/stages/${s.stageB}`);
    const r = await s.eng3.patch(
      `/stages/${s.stageB}`,
      { title: 'Этап B1 (уточнён)', submissionDeadline: '2026-10-01T09:00:00Z' },
      { headers: { 'If-Match': r0.headers.etag } },
    );
    expect(r.status).toBe(200);
    const rows = await auditRows(db.pool, "action = 'stage.update' AND outcome = 'allowed' AND entity_id = $1", [s.stageB]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: s.ids.eng3, entity_type: 'tender_stage', tender_id: s.tenderB });
    expect(rows[0]?.details.changes).toEqual({
      title: { from: 'Этап B1', to: 'Этап B1 (уточнён)' },
      submissionDeadline: { from: null, to: '2026-10-01T09:00:00.000Z' },
    });
  });

  it('руководитель видит журнал своего тендера с автором', async () => {
    const r = await s.manager.get(`/tenders/${s.tenderB}/audit-events?limit=5`);
    expect(r.status).toBe(200);
    const upd = r.body.items.find((e: { action: string }) => e.action === 'stage.update');
    expect(upd.actor.login).toBe('eng3');
    expect(upd.entityId).toBe(s.stageB);
  });

  it('пагинация журнала по курсору', async () => {
    const p1 = await s.manager.get(`/tenders/${s.tenderA}/audit-events?limit=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await s.manager.get(`/tenders/${s.tenderA}/audit-events?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[1].id);
  });

  it('роль приложения не может изменить или удалить журнал; триггер — вторая линия', async () => {
    await expect(db.pool.query("UPDATE audit_event SET action = 'x'")).rejects.toThrow(/permission denied/);
    await expect(db.pool.query('DELETE FROM audit_event')).rejects.toThrow(/permission denied/);
    const { default: pg } = await import('pg');
    const owner = new pg.Client({ connectionString: db.migratorUrl });
    await owner.connect();
    try {
      await expect(owner.query("UPDATE audit_event SET action = 'x'")).rejects.toThrow(/append-only/);
      await expect(owner.query('DELETE FROM audit_event')).rejects.toThrow(/append-only/);
      await expect(owner.query('TRUNCATE audit_event')).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
  });
});
