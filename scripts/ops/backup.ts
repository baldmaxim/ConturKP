// npm run ops:backup [-- --pre-update] — резервная копия БД и файлов (этап 17, ADR-011 §7–10, docs/runbooks/backup-restore.md).
// Окружение: BACKUP_DATABASE_URL (роль kontur_backup), STORAGE_ROOT, BACKUP_ROOT; PG_BIN_DIR или PG_DOCKER_CONTAINER,
// если pg_dump не в PATH. Пароли и адреса не печатаются. Запуск планировщиком Windows — ежедневно и перед обновлением.
// --pre-update — только перед первым обновлением установки этапов 14–16 на этап 17: у kontur_backup ещё нет прав
// (их выдаёт миграция 0043), копию снимает владелец схемы по DATABASE_MIGRATOR_URL.
// Код выхода: 0 — копия завершена (манифест записан), 1 — отказ, 2 — неверная конфигурация.
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { buildId } from '../../packages/config/src/index.ts';
import { BackupError } from '../../packages/storage/src/index.ts';
import { pruneBackupPoints } from '../../packages/storage/src/backupRetention.ts';
import { hasFlag } from '../cli.ts';
import { runBackup } from './backup-lib.ts';
import { findPgTools } from './pgTools.ts';

const log = (line: string): void => console.log(`${new Date().toISOString()} [backup] ${line}`);

const run = (file: string, args: string[]) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout) }));
  });

const main = async (): Promise<void> => {
  const env = process.env;
  const preUpdate = hasFlag('pre-update');
  const urlKey = preUpdate ? 'DATABASE_MIGRATOR_URL' : 'BACKUP_DATABASE_URL';
  const missing = [urlKey, 'STORAGE_ROOT', 'BACKUP_ROOT'].filter((k) => !env[k]);
  if (missing.length > 0) {
    log(`не задано: ${missing.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const tool = await findPgTools({ platform: process.platform, env, run });
  if ('error' in tool) {
    log(tool.error);
    process.exitCode = 1;
    return;
  }
  log(`инструмент: ${tool.version} (${tool.mode === 'docker' ? `контейнер ${tool.container}` : 'локально'})`);
  let completed = false;
  try {
    const r = await runBackup({ backupUrl: env[urlKey]!, storageRoot: env.STORAGE_ROOT!, backupRoot: env.BACKUP_ROOT!, tool, host: hostname(), build: buildId(), log, preUpdate });
    log(`копия завершена: ${r.dir}`);
    log(`схема ${r.manifest.schema.version}; дамп ${r.manifest.dump.sizeBytes} байт, SHA-256 ${r.manifest.dump.sha256}; файлов ${r.manifest.files.count} (${r.manifest.files.totalBytes} байт), перечень ${r.manifest.files.listSha256}`);
    completed = true;
    if ((hasFlag('retention') || env.BACKUP_RETENTION_CONFIG) && !preUpdate) {
      if (!env.BACKUP_RETENTION_CONFIG) throw new BackupError('backup_retention', 'для --retention нужен BACKUP_RETENTION_CONFIG');
      const result = await pruneBackupPoints({ policyFile: env.BACKUP_RETENTION_CONFIG, backupRoot: env.BACKUP_ROOT!, storageRoot: env.STORAGE_ROOT!, completedPoint: r.dir.split(/[\\/]/u).at(-1)!, apply: true, freshlyVerifiedManifest: r.manifest, log });
      log(`очистка: удалено ${result.removed.length}, оставлено ${result.keep.length}, служебных папок ${result.ignored.length}`);
    }
  } catch (err) {
    const stage = completed ? 'копия сохранена; очистка не завершена' : 'копия не снята';
    log(err instanceof BackupError ? `${stage} (${err.code}): ${err.message}` : `${stage}: ${err instanceof Error ? err.message : 'неизвестная ошибка'}`);
    process.exitCode = 1;
  }
};

void main();
