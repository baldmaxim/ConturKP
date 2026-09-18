// Контекст доступа (ADR-006 §6): каждый репозиторий данных тендера принимает его первым
// аргументом, поэтому запрос без контекста не компилируется. Контекст читается из БД
// на каждый запрос: снятие роли или назначения действует сразу.
import type { MemberRole, Role } from '@kontur/core';
import type { Queryable } from './pool.ts';

export interface IPrincipal {
  userId: string;
  kind: 'human';
  login: string;
  displayName: string;
}

export interface IAccessContext {
  readonly principal: IPrincipal;
  readonly roles: ReadonlySet<Role>;
  // Только действующие назначения (без снятых).
  readonly memberships: ReadonlyMap<string, MemberRole>;
  readonly requestId: string;
}

interface IUserRow {
  id: string;
  login: string;
  display_name: string;
  roles: Role[] | null;
}

export const loadAccessContext = async (
  db: Queryable,
  userId: string,
  requestId: string,
): Promise<IAccessContext | null> => {
  const u = await db.query<IUserRow>(
    `SELECT u.id, u.login, u.display_name,
            array_agg(r.role) FILTER (WHERE r.role IS NOT NULL) AS roles
       FROM app_user u
       LEFT JOIN user_role r ON r.user_id = u.id
      WHERE u.id = $1 AND u.kind = 'human' AND u.status = 'active'
      GROUP BY u.id`,
    [userId],
  );
  const row = u.rows[0];
  if (!row) return null;
  const m = await db.query<{ tender_id: string; member_role: MemberRole }>(
    'SELECT tender_id, member_role FROM tender_member WHERE user_id = $1 AND removed_at IS NULL',
    [userId],
  );
  return {
    principal: { userId: row.id, kind: 'human', login: row.login, displayName: row.display_name },
    roles: new Set(row.roles ?? []),
    memberships: new Map(m.rows.map((r) => [r.tender_id, r.member_role])),
    requestId,
  };
};

export const memberRoleOf = (ctx: IAccessContext, tenderId: string): MemberRole | null =>
  ctx.memberships.get(tenderId) ?? null;

// Список тендеров, чьё содержимое доступно (действующее назначение и соответствующая роль).
export const contentTenderIds = (ctx: IAccessContext): string[] =>
  [...ctx.memberships.entries()].filter(([, role]) => ctx.roles.has(role)).map(([id]) => id);
