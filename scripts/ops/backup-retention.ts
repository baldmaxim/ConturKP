// Default is a plan. --apply requires the exact latest completed point; it verifies its dump and all blob hashes.
import { pruneBackupPoints } from '../../packages/storage/src/backupRetention.ts';
import { argValue, hasFlag } from '../cli.ts';

const main = async (): Promise<void> => {
  const policyFile = argValue('config') ?? process.env.BACKUP_RETENTION_CONFIG;
  const backupRoot = process.env.BACKUP_ROOT;
  const storageRoot = process.env.STORAGE_ROOT;
  const completedPoint = argValue('completed-backup');
  if (!policyFile || !backupRoot || !storageRoot || !completedPoint) {
    throw new Error('нужны BACKUP_RETENTION_CONFIG (или --config), BACKUP_ROOT, STORAGE_ROOT, --completed-backup <имя последней успешной точки>');
  }
  const r = await pruneBackupPoints({ policyFile, backupRoot, storageRoot, completedPoint, apply: hasFlag('apply'), log: console.log });
  console.log(JSON.stringify(r, null, 2));
};
void main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : 'ошибка очистки'); process.exitCode = 1; });
