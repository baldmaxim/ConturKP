// Этап 08a: проверка интерфейса диалогов и ответного ядра в headless Chromium (CDP) против настоящих процессов
// server + worker (генеративная модель — поддельный провайдер MODEL_PROVIDER=fake: живой модели на машине разработки
// нет, качество ответа не проверяется — Q-11). Проверяется: вкладка «Вопросы» — пустое состояние, создание диалога;
// пока worker остановлен, ход виден только состоянием «Вопрос в очереди» без текста (черновик не показывается и не
// стримится); после запуска worker ответ появляется опросом — бейдж «Подтверждено цитатами», номер цитаты, текст
// цитаты и ссылка на неё; вопрос без оснований — не «подтверждено»; на 390/360 px — диалог вместо списка, кнопка
// «К списку», без горизонтальной прокрутки; 1280 px — две колонки, тёмная тема; инженер не видит чужой диалог;
// нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-08a/ui-check.mjs → artifacts/stage-08a/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана ключевых состояний для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { standardTender, startFakeTenderHub, TH, TH_KEY } from '../../scripts/tenderhub-fake.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui08a_test';
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
const hub = await startFakeTenderHub({ apiKey: TH_KEY });
hub.tenders.set(TH.tender, standardTender());
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui08a-')),
  MODEL_PROVIDER: 'fake',
  MODEL_REVISION: 'fake-heuristic-v1',
  TENDERHUB_URL: hub.url,
  TENDERHUB_API_KEY: TH_KEY,
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
const SHOTS = process.env.UI_SHOTS ?? null;
const shot = async (name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
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
const fillLabeled = (label, value) =>
  evaluate(`(() => { const l = [...document.querySelectorAll('label')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(label)}));
    const el = l && document.getElementById(l.htmlFor); if (!el) return false;
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true; })()`);
const fill = (selector, value) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clickButton = (label) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.click(); return true; })()`);
const clickLink = (label) =>
  evaluate(`(() => { const a = [...document.querySelectorAll('a')].find((x) => x.innerText.trim() === ${JSON.stringify(label)});
    if (!a) return false; a.click(); return true; })()`);
const checkLabel = (label, checked) =>
  evaluate(`(() => { const l = [...document.querySelectorAll('label')].find((x) => x.innerText.trim() === ${JSON.stringify(label)});
    const input = l?.querySelector('input'); if (!input) return false; if (input.checked !== ${checked}) input.click(); return true; })()`);
// Файл выбирается штатным <input type=file> через CDP: тот же путь, что у пользователя.
const pickFile = async (path) => {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  if (!node.result?.nodeId) return false;
  await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [path] });
  return true;
};
const api = (path, init = {}) =>
  evaluate(`(async () => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('kkp_csrf=')) ?? '').slice(9));
    const init = ${JSON.stringify(init)};
    const headers = { 'X-CSRF-Token': csrf, ...(init.headers ?? {}) };
    const r = await fetch('/api/v1' + ${JSON.stringify(path)}, { method: init.method ?? 'GET', headers, body: init.body });
    const t = await r.text();
    return { status: r.status, etag: r.headers.get('etag'), body: t ? JSON.parse(t) : null };
  })()`);
const key = () => `ui08a-${randomBytes(6).toString('hex')}`;
const noHorizontalScroll = () => evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth');
const buttonsFit = () =>
  evaluate(`[...document.querySelectorAll('main button')].filter((b) => b.offsetParent !== null)
    .every((b) => b.scrollWidth <= b.clientWidth + 1 && [...b.querySelectorAll('svg')].every((i) => i.getBoundingClientRect().width > 0))`);
const login = async (user) => {
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(`document.querySelector('input[name=username]')`);
  await fill('input[name=username]', user);
  await fill('input[name=password]', PASSWORD);
  await evaluate(`document.querySelector('form button[type=submit]').click(), true`);
  return waitFor(text('DEMO-001'));
};
const logout = () => api('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });


const json = { 'Content-Type': 'application/json' };
const fillField = (label, value) =>
  evaluate(`(() => { const l = [...document.querySelectorAll('label')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(label)}));
    const el = l && (document.getElementById(l.htmlFor) ?? l.querySelector('input, textarea, select')); if (!el) return false;
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true; })()`);
// Загрузка байтов в этап из страницы: тот же путь импорта, что у кнопки загрузки.
const uploadBytes = (stageId, name, bytes) =>
  evaluate(`(async () => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('kkp_csrf=')) ?? '').slice(9));
    const body = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), (c) => c.charCodeAt(0));
    const r = await fetch('/api/v1/stages/${stageId}/imports?name=' + encodeURIComponent(${JSON.stringify(name)}), {
      method: 'POST', headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream', 'Idempotency-Key': ${JSON.stringify(key())} }, body });
    return { status: r.status, body: await r.json() };
  })()`);
const registered = async (batchId) =>
  poll(async () => {
    const b = (await api(`/imports/${batchId}`)).body;
    return b?.status === 'completed' ? b.items[0].documentRevisionId : null;
  }, 30_000);
const runOf = (revisionId) =>
  poll(async () => {
    const r = (await api(`/document-revisions/${revisionId}/recognition-runs`)).body.items?.[0];
    return r && ['complete', 'partial', 'failed'].includes(r.status) ? r : null;
  }, 60_000);


const CSV = Buffer.from(
  'Раздел;Текст\nФасад;Фасад должен быть облицован клинкерным кирпичом.\nКровля;Гарантийный срок кровли составляет 5 лет.\nПрочее;Пояснительная записка к проекту.\n',
  'utf8',
);
const count = (s) => evaluate(`(document.body?.innerText ?? '').split(${JSON.stringify(s)}).length - 1`);
const visible = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && el.offsetParent !== null); })()`);

let browser;
let worker;
try {
  dropDb();
  if (runNode(['scripts/db-setup.ts']) !== 0 || runNode(['scripts/db-migrate.ts']) !== 0 || runNode(['scripts/seed-demo.ts', '--password-stdin'], PASSWORD) !== 0) {
    throw new Error('подготовка БД не удалась');
  }
  worker = start('apps/worker/src/main.ts');
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
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'kontur-chrome-'))}`,
      'about:blank',
    ],
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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/\b(401|403|404|409|412)\b/.test(m.params.entry.text)) {
      problems.push(`${m.params.entry.source}: ${m.params.entry.text.slice(0, 200)}`);
    }
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  record('вход администратора-руководителя', await login('demo.admin'));
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const me = (await api('/me')).body;
  const card = await api(`/tenders/${demo.id}`);
  await api(`/tenders/${demo.id}/members/${me.id}`, { method: 'PUT', headers: { ...json, 'If-Match': card.etag }, body: JSON.stringify({ memberRole: 'manager' }) });
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;

  // ---- Документ ТЗ (CSV) → локальное распознавание → замороженный набор → индекс поиска
  const up = await uploadBytes(stageId, 'тз-кровля.csv', CSV);
  const rev = await registered(up.body.id);
  record('документ ТЗ загружен штатным импортом', Boolean(rev));
  await api(`/document-revisions/${rev}/local-recognitions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const run = await runOf(rev);
  record('локальное распознавание CSV завершено', run?.status === 'complete', run?.status ?? 'нет прогона');
  const draft = await api(`/stages/${stageId}/source-set-revisions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const put = await api(`/source-set-revisions/${draft.body.id}/items`, { method: 'PUT', headers: { ...json, 'If-Match': draft.etag }, body: JSON.stringify({ items: [{ documentRevisionId: rev, inclusion: 'included' }] }) });
  await api(`/source-set-revisions/${draft.body.id}/freeze`, { method: 'POST', headers: { ...json, 'If-Match': put.etag, 'Idempotency-Key': key() }, body: '{}' });
  const indexed = await poll(async () => {
    const r = await api('/search', { method: 'POST', headers: json, body: JSON.stringify({ context: { kind: 'tender', tenderId: demo.id, mode: 'working', stageId }, query: 'гарантийный срок', limit: 5 }) });
    return r.status === 200 && r.body.scope?.unitsNotIndexed === 0 ? r : null;
  }, 60_000);
  record('рабочий состав проиндексирован для поиска', Boolean(indexed));

  // ---- 390 px: пустое состояние, создание диалога
  const tabUrl = `${BASE}/stages/${stageId}?tab=answers`;
  await send('Page.navigate', { url: tabUrl });
  record('вкладка «Вопросы»: диалогов нет — пустое состояние и пояснение о характере ответа', await waitFor(`${text('Диалогов пока нет')} && ${text('Это не регламентная проверка')}`));
  record('нет горизонтальной прокрутки на 390 px (пустой список)', await noHorizontalScroll());
  await shot('390-empty');
  await clickButton('Новый диалог');
  record('диалог создан; на 390 px он заменяет список, есть «К списку»', await waitFor(`${text('Вопросы к документам')} && ${text('Задайте вопрос по документам области')}`) && (await visible('[aria-label="Мои диалоги этапа"]')) === false);

  // ---- Worker остановлен: ход виден только состоянием, без текста
  worker.kill();
  await new Promise((r) => (worker.exitCode !== null ? r() : worker.once('exit', r)));
  await fillField('Вопрос', 'Какой гарантийный срок кровли?');
  await clickButton('Спросить');
  record(
    'пока worker остановлен — «Вопрос в очереди» без текста ответа; повторный вопрос недоступен',
    (await waitFor(`${text('Вопрос в очереди')} && ${text('Черновик модели не показывается')}`)) &&
      !(await evaluate(text('5 лет'))) &&
      (await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Спросить')?.disabled === true`)),
  );
  await shot('390-queued');
  worker = start('apps/worker/src/main.ts');
  record(
    'worker запущен — ответ появился опросом: «Подтверждено цитатами», [1], цитата и ссылка',
    await waitFor(`${text('Подтверждено цитатами')} && ${text('[1]')} && ${text('Гарантийный срок кровли составляет 5 лет')} && ${text('Открыть цитату')}`, 60_000),
  );
  record('нет горизонтальной прокрутки на 390 px (ответ с цитатой)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('390-answer');

  // ---- Вопрос без оснований
  await fillField('Вопрос', 'Какая марка бетона фундамента?');
  await clickButton('Спросить');
  record(
    'вопрос без оснований — «Не найдено в области» или «Неполная обработка», а не «подтверждено»',
    (await waitFor(`${text('Не найдено в области')} || ${text('Неполная обработка')}`, 60_000)) && (await count('Подтверждено цитатами')) === 1,
  );

  // ---- 360 px: «К списку» возвращает список
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  record('нет горизонтальной прокрутки на 360 px (диалог)', await noHorizontalScroll());
  await shot('360-dialog');
  await clickButton('К списку');
  record('«К списку» — список диалогов с созданным диалогом', await waitFor(`${text('Мои диалоги')} || document.querySelector('[aria-label="Мои диалоги этапа"] button')`) && (await count('Вопросы к документам')) >= 1);
  record('нет горизонтальной прокрутки на 360 px (список)', await noHorizontalScroll());

  // ---- 1280 px, тёмная тема: две колонки
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[aria-label="Мои диалоги этапа"] button')?.click(), true`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record(
    'тёмная тема, 1280 px: список и диалог рядом, «К списку» скрыта',
    (await waitFor(text('Гарантийный срок кровли составляет 5 лет'))) &&
      (await visible('[aria-label="Мои диалоги этапа"]')) &&
      !(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'К списку' && b.offsetParent !== null)`)),
  );
  if (SHOTS) await sleep(500);
  await shot('1280-dark-dialog');

  // ---- Инженер: чужой диалог не виден
  await logout();
  record('вход инженера тендера', await login('demo.eng1'));
  await send('Page.navigate', { url: tabUrl });
  record('инженер не видит диалог руководителя — у него пустой список', await waitFor(text('Диалогов пока нет')));

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
  await hub.close();
  await sleep(500);
  dropDb();
}

const out = join(ROOT, 'artifacts', 'stage-08a');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker, MODEL_PROVIDER=fake\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
