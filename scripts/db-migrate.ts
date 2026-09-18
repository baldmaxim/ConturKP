// Команда migrate (ADR-002 §6): отдельно от запуска служб, под ролью kontur_migrator.
import pg from 'pg';
import { migrate, MigrationError } from '../packages/db/src/index.ts';
import { fail } from './cli.ts';

const url = process.env.DATABASE_MIGRATOR_URL;
if (!url) fail('нужен DATABASE_MIGRATOR_URL', 2);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const done = await migrate(client, { testMode: process.env.KONTUR_ENV === 'test', log: (l) => console.log(l) });
  console.log(`готово, применено миграций: ${done.length}`);
} catch (err) {
  if (err instanceof MigrationError) fail(`ошибка миграции: ${err.message}`, 3);
  throw err;
} finally {
  await client.end();
}
