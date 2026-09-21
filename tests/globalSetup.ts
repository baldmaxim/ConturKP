// Перед тестами: кластер доступен, роли kontur_* существуют; оставшиеся тестовые базы удаляются.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { ensureRoles } from '../packages/db/src/index.ts';

const ADMIN_URL = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';

// Временные каталоги хранилищ и наблюдаемых папок прошлых прогонов: чистим старше суток.
const cleanTempDirs = (): void => {
  const root = tmpdir();
  const dayAgo = Date.now() - 24 * 3600_000;
  for (const name of readdirSync(root)) {
    if (!name.startsWith('kontur-')) continue;
    const path = join(root, name);
    try {
      if (statSync(path).mtimeMs < dayAgo) rmSync(path, { recursive: true, force: true });
    } catch {
      // каталог занят или уже удалён — пропускаем
    }
  }
};

export default async (): Promise<void> => {
  cleanTempDirs();
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
