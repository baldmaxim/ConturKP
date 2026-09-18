// Сквозная проверка чистого старта на реальных процессах (этап 02):
// setup БД → migrate → bootstrap → демо-данные → server + worker → /ready → вход → перезапуск server.
// База kontur_kp_smoke_test создаётся заново и удаляется в конце. Пароль генерируется и не выводится.
// Результат: artifacts/stage-02/smoke.log; код 0 только если все шаги PASS.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  const worker = startProc('worker', 'apps/worker/src/main.ts');
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

  await stopProc(server);
  server = startProc('server', 'apps/server/src/main.ts');
  ready = await waitReady(30_000);
  record('перезапуск server — /ready 200', ready.ok);
  const me = await fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookieHeader() } });
  record('перезапуск server — сессия действительна', me.status === 200);

  await stopProc(server);
  await stopProc(worker);
  const logs = `${server.output()}${worker.output()}`;
  record('журналы процессов без секретов', !logs.includes(PASSWORD) && !logs.includes(SECRET_MARKER));
} catch (err) {
  record('исключение сценария', false, err instanceof Error ? err.message : String(err));
} finally {
  for (const c of children) if (c.exitCode === null) c.kill();
  runNode(['-e', `const pg=require('pg');const c=new pg.Client({connectionString:${JSON.stringify(ADMIN)}});c.connect().then(()=>c.query('DROP DATABASE IF EXISTS ${DB} WITH (FORCE)')).then(()=>c.end())`]);
}

const dir = join(ROOT, 'artifacts', 'stage-02');
mkdirSync(dir, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
writeFileSync(
  join(dir, 'smoke.log'),
  `# npm run smoke — ${new Date().toISOString()}\n# Node ${process.version}, PostgreSQL ${ADMIN.replace(/\/\/[^@]*@/, '//***@')}\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
