// Этап 14 — размещение выпуска на поддельных назначениях (VERIFIED_FIXTURE, D-034): «папка синхронизации» Яндекс Диска
// и «сетевая папка» во временных каталогах, отказы вносит обёртка файловой системы. Проверки задания (проект §15):
// обрыв сети, потеря доступа, частичная запись, перезапуск, неизвестный исход, существующий файл, несовпадение хэша,
// независимость направлений, заполненный диск, облако Яндекс Диска, среда. Настоящих назначений здесь нет.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, PLACEMENT_MARKER } from '../packages/core/src/index.ts';
import { tamperBlob } from './approvalFixtures.ts';
import { auditRows, idem } from './helpers.ts';
import {
  act,
  buildStage14,
  closeStage14,
  crashAt,
  createDestination,
  deliveriesOf,
  deliveryOf,
  deliveryWorker,
  dirs,
  FaultyFs,
  newVersion,
  pgCode,
  place,
  runDeliveries,
  runOneDelivery,
  setActive,
  tree,
  type IDeliveryView,
  type IDestinationView,
  type IStage14,
} from './deliveryFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let s: IStage14;
let fs: FaultyFs;
let yandex: IDestinationView;
let smb: IDestinationView;
let prod: IDestinationView;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const st = () => s.st;
const eng = () => s.st.e.s.eng1;

// Новая пара папок и назначение под сценарий; доставка — «Разместить» по выпуску.
let n = 0;
const fresh = async (kind: 'yandex_disk' | 'smb', o: { includeInternal?: boolean } = {}) => {
  n += 1;
  const base = join(s.folders.base, `case-${n}`);
  const root = kind === 'yandex_disk' ? join(base, 'Яндекс.Диск', 'Контур') : join(base, 'share', 'Контур');
  const staging = kind === 'yandex_disk' ? join(base, 'staging') : null;
  mkdirSync(root, { recursive: true });
  if (staging) mkdirSync(staging, { recursive: true });
  const dest = await createDestination(s.st.e.s.admin, { title: `Сценарий ${n} (${kind})`, kind, rootPath: root, stagingPath: staging, ...o });
  return { dest, root, staging: staging ?? join(root, '.kontur-staging') };
};

const placeFor = async (destId: string): Promise<IDeliveryView> => {
  const r = await place(eng(), s.releaseId, 'Разместить в новое назначение');
  expect(r.status, r.text).toBe(201);
  return (r.body.items as IDeliveryView[]).find((d) => d.destination.id === destId && d.status !== 'superseded')!;
};

const releaseFolder = (root: string, d: IDeliveryView) => join(root, ...d.targetFolder.split('/'));

// Папка выпуска: ровно файлы набора и признак, байты совпадают с хэшами; признак — каноническая запись.
const expectExact = (root: string, d: IDeliveryView) => {
  const files = tree(releaseFolder(root, d));
  expect([...files.keys()].sort()).toEqual(d.files.map((f) => f.path).sort());
  for (const f of d.files) {
    expect(sha(files.get(f.path)!), f.path).toBe(f.sha256);
    expect(files.get(f.path)!.length).toBe(f.size);
  }
  const marker = JSON.parse(files.get(PLACEMENT_MARKER)!.toString('utf8'));
  expect(canonicalJson(marker)).toBe(files.get(PLACEMENT_MARKER)!.toString('utf8'));
  expect(marker).toMatchObject({ schema: 'kontur-placement/1', release: { id: s.releaseId, mode: 'test' }, fileSet: d.fileSet });
  return files;
};

beforeAll(async () => {
  s = await buildStage14({
    destinations: async (f, admin) => {
      yandex = await createDestination(admin, { title: 'Яндекс Диск (тест)', kind: 'yandex_disk', rootPath: f.yandexRoot, stagingPath: f.yandexStaging });
      smb = await createDestination(admin, { title: 'Сетевая папка (тест)', kind: 'smb', rootPath: f.smbRoot });
      prod = await createDestination(admin, { title: 'Сетевая папка (боевая)', kind: 'smb', environment: 'production', rootPath: join(f.base, 'prod') });
    },
  });
  fs = new FaultyFs();
});
afterAll(async () => {
  await closeStage14(s);
});

describe('выпуск: доставки во все активные назначения среды (RT-05), размещение на worker', () => {
  it('тестовый выпуск — доставки в два тестовых назначения, боевое не затронуто; закреплены версия, папка, набор, признак', async () => {
    const list = await deliveriesOf(eng(), s.releaseId);
    expect(list.items.map((d) => d.destination.id).sort()).toEqual([yandex.id, smb.id].sort());
    expect(list.summary).toMatchObject({ total: 2, delivered: 0, cloudTotal: 1, cloudConfirmed: 0, missing: 0 });
    for (const d of list.items) {
      expect(d).toMatchObject({ status: 'pending', fileSet: 'customer', destination: { environment: 'test', version: 1 } });
      expect(d.targetFolder).toMatch(/^A-1\/Этап \d+\/Выпуск \d+ [0-9a-f]{8}$/u);
      expect(d.files.at(-1)).toMatchObject({ path: PLACEMENT_MARKER, kind: 'marker' });
      expect(d.files.filter((f) => f.kind === 'manifest')).toEqual([]);
      expect(JSON.stringify(d)).not.toContain(s.folders.base);
    }
    expect(list.items.find((d) => d.destination.kind === 'smb')!.cloud).toBeNull();
    expect(list.items.find((d) => d.destination.kind === 'yandex_disk')!.cloud).toMatchObject({ state: 'unconfirmed' });
    expect(Number((await st().db.pool.query('SELECT count(*) AS n FROM delivery WHERE destination_id = $1', [prod.id])).rows[0].n)).toBe(0);
    const audit = await auditRows(st().db.pool, "action = 'release.create' AND entity_id = $1", [s.releaseId]);
    expect((audit[0]!.details as { deliveries: string[] }).deliveries).toHaveLength(2);
  });

  it('worker размещает в оба назначения: точные файлы, признак последним, служебные папки пусты; Яндекс Диск — «проверено локально, облако не подтверждено»', async () => {
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const list = await deliveriesOf(eng(), s.releaseId);
    expect(list.summary, JSON.stringify(list.items.map((d) => [d.destination.kind, d.status, d.lastError, d.attempts]))).toMatchObject({ total: 2, delivered: 2, cloudTotal: 1, cloudConfirmed: 0 });
    for (const d of list.items) {
      expect(d.status).toBe('delivered');
      expect(d.files.every((f) => f.remoteState === 'verified')).toBe(true);
      expect(d.attempts).toEqual([expect.objectContaining({ seq: 1, outcome: 'delivered' })]);
    }
    const y = list.items.find((d) => d.destination.kind === 'yandex_disk')!;
    const m = list.items.find((d) => d.destination.kind === 'smb')!;
    expectExact(s.folders.yandexRoot, y);
    expectExact(s.folders.smbRoot, m);
    expect(y.cloud).toMatchObject({ state: 'unconfirmed', confirmedBy: null });
    expect(readdirSync(s.folders.yandexStaging)).toEqual([]);
    expect(readdirSync(join(s.folders.smbRoot, '.kontur-staging'))).toEqual([]);
    // Служебная папка Яндекс Диска — вне папки синхронизации: в синхронизируемом дереве только папка выпуска.
    expect(dirs(s.folders.yandexSync)).toEqual(['Контур КП тест', 'Контур КП тест/A-1', `Контур КП тест/A-1/${y.targetFolder.split('/')[1]}`, `Контур КП тест/${y.targetFolder}`]);
    // Признак готовности перенесён последним: после переноса папки выпуска.
    const intoRelease = fs.calls.filter((c) => (c.op === 'rename' || c.op === 'moveNoReplace') && (c.path.split(' -> ')[1] ?? '').startsWith(join(s.folders.smbRoot, 'A-1')));
    expect(intoRelease.map((c) => c.op)).toEqual(['rename', 'moveNoReplace']);
    expect(intoRelease[1]!.path.endsWith(PLACEMENT_MARKER)).toBe(true);
  });

  it('повтор задания по размещённой доставке ничего не пишет и дублей не создаёт', async () => {
    const d = (await deliveriesOf(eng(), s.releaseId)).items[0]!;
    await st().db.pool.query("INSERT INTO job (kind, dedupe_key, payload, resource_class, max_attempts) VALUES ('delivery.place', $1, $2, 'network', 5)", [`delivery-replay:${d.id}`, JSON.stringify({ deliveryId: d.id })]);
    const before = fs.calls.length;
    await runDeliveries(st(), deliveryWorker(st(), fs));
    expect(fs.calls.length).toBe(before);
    expect((await deliveryOf(eng(), d.id)).attempts).toHaveLength(1);
  });
});

// Повторы worker: сеть и неизвестный исход — повтор с backoff (сдвигается тестом), исчерпание — «ошибка».
describe('отказы назначения (проект §5.5, §15)', () => {
  it('обрыв сети: повторы, затем «ошибка» NETWORK; в папке выпуска ничего; «Повторить» после восстановления — размещено, без дублей', async () => {
    const { dest, root } = await fresh('smb');
    fs.add({ op: 'writeFile', path: root, effect: { errno: 'ECONNRESET' } });
    const d0 = await placeFor(dest.id);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    fs.clear();
    const failed = await deliveryOf(eng(), d0.id);
    expect(failed).toMatchObject({ status: 'failed', lastError: { code: 'NETWORK' }, attemptCount: 5, actions: { retry: true, resolveConflict: false } });
    expect(failed.attempts.map((a) => a.outcome)).toEqual(['interrupted', 'interrupted', 'interrupted', 'interrupted', 'failed']);
    expect(existsSync(join(root, 'A-1'))).toBe(false);
    const noReason = await eng().post(`/deliveries/${d0.id}/retry`, {}, { headers: { 'If-Match': failed.etag, ...idem() } });
    expect(noReason.status).toBe(400);
    const r = await act(eng(), failed, 'retry', 'Связь с сервером восстановлена');
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'pending', events: expect.arrayContaining([expect.objectContaining({ action: 'retry', actor: 'Инженер 1', reason: 'Связь с сервером восстановлена' })]) });
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const ok = await deliveryOf(eng(), d0.id);
    expect(ok.status).toBe('delivered');
    expectExact(root, ok);
    expect(dirs(root).filter((x) => x.startsWith('A-1/'))).toHaveLength(2);
    // Старый ETag после изменения — 412.
    expect((await act(eng(), failed, 'retry', 'Повтор по устаревшей версии')).status).toBe(412);
  });

  it('потеря доступа: «ошибка» FORBIDDEN сразу, без повторов и без ложного успеха', async () => {
    const { dest, root } = await fresh('smb');
    fs.add({ op: 'writeFile', path: root, effect: { errno: 'EACCES' } });
    const d0 = await placeFor(dest.id);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    fs.clear();
    const d = await deliveryOf(eng(), d0.id);
    expect(d).toMatchObject({ status: 'failed', lastError: { code: 'FORBIDDEN' }, attemptCount: 1 });
    expect(d.files.some((f) => f.remoteState === 'verified')).toBe(false);
    expect(existsSync(join(root, 'A-1'))).toBe(false);
  });

  it('заполненный диск: «ошибка» NO_SPACE; служебная папка не выдаётся за размещение', async () => {
    const { dest, root } = await fresh('yandex_disk');
    fs.add({ op: 'writeFile', path: root.replace(/Яндекс\.Диск.*$/u, 'staging'), effect: { errno: 'ENOSPC' } });
    const d0 = await placeFor(dest.id);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    fs.clear();
    expect(await deliveryOf(eng(), d0.id)).toMatchObject({ status: 'failed', lastError: { code: 'NO_SPACE' }, cloud: { state: 'unconfirmed' } });
    expect(readdirSync(root)).toEqual([]);
  });

  it('частичная запись: обрыв посреди файла — в папке выпуска ничего; повтор перезаписывает свой файл в служебной папке и переносит', async () => {
    const { dest, root, staging } = await fresh('yandex_disk');
    fs.add({ op: 'writeFile', path: staging, effect: { partial: true }, times: 1 });
    const d0 = await placeFor(dest.id);
    const w = deliveryWorker(st(), fs);
    await runOneDelivery(st(), w);
    const mid = await deliveryOf(eng(), d0.id);
    expect(mid).toMatchObject({ status: 'staging', lastError: { code: 'NETWORK' } });
    expect(readdirSync(root)).toEqual([]);
    const part = tree(staging);
    expect([...part.keys()].every((k) => k.endsWith('.part'))).toBe(true);
    expect([...part.values()][0]!.length).toBeLessThan(mid.files[0]!.size);
    await runDeliveries(st(), w);
    const ok = await deliveryOf(eng(), d0.id);
    expect(ok.status).toBe('delivered');
    expect(ok.attempts.map((a) => a.outcome)).toEqual(['interrupted', 'delivered']);
    expectExact(root, ok);
    expect(readdirSync(staging)).toEqual([]);
  });

  it('файл прочитан после записи с другим хэшем: не сверен, повтор перезаписывает в служебной папке; в папку выпуска попадают точные байты', async () => {
    const { dest, root, staging } = await fresh('smb');
    fs.add({ op: 'writeFile', path: staging, effect: { corrupt: true }, times: 1 });
    const d0 = await placeFor(dest.id);
    const w = deliveryWorker(st(), fs);
    await runOneDelivery(st(), w);
    const mid = await deliveryOf(eng(), d0.id);
    expect(mid.files[0]!.remoteState).toBe('unknown');
    expect(existsSync(join(root, 'A-1'))).toBe(false);
    await runDeliveries(st(), w);
    const ok = await deliveryOf(eng(), d0.id);
    expect(ok.status).toBe('delivered');
    expectExact(root, ok);
  });

  it('неизвестный исход: перенос прошёл, ответа нет — «исход неизвестен»; следующий запуск только сверяет и завершает без повторной записи (A29)', async () => {
    const { dest, root } = await fresh('smb');
    const target = join(root, 'A-1');
    fs.add({ op: 'rename', path: (p) => (p.split(' -> ')[1] ?? '').startsWith(target), effect: { lateMs: 600 }, times: 1 });
    const d0 = await placeFor(dest.id);
    const w = deliveryWorker(st(), fs, 150);
    await runOneDelivery(st(), w);
    const mid = await deliveryOf(eng(), d0.id);
    expect(mid).toMatchObject({ status: 'outcome_unknown', lastError: { code: 'OUTCOME_UNKNOWN' } });
    expect(existsSync(releaseFolder(root, mid))).toBe(true);
    expect(existsSync(join(releaseFolder(root, mid), PLACEMENT_MARKER))).toBe(false);
    const writesBefore = fs.count('writeFile', root);
    await runDeliveries(st(), w);
    const ok = await deliveryOf(eng(), d0.id);
    expect(ok.status).toBe('delivered');
    expect(ok.attempts.map((a) => a.outcome)).toEqual(['outcome_unknown', 'delivered']);
    // Второй запуск записал только признак готовности: файлы набора не перезаписывались.
    expect(fs.count('writeFile', root) - writesBefore).toBe(1);
    expectExact(root, ok);
  });
});

describe('перезапуск worker (проект §5.4)', () => {
  const restart = async (hangAt: (root: string, staging: string, d: IDeliveryView) => Parameters<FaultyFs['add']>[0]) => {
    const { dest, root, staging } = await fresh('smb', { includeInternal: true });
    const d0 = await placeFor(dest.id);
    expect(d0.fileSet).toBe('all');
    fs.add({ ...hangAt(root, staging, d0), times: 1 });
    const w = deliveryWorker(st(), fs);
    await crashAt(st(), w, fs);
    const mid = await deliveryOf(eng(), d0.id);
    const writes = fs.calls.length;
    await runDeliveries(st(), w);
    const ok = await deliveryOf(eng(), d0.id);
    expect(ok.status, JSON.stringify(ok.lastError)).toBe('delivered');
    expectExact(root, ok);
    expect(readdirSync(staging)).toEqual([]);
    return { mid, ok, after: fs.calls.slice(writes) };
  };

  it('после части файлов: уже записанные в служебной папке не пишутся заново; дублей нет', async () => {
    const { mid, after } = await restart((_r, staging, d) => ({ op: 'writeFile', path: join(staging, d.id, `${d.files[1]!.path}.part`), effect: { hang: true } }));
    expect(mid.status).toBe('staging');
    expect(mid.files[0]!.remoteState).toBe('staged');
    expect(after.filter((c) => c.op === 'writeFile' && c.path.endsWith(`${mid.files[0]!.path}.part`))).toEqual([]);
  });

  it('после переноса папки выпуска, до признака готовности: сверка и признак, файлы не переписываются', async () => {
    const { mid, after } = await restart((_r, staging, d) => ({ op: 'writeFile', path: join(staging, d.id, `${PLACEMENT_MARKER}.part`), effect: { hang: true } }));
    expect(mid.status).toBe('verifying');
    expect(after.filter((c) => c.op === 'writeFile').map((c) => c.path.split(/[\\/]/u).at(-1))).toEqual([`${PLACEMENT_MARKER}.part`]);
  });

  it('после записи признака, до фиксации в БД: признак есть — сверка совпала, «размещено» без перезаписи', async () => {
    const { mid, after } = await restart((root) => ({ op: 'hashFile', path: (p) => p.startsWith(join(root, 'A-1')) && p.endsWith(PLACEMENT_MARKER), effect: { hang: true } }));
    expect(mid.status).toBe('verifying');
    expect(after.filter((c) => c.op === 'writeFile' || c.op === 'moveNoReplace' || c.op === 'rename')).toEqual([]);
  });
});

describe('существующие файлы и целостность (A27, A30)', () => {
  it('в папке выпуска чужой файл с тем же именем: «конфликт», без перезаписи и удаления; убрали папку — «Повторить после проверки» размещает', async () => {
    const { dest, root } = await fresh('smb');
    const d0 = await placeFor(dest.id);
    const folder = releaseFolder(root, d0);
    mkdirSync(folder, { recursive: true });
    const foreign = Buffer.from('чужой файл с тем же именем');
    writeFileSync(join(folder, d0.files[0]!.path), foreign);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const c = await deliveryOf(eng(), d0.id);
    expect(c).toMatchObject({ status: 'conflict', lastError: { code: 'CONFLICT' }, actions: { retry: false, resolveConflict: true, redirect: false } });
    expect(c.lastError!.detail).toMatch(/портал не перезаписывает/u);
    expect(c.files[0]!.remoteState).toBe('conflict');
    expect(readFileSync(join(folder, d0.files[0]!.path))).toEqual(foreign);
    expect(readdirSync(folder)).toEqual([d0.files[0]!.path]);
    expect((await act(eng(), c, 'retry', 'Не та команда для конфликта')).body.current.reason).toBe('not_failed');
    // Повтор без вмешательства — снова конфликт, файл тот же.
    expect((await act(eng(), c, 'resolve-conflict', 'Проверил папку — повторяю')).status).toBe(200);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const again = await deliveryOf(eng(), d0.id);
    expect(again.status).toBe('conflict');
    expect(readFileSync(join(folder, d0.files[0]!.path))).toEqual(foreign);
    rmSync(folder, { recursive: true });
    expect((await act(eng(), again, 'resolve-conflict', 'Чужую папку убрали вручную')).status).toBe(200);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const ok = await deliveryOf(eng(), d0.id);
    expect(ok.status).toBe('delivered');
    expect(ok.events.map((e) => e.action)).toEqual(['place', 'resolve_conflict', 'resolve_conflict']);
    expectExact(root, ok);
  });

  it('папка выпуска уже размещена с тем же содержимым — «размещено» без записи; посторонний файл или другой признак — «конфликт»', async () => {
    const delivered = (await deliveriesOf(eng(), s.releaseId)).items.find((d) => d.destination.id === smb.id)!;
    // То же содержимое: второе назначение на тот же корень.
    const same = await createDestination(s.st.e.s.admin, { title: 'Тот же корень', kind: 'smb', rootPath: s.folders.smbRoot, stagingPath: join(s.folders.base, 'same-staging') });
    mkdirSync(join(s.folders.base, 'same-staging'));
    const writes = fs.count('writeFile');
    const d1 = await placeFor(same.id);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    expect((await deliveryOf(eng(), d1.id)).status).toBe('delivered');
    expect(fs.count('writeFile') - writes).toBe(0);
    expectExact(s.folders.smbRoot, delivered);
    // Посторонний файл в копии папки выпуска.
    const extra = await fresh('smb');
    const d2 = await placeFor(extra.dest.id);
    const copy = releaseFolder(extra.root, d2);
    mkdirSync(copy, { recursive: true });
    for (const [name, bytes] of tree(releaseFolder(s.folders.smbRoot, delivered))) writeFileSync(join(copy, name), bytes);
    writeFileSync(join(copy, 'лишний.txt'), 'не из выпуска');
    writeFileSync(join(copy, 'desktop.ini'), '[.ShellClassInfo]');
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const c2 = await deliveryOf(eng(), d2.id);
    expect(c2).toMatchObject({ status: 'conflict' });
    expect(c2.lastError!.detail).toMatch(/посторонние файлы: лишний\.txt$/u);
    // Другой признак готовности: не перезаписывается.
    const marker = await fresh('smb');
    const d3 = await placeFor(marker.dest.id);
    const copy3 = releaseFolder(marker.root, d3);
    mkdirSync(copy3, { recursive: true });
    for (const [name, bytes] of tree(releaseFolder(s.folders.smbRoot, delivered))) writeFileSync(join(copy3, name), bytes);
    writeFileSync(join(copy3, PLACEMENT_MARKER), '{"schema":"kontur-placement/1","поддельный":true}');
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const c3 = await deliveryOf(eng(), d3.id);
    expect(c3.status).toBe('conflict');
    expect(c3.files.find((f) => f.kind === 'marker')!.remoteState).toBe('conflict');
    expect(readFileSync(join(copy3, PLACEMENT_MARKER), 'utf8')).toContain('поддельный');
  });

  it('байты в хранилище подменены после согласования: «ошибка» CONTENT_MISMATCH, в назначение ничего не записано (A27)', async () => {
    const { dest, root, staging } = await fresh('yandex_disk');
    const d0 = await placeFor(dest.id);
    const restore = tamperBlob(st(), d0.files[0]!.sha256);
    try {
      await runDeliveries(st(), deliveryWorker(st(), fs));
    } finally {
      restore();
    }
    const d = await deliveryOf(eng(), d0.id);
    expect(d).toMatchObject({ status: 'failed', lastError: { code: 'CONTENT_MISMATCH' }, attemptCount: 1 });
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(staging)).toEqual([]);
  });
});

describe('независимость направлений (A28, I14) и перенаправление (RT-05)', () => {
  it('Яндекс Диск размещён, сетевая папка — «ошибка»; «Повторить» действует только на сетевую; сводка N из M', async () => {
    const y = await fresh('yandex_disk');
    const m = await fresh('smb');
    fs.add({ op: 'writeFile', path: m.root, effect: { errno: 'EHOSTUNREACH' } });
    const r = await place(eng(), s.releaseId, 'Два новых назначения');
    expect(r.status, r.text).toBe(201);
    expect(r.body.created).toHaveLength(2);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    fs.clear();
    const list = await deliveriesOf(eng(), s.releaseId);
    const dy = list.items.find((d) => d.destination.id === y.dest.id)!;
    const dm = list.items.find((d) => d.destination.id === m.dest.id)!;
    expect(dy.status).toBe('delivered');
    expect(dm).toMatchObject({ status: 'failed', lastError: { code: 'NETWORK' } });
    expect(list.summary.total - list.summary.delivered).toBeGreaterThan(0);
    const yBefore = (await st().db.pool.query('SELECT row_version, attempt_count FROM delivery WHERE id = $1', [dy.id])).rows[0];
    expect((await act(eng(), dy, 'retry', 'Повтор размещённой')).body.current.reason).toBe('not_failed');
    expect((await act(s.st.e.s.eng2, dm, 'retry', 'Сеть восстановлена, повтор сетевой')).status).toBe(200);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    expect((await deliveryOf(eng(), dm.id)).status).toBe('delivered');
    expect((await st().db.pool.query('SELECT row_version, attempt_count FROM delivery WHERE id = $1', [dy.id])).rows[0]).toEqual(yBefore);
    // Повторное «Разместить» — без новых доставок.
    const again = await place(eng(), s.releaseId);
    expect(again.status).toBe(200);
    expect(again.body.created).toEqual([]);
  });

  it('«Перенаправить»: без новой версии — version_not_newer; после новой версии путей прежняя доставка заменена и сохранена, новая — размещена в новый корень', async () => {
    const { dest, root } = await fresh('smb');
    fs.add({ op: 'mkdir', path: root, effect: { errno: 'EACCES' } });
    fs.add({ op: 'writeFile', path: root, effect: { errno: 'EACCES' } });
    const d0 = await placeFor(dest.id);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    fs.clear();
    let failed = await deliveryOf(eng(), d0.id);
    expect(failed).toMatchObject({ status: 'failed', lastError: { code: 'FORBIDDEN' }, actions: { redirect: false } });
    expect((await act(eng(), failed, 'redirect', 'Перенаправить без новой версии')).body.current.reason).toBe('version_not_newer');
    const newRoot = join(s.folders.base, `redirect-${n}`);
    mkdirSync(newRoot);
    await newVersion(s.st.e.s.admin, dest, { rootPath: newRoot });
    failed = await deliveryOf(eng(), d0.id);
    expect(failed.actions.redirect).toBe(true);
    const r = await act(eng(), failed, 'redirect', 'Папка перенесена администратором');
    expect(r.status, r.text).toBe(201);
    const next = r.body as IDeliveryView;
    expect(next).toMatchObject({ status: 'pending', destination: { id: dest.id, version: 2, environment: 'test' }, targetFolder: failed.targetFolder });
    const old = await deliveryOf(eng(), d0.id);
    expect(old).toMatchObject({ status: 'superseded', supersededBy: next.id });
    expect(old.attempts).toEqual(failed.attempts);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    expectExact(newRoot, await deliveryOf(eng(), next.id));
    expect(readdirSync(root).filter((x) => x !== '.kontur-staging')).toEqual([]);
    expect((await act(eng(), old, 'retry', 'Повтор заменённой')).status).toBe(409);
  });

  it('выключенное назначение: «Разместить» его не берёт; перенаправление на него — destination_inactive', async () => {
    const { dest, root } = await fresh('smb');
    fs.add({ op: 'writeFile', path: root, effect: { errno: 'EACCES' } });
    const d0 = await placeFor(dest.id);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    fs.clear();
    const nr = join(s.folders.base, `inactive-${n}`);
    mkdirSync(nr);
    await newVersion(s.st.e.s.admin, dest, { rootPath: nr });
    await setActive(s.st.e.s.admin, dest.id, false);
    const failed = await deliveryOf(eng(), d0.id);
    expect(failed.actions.redirect).toBe(false);
    expect((await act(eng(), failed, 'redirect', 'Перенаправить на выключенное')).body.current.reason).toBe('destination_inactive');
    const other = await fresh('smb');
    await setActive(s.st.e.s.admin, other.dest.id, false);
    const r = await place(eng(), s.releaseId);
    expect(r.body.created).toEqual([]);
  });
});

describe('облако Яндекс Диска (D-034): «проверено локально» ≠ «доставлено в облако»', () => {
  it('подтверждает человек с delivery.manage и примечанием; только у размещённой доставки Яндекс Диска; один раз', async () => {
    const list = await deliveriesOf(eng(), s.releaseId);
    const y = list.items.find((d) => d.destination.id === yandex.id)!;
    const m = list.items.find((d) => d.destination.id === smb.id)!;
    expect(y.actions.confirmCloud).toBe(true);
    expect(m.actions.confirmCloud).toBe(false);
    expect((await act(eng(), m, 'confirm-cloud', 'Сетевая папка не облако')).body.current.reason).toBe('not_yandex');
    const failedY = (await st().db.pool.query("SELECT id FROM delivery WHERE kind = 'yandex_disk' AND status = 'failed' LIMIT 1")).rows[0].id as string;
    expect((await act(eng(), await deliveryOf(eng(), failedY), 'confirm-cloud', 'Ещё не размещено')).body.current.reason).toBe('not_delivered');
    expect((await eng().post(`/deliveries/${y.id}/confirm-cloud`, { note: '' }, { headers: { 'If-Match': y.etag, ...idem() } })).status).toBe(400);
    expect((await act(s.st.e.s.eng3, y, 'confirm-cloud', 'Чужой тендер')).status).toBe(404);
    // Прямая запись в обход решения человека — отказ второй линии.
    expect(await pgCode(st(), "UPDATE delivery SET cloud_state = 'confirmed', cloud_confirmed_by = $2, cloud_confirmed_at = now(), cloud_note = 'обход', row_version = row_version + 1 WHERE id = $1", [y.id, s.st.e.s.ids.eng1])).toBe('23514');
    const r = await act(eng(), y, 'confirm-cloud', 'Папка выпуска скачана из веб-интерфейса Диска, delivery:compare — совпадает');
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'delivered', cloud: { state: 'confirmed', confirmedBy: 'Инженер 1', note: expect.stringMatching(/delivery:compare/u) }, actions: { confirmCloud: false } });
    expect((await act(eng(), r.body as IDeliveryView, 'confirm-cloud', 'Повторное подтверждение')).body.current.reason).toBe('already_confirmed');
    expect((await deliveriesOf(eng(), s.releaseId)).summary.cloudConfirmed).toBe(1);
    const audit = await auditRows(st().db.pool, "action = 'delivery.confirm_cloud' AND outcome = 'allowed' AND entity_id = $1", [y.id]);
    expect(audit).toHaveLength(1);
  });
});

describe('права и видимость (I12, проект §9–§10)', () => {
  it('участник другого тендера и администратор без участия не видят доставок; полных путей в ответах нет', async () => {
    expect((await s.st.e.s.eng3.get(`/releases/${s.releaseId}/deliveries`)).status).toBe(404);
    expect((await s.st.e.s.admin.get(`/releases/${s.releaseId}/deliveries`)).status).toBe(404);
    const list = await deliveriesOf(s.st.e.s.manager, s.releaseId);
    expect(JSON.stringify(list)).not.toContain(s.folders.base);
    expect(list.canPlace).toBe(false);
    expect((await place(s.st.e.s.eng3, s.releaseId)).status).toBe(404);
    // Назначения — только администратор.
    expect((await eng().get('/delivery-destinations')).status).toBe(403);
    expect((await eng().post('/delivery-destinations', { title: 'x', kind: 'smb', environment: 'test', rootPath: '/tmp', reason: 'попытка инженера' }, { headers: idem() })).status).toBe(403);
    const denied = await auditRows(st().db.pool, "action = 'delivery.destination.create' AND outcome = 'denied' AND actor_user_id = $1", [s.st.e.s.ids.eng1]);
    expect(denied).toHaveLength(1);
  });
});
