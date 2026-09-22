// Тестовая обвязка: изолированная БД на файл тестов (имя содержит test), клиент с cookie/CSRF.
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import type { IAppConfig } from '../packages/config/src/index.ts';
import { hashPassword, type Role } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, insertUser, migrate, setupDatabase, type Pool } from '../packages/db/src/index.ts';
import { createApp } from '../apps/server/src/app.ts';
import { HANDLERS } from '../apps/worker/src/handlers/index.ts';
import { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';

export const ADMIN_URL = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
export const ORIGIN = 'http://127.0.0.1:5273';
export const PASSWORD = 'correct-horse-battery';

const urlFor = (user: string, db: string): string => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = '';
  u.pathname = `/${db}`;
  return u.toString();
};

export interface ITestDb {
  name: string;
  appUrl: string;
  migratorUrl: string;
  pool: Pool;
  drop: () => Promise<void>;
}

export const createTestDb = async (): Promise<ITestDb> => {
  const name = `kontur_kp_test_${randomBytes(5).toString('hex')}`;
  await setupDatabase(ADMIN_URL, name);
  const migratorUrl = urlFor('kontur_migrator', name);
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await migrate(client, { testMode: true });
  } finally {
    await client.end();
  }
  const appUrl = urlFor('kontur_app', name);
  const pool = createPool(appUrl, 5);
  return {
    name,
    appUrl,
    migratorUrl,
    pool,
    drop: async () => {
      await pool.end();
      await dropDatabase(ADMIN_URL, name);
    },
  };
};

export const testConfig = (overrides: Partial<IAppConfig> = {}): IAppConfig => ({
  env: 'test',
  databaseUrl: '',
  storageRoot: mkdtempSync(join(tmpdir(), 'kontur-storage-')),
  httpHost: '127.0.0.1',
  httpPort: 0,
  allowedOrigins: [ORIGIN],
  tls: null,
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 24,
  workerHeartbeatSeconds: 10,
  workerStaleSeconds: 60,
  webDistDir: join(tmpdir(), 'kontur-no-web'),
  limits: {
    maxUploadBytes: 64 * 1024 * 1024,
    maxEntryBytes: 32 * 1024 * 1024,
    maxArchiveTotalBytes: 128 * 1024 * 1024,
    maxArchiveEntries: 3000,
    maxCompressionRatio: 200,
  },
  intakeRoots: [],
  intakeStabilitySeconds: 1,
  jobLeaseSeconds: 60,
  gpuTakeoverGraceSeconds: 120,
  recognition: {
    maxMetadataBytes: 8 * 1024 * 1024,
    maxMetadataTotalBytes: 16 * 1024 * 1024,
    maxTotalTextChars: 4 * 1024 * 1024,
    maxPdfBytes: 16 * 1024 * 1024,
  },
  ...overrides,
});

export class Clock {
  now = new Date('2026-09-18T09:00:00Z');
  read = (): Date => new Date(this.now);
  advanceMinutes(m: number): void {
    this.now = new Date(this.now.getTime() + m * 60_000);
  }
}

export const makeApp = (db: ITestDb, clock = new Clock(), config = testConfig()) =>
  createApp({ config, pool: db.pool, clock: clock.read, logError: () => undefined });

// Worker в том же процессе теста: те же обработчики и хранилище, что у процесса worker.
export const makeWorker = (db: ITestDb, config: IAppConfig, workerId = 'test-worker'): WorkerRuntime =>
  new WorkerRuntime({ pool: db.pool, store: new BlobStore(config.storageRoot), config, handlers: HANDLERS, workerId });

// Выполняет задания, пока очередь не опустеет (ограничение — защита от бесконечного цикла).
export const drain = async (worker: WorkerRuntime, max = 20_000): Promise<number> => {
  let n = 0;
  while (n < max && (await worker.runOnce())) n += 1;
  return n;
};

let cachedHash: Promise<string> | null = null;
export const createUser = async (pool: Pool, login: string, roles: Role[], displayName = login): Promise<string> => {
  cachedHash ??= hashPassword(PASSWORD);
  return insertUser(pool, { login, displayName, passwordHash: await cachedHash, roles }, null);
};

type App = ReturnType<typeof makeApp>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface IRequestOptions {
  body?: unknown;
  headers?: Record<string, string | undefined>;
  csrf?: boolean;
  origin?: string | null;
}

// Клиент браузера: хранит cookie, для изменяющих запросов ставит Origin и X-CSRF-Token.
export class TestClient {
  readonly cookies = new Map<string, string>();
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  private absorb(res: request.Response): void {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const c of raw ?? []) {
      const pair = c.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = decodeURIComponent(pair.slice(i + 1));
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async req(method: Method, path: string, o: IRequestOptions = {}): Promise<request.Response> {
    let r = request(this.app)[method](path);
    if (this.cookies.size > 0) r = r.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '));
    if (method !== 'get') {
      const origin = o.origin === undefined ? ORIGIN : o.origin;
      if (origin) r = r.set('Origin', origin);
      const csrf = this.cookies.get('kkp_csrf');
      if (o.csrf !== false && csrf) r = r.set('X-CSRF-Token', csrf);
    }
    for (const [k, v] of Object.entries(o.headers ?? {})) if (v !== undefined) r = r.set(k, v);
    const res = o.body !== undefined ? await r.send(o.body as object) : await r;
    this.absorb(res);
    return res;
  }

  get(path: string, o?: IRequestOptions) {
    return this.req('get', `/api/v1${path}`, o);
  }
  post(path: string, body?: unknown, o: IRequestOptions = {}) {
    return this.req('post', `/api/v1${path}`, { ...o, body });
  }
  put(path: string, body?: unknown, o: IRequestOptions = {}) {
    return this.req('put', `/api/v1${path}`, { ...o, body });
  }
  patch(path: string, body?: unknown, o: IRequestOptions = {}) {
    return this.req('patch', `/api/v1${path}`, { ...o, body });
  }
  delete(path: string, o: IRequestOptions = {}) {
    return this.req('delete', `/api/v1${path}`, o);
  }

  async login(login: string, password = PASSWORD): Promise<request.Response> {
    return this.post('/auth/login', { login, password });
  }
}

// Прогон распознавания для тестов, которым нужен факт распознавания, а не его разбор
// (охранное условие заморозки, область). Идёт по настоящей машине состояний: queued → running →
// терминальный статус, поэтому проверяет заодно и триггеры миграции 0005.
export const seedRecognition = async (
  pool: Pool,
  revisionId: string,
  status: 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled' = 'complete',
  pages: { total: number; recognized: number } = { total: 2, recognized: 2 },
): Promise<string> => {
  const rev = await pool.query<{ tender_id: string }>('SELECT tender_id FROM document_revision WHERE id = $1', [revisionId]);
  const sha = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/zip', $2)", [sha, `seed/${sha}`]);
  const run = await pool.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, source_artifact_name)
     VALUES ($1, $2, 'rdweb_export', $3, 'seed.zip') RETURNING id`,
    [revisionId, rev.rows[0]!.tender_id, sha],
  );
  const id = run.rows[0]!.id;
  if (status === 'queued') return id;
  await pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
  if (status === 'running') return id;
  if (status === 'failed') {
    await pool.query(
      `UPDATE recognition_run SET status = 'failed', failure_code = 'seed', finished_at = now(), row_version = row_version + 1 WHERE id = $1`,
      [id],
    );
    return id;
  }
  if (status === 'cancelled') {
    await pool.query("UPDATE recognition_run SET status = 'cancelled', finished_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
    return id;
  }
  // Счётчики полноты сверяются со строками страниц (R04-04): заголовок прогона и его
  // содержимое обязаны совпадать, поэтому фикстура вставляет страницы, а не только числа.
  const recognized = status === 'complete' ? pages.total : Math.min(pages.recognized, pages.total - 1);
  for (let i = 0; i < pages.total; i += 1) {
    const ok = i < recognized;
    await pool.query(
      `INSERT INTO recognition_page (run_id, page_index, page_label, width_px, height_px, rotation, status)
       VALUES ($1, $2, $3, $4, $5, 0, $6)`,
      [id, i, String(i + 1), ok ? 2480 : null, ok ? 3508 : null, ok ? 'recognized' : 'missing'],
    );
  }
  await pool.query(
    `UPDATE recognition_run SET status = $2, engine_schema_version = '1', pages_total = $3, pages_recognized = $4,
            finished_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [id, status, pages.total, recognized],
  );
  return id;
};

export const idem = (): Record<string, string> => ({ 'Idempotency-Key': `test-${randomBytes(8).toString('hex')}` });

export interface IScenario {
  admin: TestClient;
  manager: TestClient;
  eng1: TestClient;
  eng2: TestClient;
  eng3: TestClient;
  ids: Record<'admin' | 'manager' | 'eng1' | 'eng2' | 'eng3', string>;
  tenderA: string;
  tenderB: string;
  stageA: string;
  stageB: string;
}

// Тендер A: руководитель, инженеры 1 и 2. Тендер B: руководитель и инженер 3. Создаётся через API.
export const buildScenario = async (db: ITestDb, app: App): Promise<IScenario> => {
  const ids = {
    admin: await createUser(db.pool, 'admin', ['admin'], 'Администратор'),
    manager: await createUser(db.pool, 'manager', ['manager'], 'Руководитель'),
    eng1: await createUser(db.pool, 'eng1', ['engineer'], 'Инженер 1'),
    eng2: await createUser(db.pool, 'eng2', ['engineer'], 'Инженер 2'),
    eng3: await createUser(db.pool, 'eng3', ['engineer'], 'Инженер 3'),
  };
  const clients = {
    admin: new TestClient(app),
    manager: new TestClient(app),
    eng1: new TestClient(app),
    eng2: new TestClient(app),
    eng3: new TestClient(app),
  };
  for (const [login, c] of Object.entries(clients)) {
    const r = await c.login(login);
    if (r.status !== 200) throw new Error(`вход ${login}: ${r.status}`);
  }
  const mkTender = async (code: string, members: [string, string][]) => {
    const t = await clients.admin.post('/tenders', { code, title: `Тендер ${code}` }, { headers: idem() });
    if (t.status !== 201) throw new Error(`тендер ${code}: ${t.status} ${t.text}`);
    let etag = t.headers.etag as string;
    for (const [userId, memberRole] of members) {
      const m = await clients.admin.put(`/tenders/${t.body.id}/members/${userId}`, { memberRole }, { headers: { 'If-Match': etag } });
      if (m.status !== 200) throw new Error(`назначение: ${m.status} ${m.text}`);
      etag = m.headers.etag as string;
    }
    return t.body.id as string;
  };
  const tenderA = await mkTender('A-1', [[ids.manager, 'manager'], [ids.eng1, 'engineer'], [ids.eng2, 'engineer']]);
  const tenderB = await mkTender('B-1', [[ids.manager, 'manager'], [ids.eng3, 'engineer']]);
  const sA = await clients.manager.post(`/tenders/${tenderA}/stages`, { title: 'Этап A1' }, { headers: idem() });
  const sB = await clients.manager.post(`/tenders/${tenderB}/stages`, { title: 'Этап B1' }, { headers: idem() });
  if (sA.status !== 201 || sB.status !== 201) throw new Error(`этапы: ${sA.status} ${sB.status}`);
  return { ...clients, ids, tenderA, tenderB, stageA: sA.body.id, stageB: sB.body.id };
};

export const auditRows = async (pool: Pool, where: string, params: unknown[] = []) =>
  (
    await pool.query<{
      action: string;
      outcome: string;
      actor_user_id: string | null;
      entity_type: string | null;
      entity_id: string | null;
      tender_id: string | null;
      details: Record<string, unknown>;
    }>(`SELECT action, outcome, actor_user_id, entity_type, entity_id, tender_id, details FROM audit_event WHERE ${where} ORDER BY seq`, params)
  ).rows;
