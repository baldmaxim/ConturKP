// Проверка восстановления на чистом окружении (этап 17, ADR-011 §11, проект §4.4). Общая для ops:restore-check и
// тестов: только новая база kontur_restore_* и пустой каталог хранилища — никогда поверх рабочей системы, ключа
// обхода нет. Каждый шаг — строка PASS/FAIL с фактом (команда без секретов, хэши, числа).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { blobReferences, checkSchema, createPool, dropDatabase, restoreUnsafeFunctions, setupDatabase, type IRolePasswords, type Pool } from '../../packages/db/src/index.ts';
import {
  BackupError,
  blobListSha256,
  DUMP_NAME,
  fileDigest,
  isEmptyDir,
  pathsOverlap,
  readManifest,
  restoreBackupFiles,
  type IBackupManifest,
} from '../../packages/storage/src/index.ts';
import { join } from 'node:path';
import { CLUSTER_ID_SQL, clusterIdentityProblem, runPgRestore, runPsql, type IPgTool } from './pgTools.ts';

export const RESTORE_DB_RE = /^kontur_restore_[a-z0-9_]{1,40}$/u;

export interface IRestoreStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface IRestoreOptions {
  backupDir: string;
  // Суперпользователь кластера проверки (служебная база, обычно postgres).
  adminUrl: string;
  dbName: string;
  storageRoot: string;
  // Рабочая система — для охранников: адреса и каталоги, поверх которых восстанавливать нельзя.
  production: { databaseUrl?: string | undefined; storageRoot?: string | undefined; backupRoot?: string | undefined };
  tool: IPgTool;
  passwords?: IRolePasswords;
  env?: Record<string, string | undefined>;
  log: (line: string) => void;
}

export interface IRestoreResult {
  ok: boolean;
  steps: IRestoreStep[];
  manifest: IBackupManifest | null;
  appUrl: string;
  pool: Pool | null;
}

const withDb = (url: string, db: string, user?: string, password?: string): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user !== undefined) {
    u.username = user;
    u.password = password ?? '';
  }
  return u.toString();
};

const sameServerAndDb = (a: string, b: string): boolean => {
  const x = new URL(a);
  const y = new URL(b);
  return x.hostname === y.hostname && (x.port || '5432') === (y.port || '5432') && x.pathname === y.pathname;
};

// Охранники до любой записи: ни одного действия, если цель может оказаться рабочей системой.
export const restoreGuards = async (o: Pick<IRestoreOptions, 'adminUrl' | 'dbName' | 'storageRoot' | 'production' | 'backupDir'>): Promise<string[]> => {
  const problems: string[] = [];
  if (!RESTORE_DB_RE.test(o.dbName)) problems.push(`имя базы проверки должно начинаться с kontur_restore_ (латиница, цифры, _): «${o.dbName}»`);
  if (o.production.databaseUrl && sameServerAndDb(withDb(o.adminUrl, o.dbName), o.production.databaseUrl)) {
    problems.push('база проверки совпадает с рабочей базой (DATABASE_URL)');
  }
  const admin = new pg.Client({ connectionString: o.adminUrl });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [o.dbName]);
    if ((exists.rowCount ?? 0) > 0) problems.push(`база «${o.dbName}» уже существует: восстановление только в новую базу`);
    const su = await admin.query<{ s: boolean }>('SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user');
    if (!su.rows[0]?.s) problems.push('RESTORE_ADMIN_URL — не суперпользователь: нужен для создания базы, ролей и расширений');
  } finally {
    await admin.end().catch(() => undefined);
  }
  if (!(await isEmptyDir(o.storageRoot))) problems.push('каталог хранилища проверки не пуст: восстановление только в пустой каталог');
  for (const [label, dir] of [
    ['рабочим хранилищем (STORAGE_ROOT)', o.production.storageRoot],
    ['каталогом копий (BACKUP_ROOT)', o.production.backupRoot],
    ['каталогом самой копии', o.backupDir],
  ] as const) {
    if (dir && (await pathsOverlap(o.storageRoot, dir))) problems.push(`каталог хранилища проверки пересекается с ${label}`);
  }
  return problems;
};

const directQuery = async <T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> => {
  const c = new pg.Client({ connectionString: url });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end().catch(() => undefined);
  }
};

// Маршрут pg_restore (R17-03): инструмент подключится к тому же кластеру, что проверили охранники, и базы проверки
// там тоже нет. Только чтение, до любой записи. Имя базы уже проверено охранниками (RESTORE_DB_RE).
export const restoreRouteProblems = async (o: Pick<IRestoreOptions, 'tool' | 'adminUrl' | 'dbName' | 'env'>): Promise<string[]> => {
  if (!o.tool.psql) return ['рядом с pg_restore нет psql: без него нельзя проверить, в какой кластер пойдёт восстановление'];
  const direct = (await directQuery<{ system_identifier: string }>(o.adminUrl, CLUSTER_ID_SQL))[0]?.system_identifier ?? '';
  const identity = await clusterIdentityProblem(o.tool, o.adminUrl, String(direct), o.env);
  if (identity) return [identity];
  const seen = await runPsql(o.tool, o.adminUrl, `SELECT count(*) FROM pg_database WHERE datname = '${o.dbName}'`, o.env);
  if (seen.code !== 0 || seen.stdout !== '0') return [`база «${o.dbName}» видна инструменту восстановления как существующая или не проверена (${seen.stdout || seen.stderr.trim().slice(0, 200)})`];
  return [];
};

// Метка новой базы (R17-03): после создания базы проверки инструмент должен увидеть именно её — по метке в
// комментарии, поставленной прямым подключением. Метка снимается после сверки.
const sameDatabaseProblem = async (o: Pick<IRestoreOptions, 'tool' | 'adminUrl' | 'dbName' | 'env'>): Promise<string | null> => {
  const mark = `kontur-restore-check ${randomBytes(12).toString('hex')}`;
  await directQuery(o.adminUrl, `COMMENT ON DATABASE "${o.dbName}" IS '${mark}'`);
  const seen = await runPsql(o.tool, o.adminUrl, `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '${o.dbName}'`, o.env);
  await directQuery(o.adminUrl, `COMMENT ON DATABASE "${o.dbName}" IS NULL`);
  return seen.code === 0 && seen.stdout === mark ? null : `инструмент восстановления не видит метку новой базы «${o.dbName}»: это другая база или другой кластер`;
};

export const runRestoreCheck = async (o: IRestoreOptions): Promise<IRestoreResult> => {
  const steps: IRestoreStep[] = [];
  const step = (name: string, ok: boolean, detail: string): boolean => {
    steps.push({ name, ok, detail });
    o.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    return ok;
  };
  const appUrl = withDb(o.adminUrl, o.dbName, 'kontur_app', o.passwords?.appPassword);
  const result = (manifest: IBackupManifest | null, pool: Pool | null): IRestoreResult => ({ ok: steps.every((s) => s.ok), steps, manifest, appUrl, pool });

  const guards = await restoreGuards(o);
  if (!step('охранники: новая база, пустой каталог, не рабочая система', guards.length === 0, guards.join('; ') || `база ${o.dbName}, каталог пуст`)) return result(null, null);

  let manifest: IBackupManifest;
  try {
    manifest = await readManifest(o.backupDir);
  } catch (err) {
    step('манифест копии', false, (err as Error).message);
    return result(null, null);
  }
  step('манифест копии', true, `${manifest.format}, создан ${manifest.createdAt}, схема ${manifest.schema.version}, файлов ${manifest.files.count}, перечень ${manifest.files.listSha256}`);
  const dumpFile = join(o.backupDir, DUMP_NAME);
  const dump = await fileDigest(dumpFile).catch(() => null);
  if (!step('дамп совпадает с манифестом', dump !== null && dump.sha256 === manifest.dump.sha256 && dump.size === manifest.dump.sizeBytes, dump ? `SHA-256 ${dump.sha256}, ${dump.size} байт` : 'файла дампа нет')) {
    return result(manifest, null);
  }

  // До любой записи: pg_restore пойдёт в тот же кластер, что проверили охранники (R17-03).
  const route = await restoreRouteProblems(o);
  if (!step('pg_restore — тот же кластер, что проверили охранники', route.length === 0, route.join('; ') || `${o.tool.mode === 'docker' ? `контейнер ${o.tool.container}` : 'клиент PostgreSQL'}: идентификатор кластера совпал, базы ${o.dbName} нет`)) {
    return result(manifest, null);
  }

  await setupDatabase(o.adminUrl, o.dbName, o.passwords ?? {});
  step('пустая база создана', true, `db:setup → ${o.dbName} (роли, локаль builtin, vector, pg_trgm)`);
  const same = await sameDatabaseProblem(o);
  if (!step('pg_restore видит именно новую базу (метка)', same === null, same ?? 'метка новой базы прочитана инструментом восстановления')) {
    // База создана этим запуском и пуста — удаляется, чтобы не мешать следующей проверке.
    await dropDatabase(o.adminUrl, o.dbName).catch(() => undefined);
    return result(manifest, null);
  }
  // Три секции дампа: после схемы (pre-data) функции ограничений и вычисляемых столбцов без search_path получают его —
  // иначе COPY дампа, снятого до миграции 0043, падает (S17-20). У дампа после 0043 исправлять нечего.
  const target = withDb(o.adminUrl, o.dbName);
  for (const section of ['pre-data', 'data', 'post-data'] as const) {
    const restored = await runPgRestore(o.tool, target, dumpFile, o.env, section);
    if (!step(`pg_restore ${section}`, restored.code === 0, `${restored.command} → код ${restored.code}${restored.code === 0 ? '' : `: ${restored.stderr.trim().slice(0, 600)}`}`)) {
      return result(manifest, null);
    }
    if (section === 'pre-data') {
      const admin = new pg.Client({ connectionString: target });
      admin.on('error', () => undefined);
      await admin.connect();
      try {
        const unsafe = await restoreUnsafeFunctions(admin);
        for (const fn of unsafe) await admin.query(`ALTER FUNCTION ${fn} SET search_path = pg_catalog, public`);
        step('функции ограничений с search_path', true, unsafe.length === 0 ? 'исправлять нечего (дамп после миграции 0043)' : `исправлено перед загрузкой данных: ${unsafe.join(', ')}`);
      } finally {
        await admin.end().catch(() => undefined);
      }
    }
  }

  const pool = createPool(appUrl, 4);
  const schema = await checkSchema(pool);
  step('версия схемы', schema.ok && schema.dbVersion === manifest.schema.version, `в базе ${schema.dbVersion ?? '—'}, в манифесте ${manifest.schema.version}${schema.ok ? '' : `; ${schema.problem}`}`);

  let restoredFiles = 0;
  try {
    restoredFiles = await restoreBackupFiles(o.backupDir, manifest, o.storageRoot);
    step('файлы хранилища: SHA-256 каждого = манифест', restoredFiles === manifest.files.count, `восстановлено ${restoredFiles} из ${manifest.files.count}`);
  } catch (err) {
    step('файлы хранилища: SHA-256 каждого = манифест', false, err instanceof BackupError ? err.message : (err as Error).message);
  }

  const rows = await pool.query<{ sha256: string; size_bytes: number }>('SELECT sha256, size_bytes FROM blob');
  const dbList = blobListSha256(rows.rows.map((r) => ({ sha256: r.sha256, sizeBytes: Number(r.size_bytes) })));
  step('перечень blob базы = перечень манифеста', dbList === manifest.files.listSha256, `строк ${rows.rows.length}, SHA-256 перечня ${dbList}`);

  // Каждая ссылка на файл (выпуски, кандидаты, размещения, оригиналы) — на строку blob, а файл строки сверен выше.
  const refs = await blobReferences(pool);
  const releaseRefs = refs.filter((r) => /release|candidate|delivery|send/u.test(r.table)).reduce((a, r) => a + r.count, 0);
  step('ссылки на файлы', true, `таблиц со ссылками ${refs.length}; ссылок из выпусков, кандидатов, размещений и отправок — ${releaseRefs}`);

  const counts = await pool.query<{ releases: number; approvals: number; fragments: number; vectors: number; chunks: number }>(
    `SELECT (SELECT count(*)::int FROM release) AS releases,
            (SELECT count(*)::int FROM approval) AS approvals,
            (SELECT count(*)::int FROM evidence_fragment) AS fragments,
            (SELECT count(*)::int FROM search_chunk_vector) AS vectors,
            (SELECT count(*)::int FROM search_chunk) AS chunks`,
  );
  const c = counts.rows[0]!;
  step('выпуски, согласования, фрагменты на месте; векторов нет (не копируются)', c.vectors === 0, `выпусков ${c.releases}, согласований ${c.approvals}, фрагментов ${c.fragments}, чанков ${c.chunks}, векторов ${c.vectors}`);
  return result(manifest, pool);
};
