// R08-05 (независимый прогон на Windows): папка, пересекающаяся с хранилищем, должна отвергаться уже на первом скане,
// как бы ни был записан путь к хранилищу. На Windows путь из конфигурации и физический путь папки расходятся в записи
// (короткие имена 8.3, регистр, junction), а проверка шла по тексту пути из конфигурации, пока физический корень
// хранилища ещё не был вычислен, — `overlaps_storage` не возникал. Здесь та же ситуация воспроизводится псевдонимом
// каталога (символической ссылкой): путь к хранилищу записан через псевдоним, папка канала — физическим путём.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { insidePath, resolveChannelRoot } from '../apps/worker/src/handlers/intake.ts';
import { BlobStore, physicalPath } from '../packages/storage/src/index.ts';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, removeLink, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
const BASE = mkdtempSync(join(tmpdir(), 'kontur-r0805-'));
const ROOT = join(BASE, 'intake');
const ALIAS = join(BASE, 'intake-alias');
mkdirSync(ROOT);
symlinkSync(ROOT, ALIAS, 'junction');
const config = testConfig({ intakeRoots: [ROOT], intakeStabilitySeconds: 1 });

const createChannel = async (locator: string) => {
  const r = await s.admin.post(`/tenders/${s.tenderA}/intake-channels`, { origin: 'local', locator, scanIntervalSeconds: 3600 }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string };
};
const channel = async (id: string) => (await s.eng1.get(`/tenders/${s.tenderA}/intake-channels`)).body.items.find((c: { id: string }) => c.id === id);
const scanOnce = async (channelId: string, storageRoot: string, workerId: string) => {
  await s.eng1.post(`/intake-channels/${channelId}/scan`);
  await drain(makeWorker(db, testConfig({ intakeRoots: [ROOT], intakeStabilitySeconds: 1, storageRoot }), workerId));
  return channel(channelId);
};
const disable = (id: string) => s.admin.patch(`/intake-channels/${id}`, { active: false, disabledReason: 'тест R08-05 завершён' }, { headers: { 'If-Match': `"${id}:1"` } });

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
});
afterAll(async () => {
  await db.drop();
  removeLink(ALIAS);
  expect(existsSync(ROOT)).toBe(true);
  rmSync(BASE, { recursive: true, force: true });
});

describe('R08-05: пересечение с хранилищем — с первого скана, при любой записи пути', () => {
  it('хранилище внутри папки канала, путь к нему — через псевдоним каталога: overlaps_storage на первом скане', async () => {
    const dir = join(ROOT, 'a');
    mkdirSync(dir);
    writeFileSync(join(dir, 'документ.pdf'), fakePdf('r0805-a'));
    const c = await createChannel(dir);
    const view = await scanOnce(c.id, join(ALIAS, 'a', 'store'), 'r0805-a');
    expect(view.lastErrorCode).toBe('overlaps_storage');
    expect((await db.pool.query('SELECT 1 FROM import_batch WHERE intake_channel_id = $1', [c.id])).rowCount).toBe(0);
    await disable(c.id);
  });

  it('папка канала внутри хранилища, путь к хранилищу — через псевдоним: overlaps_storage на первом скане', async () => {
    const storeDir = join(ROOT, 'b-store');
    const dir = join(storeDir, 'inbox');
    mkdirSync(dir, { recursive: true });
    const c = await createChannel(dir);
    expect((await scanOnce(c.id, join(ALIAS, 'b-store'), 'r0805-b')).lastErrorCode).toBe('overlaps_storage');
    await disable(c.id);
  });

  it('хранилище по прямому пути, ещё не созданное к первому скану: overlaps_storage', async () => {
    const dir = join(ROOT, 'c');
    mkdirSync(dir);
    const c = await createChannel(dir);
    expect((await scanOnce(c.id, join(dir, 'store-new'), 'r0805-c')).lastErrorCode).toBe('overlaps_storage');
    await disable(c.id);
  });

  it('соседние каталоги не пересекаются: хранилище рядом с папкой, путь через псевдоним — скан успешен, каталоги созданы физически', async () => {
    const dir = join(ROOT, 'd');
    mkdirSync(dir);
    const c = await createChannel(dir);
    const view = await scanOnce(c.id, join(ALIAS, 'd-store'), 'r0805-d');
    expect(view).toMatchObject({ lastErrorCode: null, lastSuccessfulScanAt: expect.any(String) });
    expect(readdirSync(join(ROOT, 'd-store')).sort()).toEqual(['derived', 'sha256', 'tmp']);
    await disable(c.id);
  });

  it('resolveChannelRoot: пересечение по физической идентичности каталога — и через псевдоним, и напрямую', async () => {
    const dir = join(ROOT, 'e');
    mkdirSync(join(dir, 'store'), { recursive: true });
    await expect(resolveChannelRoot(dir, [ROOT], join(ALIAS, 'e', 'store'))).rejects.toThrow('overlaps_storage');
    await expect(resolveChannelRoot(join(ALIAS, 'e'), [ROOT], join(dir, 'store'))).rejects.toThrow('overlaps_storage');
    await expect(resolveChannelRoot(join(dir, 'store'), [ROOT], join(ALIAS, 'e'))).rejects.toThrow('overlaps_storage');
  });
});

// Ожидаемый физический путь — тем же системным вызовом, что у продукта (`fs.promises.realpath` = `realpathSync.native`):
// на Windows обычный `realpathSync` оставляет короткое имя 8.3 (`ODINTS~1.A`), а системный возвращает полное (R08-08).
describe('R08-05: хранилище работает по физическому пути, не через junction', () => {
  it('physicalPath: несуществующий путь через псевдоним — физический предок и оставшиеся компоненты, без создания', async () => {
    const real = realpathSync.native(ROOT);
    expect(await physicalPath(join(ALIAS, 'нет', 'store'))).toBe(join(real, 'нет', 'store'));
    expect(existsSync(join(ROOT, 'нет'))).toBe(false);
    expect(await physicalPath(ALIAS)).toBe(real);
  });

  it('после вычисления физического корня junction снят — каталоги и объект всё равно создаются: ни mkdir, ни запись не идут через junction', async () => {
    const target = join(BASE, 'f-target');
    mkdirSync(target);
    const alias = join(BASE, 'f-alias');
    symlinkSync(target, alias, 'junction');
    const store = new BlobStore(join(alias, 'x', 'store'));
    const physical = await store.physicalRoot();
    expect(physical).toBe(join(realpathSync.native(target), 'x', 'store'));
    expect(existsSync(join(target, 'x'))).toBe(false);
    removeLink(alias);
    await store.ensureDirs();
    expect(store.canonicalRoot()).toBe(physical);
    const blob = await store.putStream(Readable.from([Buffer.from('содержимое R08-05')]), 1024);
    expect(store.pathOf(blob.sha256).startsWith(physical)).toBe(true);
    expect(existsSync(join(target, 'x', 'store', ...blob.storageKey.split('/')))).toBe(true);
    expect(await store.verify(blob.sha256)).toBe(true);
  });
});

describe('R08-05: сравнение путей с правилами платформы', () => {
  it('Windows — без учёта регистра и разделителей; POSIX — с учётом регистра', () => {
    expect(insidePath('c:\\users\\eng\\appdata\\local\\temp\\x\\store', 'C:\\Users\\Eng\\AppData\\Local\\Temp\\X', win32)).toBe(true);
    expect(insidePath('C:\\Temp\\X', 'c:\\temp\\x\\', win32)).toBe(true);
    expect(insidePath('C:\\Temp\\X-other', 'C:\\Temp\\X', win32)).toBe(false);
    expect(insidePath('C:\\Temp', 'C:\\Temp\\X', win32)).toBe(false);
    expect(insidePath('D:\\Temp\\X', 'C:\\Temp\\X', win32)).toBe(false);
    expect(insidePath('/srv/Store/a', '/srv/store', posix)).toBe(false);
    expect(insidePath('/srv/store/a', '/srv/store', posix)).toBe(true);
    expect(insidePath('/srv/store..x', '/srv/store', posix)).toBe(false);
  });
});

describe('R08-06: снятие тестовой ссылки', () => {
  it('removeLink снимает только ссылку — каталог назначения и файлы остаются; обычный каталог не трогает', () => {
    const target = join(BASE, 'r0806-target');
    mkdirSync(target);
    writeFileSync(join(target, 'файл.txt'), 'содержимое');
    const link = join(BASE, 'r0806-link');
    symlinkSync(target, link, 'junction');
    removeLink(link);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(target, 'файл.txt'))).toBe(true);
    expect(() => removeLink(target)).toThrow(/не ссылка/u);
    expect(existsSync(join(target, 'файл.txt'))).toBe(true);
  });
});

