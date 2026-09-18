// Перед тестами: кластер доступен, роли kontur_* существуют; оставшиеся тестовые базы удаляются.
import pg from 'pg';
import { ensureRoles } from '../packages/db/src/index.ts';

const ADMIN_URL = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';

export default async (): Promise<void> => {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
  } catch {
    throw new Error('тестовый PostgreSQL недоступен: выполните npm run pg:init && npm run pg:start (или задайте KONTUR_TEST_ADMIN_URL)');
  }
  try {
    await ensureRoles(client);
    const stale = await client.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'kontur_kp_test_%'");
    for (const row of stale.rows) await client.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
};
