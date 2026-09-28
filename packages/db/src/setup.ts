// Подготовка кластера: роли и база (ADR-002 §4). Выполняется суперпользователем один раз.
// Пароли ролей берутся из окружения и никуда не выводятся.
import pg from 'pg';
import { checkServerVersion } from './migrate.ts';

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

export class SetupError extends Error {}

// Локаль базы (ADR-002 §1, D-015): при libc-локали C приведение регистра кириллицы не
// выполняется, и русский полнотекстовый поиск ломается тихо — «договор» не находит «Договор».
// Провайдер builtin не зависит от ОС и версии ICU, поэтому поведение на Windows целевого ПК
// и в среде ревью совпадает. Кластер при этом может оставаться с --locale=C.
const CREATE_DATABASE_LOCALE = "LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' ENCODING 'UTF8' TEMPLATE template0";

// Расширения закрытого списка (ADR-002, ADR-012 §18). Роль приложения и мигратор создать их
// не могут: pgvector не помечен trusted, поэтому это делает суперпользователь при подготовке базы.
const EXTENSIONS = ['vector', 'pg_trgm'] as const;

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
    const version = await checkServerVersion(admin);
    if (version) throw new SetupError(version);
    await ensureRoles(admin, passwords);
    const exists = await admin.query<{ datlocprovider: string }>('SELECT datlocprovider FROM pg_database WHERE datname = $1', [databaseName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${dbIdent} OWNER kontur_migrator ${CREATE_DATABASE_LOCALE}`);
      state = 'created';
    } else if (exists.rows[0]!.datlocprovider !== 'b') {
      // Локаль существующей базы не меняется: её выбирают только при создании. Молча
      // продолжать нельзя — миграция поиска всё равно откажет, но позже и менее понятно.
      throw new SetupError(
        `база «${databaseName}» создана до этапа 05 с провайдером локали «${exists.rows[0]!.datlocprovider}», а не builtin: ` +
          'русский полнотекстовый поиск на ней не приводит регистр кириллицы. Базу нужно пересоздать командой db:setup (ADR-002 §1)',
      );
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
    for (const ext of EXTENSIONS) {
      try {
        await target.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
      } catch (err) {
        throw new SetupError(`расширение ${ext} не установлено в PostgreSQL: ${(err as Error).message} (ADR-002, ADR-011)`);
      }
    }
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
