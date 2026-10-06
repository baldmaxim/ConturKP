// Этап 12: проверка вкладки «Комплект» и библиотеки шаблонов в headless Chromium (CDP) против настоящих server + worker
// с LibreOffice (D-032; ADR-013). Расчёт — поддельный TenderHub (одна ревизия), ТЗ — CSV с локальным распознаванием,
// формы — демонстрационные (вымышленный текст). Проверяется: руководитель в интерфейсе создаёт ревизию шаблона со схемой,
// оригиналом и размеченной копией образца — «Разметка DOCX проверена», утверждает; библиотека вложений видна; инженер
// собирает тестовый комплект кнопкой — статус «Собран — к согласованию», файлы «Заказчику» и «Внутреннее», превью именно файла комплекта постранично (холст отрисован,
// отметка «ТЕСТОВЫЙ ВЫПУСК» видна красным в шапке страницы), ZIP и манифест по ссылкам; 390/360 px без горизонтальной
// прокрутки, 1280 px — файлы и превью рядом, тёмная тема; нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH, LibreOffice.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-12/ui-check.mjs → artifacts/stage-12/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана и PNG страниц превью для просмотра человеком (D-032 В-12-10; в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const DB = 'kontur_kp_ui12_test';
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
const id = (b, k) => `7d1f0c8e-1010-4a6b-9c1d-${b}${String(k).padStart(12 - b.length, '0')}`;
const V1 = id('e', 1);
// Одна версия расчёта: сборке комплекта нужна ревизия расчёта этапа. Итог источника 120 002 315,50 ₽ = 120,00 млн руб. —
// цена КП в письме сверяется с ним (D-032 В-12-6).
const line = (t, pos, lid, desc, wn, q, r, k, extra = {}) => {
  const total = extra.total ?? String(Number(q) * Number(r) * Number(extra.fx ?? 1));
  const comm = extra.noComm ? null : String(Number(total) * Number(k));
  return fakeItem(t, pos, lid, { boq_item_type: extra.type ?? 'раб', description: desc, work_name_id: wn, unit_code: extra.unit ?? 'м2', quantity: n(q), base_quantity: n(q === '0' ? '1' : q), unit_rate: n(r), currency_type: extra.currency ?? 'RUB', total_amount: n(total), commercial_markup: extra.noComm ? null : n(k), total_commercial_material_cost: extra.noComm ? null : n('0'), total_commercial_work_cost: comm === null ? null : n(comm) });
};
const tender = (t, version, usd, rows, items, grand) => {
  const sum = (pid, pick) => items.filter((i) => i.client_position_id === pid).reduce((a, i) => a + Number(pick(i)?.__num ?? 0), 0);
  const positions = rows.map(([pid, number, name, o]) => fakePosition(t, pid, { position_number: n(number), item_no: number, work_name: name, unit_code: 'м2', volume: n('100'), manual_volume: n('100'), items_count: n(String(items.filter((i) => i.client_position_id === pid).length)), base_total: n(String(sum(pid, (i) => i.total_amount))), commercial_total: n(String(sum(pid, (i) => i.total_commercial_work_cost))), work_cost_total: n(String(sum(pid, (i) => i.total_commercial_work_cost))), ...o }));
  return fakeTender({ id: t, tender_number: 'TH-UI-12', title: 'Корпус 12 — комплект', version, usd_rate: n(usd), cached_grand_total: n(grand), positions, items });
};
const lamps = (t, pid, b) => [line(t, pid, id(b, 7), 'Монтаж светильников', 'w-lamp', '10', '50', '1', { unit: 'шт' }), line(t, pid, id(b, 8), 'Кронштейн', 'm-bracket', '0', '50', '1', { type: 'мат', unit: 'шт', noComm: true })];
hub.tenders.set(V1, tender(V1, 1, '90',
  [[id('a', 0), '1', 'Раздел 1', { is_section: true, item_no: null, unit_code: null, volume: null, manual_volume: null }], [id('a', 1), '1.1', 'Штукатурка стен'], [id('a', 5), '3', 'Вывоз мусора', { unit_code: 'т' }], [id('a', 6), '4', 'Светильники', { unit_code: 'шт' }]],
  [line(V1, id('a', 1), id('c', 1), 'Штукатурка стен', 'w-plaster', '100000', '1000', '1.2'), line(V1, id('a', 5), id('c', 6), 'Вывоз мусора', 'w-waste', '10', '2', '1', { type: 'суб-раб', unit: 'т', currency: 'USD', fx: 90 }), ...lamps(V1, id('a', 6), 'c')],
  '120002315.5'));
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui12-')),
  TENDERHUB_INSTANCE_ID: 'th-ui-12',
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
// Файл в N-й штатный <input type=file> страницы (схема, оригинал образца, размеченная копия).
const pickFileAt = async (index, path) => {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const nodes = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  const nodeId = nodes.result?.nodeIds?.[index];
  if (!nodeId) return false;
  await send('DOM.setFileInputFiles', { nodeId, files: [path] });
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
const key = () => `ui12-${randomBytes(6).toString('hex')}`;
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

const CSV = Buffer.from('Раздел;Текст\nКровля;Кровля выполняется из профнастила С-44.\n', 'utf8');
const LETTER = {
  letter_date: '2026-10-06',
  letter_number: '04/26-01-ТО',
  addressee: 'Тендерному управлению заказчика (демо)',
  subject: 'Строительство демонстрационного объекта',
  materials_price_date: '2026-09-01',
  advance_percent: '30',
  duration_months: '32',
  validity_days: '30',
  kp_price: '120.00',
  warranty_months: '60',
  conditions_text: 'Длинное условие для проверки переносов: '.repeat(40).trim(),
  missing_data: [
    { item: 'Инженерно-геологические изыскания' },
    { item: `Технические условия на подключение к сетям: ${'водоснабжение, водоотведение, теплоснабжение, электроснабжение, связь; '.repeat(3).trim()}` },
  ],
};
// Отметка режима на превью: в верхней части холста есть красные пиксели (цвет отметки C00000).
const redOnCanvas = () =>
  evaluate(`(() => { const c = document.querySelector('figure canvas'); if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.floor(c.height / 4)).data; let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red += 1; return red > 50; })()`);
const canvasDrawn = () =>
  evaluate(`(() => { const c = document.querySelector('figure canvas'); if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) dark += 1; return dark > 500; })()`);
// PNG страниц превью для просмотра человеком (D-032 В-12-10): PDF берётся тем же запросом, что у пользователя.
const savePages = async (fileId, name) => {
  if (!SHOTS) return 0;
  const b64 = await evaluate(`(async () => { const r = await fetch('/api/v1/candidate-files/${fileId}/content'); const a = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (let i = 0; i < a.length; i += 1) s += String.fromCharCode(a[i]); return btoa(s); })()`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(b64, 'base64')), disableFontFace: true, useSystemFonts: false }).promise;
  mkdirSync(join(SHOTS, 'pages'), { recursive: true });
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    writeFileSync(join(SHOTS, 'pages', `${name}-${String(i).padStart(2, '0')}.png`), canvas.toBuffer('image/png'));
  }
  const n = doc.numPages;
  await doc.destroy();
  return n;
};

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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // ---- Подготовка (администратор-руководитель): ТЗ и снимок, ревизия расчёта, шаблон с размеченной копией образца
  record('вход администратора-руководителя', await login('demo.admin'));
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const me = (await api('/me')).body;
  const card = await api(`/tenders/${demo.id}`);
  await api(`/tenders/${demo.id}/members/${me.id}`, { method: 'PUT', headers: { ...json, 'If-Match': card.etag }, body: JSON.stringify({ memberRole: 'manager' }) });
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;
  const up = await uploadBytes(stageId, 'тз-кровля.csv', CSV);
  const rev = await registered(up.body.id);
  await api(`/document-revisions/${rev}/local-recognitions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const run = await runOf(rev);
  const draftSet = await api(`/stages/${stageId}/source-set-revisions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const put = await api(`/source-set-revisions/${draftSet.body.id}/items`, { method: 'PUT', headers: { ...json, 'If-Match': draftSet.etag }, body: JSON.stringify({ items: [{ documentRevisionId: rev, inclusion: 'included' }] }) });
  await api(`/source-set-revisions/${draftSet.body.id}/freeze`, { method: 'POST', headers: { ...json, 'If-Match': put.etag, 'Idempotency-Key': key() }, body: '{}' });
  const scope = await api(`/stages/${stageId}/evidence-scopes`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const src = await api(`/stages/${stageId}/calculation-source`);
  await api(`/stages/${stageId}/calculation-source`, { method: 'PUT', headers: { ...json, 'If-Match': src.etag }, body: JSON.stringify({ externalTenderId: V1, externalVersion: 1 }) });
  const capture = await api(`/stages/${stageId}/calculation-captures`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const cap = await poll(async () => {
    const c = (await api(`/calculation-captures/${capture.body.id}`)).body;
    return c?.status === 'complete' || c?.status === 'failed' ? c : null;
  }, 60_000);
  record('этап подготовлен: ТЗ распознано, снимок области, ревизия расчёта', run?.status === 'complete' && scope.status === 201 && cap?.status === 'complete', `${run?.status}/${scope.status}/${cap?.status}`);
  // Шаблон через интерфейс: «С образцом для генерации» — схема, оригинал образца и размеченная копия, затем утверждение.
  await send('Page.navigate', { url: `${BASE}/forms` });
  await waitFor(text('Шаблоны приложений'), 20_000);
  await fillField('Новый шаблон компании', 'Письмо КП');
  await clickButton('Создать');
  await waitFor(text('С образцом для генерации файла (DOCX или XLSX)'), 15_000);
  await checkLabel('С образцом для генерации файла (DOCX или XLSX)', true);
  await waitFor(text('Размеченная копия с {{ключами}}'));
  const picked =
    (await pickFileAt(0, join(ROOT, 'docs/forms/demo-kp-letter.forms.json'))) &&
    (await pickFileAt(1, join(ROOT, 'docs/forms/samples/demo-kp-letter.original.docx'))) &&
    (await pickFileAt(2, join(ROOT, 'docs/forms/samples/demo-kp-letter.marked.docx')));
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Загрузить ревизию' && !b.disabled)`);
  await clickButton('Загрузить ревизию');
  record('шаблон в интерфейсе: схема, оригинал и размеченная копия — «Разметка DOCX проверена», аудитория «Заказчику»', picked && (await waitFor(`${text('Разметка DOCX проверена')} && ${text('Заказчику')}`, 20_000)));
  await shot('1280-templates-markup');
  await clickButton('Утвердить');
  await waitFor(text('Действует ревизия № 1'), 15_000);
  const tpl = (await api('/application-templates')).body.items.find((x) => x.name === 'Письмо КП');
  const r = { body: (await api(`/application-templates/${tpl.id}`)).body.revisions.find((x) => x.status === 'approved') };
  record('ревизия утверждена: размеченная копия рядом с оригиналом образца', Boolean(r.body?.markedSample) && Boolean(r.body?.sample) && r.body?.outputFormat === 'docx', `${r.body?.status}/${r.body?.outputFormat}`);
  await clickButton('Новое вложение');
  record('библиотека стандартных вложений видна руководителю, форма вложения раскрывается кнопкой', await waitFor(`${text('Стандартные вложения комплекта')} && ${text('Добавить вложение')}`));
  await logout();

  // ---- Инженер: заполненное приложение (API), сборка комплекта кнопкой на 390 px
  record('вход инженера', await login('demo.eng1'));
  const d = await api(`/stages/${stageId}/application-drafts`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: JSON.stringify({ templateRevisionId: r.body.id, title: 'Письмо КП' }) });
  for (const [k, v] of Object.entries(LETTER)) {
    const view = (await api(`/application-drafts/${d.body.id}`)).body;
    const f = view.sections.flatMap((s) => s.fields).find((x) => x.key === k);
    await api(`/application-drafts/${d.body.id}/fields/${k}`, { method: 'PUT', headers: { ...json, 'If-Match': f.etag }, body: JSON.stringify({ action: 'set', value: v, bases: [] }) });
  }
  const dv = (await api(`/application-drafts/${d.body.id}`)).body;
  const done = await api(`/application-drafts/${d.body.id}/complete`, { method: 'POST', headers: { ...json, 'If-Match': dv.etag }, body: '{}' });
  record('приложение заполнено и отмечено «заполнено»', done.status === 200, `HTTP ${done.status}`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=release` });
  record('вкладка «Комплект»: форма сборки, приложение «заполнено» к выбору', await waitFor(`${text('Собрать комплект')} && ${text('Письмо КП · Письмо КП (демо)')}`, 20_000));
  await checkLabel('Письмо КП · Письмо КП (демо)', true);
  await shot('390-release-new');
  await clickButton('Собрать комплект');
  record('комплект собран worker: «Собран — к согласованию», файл в группе «Заказчику»', await waitFor(`${text('Собран — к согласованию')} && ${text('01 Письмо КП.docx')} && ${text('Заказчику')}`, 120_000));
  record('превью: страница отрисована на холсте, счётчик страниц', await waitFor(`${text('Страница 1 из')}`, 30_000) && (await poll(() => canvasDrawn(), 20_000)) === true);
  record('превью: отметка «ТЕСТОВЫЙ ВЫПУСК» видна на странице (красным в шапке)', (await poll(() => redOnCanvas(), 20_000)) === true);
  await evaluate(`(() => { const d = [...document.querySelectorAll('details')].find((x) => x.innerText.startsWith('Проверки сборки')); if (d) d.open = true; return true; })()`);
  record(
    'проверки сборки раскрываются: «Числа и расчёт» — пройдено (цена КП = итог расчёта в млн руб.)',
    await waitFor(`[...document.querySelectorAll('li')].some((li) => li.innerText.includes('Числа и расчёт') && li.innerText.includes('Пройдено'))`),
  );
  record('ZIP для заказчика, ZIP всех файлов и манифест — ссылками', await waitFor(`${text('ZIP для заказчика')} && ${text('ZIP всех файлов')} && ${text('Манифест')}`));
  record('нет горизонтальной прокрутки на 390 px (комплект)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны (комплект)', await buttonsFit());
  await shot('390-release-candidate');
  const list = (await api(`/stages/${stageId}/release-candidates`)).body.items;
  const cand = (await api(`/release-candidates/${list[0].id}`)).body;
  const pages = await savePages(cand.files[0].previewFileId, '01-pismo-kp');
  if (SHOTS) record('PNG страниц превью сохранены для просмотра человеком', pages > 0, `страниц: ${pages}`);

  // ---- 360 px
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  record('нет горизонтальной прокрутки на 360 px', await noHorizontalScroll());

  // ---- 1280 px, тёмная тема: файлы и превью рядом
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=release` });
  await waitFor(text('Комплект № 1'), 20_000);
  await clickButton(`Комплект № 1 · Тестовый${'Собран — к согласованию'}`).catch(() => false);
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('Комплект № 1')); b?.click(); return true; })()`);
  await waitFor(`${text('Страница 1 из')}`, 30_000);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record(
    'тёмная тема, 1280 px: файлы и превью в одном ряду',
    await evaluate(`(() => { const f = document.querySelector('figure'); const list = [...document.querySelectorAll('h4')].find((h) => h.innerText === 'Заказчику');
      if (!f || !list) return false; const a = f.getBoundingClientRect(); const b = list.getBoundingClientRect(); return a.left > b.right - 5 && Math.abs(a.top - b.top) < 400; })()`),
  );
  if (SHOTS) await sleep(500);
  await shot('1280-dark-release');
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

const out = join(ROOT, 'artifacts', 'stage-12');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker, LibreOffice, TenderHub — поддельный, демонстрационные формы\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
