// Сквозная проверка чистого старта на реальных процессах (этап 02):
// setup БД → migrate → bootstrap → демо-данные → server + worker → /ready → вход → перезапуск server.
// База kontur_kp_smoke_test создаётся заново и удаляется в конце. Пароль генерируется и не выводится.
// Результат: artifacts/stage-02/smoke.log; код 0 только если все шаги PASS.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_smoke_test';
// Свободный порт выбирается системой: фиксированный порт может быть занят другим процессом.
const PORT = await new Promise((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const url = (user) => {
  const u = new URL(ADMIN);
  u.username = user;
  u.password = '';
  u.pathname = `/${DB}`;
  return u.toString();
};
const INTAKE_ROOT = mkdtempSync(join(tmpdir(), 'kontur-smoke-intake-'));
const SECRET_MARKER = `smoke-secret-${randomBytes(6).toString('hex')}`;
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-smoke-')),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
  TENDERHUB_API_KEY: SECRET_MARKER,
  INTAKE_ROOTS: INTAKE_ROOT,
  INTAKE_STABILITY_SECONDS: '1',
};

const lines = [];
let failed = false;
const record = (step, ok, note = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`;
  lines.push(line);
  console.log(line);
  if (!ok) failed = true;
};

const runNode = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, input, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const children = [];
const startProc = (name, script) => {
  const p = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  children.push(p);
  return { p, output: () => out, name };
};
const stopProc = (h) =>
  new Promise((res) => {
    if (h.p.exitCode !== null) return res();
    h.p.once('exit', () => res());
    h.p.kill();
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitReady = async (timeoutMs) => {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/v1/ready`);
      last = await r.json();
      if (r.status === 200) return { ok: true, body: last };
    } catch {
      // сервер ещё не слушает
    }
    await sleep(500);
  }
  return { ok: false, body: last };
};

const cookieJar = new Map();
const absorb = (res) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookieJar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
// Минимальный ZIP (метод stored) для проверки разбора архивов на реальных процессах.
const buildZip = (entries) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};

const cookieHeader = () => [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');

try {
  runNode(['-e', `const pg=require('pg');const c=new pg.Client({connectionString:${JSON.stringify(ADMIN)}});c.connect().then(()=>c.query('DROP DATABASE IF EXISTS ${DB} WITH (FORCE)')).then(()=>c.end())`]);

  let r = runNode(['scripts/db-setup.ts']);
  record('db:setup — роли и база', r.code === 0, r.out.trim().split('\n').at(-1));

  r = runNode(['scripts/db-migrate.ts']);
  record('db:migrate — пустая БД', r.code === 0 && /применена 0001/.test(r.out), r.out.trim().split('\n').at(-1));

  r = runNode(['scripts/db-migrate.ts']);
  record('db:migrate — повторный запуск без изменений', r.code === 0 && /применено миграций: 0/.test(r.out));

  r = runNode(['scripts/bootstrap.ts', '--login', 'smoke.owner', '--name', 'Проверка', '--password-stdin'], PASSWORD);
  record('bootstrap — первый администратор-руководитель', r.code === 0 && !r.out.includes(PASSWORD));

  r = runNode(['scripts/bootstrap.ts', '--login', 'smoke.second', '--name', 'Второй', '--password-stdin'], PASSWORD);
  record('bootstrap — повтор отклонён', r.code === 4);

  r = runNode(['scripts/seed-demo.ts', '--password-stdin'], PASSWORD);
  record('db:seed-demo — синтетические данные', r.code === 0 && !r.out.includes(PASSWORD), r.out.trim().split('\n').at(-1));

  r = runNode(['scripts/config-check.ts']);
  record('config:check — без значений секретов', r.code === 0 && !r.out.includes(SECRET_MARKER) && /TENDERHUB_API_KEY\s+задано/.test(r.out));

  let worker = startProc('worker', 'apps/worker/src/main.ts');
  let server = startProc('server', 'apps/server/src/main.ts');
  let ready = await waitReady(30_000);
  record('server + worker — /ready 200', ready.ok, JSON.stringify(ready.body?.checks ?? null));
  if (!ready.ok) console.log(server.output(), worker.output());

  const anon = await fetch(`${BASE}/api/v1/tenders`);
  record('неаутентифицированный запрос — 401', anon.status === 401);

  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ login: 'smoke.owner', password: PASSWORD }),
  });
  absorb(login);
  record('вход администратора', login.status === 200, `HTTP ${login.status}`);

  const tenders = await fetch(`${BASE}/api/v1/tenders`, { headers: { Cookie: cookieHeader() } });
  const tBody = await tenders.json();
  record('список тендеров (демо)', tenders.status === 200 && tBody.items.length === 2, `тендеров: ${tBody.items?.length}`);

  const webDist = join(ROOT, 'apps', 'web', 'dist', 'index.html');
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  record(
    'интерфейс раздаётся сервером с CSP',
    existsSync(webDist) && page.status === 200 && html.includes('<div id="root">') && /script-src 'self'/.test(page.headers.get('content-security-policy') ?? ''),
    existsSync(webDist) ? '' : 'нет сборки apps/web/dist — выполните npm run build',
  );

  // ---- Этап 03: источники на реальных процессах
  const csrf = decodeURIComponent(cookieJar.get('kkp_csrf') ?? '');
  const api = (path, init = {}) =>
    fetch(`${BASE}/api/v1${path}`, { ...init, headers: { Cookie: cookieHeader(), Origin: BASE, 'X-CSRF-Token': csrf, ...(init.headers ?? {}) } });
  const demo = tBody.items.find((t) => t.code === 'DEMO-001');
  // Администратор-владелец назначается руководителем демо-тендера, чтобы видеть его содержимое.
  const members = await api(`/tenders/${demo.id}/members`);
  const put = await api(`/tenders/${demo.id}/members/${(await (await api('/me')).json()).id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': members.headers.get('etag') },
    body: JSON.stringify({ memberRole: 'manager' }),
  });
  const stages = await (await api(`/tenders/${demo.id}/stages`)).json();
  const stageId = stages.items?.[0]?.id;
  record('назначение на демо-тендер', put.status === 200 && Boolean(stageId));
  const waitFor = async (fn, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = await fn();
      if (v) return v;
      await sleep(500);
    }
    return null;
  };
  const zip = buildZip([
    ['Проект/ТЗ.pdf', Buffer.from('%PDF-1.4\n% smoke tz\n%%EOF\n')],
    ['../evil.pdf', Buffer.from('%PDF-1.4\n%%EOF\n')],
  ]);
  const up = await api(`/stages/${stageId}/imports?name=${encodeURIComponent('комплект.zip')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': `smoke-${randomBytes(6).toString('hex')}` },
    body: zip,
  });
  const batch = await up.json();
  const done = await waitFor(async () => {
    const b = await (await api(`/imports/${batch.id}`)).json();
    return b.status !== 'running' ? b : null;
  }, 30_000);
  record(
    'загрузка архива обработана worker: ТЗ зарегистрирован, ../ отклонён',
    up.status === 202 && done?.status === 'completed_with_errors' && done.items.some((i) => i.memberPath === 'Проект/ТЗ.pdf' && i.status === 'registered') && done.items.some((i) => i.rejectReason === 'path_traversal'),
    done ? `статус ${done.status}` : 'нет результата',
  );

  // Worker остановлен: загрузка принимается, задание ждёт; после запуска worker обработка завершается.
  await stopProc(worker);
  const up2 = await api(`/stages/${stageId}/imports?name=${encodeURIComponent('после-остановки.pdf')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': `smoke-${randomBytes(6).toString('hex')}` },
    body: Buffer.from('%PDF-1.4\n% while worker is down\n%%EOF\n'),
  });
  const b2 = await up2.json();
  await sleep(1500);
  const still = await (await api(`/imports/${b2.id}`)).json();
  worker = startProc('worker', 'apps/worker/src/main.ts');
  const done2 = await waitFor(async () => {
    const b = await (await api(`/imports/${b2.id}`)).json();
    return b.status === 'completed' ? b : null;
  }, 30_000);
  record('worker остановлен → задание не потеряно, выполнено после запуска', still.status === 'running' && Boolean(done2));

  // Наблюдаемая папка: файл появляется, импортируется после стабильности.
  const folder = join(INTAKE_ROOT, 'demo');
  mkdirSync(folder);
  const ch = await api(`/tenders/${demo.id}/intake-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `smoke-${randomBytes(6).toString('hex')}` },
    body: JSON.stringify({ origin: 'smb', locator: folder, scanIntervalSeconds: 5 }),
  });
  const channel = await ch.json();
  writeFileSync(join(folder, 'Договор.pdf'), '%PDF-1.4\n% smoke contract\n%%EOF\n');
  const scanned = await waitFor(async () => {
    const list = await (await api(`/tenders/${demo.id}/intake-channels`)).json();
    const c = list.items.find((x) => x.id === channel.id);
    const docs = await (await api(`/stages/${stageId}/documents`)).json();
    return c?.current && docs.items.some((d) => d.title === 'Договор.pdf') ? c : null;
  }, 45_000);
  record('наблюдаемая папка: файл импортирован worker, канал актуален', ch.status === 201 && Boolean(scanned));

  await stopProc(server);
  server = startProc('server', 'apps/server/src/main.ts');
  ready = await waitReady(30_000);
  record('перезапуск server — /ready 200', ready.ok);
  const me = await fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookieHeader() } });
  record('перезапуск server — сессия действительна', me.status === 200);

  await stopProc(server);
  await stopProc(worker);
  const logs = `${server.output()}${worker.output()}`;
  rmSync(INTAKE_ROOT, { recursive: true, force: true });
  record('журналы процессов без секретов', !logs.includes(PASSWORD) && !logs.includes(SECRET_MARKER));
} catch (err) {
  record('исключение сценария', false, err instanceof Error ? err.message : String(err));
} finally {
  for (const c of children) if (c.exitCode === null) c.kill();
  runNode(['-e', `const pg=require('pg');const c=new pg.Client({connectionString:${JSON.stringify(ADMIN)}});c.connect().then(()=>c.query('DROP DATABASE IF EXISTS ${DB} WITH (FORCE)')).then(()=>c.end())`]);
}

// Каталог артефактов текущего этапа (SMOKE_STAGE), логи прежних этапов не перезаписываются.
const dir = join(ROOT, 'artifacts', process.env.SMOKE_STAGE ?? 'stage-03');
mkdirSync(dir, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
writeFileSync(
  join(dir, 'smoke.log'),
  `# npm run smoke — ${new Date().toISOString()}\n# Node ${process.version}, PostgreSQL ${ADMIN.replace(/\/\/[^@]*@/, '//***@')}\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
