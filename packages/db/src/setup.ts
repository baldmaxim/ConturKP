// Подготовка кластера: роли и база (ADR-002 §4). Выполняется суперпользователем один раз.
// Пароли ролей берутся из окружения и никуда не выводятся.
import pg from 'pg';

export interface IRolePasswords {
  appPassword?: string | undefined;
  migratorPassword?: string | undefined;
  backupPassword?: string | undefined;
}

const quoteIdent = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`недопустимое имя базы: ${name}`);
  return `"${name}"`;
};

const ensureRole = async (admin: pg.ClientBase, role: string, password: string | undefined): Promise<void> => {
  const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  }
  if (password) {
    // DDL не принимает параметры: пароль передаётся литералом с экранированием кавычек.
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password.replaceAll("'", "''")}'`);
  }
};

export const ensureRoles = async (admin: pg.ClientBase, passwords: IRolePasswords = {}): Promise<void> => {
  await ensureRole(admin, 'kontur_migrator', passwords.migratorPassword);
  await ensureRole(admin, 'kontur_app', passwords.appPassword);
  await ensureRole(admin, 'kontur_backup', passwords.backupPassword);
};

const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

// adminUrl — суперпользователь на служебной базе (обычно postgres).
export const setupDatabase = async (
  adminUrl: string,
  databaseName: string,
  passwords: IRolePasswords = {},
): Promise<'created' | 'exists'> => {
  const dbIdent = quoteIdent(databaseName);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let state: 'created' | 'exists' = 'exists';
  try {
    await ensureRoles(admin, passwords);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${dbIdent} OWNER kontur_migrator ENCODING 'UTF8' TEMPLATE template0`);
      state = 'created';
    }
  } finally {
    await admin.end();
  }
  const target = new pg.Client({ connectionString: withDatabase(adminUrl, databaseName) });
  await target.connect();
  try {
    await target.query(`REVOKE ALL ON DATABASE ${dbIdent} FROM PUBLIC`);
    await target.query(`GRANT CONNECT ON DATABASE ${dbIdent} TO kontur_migrator, kontur_app, kontur_backup`);
    await target.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await target.query('GRANT USAGE ON SCHEMA public TO kontur_app, kontur_backup');
    await target.query('GRANT USAGE, CREATE ON SCHEMA public TO kontur_migrator');
  } finally {
    await target.end();
  }
  return state;
};

export const dropDatabase = async (adminUrl: string, databaseName: string): Promise<void> => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
};
