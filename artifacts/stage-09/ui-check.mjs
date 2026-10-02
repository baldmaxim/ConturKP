// Этап 09: проверка интерфейса «Проверка» и «Разногласия» в headless Chromium (CDP) против настоящих процессов server +
// worker. Расчёт — поддельный TenderHub (VERIFIED_FIXTURE), модель — поддельный провайдер MODEL_PROVIDER=fake: проверяется
// механизм, а не качество (D-029 В-09-5). Проверяется: запуск проверки кнопкой; отчёт — сводка без «всё проверено» при
// неполном реестре, исходы программных проверок и отдельный блок гипотез модели; закреплённые входы; вкладка
// «Разногласия» — замечание «светильник №1/№2» (A01) с цитатой ТЗ и строкой расчёта; разногласие открывается, оси по
// умолчанию, ось «Учтено в расчёте» меняется отдельно от остальных (I09); решение замечания с формулировкой; 390/360 px
// без горизонтальной прокрутки, 1280 px — список и карточка рядом, тёмная тема; приоритет источников — руководитель меняет
// с причиной, инженер видит без кнопок; инженер не видит «Принять риск»; нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-09/ui-check.mjs → artifacts/stage-09/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана ключевых состояний для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { n, startFakeTenderHub, TH_KEY } from '../../scripts/tenderhub-fake.ts';
import { fakeItem, fakePosition, fakeTender } from '../../scripts/tenderhub-fake-data.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui09_test';
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
const UI = {
  tender: '7d1f0c8e-9999-4a6b-9c1d-0000000009e0',
  lamp: '7d1f0c8e-9999-4a6b-9c1d-0000000009e1',
  lampLine: '7d1f0c8e-9999-4a6b-9c1d-0000000009f1',
};
hub.tenders.set(
  UI.tender,
  fakeTender({
    id: UI.tender,
    tender_number: 'TH-UI-09',
    positions: [fakePosition(UI.tender, UI.lamp, { position_number: n('1'), work_name: 'Светильники коридоров', unit_code: 'шт', volume: n('10'), items_count: n('1'), commercial_total: n('500') })],
    items: [fakeItem(UI.tender, UI.lamp, UI.lampLine, { boq_item_type: 'мат', description: 'Светильник светодиодный №2', unit_code: 'шт', quantity: n('10') })],
  }),
);
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui09-')),
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
const key = () => `ui09-${randomBytes(6).toString('hex')}`;
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



const CSV = Buffer.from('Раздел;Текст\nОсвещение;Светильники в коридорах — тип №1.\nФундамент;Марка бетона фундамента уточняется в РД.\n', 'utf8');
const visible = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && el.offsetParent !== null); })()`);
// Строка списка замечаний — кнопка с текстом замечания.
const openRow = (rowText) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('[aria-label="Замечания"] button')].find((x) => x.innerText.includes(${JSON.stringify(rowText)}));
    if (!b) return false; b.click(); return true; })()`);
const buttonVisible = (label) => evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === ${JSON.stringify(label)} && b.offsetParent !== null)`);

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

  // ---- Подготовка этапа (руководитель-администратор): ТЗ, снимок, реестр, расчёт
  record('вход администратора-руководителя', await login('demo.admin'));
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const me = (await api('/me')).body;
  const card = await api(`/tenders/${demo.id}`);
  await api(`/tenders/${demo.id}/members/${me.id}`, { method: 'PUT', headers: { ...json, 'If-Match': card.etag }, body: JSON.stringify({ memberRole: 'manager' }) });
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;
  const up = await uploadBytes(stageId, 'тз-освещение.csv', CSV);
  const rev = await registered(up.body.id);
  await api(`/document-revisions/${rev}/local-recognitions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const run = await runOf(rev);
  record('ТЗ загружено и распознано (CSV, локально)', run?.status === 'complete', run?.status ?? 'нет прогона');
  const draft = await api(`/stages/${stageId}/source-set-revisions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const put = await api(`/source-set-revisions/${draft.body.id}/items`, { method: 'PUT', headers: { ...json, 'If-Match': draft.etag }, body: JSON.stringify({ items: [{ documentRevisionId: rev, inclusion: 'included' }] }) });
  await api(`/source-set-revisions/${draft.body.id}/freeze`, { method: 'POST', headers: { ...json, 'If-Match': put.etag, 'Idempotency-Key': key() }, body: '{}' });
  const scope = await api(`/stages/${stageId}/evidence-scopes`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const registry = await api(`/stages/${stageId}/requirement-registries`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: JSON.stringify({ evidenceScopeId: scope.body.id, reason: 'Реестр для проверки' }) });
  const src = await api(`/stages/${stageId}/calculation-source`);
  await api(`/stages/${stageId}/calculation-source`, { method: 'PUT', headers: { ...json, 'If-Match': src.etag }, body: JSON.stringify({ externalTenderId: UI.tender, externalVersion: null }) });
  const capture = await api(`/stages/${stageId}/calculation-captures`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const captured = await poll(async () => {
    const c = (await api(`/calculation-captures/${capture.body.id}`)).body;
    return c?.status === 'complete' ? c : null;
  }, 60_000);
  record('снимок, реестр и ревизия расчёта (поддельный TenderHub)', scope.status === 201 && registry.status === 201 && Boolean(captured), `${scope.status}/${registry.status}/${captured?.status}`);
  const fragments = (await api(`/requirement-registries/${registry.body.id}/fragments?limit=50`)).body.items;
  const lampFragment = fragments.find((f) => f.text.includes('тип №1'));
  await logout();

  // ---- Инженер предлагает требование; руководитель подтверждает и оценивает покрытие строкой расчёта
  record('вход инженера', await login('demo.eng1'));
  const candidate = await api(`/requirement-registries/${registry.body.id}/requirement-candidates`, {
    method: 'POST',
    headers: { ...json, 'Idempotency-Key': key() },
    body: JSON.stringify({ statement: 'Светильники в коридорах — тип №1', parameters: [{ name: 'Тип светильника', value: '№1', unit: null }], evidence: [{ fragmentId: lampFragment.fragmentId ?? lampFragment.id, role: 'supports' }] }),
  });
  await logout();
  await login('demo.admin');
  const cand = await api(`/requirement-candidates/${candidate.body.id}`);
  const confirmed = await api(`/requirement-candidates/${candidate.body.id}/confirm`, { method: 'POST', headers: { ...json, 'If-Match': cand.etag, 'Idempotency-Key': key() }, body: '{}' });
  const coverage = await api(`/requirement-revisions/${confirmed.body.revisionId}/coverage`, {
    method: 'POST',
    headers: { ...json, 'Idempotency-Key': key() },
    body: JSON.stringify({ state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: captured.revisionId, externalPositionId: UI.lamp, externalItemId: UI.lampLine, match: 'explicit_line' }] }),
  });
  record('требование «тип №1» подтверждено и покрыто строкой «Светильник светодиодный №2»', candidate.status === 201 && confirmed.status === 200 && coverage.status === 201, `${candidate.status}/${confirmed.status}/${coverage.status}`);

  // ---- 390 px: вкладка «Проверка» — запуск кнопкой, отчёт
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=review` });
  record('вкладка «Проверка»: проверок ещё не было', await waitFor(`${text('Проверок ещё не было')} && ${text('Запустить проверку')}`));
  record('нет горизонтальной прокрутки на 390 px (пустая проверка)', await noHorizontalScroll());
  await clickButton('Запустить проверку');
  record(
    'отчёт: сводка не «замечаний нет» (реестр не пройден), исходы проверок, блок гипотез модели отдельно',
    await waitFor(`${text('Программные проверки')} && ${text('Гипотезы модели')} && ${text('Полнота реестра требований')} && ${text('неполно')} && !${text('Проверка завершена: замечаний нет')} && (${text('Проверка неполная')} || ${text('Есть замечания')})`, 90_000),
  );
  record('параметры: «есть замечания»; закреплённые входы видны', (await evaluate(text('Параметры требований в строках расчёта'))) && (await evaluate(text('Закреплённые входы'))));
  record('нет горизонтальной прокрутки на 390 px (отчёт)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны (отчёт)', await buttonsFit());
  await shot('390-review-report');

  // ---- «Разногласия»: замечание A01 с цитатой ТЗ и строкой расчёта
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=discrepancies` });
  record('вкладка «Разногласия»: замечание «Тип светильника: №1» в списке', await waitFor(`${text('«Тип светильника: №1» не найдено в строке расчёта')}`, 15_000));
  await openRow('«Тип светильника: №1» не найдено');
  record(
    'карточка: обе стороны — цитата ТЗ и строка расчёта «№2», критичность «существенное»',
    await waitFor(`${text('Светильники в коридорах — тип №1')} && ${text('Светильник светодиодный №2')} && ${text('существенное')} && ${text('открыть цитату')}`),
  );
  record('нет горизонтальной прокрутки на 390 px (карточка замечания)', await noHorizontalScroll());
  await shot('390-finding');
  await clickButton('Открыть разногласие');
  await waitFor(text('Тема'));
  await fillField('Тема', 'Светильник в коридорах');
  await clickButton('Открыть');
  record(
    'разногласие открыто: четыре оси по умолчанию',
    await waitFor(`${text('Разногласие: Светильник в коридорах')} && ${text('неизвестна')} && ${text('не учтено')} && ${text('не отражено')} && ${text('не закреплено')}`),
  );
  await clickButton('Изменить ось');
  await waitFor(text('Изменить ось разногласия'));
  await fillField('Ось', 'calculation');
  await sleep(200);
  await fillField('Значение', 'reflected');
  await fillField('Причина', 'В расчёте светильник №2 по письму заказчика');
  if (SHOTS) await sleep(500);
  await shot('390-axis-dialog');
  await clickButton('Записать');
  record(
    'ось «Учтено в расчёте» = «учтено»; позиция заказчика и закрепление не изменились (I09)',
    await waitFor(`${text('Ось изменена')} && ${text('учтено')} && ${text('неизвестна')} && ${text('не закреплено')}`),
  );
  record('нет горизонтальной прокрутки на 390 px (разногласие)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны (разногласие)', await buttonsFit());
  await shot('390-discrepancy');

  // ---- 360 px
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  record('нет горизонтальной прокрутки на 360 px (карточка и разногласие)', await noHorizontalScroll());

  // ---- Решение замечания с формулировкой
  await clickButton('Решить');
  await waitFor(text('Решить замечание'));
  await fillField('Решение', 'Применять светильник №2 по письму заказчика');
  await fillField('Причина', 'Замена согласована письмом');
  await clickButton('Записать');
  record('замечание решено человеком: статус «решено», решение в карточке', await waitFor(`${text('Статус замечания изменён')} && ${text('решено')} && ${text('Решение по замечанию: Применять светильник №2')}`));

  // ---- 1280 px, тёмная тема: список и карточка рядом
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record(
    'тёмная тема, 1280 px: список замечаний и карточка рядом',
    (await waitFor(`${text('Разногласие: Светильник в коридорах')} && document.querySelector('[aria-label="Замечания"]')`)) &&
      (await evaluate(`(() => { const l = document.querySelector('[aria-label="Замечания"]').getBoundingClientRect(); const c = document.querySelector('[aria-label="Карточка замечания"]').getBoundingClientRect(); return c.left >= l.right - 1; })()`)),
  );
  if (SHOTS) await sleep(500);
  await shot('1280-dark-discrepancies');
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=review` });
  record('тёмная тема, 1280 px: отчёт проверки читается', await waitFor(`${text('Программные проверки')} && ${text('Гипотезы модели')}`));
  if (SHOTS) await sleep(500);
  await shot('1280-dark-review');
  await evaluate(`document.documentElement.removeAttribute('data-theme'), true`);

  // ---- Приоритет источников: руководитель меняет с причиной
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=priority` });
  record('приоритет источников: порядок по умолчанию и пояснение «подсказывает, решает человек»', await waitFor(`${text('Действует порядок по умолчанию')} && ${text('конфликт решает человек')} && ${text('1. Договор и допсоглашения')}`));
  await evaluate(`(() => { const b = document.querySelector('button[aria-label="Повысить «ТЗ»"]'); b?.click(); return Boolean(b); })()`);
  await fillField('Причина изменения', 'По этому тендеру ТЗ имеет приоритет над проектом договора');
  await clickButton('Сохранить порядок');
  record('руководитель сохранил порядок: «1. ТЗ», ревизия № 1 с причиной', await waitFor(`${text('Приоритет источников сохранён')} && ${text('1. ТЗ')} && ${text('Ревизия № 1')}`));
  await logout();

  // ---- Инженер: без «Принять риск», приоритет — только просмотр
  record('вход инженера', await login('demo.eng1'));
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=priority` });
  record('инженер видит приоритет без кнопок изменения', (await waitFor(text('1. ТЗ'))) && !(await evaluate(`Boolean(document.querySelector('button[aria-label^="Повысить"]'))`)));
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=discrepancies` });
  await waitFor(text('не найдено в строке расчёта'));
  await openRow('не найдено в строке расчёта');
  record('инженер: карточка открыта, «Принять риск» нет', (await waitFor(text('Светильники в коридорах — тип №1'))) && !(await buttonVisible('Принять риск')));

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

const out = join(ROOT, 'artifacts', 'stage-09');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker, MODEL_PROVIDER=fake, TenderHub — поддельный\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
