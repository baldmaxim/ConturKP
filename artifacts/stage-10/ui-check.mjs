// Этап 10: проверка вкладки «Экономика» в headless Chromium (CDP) против настоящих процессов server + worker. Расчёт —
// поддельный TenderHub (VERIFIED_FIXTURE, две версии одного номера), модель не нужна. Проверяется: отчёт ревизии —
// суммы в рублях, неподтверждённый остаток отдельно («не итог КП»), составляющие «недоступно по ключу», курс с датой
// наблюдения, отклонения источника со строками; сравнение кнопкой — пары по ключам только предложения, пакетное
// подтверждение инженером, повторное сравнение с вкладами «Объём», «Цена в валюте», «Курс» и остатком уровня тендера;
// порядок подстановок и правило совместного эффекта видны; причина вручную («предполагаемая»); 390/360 px без
// горизонтальной прокрутки, 1280 px — четыре карточки в ряд, тёмная тема; нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-10/ui-check.mjs → artifacts/stage-10/ui-check.log.
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
const DB = 'kontur_kp_ui10_test';
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
const V2 = id('e', 2);
// Позиции и строки двух версий: штукатурка 100 × 10 → 110 × 12 (A20), вывоз мусора в USD (курс 90 → 100), светильники с
// кронштейном без коммерческой стоимости (отклонение источника), новая окраска фасада.
const line = (t, pos, lid, desc, wn, q, r, k, extra = {}) => {
  const total = extra.total ?? String(Number(q) * Number(r) * Number(extra.fx ?? 1));
  const comm = extra.noComm ? null : String(Number(total) * Number(k));
  return fakeItem(t, pos, lid, { boq_item_type: extra.type ?? 'раб', description: desc, work_name_id: wn, unit_code: extra.unit ?? 'м2', quantity: n(q), base_quantity: n(q === '0' ? '1' : q), unit_rate: n(r), currency_type: extra.currency ?? 'RUB', total_amount: n(total), commercial_markup: extra.noComm ? null : n(k), total_commercial_material_cost: extra.noComm ? null : n('0'), total_commercial_work_cost: comm === null ? null : n(comm) });
};
const tender = (t, version, usd, rows, items, grand) => {
  const sum = (pid, pick) => items.filter((i) => i.client_position_id === pid).reduce((a, i) => a + Number(pick(i)?.__num ?? 0), 0);
  const positions = rows.map(([pid, number, name, o]) => fakePosition(t, pid, { position_number: n(number), item_no: number, work_name: name, unit_code: 'м2', volume: n('100'), manual_volume: n('100'), items_count: n(String(items.filter((i) => i.client_position_id === pid).length)), base_total: n(String(sum(pid, (i) => i.total_amount))), commercial_total: n(String(sum(pid, (i) => i.total_commercial_work_cost))), work_cost_total: n(String(sum(pid, (i) => i.total_commercial_work_cost))), ...o }));
  return fakeTender({ id: t, tender_number: 'TH-UI-10', title: 'Корпус 10 — экономика', version, usd_rate: n(usd), cached_grand_total: n(grand), positions, items });
};
const lamps = (t, pid, b) => [line(t, pid, id(b, 7), 'Монтаж светильников', 'w-lamp', '10', '50', '1', { unit: 'шт' }), line(t, pid, id(b, 8), 'Кронштейн', 'm-bracket', '0', '50', '1', { type: 'мат', unit: 'шт', noComm: true })];
hub.tenders.set(V1, tender(V1, 1, '90',
  [[id('a', 0), '1', 'Раздел 1', { is_section: true, item_no: null, unit_code: null, volume: null, manual_volume: null }], [id('a', 1), '1.1', 'Штукатурка стен'], [id('a', 5), '3', 'Вывоз мусора', { unit_code: 'т' }], [id('a', 6), '4', 'Светильники', { unit_code: 'шт' }]],
  [line(V1, id('a', 1), id('c', 1), 'Штукатурка стен', 'w-plaster', '100', '10', '1.2'), line(V1, id('a', 5), id('c', 6), 'Вывоз мусора', 'w-waste', '10', '2', '1', { type: 'суб-раб', unit: 'т', currency: 'USD', fx: 90 }), ...lamps(V1, id('a', 6), 'c')],
  '3515.5'));
hub.tenders.set(V2, tender(V2, 2, '100',
  [[id('b', 0), '1', 'Раздел 1', { is_section: true, item_no: null, unit_code: null, volume: null, manual_volume: null }], [id('b', 1), '1.1', 'Штукатурка стен'], [id('b', 5), '3', 'Вывоз мусора', { unit_code: 'т' }], [id('b', 6), '4', 'Светильники', { unit_code: 'шт' }], [id('b', 8), '5', 'Окраска фасада']],
  [line(V2, id('b', 1), id('d', 1), 'Штукатурка стен', 'w-plaster', '110', '12', '1.25'), line(V2, id('b', 5), id('d', 6), 'Вывоз мусора', 'w-waste', '10', '2', '1', { type: 'суб-раб', unit: 'т', currency: 'USD', fx: 100 }), ...lamps(V2, id('b', 6), 'd'), line(V2, id('b', 8), id('d', 20), 'Окраска фасада', 'w-paint', '5', '40', '1')],
  '4370'));
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui10-')),
  TENDERHUB_INSTANCE_ID: 'th-ui-10',
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
const key = () => `ui10-${randomBytes(6).toString('hex')}`;
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

  // ---- Подготовка: администратор-руководитель связывает этап с версией 1, затем с версией 2; две ревизии
  record('вход администратора-руководителя', await login('demo.admin'));
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const me = (await api('/me')).body;
  const card = await api(`/tenders/${demo.id}`);
  await api(`/tenders/${demo.id}/members/${me.id}`, { method: 'PUT', headers: { ...json, 'If-Match': card.etag }, body: JSON.stringify({ memberRole: 'manager' }) });
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;
  const captureVersion = async (tenderId, version) => {
    const src = await api(`/stages/${stageId}/calculation-source`);
    await api(`/stages/${stageId}/calculation-source`, { method: 'PUT', headers: { ...json, 'If-Match': src.etag }, body: JSON.stringify({ externalTenderId: tenderId, externalVersion: version }) });
    const capture = await api(`/stages/${stageId}/calculation-captures`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
    return poll(async () => {
      const c = (await api(`/calculation-captures/${capture.body.id}`)).body;
      return c?.status === 'complete' || c?.status === 'failed' ? c : null;
    }, 60_000);
  };
  const c1 = await captureVersion(V1, 1);
  const c2 = await captureVersion(V2, 2);
  record('две ревизии расчёта (поддельный TenderHub, версии 1 и 2)', c1?.status === 'complete' && c2?.status === 'complete', `${c1?.status}/${c2?.status}`);
  await logout();

  // ---- Инженер, 390 px: отчёт ревизии
  record('вход инженера', await login('demo.eng1'));
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=economics` });
  record(
    'отчёт ревизии: суммы в ₽, остаток отдельно «не итог КП», составляющие «недоступно по ключу», курс с датой наблюдения',
    await waitFor(`${text('Экономика ревизии № 2')} && ${text('Неподтверждённый остаток — не итог КП')} && ${text('Недоступно по ключу TenderHub')} && ${text('Страхование')} && ${text('не дата установления курса')} && ${text('НДС неизвестен')}`, 30_000),
  );
  record('отклонения источника показаны и не исправлены', await waitFor(`${text('Отклонения от ограничений источника')} && ${text('Пустая коммерческая стоимость (не 0): 1')} && ${text('Количество ≤ 0 или пусто: 1')}`));
  await clickButton('Показать строки');
  record('строки отклонения раскрываются', await waitFor(text('Кронштейн')));
  record('нет горизонтальной прокрутки на 390 px (отчёт)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны (отчёт)', await buttonsFit());
  await shot('390-economics-report');

  // ---- Сравнение: пары по ключам — предложения; пакетное подтверждение; повторное сравнение
  await clickButton('Сравнить');
  record('сравнение готово; пары по ключам — предложения, не подтверждены системой', await waitFor(`${text('Сопоставление позиций')} && ${text('подтверждено 0')} && ${text('Подтвердить все')}`, 30_000));
  record('без подтверждённых пар позиции — «Удалено» / «Добавлено»', await waitFor(`${text('Удалено')} && ${text('Добавлено')}`));
  await shot('390-economics-proposals');
  await clickButton('Подтвердить все');
  record('инженер подтвердил предложения пакетом; прежнее сравнение «устарело»', await waitFor(`${text('Подтверждено пар')} && ${text('появились новые решения по парам')}`));
  await clickButton('Сравнить');
  record(
    'повторное сравнение: вклады «Объём» +100 и «Цена в валюте» +220 у штукатурки, «Курс» +200 у вывоза мусора',
    await waitFor(`${text('Штукатурка стен')} && ${text('себест. · Объём')} && ${text('+100')} && ${text('+220')} && ${text('себест. · Курс')} && ${text('+200')}`, 30_000),
  );
  record(
    'остаток уровня тендера отдельной строкой; порядок подстановок и правило совместного эффекта видны',
    await waitFor(`${text('Неподтверждённый остаток уровня тендера')} && ${text('количество → цена в валюте → курс → доставка → коэффициент')} && ${text('более позднему фактору')}`),
  );
  record('нет горизонтальной прокрутки на 390 px (сравнение)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны (сравнение)', await buttonsFit());
  await shot('390-economics-comparison');

  // ---- Причина вручную
  await clickButton('Указать причину');
  await waitFor(text('Причина изменения:'));
  await fillField('Вид причины', 'internal_decision');
  await sleep(200);
  await fillField('Обоснование', 'Площадь уточнена сметчиком по обмерам');
  if (SHOTS) await sleep(400);
  await shot('390-economics-reason');
  await clickButton('Записать');
  record('причина записана человеком: «Внутреннее решение, предполагаемая»', await waitFor(text('Причина: Внутреннее решение, предполагаемая')));

  // ---- 360 px
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  record('нет горизонтальной прокрутки на 360 px', await noHorizontalScroll());

  // ---- 1280 px, тёмная тема: карточки отчёта в ряд
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=economics` });
  await waitFor(text('Неподтверждённый остаток — не итог КП'), 30_000);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record(
    'тёмная тема, 1280 px: четыре карточки отчёта в одном ряду',
    await evaluate(`(() => { const cards = [...document.querySelectorAll('section[aria-labelledby="econ-report-title"] p')].filter((p) => p.innerText.includes('₽')).length; const tops = new Set([...document.querySelectorAll('section[aria-labelledby="econ-report-title"] > div > div')].slice(0, 4).map((d) => Math.round(d.getBoundingClientRect().top))); return cards > 0 && tops.size === 1; })()`),
  );
  if (SHOTS) await sleep(500);
  await shot('1280-dark-economics');
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

const out = join(ROOT, 'artifacts', 'stage-10');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker, TenderHub — поддельный (две версии)\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
