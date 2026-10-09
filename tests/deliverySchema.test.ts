// Этап 14 — вторая линия БД (проект §13), назначения администратора и проверка доступа под учётной записью worker
// (D-034), пути (A38) и обновление схемы 0037 → 0038. Назначения — временные папки (VERIFIED_FIXTURE).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { placementBytes, placementSha256, type IPlacementManifest } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, MIGRATIONS_DIR, migrate, setupDatabase } from '../packages/db/src/index.ts';
import { acceptAll, approve, assembled, buildStage13, closeStage13, notApplicable, release, view, type IStage13 } from './approvalFixtures.ts';
import { ADMIN_URL, auditRows, idem, type ITestDb } from './helpers.ts';
import {
  buildStage14,
  closeStage14,
  createDestination,
  deliveriesOf,
  deliveryOf,
  deliveryWorker,
  destination,
  FaultyFs,
  nodeFsDev,
  pgCode,
  runDeliveries,
  type IDestinationView,
  type IStage14,
} from './deliveryFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let s: IStage14;
let yandex: IDestinationView;
let smb: IDestinationView;
let prod: IDestinationView;
const fs = new FaultyFs();
const st = () => s.st;
const admin = () => s.st.e.s.admin;

const su = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${st().db.name}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};

// Транзакция роли приложения: код ошибки (с учётом отложенных проверок при COMMIT) или ok.
const txCode = async (fn: (c: pg.PoolClient) => Promise<void>): Promise<string> => {
  const c = await st().db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return 'ok';
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    return (err as { code?: string }).code ?? 'error';
  } finally {
    c.release();
  }
};

const probe = async (d: IDestinationView): Promise<IDestinationView> => {
  const r = await admin().post(`/delivery-destinations/${d.id}/probe`, {}, { headers: idem() });
  expect(r.status, r.text).toBe(202);
  expect(r.body.probePending).toBe(true);
  await runDeliveries(st(), deliveryWorker(st(), fs));
  return destination(admin(), d.id);
};

beforeAll(async () => {
  s = await buildStage14({
    destinations: async (f, a) => {
      yandex = await createDestination(a, { title: 'Яндекс Диск (тест)', kind: 'yandex_disk', rootPath: f.yandexRoot, stagingPath: f.yandexStaging });
      smb = await createDestination(a, { title: 'Сетевая папка (тест)', kind: 'smb', rootPath: f.smbRoot });
      prod = await createDestination(a, { title: 'Сетевая папка (боевая)', kind: 'smb', environment: 'production', rootPath: join(f.base, 'prod') });
    },
  });
});
afterAll(async () => {
  await closeStage14(s);
});

describe('назначения: администратор, пути (проект §6, §8)', () => {
  const create = (body: Record<string, unknown>) => admin().post('/delivery-destinations', { title: 'Проверка путей', environment: 'test', reason: 'Проверка правил путей', ...body }, { headers: idem() });

  it('пути: только абсолютные, без «..»; Яндекс Диск — служебная папка обязательна и вне папки синхронизации; сетевая — по умолчанию <корень>/.kontur-staging', async () => {
    for (const [body, re] of [
      [{ kind: 'smb', rootPath: 'относительный/путь' }, /не абсолютный/u],
      [{ kind: 'smb', rootPath: '/tmp/a/../b' }, /«\.»|«\.\.»/u],
      [{ kind: 'smb', rootPath: 'C:\\Контур\\..\\x' }, /«\.»|«\.\.»/u],
      [{ kind: 'smb', rootPath: '\\\\srv\\share\\a*b' }, /недопустимый символ/u],
      [{ kind: 'yandex_disk', rootPath: '/tmp/sync/Контур' }, /служебная папка Яндекс Диска обязательна/u],
      [{ kind: 'yandex_disk', rootPath: '/tmp/sync/Контур', stagingPath: '/tmp/sync/Контур/служебная' }, /вне папки синхронизации/u],
      [{ kind: 'smb', rootPath: '/tmp/st/root', stagingPath: '/tmp/st' }, /внутри служебной папки/u],
    ] as const) {
      const r = await create(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.text).toMatch(re);
    }
    const unc = await create({ kind: 'smb', rootPath: '\\\\srv\\share\\Контур КП тест\\' });
    expect(unc.status, unc.text).toBe(201);
    expect(unc.body.current).toMatchObject({ rootPath: '\\\\srv\\share\\Контур КП тест', stagingPath: '\\\\srv\\share\\Контур КП тест\\.kontur-staging', includeInternal: false, version: 1 });
    const drive = await create({ kind: 'yandex_disk', rootPath: 'D:\\Яндекс.Диск\\Контур', stagingPath: 'D:\\kontur-staging' });
    expect(drive.status, drive.text).toBe(201);
    // Выключаем, чтобы они не брались в доставки.
    for (const d of [unc.body, drive.body] as IDestinationView[]) {
      const r = await admin().patch(`/delivery-destinations/${d.id}`, { active: false }, { headers: { 'If-Match': d.etag } });
      expect(r.status, r.text).toBe(200);
    }
  });

  it('изменение: If-Match обязателен; тип и среда не меняются; новая версия — номер +1, аудит с прежними и новыми путями', async () => {
    const d = await destination(admin(), smb.id);
    expect((await admin().patch(`/delivery-destinations/${d.id}`, { active: true })).status).toBe(428);
    expect((await admin().patch(`/delivery-destinations/${d.id}`, { kind: 'yandex_disk' }, { headers: { 'If-Match': d.etag } })).status).toBe(400);
    expect((await admin().patch(`/delivery-destinations/${d.id}`, {}, { headers: { 'If-Match': d.etag } })).status).toBe(400);
    const nr = join(s.folders.base, 'smb-v2');
    mkdirSync(nr);
    const r = await admin().post(`/delivery-destinations/${d.id}/versions`, { rootPath: nr, includeInternal: true, reason: 'Перенос сетевой папки' }, { headers: { 'If-Match': d.etag, ...idem() } });
    expect(r.status, r.text).toBe(201);
    expect(r.body.current).toMatchObject({ version: 2, rootPath: nr, includeInternal: true });
    expect(r.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const audit = await auditRows(st().db.pool, "action = 'delivery.destination.version' AND entity_id = $1", [d.id]);
    expect(audit[0]!.details).toMatchObject({ version: { from: 1, to: 2 }, rootPath: { from: s.folders.smbRoot, to: nr }, includeInternal: { from: false, to: true } });
    // Прежние доставки остаются на своей версии (R01-05, RT-05).
    const delivery = (await deliveriesOf(s.st.e.s.eng1, s.releaseId)).items.find((x) => x.destination.id === smb.id)!;
    expect(delivery.destination.version).toBe(1);
    expect(await pgCode(st(), "UPDATE delivery_destination SET kind = 'yandex_disk', updated_by = $2, row_version = row_version + 1 WHERE id = $1", [d.id, s.st.e.s.ids.admin])).toBe('55000');
    expect(await pgCode(st(), 'UPDATE delivery_destination SET title = $3, updated_by = $2, row_version = row_version + 1 WHERE id = $1', [d.id, s.st.e.s.ids.eng1, 'инженер'])).toBe('42501');
  });
});

describe('«Проверить назначение» — worker под учётной записью службы (D-034)', () => {
  it('исправное назначение — ok; пробная папка не остаётся ни в корне, ни в служебной', async () => {
    const after = await probe(yandex);
    expect(after.lastProbe).toMatchObject({ outcome: 'ok', current: true, version: 1, errorCode: null });
    expect(after.probePending).toBe(false);
    expect(readdirSync(s.folders.yandexStaging).filter((x) => x.startsWith('.kontur-probe-'))).toEqual([]);
    expect(readdirSync(s.folders.yandexRoot).filter((x) => x.startsWith('.kontur-probe-'))).toEqual([]);
  });

  it('служебная папка по умолчанию у сетевой папки создаётся; явно заданная, но отсутствующая — STAGING_NOT_FOUND; нет корня — ROOT_NOT_FOUND', async () => {
    const root = join(s.folders.base, 'probe-smb');
    mkdirSync(root);
    const d = await createDestination(admin(), { title: 'Проверка: сетевая', kind: 'smb', rootPath: root });
    expect((await probe(d)).lastProbe).toMatchObject({ outcome: 'ok' });
    expect(existsSync(join(root, '.kontur-staging'))).toBe(true);
    const y = await createDestination(admin(), { title: 'Проверка: нет служебной', kind: 'yandex_disk', rootPath: root, stagingPath: join(s.folders.base, 'нет-такой') });
    expect((await probe(y)).lastProbe).toMatchObject({ outcome: 'failed', errorCode: 'STAGING_NOT_FOUND' });
    const z = await createDestination(admin(), { title: 'Проверка: нет корня', kind: 'smb', rootPath: join(s.folders.base, 'нет-корня') });
    expect((await probe(z)).lastProbe).toMatchObject({ outcome: 'failed', errorCode: 'ROOT_NOT_FOUND' });
    expect(existsSync(join(s.folders.base, 'нет-корня'))).toBe(false);
    for (const x of [d, y, z]) {
      const cur = await destination(admin(), x.id);
      await admin().patch(`/delivery-destinations/${x.id}`, { active: false }, { headers: { 'If-Match': cur.etag } });
    }
  });

  it('разные тома — CROSS_DEVICE; нет прав — FORBIDDEN; ошибки без полных путей', async () => {
    fs.add({ op: 'stat', path: s.folders.yandexStaging, effect: { dev: nodeFsDev(s.folders.yandexStaging) + 1 }, times: 1 });
    expect((await probe(yandex)).lastProbe).toMatchObject({ outcome: 'failed', errorCode: 'CROSS_DEVICE' });
    fs.clear();
    fs.add({ op: 'mkdir', path: s.folders.yandexStaging, effect: { errno: 'EACCES' }, times: 1 });
    const p = (await probe(yandex)).lastProbe!;
    fs.clear();
    expect(p).toMatchObject({ outcome: 'failed', errorCode: 'FORBIDDEN' });
    expect(p.detail).not.toContain(s.folders.base);
    expect((await probe(yandex)).lastProbe).toMatchObject({ outcome: 'ok' });
  });

  it('инженер не запрашивает проверку и не видит назначений; запись проверки от не-администратора — 42501', async () => {
    expect((await s.st.e.s.eng1.post(`/delivery-destinations/${yandex.id}/probe`, {}, { headers: idem() })).status).toBe(403);
    expect((await s.st.e.s.manager.get('/delivery-destinations')).status).toBe(403);
    expect(await pgCode(st(), "INSERT INTO delivery_destination_probe (destination_id, destination_version_id, requested_by, outcome) VALUES ($1, $2, $3, 'ok')", [yandex.id, yandex.current.id, s.st.e.s.ids.eng1])).toBe('42501');
  });
});

describe('вторая линия БД (проект §13)', () => {
  const someDelivery = async () => (await deliveriesOf(s.st.e.s.eng1, s.releaseId)).items.find((d) => d.destination.id === yandex.id)!;

  it('доставка: среда выпуска = среда назначения; создаёт участник с delivery.manage; одна действующая на (выпуск, назначение)', async () => {
    const d = await someDelivery();
    const row = (await st().db.pool.query('SELECT * FROM delivery WHERE id = $1', [d.id])).rows[0];
    const insert = (dest: string, version: string, env: string, by: string | null) =>
      txCode(async (c) => {
        await c.query(
          `INSERT INTO delivery (release_id, tender_id, stage_id, destination_id, destination_version_id, kind, environment, target_folder, file_set, placement, placement_sha256, cloud_state, created_by)
           SELECT release_id, tender_id, stage_id, $2, $3, 'smb', $4, target_folder, file_set, placement, placement_sha256, 'not_applicable', $5 FROM delivery WHERE id = $1`,
          [d.id, dest, version, env, by],
        );
      });
    expect(await insert(prod.id, prod.current.id, 'production', null)).toBe('23514');
    expect(await insert(prod.id, prod.current.id, 'test', null)).toBe('23514');
    expect(await insert(smb.id, (await destination(admin(), smb.id)).current.id, 'test', s.st.e.s.ids.eng3)).toBe('42501');
    // Вторая действующая доставка в то же назначение.
    const dup = await txCode(async (c) => {
      await c.query(
        `INSERT INTO delivery (release_id, tender_id, stage_id, destination_id, destination_version_id, kind, environment, target_folder, file_set, placement, placement_sha256, cloud_state)
         VALUES ($1, $2, $3, $4, $5, 'yandex_disk', 'test', $6, $7, $8, $9, 'unconfirmed')`,
        [row.release_id, row.tender_id, row.stage_id, row.destination_id, row.destination_version_id, row.target_folder, row.file_set, row.placement, row.placement_sha256],
      );
    });
    expect(['23505', '23514']).toContain(dup);
  });

  it('набор файлов закрепляется только в транзакции создания и только совпадающий с выпуском (A27)', async () => {
    const d = await someDelivery();
    expect(await pgCode(st(), "INSERT INTO delivery_file_state (delivery_id, ordinal, path, kind, sha256, size_bytes) VALUES ($1, 99, 'лишний.pdf', 'file', $2, 1)", [d.id, 'a'.repeat(64)])).toBe('23514');
    // Новая доставка вручную, с поддельным файлом в наборе — отказ при COMMIT.
    const nr = join(s.folders.base, 'manual');
    mkdirSync(nr);
    const dest = await createDestination(admin(), { title: 'Ручная вставка', kind: 'smb', rootPath: nr });
    const forged = await txCode(async (c) => {
      const id = (
        await c.query(
          `INSERT INTO delivery (release_id, tender_id, stage_id, destination_id, destination_version_id, kind, environment, target_folder, file_set, placement, placement_sha256, cloud_state)
           SELECT release_id, tender_id, stage_id, $2, $3, 'smb', 'test', target_folder, file_set, placement, placement_sha256, 'not_applicable' FROM delivery WHERE id = $1 RETURNING id`,
          [d.id, dest.id, dest.current.id],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO delivery_file_state (delivery_id, ordinal, path, kind, sha256, size_bytes)
         SELECT $1, ordinal, path, kind, CASE WHEN kind = 'file' AND ordinal = 1 THEN $2 ELSE sha256 END, size_bytes FROM delivery_file_state WHERE delivery_id = $3`,
        [id, 'b'.repeat(64), d.id],
      );
    });
    expect(forged).toBe('23514');
    const noMarker = await txCode(async (c) => {
      const id = (
        await c.query(
          `INSERT INTO delivery (release_id, tender_id, stage_id, destination_id, destination_version_id, kind, environment, target_folder, file_set, placement, placement_sha256, cloud_state)
           SELECT release_id, tender_id, stage_id, $2, $3, 'smb', 'test', target_folder, file_set, placement, placement_sha256, 'not_applicable' FROM delivery WHERE id = $1 RETURNING id`,
          [d.id, dest.id, dest.current.id],
        )
      ).rows[0].id;
      await c.query("INSERT INTO delivery_file_state (delivery_id, ordinal, path, kind, sha256, size_bytes) SELECT $1, ordinal, path, kind, sha256, size_bytes FROM delivery_file_state WHERE delivery_id = $2 AND kind <> 'marker'", [id, d.id]);
    });
    expect(noMarker).toBe('23514');
    const badFolder = await txCode(async (c) => {
      const id = (
        await c.query(
          `INSERT INTO delivery (release_id, tender_id, stage_id, destination_id, destination_version_id, kind, environment, target_folder, file_set, placement, placement_sha256, cloud_state)
           SELECT release_id, tender_id, stage_id, $2, $3, 'smb', 'test', '../../Чужая папка', file_set, placement, placement_sha256, 'not_applicable' FROM delivery WHERE id = $1 RETURNING id`,
          [d.id, dest.id, dest.current.id],
        )
      ).rows[0].id;
      await c.query('INSERT INTO delivery_file_state (delivery_id, ordinal, path, kind, sha256, size_bytes) SELECT $1, ordinal, path, kind, sha256, size_bytes FROM delivery_file_state WHERE delivery_id = $2', [id, d.id]);
    });
    expect(badFolder).toBe('23514');
    // Тот же набор — допустим: так создаёт доставку портал.
    const same = await txCode(async (c) => {
      const id = (
        await c.query(
          `INSERT INTO delivery (release_id, tender_id, stage_id, destination_id, destination_version_id, kind, environment, target_folder, file_set, placement, placement_sha256, cloud_state)
           SELECT release_id, tender_id, stage_id, $2, $3, 'smb', 'test', target_folder, file_set, placement, placement_sha256, 'not_applicable' FROM delivery WHERE id = $1 RETURNING id`,
          [d.id, dest.id, dest.current.id],
        )
      ).rows[0].id;
      await c.query('INSERT INTO delivery_file_state (delivery_id, ordinal, path, kind, sha256, size_bytes) SELECT $1, ordinal, path, kind, sha256, size_bytes FROM delivery_file_state WHERE delivery_id = $2', [id, d.id]);
      await c.query("INSERT INTO delivery_event (delivery_id, action) VALUES ($1, 'created')", [id]);
    });
    expect(same).toBe('ok');
  });

  it('переходы только по §16: «размещено» — только при всех сверенных файлах; человеческие — только с событием; конечные не меняются; закреплённое неизменно', async () => {
    const pending = (await st().db.pool.query("SELECT id FROM delivery WHERE status = 'pending' LIMIT 1")).rows[0].id as string;
    expect(await pgCode(st(), "UPDATE delivery SET status = 'delivered', delivered_at = now(), row_version = row_version + 1 WHERE id = $1", [pending])).toBe('23514');
    expect(await pgCode(st(), "UPDATE delivery SET status = 'superseded', row_version = row_version + 1 WHERE id = $1", [pending])).toBe('23514');
    expect(await pgCode(st(), "UPDATE delivery SET target_folder = 'A-1/другая', row_version = row_version + 1 WHERE id = $1", [pending])).toBe('55000');
    expect(await pgCode(st(), "UPDATE delivery_file_state SET remote_state = 'verified', remote_sha256 = $2 WHERE delivery_id = $1 AND ordinal = 1", [pending, 'c'.repeat(64)])).toBe('23514');
    // Без события человека: failed → pending нельзя.
    await runDeliveries(st(), deliveryWorker(st(), fs));
    fs.add({ op: 'writeFile', effect: { errno: 'EACCES' } });
    const root = join(s.folders.base, 'second-line');
    mkdirSync(root);
    await createDestination(admin(), { title: 'Вторая линия', kind: 'smb', rootPath: root });
    const placed = await s.st.e.s.eng1.post(`/releases/${s.releaseId}/deliveries`, {}, { headers: idem() });
    expect(placed.status, placed.text).toBe(201);
    await runDeliveries(st(), deliveryWorker(st(), fs));
    fs.clear();
    const failedId = placed.body.created[0] as string;
    expect((await deliveryOf(s.st.e.s.eng1, failedId)).status).toBe('failed');
    expect(await pgCode(st(), "UPDATE delivery SET status = 'pending', row_version = row_version + 1 WHERE id = $1", [failedId])).toBe('23514');
    expect(await pgCode(st(), "INSERT INTO delivery_event (delivery_id, action, actor_user_id, reason) VALUES ($1, 'retry', $2, 'чужой тендер')", [failedId, s.st.e.s.ids.eng3])).toBe('42501');
    expect(await pgCode(st(), "INSERT INTO delivery_event (delivery_id, action, actor_user_id) VALUES ($1, 'retry', $2)", [failedId, s.st.e.s.ids.eng1])).toBe('23514');
    // Размещённая — конечная.
    const delivered = (await st().db.pool.query("SELECT id FROM delivery WHERE status = 'delivered' AND kind = 'smb' LIMIT 1")).rows[0].id as string;
    expect(await pgCode(st(), "UPDATE delivery SET status = 'failed', row_version = row_version + 1 WHERE id = $1", [delivered])).toBe('55000');
    expect(await pgCode(st(), "UPDATE delivery SET cloud_state = 'unconfirmed', row_version = row_version + 1 WHERE id = $1", [delivered])).toBe('23514');
    expect(await pgCode(st(), "UPDATE delivery_file_state SET remote_state = 'absent' WHERE delivery_id = $1", [delivered])).toBe('55000');
    // Удаление и очистка запрещены у всех таблиц этапа.
    for (const t of ['delivery', 'delivery_file_state', 'delivery_attempt', 'delivery_event', 'delivery_destination', 'delivery_destination_version', 'delivery_destination_probe']) {
      expect(await pgCode(st(), `DELETE FROM ${t}`, []), t).not.toBe('ok');
    }
    // Неизменяемые таблицы: у роли приложения нет UPDATE (42501); суперпользователя останавливает триггер (55000).
    expect(await pgCode(st(), 'UPDATE delivery_attempt SET detail = $1', ['правка'])).toBe('42501');
    expect(await pgCode(st(), 'UPDATE delivery_destination_version SET root_path = $1', ['/x'])).toBe('42501');
    for (const [t, col] of [['delivery_attempt', 'detail'], ['delivery_event', 'reason'], ['delivery_destination_version', 'reason'], ['delivery_destination_probe', 'detail']] as const) {
      const code = await su((c) => c.query(`UPDATE ${t} SET ${col} = ${col}`).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error'));
      expect(code, t).toBe('55000');
    }
  });

  it('возможность delivery.manage — у инженера и руководителя тендера; у сервисной учётной записи модели — нет', async () => {
    const caps = async (user: string) => (await st().db.pool.query('SELECT tender_capabilities($1, $2) AS caps', [user, s.st.e.s.tenderA])).rows[0].caps as string[];
    expect(await caps(s.st.e.s.ids.eng1)).toContain('delivery.manage');
    expect(await caps(s.st.e.s.ids.manager)).toContain('delivery.manage');
    expect(await caps(s.st.e.s.ids.eng3)).not.toContain('delivery.manage');
    const model = (await st().db.pool.query("INSERT INTO app_user (kind, service_kind, login, display_name) VALUES ('service', 'model', 'model.delivery', 'Модель') RETURNING id")).rows[0].id as string;
    expect(await caps(model)).toEqual([]);
    const failed = (await st().db.pool.query("SELECT id FROM delivery WHERE status = 'failed' LIMIT 1")).rows[0].id as string;
    expect(await pgCode(st(), "INSERT INTO delivery_event (delivery_id, action, actor_user_id, reason) VALUES ($1, 'retry', $2, 'модель повторяет')", [failed, model])).toBe('42501');
  });
});

describe('вредоносные пути (A38): отказ до записи', () => {
  it('путь файла с «..» и зарезервированное имя в наборе, «..» в корне версии — «ошибка» INVALID_PATH, вне корня ничего не появилось', async () => {
    const root = join(s.folders.base, 'evil', 'root');
    mkdirSync(root, { recursive: true });
    const dest = await createDestination(admin(), { title: 'Вредоносный путь', kind: 'smb', rootPath: root });
    const placed = await s.st.e.s.eng1.post(`/releases/${s.releaseId}/deliveries`, {}, { headers: idem() });
    const id = placed.body.created[0] as string;
    // Так выглядели бы данные, попавшие в обход портала: правка суперпользователем с выключенными триггерами — путь файла
    // в наборе и в признаке готовности согласованно (иначе сработала бы сверка набора, CONTENT_MISMATCH).
    await su(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      const row = (await c.query('SELECT placement FROM delivery WHERE id = $1', [id])).rows[0];
      const first = (await c.query("SELECT path FROM delivery_file_state WHERE delivery_id = $1 AND ordinal = 1", [id])).rows[0].path as string;
      const placement = row.placement as IPlacementManifest;
      const evil: IPlacementManifest = { ...placement, files: placement.files.map((f) => (f.path === first ? { ...f, path: '../../вне корня.pdf' } : f)) };
      await c.query('UPDATE delivery SET placement = $2, placement_sha256 = $3 WHERE id = $1', [id, JSON.stringify(evil), placementSha256(evil)]);
      await c.query("UPDATE delivery_file_state SET path = '../../вне корня.pdf' WHERE delivery_id = $1 AND ordinal = 1", [id]);
      await c.query("UPDATE delivery_file_state SET sha256 = $2, size_bytes = $3 WHERE delivery_id = $1 AND kind = 'marker'", [id, placementSha256(evil), placementBytes(evil).length]);
    });
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const d = await deliveryOf(s.st.e.s.eng1, id);
    expect(d).toMatchObject({ status: 'failed', lastError: { code: 'INVALID_PATH' } });
    expect(d.lastError!.detail).toMatch(/вне корня/u);
    expect(readdirSync(join(s.folders.base, 'evil'))).toEqual(['root']);
    expect(readdirSync(root).filter((x) => x !== '.kontur-staging')).toEqual([]);
    // Корень версии с «..» (в обход проверки сервера): отказ до любой записи.
    const root2 = join(s.folders.base, 'evil2', 'root');
    mkdirSync(root2, { recursive: true });
    const dest2 = await createDestination(admin(), { title: 'Вредоносный корень', kind: 'smb', rootPath: root2 });
    await su(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      await c.query('UPDATE delivery_destination_version SET root_path = $2 WHERE id = $1', [dest2.current.id, `${root2}/../..`]);
    });
    const placed2 = await s.st.e.s.eng1.post(`/releases/${s.releaseId}/deliveries`, {}, { headers: idem() });
    await runDeliveries(st(), deliveryWorker(st(), fs));
    const d2 = await deliveryOf(s.st.e.s.eng1, placed2.body.created.find((x: string) => x !== id) as string);
    expect(d2).toMatchObject({ status: 'failed', lastError: { code: 'INVALID_PATH' } });
    expect(readdirSync(join(s.folders.base, 'evil2'))).toEqual(['root']);
    expect(dest.id).not.toBe(dest2.id);
  });
});

describe('обновление схемы 0037 → 0038', () => {
  it('данные этапа 13 переживают обновление: участникам выдан delivery.manage, интеграции BLOCKED_EXTERNAL, выпуск после обновления размещается', async () => {
    const name = `kontur_kp_test_upgrade37_${Date.now().toString(36)}`;
    const urlFor = (user: string) => {
      const u = new URL(ADMIN_URL);
      u.username = user;
      u.password = '';
      u.pathname = `/${name}`;
      return u.toString();
    };
    const migrateTo = async (max: number): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), `kontur-mig37-${max}-`));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
      const mc = new pg.Client({ connectionString: urlFor('kontur_migrator') });
      await mc.connect();
      try {
        return (await migrate(mc, { testMode: true, dir })).length;
      } finally {
        await mc.end();
      }
    };
    await setupDatabase(ADMIN_URL, name);
    const db: ITestDb = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
    let up: IStage13 | undefined;
    try {
      expect(await migrateTo(37)).toBe(37);
      up = await buildStage13({ db });
      let c = await assembled(up);
      await notApplicable(up, c.id).catch(() => 0);
      c = await view(up, c.id);
      await acceptAll(up, c);
      c = await view(up, c.id);
      const a = await approve(up, c);
      expect(a.status, a.text).toBe(200);
      expect(await migrateTo(99)).toBe(1);
      expect((await db.pool.query('SELECT tender_capabilities($1, $2) AS caps', [up.e.s.ids.eng1, up.e.s.tenderA])).rows[0].caps).toContain('delivery.manage');
      expect((await db.pool.query("SELECT system, status FROM integration_status WHERE component = 'FsDeliveryTarget' ORDER BY system")).rows).toEqual([
        { system: 'smb', status: 'BLOCKED_EXTERNAL' },
        { system: 'yandex_disk', status: 'BLOCKED_EXTERNAL' },
      ]);
      const root = mkdtempSync(join(tmpdir(), 'kontur-upgrade-smb-'));
      await createDestination(up.e.s.admin, { title: 'После обновления', kind: 'smb', rootPath: root });
      c = await view(up, c.id, up.e.s.eng1);
      const r = await release(up, c, a.body.approval.id as string);
      expect(r.status, r.text).toBe(201);
      const w = new FaultyFs();
      await runDeliveries(up, deliveryWorker(up, w));
      const list = await deliveriesOf(up.e.s.eng1, r.body.release.id as string);
      expect(list.items.map((d) => d.status)).toEqual(['delivered']);
    } finally {
      await closeStage13(up);
      await db.pool.end().catch(() => undefined);
      await dropDatabase(ADMIN_URL, name);
    }
  });
});
