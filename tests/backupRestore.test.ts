// A40 (этап 17, ADR-011 §7–11, проект §4): копия БД и файлов с манифестом; восстановление на чистой среде — новая
// база и пустой каталог, никогда поверх рабочих; сверка схемы, хэшей, перечня; сервер на копии открывает исторический
// выпуск, его манифест, оригинал и цитату; поиск честно деградирует (векторы не копируются) и восстанавливается после
// достройки (A42). Требует pg_dump и pg_restore не ниже версии сервера: PATH, PG_BIN_DIR или PG_DOCKER_CONTAINER.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeEmbeddings } from '../packages/adapters/src/index.ts';
import { dropDatabase } from '../packages/db/src/index.ts';
import { readManifest, verifyBackupFiles } from '../packages/storage/src/index.ts';
import { runBackup, EXCLUDED_TABLE_DATA } from '../scripts/ops/backup-lib.ts';
import { findPgTools, type IPgTool } from '../scripts/ops/pgTools.ts';
import { restoreGuards, runRestoreCheck, type IRestoreResult } from '../scripts/ops/restore-lib.ts';
import { createApp } from '../apps/server/src/app.ts';
import { buildStage14, closeStage14, type IStage14 } from './deliveryFixtures.ts';
import { ADMIN_URL, Clock, drain, idem, makeWorker, TestClient } from './helpers.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 900_000 });

let s: IStage14;
let tool: IPgTool;
let backupDir = '';
let restored: IRestoreResult | null = null;
const backupRoot = mkdtempSync(join(tmpdir(), 'kontur-backup-'));
const restoreRoot = mkdtempSync(join(tmpdir(), 'kontur-restore-'));
const restoreDb = `kontur_restore_test_${randomBytes(4).toString('hex')}`;
const legacyDb = `kontur_restore_test_${randomBytes(4).toString('hex')}`;
const log: string[] = [];

const runCmd = (file: string, args: string[]) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout) }));
  });
const as = (role: string): string => {
  const u = new URL(s.st.db.appUrl);
  u.username = role;
  return u.toString();
};
const countVectors = async (pool: { query: (q: string) => Promise<{ rows: Array<{ n: number }> }> }) => (await pool.query('SELECT count(*)::int AS n FROM search_chunk_vector')).rows[0]!.n;
const searchBody = () => ({ context: { kind: 'tender', tenderId: s.st.e.s.tenderA, mode: 'working', stageId: s.st.e.s.stageA }, query: 'Штукатурка стен', limit: 5 });

beforeAll(async () => {
  const found = await findPgTools({ platform: process.platform, env: process.env, run: runCmd });
  if ('error' in found) throw new Error(`среда теста: ${found.error}`);
  tool = found;
  s = await buildStage14({ stage13: { realArtifacts: true } });
  // Индекс поиска с векторами (поддельная модель): копия их не несёт, восстановление достраивает.
  const w = makeWorker(s.st.db, s.st.e.config, 'w-index', new FakeEmbeddings({ dim: 16, batchSize: 8 }));
  for (let i = 0; i < 3; i += 1) {
    await w.maintain({ checkModel: true });
    await drain(w);
  }
  expect(await countVectors(s.st.db.pool)).toBeGreaterThan(0);
});

afterAll(async () => {
  await restored?.pool?.end().catch(() => undefined);
  await dropDatabase(ADMIN_URL, restoreDb).catch(() => undefined);
  await dropDatabase(ADMIN_URL, legacyDb).catch(() => undefined);
  await closeStage14(s);
});

describe('A40: копия БД и файлов', () => {
  it('все строки blob данных этапа — настоящие файлы хранилища', async () => {
    const bad = await s.st.db.pool.query("SELECT count(*)::int AS n FROM blob WHERE storage_key !~ '^sha256/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}$'");
    expect(bad.rows[0]!.n).toBe(0);
  });

  it('копия ролью kontur_backup: дамп со снимком, файлы по перечню, манифест; векторы исключены', async () => {
    const r = await runBackup({ backupUrl: as('kontur_backup'), storageRoot: s.st.e.config.storageRoot, backupRoot, tool, host: 'test', build: null, log: (l) => log.push(l) });
    backupDir = r.dir;
    const m = await readManifest(r.dir);
    const blobs = await s.st.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM blob');
    expect(m.files.count).toBe(blobs.rows[0]!.n);
    expect(m.files.copied).toBe(m.files.count);
    expect(m.schema.version).toBeGreaterThanOrEqual(43);
    expect(m.dump.excludedTableData).toEqual([...EXCLUDED_TABLE_DATA]);
    expect(m.dump.sizeBytes).toBe(statSync(join(r.dir, 'db.dump')).size);
    expect(await verifyBackupFiles(r.dir, m)).toEqual([]);
    expect(r.dumpCommand).not.toContain('PGPASSWORD');
    expect(r.dumpCommand).not.toMatch(/postgres(ql)?:\/\//u);
    expect(log.join('\n')).not.toMatch(/postgres(ql)?:\/\//u);
  });

  it('вторая копия связывает неизменные файлы с прошлой, не копируя заново', async () => {
    const r = await runBackup({
      backupUrl: as('kontur_backup'),
      storageRoot: s.st.e.config.storageRoot,
      backupRoot,
      tool,
      host: 'test',
      build: null,
      log: () => undefined,
      now: () => new Date(Date.now() + 2000),
    });
    const m = await readManifest(r.dir);
    expect(m.files.copied + m.files.linked).toBe(m.files.count);
    expect(await verifyBackupFiles(r.dir, m)).toEqual([]);
  });

  it('каталог копий внутри хранилища, роль приложения вместо роли копии — отказ без каталога копии', async () => {
    await expect(
      runBackup({ backupUrl: as('kontur_backup'), storageRoot: s.st.e.config.storageRoot, backupRoot: join(s.st.e.config.storageRoot, 'backups'), tool, host: 't', build: null, log: () => undefined }),
    ).rejects.toMatchObject({ code: 'backup_root_overlaps' });
    const before = readdirSync(backupRoot).length;
    await expect(runBackup({ backupUrl: s.st.db.appUrl, storageRoot: s.st.e.config.storageRoot, backupRoot, tool, host: 't', build: null, log: () => undefined })).rejects.toMatchObject({
      code: 'backup_role',
    });
    expect(readdirSync(backupRoot).length).toBe(before);
  });
});

describe('A40: восстановление на чистой среде', () => {
  it('охранники: рабочая база, существующая база, чужое имя, непустой каталог, рабочее хранилище — отказ', async () => {
    const occupied = mkdtempSync(join(tmpdir(), 'kontur-occupied-'));
    writeFileSync(join(occupied, 'x'), 'x');
    const problems = await restoreGuards({
      adminUrl: ADMIN_URL,
      dbName: s.st.db.name,
      storageRoot: s.st.e.config.storageRoot,
      production: { databaseUrl: s.st.db.appUrl, storageRoot: s.st.e.config.storageRoot, backupRoot },
      backupDir,
    });
    expect(problems.join('\n')).toMatch(/kontur_restore_/u);
    expect(problems.join('\n')).toMatch(/рабочей базой/u);
    expect(problems.join('\n')).toMatch(/уже существует/u);
    expect(problems.join('\n')).toMatch(/не пуст/u);
    expect(problems.join('\n')).toMatch(/рабочим хранилищем/u);
    const blocked = await runRestoreCheck({ backupDir, adminUrl: ADMIN_URL, dbName: restoreDb, storageRoot: occupied, production: {}, tool, log: () => undefined });
    expect(blocked.ok).toBe(false);
    expect(blocked.steps).toHaveLength(1);
    const exists = await s.st.db.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [restoreDb]);
    expect(exists.rowCount).toBe(0);
  });

  it('новая база и пустой каталог: схема, SHA-256 файлов, перечень, выпуски и согласования; векторов нет', async () => {
    restored = await runRestoreCheck({
      backupDir,
      adminUrl: ADMIN_URL,
      dbName: restoreDb,
      storageRoot: restoreRoot,
      production: { databaseUrl: s.st.db.appUrl, storageRoot: s.st.e.config.storageRoot, backupRoot },
      tool,
      log: (l) => log.push(l),
    });
    expect(restored.steps.filter((x) => !x.ok), JSON.stringify(restored.steps)).toEqual([]);
    expect(restored.ok).toBe(true);
    expect(await countVectors(restored.pool!)).toBe(0);
  });

  it('сервер на копии: исторический выпуск, манифест, оригинал и цитата совпадают с рабочими', async () => {
    const pool = restored!.pool!;
    const config = { ...s.st.e.config, storageRoot: restoreRoot };
    const app = createApp({ config, pool, clock: new Clock().read });
    const manager = new TestClient(app);
    expect((await manager.login('manager')).status).toBe(200);
    const live = s.st.e.s.manager;
    const relLive = await live.get(`/releases/${s.releaseId}`);
    const relCopy = await manager.get(`/releases/${s.releaseId}`);
    expect(relCopy.status, relCopy.text).toBe(200);
    expect(relCopy.body.release?.manifestSha256 ?? relCopy.body.manifestSha256).toBe(relLive.body.release?.manifestSha256 ?? relLive.body.manifestSha256);
    const manLive = await live.getBuffer(`/releases/${s.releaseId}/manifest`);
    const manCopy = await manager.getBuffer(`/releases/${s.releaseId}/manifest`);
    expect(manCopy.status).toBe(200);
    expect(Buffer.compare(manCopy.body as Buffer, manLive.body as Buffer)).toBe(0);
    const original = await manager.getBuffer(`/document-revisions/${s.st.tzRev}/content`);
    expect(original.status).toBe(200);
    expect(Buffer.compare(original.body as Buffer, (await live.getBuffer(`/document-revisions/${s.st.tzRev}/content`)).body as Buffer)).toBe(0);
    const fragment = await s.st.db.pool.query<{ id: string }>("SELECT id FROM evidence_fragment WHERE text LIKE 'Штукатурка стен%' LIMIT 1");
    const cite = await manager.get(`/evidence/${fragment.rows[0]!.id}`);
    expect(cite.status, cite.text).toBe(200);
    expect(JSON.stringify(cite.body)).toContain('Штукатурка стен');
  });

  it('A42: поиск на копии — точный и полнотекстовый работают, смысловой честно недоступен; после достройки векторов — снова полный', async () => {
    const pool = restored!.pool!;
    const config = { ...s.st.e.config, storageRoot: restoreRoot };
    const app = createApp({ config, pool, clock: new Clock().read });
    const manager = new TestClient(app);
    await manager.login('manager');
    const first = await manager.post('/search', searchBody(), { headers: idem() });
    expect(first.status, first.text).toBe(200);
    expect(first.body.semantic).toEqual({ status: 'unavailable', reason: 'index_vectors_missing' });
    const hits = (first.body.fused?.items ?? first.body.lexical?.items ?? []) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
    // Достройка векторов активной версии на месте (ADR-012 §10 в редакции этапа 17).
    const w = makeWorker({ ...s.st.db, pool, name: restoreDb, appUrl: restored!.appUrl, migratorUrl: '', drop: async () => undefined }, config, 'w-restore', new FakeEmbeddings({ dim: 16, batchSize: 8 }));
    for (let i = 0; i < 4; i += 1) {
      await w.maintain({ checkModel: true });
      await drain(w);
    }
    expect(await countVectors(pool)).toBe(await countVectors(s.st.db.pool));
    const again = await manager.post('/search', searchBody(), { headers: idem() });
    expect(again.status).toBe(200);
    expect(again.body.semantic.status).not.toBe('unavailable');
    expect(again.body.scope.chunksWithoutVectors).toBe(0);
  });
});

describe('первое обновление установки этапов 14–16 (до миграции 0043)', () => {
  it('копия владельцем схемы (--pre-update) и восстановление старого дампа: функции ограничений исправляются до загрузки', async () => {
    const migrator = new pg.Client({ connectionString: s.st.db.migratorUrl });
    await migrator.connect();
    const fns = ['search_prepare(text)', 'local_recognizer_valid(jsonb)', 'evidence_locator_valid(jsonb)'];
    try {
      // Состояние схемы до 0043: функции без search_path, у роли копии нет прав.
      for (const fn of fns) await migrator.query(`ALTER FUNCTION ${fn} RESET search_path`);
      await expect(
        runBackup({ backupUrl: as('kontur_backup'), storageRoot: s.st.e.config.storageRoot, backupRoot: mkdtempSync(join(tmpdir(), 'kontur-backup-')), tool, host: 't', build: null, log: () => undefined }),
      ).rejects.toMatchObject({ code: 'dump_not_restorable' });
      const root = mkdtempSync(join(tmpdir(), 'kontur-backup-pre-'));
      const r = await runBackup({ backupUrl: s.st.db.migratorUrl, storageRoot: s.st.e.config.storageRoot, backupRoot: root, tool, host: 't', build: null, log: () => undefined, preUpdate: true });
      expect((await readManifest(r.dir)).role).toBe('kontur_migrator');
      const legacy = await runRestoreCheck({ backupDir: r.dir, adminUrl: ADMIN_URL, dbName: legacyDb, storageRoot: mkdtempSync(join(tmpdir(), 'kontur-restore-pre-')), production: {}, tool, log: () => undefined });
      expect(legacy.steps.filter((x) => !x.ok), JSON.stringify(legacy.steps)).toEqual([]);
      expect(legacy.steps.find((x) => x.name === 'функции ограничений с search_path')?.detail).toContain('evidence_locator_valid(jsonb)');
      await legacy.pool?.end();
    } finally {
      for (const fn of fns) await migrator.query(`ALTER FUNCTION ${fn} SET search_path = pg_catalog, public`);
      await migrator.end();
    }
  });
});
