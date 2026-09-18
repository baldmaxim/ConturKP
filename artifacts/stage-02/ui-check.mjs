// Проверка интерфейса в headless Microsoft Edge против настоящих процессов server + worker (не mock).
// Требует: npm run build, запущенный кластер (npm run pg:start), Edge по пути EDGE_PATH или по умолчанию.
// Запуск: node artifacts/stage-02/ui-check.mjs → artifacts/stage-02/ui-check.log; код 0 только при всех PASS.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui_test';
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const url = (user) => {
  const u = new URL(ADMIN);
  u.username = user;
  u.password = '';
  u.pathname = `/${DB}`;
  return u.toString();
};
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui-')),
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
};

const lines = [];
let failed = false;
const record = (step, ok, note = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`;
  lines.push(line);
  console.log(line);
  if (!ok) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runNode = (args, input) => spawnSync(process.execPath, args, { cwd: ROOT, env, input, encoding: 'utf8' }).status;
const dropDb = () =>
  runNode(['-e', `const pg=require('pg');const c=new pg.Client({connectionString:${JSON.stringify(ADMIN)}});c.connect().then(()=>c.query('DROP DATABASE IF EXISTS ${DB} WITH (FORCE)')).then(()=>c.end())`]);

const procs = [];
const start = (script) => {
  const p = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: 'ignore' });
  procs.push(p);
  return p;
};

const problems = [];
let ws;
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res) => {
    seq += 1;
    pending.set(seq, res);
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result?.result?.value;
};
const waitFor = async (expression, timeoutMs = 10_000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evaluate(`Boolean(${expression})`)) return true;
    await sleep(200);
  }
  return false;
};
const text = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
// Ввод значения в управляемое поле React: нативный setter + событие input.
const fill = (selector, value) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clickButton = (label) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.click(); return true; })()`);

let edge;
try {
  dropDb();
  if (runNode(['scripts/db-setup.ts']) !== 0 || runNode(['scripts/db-migrate.ts']) !== 0 || runNode(['scripts/seed-demo.ts', '--password-stdin'], PASSWORD) !== 0) {
    throw new Error('подготовка БД не удалась');
  }
  start('apps/worker/src/main.ts');
  start('apps/server/src/main.ts');
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      ready = (await fetch(`${BASE}/api/v1/ready`)).status === 200;
    } catch {
      // ещё не слушает
    }
    if (!ready) await sleep(500);
  }
  record('server + worker готовы', ready);

  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'kontur-edge-'))}`, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 50 && !targets; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    } catch {
      await sleep(200);
    }
  }
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`исключение: ${m.params.exceptionDetails.text}`);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/\b(401|404|412)\b/.test(m.params.entry.text)) {
      problems.push(`${m.params.entry.source}: ${m.params.entry.text.slice(0, 200)}`);
    }
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  await send('Page.navigate', { url: `${BASE}/` });
  record('без входа открывается форма входа', await waitFor(`document.querySelector('input[name=username]')`));
  await fill('input[name=username]', 'demo.eng1');
  await fill('input[name=password]', PASSWORD);
  await evaluate(`document.querySelector('form button[type=submit]').click(), true`);
  record('вход инженера через форму — список тендеров', await waitFor(text('DEMO-001')), '390 px');
  record('чужой тендер DEMO-002 не показан', !(await evaluate(text('DEMO-002'))));
  record(
    'тема и theme-color выставлены до отрисовки',
    await evaluate(`['light','dark'].includes(document.documentElement.dataset.theme) && Boolean(document.querySelector('meta[name=theme-color]')?.content)`),
  );
  record('нет горизонтальной прокрутки на 390 px', await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
  const createVisible = await evaluate(text('Создать тендер'));
  record('инженеру не показана кнопка «Создать тендер»', !createVisible);

  const stageId = await evaluate(`(async () => {
    const t = await (await fetch('/api/v1/tenders')).json();
    const demo = t.items.find((x) => x.code === 'DEMO-001');
    const s = await (await fetch('/api/v1/tenders/' + demo.id + '/stages')).json();
    return s.items[0].id; })()`);
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}` });
  await waitFor(text('Параметры этапа'));
  await clickButton('Изменить');
  await waitFor(`document.querySelector('form input')`);
  await fill('form input', 'Первичное КП (правка из интерфейса)');
  await clickButton('Сохранить');
  const saved = await waitFor(text('Первичное КП (правка из интерфейса)') + ` && !document.querySelector('form input')`);
  const apiTitle = await evaluate(`fetch('/api/v1/stages/${stageId}').then((r) => r.json()).then((s) => s.title)`);
  record('правка этапа сохраняется на сервере', saved && apiTitle === 'Первичное КП (правка из интерфейса)');

  await clickButton('Изменить');
  await waitFor(`document.querySelector('form input')`);
  // Параллельная правка «другого пользователя» прямо через API с актуальной версией.
  const bumped = await evaluate(`(async () => {
    const r = await fetch('/api/v1/stages/${stageId}');
    const csrf = document.cookie.split('; ').find((c) => c.startsWith('kkp_csrf=')).slice(9);
    const p = await fetch('/api/v1/stages/${stageId}', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': r.headers.get('ETag'), 'X-CSRF-Token': decodeURIComponent(csrf) }, body: JSON.stringify({ title: 'Правка другого инженера' }) });
    return p.status; })()`);
  await fill('form input', 'Моя устаревшая правка');
  await clickButton('Сохранить');
  const dialog = await waitFor(text('Этап изменён другим пользователем'));
  const kept = await evaluate(`fetch('/api/v1/stages/${stageId}').then((r) => r.json()).then((s) => s.title)`);
  record('412 → диалог конфликта, правка другого не перезаписана', bumped === 200 && dialog && kept === 'Правка другого инженера');

  const sw = await evaluate(`navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then((r) => Boolean(r)) : false`);
  record('service worker зарегистрирован (127.0.0.1 — защищённый контекст)', sw === true);

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(text('DEMO-001'));
  record('нет горизонтальной прокрутки на 360 px', await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));

  record('нет ошибок консоли и нарушений CSP', problems.length === 0, problems.join(' | '));
} catch (err) {
  record('исключение сценария', false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    ws?.close();
  } catch {
    // уже закрыт
  }
  edge?.kill();
  for (const p of procs) p.kill();
  await sleep(500);
  dropDb();
}

const out = join(ROOT, 'artifacts', 'stage-02');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
writeFileSync(join(out, 'ui-check.log'), `# ui-check — ${new Date().toISOString()}, Microsoft Edge headless, реальные server + worker\n${lines.join('\n')}\n${summary}\n`);
console.log(summary);
process.exit(failed ? 1 : 0);
