// Наблюдаемые папки (этап 03): стабильность файла (A15), повторное обнаружение, переименование,
// новое содержимое (A13), двойное получение Яндекс/SMB (A14), недоступная шара, выход за корень,
// ссылки, временные файлы, отключение канала.
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
const ROOT = mkdtempSync(join(tmpdir(), 'kontur-intake-'));
const config = testConfig({ intakeRoots: [ROOT], intakeStabilitySeconds: 1 });
let worker: ReturnType<typeof makeWorker>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const createChannel = async (locator: string, origin = 'local') => {
  const r = await s.admin.post(`/tenders/${s.tenderA}/intake-channels`, { origin, locator, scanIntervalSeconds: 3600 }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string };
};
const scan = async (channelId: string) => {
  const r = await s.eng1.post(`/intake-channels/${channelId}/scan`);
  expect(r.status, r.text).toBe(202);
  await drain(worker);
};
const channel = async (id: string) => (await s.eng1.get(`/tenders/${s.tenderA}/intake-channels`)).body.items.find((c: { id: string }) => c.id === id);
const batchesOf = async (channelId: string) =>
  (await db.pool.query<{ id: string }>('SELECT id FROM import_batch WHERE intake_channel_id = $1 ORDER BY created_at', [channelId])).rows;
const occurrences = async (channelId: string) =>
  (await db.pool.query<{ observed_name: string; source_kind: string; document_revision_id: string }>(
    'SELECT observed_name, source_kind, document_revision_id FROM document_occurrence WHERE intake_channel_id = $1 ORDER BY observed_at',
    [channelId],
  )).rows;

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  worker = makeWorker(db, config);
  s = await buildScenario(db, app);
});
afterAll(async () => {
  await db.drop();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('настройка канала', () => {
  it('создаёт только администратор и только внутри INTAKE_ROOTS', async () => {
    const dir = join(ROOT, 'setup');
    mkdirSync(dir);
    expect((await s.manager.post(`/tenders/${s.tenderA}/intake-channels`, { origin: 'local', locator: dir }, { headers: idem() })).status).toBe(403);
    expect((await s.admin.post(`/tenders/${s.tenderA}/intake-channels`, { origin: 'local', locator: tmpdir() }, { headers: idem() })).status).toBe(400);
    expect((await s.admin.post(`/tenders/${s.tenderA}/intake-channels`, { origin: 'local', locator: 'relative/path' }, { headers: idem() })).status).toBe(400);
    const c = await createChannel(dir);
    const view = await channel(c.id);
    expect(view).toMatchObject({ active: true, current: false, lastSuccessfulScanAt: null });
  });
});

describe('скан папки', () => {
  const dir = join(ROOT, 'main');
  let ch: { id: string };

  beforeAll(async () => {
    mkdirSync(dir);
    ch = await createChannel(dir);
  });

  it('A15: файл импортируется только после стабильности, ровно один раз; временные файлы пропускаются', async () => {
    writeFileSync(join(dir, 'ПД-01.pdf'), fakePdf('пд 01'));
    writeFileSync(join(dir, '~$ПД-01.docx'), 'lock');
    writeFileSync(join(dir, 'загрузка.pdf.crdownload'), 'part');
    await scan(ch.id);
    expect(await batchesOf(ch.id)).toHaveLength(0);
    expect(await channel(ch.id)).toMatchObject({ pendingUnstable: 1, lastSuccessfulScanAt: null, current: false });
    await sleep(1200);
    await scan(ch.id);
    const batches = await batchesOf(ch.id);
    expect(batches).toHaveLength(1);
    const b = (await s.eng1.get(`/imports/${batches[0]!.id}`)).body;
    expect(b).toMatchObject({ status: 'completed', sourceKind: 'watched_folder' });
    expect(b.items.map((i: { memberPath: string }) => i.memberPath)).toEqual(['ПД-01.pdf']);
    expect((await channel(ch.id)).current).toBe(true);
    const ev = await db.pool.query("SELECT event_type FROM stage_input_event WHERE ref_id = $1", [batches[0]!.id]);
    expect(ev.rows.map((r) => r.event_type)).toEqual(['import_accepted']);
  });

  it('повторное обнаружение: неизменный файл не импортируется снова', async () => {
    await scan(ch.id);
    await sleep(1200);
    await scan(ch.id);
    expect(await batchesOf(ch.id)).toHaveLength(1);
  });

  it('переименование: то же содержимое — новое происхождение с новым именем, без новой редакции; удаление ничего не удаляет', async () => {
    renameSync(join(dir, 'ПД-01.pdf'), join(dir, 'ПД-01 (итог).pdf'));
    await scan(ch.id);
    await sleep(1200);
    await scan(ch.id);
    const occ = await occurrences(ch.id);
    expect(occ.map((o) => o.observed_name)).toEqual(['ПД-01.pdf', 'ПД-01 (итог).pdf']);
    expect(new Set(occ.map((o) => o.document_revision_id)).size).toBe(1);
    const missing = await db.pool.query("SELECT missing_since FROM intake_file_state WHERE channel_id = $1 AND rel_path = 'ПД-01.pdf'", [ch.id]);
    expect(missing.rows[0].missing_since).not.toBeNull();
    const rev = occ[0]!.document_revision_id;
    expect((await s.eng1.get(`/document-revisions/${rev}/content`)).status).toBe(200);
  });

  it('A13: то же имя с новым содержимым — новая редакция документа', async () => {
    writeFileSync(join(dir, 'ПД-01 (итог).pdf'), fakePdf('пд 01 изм. 2'));
    await scan(ch.id);
    await sleep(1200);
    await scan(ch.id);
    const occ = await occurrences(ch.id);
    expect(new Set(occ.map((o) => o.document_revision_id)).size).toBe(2);
  });

  it('частично скопированный файл: пока растёт — не импортируется; затем один раз целиком', async () => {
    const p = join(dir, 'большой.pdf');
    writeFileSync(p, fakePdf('начало'));
    await scan(ch.id);
    appendFileSync(p, 'продолжение копирования\n');
    await sleep(1200);
    await scan(ch.id); // размер изменился — отсчёт стабильности заново
    const before = (await occurrences(ch.id)).filter((o) => o.observed_name === 'большой.pdf');
    expect(before).toHaveLength(0);
    appendFileSync(p, '%%EOF\n');
    await scan(ch.id);
    await sleep(1200);
    await scan(ch.id);
    const after = (await occurrences(ch.id)).filter((o) => o.observed_name === 'большой.pdf');
    expect(after).toHaveLength(1);
    const content = await s.eng1.get(`/document-revisions/${after[0]!.document_revision_id}/content`);
    expect(Buffer.from(content.body).toString('utf8')).toContain('продолжение копирования');
    expect(Buffer.from(content.body).toString('utf8').endsWith('%%EOF\n')).toBe(true);
  });

  it('ZIP в наблюдаемой папке не распаковывается — отказ с исходом', async () => {
    writeFileSync(join(dir, 'пакет.zip'), Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
    await scan(ch.id);
    await sleep(1200);
    await scan(ch.id);
    const item = await db.pool.query("SELECT status, reject_reason FROM import_item WHERE member_path = 'пакет.zip'");
    expect(item.rows[0]).toEqual({ status: 'rejected', reject_reason: 'type_not_allowed' });
  });

  it('ссылка (junction) внутри папки не открывается — отказ path_traversal', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'kontur-outside-'));
    writeFileSync(join(outside, 'secret.pdf'), fakePdf('secret'));
    symlinkSync(outside, join(dir, 'link'), 'junction');
    await scan(ch.id);
    await sleep(1200);
    await scan(ch.id);
    const item = await db.pool.query("SELECT status, reject_reason FROM import_item WHERE member_path = 'link'");
    expect(item.rows[0]).toEqual({ status: 'rejected', reject_reason: 'path_traversal' });
    const leaked = await db.pool.query("SELECT 1 FROM document_occurrence WHERE observed_name = 'secret.pdf'");
    expect(leaked.rowCount).toBe(0);
    rmSync(join(dir, 'link'));
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('двойное получение Яндекс Диск / SMB', () => {
  it('одно содержимое из двух каналов — одна редакция, два происхождения с видом источника', async () => {
    const y = join(ROOT, 'yandex');
    const m = join(ROOT, 'smb');
    mkdirSync(y);
    mkdirSync(m);
    writeFileSync(join(y, 'Договор.pdf'), fakePdf('договор'));
    writeFileSync(join(m, 'Договор (с шары).pdf'), fakePdf('договор'));
    const cy = await createChannel(y, 'yandex_disk');
    const cm = await createChannel(m, 'smb');
    for (const c of [cy, cm]) await scan(c.id);
    await sleep(1200);
    for (const c of [cy, cm]) await scan(c.id);
    const oy = await occurrences(cy.id);
    const om = await occurrences(cm.id);
    expect(oy).toHaveLength(1);
    expect(om).toHaveLength(1);
    expect(oy[0]!.source_kind).toBe('yandex_disk');
    expect(om[0]!.source_kind).toBe('smb');
    expect(oy[0]!.document_revision_id).toBe(om[0]!.document_revision_id);
    const item = await db.pool.query("SELECT status FROM import_item WHERE member_path = 'Договор (с шары).pdf'");
    expect(item.rows[0].status).toBe('duplicate');
  });
});

describe('недоступная папка и защита корня', () => {
  it('недоступная шара: ошибка канала, повтор с задержкой, свежесть не обновляется', async () => {
    const dir = join(ROOT, 'share');
    mkdirSync(dir);
    const c = await createChannel(dir);
    rmSync(dir, { recursive: true });
    await scan(c.id);
    const view = await channel(c.id);
    expect(view).toMatchObject({ lastErrorCode: 'share_unavailable', lastSuccessfulScanAt: null, current: false });
    const job = await db.pool.query("SELECT status, attempts, last_error_code FROM job WHERE dedupe_key = $1", [`scan:${c.id}`]);
    expect(job.rows[0]).toMatchObject({ status: 'queued', attempts: 1, last_error_code: 'share_unavailable' });
    mkdirSync(dir);
    await db.pool.query("UPDATE job SET run_after = now() WHERE dedupe_key = $1 AND status = 'queued'", [`scan:${c.id}`]);
    await drain(worker);
    expect((await channel(c.id)).lastErrorCode).toBeNull();
  });

  it('сбой хранилища при скане — ошибка задания, а не молчаливое «файл ещё копируется»', async () => {
    const dir = join(ROOT, 'broken-store');
    mkdirSync(dir);
    writeFileSync(join(dir, 'файл.pdf'), fakePdf('при сбое хранилища'));
    const brokenRoot = join(ROOT, '..', `kontur-broken-${Date.now()}.txt`);
    writeFileSync(brokenRoot, 'не каталог');
    const broken = testConfig({ intakeRoots: [ROOT], storageRoot: brokenRoot, intakeStabilitySeconds: 1 });
    const c = await createChannel(dir);
    await s.eng1.post(`/intake-channels/${c.id}/scan`);
    await drain(makeWorker(db, broken, 'broken-worker'));
    const job = await db.pool.query('SELECT status, last_error_code FROM job WHERE dedupe_key = $1 ORDER BY created_at DESC LIMIT 1', [`scan:${c.id}`]);
    expect(job.rows[0]).toMatchObject({ status: 'queued', last_error_code: 'internal' });
    expect((await channel(c.id)).lastSuccessfulScanAt).toBeNull();
    rmSync(brokenRoot, { force: true });
    await s.admin.patch(`/intake-channels/${c.id}`, { active: false, disabledReason: 'тест сбоя хранилища завершён' }, { headers: { 'If-Match': `"${c.id}:1"` } });
    await db.pool.query("UPDATE job SET status = 'cancelled', finished_at = now() WHERE dedupe_key = $1 AND status = 'queued'", [`scan:${c.id}`]);
  });

  it('папка, пересекающаяся с хранилищем, не сканируется', async () => {
    const overlapping = testConfig({ intakeRoots: [ROOT], storageRoot: join(ROOT, 'store-inside') });
    const dir = join(ROOT);
    const c = await createChannel(dir);
    await s.eng1.post(`/intake-channels/${c.id}/scan`);
    await drain(makeWorker(db, overlapping, 'overlap-worker'));
    expect((await channel(c.id)).lastErrorCode).toBe('overlaps_storage');
    await s.admin.patch(`/intake-channels/${c.id}`, { active: false, disabledReason: 'тест пересечения завершён' }, { headers: { 'If-Match': `"${c.id}:1"` } });
  });

  it('отключение канала: руководитель с причиной, инженер — нет; отключённый не сканируется', async () => {
    const dir = join(ROOT, 'disable');
    mkdirSync(dir);
    const c = await createChannel(dir);
    const etag = { 'If-Match': `"${c.id}:1"` };
    expect((await s.eng1.patch(`/intake-channels/${c.id}`, { active: false, disabledReason: 'не нужен' }, { headers: etag })).status).toBe(403);
    expect((await s.manager.patch(`/intake-channels/${c.id}`, { active: false }, { headers: etag })).status).toBe(400);
    expect((await s.manager.patch(`/intake-channels/${c.id}`, { locator: dir }, { headers: etag })).status).toBe(403);
    const ok = await s.manager.patch(`/intake-channels/${c.id}`, { active: false, disabledReason: 'папка больше не используется' }, { headers: etag });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ active: false, disabledReason: 'папка больше не используется' });
    expect((await s.eng1.post(`/intake-channels/${c.id}/scan`)).status).toBe(409);
    expect((await s.eng3.get(`/tenders/${s.tenderA}/intake-channels`)).status).toBe(404);
  });
});
