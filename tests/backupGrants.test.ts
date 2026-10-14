// Этап 17 (S17-01, миграция 0043): роль копии kontur_backup читает все таблицы и последовательности и ничего не
// пишет; права на объекты будущих миграций выдаются автоматически; снимок для pg_dump экспортируется этой ролью.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupRoleProblems, openBackupSnapshot, restoreSafetyProblems } from '../packages/db/src/index.ts';
import { createTestDb, type ITestDb } from './helpers.ts';

let db: ITestDb;
const as = (role: string): string => {
  const u = new URL(db.appUrl);
  u.username = role;
  return u.toString();
};

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db.drop());

describe('роль резервной копии', () => {
  it('после всех миграций: всё читается, записи, создания объектов и SECURITY DEFINER нет', async () => {
    expect(await backupRoleProblems(db.pool)).toEqual([]);
    // Сторож видит нарушение: роль приложения пишет — для неё отчёт не пуст.
    expect((await backupRoleProblems(db.pool, 'kontur_app')).some((p) => p.startsWith('есть права записи'))).toBe(true);
  });

  it('таблица и последовательность новой миграции получают SELECT для копии сами (права по умолчанию)', async () => {
    const migrator = new pg.Client({ connectionString: db.migratorUrl });
    await migrator.connect();
    try {
      await migrator.query('CREATE TABLE stage17_probe (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text)');
      const r = await migrator.query<{ t: boolean; s: boolean }>(
        "SELECT has_table_privilege('kontur_backup', 'stage17_probe', 'SELECT') AS t, has_sequence_privilege('kontur_backup', 'stage17_probe_id_seq', 'SELECT') AS s",
      );
      expect(r.rows[0]).toEqual({ t: true, s: true });
      expect(await backupRoleProblems(db.pool)).toEqual([]);
    } finally {
      await migrator.query('DROP TABLE IF EXISTS stage17_probe');
      await migrator.end();
    }
  });

  it('восстановимость дампа: функции ограничений, индексов и вычисляемых столбцов задают search_path (S17-20)', async () => {
    expect(await restoreSafetyProblems(db.pool)).toEqual([]);
    const migrator = new pg.Client({ connectionString: db.migratorUrl });
    await migrator.connect();
    try {
      // Новая функция в CHECK без search_path — сторож её видит.
      await migrator.query("CREATE FUNCTION stage17_ok(v int) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT v > 0'");
      await migrator.query('CREATE TABLE stage17_checked (v int CHECK (stage17_ok(v)))');
      expect((await restoreSafetyProblems(db.pool)).join()).toContain('stage17_ok(integer)');
    } finally {
      await migrator.query('DROP TABLE IF EXISTS stage17_checked');
      await migrator.query('DROP FUNCTION IF EXISTS stage17_ok(int)');
      await migrator.end();
    }
  });

  it('снимок экспортирует роль копии: версия схемы, перечень blob в том же снимке', async () => {
    const snap = await openBackupSnapshot(as('kontur_backup'));
    try {
      expect(snap.snapshotId).toMatch(/^[0-9A-F]+-[0-9A-F]+-\d+$/u);
      expect(snap.schemaVersion).toBeGreaterThanOrEqual(43);
      expect(snap.migrations).toBe(snap.schemaVersion);
      expect(snap.database).toBe(db.name);
      expect(Array.isArray(snap.blobs)).toBe(true);
      // Роль копии не может писать даже внутри своей сессии.
      const c = new pg.Client({ connectionString: as('kontur_backup') });
      await c.connect();
      await expect(c.query("INSERT INTO process_heartbeat (process_id, kind, pid, started_at, last_seen_at) VALUES ('x', 'worker', 1, now(), now())")).rejects.toThrow(/permission denied/u);
      await c.end();
    } finally {
      await snap.close();
    }
  });
});
