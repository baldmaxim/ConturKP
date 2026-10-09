// Фикстуры этапа 14 (D-034): выпуск тестового комплекта этапа 13 и назначения размещения во временных папках —
// «папка синхронизации» Яндекс Диска со служебной папкой вне её и «сетевая папка» со служебной внутри. Это поддельные
// назначения (VERIFIED_FIXTURE): клиента Яндекс Диска и сервера SMB нет. Отказы вносит обёртка файловой системы.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { expect } from 'vitest';
import { HANDLERS } from '../apps/worker/src/handlers/index.ts';
import { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import type { IDeliveryFs, IFsStat } from '../packages/adapters/src/index.ts';
import { BlobStore, nodeDeliveryFs } from '../packages/storage/src/index.ts';
import { acceptAll, approve, assembled, buildStage13, closeStage13, notApplicable, release, view, type IStage13 } from './approvalFixtures.ts';
import { idem, type TestClient } from './helpers.ts';

export type FsOp = keyof IDeliveryFs;

// Отказ: errno — ошибка ОС до операции; partial — половина байтов записана, затем обрыв; late — операция выполнена,
// ответ приходит после срока ожидания (неизвестный исход); corrupt — записаны другие байты; hang — операция не
// завершается: процесс worker «умер» в этой точке (см. crashAt); dev — другой том.
export type FaultEffect =
  | { errno: string }
  | { partial: true }
  | { lateMs: number }
  | { corrupt: true }
  | { hang: true }
  | { dev: number };

export interface IFaultRule {
  op: FsOp;
  // Подстрока пути (в любом разделителе) или предикат.
  path?: string | ((p: string) => boolean);
  effect: FaultEffect;
  times?: number;
}

export class WorkerCrash extends Error {}

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: внесённый отказ`), { code });

const collect = async (source: Readable | Buffer): Promise<Buffer> => {
  if (Buffer.isBuffer(source)) return source;
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
};

// Файловая система с внесением отказов поверх настоящих временных папок.
export class FaultyFs implements IDeliveryFs {
  private rules: (IFaultRule & { left: number })[] = [];
  private hung: { reject: (e: Error) => void }[] = [];
  private onHang: (() => void) | null = null;
  readonly calls: { op: FsOp; path: string }[] = [];
  private readonly inner = nodeDeliveryFs();

  add(rule: IFaultRule): this {
    this.rules.push({ ...rule, left: rule.times ?? Number.POSITIVE_INFINITY });
    return this;
  }

  clear(): void {
    this.rules = [];
  }

  // Ждать, пока какая-нибудь операция «зависнет».
  waitHung(): Promise<void> {
    if (this.hung.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.onHang = resolve;
    });
  }

  // Зависшие операции завершаются ошибкой: запуск «умершего» процесса доигрывает без аренды и ничего не записывает.
  releaseHung(): void {
    for (const h of this.hung.splice(0)) h.reject(new WorkerCrash('процесс worker остановлен'));
  }

  private hang(): Promise<never> {
    return new Promise<never>((_, reject) => {
      this.hung.push({ reject });
      this.onHang?.();
      this.onHang = null;
    });
  }

  count(op: FsOp, path?: string): number {
    return this.calls.filter((c) => c.op === op && (!path || norm(c.path).includes(norm(path)))).length;
  }

  private take(op: FsOp, path: string): FaultEffect | null {
    this.calls.push({ op, path });
    for (const r of this.rules) {
      if (r.op !== op || r.left <= 0) continue;
      const hit = r.path === undefined ? true : typeof r.path === 'string' ? norm(path).includes(norm(r.path)) : r.path(path);
      if (!hit) continue;
      r.left -= 1;
      return r.effect;
    }
    return null;
  }

  private async wrap<T>(op: FsOp, path: string, run: () => Promise<T>): Promise<T> {
    const e = this.take(op, path);
    if (!e) return run();
    if ('errno' in e) throw errnoError(e.errno);
    if ('hang' in e) return this.hang();
    if ('lateMs' in e) {
      const out = await run();
      await new Promise((r) => setTimeout(r, e.lateMs));
      return out;
    }
    return run();
  }

  stat(p: string): Promise<IFsStat | null> {
    const e = this.take('stat', p);
    if (e && 'errno' in e) return Promise.reject(errnoError(e.errno));
    if (e && 'dev' in e) return this.inner.stat(p).then((s) => (s ? { ...s, dev: e.dev } : s));
    return this.inner.stat(p);
  }

  mkdir(p: string): Promise<void> {
    return this.wrap('mkdir', p, () => this.inner.mkdir(p));
  }

  readdir(p: string): Promise<string[]> {
    return this.wrap('readdir', p, () => this.inner.readdir(p));
  }

  async writeFile(p: string, source: Readable | Buffer, exclusive: boolean): Promise<void> {
    const e = this.take('writeFile', p);
    if (!e) return this.inner.writeFile(p, source, exclusive);
    if ('errno' in e) throw errnoError(e.errno);
    if ('hang' in e) return this.hang();
    const bytes = await collect(source);
    if ('partial' in e) {
      await this.inner.writeFile(p, bytes.subarray(0, Math.floor(bytes.length / 2)), exclusive);
      throw errnoError('ECONNRESET');
    }
    if ('corrupt' in e) {
      const bad = Buffer.from(bytes);
      bad[0] = (bad[0] ?? 0) ^ 0xff;
      return this.inner.writeFile(p, bad, exclusive);
    }
    if ('lateMs' in e) {
      await this.inner.writeFile(p, bytes, exclusive);
      await new Promise((r) => setTimeout(r, e.lateMs));
      return;
    }
    return this.inner.writeFile(p, bytes, exclusive);
  }

  hashFile(p: string): Promise<{ sha256: string; size: number }> {
    return this.wrap('hashFile', p, () => this.inner.hashFile(p));
  }

  rename(from: string, to: string): Promise<void> {
    return this.wrap('rename', `${from} -> ${to}`, () => this.inner.rename(from, to));
  }

  moveNoReplace(from: string, to: string): Promise<void> {
    return this.wrap('moveNoReplace', `${from} -> ${to}`, () => this.inner.moveNoReplace(from, to));
  }

  remove(p: string): Promise<void> {
    return this.wrap('remove', p, () => this.inner.remove(p));
  }
}

const norm = (p: string): string => p.replaceAll('\\', '/');

export const nodeFsDev = (p: string): number => statSync(p).dev;

// ---------------------------------------------------------------- Временные назначения

export interface IFolders {
  base: string;
  yandexSync: string;
  yandexRoot: string;
  yandexStaging: string;
  smbRoot: string;
}

export const tempFolders = (): IFolders => {
  const base = mkdtempSync(join(tmpdir(), 'kontur-delivery-'));
  const yandexSync = join(base, 'Яндекс.Диск');
  const yandexRoot = join(yandexSync, 'Контур КП тест');
  const yandexStaging = join(base, 'kontur-staging');
  const smbRoot = join(base, 'share', 'Контур КП тест');
  for (const d of [yandexRoot, yandexStaging, smbRoot]) mkdirSync(d, { recursive: true });
  return { base, yandexSync, yandexRoot, yandexStaging, smbRoot };
};

// Все файлы под папкой: относительный путь (через /) → байты.
export const tree = (root: string): Map<string, Buffer> => {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p).split(sep).join('/'), readFileSync(p));
    }
  };
  walk(root);
  return out;
};

export const dirs = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        out.push(relative(root, p).split(sep).join('/'));
        walk(p);
      }
    }
  };
  walk(root);
  return out.sort();
};

// ---------------------------------------------------------------- Назначения и доставки через API

export interface IDestinationView {
  id: string;
  title: string;
  kind: 'yandex_disk' | 'smb';
  environment: 'test' | 'production';
  active: boolean;
  etag: string;
  current: { id: string; version: number; rootPath: string; stagingPath: string; includeInternal: boolean };
  versions: { id: string; version: number }[];
  lastProbe: { version: number; current: boolean; outcome: 'ok' | 'failed'; errorCode: string | null; detail: string | null } | null;
  probePending: boolean;
}

export interface IDeliveryView {
  id: string;
  releaseId: string;
  destination: { id: string; title: string; kind: 'yandex_disk' | 'smb'; environment: string; version: number };
  targetFolder: string;
  fileSet: 'customer' | 'all';
  status: string;
  attemptCount: number;
  lastError: { code: string; detail: string | null } | null;
  supersededBy: string | null;
  deliveredAt: string | null;
  cloud: { state: string; confirmedBy: string | null; confirmedAt: string | null; note: string | null } | null;
  files: { path: string; kind: string; size: number; sha256: string; remoteState: string }[];
  attempts: { seq: number; outcome: string; errorCode: string | null; detail: string | null }[];
  events: { action: string; actor: string | null; reason: string | null }[];
  etag: string;
  actions: { retry: boolean; resolveConflict: boolean; redirect: boolean; confirmCloud: boolean };
}

export interface IReleaseDeliveries {
  items: IDeliveryView[];
  summary: { total: number; delivered: number; cloudTotal: number; cloudConfirmed: number; missing: number };
  canPlace: boolean;
}

export const createDestination = async (
  admin: TestClient,
  d: { title: string; kind: 'yandex_disk' | 'smb'; environment?: 'test' | 'production'; rootPath: string; stagingPath?: string | null; includeInternal?: boolean },
): Promise<IDestinationView> => {
  const r = await admin.post(
    '/delivery-destinations',
    { environment: 'test', includeInternal: false, reason: 'Тестовое назначение этапа 14', ...d },
    { headers: idem() },
  );
  expect(r.status, r.text).toBe(201);
  return r.body as IDestinationView;
};

export const newVersion = async (admin: TestClient, d: IDestinationView, v: { rootPath: string; stagingPath?: string | null; includeInternal?: boolean }): Promise<IDestinationView> => {
  const fresh = await destination(admin, d.id);
  const r = await admin.post(
    `/delivery-destinations/${d.id}/versions`,
    { includeInternal: fresh.current.includeInternal, reason: 'Новая версия путей для теста', ...v },
    { headers: { 'If-Match': fresh.etag, ...idem() } },
  );
  expect(r.status, r.text).toBe(201);
  return r.body as IDestinationView;
};

export const destination = async (admin: TestClient, id: string): Promise<IDestinationView> => {
  const r = await admin.get('/delivery-destinations');
  expect(r.status, r.text).toBe(200);
  return (r.body.items as IDestinationView[]).find((x) => x.id === id)!;
};

export const setActive = async (admin: TestClient, id: string, active: boolean): Promise<void> => {
  const d = await destination(admin, id);
  const r = await admin.patch(`/delivery-destinations/${id}`, { active }, { headers: { 'If-Match': d.etag } });
  expect(r.status, r.text).toBe(200);
};

export const deliveriesOf = async (client: TestClient, releaseId: string): Promise<IReleaseDeliveries> => {
  const r = await client.get(`/releases/${releaseId}/deliveries`);
  expect(r.status, r.text).toBe(200);
  return r.body as IReleaseDeliveries;
};

export const deliveryOf = async (client: TestClient, id: string): Promise<IDeliveryView> => {
  const r = await client.get(`/deliveries/${id}`);
  expect(r.status, r.text).toBe(200);
  return r.body as IDeliveryView;
};

export const place = (client: TestClient, releaseId: string, reason?: string) =>
  client.post(`/releases/${releaseId}/deliveries`, reason ? { reason } : {}, { headers: idem() });

export const act = async (client: TestClient, d: IDeliveryView, action: 'retry' | 'resolve-conflict' | 'redirect' | 'confirm-cloud', text: string) =>
  client.post(`/deliveries/${d.id}/${action}`, action === 'confirm-cloud' ? { note: text } : { reason: text }, { headers: { 'If-Match': d.etag, ...idem() } });

// ---------------------------------------------------------------- Worker размещения

export const DELIVERY_KINDS = ['delivery.place', 'delivery.probe'];

export const deliveryWorker = (st: IStage13, fs: IDeliveryFs, operationTimeoutMs = 30_000): WorkerRuntime =>
  new WorkerRuntime({
    pool: st.db.pool,
    store: new BlobStore(st.e.config.storageRoot),
    config: { ...st.e.config, delivery: { operationTimeoutMs } },
    handlers: HANDLERS,
    workerId: 'test-worker-14',
    deliveryFs: fs,
  });

// Задания размещения до опустошения очереди; повторы — сразу (backoff сдвигается), не больше max запусков.
export const runDeliveries = async (st: IStage13, worker: WorkerRuntime, max = 50): Promise<number> => {
  let n = 0;
  while (n < max) {
    await st.db.pool.query("UPDATE job SET run_after = now() WHERE kind = ANY($1::text[]) AND status = 'queued' AND run_after > now()", [DELIVERY_KINDS]);
    if (!(await worker.runOnce(DELIVERY_KINDS))) break;
    n += 1;
  }
  return n;
};

// Остановка процесса worker в точке зависшей операции: аренда снимается (как после её истечения и прохода
// восстановления), «умерший» запуск доигрывает без аренды. Следующий запуск — новый захват задания.
export const crashAt = async (st: IStage13, worker: WorkerRuntime, fs: FaultyFs): Promise<void> => {
  const running = worker.runOnce(DELIVERY_KINDS);
  await fs.waitHung();
  await st.db.pool.query(
    "UPDATE job SET status = 'queued', lease_token = NULL, locked_by = NULL, locked_until = NULL, run_after = now(), updated_at = now() WHERE kind = 'delivery.place' AND status = 'running'",
  );
  fs.releaseHung();
  await running;
};

// Ровно один запуск задания размещения (без сдвига повторов).
export const runOneDelivery = async (st: IStage13, worker: WorkerRuntime): Promise<boolean> => {
  await st.db.pool.query("UPDATE job SET run_after = now() WHERE kind = ANY($1::text[]) AND status = 'queued' AND run_after > now()", [DELIVERY_KINDS]);
  return worker.runOnce(DELIVERY_KINDS);
};

// ---------------------------------------------------------------- Выпуск

export interface IStage14 {
  st: IStage13;
  folders: IFolders;
  releaseId: string;
  candidateId: string;
}

// Тестовый комплект: «не влияет» по удержаниям, принятые риски, согласование, выпуск. Назначения создаются заранее —
// доставки появляются в транзакции выпуска.
export const releaseTestCandidate = async (st: IStage13): Promise<{ releaseId: string; candidateId: string }> => {
  let c = await assembled(st);
  await notApplicable(st, c.id).catch(() => 0);
  c = await view(st, c.id);
  await acceptAll(st, c);
  c = await view(st, c.id);
  const a = await approve(st, c);
  expect(a.status, a.text).toBe(200);
  c = await view(st, c.id, st.e.s.eng1);
  const r = await release(st, c, a.body.approval.id as string);
  expect(r.status, r.text).toBe(201);
  return { releaseId: r.body.release.id as string, candidateId: c.id };
};

export const buildStage14 = async (o: { destinations?: (f: IFolders, admin: TestClient) => Promise<void> } = {}): Promise<IStage14> => {
  const st = await buildStage13();
  const folders = tempFolders();
  if (o.destinations) await o.destinations(folders, st.e.s.admin);
  const r = await releaseTestCandidate(st);
  return { st, folders, ...r };
};

export const closeStage14 = async (s: IStage14 | undefined): Promise<void> => {
  await closeStage13(s?.st);
};

export const pgCode = async (st: IStage13, sql: string, params: unknown[]): Promise<string> =>
  st.db.pool.query(sql, params).then(
    () => 'ok',
    (x: { code?: string }) => x.code ?? 'error',
  );
