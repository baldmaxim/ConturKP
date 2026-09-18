// Защищённый bootstrap (ADR-006 §11): первый администратор-руководитель создаётся только
// консольной командой на сервере (нужен доступ к окружению процесса и БД), не через HTTP.
// Команда отказывает, если активный администратор уже есть: повторно открыть «первую
// регистрацию» нельзя; дальше пользователей ведёт администратор через интерфейс.
import { passwordProblem, hashPassword, type Role } from '@kontur/core';
import { countActiveAdmins, insertUser, withTransaction, writeAudit, type Pool } from '@kontur/db';

export class BootstrapRefused extends Error {}

export interface IBootstrapInput {
  login: string;
  displayName: string;
  password: string;
  roles: Role[];
}

export const bootstrapOwner = async (pool: Pool, input: IBootstrapInput): Promise<string> => {
  const problem = passwordProblem(input.password);
  if (problem) throw new BootstrapRefused(problem);
  if (!input.roles.includes('admin')) throw new BootstrapRefused('первый пользователь должен иметь роль admin');
  const passwordHash = await hashPassword(input.password);
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kontur_kp_bootstrap'))");
    if ((await countActiveAdmins(client)) > 0) {
      throw new BootstrapRefused('активный администратор уже существует; bootstrap повторно не выполняется');
    }
    const id = await insertUser(client, { login: input.login, displayName: input.displayName, passwordHash, roles: input.roles }, null);
    await writeAudit(client, {
      actorUserId: null,
      principalKind: 'system',
      action: 'user.bootstrap',
      entityType: 'app_user',
      entityId: id,
      outcome: 'allowed',
      details: { login: input.login, roles: input.roles, via: 'cli' },
    });
    return id;
  });
};
