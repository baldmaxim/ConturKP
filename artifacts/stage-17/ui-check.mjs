// Этап 17: вкладка «Состояние» страницы администратора — headless Chromium (CDP) против настоящих server + worker
// (проект §11). Данные ПОДДЕЛЬНЫЕ: демонстрационные тендеры, поддельные модель и эмбеддинги; копия снимается настоящей
// командой ops:backup перед запуском. Проверяется: сводка (схема, worker, очередь, место, копия), карточки установки,
// хранилища и копии, таблицы очереди и интеграций; 360/390/430 px без горизонтальной прокрутки; 1280 px, тёмная тема;
// инженер вкладку не видит и маршрут ему закрыт; нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), pg_dump той же версии, Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-17/ui-check.mjs → artifacts/stage-17/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui17_test';
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
  BACKUP_DATABASE_URL: url('kontur_backup'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui17-')),
  BACKUP_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui17-backup-')),
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
  MODEL_PROVIDER: 'fake',
  EMBEDDING_PROVIDER: 'fake',
  EMBEDDING_DIM: '16',
  // Порог предупреждения выше любого диска: сводка показывает «Мало места» (запись не останавливается).
  STORAGE_WARN_FREE_MB: '999999999',
  STORAGE_STOP_FREE_MB: '1',
};

const lines = [];
let failed = false;
const record = (step, ok, note = '') => {
  const out = `${ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`;
  lines.push(out);
  console.log(out);
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
const SHOTS = process.env.UI_SHOTS ?? null;
const shot = async (name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // Снимок — после завершения переходов (Review 16-1: кадр диалога принятия был снят в начале анимации).
  for (let i = 0; i < 20; i += 1) {
    const idle = await send('Runtime.evaluate', { expression: "document.getAnimations().every((a) => a.playState !== 'running')", returnByValue: true });
    if (idle.result?.result?.value === true) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result?.data) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (expression, timeoutMs = 15_000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evaluate(`Boolean(${expression})`).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};
const poll = async (fn, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  return null;
};
const text = (s) => `(document.body?.innerText ?? '').includes(${JSON.stringify(s)})`;
// Какие из ожидаемых подписей на странице не найдены — в пояснение провала.
const lacks = async (...parts) => {
  const out = [];
  for (const p of parts) if (!(await evaluate(text(p)).catch(() => false))) out.push(p);
  return out.length ? `нет: ${out.join(' | ')}` : '';
};
const fill = (selector, value) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
// Текст в поле открытого диалога (причина, комментарий).
const fillDialogText = (value) =>
  evaluate(`(() => { const d = document.querySelector('dialog[open]'); const el = d?.querySelector('textarea'); if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clickButton = (label, scope = 'document') =>
  evaluate(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.click(); return true; })()`);
const clickInDialog = (label) => clickButton(label, `(document.querySelector('dialog[open]') ?? document)`);
const api = (path, init = {}) =>
  evaluate(`(async () => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('kkp_csrf=')) ?? '').slice(9));
    const init = ${JSON.stringify(init)};
    const headers = { 'X-CSRF-Token': csrf, ...(init.headers ?? {}) };
    const r = await fetch('/api/v1' + ${JSON.stringify(path)}, { method: init.method ?? 'GET', headers, body: init.body });
    const t = await r.text();
    return { status: r.status, etag: r.headers.get('etag'), body: t ? JSON.parse(t) : null };
  })()`);
const key = () => `ui17-${randomBytes(6).toString('hex')}`;
const json = { 'Content-Type': 'application/json' };
const post = (path, body, headers = {}) => api(path, { method: 'POST', headers: { ...json, 'Idempotency-Key': key(), ...headers }, body: JSON.stringify(body) });
const noHorizontalScroll = () => evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth');
// Элементы, выходящие за правый край страницы, — в пояснение провала проверки ширины.
const overflowers = () =>
  evaluate(`(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > w + 1).slice(0, 4)
    .map((el) => el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40) + ' «' + (el.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 40) + '»').join(' | '); })()`);
const dialogFits = () =>
  evaluate(`(() => { const d = document.querySelector('dialog[open]'); if (!d) return false; const r = d.getBoundingClientRect();
    return r.left >= -1 && r.right <= window.innerWidth + 1 && [...d.querySelectorAll('*')].every((el) => el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflowX !== 'visible'); })()`);
const login = async (user) => {
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(`document.querySelector('input[name=username]')`);
  await fill('input[name=username]', user);
  await fill('input[name=password]', PASSWORD);
  await evaluate(`document.querySelector('form button[type=submit]').click(), true`);
  return waitFor(`!document.querySelector('input[name=password]')`);
};
const logout = () => api('/auth/logout', { method: 'POST', headers: json, body: '{}' });

const viewport = (width) => send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true });

let browser;
try {
  dropDb();
  if (runNode(['scripts/db-setup.ts']) !== 0 || runNode(['scripts/db-migrate.ts']) !== 0 || runNode(['scripts/seed-demo.ts', '--password-stdin'], PASSWORD) !== 0) {
    throw new Error('подготовка БД не удалась');
  }
  record('копия перед запуском: npm run ops:backup', runNode(['scripts/ops/backup.ts']) === 0);
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

  browser = spawn(
    BROWSER,
    ['--headless=new', '--disable-gpu', '--no-first-run', ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'kontur-ui17-chrome-'))}`, 'about:blank'],
    { stdio: 'ignore' },
  );
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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/\b(401|403|404|409|412)\b/.test(m.params.entry.text)) problems.push(`${m.params.entry.source}: ${m.params.entry.text.slice(0, 200)}`);
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('DOM.enable');

  // ---- Смартфон 390 px: администратор
  await viewport(390);
  record('вход администратора', await login('demo.admin'));
  await send('Page.navigate', { url: `${BASE}/admin?tab=operations` });
  const loaded = await waitFor(`${text('Установка')} && ${text('Интеграции')} && ${text('Очередь заданий')}`, 20_000);
  record('вкладка «Состояние»: карточки установки, хранилища, копии, очереди, интеграций', loaded, await lacks('Установка', 'Хранилище', 'Резервная копия', 'Очередь заданий', 'Интеграции'));
  record('сводка: схема 43, worker работает, мало места — предупреждение, копия свежая', await waitFor(`${text('Схема БД 43')} && ${text('Worker работает')} && ${text('Мало места')} && ${text('Копия свежая')}`, 20_000), await lacks('Схема БД 43', 'Worker работает', 'Мало места', 'Копия свежая'));
  record('копия: дата, состав и каталог из манифеста', await waitFor(`${text('Последняя')} && ${text('схема 43, дамп')}`), await lacks('Последняя', 'схема 43, дамп'));
  record('интеграции: статусы называют уровень проверки — модель только на поддельных данных', await waitFor(`${text('model / ModelGateway')} && ${text('Только на поддельных данных')}`), await lacks('model / ModelGateway', 'Только на поддельных данных'));
  await shot('390-operations');
  for (const w of [360, 390, 430]) {
    await viewport(w);
    await sleep(300);
    record(`${w} px: без горизонтальной прокрутки`, (await noHorizontalScroll()) === true, await overflowers());
  }
  await viewport(360);
  await shot('360-operations');

  // ---- 1280 px, тёмная тема
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/admin?tab=operations` });
  await waitFor(text('Интеграции'), 20_000);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  await sleep(300);
  record('тёмная тема, 1280 px: страница не шире экрана, сводка читается', (await noHorizontalScroll()) === true && (await waitFor(text('Worker работает'))), await overflowers());
  await shot('1280-dark-operations');
  await evaluate(`document.documentElement.removeAttribute('data-theme'), true`);
  const refresh = await clickButton('Обновить');
  record('кнопка «Обновить» перечитывает состояние', refresh && (await waitFor(text('Установка'))));

  // ---- Инженер: вкладки нет, маршрут закрыт
  await logout();
  record('вход инженера', await login('demo.eng1'));
  const eng = await api('/admin/operations');
  record('инженеру состояние установки закрыто сервером (403)', eng.status === 403, `status ${eng.status}`);
  const statuses = await api('/integrations/status');
  record('статусы интеграций инженеру доступны без адресов и ключей', statuses.status === 200 && Array.isArray(statuses.body?.items) && !/https?:\/\/|postgres/u.test(JSON.stringify(statuses.body)), `status ${statuses.status}`);
  await send('Page.navigate', { url: `${BASE}/admin?tab=operations` });
  await waitFor(`${text('Нет доступа')} || ${text('Администрирование')}`, 10_000);
  record('инженер не видит вкладку «Состояние»', !(await evaluate(text('Резервная копия'))), '');
  record('нет ошибок консоли и нарушений CSP', problems.length === 0, problems.join(' | '));
} catch (err) {
  record('исключение сценария', false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    ws?.close();
  } catch {
    // уже закрыт
  }
  browser?.kill();
  for (const p of procs) p.kill();
  await sleep(500);
  dropDb();
}

const out = join(ROOT, 'artifacts', 'stage-17');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker; данные ПОДДЕЛЬНЫЕ: демонстрационные тендеры, поддельные модель и эмбеддинги; копия — настоящей командой ops:backup\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
