// Этап 17 (проект §8): даты и сроки. Хранение и API — UTC; отображение и ввод — по Москве (спецификация §12, решение
// владельца 2026-10-14) на границах суток и года; дата вопроса для проверки — по Москве (S17-16); срок TenderHub без
// пояса — UTC (толкование исполнителя, проект §16 п. 5); ответ API не зависит от пояса сессии БД.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSourceTimestamp } from '../packages/adapters/src/index.ts';
import { portalDate, PORTAL_TIME_ZONE } from '../packages/core/src/index.ts';
import { createPool } from '../packages/db/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { formatDateTime, isoToMoscowInput, moscowInputToIso, PORTAL_TIME_ZONE as WEB_ZONE } from '../apps/web/src/utils/datetime.ts';
import { ADMIN_URL, buildScenario, Clock, createTestDb, idem, testConfig, TestClient, type ITestDb } from './helpers.ts';

let db: ITestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db.drop());

describe('пояс отображения — Europe/Moscow', () => {
  it('интерфейс и сервер используют один пояс', () => {
    expect(PORTAL_TIME_ZONE).toBe('Europe/Moscow');
    expect(WEB_ZONE).toBe(PORTAL_TIME_ZONE);
  });

  it('ввод и показ на границах суток и года: UTC ↔ МСК', () => {
    expect(isoToMoscowInput('2026-12-31T21:30:00.000Z')).toBe('2027-01-01T00:30');
    expect(moscowInputToIso('2027-01-01T00:30')).toBe('2026-12-31T21:30:00.000Z');
    expect(moscowInputToIso('2026-10-14T02:59')).toBe('2026-10-13T23:59:00.000Z');
    expect(isoToMoscowInput(moscowInputToIso('2026-03-29T02:30')!)).toBe('2026-03-29T02:30');
    expect(formatDateTime('2026-10-13T21:05:00Z')).toBe('14.10.2026, 00:05');
    expect(moscowInputToIso('14.10.2026 00:05')).toBeNull();
    expect(moscowInputToIso('')).toBeNull();
  });

  it('дата вопроса для проверки — по Москве, а не по UTC', () => {
    expect(portalDate(new Date('2026-10-13T22:30:00Z'))).toBe('2026-10-14');
    expect(portalDate(new Date('2026-10-13T20:59:59Z'))).toBe('2026-10-13');
    expect(portalDate(new Date('2026-12-31T21:00:00Z'))).toBe('2027-01-01');
  });

  it('срок TenderHub: со смещением — точный момент, без пояса — UTC (толкование, поведение не меняется)', () => {
    expect(parseSourceTimestamp('2026-10-20 12:00:00+03')).toBe('2026-10-20T09:00:00.000Z');
    expect(parseSourceTimestamp('2026-10-20T12:00:00+05:00')).toBe('2026-10-20T07:00:00.000Z');
    expect(parseSourceTimestamp('2026-10-20 12:00:00')).toBe('2026-10-20T12:00:00.000Z');
    expect(parseSourceTimestamp('20.10.2026')).toBeNull();
  });
});

describe('ответ API не зависит от пояса сессии БД', () => {
  it('срок подачи этапа: ввод со смещением, чтение — тот же момент UTC при TimeZone=Asia/Almaty и Pacific/Kiritimati', async () => {
    const results: string[] = [];
    for (const zone of ['Asia/Almaty', 'Pacific/Kiritimati']) {
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`ALTER DATABASE ${db.name} SET timezone = '${zone}'`);
      await admin.end();
      const pool = createPool(db.appUrl, 3);
      try {
        const tz = await pool.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
        expect(tz.rows[0]!.tz).toBe(zone);
        const app = createApp({ config: testConfig(), pool, clock: new Clock().read, logError: () => undefined });
        if (zone === 'Asia/Almaty') await buildScenario({ ...db, pool }, app);
        const m = new TestClient(app);
        expect((await m.login('manager')).status).toBe(200);
        const tenders = (await m.get('/tenders')).body.items as Array<{ id: string; code: string }>;
        const tender = tenders.find((t) => t.code === 'A-1')!;
        const created = await m.post(`/tenders/${tender.id}/stages`, { title: `Срок ${zone}`, submissionDeadline: '2026-10-20T12:00:00+03:00' }, { headers: idem() });
        expect(created.status, created.text).toBe(201);
        const read = await m.get(`/stages/${created.body.id}`);
        results.push(read.body.submissionDeadline as string);
      } finally {
        await pool.end();
      }
    }
    expect(results).toEqual(['2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z']);
  });
});
