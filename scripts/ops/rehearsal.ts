// npm run ops:rehearsal — репетиция эксплуатации у разработчика (этап 17, проект §3, §4.5, §5). Настоящие процессы и
// настоящие команды, синтетические данные:
//   1) обновление с принятого этапа 16 (git archive 8964017): старый код создаёт базу и данные → копия --pre-update →
//      db:migrate новым кодом → новые процессы видят прежние данные;
//   2) копия ролью kontur_backup → проверка восстановления ops:restore-check в ОТДЕЛЬНОМ чистом кластере
//      (временный контейнер pgvector/pgvector:pg18, удаляется в конце);
//   3) надёжность процессов: штатная остановка worker по IPC (код 0, /ready сразу 503), kill -9 worker посреди
//      OCR-задания (задание восстановлено и завершено один раз), перезапуск PostgreSQL под работающими процессами.
// Журнал: artifacts/stage-17/ops-rehearsal.log. Код выхода: 0 — PASS, 1 — FAIL, 3 — NOT_RUN (нет Docker, git или
// pg_dump нужной версии). Рабочие базы и каталоги не используются: база kontur_kp_rehearsal_test, каталоги — временные.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ApiClient, freePort, killNode, sleep, startNode, stopNode, waitReady, type IProc } from './procs.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ACCEPTED = '8964017';
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_rehearsal_test';
const CONTAINER = 'kontur-restore-pg';
// Второй одноразовый кластер — «неправильная сторона» в проверке маршрута восстановления (R17-03).
const WRONG_CONTAINER = 'kontur-restore-pg-wrong';
const ROUTE_DB = 'kontur_restore_route_probe';
const IMAGE = 'pgvector/pgvector:pg18';
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
const OWNER = 'reh.owner';

const lines: string[] = [];
let failed = false;
let notRun = false;
const record = (step: string, ok: boolean | null, note = ''): void => {
  if (ok === false) failed = true;
  if (ok === null) notRun = true;
  const line = `${ok === null ? 'NOT_RUN' : ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`;
  lines.push(line);
  console.log(line);
};
const info = (line: string): void => {
  lines.push(`# ${line}`);
  console.log(`# ${line}`);
};

const exec = (file: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}) =>
  new Promise<{ code: number | null; out: string }>((done) => {
    const child = execFile(file, args, { cwd: o.cwd ?? ROOT, env: o.env ?? process.env, windowsHide: true, timeout: o.timeoutMs ?? 300_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, out: `${String(stdout)}${String(stderr)}` }),
    );
    if (o.input !== undefined) {
      child.stdin?.end(o.input);
    }
  });

const dbUrl = (base: string, user: string, db: string): string => {
  const u = new URL(base);
  u.username = user;
  u.password = '';
  u.pathname = `/${db}`;
  return u.toString();
};

const adminQuery = async (url: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> => {
  const c = new pg.Client({ connectionString: url });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end().catch(() => undefined);
  }
};

const waitFor = async <T>(fn: () => Promise<T | null>, timeoutMs: number, stepMs = 500): Promise<T | null> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
};

// Дерево принятого этапа 16: git archive во временный каталог; node_modules — ссылками на текущие пакеты, а
// @kontur/* — на пакеты самого старого дерева (иначе старый код импортировал бы новые пакеты рабочей копии).
const extractAccepted = async (dir: string): Promise<boolean> => {
  const closed = (p: ReturnType<typeof spawn>): Promise<boolean> =>
    new Promise((done) => {
      p.on('close', (code) => done(code === 0));
      p.on('error', () => done(false));
    });
  const git = spawn('git', ['archive', '--format=tar', ACCEPTED], { cwd: ROOT, windowsHide: true });
  const tar = spawn('tar', ['-x', '-C', dir], { windowsHide: true });
  git.stdout.pipe(tar.stdin);
  const ok = (await Promise.all([closed(git), closed(tar)])).every(Boolean);
  if (!ok) return false;
  const nm = join(dir, 'node_modules');
  mkdirSync(nm);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of readdirSync(join(ROOT, 'node_modules'))) {
    if (name === '@kontur' || name === '.bin') continue;
    const src = join(ROOT, 'node_modules', name);
    symlinkSync(src, join(nm, name), lstatSync(src).isDirectory() ? linkType : 'file');
  }
  mkdirSync(join(nm, '@kontur'));
  for (const pkg of readdirSync(join(dir, 'packages'))) symlinkSync(join(dir, 'packages', pkg), join(nm, '@kontur', pkg), linkType);
  for (const app of ['server', 'worker']) symlinkSync(join(dir, 'apps', app), join(nm, '@kontur', app), linkType);
  return true;
};

const uniquePdf = (file: string): Buffer => Buffer.concat([readFileSync(file), Buffer.from(`\n%kontur-rehearsal-${randomBytes(6).toString('hex')}\n`)]);

const main = async (): Promise<void> => {
  info(`Репетиция эксплуатации этапа 17 — ${new Date().toISOString()}, Node ${process.version}, ${process.platform}`);
  const storage = mkdtempSync(join(tmpdir(), 'kontur-reh-storage-'));
  const backupRoot = mkdtempSync(join(tmpdir(), 'kontur-reh-backup-'));
  const restoreRoot = mkdtempSync(join(tmpdir(), 'kontur-reh-restore-'));
  const oldTree = mkdtempSync(join(tmpdir(), 'kontur-reh-16-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KONTUR_ENV: 'test',
    DATABASE_ADMIN_URL: ADMIN,
    DATABASE_URL: dbUrl(ADMIN, 'kontur_app', DB),
    DATABASE_MIGRATOR_URL: dbUrl(ADMIN, 'kontur_migrator', DB),
    BACKUP_DATABASE_URL: dbUrl(ADMIN, 'kontur_backup', DB),
    STORAGE_ROOT: storage,
    BACKUP_ROOT: backupRoot,
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(port),
    ALLOWED_ORIGINS: base,
    MODEL_PROVIDER: 'fake',
    EMBEDDING_PROVIDER: 'fake',
    EMBEDDING_DIM: '16',
    // Короткая аренда: восстановление задания после kill -9 видно за секунды, а не за минуту.
    JOB_LEASE_SECONDS: '5',
    SHUTDOWN_GRACE_SECONDS: '15',
  };
  for (const k of ['TLS_CERT_FILE', 'TLS_KEY_FILE', 'TENDERHUB_URL', 'TENDERHUB_API_KEY', 'INTAKE_ROOTS', 'RESTORE_ADMIN_URL', 'RESTORE_STORAGE_ROOT']) delete env[k];
  const procs: IProc[] = [];
  let containerUp = false;
  let wrongUp = false;
  try {
    await adminQuery(ADMIN, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);

    // ---------------------------------------------------------------- 1. Обновление с этапа 16
    const extracted = await extractAccepted(oldTree);
    record(`дерево принятого этапа 16 (${ACCEPTED})`, extracted ? true : null, extracted ? oldTree : 'git archive или tar недоступны');
    if (!extracted) return;
    const oldEnv = { ...env };
    let r = await exec(process.execPath, ['scripts/db-setup.ts'], { cwd: oldTree, env: oldEnv });
    record('этап 16: db:setup', r.code === 0, r.out.trim().split('\n').at(-1));
    r = await exec(process.execPath, ['scripts/db-migrate.ts'], { cwd: oldTree, env: oldEnv });
    record('этап 16: db:migrate — 42 миграции', r.code === 0 && /применено миграций: 42/u.test(r.out), r.out.trim().split('\n').at(-1));
    r = await exec(process.execPath, ['scripts/bootstrap.ts', '--login', OWNER, '--name', 'Репетиция', '--password-stdin'], { cwd: oldTree, env: oldEnv, input: PASSWORD });
    record('этап 16: bootstrap', r.code === 0 && !r.out.includes(PASSWORD));
    r = await exec(process.execPath, ['scripts/seed-demo.ts', '--password-stdin'], { cwd: oldTree, env: oldEnv, input: PASSWORD });
    record('этап 16: демо-данные', r.code === 0);
    let worker = startNode('worker-16', 'apps/worker/src/main.ts', { cwd: oldTree, env: oldEnv });
    let server = startNode('server-16', 'apps/server/src/main.ts', { cwd: oldTree, env: oldEnv });
    procs.push(worker, server);
    let ready = await waitReady(base, 60_000);
    record('этап 16: server и worker — /ready', ready.ok);
    const api = new ApiClient(base, base);
    const login = await api.call('/auth/login', { method: 'POST', body: { login: 'demo.eng1', password: PASSWORD } });
    record('этап 16: вход', login.status === 200, `HTTP ${login.status}`);
    const tenders = (await (await api.call('/tenders')).json()) as { items: Array<{ id: string; code: string }> };
    const demo = tenders.items.find((t) => t.code === 'DEMO-001');
    const stages = (await (await api.call(`/tenders/${demo?.id}/stages`)).json()) as { items: Array<{ id: string }> };
    const stageId = stages.items[0]?.id;
    const upload = await api.call(`/stages/${stageId}/imports?name=${encodeURIComponent('Письмо-скан.pdf')}`, {
      method: 'POST',
      raw: uniquePdf(join(ROOT, 'tests', 'fixtures', 'local', 'letter-scan.pdf')),
      headers: { 'Idempotency-Key': `reh-${randomBytes(6).toString('hex')}` },
    });
    const batch = (await upload.json()) as { id?: string };
    const done = await waitFor(async () => {
      const b = (await (await api.call(`/imports/${batch.id}`)).json()) as { status: string; items: Array<{ documentRevisionId: string }> };
      return b.status === 'completed' ? b : null;
    }, 60_000);
    record('этап 16: документ импортирован', Boolean(done), `HTTP ${upload.status}`);
    const before = await adminQuery(dbUrl(ADMIN, 'postgres', DB), 'SELECT (SELECT count(*)::int FROM document_revision) AS docs, (SELECT count(*)::int FROM audit_event) AS audit');
    info(`данные этапа 16: редакций ${before.rows[0].docs}, событий аудита ${before.rows[0].audit}`);
    await stopNode(server, 20_000);
    await stopNode(worker, 20_000);

    r = await exec(process.execPath, ['scripts/ops/backup.ts', '--pre-update'], { env });
    record('копия перед обновлением (--pre-update, роль kontur_migrator)', r.code === 0, r.out.trim().split('\n').find((l) => l.includes('копия завершена')) ?? r.out.trim().split('\n').at(-1));
    r = await exec(process.execPath, ['scripts/ops/backup.ts'], { env });
    record('копия ролью kontur_backup до 0043 — отказ с понятной причиной', r.code === 1 && /права роли копии|kontur_backup/u.test(r.out), r.out.trim().split('\n').at(-1));
    r = await exec(process.execPath, ['scripts/db-migrate.ts'], { env });
    record('обновление: db:migrate новым кодом — две новые миграции (0043, 0044)', r.code === 0 && /применено миграций: 2/u.test(r.out), r.out.trim().split('\n').at(-1));
    worker = startNode('worker', 'apps/worker/src/main.ts', { cwd: ROOT, env });
    server = startNode('server', 'apps/server/src/main.ts', { cwd: ROOT, env });
    procs.push(worker, server);
    ready = await waitReady(base, 60_000);
    record('после обновления: /ready', ready.ok, JSON.stringify((ready.body as { checks?: unknown } | null)?.checks ?? null));
    const api2 = new ApiClient(base, base);
    const again = await api2.call('/auth/login', { method: 'POST', body: { login: 'demo.eng1', password: PASSWORD } });
    const tenders2 = (await (await api2.call('/tenders')).json()) as { items: Array<{ code: string }> };
    const after = await adminQuery(dbUrl(ADMIN, 'postgres', DB), 'SELECT (SELECT count(*)::int FROM document_revision) AS docs');
    record('после обновления: вход, тендеры и документы на месте', again.status === 200 && tenders2.items.some((t) => t.code === 'DEMO-001') && after.rows[0].docs === before.rows[0].docs);

    // ---------------------------------------------------------------- 3. Надёжность процессов (новый код)
    const revId = done?.items[0]?.documentRevisionId;
    const ocr = await api2.call(`/document-revisions/${revId}/local-recognitions`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': `reh-${randomBytes(6).toString('hex')}` } });
    const ocrBody = (await ocr.json()) as { run?: { id: string } };
    const runId = ocrBody.run?.id;
    const running = await waitFor(async () => {
      const q = await adminQuery(dbUrl(ADMIN, 'postgres', DB), "SELECT 1 FROM job WHERE kind = 'recognition.local' AND status = 'running'");
      return (q.rowCount ?? 0) > 0 ? true : null;
    }, 30_000, 100);
    await killNode(worker);
    record('kill -9 worker посреди задания OCR', ocr.status === 202 && Boolean(running), `HTTP ${ocr.status}`);
    const readyAfterKill = await waitFor(async () => ((await fetch(`${base}/api/v1/ready`)).status === 503 ? true : null), 90_000, 1000);
    record('/ready замечает остановку worker', Boolean(readyAfterKill));
    worker = startNode('worker-2', 'apps/worker/src/main.ts', { cwd: ROOT, env });
    procs.push(worker);
    const finished = await waitFor(async () => {
      const q = await adminQuery(dbUrl(ADMIN, 'postgres', DB), 'SELECT status FROM recognition_run WHERE id = $1', [runId]);
      const st = q.rows[0]?.status as string | undefined;
      return st && ['complete', 'partial', 'failed'].includes(st) ? st : null;
    }, 180_000, 1000);
    const dup = await adminQuery(
      dbUrl(ADMIN, 'postgres', DB),
      `SELECT (SELECT count(*)::int FROM recognition_run WHERE document_revision_id = $1) AS runs,
              (SELECT count(*)::int FROM evidence_fragment WHERE run_id = $2) AS frags,
              (SELECT count(DISTINCT fragment_key)::int FROM evidence_fragment WHERE run_id = $2) AS keys`,
      [revId, runId],
    );
    const d = dup.rows[0] as { runs: number; frags: number; keys: number };
    record('задание восстановлено после аренды и выполнено один раз', finished === 'complete' && d.runs === 1 && d.frags === d.keys && d.frags > 0, `итог ${finished}, прогонов ${d.runs}, фрагментов ${d.frags}`);

    // Документ — в рабочий состав этапа: поиск режима working ищет только по составу, иначе проверка поиска на копии
    // видит пустую область.
    const draft = await api2.call(`/stages/${stageId}/source-set-revisions`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': `reh-${randomBytes(6).toString('hex')}` } });
    const draftId = ((await draft.json()) as { id?: string }).id;
    const items = await api2.call(`/source-set-revisions/${draftId}/items`, {
      method: 'PUT',
      headers: { 'If-Match': draft.headers.get('etag') ?? '' },
      body: { items: [{ documentRevisionId: revId, inclusion: 'included' }] },
    });
    record('документ включён в рабочий состав этапа', [200, 201].includes(draft.status) && items.status === 200, `HTTP ${draft.status}, ${items.status}`);

    const idle = await waitReady(base, 60_000);
    const pid = worker.child.pid;
    const t0 = Date.now();
    const code = await stopNode(worker, 30_000);
    const stopMs = Date.now() - t0;
    // Строка heartbeat остановленного процесса снята сразу (у убитого kill -9 и у старого worker этапа 16 строки
    // остаются свежими до workerStaleSeconds — поэтому проверяется именно строка этого процесса).
    const hb = await adminQuery(dbUrl(ADMIN, 'postgres', DB), 'SELECT last_seen_at < now() - interval \'1 day\' AS retired FROM process_heartbeat WHERE pid = $1', [pid]);
    record('штатная остановка worker по IPC: код 0, своя строка heartbeat снята сразу', idle.ok && code === 0 && hb.rows[0]?.retired === true, `код ${code}, ${stopMs} мс`);
    worker = startNode('worker-3', 'apps/worker/src/main.ts', { cwd: ROOT, env });
    procs.push(worker);
    record('повторный запуск worker — /ready', (await waitReady(base, 60_000)).ok);

    // ---------------------------------------------------------------- 2. Копия и восстановление на чистом кластере
    r = await exec(process.execPath, ['scripts/ops/backup.ts'], { env });
    record('копия ролью kontur_backup после обновления', r.code === 0, r.out.trim().split('\n').find((l) => l.includes('дамп')) ?? r.out.trim().split('\n').at(-1));
    const restorePort = await freePort();
    const docker = await exec('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-p', `127.0.0.1:${restorePort}:5432`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE], { timeoutMs: 300_000 });
    containerUp = docker.code === 0;
    if (!containerUp) {
      record('чистый кластер для восстановления (Docker)', null, docker.out.trim().slice(0, 200));
      return;
    }
    const restoreAdmin = `postgresql://postgres@127.0.0.1:${restorePort}/postgres`;
    const pgUp = await waitFor(async () => ((await adminQuery(restoreAdmin, 'SELECT 1')).rowCount === 1 ? true : null), 60_000, 1000);
    record(`чистый кластер ${IMAGE} на отдельном порту`, Boolean(pgUp));
    // Инструмент восстановления — из контейнера чистого кластера (R17-03): унаследованный PG_DOCKER_CONTAINER указывал
    // бы на исходный кластер, и pg_restore ушёл бы туда.
    const restoreEnv: NodeJS.ProcessEnv = { ...env, RESTORE_ADMIN_URL: restoreAdmin, RESTORE_STORAGE_ROOT: restoreRoot, PG_DOCKER_CONTAINER: CONTAINER };
    delete restoreEnv.PG_BIN_DIR;

    // Маршрут восстановления (R17-03): охранники смотрят в чистый кластер, а инструмент — в контейнер другого кластера,
    // где уже есть одноимённая база с контрольной таблицей. Отказ должен прийти до записи: на неправильной стороне
    // таблиц не прибавилось, на правильной базы не появилось.
    const wrongPort = await freePort();
    const wrong = await exec('docker', ['run', '-d', '--rm', '--name', WRONG_CONTAINER, '-p', `127.0.0.1:${wrongPort}:5432`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE], { timeoutMs: 300_000 });
    wrongUp = wrong.code === 0;
    const wrongAdmin = `postgresql://postgres@127.0.0.1:${wrongPort}/postgres`;
    const wrongDb = `postgresql://postgres@127.0.0.1:${wrongPort}/${ROUTE_DB}`;
    const wrongReady = wrongUp ? await waitFor(async () => ((await adminQuery(wrongAdmin, 'SELECT 1')).rowCount === 1 ? true : null), 60_000, 1000) : null;
    if (!wrongReady) {
      record('маршрут восстановления: второй кластер', null, wrong.out.trim().slice(0, 200));
    } else {
      await adminQuery(wrongAdmin, `CREATE DATABASE ${ROUTE_DB}`);
      await adminQuery(wrongDb, 'CREATE TABLE route_control (id int)');
      const tablesOf = async (): Promise<number> => Number((await adminQuery(wrongDb, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n);
      const before = await tablesOf();
      const routeRoot = mkdtempSync(join(tmpdir(), 'kontur-reh-route-'));
      r = await exec(process.execPath, ['scripts/ops/restore-check.ts', '--db', ROUTE_DB], {
        env: { ...restoreEnv, PG_DOCKER_CONTAINER: WRONG_CONTAINER, RESTORE_STORAGE_ROOT: routeRoot },
        timeoutMs: 300_000,
      });
      const after = await tablesOf();
      const created = (await adminQuery(restoreAdmin, 'SELECT 1 FROM pg_database WHERE datname = $1', [ROUTE_DB])).rowCount ?? 0;
      const refused = r.out.split('\n').find((l) => l.includes('тот же кластер')) ?? '';
      record(
        'маршрут восстановления: инструмент смотрит в другой кластер — отказ до записи',
        r.code === 1 && /FAIL/u.test(refused) && after === before && created === 0,
        `код ${r.code}; таблиц на неправильной стороне ${before} → ${after}; база на правильной стороне ${created ? 'создана' : 'не создана'}; ${refused.replace(/^\s*FAIL\s+/u, '').slice(0, 220)}`,
      );
      rmSync(routeRoot, { recursive: true, force: true });

      // Маршрут копии (R17-03, R17-05): BACKUP_DATABASE_URL — база репетиции в рабочем кластере, инструмент — контейнер
      // второго кластера, где есть та же роль и одноимённая база. Отказ — до снимка и pg_dump: с psql — по
      // идентификатору кластера, без psql — потому что сверить нечем (совпавшее имя снимка pg_dump чужого кластера
      // принял бы и снял свою базу).
      await adminQuery(wrongAdmin, 'CREATE ROLE kontur_backup LOGIN').catch(() => undefined);
      await adminQuery(wrongAdmin, `CREATE DATABASE ${DB}`);
      const backupProbe = async (label: string, expected: RegExp): Promise<void> => {
        const probeRoot = mkdtempSync(join(tmpdir(), 'kontur-reh-backup-route-'));
        const rr = await exec(process.execPath, ['scripts/ops/backup.ts'], { env: { ...env, PG_DOCKER_CONTAINER: WRONG_CONTAINER, PG_BIN_DIR: '', BACKUP_ROOT: probeRoot } });
        const dirs = readdirSync(probeRoot);
        const last = rr.out.trim().split('\n').at(-1) ?? '';
        record(`маршрут копии: ${label} — отказ до pg_dump`, rr.code === 1 && expected.test(rr.out) && dirs.length === 0, `код ${rr.code}; каталогов копии ${dirs.length}; ${last.slice(0, 220)}`);
        rmSync(probeRoot, { recursive: true, force: true });
      };
      await backupProbe('инструмент другого кластера (psql есть)', /другому кластеру/u);
      const hide = await exec('docker', ['exec', WRONG_CONTAINER, 'sh', '-c', 'mv /usr/bin/psql /usr/bin/psql.hidden && mv /usr/lib/postgresql/18/bin/psql /usr/lib/postgresql/18/bin/psql.hidden']);
      if (hide.code !== 0) record('маршрут копии: инструмент без psql', null, `psql во втором контейнере не скрыт: ${hide.out.trim().slice(0, 160)}`);
      else await backupProbe('инструмент без psql', /нет psql/u);
    }

    r = await exec(process.execPath, ['scripts/ops/restore-check.ts', '--db', 'kontur_restore_rehearsal', '--login', 'demo.eng1', '--password-stdin', '--vectors-timeout', '300'], {
      env: restoreEnv,
      input: PASSWORD,
      timeoutMs: 900_000,
    });
    for (const l of r.out.trim().split('\n')) lines.push(`    ${l}`);
    record('ops:restore-check на чистом кластере', r.code === 0, `код ${r.code}`);

    // Перезапуск PostgreSQL под работающими процессами: процессы на копии не падают, /ready возвращается.
    const copyPort = await freePort();
    const copyBase = `http://127.0.0.1:${copyPort}`;
    const copyEnv: NodeJS.ProcessEnv = {
      ...env,
      DATABASE_URL: dbUrl(restoreAdmin, 'kontur_app', 'kontur_restore_rehearsal'),
      STORAGE_ROOT: restoreRoot,
      HTTP_PORT: String(copyPort),
      ALLOWED_ORIGINS: copyBase,
      WORKER_MODE: 'restore_check',
    };
    const cw = startNode('worker-copy', 'apps/worker/src/main.ts', { cwd: ROOT, env: copyEnv });
    const cs = startNode('server-copy', 'apps/server/src/main.ts', { cwd: ROOT, env: copyEnv });
    procs.push(cw, cs);
    const copyReady = await waitReady(copyBase, 60_000);
    const restart = await exec('docker', ['restart', CONTAINER], { timeoutMs: 120_000 });
    await sleep(3000);
    const back = await waitReady(copyBase, 90_000);
    record(
      'перезапуск PostgreSQL: server и worker не упали, /ready снова 200',
      copyReady.ok && restart.code === 0 && back.ok && cw.child.exitCode === null && cs.child.exitCode === null,
      `коды процессов: ${cw.child.exitCode ?? 'работает'}, ${cs.child.exitCode ?? 'работает'}`,
    );
    const ec = await Promise.all([stopNode(cs, 30_000), stopNode(cw, 30_000)]);
    record('штатная остановка процессов на копии', ec.every((c) => c === 0), `коды ${ec.join(', ')}`);
    const leaked = [...procs.map((p) => p.output())].join('\n');
    record('журналы процессов без пароля', !leaked.includes(PASSWORD));
  } finally {
    for (const p of procs) await stopNode(p, 15_000).catch(() => undefined);
    if (containerUp) await exec('docker', ['stop', CONTAINER], { timeoutMs: 120_000 });
    if (wrongUp) await exec('docker', ['stop', WRONG_CONTAINER], { timeoutMs: 120_000 });
    await adminQuery(ADMIN, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    for (const dir of [storage, backupRoot, restoreRoot, oldTree]) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
};

main()
  .catch((err: unknown) => {
    record('репетиция прервана', false, err instanceof Error ? err.message : 'unknown');
  })
  .finally(() => {
    const summary = `Итог: ${failed ? 'FAIL' : notRun ? 'NOT_RUN' : 'PASS'}`;
    lines.push(summary);
    console.log(summary);
    const dir = join(ROOT, 'artifacts', 'stage-17');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ops-rehearsal.log'), `${lines.join('\n')}\n`);
    process.exitCode = failed ? 1 : notRun ? 3 : 0;
  });
