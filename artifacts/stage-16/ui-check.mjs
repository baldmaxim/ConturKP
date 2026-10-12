// Этап 16: MCP портала в интерфейсе — headless Chromium (CDP) против настоящих server + worker (ADR-010; проект §11).
// Данные ПОДДЕЛЬНЫЕ: демонстрационный тендер, поддельный TenderHub и модель. Проверяется на смартфоне 390 px: диалог
// «Доступ для чат-клиентов» (выпуск токена, значение показано один раз, список, отзыв), точка /mcp с этим токеном
// (список инструментов, выбор дела, предложение вопроса — запросами JSON-RPC, как их шлёт чат-клиент), раздел этапа
// «Предложения из чата» (принять — создаётся черновик вопроса от имени человека; отклонить — с причиной), отзыв токена
// закрывает доступ. 360/390/430 px без горизонтальной прокрутки; 1280 px, тёмная тема; нет ошибок консоли и CSP.
// Это проверка портала и протокола, а не подключения Codex или Cursor: живая проверка клиентов — отдельно.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-16/ui-check.mjs → artifacts/stage-16/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeTenderHub, TH_KEY } from '../../scripts/tenderhub-fake.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui16_test';
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
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui16-')),
  TENDERHUB_INSTANCE_ID: 'th-ui-16',
  TENDERHUB_URL: hub.url,
  TENDERHUB_API_KEY: TH_KEY,
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
  // Модель — поддельный провайдер: проверка гипотез выполняется (D-029 В-09-5), живой модели на машине разработки нет.
  MODEL_PROVIDER: 'fake',
  // MCP-сервер портала включается настройкой (по умолчанию выключен).
  MCP_ENABLED: 'true',
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
const key = () => `ui16-${randomBytes(6).toString('hex')}`;
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
  return waitFor(text('DEMO-001'));
};
const logout = () => api('/auth/logout', { method: 'POST', headers: json, body: '{}' });

// Запрос к точке MCP так, как его шлёт чат-клиент: JSON-RPC по HTTP с токеном в заголовке.
const mcp = async (token, method, params, id = 1) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const raw = await r.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    const m = /^data: (.*)$/m.exec(raw);
    body = m ? JSON.parse(m[1]) : null;
  }
  return { status: r.status, body };
};
const tool = async (token, name, args = {}) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  const text0 = r.body?.result?.content?.[0]?.text;
  return { status: r.status, isError: r.body?.result?.isError === true, data: text0 ? JSON.parse(text0) : null };
};
const viewport = (width) => send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true });
const openTokens = async () => {
  await evaluate(`(() => { const b = document.querySelector('button[aria-label="Открыть меню"]'); b?.click(); return true; })()`);
  await sleep(200);
  const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.innerText.trim() === 'Доступ для чат-клиентов' || x.getAttribute('aria-label') === 'Доступ для чат-клиентов') && x.offsetParent !== null); if (!b) return false; b.click(); return true; })()`);
  return clicked && (await waitFor(`document.querySelector('dialog[open]') && ${text('Доступ для чат-клиентов')}`));
};
const QUESTION = 'Подтвердите срок действия банковской гарантии — 60 дней';
const EXTRA = 'Уточните порядок индексации цены при переносе сроков';

let STAGE = '';
let browser;
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

  browser = spawn(
    BROWSER,
    ['--headless=new', '--disable-gpu', '--no-first-run', ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'kontur-ui16-chrome-'))}`, 'about:blank'],
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // ---- Подготовка: администратор демо-данных становится руководителем демонстрационного тендера
  record('вход администратора-руководителя', await login('demo.admin'));
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const me = (await api('/me')).body;
  const card = await api(`/tenders/${demo.id}`);
  await api(`/tenders/${demo.id}/members/${me.id}`, { method: 'PUT', headers: { ...json, 'If-Match': card.etag }, body: JSON.stringify({ memberRole: 'manager' }) });
  STAGE = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;

  // ---- Смартфон 390 px: диалог токенов
  await viewport(390);
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(text('DEMO-001'));
  record('меню на смартфоне: «Доступ для чат-клиентов» открывает диалог', await openTokens(), await lacks('Доступ для чат-клиентов'));
  record('диалог объясняет границу: чат только предлагает, решения — за человеком; токенов пока нет', (await waitFor(`${text('может')} && ${text('только предложить')} && ${text('Токенов пока нет')}`)) === true, await lacks('только предложить', 'Токенов пока нет'));
  record('поле названия пустое: «Выпустить токен» без названия показывает ошибку у поля', (await clickInDialog('Выпустить токен')) && (await waitFor(text('Назовите токен'))));
  await fill('dialog[open] input:not([type=checkbox])', 'Codex на ноутбуке');
  await evaluate(`(() => { const c = document.querySelector('dialog[open] input[type=checkbox]'); if (!c) return false; c.click(); return true; })()`);
  await clickInDialog('Выпустить токен');
  const shown = await waitFor(`document.querySelector('[data-testid=issued-token]')`, 20_000);
  const TOKEN = shown ? await evaluate(`document.querySelector('[data-testid=issued-token]').innerText.trim()`) : '';
  record('токен выпущен: значение показано, в списке — «Действует», «чтение и предложения»', /^kkp_[A-Za-z0-9_-]{43}$/.test(TOKEN) && (await waitFor(`${text('Действует')} && ${text('чтение и предложения')} && ${text('показано один раз')}`)), await lacks('Действует', 'чтение и предложения', 'показано один раз'));
  for (const w of [360, 390, 430]) {
    await viewport(w);
    await sleep(250);
    record(`${w} px: диалог токенов с длинным значением не шире экрана`, (await dialogFits()) === true && (await noHorizontalScroll()) === true, await overflowers());
    if (w === 390) await shot('390-token-issued');
  }
  await viewport(390);

  // ---- Точка /mcp с выпущенным токеном (как чат-клиент)
  const init = await mcp(TOKEN, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ui-check', version: '1.0.0' } });
  record('точка /mcp: рукопожатие с токеном проходит, сервер называет себя', init.status === 200 && init.body?.result?.serverInfo?.name === 'kontur-kp', `status ${init.status}`);
  const list = await mcp(TOKEN, 'tools/list', {});
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  record('точка /mcp: инструменты чтения и предложений в списке, действий человека нет', ['list_cases', 'search_evidence', 'get_readiness', 'compare_releases', 'propose_question'].every((n) => names.includes(n)) && !names.some((n) => /approve|release_candidate|send_|resolve|accept/i.test(n)), names.join(', ').slice(0, 300));
  const cases = await tool(TOKEN, 'list_cases');
  record('list_cases: демонстрационный тендер виден владельцу токена', cases.isError === false && (cases.data?.cases ?? []).some((c) => c.code === 'DEMO-001'));
  const noScope = await tool(TOKEN, 'search_evidence', { query: 'Какой аванс по договору?' });
  record('вопрос без области: needs_selection со списком дел, тендер по тексту не выбирается', noScope.isError === true && noScope.data?.error?.code === 'needs_selection' && Array.isArray(noScope.data.error.cases));
  const overview = await tool(TOKEN, 'get_case_overview', { tenderId: demo.id, stageId: STAGE });
  record('get_case_overview отвечает по этапу', overview.isError === false && overview.data?.stageId === STAGE, JSON.stringify(overview.data?.error ?? {}).slice(0, 200));
  const p1 = await tool(TOKEN, 'propose_question', { tenderId: demo.id, stageId: STAGE, text: QUESTION, requestId: 'ui16-question-0001' });
  const p1again = await tool(TOKEN, 'propose_question', { tenderId: demo.id, stageId: STAGE, text: QUESTION, requestId: 'ui16-question-0001' });
  const p2 = await tool(TOKEN, 'propose_question', { tenderId: demo.id, stageId: STAGE, text: EXTRA, requestId: 'ui16-question-0002' });
  record('propose_question: предложение сохранено открытым; повтор с тем же requestId — та же запись', p1.isError === false && p1.data?.proposal?.status === 'open' && p1again.data?.proposal?.id === p1.data.proposal.id && p1again.data.proposal.repeat === true && p2.isError === false);
  const questionsBefore = ((await api(`/stages/${STAGE}/customer-questions`)).body.items ?? []).length;
  record('предложение вопросом не стало: вопросов заказчику у этапа не прибавилось', questionsBefore === 0 || !((await api(`/stages/${STAGE}/customer-questions`)).body.items ?? []).some((q) => q.text === QUESTION));

  // ---- Значение токена больше не показывается
  await clickInDialog('Я сохранил токен');
  await sleep(200);
  record('после «Я сохранил токен» значение исчезает; в списке — только первые символы', (await evaluate(`!(document.body.innerText).includes(${JSON.stringify(TOKEN)})`)) === true && (await evaluate(text(`${TOKEN.slice(0, 8)}…`))) === true);
  await clickInDialog('Закрыть');
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(text('DEMO-001'));
  await openTokens();
  record('повторно открытый диалог значения токена не показывает; последний вызов отмечен', (await waitFor(text('последний вызов'))) && (await evaluate(`!(document.body.innerText).includes(${JSON.stringify(TOKEN)})`)) === true, await lacks('последний вызов'));
  await clickInDialog('Закрыть');

  // ---- Раздел этапа «Предложения из чата»
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=proposals` });
  record('раздел «Предложения из чата»: оба предложения ждут решения, с автором «от имени»', await waitFor(`${text(QUESTION)} && ${text(EXTRA)} && ${text('Ждёт решения')} && ${text('Предложено через чат от имени')}`, 20_000), await lacks(QUESTION, EXTRA, 'Ждёт решения', 'Предложено через чат от имени'));
  for (const w of [360, 390, 430]) {
    await viewport(w);
    await sleep(250);
    record(`${w} px: раздел предложений без горизонтальной прокрутки`, (await noHorizontalScroll()) === true, await overflowers());
    if (w === 390) await shot('390-proposals');
  }
  await viewport(390);
  const clickFor = (needle, label) =>
    evaluate(`(() => { const li = [...document.querySelectorAll('li')].find((x) => x.innerText.includes(${JSON.stringify(needle)})); const b = li ? [...li.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}) : null; if (!b) return false; b.click(); return true; })()`);
  await clickFor(QUESTION, 'Принять');
  record('диалог принятия объясняет последствие: черновик вопроса от имени человека', await waitFor(`document.querySelector('dialog[open]') && ${text('Будет создан черновик вопроса заказчику от вашего имени')}`), await lacks('Будет создан черновик вопроса заказчику от вашего имени'));
  record('диалог принятия на 390 px не шире экрана', (await dialogFits()) === true);
  await shot('390-proposal-accept');
  await clickInDialog('Принять');
  record('предложение принято: отметка «Принято» и кто принял', await waitFor(`${text('Принято')} && ${text('Принял')} && !document.querySelector('dialog[open]')`, 20_000), await lacks('Принято', 'Принял'));
  const created = ((await api(`/stages/${STAGE}/customer-questions`)).body.items ?? []).find((q) => q.text === QUESTION);
  record('создан черновик вопроса заказчику; автор — человек, принявший предложение', created?.status === 'draft' && created?.createdBy === me.id, JSON.stringify({ status: created?.status, createdBy: created?.createdBy }));
  await clickFor(EXTRA, 'Отклонить');
  await waitFor(`document.querySelector('dialog[open]')`);
  await clickInDialog('Отклонить');
  record('отклонение без причины не проходит: ошибка у поля', await waitFor(text('Укажите причину отклонения')));
  await fillDialogText('Вопрос уже задан заказчику письмом');
  await clickInDialog('Отклонить');
  record('предложение отклонено: отметка и причина видны', await waitFor(`${text('Отклонено')} && ${text('Вопрос уже задан заказчику письмом')} && !document.querySelector('dialog[open]')`, 20_000), await lacks('Отклонено', 'Вопрос уже задан заказчику письмом'));
  await shot('390-proposals-decided');

  // ---- Отзыв токена
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(text('DEMO-001'));
  await openTokens();
  await waitFor(text('Codex на ноутбуке'));
  await clickInDialog('Отозвать');
  await clickInDialog('Отозвать сейчас');
  record('токен отозван в интерфейсе: отметка «Отозван»', await waitFor(text('Отозван'), 20_000));
  const afterRevoke = await mcp(TOKEN, 'tools/list', {});
  record('отозванный токен точка /mcp не принимает (401)', afterRevoke.status === 401, `status ${afterRevoke.status}`);
  await clickInDialog('Закрыть');

  // ---- Журнал
  const audit = (await api(`/tenders/${demo.id}/audit-events`)).body.items ?? [];
  const viaMcp = audit.filter((e) => /^mcp\.(propose_question|get_case_overview)$/u.test(e.action));
  record('журнал тендера: вызовы чат-клиента записаны как «модель через MCP», текста предложений в журнале нет', viaMcp.length >= 3 && viaMcp.every((e) => e.principalKind === 'model_via_mcp') && !JSON.stringify(audit).includes('банковской гарантии'), `записей ${viaMcp.length}`);

  // ---- 1280 px, тёмная тема
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=proposals` });
  await waitFor(text('Отклонено'), 20_000);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  await sleep(300);
  record('тёмная тема, 1280 px: раздел предложений не шире страницы, статусы читаются', (await noHorizontalScroll()) === true && (await waitFor(`${text('Принято')} && ${text('Отклонено')}`)), await overflowers());
  await shot('1280-dark-proposals');
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Доступ для чат-клиентов' && x.offsetParent !== null); b?.click(); return Boolean(b); })()`);
  record('тёмная тема, 1280 px: кнопка шапки открывает диалог токенов', await waitFor(`document.querySelector('dialog[open]') && ${text('Отозван')}`), await lacks('Отозван'));
  await shot('1280-dark-tokens');
  await evaluate(`document.documentElement.removeAttribute('data-theme'), true`);
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

const out = join(ROOT, 'artifacts', 'stage-16');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker; данные ПОДДЕЛЬНЫЕ: демонстрационный тендер, поддельный TenderHub и модель; точка /mcp проверяется запросами JSON-RPC, а не чат-клиентом\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
