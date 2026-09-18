// Создание ролей kontur_migrator / kontur_app / kontur_backup и базы из DATABASE_URL.
// Требует DATABASE_ADMIN_URL (суперпользователь). Пароли ролей — из окружения, не выводятся.
import { databaseNameOf, setupDatabase } from '../packages/db/src/index.ts';
import { fail } from './cli.ts';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) fail('нужны DATABASE_ADMIN_URL и DATABASE_URL', 2);
const dbName = databaseNameOf(appUrl!);
const state = await setupDatabase(adminUrl!, dbName, {
  appPassword: process.env.KONTUR_APP_DB_PASSWORD,
  migratorPassword: process.env.KONTUR_MIGRATOR_DB_PASSWORD,
  backupPassword: process.env.KONTUR_BACKUP_DB_PASSWORD,
});
console.log(`база ${dbName}: ${state === 'created' ? 'создана' : 'уже существует'}; роли и права выставлены`);
