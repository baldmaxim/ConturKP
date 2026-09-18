// Пользователи и роли (data-model §4.1). Администрирование требует admin.users —
// проверка в обработчике; репозиторий принимает контекст, чтобы вызов без него не компилировался.
import type { Role } from '@kontur/core';
import type { IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export interface IUserRow {
  id: string;
  login: string;
  display_name: string;
  status: 'active' | 'disabled';
  roles: Role[];
  row_version: number;
  created_at: Date;
}

const SELECT_USER = `
  SELECT u.id, u.login, u.display_name, u.status, u.row_version, u.created_at,
         coalesce(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
    FROM app_user u
    LEFT JOIN user_role r ON r.user_id = u.id`;

export const listUsers = async (db: Queryable, _ctx: IAccessContext): Promise<IUserRow[]> => {
  const r = await db.query<IUserRow>(`${SELECT_USER} WHERE u.kind = 'human' GROUP BY u.id ORDER BY u.login`);
  return r.rows;
};

export const getUser = async (db: Queryable, id: string, lock = false): Promise<IUserRow | null> => {
  if (lock) await db.query('SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE', [id]);
  const r = await db.query<IUserRow>(`${SELECT_USER} WHERE u.id = $1 AND u.kind = 'human' GROUP BY u.id`, [id]);
  return r.rows[0] ?? null;
};

export interface ICredentialRow {
  id: string;
  password_hash: string | null;
}

// Для входа: только активные люди.
export const findCredential = async (db: Queryable, login: string): Promise<ICredentialRow | null> => {
  const r = await db.query<ICredentialRow>(
    `SELECT id, password_hash FROM app_user WHERE login = $1 AND kind = 'human' AND status = 'active'`,
    [login],
  );
  return r.rows[0] ?? null;
};

export const getPasswordHash = async (db: Queryable, userId: string): Promise<string | null> => {
  const r = await db.query<{ password_hash: string | null }>('SELECT password_hash FROM app_user WHERE id = $1', [userId]);
  return r.rows[0]?.password_hash ?? null;
};

export interface INewUser {
  login: string;
  displayName: string;
  passwordHash: string;
  roles: Role[];
}

// grantedBy = null только для bootstrap с консоли сервера.
export const insertUser = async (db: Queryable, u: INewUser, grantedBy: string | null): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO app_user (kind, login, display_name, password_hash) VALUES ('human', $1, $2, $3) RETURNING id`,
    [u.login, u.displayName, u.passwordHash],
  );
  const id = r.rows[0]!.id;
  await setRoles(db, id, u.roles, grantedBy);
  return id;
};

export const setRoles = async (db: Queryable, userId: string, roles: Role[], grantedBy: string | null): Promise<void> => {
  await db.query('DELETE FROM user_role WHERE user_id = $1 AND NOT (role = ANY($2::text[]))', [userId, roles]);
  await db.query(
    `INSERT INTO user_role (user_id, role, granted_by)
     SELECT $1, unnest($2::text[]), $3 ON CONFLICT DO NOTHING`,
    [userId, roles, grantedBy],
  );
};

export interface IUserPatch {
  displayName?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  passwordHash?: string | undefined;
}

export const updateUser = async (db: Queryable, id: string, patch: IUserPatch): Promise<void> => {
  await db.query(
    `UPDATE app_user
        SET display_name = coalesce($2, display_name),
            status = coalesce($3, status),
            password_hash = coalesce($4, password_hash),
            updated_at = now(),
            row_version = row_version + 1
      WHERE id = $1`,
    [id, patch.displayName ?? null, patch.status ?? null, patch.passwordHash ?? null],
  );
};

export const countActiveAdmins = async (db: Queryable): Promise<number> => {
  const r = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM app_user u JOIN user_role r ON r.user_id = u.id
      WHERE r.role = 'admin' AND u.status = 'active' AND u.kind = 'human'`,
  );
  return r.rows[0]?.n ?? 0;
};
