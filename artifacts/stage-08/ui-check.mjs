// Этап 08: проверка интерфейса требований в headless Chromium (CDP) против настоящих процессов server + worker
// (генеративная модель — поддельный провайдер MODEL_PROVIDER=fake: живой модели на машине разработки нет).
// Проверяется: реестр создаётся на снимке через диалог; прогон модели предлагает кандидатов с пометкой
// «Гипотеза модели»; последовательный обход и подтверждение руководителем; инженер не видит кнопки
// подтверждения; карточка требования — основания, покрытие, решение; полнота — пакетная отметка и
// завершение прохода; допущение и вопрос; R08-01 — конфликт требований (отметка, подтверждение только с
// пояснением) и несовпадение единиц покрытия (поддельный TenderHub по контракту: пояснение обязательно, признак
// в истории); 390/360 px без горизонтальной прокрутки, тёмная тема 1280 px, нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-08/ui-check.mjs → artifacts/stage-08/ui-check.log.
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
const DB = 'kontur_kp_ui08_test';
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
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui08-')),
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
const key = () => `ui08-${randomBytes(6).toString('hex')}`;
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
  'Раздел;Текст\nФасад;Фасад должен быть облицован клинкерным кирпичом.\nКровля;Требуется кровля из профнастила С-44.\nПрочее;Пояснительная записка к проекту.\n',
  'utf8',
);

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

  // ---- Документ ТЗ (CSV) → локальное распознавание → замороженный набор → снимок области
  const up = await uploadBytes(stageId, 'тз-требования.csv', CSV);
  const rev = await registered(up.body.id);
  record('документ ТЗ загружен штатным импортом', Boolean(rev));
  await api(`/document-revisions/${rev}/local-recognitions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const run = await runOf(rev);
  record('локальное распознавание CSV завершено', run?.status === 'complete', run?.status ?? 'нет прогона');
  const draft = await api(`/stages/${stageId}/source-set-revisions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  const put = await api(`/source-set-revisions/${draft.body.id}/items`, { method: 'PUT', headers: { ...json, 'If-Match': draft.etag }, body: JSON.stringify({ items: [{ documentRevisionId: rev, inclusion: 'included' }] }) });
  await api(`/source-set-revisions/${draft.body.id}/freeze`, { method: 'POST', headers: { ...json, 'If-Match': put.etag, 'Idempotency-Key': key() }, body: '{}' });
  const scope = await api(`/stages/${stageId}/evidence-scopes`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  record('снимок области зафиксирован', [200, 201].includes(scope.status), String(scope.status));

  // ---- 390 px: реестр требований
  const tabUrl = `${BASE}/stages/${stageId}?tab=requirements`;
  await send('Page.navigate', { url: tabUrl });
  record('вкладка «Требования»: реестра нет — пустое состояние с действием', await waitFor(`${text('Реестр требований не создан')} && ${text('Создать реестр')}`));
  record('нет горизонтальной прокрутки на 390 px (пустой реестр)', await noHorizontalScroll());
  await clickButton('Создать реестр');
  await waitFor(text('Создать реестр требований'));
  await waitFor(`document.querySelectorAll('option').length > 1`);
  await fillField('Снимок области доказательств', scope.body.id);
  await fillField('Причина', 'Первичный реестр этапа');
  await clickButton('Создать');
  record('реестр № 1 создан диалогом и активен', await waitFor(`${text('Реестр № 1')} && ${text('Активный')}`));
  await shot('390-registry');

  // ---- Анализ моделью (поддельный провайдер)
  await clickButton('Анализ моделью');
  await waitFor(text('Найти кандидатов требований'));
  await clickButton('Найти кандидатов требований');
  record('прогон модели завершён, кандидаты предложены', await waitFor(`${text('Завершён')} && ${text('кандидатов: 2')}`, 30_000));
  await shot('390-analysis');

  // ---- Кандидаты: обход по одному, подтверждение руководителем
  await clickButton('Кандидаты');
  record('кандидаты модели помечены «Гипотеза модели»; обход по одному', await waitFor(`${text('Гипотеза модели')} && ${text('1 из 2')} && ${text('Ждёт решения')}`));
  record('нет горизонтальной прокрутки на 390 px (кандидаты)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('390-candidates');
  await clickButton('Подтвердить');
  record('подтверждение кандидата — следующий в очереди', await waitFor(`${text('Подтверждено')} && ${text('1 из 1')}`));

  // ---- Реестр и карточка требования
  await clickButton('Реестр');
  record('реестр: R-0001 подтверждено человеком, покрытие не оценено', await waitFor(`${text('R-0001')} && ${text('Подтверждено человеком')} && ${text('Покрытие не оценено')}`));
  await clickLink('R-0001');
  record('карточка требования: формулировка, основание, ревизии', await waitFor(`${text('Требование R-0001')} && ${text('Основание')} && ${text('Ревизия 1')} && ${text('Открыть цитату')}`));
  await fillField('Решение', 'Принять облицовку клинкерным кирпичом по ТЗ');
  await fillField('Обоснование', 'Раздел АР, лист 3');
  await clickButton('Записать решение');
  record('решение по требованию записано и действует', await waitFor(`${text('Принять облицовку клинкерным кирпичом по ТЗ')} && ${text('Действует')}`));
  await fillField('Состояние покрытия', 'uncovered');
  await clickButton('Записать оценку');
  record('оценка покрытия «Нет покрытия в расчёте» в истории', await waitFor(`${text('Нет покрытия в расчёте')} && ${text('Человек')}`));
  record('нет горизонтальной прокрутки на 390 px (карточка требования)', await noHorizontalScroll());
  await shot('390-requirement');
  const reqUrl = await evaluate('location.href');

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: reqUrl });
  await waitFor(text('Требование R-0001'));
  await sleep(300);
  record('нет горизонтальной прокрутки на 360 px (карточка требования)', await noHorizontalScroll());
  record('360 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('360-requirement');

  // ---- R08-01: конфликт требований — явная отметка, подтверждение только с пояснением
  const regId = (await api(`/stages/${stageId}/requirement-registry`)).body.active.id;
  const frags = (await api(`/requirement-registries/${regId}/fragments?limit=500`)).body.items;
  const fragOf = (t) => frags.find((f) => (f.text ?? '').includes(t))?.fragmentId;
  const propose = (statement, parameters, fragment) =>
    api(`/requirement-registries/${regId}/requirement-candidates`, {
      method: 'POST',
      headers: { ...json, 'Idempotency-Key': key() },
      body: JSON.stringify({ statement, parameters, evidence: [{ fragmentId: fragment, role: 'supports' }] }),
    });
  const first = await propose('Класс бетона плиты — B30', [{ name: 'Класс бетона', value: 'B30' }], fragOf('профнастила'));
  const firstOk = await api(`/requirement-candidates/${first.body.id}/confirm`, { method: 'POST', headers: { ...json, 'If-Match': first.etag, 'Idempotency-Key': key() }, body: '{}' });
  const second = await propose('Класс бетона плиты — B40', [{ name: 'Класс бетона', value: 'B40' }], fragOf('клинкерным'));
  record('API: R-0002 подтверждено, второй кандидат с тем же параметром в очереди', firstOk.status === 200 && second.status === 201, `${firstOk.status}/${second.status}`);
  await send('Page.navigate', { url: tabUrl });
  await waitFor(text('Реестр № 1'));
  await clickButton('Кандидаты');
  await waitFor(text('Ждёт решения'));
  for (let i = 0; i < 3 && !(await evaluate(text('Конфликт: R-0002'))); i += 1) await clickButton('Далее');
  record('кандидат с конфликтом: отметка «Конфликт: R-0002» и предупреждение с параметром', await waitFor(`${text('Конфликт: R-0002')} && ${text('Противоречит действующим требованиям: R-0002 («класс бетона»)')}`));
  record(
    'без пояснения кнопка «Подтвердить» недоступна',
    await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Подтвердить' && b.disabled)`),
  );
  record('нет горизонтальной прокрутки на 360 px (кандидат с конфликтом)', await noHorizontalScroll());
  await shot('360-candidate-conflict');
  await fillField('Пояснение к конфликту', 'Класс уточнён письмом заказчика; вопрос направлен');
  await clickButton('Подтвердить');
  await waitFor(text('Подтверждено'));
  await clickButton('Реестр');
  record(
    'реестр: конфликт показан у обоих требований',
    await waitFor(`[...document.querySelectorAll('[title^="Конфликт: "]')].length >= 2 && ${text('R-0003')}`),
  );
  await clickLink('R-0003');
  record(
    'карточка: конфликт с параметром и пояснение подтверждения',
    await waitFor(`${text('Конфликт с действующими требованиями: R-0002 («класс бетона»)')} && ${text('Пояснение к конфликту при подтверждении: Класс уточнён письмом заказчика')}`),
  );

  // ---- R08-01: несовпадение единиц покрытия (поддельный TenderHub, ревизия расчёта этапа)
  const src = await api(`/stages/${stageId}/calculation-source`);
  await api(`/stages/${stageId}/calculation-source`, { method: 'PUT', headers: { ...json, 'If-Match': src.etag }, body: JSON.stringify({ externalTenderId: TH.tender, externalVersion: null }) });
  if ((await api(`/stages/${stageId}/calculation-captures`)).body.items.length === 0) {
    await api(`/stages/${stageId}/calculation-captures`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: '{}' });
  }
  const calcId = await poll(async () => (await api(`/stages/${stageId}/calculation-revisions`)).body.items?.[0]?.id ?? null, 60_000);
  record('ревизия расчёта этапа выгружена', Boolean(calcId));
  const area = await propose('Утепление стен — 120 м²', [{ name: 'Площадь утепления', value: '120', unit: 'м²' }], fragOf('клинкерным'));
  const areaOk = await api(`/requirement-candidates/${area.body.id}/confirm`, { method: 'POST', headers: { ...json, 'If-Match': area.etag, 'Idempotency-Key': key() }, body: '{}' });
  await send('Page.navigate', { url: `${BASE}/requirements/${areaOk.body.requirementId}` });
  await waitFor(text('Требование R-0004'));
  await fillField('Состояние покрытия', 'covered');
  await waitFor(`document.querySelector('option[value="${calcId}"]') !== null`);
  await fillField('Ревизия расчёта', calcId);
  await waitFor(`document.querySelector('option[value="${TH.p1}"]') !== null`);
  await fillField('Позиция', TH.p1);
  await waitFor(`document.querySelector('option[value="${TH.l2}"]') !== null`);
  await fillField('Строка', TH.l2);
  await clickButton('Добавить позицию расчёта');
  await clickButton('Записать оценку');
  record(
    'несовпадение единиц показано явно, оценка без пояснения не записана',
    await waitFor(`${text('единица требования м2, в расчёте м3')} && ${text('Пояснение к несовпадению единиц')} && ${text('Покрытие ещё не оценивалось')}`),
  );
  record('нет горизонтальной прокрутки на 360 px (несовпадение единиц)', await noHorizontalScroll());
  await shot('360-unit-mismatch');
  await fillField('Пояснение к несовпадению единиц', 'В расчёте объём утеплителя, площадь пересчитана по толщине 0,1 м');
  await clickButton('Записать оценку');
  record(
    'оценка с пояснением записана, признак «Единица не совпадает с расчётом» в истории',
    await waitFor(`${text('Пояснение к единицам: В расчёте объём утеплителя')} && [...document.querySelectorAll('[title="Единица не совпадает с расчётом"]')].length >= 2`),
  );

  // ---- Полнота: пакетная отметка и завершение прохода
  await send('Page.navigate', { url: tabUrl });
  await waitFor(text('Реестр № 1'));
  await clickButton('Полнота');
  record('полнота: счётчики по фрагментам, есть непросмотренные', await waitFor(`${text('Не просмотрено')} && ${text('Связаны с требованиями')}`));
  await fillField('Причина отметки', 'Справочный текст, требований нет');
  await clickButton('Всё остальное — не требование');
  record('пакетная отметка по документу — все фрагменты просмотрены', await waitFor(text('Просмотрено')));
  await clickButton('Завершить проход полноты');
  record('проход полноты завершён', await waitFor(text('Последнее завершение прохода')));
  record('нет горизонтальной прокрутки на 360 px (полнота)', await noHorizontalScroll());
  await shot('360-completeness');

  // ---- Допущения и вопросы
  await clickButton('Допущения и вопросы');
  await waitFor(text('Допущения ПД'));
  await fillField('Новое допущение', 'Толщина плиты принята 300 мм до выхода РД');
  await clickButton('Добавить');
  record('допущение создано открытым', await waitFor(`${text('Толщина плиты принята 300 мм до выхода РД')} && ${text('Открыто')}`));
  await fillField('Новый вопрос', 'Уточните марку бетона плиты');
  await clickButton('Добавить черновик');
  await waitFor(text('Черновик'));
  await clickButton('Отправлен');
  record('вопрос заказчику: черновик → отправлен (отправку делает человек)', await waitFor(text('отправлен ')));

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: reqUrl });
  await waitFor(text('Требование R-0001'));
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record('тёмная тема, 1280 px: карточка требования читается', await waitFor(`${text('Ревизии')} && ${text('Покрытие')} && ${text('Решения')}`));
  if (SHOTS) await sleep(500);
  await shot('1280-dark-requirement');

  // ---- Инженер: предлагает, но не подтверждает
  await logout();
  record('вход инженера тендера', await login('demo.eng1'));
  await send('Page.navigate', { url: tabUrl });
  await waitFor(text('Реестр № 1'));
  await clickButton('Кандидаты');
  await waitFor(text('Предложить требование'));
  record('у инженера нет кнопки подтверждения кандидата', !(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Подтвердить')`)));
  record('инженер может предложить требование', await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Предложить требование')`));

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

const out = join(ROOT, 'artifacts', 'stage-08');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(join(out, 'ui-check.log'), `# ui-check — ${new Date().toISOString()}, Chromium headless (CDP)${sandbox}, реальные server + worker, MODEL_PROVIDER=fake, поддельный TenderHub\n${lines.join('\n')}\n${summary}\n`);
console.log(summary);
process.exit(failed ? 1 : 0);
