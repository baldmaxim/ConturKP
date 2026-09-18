// Раннер миграций (ADR-002 §5–7): файлы docs/migrations/NNNN_имя.sql, только вперёд,
// каждый файл в своей транзакции, SHA-256 применённого файла сверяется при каждом запуске.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'migrations');

export interface IMigrationFile {
  version: number;
  name: string;
  sha256: string;
  sql: string;
}

export class MigrationError extends Error {}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export const listMigrations = (dir: string = MIGRATIONS_DIR): IMigrationFile[] => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return files.map((file, index) => {
    const m = FILE_RE.exec(file);
    if (!m) throw new MigrationError(`имя файла миграции не по формату NNNN_имя.sql: ${file}`);
    const version = Number(m[1]);
    if (version !== index + 1) throw new MigrationError(`пропуск или повтор номера миграции: ${file}`);
    const raw = readFileSync(resolve(dir, file));
    return {
      version,
      name: file,
      sha256: createHash('sha256').update(raw).digest('hex'),
      sql: raw.toString('utf8'),
    };
  });
};

interface IAppliedRow {
  version: number;
  name: string;
  sha256: string;
}

type Db = Pick<pg.ClientBase, 'query'>;

const readApplied = async (db: Db): Promise<IAppliedRow[]> => {
  const exists = await db.query<{ ok: boolean }>("SELECT to_regclass('public.schema_migration') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) return [];
  const r = await db.query<IAppliedRow>('SELECT version, name, sha256 FROM schema_migration ORDER BY version');
  return r.rows;
};

const verifyApplied = (applied: IAppliedRow[], files: IMigrationFile[]): string | null => {
  for (const row of applied) {
    const file = files[row.version - 1];
    if (!file) return `схема БД новее кода: миграция ${row.name}`;
    if (file.sha256 !== row.sha256 || file.name !== row.name) return `применённая миграция изменена: ${row.name}`;
  }
  return null;
};

export interface ISchemaCheck {
  ok: boolean;
  dbVersion: number;
  expectedVersion: number;
  problem: string | null;
}

// Сверка схемы БД с файлами: server и worker не стартуют при расхождении, /ready его показывает.
export const checkSchema = async (db: Db, files: IMigrationFile[] = listMigrations()): Promise<ISchemaCheck> => {
  const applied = await readApplied(db);
  const expectedVersion = files.length;
  const dbVersion = applied.length;
  const problem =
    verifyApplied(applied, files) ??
    (dbVersion !== expectedVersion ? `не применены миграции: ${dbVersion} из ${expectedVersion}` : null);
  return { ok: problem === null, dbVersion, expectedVersion, problem };
};

export interface IMigrateOptions {
  dir?: string;
  // В тестовом режиме раннер отказывается работать с базой без «test» в имени (ADR-002 §7).
  testMode?: boolean;
  log?: (line: string) => void;
}

const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('kontur_kp_migrate'))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('kontur_kp_migrate'))";

export const migrate = async (client: pg.ClientBase, options: IMigrateOptions = {}): Promise<number[]> => {
  const log = options.log ?? (() => undefined);
  const files = listMigrations(options.dir);
  const db = await client.query<{ name: string }>('SELECT current_database() AS name');
  const dbName = db.rows[0]?.name ?? '';
  if (options.testMode && !dbName.includes('test')) {
    throw new MigrationError(`тестовый режим: база «${dbName}» не содержит «test» в имени`);
  }
  await client.query(LOCK_SQL);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version    int PRIMARY KEY,
        name       text NOT NULL,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query('GRANT SELECT ON schema_migration TO kontur_app, kontur_backup');
    const applied = await readApplied(client);
    const problem = verifyApplied(applied, files);
    if (problem) throw new MigrationError(problem);
    const done: number[] = [];
    for (const file of files.slice(applied.length)) {
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migration (version, name, sha256) VALUES ($1, $2, $3)', [
          file.version,
          file.name,
          file.sha256,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new MigrationError(`миграция ${file.name} не применена: ${(err as Error).message}`);
      }
      done.push(file.version);
      log(`применена ${file.name}`);
    }
    if (done.length === 0) log('схема актуальна, новых миграций нет');
    return done;
  } finally {
    await client.query(UNLOCK_SQL);
  }
};
