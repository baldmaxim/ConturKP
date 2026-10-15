// Порядок блокировок массового импорта (этап 17, S17-22; state-machines §1.2 — сначала строки этапов). Замер профиля
// D-040 поймал взаимоблокировку на 205 загрузках подряд: приём загрузки (server) держал строку тендера через внешний
// ключ import_batch и ждал этап, а регистрация редакции (worker, registerItem) держала этапы и ждала строку тендера
// FOR UPDATE. Сценарии ставят транзакции в этот порядок вручную, поэтому воспроизводятся без гонок по времени.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBatch, getItem, insertBlob, insertItem, lockTenderStages, registerItem } from '../packages/db/src/index.ts';
import { buildScenario, createTestDb, idem, makeApp, type IScenario, type ITestDb } from './helpers.ts';
import { postManifest, qaManifest } from './mailFixtures.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const octet = { 'Content-Type': 'application/octet-stream' };

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db));
});
afterAll(async () => {
  await db.drop();
});

const newBlob = async (): Promise<string> => {
  const sha = createHash('sha256').update(randomBytes(16)).digest('hex');
  await insertBlob(db.pool, { sha256: sha, sizeBytes: 10, mediaType: 'application/pdf', storageKey: `sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}` });
  return sha;
};
const pendingItem = async (name: string) => {
  const sha = await newBlob();
  const batchId = await createBatch(db.pool, { tenderId: s.tenderA, stageId: s.stageA, sourceKind: 'upload', channelId: null, uploadName: name, uploadSha: sha, createdBy: s.ids.eng1 });
  const { id } = await insertItem(db.pool, { batchId, tenderId: s.tenderA, memberPath: name, observedName: name, status: 'pending', blobSha: sha, sizeBytes: 10 });
  return (await getItem(db.pool, id))!;
};
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error');

describe('S17-22: порядок блокировок массового импорта', () => {
  it('регистрация держит этапы, вставка партии держит тендер и ждёт этап — обе завершаются', async () => {
    const item = await pendingItem('регистрация.pdf');
    const sha2 = await newBlob();
    const c1 = await db.pool.connect();
    const c2 = await db.pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      // Регистрация (worker) первой берёт этапы тендера — как в начале registerItem.
      await lockTenderStages(c1, s.tenderA, null);
      // Приём загрузки: внешние ключи партии — строка тендера, затем строка этапа (ждёт регистрацию).
      const upload = outcome(createBatch(c2, { tenderId: s.tenderA, stageId: s.stageA, sourceKind: 'upload', channelId: null, uploadName: 'загрузка.pdf', uploadSha: sha2, createdBy: s.ids.eng1 }));
      await sleep(300);
      const reg = await outcome(registerItem(c1, item, { sourceKind: 'upload', locator: 'upload:test/регистрация.pdf', channelId: null, actorUserId: s.ids.eng1 }));
      await c1.query(reg === 'ok' ? 'COMMIT' : 'ROLLBACK');
      const up = await upload;
      await c2.query(up === 'ok' ? 'COMMIT' : 'ROLLBACK');
      expect([reg, up]).toEqual(['ok', 'ok']);
    } finally {
      c1.release();
      c2.release();
    }
  });

  it('две загрузки в один этап одновременно — обе приняты (202), без взаимоблокировки на строке этапа', async () => {
    // Держатель FOR NO KEY UPDATE на этапе пропускает проверки внешних ключей (KEY SHARE), но не FOR UPDATE:
    // обе загрузки доходят до точки, где каждой нужна строка этапа, которую другая держит через внешний ключ.
    const c0 = await db.pool.connect();
    try {
      await c0.query('BEGIN');
      await c0.query('SELECT 1 FROM tender_stage WHERE id = $1 FOR NO KEY UPDATE', [s.stageA]);
      const a = s.eng1.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent('одновременно-1.pdf')}`, fakePdf(`lock-a-${randomBytes(4).toString('hex')}`), { headers: { ...octet, ...idem() } });
      const b = s.eng2.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent('одновременно-2.pdf')}`, fakePdf(`lock-b-${randomBytes(4).toString('hex')}`), { headers: { ...octet, ...idem() } });
      await sleep(500);
      await c0.query('COMMIT');
      const [ra, rb] = await Promise.all([a, b]);
      expect([ra.status, rb.status], `${ra.text} ${rb.text}`).toEqual([202, 202]);
    } finally {
      c0.release();
    }
  });

  it('импорт манифеста Q&A и регистрация редакции — обе завершаются', async () => {
    const item = await pendingItem('регистрация-qa.pdf');
    const c1 = await db.pool.connect();
    try {
      await c1.query('BEGIN');
      await lockTenderStages(c1, s.tenderA, null);
      const qa = postManifest(s.eng1, s.tenderA, 'qa', qaManifest([{ no: '1', question: `Порядок блокировок ${randomBytes(3).toString('hex')}?` }]), { stageId: s.stageA });
      await sleep(300);
      const reg = await outcome(registerItem(c1, item, { sourceKind: 'upload', locator: 'upload:test/регистрация-qa.pdf', channelId: null, actorUserId: s.ids.eng1 }));
      await c1.query(reg === 'ok' ? 'COMMIT' : 'ROLLBACK');
      const r = await qa;
      expect([reg, r.status], r.text).toEqual(['ok', 201]);
    } finally {
      c1.release();
    }
  });
});
