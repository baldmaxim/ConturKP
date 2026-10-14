// Резервная копия БД и файлов (этап 17, ADR-011 §7–10, проект §4.2–4.3). Общая для команды ops:backup и тестов.
// Порядок: охранники → права роли копии → снимок → pg_dump со снимком → файлы по перечню снимка → манифест последним.
// Неудачная копия удаляет только свой каталог; прошлые копии не трогаются.
import { mkdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { backupRoleProblems, openBackupSnapshot, restoreSafetyProblems } from '../../packages/db/src/index.ts';
import {
  BACKUP_FORMAT,
  BackupError,
  backupDirName,
  blobListSha256,
  copyBackupFiles,
  DUMP_NAME,
  latestCompleteBackup,
  pathsOverlap,
  readManifest,
  writeManifest,
  type IBackupManifest,
} from '../../packages/storage/src/index.ts';
import { CLUSTER_ID_SQL, clusterIdentityProblem, runPgDump, versionProblem, type IPgTool } from './pgTools.ts';

// Векторы и кеш эмбеддингов пересобираются (ADR-011 §7, ADR-012 §10); heartbeat процессов — не данные.
export const EXCLUDED_TABLE_DATA = ['public.search_chunk_vector', 'public.embedding_cache', 'public.process_heartbeat'] as const;

const RESERVE_BYTES = 512 * 1024 * 1024;

export interface IBackupOptions {
  backupUrl: string;
  storageRoot: string;
  backupRoot: string;
  tool: IPgTool;
  host: string;
  build: string | null;
  log: (line: string) => void;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  freeBytes?: (dir: string) => Promise<number | null>;
  // Копия перед первым обновлением на этап 17: у kontur_backup прав ещё нет (их выдаёт миграция 0043), поэтому
  // копию снимает владелец схемы kontur_migrator; проверяется только, что он читает всё.
  preUpdate?: boolean;
}

export interface IBackupResult {
  dir: string;
  manifest: IBackupManifest;
  dumpCommand: string;
}

const defaultFree = async (dir: string): Promise<number | null> => {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
};

export const runBackup = async (o: IBackupOptions): Promise<IBackupResult> => {
  const now = o.now ?? (() => new Date());
  if (await pathsOverlap(o.backupRoot, o.storageRoot)) {
    throw new BackupError('backup_root_overlaps', 'каталог копий совпадает с хранилищем или лежит внутри него: копия на том же месте — не копия (ADR-011 §8)');
  }
  await mkdir(o.backupRoot, { recursive: true });

  // Предполётная проверка роли: копия, которая не читает часть таблиц, — не копия (S17-01).
  let role = '';
  const check = new pg.Client({ connectionString: o.backupUrl, application_name: 'kontur-kp-backup' });
  check.on('error', () => undefined);
  await check.connect();
  try {
    const user = await check.query<{ u: string }>('SELECT current_user AS u');
    role = user.rows[0]!.u;
    const expected = o.preUpdate ? 'kontur_migrator' : 'kontur_backup';
    if (role !== expected) throw new BackupError('backup_role', `копия снимается ролью ${expected}, а подключение — роль ${role}`);
    if (o.preUpdate) {
      // Владелец пишет — это ожидаемо; важно только, что он читает всё.
      const unreadable = (await backupRoleProblems(check, role)).filter((p) => p.startsWith('нет SELECT'));
      if (unreadable.length > 0) throw new BackupError('backup_role', `роль ${role}: ${unreadable.join('; ')}`);
    } else {
      const problems = await backupRoleProblems(check);
      if (problems.length > 0) throw new BackupError('backup_role', `права роли копии: ${problems.join('; ')}. Выполните npm run db:migrate`);
      const restorable = await restoreSafetyProblems(check);
      if (restorable.length > 0) throw new BackupError('dump_not_restorable', `${restorable.join('; ')}. Выполните npm run db:migrate`);
    }
    // pg_dump в режиме docker идёт в сервер своего контейнера (R17-03): тот ли это кластер, что у BACKUP_DATABASE_URL.
    // Без psql сверку заменяет снимок: чужой кластер его не знает, и pg_dump откажет.
    if (o.tool.psql) {
      const direct = (await check.query<{ system_identifier: string }>(CLUSTER_ID_SQL)).rows[0]?.system_identifier ?? '';
      const problem = await clusterIdentityProblem(o.tool, o.backupUrl, String(direct), o.env);
      if (problem) throw new BackupError('pg_dump_route', problem);
    }
  } finally {
    await check.end().catch(() => undefined);
  }

  const startedAt = now();
  const snap = await openBackupSnapshot(o.backupUrl);
  let dir: string | null = null;
  try {
    const vp = versionProblem(o.tool, snap.serverVersionNum);
    if (vp) throw new BackupError('pg_dump_version', vp);
    const previous = await latestCompleteBackup(o.backupRoot);
    const prevSet = previous ? new Set((await readManifest(previous).catch(() => null))?.blobs.map(([sha]) => sha) ?? []) : new Set<string>();
    const newBytes = snap.blobs.filter((b) => !prevSet.has(b.sha256)).reduce((a, b) => a + b.sizeBytes, 0);
    const free = await (o.freeBytes ?? defaultFree)(o.backupRoot);
    if (free !== null && free < newBytes + RESERVE_BYTES) {
      throw new BackupError('backup_space', `в каталоге копий свободно ${Math.floor(free / 1024 ** 2)} МБ, нужно не меньше ${Math.ceil((newBytes + RESERVE_BYTES) / 1024 ** 2)} МБ`);
    }
    dir = join(o.backupRoot, backupDirName(startedAt));
    await mkdir(dir);
    o.log(`копия ${dir}: снимок ${snap.snapshotId}, схема ${snap.schemaVersion}, файлов ${snap.blobs.length}`);
    const dump = await runPgDump(o.tool, o.backupUrl, { snapshotId: snap.snapshotId, excludeTableData: EXCLUDED_TABLE_DATA, outFile: join(dir, DUMP_NAME), env: o.env });
    if (dump.code !== 0) throw new BackupError('pg_dump_failed', `pg_dump завершился с кодом ${dump.code}: ${dump.stderr.trim().slice(0, 600)}`);
    o.log(`дамп: ${dump.sizeBytes} байт, SHA-256 ${dump.sha256}`);
    // pg_dump импортировал снимок в начале работы и завершился — снимок больше не нужен.
    await snap.close();
    const copy = await copyBackupFiles({ storageRoot: o.storageRoot, destDir: dir, files: snap.blobs, previousDir: previous });
    o.log(`файлы: скопировано ${copy.copied} (${copy.bytes} байт), связано с прошлой копией ${copy.linked}`);
    const manifest: IBackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      host: o.host,
      build: o.build,
      role,
      schema: { version: snap.schemaVersion, migrations: snap.migrations },
      server: { versionNum: snap.serverVersionNum },
      dump: { file: DUMP_NAME, sizeBytes: dump.sizeBytes, sha256: dump.sha256, tool: o.tool.version, excludedTableData: [...EXCLUDED_TABLE_DATA] },
      files: {
        count: snap.blobs.length,
        totalBytes: snap.blobs.reduce((a, b) => a + b.sizeBytes, 0),
        listSha256: blobListSha256(snap.blobs),
        copied: copy.copied,
        linked: copy.linked,
      },
      blobs: snap.blobs.map((b) => [b.sha256, b.sizeBytes]),
    };
    await writeManifest(dir, manifest);
    return { dir, manifest, dumpCommand: dump.command };
  } catch (err) {
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    throw err;
  } finally {
    await snap.close();
  }
};
