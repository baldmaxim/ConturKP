// Создание ролей kontur_migrator / kontur_app / kontur_backup и базы из DATABASE_URL.
// Требует DATABASE_ADMIN_URL (суперпользователь). Пароли ролей — из окружения, не выводятся.
// Этап 05: PostgreSQL не ниже 17, база с провайдером локали builtin (C.UTF-8) и расширения
// vector, pg_trgm — их создаёт суперпользователь здесь же (ADR-002 §1).
import { databaseNameOf, setupDatabase, SetupError } from '../packages/db/src/index.ts';
import { fail } from './cli.ts';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) fail('нужны DATABASE_ADMIN_URL и DATABASE_URL', 2);
const dbName = databaseNameOf(appUrl!);
const state = await setupDatabase(adminUrl!, dbName, {
  appPassword: process.env.KONTUR_APP_DB_PASSWORD,
  migratorPassword: process.env.KONTUR_MIGRATOR_DB_PASSWORD,
  backupPassword: process.env.KONTUR_BACKUP_DB_PASSWORD,
}).catch((err: unknown) => {
  if (err instanceof SetupError) fail(err.message, 3);
  throw err;
});
console.log(`база ${dbName}: ${state === 'created' ? 'создана' : 'уже существует'}; роли и права выставлены`);
