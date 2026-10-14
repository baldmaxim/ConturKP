// Резервная копия (этап 17, ADR-011 §7, проект §4): согласованный снимок БД для pg_dump и перечня файлов.
// Сессия роли kontur_backup открывает REPEATABLE READ READ ONLY и экспортирует снимок; в нём же читаются версия
// схемы и перечень blob. Файл хранилища пишется до строки blob, файлы не удаляются, blob неизменяема — значит,
// каждый файл перечня снимка уже лежит в хранилище, когда pg_dump импортирует тот же снимок.
import pg from 'pg';
import type { Queryable } from './pool.ts';

export interface IBackupBlob {
  sha256: string;
  sizeBytes: number;
  storageKey: string;
}

export interface IBackupSnapshot {
  snapshotId: string;
  schemaVersion: number;
  migrations: number;
  serverVersionNum: number;
  database: string;
  blobs: IBackupBlob[];
  // Снимок действует, пока открыта эта транзакция: закрывать после того, как pg_dump его импортировал.
  close: () => Promise<void>;
}

export const openBackupSnapshot = async (connectionString: string): Promise<IBackupSnapshot> => {
  const client = new pg.Client({ connectionString, application_name: 'kontur-kp-backup' });
  // Обрыв соединения во время копии — отказ копии, а не падение процесса (S17-02).
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snap = await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id');
    const schema = await client.query<{ version: number | null; n: number }>('SELECT max(version) AS version, count(*)::int AS n FROM schema_migration');
    const server = await client.query<{ v: string; db: string }>("SELECT current_setting('server_version_num') AS v, current_database() AS db");
    const blobs = await client.query<{ sha256: string; size_bytes: number; storage_key: string }>('SELECT sha256, size_bytes, storage_key FROM blob ORDER BY sha256');
    return {
      snapshotId: snap.rows[0]!.id,
      schemaVersion: schema.rows[0]!.version ?? 0,
      migrations: schema.rows[0]!.n,
      serverVersionNum: Number(server.rows[0]!.v),
      database: server.rows[0]!.db,
      blobs: blobs.rows.map((b) => ({ sha256: b.sha256, sizeBytes: Number(b.size_bytes), storageKey: b.storage_key })),
      close: async () => {
        await client.query('COMMIT').catch(() => undefined);
        await client.end().catch(() => undefined);
      },
    };
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
};

// Сторож роли копии: всё читается, ничего не пишется. Пустой список — роль в порядке. Тот же запрос — предполётная
// проверка команды копии на рабочей базе.
export const backupRoleProblems = async (db: Queryable, role = 'kontur_backup'): Promise<string[]> => {
  const problems: string[] = [];
  const unreadable = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
        AND NOT has_table_privilege($1, c.oid, 'SELECT') ORDER BY 1`,
    [role],
  );
  if (unreadable.rows.length > 0) problems.push(`нет SELECT: ${unreadable.rows.map((r) => r.name).join(', ')}`);
  const writable = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
        AND has_table_privilege($1, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') ORDER BY 1`,
    [role],
  );
  if (writable.rows.length > 0) problems.push(`есть права записи: ${writable.rows.map((r) => r.name).join(', ')}`);
  // CASE: порядок условий WHERE планировщик не гарантирует, а has_sequence_privilege падает на не-последовательности.
  const sequences = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1, c.oid, 'USAGE, UPDATE') ELSE false END ORDER BY 1`,
    [role],
  );
  if (sequences.rows.length > 0) problems.push(`может менять последовательности: ${sequences.rows.map((r) => r.name).join(', ')}`);
  const scope = await db.query<{ schema_create: boolean; db_create: boolean }>(
    `SELECT has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
            has_database_privilege($1, current_database(), 'CREATE, TEMPORARY') AS db_create`,
    [role],
  );
  if (scope.rows[0]!.schema_create) problems.push('может создавать объекты в схеме public');
  if (scope.rows[0]!.db_create) problems.push('может создавать схемы или временные таблицы в базе');
  const definer = await db.query<{ name: string }>(
    `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`,
  );
  if (definer.rows.length > 0) problems.push(`функции SECURITY DEFINER: ${definer.rows.map((r) => r.name).join(', ')}`);
  return problems;
};

// Ссылки на blob из всех таблиц (внешние ключи) — для сверки восстановленной копии: каждый упомянутый файл
// должен быть в восстановленном хранилище с тем же хэшем (ADR-011 §11).
export const blobReferences = async (db: Queryable): Promise<Array<{ table: string; column: string; count: number }>> => {
  const fks = await db.query<{ tbl: string; col: string }>(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'blob'::regclass AND array_length(c.conkey, 1) = 1
      ORDER BY 1, 2`,
  );
  const out: Array<{ table: string; column: string; count: number }> = [];
  for (const fk of fks.rows) {
    const r = await db.query<{ n: number }>(`SELECT count(DISTINCT ${pg.escapeIdentifier(fk.col)})::int AS n FROM ${fk.tbl.split('.').map((x) => pg.escapeIdentifier(x.replaceAll('"', ''))).join('.')}`);
    out.push({ table: fk.tbl, column: fk.col, count: r.rows[0]!.n });
  }
  return out;
};

// Восстановимость дампа (S17-20): pg_restore грузит данные с пустым search_path, поэтому функция, на которую прямо
// ссылается ограничение, индекс или вычисляемый столбец, обязана сама задавать search_path — иначе её вложенные
// вызовы функций схемы без имени схемы при COPY не находятся. Возвращает сигнатуры таких функций.
export const restoreUnsafeFunctions = async (db: Queryable): Promise<string[]> => {
  const r = await db.query<{ fn: string }>(
    `SELECT DISTINCT d.refobjid::regprocedure::text AS fn
       FROM pg_depend d
       JOIN pg_proc p ON p.oid = d.refobjid
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE d.refclassid = 'pg_proc'::regclass AND n.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = p.oid AND e.deptype = 'e')
        AND (d.classid IN ('pg_constraint'::regclass, 'pg_attrdef'::regclass)
             OR (d.classid = 'pg_class'::regclass AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = d.objid AND c.relkind IN ('i', 'I', 'm'))))
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS cfg WHERE cfg LIKE 'search_path=%')
      ORDER BY 1`,
  );
  return r.rows.map((x) => x.fn);
};

export const restoreSafetyProblems = async (db: Queryable): Promise<string[]> =>
  (await restoreUnsafeFunctions(db)).map((fn) => `функция ${fn} используется ограничением, индексом или вычисляемым столбцом без SET search_path — дамп не восстановится`);
