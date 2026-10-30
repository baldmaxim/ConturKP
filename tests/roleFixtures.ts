// Ограниченный руководитель для отрицательных сценариев: обычный manager читает все ящики.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { idem, type TestClient } from './helpers.ts';

export const restrictManagerPermissions = async (admin: TestClient, userId: string, omitted: string[]): Promise<() => Promise<void>> => {
  const catalog = await admin.get('/admin/roles');
  expect(catalog.status, catalog.text).toBe(200);
  const manager = catalog.body.items.find((r: { code: string }) => r.code === 'manager');
  const created = await admin.post('/admin/roles', { name: 'Ограничение теста ' + randomUUID(), baseRole: 'manager', permissions: manager.permissions.filter((p: string) => !omitted.includes(p)) }, { headers: idem() });
  expect(created.status, created.text).toBe(201);
  const findUser = async () => {
    const users = await admin.get('/admin/users');
    expect(users.status, users.text).toBe(200);
    return users.body.items.find((u: { id: string }) => u.id === userId) as { id: string; roles: string[]; rowVersion: number };
  };
  const before = await findUser();
  const assigned = await admin.patch('/admin/users/' + userId, { roles: [...before.roles.filter(role => role !== 'manager'), created.body.code] }, { headers: { 'If-Match': '"' + userId + ':' + before.rowVersion + '"' } });
  expect(assigned.status, assigned.text).toBe(200);
  return async () => {
    const fresh = await findUser();
    const restored = await admin.patch('/admin/users/' + userId, { roles: before.roles }, { headers: { 'If-Match': '"' + userId + ':' + fresh.rowVersion + '"' } });
    expect(restored.status, restored.text).toBe(200);
  };
};
