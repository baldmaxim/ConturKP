// Этап 17 (проект §11, state-machines §19): VERIFIED_LIVE в базе установки — только по журналу живой проверки этой
// сборки с «Итог: PASS», от имени действующего администратора, с событием аудита; фикстурный журнал, чужая сборка,
// не администратор и опечатка в имени интеграции — отказ без записи.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../apps/server/src/app.ts';
import { journalProblems, recordLiveCheck } from '../scripts/ops/integration-verify-lib.ts';
import { buildScenario, Clock, createTestDb, testConfig, type IScenario, type ITestDb } from './helpers.ts';

const BUILD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
let db: ITestDb;
let s: IScenario;
const dir = mkdtempSync(join(tmpdir(), 'kontur-verify-'));
const journal = (name: string, text: string): string => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, createApp({ config: testConfig(), pool: db.pool, clock: new Clock().read, logError: () => undefined }));
});
afterAll(async () => db.drop());

describe('запись живой проверки в базу установки', () => {
  it('требования к журналу: LIVE, эта сборка, Итог: PASS', () => {
    expect(journalProblems(`# Режим: LIVE; Сборка: ${BUILD.slice(0, 7)}\nPASS x\nИтог: PASS\n`, BUILD)).toEqual([]);
    expect(journalProblems('# Режим: FIXTURE (временные папки)\nИтог: PASS\n', BUILD).join()).toMatch(/фикстурного прогона/u);
    expect(journalProblems(`# Режим: LIVE; Сборка: ${BUILD}\nИтог: FAIL\n`, BUILD).join()).toMatch(/Итог: PASS/u);
    expect(journalProblems('# Режим: LIVE; Сборка: 1234567\nИтог: PASS\n', BUILD).join()).toMatch(/установлена/u);
    expect(journalProblems('# Режим: LIVE; Сборка: 1234567\nИтог: PASS\n', null).join()).toMatch(/KONTUR_BUILD/u);
  });

  it('VERIFIED_LIVE со ссылкой на журнал и SHA-256, событие аудита от администратора', async () => {
    const p = journal('live-codex.log', `# Режим: LIVE; Сборка: ${BUILD}\nPASS  вызов list_cases\nИтог: PASS\n`);
    const r = await recordLiveCheck(db.pool, { system: 'codex', component: 'McpClient', journal: p, adminLogin: 'admin', build: BUILD, create: false });
    expect(r.evidenceRef).toMatch(/^live-codex\.log sha256:[0-9a-f]{64}$/u);
    const row = (await db.pool.query("SELECT status, evidence_ref, verified_at FROM integration_status WHERE system = 'codex'")).rows[0];
    expect(row).toMatchObject({ status: 'VERIFIED_LIVE', evidence_ref: r.evidenceRef });
    expect(row.verified_at).toBeInstanceOf(Date);
    const audit = await db.pool.query("SELECT actor_user_id, outcome, details FROM audit_event WHERE action = 'integration.verify_live'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: s.ids.admin, outcome: 'allowed' });
  });

  it('не администратор, неизвестная интеграция, фикстурный журнал — отказ без записи', async () => {
    const good = journal('live-ok.log', `# Режим: LIVE; Сборка: ${BUILD}\nИтог: PASS\n`);
    await expect(recordLiveCheck(db.pool, { system: 'cursor', component: 'McpClient', journal: good, adminLogin: 'eng1', build: BUILD, create: false })).rejects.toThrow(/не действующий администратор/u);
    await expect(recordLiveCheck(db.pool, { system: 'curson', component: 'McpClient', journal: good, adminLogin: 'admin', build: BUILD, create: false })).rejects.toThrow(/строки curson\/McpClient нет/u);
    const fixture = journal('fixture.log', `# Режим: FIXTURE (временные папки, не живая проверка)\n# Сборка: ${BUILD}\nИтог: PASS\n`);
    await expect(recordLiveCheck(db.pool, { system: 'cursor', component: 'McpClient', journal: fixture, adminLogin: 'admin', build: BUILD, create: false })).rejects.toThrow(/фикстурного/u);
    const cursor = (await db.pool.query("SELECT status FROM integration_status WHERE system = 'cursor'")).rows[0];
    expect(cursor.status).not.toBe('VERIFIED_LIVE');
  });
});
