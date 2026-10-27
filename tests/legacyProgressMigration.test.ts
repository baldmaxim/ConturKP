import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { checkSchema, dropDatabase, MIGRATIONS_DIR, listMigrations, migrate, setupDatabase } from '../packages/db/src/index.ts';
import { addRoleCatalog, dropLegacyJobProgress, dropRoleCatalog } from './legacySchema.ts';
import { ADMIN_URL } from './helpers.ts';

it('совместимость очереди старой схемы не удаляет активный прогресс и не подменяет настоящую 0052', async () => {
  const name = 'kontur_kp_test_legacy_progress_' + randomUUID().replaceAll('-', '');
  const url = new URL(ADMIN_URL);
  url.username = 'kontur_migrator';
  url.password = '';
  url.pathname = '/' + name;
  const migratorUrl = url.toString();
  const tempRoot = resolve(tmpdir());
  const partial = mkdtempSync(join(tempRoot, 'kontur-legacy-progress-'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 51)) cpSync(join(MIGRATIONS_DIR, file), join(partial, file));
  await setupDatabase(ADMIN_URL, name);
  const db = new pg.Client({ connectionString: migratorUrl });
  try {
    await db.connect();
    expect((await migrate(db, { testMode: true, dir: partial })).length).toBe(51);
    await addRoleCatalog(migratorUrl);
    const job = (await db.query("INSERT INTO job(kind,dedupe_key,progress) VALUES('test.legacy-progress','legacy-progress',$1::jsonb) RETURNING id", [JSON.stringify({ phase: 'processing', completed: 1, total: 2, unit: 'files' })])).rows[0].id;
    await expect(dropLegacyJobProgress(migratorUrl)).rejects.toThrow('Прогресс активного задания');
    expect((await db.query('SELECT progress FROM job WHERE id=$1', [job])).rows[0].progress.completed).toBe(1);
    await db.query("UPDATE job SET status='succeeded',finished_at=now() WHERE id=$1", [job]);
    await dropRoleCatalog(migratorUrl);
    expect((await db.query("SELECT 1 FROM pg_attribute WHERE attrelid='job'::regclass AND attname='progress' AND NOT attisdropped")).rows).toEqual([]);
    expect((await db.query('SELECT kind,status,dedupe_key FROM job WHERE id=$1', [job])).rows[0]).toEqual({ kind: 'test.legacy-progress', status: 'succeeded', dedupe_key: 'legacy-progress' });
    expect(await migrate(db, { testMode: true })).toEqual(listMigrations().filter(file => file.version > 51).map(file => file.version));
    expect((await checkSchema(db)).ok).toBe(true);
    await db.query('UPDATE job SET progress=$2::jsonb WHERE id=$1', [job, JSON.stringify({ completed: 1 })]);
    await dropLegacyJobProgress(migratorUrl);
    expect((await db.query('SELECT progress FROM job WHERE id=$1', [job])).rows[0].progress).toEqual({ completed: 1 });
    await db.query("COMMENT ON COLUMN job.progress IS 'kontur-test-legacy-job-progress'");
    await expect(dropLegacyJobProgress(migratorUrl)).rejects.toThrow('Реальная миграция 0052 уже применена');
    await db.query('COMMENT ON COLUMN job.progress IS NULL');
    await expect(db.query("UPDATE job SET progress='[]'::jsonb WHERE id=$1", [job])).rejects.toMatchObject({ code: '23514', constraint: 'job_progress_object' });
    await expect(addRoleCatalog('postgresql://postgres@127.0.0.1:1/production_guard')).rejects.toThrow('только тестовая БД');
    await expect(dropLegacyJobProgress('postgresql://postgres@127.0.0.1:1/production_guard')).rejects.toThrow('только тестовая БД');
  } finally {
    await db.end().catch(() => undefined);
    await dropDatabase(ADMIN_URL, name);
    if (!resolve(partial).startsWith(tempRoot + sep)) throw new Error('Unexpected fixture cleanup path');
    rmSync(partial, { recursive: true, force: true });
  }
}, 60_000);
