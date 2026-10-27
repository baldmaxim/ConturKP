import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRolePermissions, tenderCapabilities, type MemberRole, type Role } from '../packages/core/src/index.ts';
import { accessFingerprint, loadAccessContext } from '../packages/db/src/index.ts';
import { buildScenario, createTestDb, createUser, idem, makeApp, PASSWORD, TestClient, type IScenario, type ITestDb } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
let app: ReturnType<typeof makeApp>;
beforeAll(async () => { db = await createTestDb(); app = makeApp(db); s = await buildScenario(db, app); }, 180_000);
afterAll(async () => { await db?.drop(); });
const sorted = (caps: readonly string[]) => [...caps].sort();
const sqlCaps = async (userId: string, tenderId = s.tenderA) => (await db.pool.query<{ caps: string[] }>('SELECT tender_capabilities($1,$2) AS caps', [userId, tenderId])).rows[0]!.caps;
const roleBody = (r: any, patch: Record<string, unknown> = {}) => ({ name: r.name, description: r.description, baseRole: r.baseRole, permissions: r.permissions, status: r.status, ...patch });
const editRole = (r: any, patch: Record<string, unknown>) => s.admin.patch('/admin/roles/' + r.id, roleBody(r, patch), { headers: { 'If-Match': '"' + r.id + ':' + r.rowVersion + '"' } });
const newRoleUser = async (name: string, baseRole: Role, permissions: string[]) => {
  const role = await s.admin.post('/admin/roles', { name, baseRole, permissions }, { headers: idem() });
  expect(role.status, role.text).toBe(201);
  const user = await s.admin.post('/admin/users', { login: 'user-' + name, displayName: name, password: PASSWORD, roles: [role.body.code] }, { headers: idem() });
  expect(user.status, user.text).toBe(201);
  const client = new TestClient(app);
  expect((await client.login('user-' + name)).status).toBe(200);
  return { role: role.body, id: user.body.id as string, client };
};

describe('S18-30: зависимость политики доступа 0053–0054', () => {
  it('начальные права всех трёх профилей в SQL совпадают с кодом', async () => {
    const rows = (await db.pool.query<{ code: Role; permissions: string[] }>('SELECT code,permissions FROM portal_role WHERE built_in ORDER BY code')).rows;
    expect(rows.map(r => r.code)).toEqual(['admin', 'engineer', 'manager']);
    for (const row of rows) expect(sorted(row.permissions), row.code).toEqual(sorted(defaultRolePermissions(row.code)));
  });

  it('сохраняет parity для всех 8 сочетаний глобальных ролей и 3 назначений', async () => {
    const roles: Role[] = ['admin', 'manager', 'engineer'];
    for (let mask = 0; mask < 8; mask++) for (const member of [null, 'engineer', 'manager'] as const) {
      const selected = roles.filter((_, bit) => mask & (1 << bit));
      const initial = [...new Set<Role>([...selected, ...(member ? [member] : [])])];
      const id = await createUser(db.pool, 'policy-' + mask + '-' + (member ?? 'none'), initial);
      const tender = await s.admin.post('/tenders', { code: 'POLICY-' + mask + '-' + (member ?? 'none'), title: 'Parity' }, { headers: idem() });
      expect(tender.status, tender.text).toBe(201);
      if (member) await db.pool.query('INSERT INTO tender_member(tender_id,user_id,member_role,assigned_by) VALUES($1,$2,$3,$4)', [tender.body.id, id, member, s.ids.admin]);
      await db.pool.query('DELETE FROM user_role WHERE user_id=$1 AND NOT(role=ANY($2::text[]))', [id, selected]);
      const ctx = (await loadAccessContext(db.pool, id, 'parity'))!;
      const actual = await sqlCaps(id, tender.body.id);
      const label = JSON.stringify({ selected, member });
      expect(sorted(actual), label).toEqual(sorted(tenderCapabilities(new Set(selected), member)));
      expect(sorted(actual), label).toEqual(sorted(tenderCapabilities(ctx.roles, member)));
      if (selected.includes('manager') && selected.includes('engineer') && member === 'engineer') {
        expect(actual).toContain('audit.read');
        expect(actual).toContain('candidate.release');
        expect(actual).not.toContain('candidate.approve');
        expect(actual).not.toContain('calculation.close');
      }
      // Не оставляем дополнительных администраторов для проверки последнего администратора ниже.
      await db.pool.query('DELETE FROM user_role WHERE user_id=$1', [id]);
    }
  });

  it('административная основа собственной роли сама не открывает администрирование и изменения', async () => {
    const u = await newRoleUser('policy-reader', 'admin', ['tender.read.all', 'contract.read.all', 'mail.read.all']);
    const me = await u.client.get('/me');
    expect(me.body.assignedRoles).toEqual([u.role.code]);
    expect(me.body.roles).toEqual(['admin']);
    expect(me.body.memberships).toEqual([]);
    expect((await u.client.get('/stages/' + s.stageA)).status).toBe(200);
    for (const path of ['/admin/users', '/admin/roles', '/admin/operations', '/admin/audit-events']) expect((await u.client.get(path)).status, path).toBe(403);
    expect((await u.client.post('/stages/' + s.stageA + '/notes', { text: 'Недопустимая запись' }, { headers: idem() })).status).toBe(403);
    expect(sorted(await sqlCaps(u.id))).toEqual(sorted(tenderCapabilities((await loadAccessContext(db.pool, u.id, 'read'))!.roles, null)));
    expect(await sqlCaps(u.id)).toEqual(['tender.read', 'requirement.read', 'fact.read', 'audit.read']);
  });

  it('назначение не обходит урезанную роль; изменение и отключение прав действуют в прежней сессии', async () => {
    const u = await newRoleUser('policy-revoke', 'engineer', []);
    const created = await s.admin.post('/tenders', { code: 'POLICY-REVOKE', title: 'Отзыв роли' }, { headers: idem() });
    expect(created.status, created.text).toBe(201);
    const tenderId = created.body.id as string;
    const manager = await s.admin.put('/tenders/' + tenderId + '/members/' + s.ids.manager, { memberRole: 'manager' }, { headers: { 'If-Match': created.headers.etag } });
    expect(manager.status, manager.text).toBe(200);
    const stage = await s.manager.post('/tenders/' + tenderId + '/stages', { title: 'Отзыв доступа' }, { headers: idem() });
    expect(stage.status, stage.text).toBe(201);
    const stageId = stage.body.id as string;
    const tender = await s.admin.get('/tenders/' + tenderId);
    const assigned = await s.admin.put('/tenders/' + tenderId + '/members/' + u.id, { memberRole: 'engineer' }, { headers: { 'If-Match': tender.headers.etag } });
    expect(assigned.status, assigned.text).toBe(200);
    expect((await u.client.get('/stages/' + stageId)).status).toBe(404);
    expect(await sqlCaps(u.id, tenderId)).toEqual([]);
    const before = accessFingerprint((await loadAccessContext(db.pool, u.id, 'before'))!);
    const enable = await editRole(u.role, { permissions: ['tender.read', 'requirement.create'] });
    expect(enable.status, enable.text).toBe(200);
    expect((await u.client.get('/stages/' + stageId)).status).toBe(200);
    expect(sorted(await sqlCaps(u.id, tenderId))).toEqual(['requirement.create', 'tender.read']);
    expect(accessFingerprint((await loadAccessContext(db.pool, u.id, 'after'))!)).not.toBe(before);
    const headers = idem();
    expect((await u.client.post('/stages/' + stageId + '/notes', { text: 'Разрешённая запись' }, { headers })).status).toBe(201);
    const revoke = await editRole(enable.body, { permissions: [] });
    expect(revoke.status, revoke.text).toBe(200);
    expect((await u.client.post('/stages/' + stageId + '/notes', { text: 'Разрешённая запись' }, { headers })).status).toBe(404);
    expect((await u.client.get('/stages/' + stageId)).status).toBe(404);
    expect(await sqlCaps(u.id, tenderId)).toEqual([]);
    const off = await editRole(revoke.body, { status: 'disabled' });
    expect(off.status, off.text).toBe(200);
    expect((await u.client.get('/me')).body.roles).toEqual([]);
    expect((await db.pool.query('SELECT 1 FROM tender_member WHERE tender_id=$1 AND user_id=$2 AND removed_at IS NULL', [tenderId, u.id])).rowCount).toBe(1);
    expect((await s.admin.post('/admin/users', { login: 'policy-disabled', displayName: 'Disabled', password: PASSWORD, roles: [u.role.code] }, { headers: idem() })).status).toBe(409);
  });

  it('office.read открывает только Офис и отзывается в прежней сессии', async () => {
    const u = await newRoleUser('policy-office', 'engineer', ['office.read']);
    expect((await u.client.get('/admin/office')).status).toBe(200);
    expect((await u.client.get('/admin/operations')).status).toBe(403);
    expect((await u.client.get('/stages/' + s.stageA)).status).toBe(404);
    const off = await editRole(u.role, { permissions: [] });
    expect(off.status, off.text).toBe(200);
    expect((await u.client.get('/admin/office')).status).toBe(403);
  });

  it('сохраняет последний административный доступ и не принимает подменённые разрешения', async () => {
    const catalog = await s.admin.get('/admin/roles');
    const admin = catalog.body.items.find((r: any) => r.code === 'admin');
    expect((await editRole(admin, { permissions: admin.permissions.filter((p: string) => p !== 'admin.roles') })).status).toBe(409);
    expect((await editRole(admin, { status: 'disabled' })).status).toBe(409);
    expect((await s.eng1.post('/admin/roles', { name: 'Spoof', baseRole: 'admin', permissions: admin.permissions }, { headers: { ...idem(), 'X-Role': 'admin' } })).status).toBe(403);
    expect((await s.admin.post('/admin/roles', { name: 'Unknown', baseRole: 'engineer', permissions: ['unknown.permission'] }, { headers: idem() })).status).toBe(400);
    expect((await s.admin.get('/admin/roles')).status).toBe(200);
  });
});
