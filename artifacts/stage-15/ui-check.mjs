// Этап 15: отправка выпуска и сравнение выпусков в интерфейсе — headless Chromium (CDP) против настоящих server + worker с
// LibreOffice (D-035; проект §14). Данные ПОДДЕЛЬНЫЕ: поддельный TenderHub и модель; боевой комплект проходит матрицу
// блокеров на данных фикстуры (ревизия расчёта verified по контрактной фикстуре X-01 с правилом итога КП фикстуры —
// artifacts/stage-15/fixture-verified-revision.ts; форма без отметки «демо»). Письма — синтетические EML в ящике портала;
// MailHub не участвует (BLOCKED_EXTERNAL). Проверяется на смартфоне 390 px: блок «Отправка» у боевого выпуска — «не
// зарегистрирована» (не «не отправлено»), диалог регистрации (фокус «Отмена») со списком отправленных писем и сверкой
// вложений, запись «Подтверждена»; письмо с лишним вложением — «Состав не совпал», руководитель принимает лишние
// вложения с причиной; регистрация по пояснению — «состав не сверялся», «Повторная»; у тестового выпуска — только
// нарушение. Раздел тендера «Сравнение выпусков»: выбор двух выпусков, результат по разделам, доказательства, причина
// вывода «не установлена» → «гипотеза». 360/390/430 px без горизонтальной прокрутки; 1280 px, тёмная тема; нет ошибок
// консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH, LibreOffice.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-15/ui-check.mjs → artifacts/stage-15/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const DB = 'kontur_kp_ui15_test';
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
const V1 = id('f', 1);
const POS = id('a', 1);
const LINE = id('c', 1);
// Одна ревизия расчёта; итог источника 120 002 315,50 ₽ = 120,00 млн руб. — цена КП в письме сверяется с ним (D-032 В-12-6).
const line = (t, pos, lid, desc, wn, q, r, k) => {
  const total = String(Number(q) * Number(r));
  return fakeItem(t, pos, lid, { boq_item_type: 'раб', description: desc, work_name_id: wn, unit_code: 'м2', quantity: n(q), base_quantity: n(q), unit_rate: n(r), currency_type: 'RUB', total_amount: n(total), commercial_markup: n(k), total_commercial_material_cost: n('0'), total_commercial_work_cost: n(String(Number(total) * Number(k))) });
};
const items = [line(V1, POS, LINE, 'Штукатурка стен', 'w-plaster', '100000', '1000', '1.2')];
hub.tenders.set(
  V1,
  fakeTender({
    id: V1,
    tender_number: 'TH-UI-15',
    title: 'Корпус 15 — отправка и сравнение',
    version: 1,
    usd_rate: n('90'),
    cached_grand_total: n('120002315.5'),
    positions: [
      fakePosition(V1, id('a', 0), { position_number: n('1'), item_no: '1', work_name: 'Раздел 1', is_section: true, unit_code: null, volume: null, manual_volume: null }),
      fakePosition(V1, POS, { position_number: n('1.1'), item_no: '1.1', work_name: 'Штукатурка стен', unit_code: 'м2', volume: n('100000'), manual_volume: n('100000'), items_count: n('1'), base_total: n('100000000'), commercial_total: n('120000000'), work_cost_total: n('120000000') }),
    ],
    items,
  }),
);
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui15-')),
  TENDERHUB_INSTANCE_ID: 'th-ui-15',
  TENDERHUB_URL: hub.url,
  TENDERHUB_API_KEY: TH_KEY,
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
  // Модель — поддельный провайдер: проверка гипотез выполняется (D-029 В-09-5), живой модели на машине разработки нет.
  MODEL_PROVIDER: 'fake',
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
const key = () => `ui15-${randomBytes(6).toString('hex')}`;
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
// Карточка комплекта: кнопка списка «Комплект № N».
// Отрывок текста страницы для пояснения провала проверки.
const excerpt = (needle) =>
  evaluate(`(() => { const t = document.body?.innerText ?? ''; const i = t.indexOf(${JSON.stringify(needle)}); return (i < 0 ? t.slice(0, 160) : t.slice(Math.max(0, i - 40), i + 160)).replace(/\\s+/g, ' '); })()`);
const openCandidate = async (n) => {
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=release` });
  await waitFor(text(`Комплект № ${n}`), 20_000);
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.startsWith('Комплект № ${n} ')); b?.click(); return Boolean(b); })()`);
  return waitFor(`document.querySelector('[aria-label="Цепочка выпуска"]')`, 20_000);
};

// Два требования: штукатурка покрыта строкой расчёта, окраска — без оценки покрытия (снимаемый бизнес-пункт
// REVIEW_UNCERTAIN, D-033 ут. 1): руководитель принимает по нему риск с причиной.
const CSV = Buffer.from('Раздел;Текст\nОтделка;Штукатурка стен выполняется по всей площади.\nФасад;Окраска фасада выполняется в два слоя.\n', 'utf8');
const LETTER = {
  letter_date: '2026-10-07',
  letter_number: '04/26-15-ТО',
  addressee: 'Тендерному управлению заказчика (демо)',
  subject: 'Строительство демонстрационного объекта',
  materials_price_date: '2026-09-01',
  advance_percent: '30',
  duration_months: '32',
  validity_days: '30',
  kp_price: '120.00',
};
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
    ['--headless=new', '--disable-gpu', '--no-first-run', ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'kontur-chrome-'))}`, 'about:blank'],
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

  // ---- Подготовка (руководитель через API): ТЗ, снимок, расчёт, реестр, требование с покрытием, проход, проверка
  record('вход администратора-руководителя', await login('demo.admin'));
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const me = (await api('/me')).body;
  const card = await api(`/tenders/${demo.id}`);
  await api(`/tenders/${demo.id}/members/${me.id}`, { method: 'PUT', headers: { ...json, 'If-Match': card.etag }, body: JSON.stringify({ memberRole: 'manager' }) });
  STAGE = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;
  const up = await uploadBytes(STAGE, 'тз-отделка.csv', CSV);
  const rev = await registered(up.body.id);
  await post(`/document-revisions/${rev}/local-recognitions`, {});
  const run = await runOf(rev);
  const draftSet = await post(`/stages/${STAGE}/source-set-revisions`, {});
  const put = await api(`/source-set-revisions/${draftSet.body.id}/items`, { method: 'PUT', headers: { ...json, 'If-Match': draftSet.etag }, body: JSON.stringify({ items: [{ documentRevisionId: rev, inclusion: 'included' }] }) });
  await post(`/source-set-revisions/${draftSet.body.id}/freeze`, {}, { 'If-Match': put.etag });
  const scope = await post(`/stages/${STAGE}/evidence-scopes`, {});
  const src = await api(`/stages/${STAGE}/calculation-source`);
  await api(`/stages/${STAGE}/calculation-source`, { method: 'PUT', headers: { ...json, 'If-Match': src.etag }, body: JSON.stringify({ externalTenderId: V1, externalVersion: 1 }) });
  const capture = await post(`/stages/${STAGE}/calculation-captures`, {});
  const cap = await poll(async () => {
    const c = (await api(`/calculation-captures/${capture.body.id}`)).body;
    return c?.status === 'complete' || c?.status === 'failed' ? c : null;
  }, 60_000);
  // Поддельные данные боевого режима: ревизия verified по контрактной фикстуре X-01 (блокеры не отключаются).
  // Асинхронно: поддельный TenderHub работает в этом же процессе и должен отвечать, пока фикстура читает расчёт.
  const fx = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['artifacts/stage-15/fixture-verified-revision.ts', STAGE, V1], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const VERIFIED = fx.status === 0 ? fx.stdout.trim().split('\n').pop() : null;
  record('поддельные данные боевого режима: ревизия расчёта verified по контрактной фикстуре X-01 (не интеграция)', Boolean(VERIFIED), fx.stderr.trim().slice(0, 200));
  const reg = await post(`/stages/${STAGE}/requirement-registries`, { evidenceScopeId: scope.body.id, reason: 'Реестр UI этапа 15' });
  const frags = (await api(`/requirement-registries/${reg.body.id}/fragments`)).body.items ?? [];
  const target = frags.find((f) => (f.text ?? '').includes('Штукатурка стен'));
  const cand = target
    ? await post(`/requirement-registries/${reg.body.id}/requirement-candidates`, { statement: 'Штукатурка стен по всей площади', parameters: [], evidence: [{ fragmentId: target.fragmentId, role: 'supports' }] })
    : null;
  const candCard = cand ? await api(`/requirement-candidates/${cand.body.id}`) : null;
  const confirmed = candCard ? await post(`/requirement-candidates/${cand.body.id}/confirm`, {}, { 'If-Match': candCard.etag }) : null;
  const paint = frags.find((f) => (f.text ?? '').includes('Окраска фасада'));
  const cand2 = paint
    ? await post(`/requirement-registries/${reg.body.id}/requirement-candidates`, { statement: 'Окраска фасада в два слоя', parameters: [], evidence: [{ fragmentId: paint.fragmentId, role: 'supports' }] })
    : null;
  const cand2Card = cand2 ? await api(`/requirement-candidates/${cand2.body.id}`) : null;
  if (cand2Card) await post(`/requirement-candidates/${cand2.body.id}/confirm`, {}, { 'If-Match': cand2Card.etag });
  const rest = frags.filter((f) => f.fragmentId !== target?.fragmentId && f.fragmentId !== paint?.fragmentId).map((f) => f.fragmentId);
  if (rest.length) await post(`/requirement-registries/${reg.body.id}/marks`, { mark: 'not_requirement', reason: 'Заголовок таблицы ТЗ', selector: { kind: 'fragments', fragmentIds: rest } });
  const cov = confirmed?.body?.revisionId
    ? await post(`/requirement-revisions/${confirmed.body.revisionId}/coverage`, {
        state: 'covered',
        objects: [{ type: 'calculation_revision', calculationRevisionId: VERIFIED, externalPositionId: POS, externalItemId: LINE, match: 'explicit_line' }],
      })
    : null;
  const pass = await post(`/requirement-registries/${reg.body.id}/reviews`, {});
  // Прогон проверок без пробелов обработки: факты D-018 извлекает worker; при «факты не извлечены» прогон повторяется.
  let reviewRun = null;
  for (let attempt = 0; attempt < 8 && !reviewRun; attempt += 1) {
    const started = await post(`/stages/${STAGE}/review-runs`, {});
    const done = await poll(async () => {
      const r = (await api(`/review-runs/${started.body.id}`)).body;
      return ['completed', 'completed_with_gaps', 'failed'].includes(r?.status) ? r : null;
    }, 90_000);
    const gaps = (done?.checks ?? []).filter((c) => (c.outcome === 'incomplete' && c.code !== 'coverage') || c.outcome === 'error');
    if (done && gaps.length === 0 && done.checks.some((c) => c.code === 'coverage' && c.outcome === 'incomplete')) reviewRun = done;
    else await sleep(3000);
  }
  record(
    'этап подготовлен: ТЗ, снимок, расчёт, требование с покрытием, завершённый проход реестра, прогон проверок без пробелов обработки',
    run?.status === 'complete' && cap?.status === 'complete' && confirmed?.status === 200 && cov?.status === 201 && pass.status === 201 && Boolean(reviewRun),
    `${run?.status}/${cap?.status}/${confirmed?.status}/${cov?.status}/${pass.status}/${reviewRun?.status ?? 'нет прогона'}`,
  );
  // ---- Форма без отметки «демо» (поддельная), приложение, боевой и тестовый комплекты
  const sample = async (file) => {
    const bytes = readFileSync(join(ROOT, 'docs/forms/samples', file));
    return evaluate(`(async () => {
      const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('kkp_csrf=')) ?? '').slice(9));
      const body = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), (c) => c.charCodeAt(0));
      const r = await fetch('/api/v1/form-samples?name=' + encodeURIComponent(${JSON.stringify(file)}), { method: 'POST', headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream', 'Idempotency-Key': ${JSON.stringify(key())} }, body });
      return (await r.json()).sha256;
    })()`);
  };
  const schema = JSON.parse(readFileSync(join(ROOT, 'docs/forms/demo-kp-letter.forms.json'), 'utf8'));
  const tpl = await post('/application-templates', { ownerKind: 'company', name: 'Письмо КП (фикстура, этап 15)', isDemo: false });
  const tRev = await post(`/application-templates/${tpl.body.id}/revisions`, {
    schema,
    sample: { sha256: await sample('demo-kp-letter.original.docx'), name: 'demo-kp-letter.original.docx' },
    markedSample: { sha256: await sample('demo-kp-letter.marked.docx'), name: 'demo-kp-letter.marked.docx' },
    audience: 'customer',
  });
  await api(`/template-revisions/${tRev.body.id}/approve`, { method: 'POST', headers: { ...json, 'If-Match': tRev.etag }, body: '{"basisFragmentIds":[]}' });
  const d = await post(`/stages/${STAGE}/application-drafts`, { templateRevisionId: tRev.body.id, title: 'Письмо КП' });
  for (const [k, v] of Object.entries(LETTER)) {
    const view = (await api(`/application-drafts/${d.body.id}`)).body;
    const f = view.sections.flatMap((s) => s.fields).find((x) => x.key === k);
    await api(`/application-drafts/${d.body.id}/fields/${k}`, { method: 'PUT', headers: { ...json, 'If-Match': f.etag }, body: JSON.stringify({ action: 'set', value: v, bases: [] }) });
  }
  const dv = (await api(`/application-drafts/${d.body.id}`)).body;
  await api(`/application-drafts/${d.body.id}/complete`, { method: 'POST', headers: { ...json, 'If-Match': dv.etag }, body: '{}' });
  const assemble = async (mode) => {
    const c = await post(`/stages/${STAGE}/release-candidates`, { mode, draftIds: [d.body.id] });
    return poll(async () => {
      const v = (await api(`/release-candidates/${c.body.id}`)).body;
      return v?.status && v.status !== 'assembling' ? v : null;
    }, 180_000);
  };
  const prod = await assemble('production');
  const test = await assemble('test');
  record('боевой (на поддельных данных) и тестовый комплекты собраны worker с LibreOffice', prod?.status === 'ready_for_approval' && test?.status === 'ready_for_approval', `${prod?.status}${prod?.failure ? `: ${prod.failure.code}` : ''}/${test?.status}`);
  const notApplicable = async (candidateId, reason) => {
    const holds = (await api(`/stages/${STAGE}/holds?candidateId=${candidateId}&status=open`)).body.items ?? [];
    if (holds.length === 0) return 0;
    const r = await post(`/release-candidates/${candidateId}/holds/resolve`, { holdIds: holds.map((h) => h.id), resolution: 'not_applicable', reason });
    return r.status === 200 ? holds.length : -1;
  };
  // Руководитель: решения по удержаниям, принятие рисков, согласование.
  const approve = async (id) => {
    await notApplicable(id, 'Не влияет на комплект');
    let cv = (await api(`/release-candidates/${id}`)).body;
    for (const b of cv.gate?.approve?.blockers ?? []) {
      if (!b.acceptable) continue;
      for (const i of b.items.filter((x) => !x.acceptance)) {
        await post(`/release-candidates/${id}/risk-acceptances`, { blockerCode: b.code, subjectType: i.subjectType, subjectId: i.subjectId, subjectKey: i.subjectKey, reason: 'Риск принят руководителем для проверки интерфейса' });
      }
    }
    cv = (await api(`/release-candidates/${id}`)).body;
    return post(`/release-candidates/${id}/approve`, { contentHash: cv.contentHash, compositionHash: cv.gate?.approve?.compositionHash }, { 'If-Match': cv.etag });
  };
  const apprProd = await approve(prod.id);
  const apprTest = await approve(test.id);
  // Ящик отправленных: инженер читает, импортирует и связывает; руководитель читает.
  const users = (await api('/admin/users')).body.items ?? [];
  const eng1 = users.find((u) => u.login === 'demo.eng1');
  const box = await post('/mailboxes', { system: 'manual', externalAccountId: 'tender-out@contractor.example.test', displayName: 'Тендерный отдел' });
  const grant = async (userId, capabilities) => {
    const card = await api(`/mailboxes/${box.body.id}`);
    return api(`/mailboxes/${box.body.id}/access/${userId}`, { method: 'PUT', headers: { ...json, 'If-Match': card.etag }, body: JSON.stringify({ capabilities }) });
  };
  const g1 = await grant(eng1?.id, ['mail.read', 'mail.import', 'mail.link']);
  const g2 = await grant(me.id, ['mail.read']);
  record('ящик «Тендерный отдел» зарегистрирован; доступ инженеру (чтение, импорт, связь) и руководителю (чтение)', box.status === 201 && g1.status === 200 && g2.status === 200, `HTTP ${box.status}/${g1.status}/${g2.status}`);
  await logout();

  // ---- Инженер: выпуск обоих комплектов, импорт двух отправленных писем (EML) и связь с тендером
  record('вход инженера', await login('demo.eng1'));
  const release = async (id, approvalId) => {
    const cv = (await api(`/release-candidates/${id}`)).body;
    return post(`/release-candidates/${id}/release`, { approvalId, contentHash: cv.contentHash, compositionHash: cv.gate?.release?.compositionHash }, { 'If-Match': cv.etag });
  };
  const relProd = await release(prod.id, apprProd.body?.approval?.id);
  const relTest = await release(test.id, apprTest.body?.approval?.id);
  record('боевой и тестовый комплекты согласованы и выпущены', apprProd.status === 200 && apprTest.status === 200 && relProd.status === 201 && relTest.status === 201, `HTTP ${apprProd.status}/${apprTest.status}/${relProd.status}/${relTest.status}`);
  const RELEASE = relProd.body?.release?.id;
  const kit = [];
  for (const f of ((await api(`/release-candidates/${prod.id}`)).body.files ?? []).filter((x) => x.audience === 'customer')) {
    const b64 = await evaluate(`(async () => { const r = await fetch('/api/v1/candidate-files/${f.id}/content'); const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
    kit.push({ name: f.path, type: 'application/octet-stream', bytes: Buffer.from(b64, 'base64') });
  }
  const b64lines = (buf) => buf.toString('base64').replace(/.{76}/gu, '$&\r\n');
  const word = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  const eml = (subject, attachments) => {
    const boundary = `b-${randomBytes(6).toString('hex')}`;
    const parts = [
      ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from('Направляем коммерческое предложение.', 'utf8'))].join('\r\n'),
      ...attachments.map((a) => [`Content-Type: ${a.type}; name="${word(a.name)}"`, `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; filename="${word(a.name)}"`, 'Content-Transfer-Encoding: base64', '', b64lines(a.bytes)].join('\r\n')),
    ];
    return Buffer.from(
      [
        'From: =?UTF-8?B?0KLQtdC90LTQtdGA0L3Ri9C5INC+0YLQtNC10Ls=?= <tender-out@contractor.example.test>',
        'To: customer@example.test',
        `Subject: ${word(subject)}`,
        `Date: ${new Date(Date.now() + 2000).toUTCString()}`,
        `Message-ID: <ui15-${randomBytes(6).toString('hex')}@contractor.example.test>`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        ...parts.flatMap((p) => [`--${boundary}`, p]),
        `--${boundary}--`,
        '',
      ].join('\r\n'),
      'utf8',
    );
  };
  const importLetter = async (subject, attachments) => {
    const raw = eml(subject, attachments);
    const q = new URLSearchParams({ name: 'letter.eml', direction: 'outbound', tenderId: demo.id, stageId: STAGE }).toString();
    const r = await evaluate(`(async () => {
      const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('kkp_csrf=')) ?? '').slice(9));
      const body = Uint8Array.from(atob(${JSON.stringify(raw.toString('base64'))}), (c) => c.charCodeAt(0));
      const r = await fetch('/api/v1/mailboxes/${box.body.id}/imports?${q}', { method: 'POST', headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream', 'Idempotency-Key': ${JSON.stringify(key())} }, body });
      return { status: r.status, body: await r.json() };
    })()`);
    return poll(async () => {
      const i = (await api(`/mail-imports/${r.body.id}`)).body;
      return i?.status === 'done' || i?.status === 'failed' ? i : null;
    }, 60_000);
  };
  const letter1 = await importLetter('КП по корпусу 15 — комплект', kit);
  const letter2 = await importLetter('КП по корпусу 15 — с подписью', [...kit, { name: 'Подпись руководителя.png', type: 'image/png', bytes: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), inline: true }]);
  record('два отправленных письма (синтетические EML) импортированы в ящик и связаны с тендером', letter1?.status === 'done' && letter2?.status === 'done', `${letter1?.status}/${letter2?.status}`);

  // ---- Смартфон 390 px: блок «Отправка» до регистрации
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=release` });
  record(
    'боевой выпуск: «Отправка не зарегистрирована», «Сведений об отправке нет. Это не значит, что комплект не отправлен», подпись про получение',
    await waitFor(`${text('Отправка не зарегистрирована')} && ${text('Это не значит, что комплект не отправлен')} && ${text('не означает, что заказчик получил или принял комплект')}`, 30_000),
    await excerpt('Отправка'),
  );
  record('связь письма с тендером — событие этапа: «Отправка удержана», кнопки регистрации нет до решения руководителя', await waitFor(`${text('Отправка удержана: по новым событиям этапа нужно решение руководителя')} && ![...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Зарегистрировать отправку…')`, 15_000), await excerpt('удержана'));
  record('тестовый выпуск: «Тестовый выпуск не отправляется», MailHub — автоматического чтения нет (X-03)', await waitFor(`${text('Тестовый выпуск не отправляется')} && ${text('автоматического чтения отправленных писем нет (X-03)')}`, 15_000));
  await logout();
  record('вход руководителя', await login('demo.admin'));
  const cleared = await notApplicable(prod.id, 'Наши исходящие письма с комплектом на него не влияют');
  record('руководитель решил по событиям писем «не влияет»', cleared > 0, String(cleared));
  await logout();

  // ---- Инженер, 390 px: регистрация по письму
  record('вход инженера', await login('demo.eng1'));
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=release` });
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Зарегистрировать отправку…')`, 30_000);
  const toSends = () => evaluate(`(() => { const el = [...document.querySelectorAll('[aria-label="Отправка"]')].find((x) => !x.innerText.includes('Тестовый выпуск не отправляется')); el?.scrollIntoView({ block: 'start' }); return Boolean(el); })()`);
  await toSends();
  await sleep(300);
  await shot('390-send-empty');
  await clickButton('Зарегистрировать отправку…');
  await waitFor(`document.querySelector('dialog[open]')`);
  record(
    'диалог регистрации: начальный фокус «Отмена»; письма со сверкой — «вложения совпадают с комплектом» и «лишних вложений: 1»',
    await waitFor(`document.activeElement?.innerText?.trim() === 'Отмена' && ${text('вложения совпадают с комплектом')} && ${text('лишних вложений: 1')} && ${text('Получение и согласие заказчика она не подтверждает')}`, 20_000),
    await excerpt('Отправленные письма'),
  );
  record('предупреждение о размещении не мешает регистрации (В-15-2)', await waitFor(text('Выпуск ещё не размещён во всех назначениях. Регистрации это не мешает')));
  await shot('390-send-dialog');
  for (const [w, h] of [[360, 780], [390, 844], [430, 932]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    await sleep(300);
    record(`${w} px: диалог регистрации отправки без горизонтальной прокрутки`, (await dialogFits()) && (await noHorizontalScroll()));
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  const pickLetter = (subject) =>
    evaluate(`(() => { const l = [...document.querySelectorAll('dialog[open] label')].find((x) => x.innerText.includes(${JSON.stringify(subject)})); const i = l?.querySelector('input[type=radio]'); if (!i || i.disabled) return false; i.click(); return true; })()`);
  const picked = await pickLetter('КП по корпусу 15 — комплект');
  await clickInDialog('Зарегистрировать');
  record(
    'письмо с точными файлами комплекта: «Отправка № 1 · Электронная почта», «Подтверждена», «Отправка подтверждена»',
    picked && (await waitFor(`!document.querySelector('dialog[open]') && ${text('Отправка № 1 · Электронная почта')} && ${text('Подтверждена')} && ${text('Отправка подтверждена')}`, 30_000)),
    await excerpt('Отправка №'),
  );
  // Второе письмо — с лишним встроенным вложением.
  await clickButton('Зарегистрировать отправку…');
  await waitFor(`document.querySelector('dialog[open]') && ${text('уже зарегистрировано как отправка этого выпуска')}`, 20_000);
  record('зарегистрированное письмо в списке отмечено и недоступно для выбора', !(await pickLetter('КП по корпусу 15 — комплект')));
  const picked2 = await pickLetter('КП по корпусу 15 — с подписью');
  await clickInDialog('Зарегистрировать');
  record(
    'письмо с лишним вложением: «Состав не совпал», «Не считается отправкой утверждённого комплекта», «Лишних вложений: 1»',
    picked2 && (await waitFor(`!document.querySelector('dialog[open]') && ${text('Отправка № 2')} && ${text('Состав не совпал')} && ${text('Не считается отправкой утверждённого комплекта')} && ${text('Лишних вложений: 1')}`, 30_000)),
    await excerpt('Отправка № 2'),
  );
  record('инженер принять лишние вложения не может: кнопки нет', !(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Принять лишние вложения…')`)));
  // Регистрация по пояснению.
  await clickButton('Зарегистрировать отправку…');
  await waitFor(`document.querySelector('dialog[open]')`);
  await evaluate(`(() => { const i = document.querySelector('dialog[open] input[value="manual_note"]'); i?.click(); return Boolean(i); })()`);
  await waitFor(text('Пояснение: как и что отправлено'));
  const setInput = (label, value) =>
    evaluate(`(() => { const d = document.querySelector('dialog[open]'); const l = [...d.querySelectorAll('label')].find((x) => x.innerText.startsWith(${JSON.stringify(label)}));
      const el = l && d.querySelector('#' + CSS.escape(l.htmlFor)); if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await clickInDialog('Зарегистрировать');
  record('пояснение короче 10 символов — подсказка у поля, запись не создаётся', await waitFor(`document.querySelector('dialog[open]') && ${text('Пояснение — не короче 10 символов')}`));
  const noted = (await setInput('Адресаты', 'Канцелярия заказчика')) && (await setInput('Пояснение', 'Комплект передан курьером, накладная № 15-001'));
  record('390 px: форма ручной регистрации без горизонтальной прокрутки', noted && (await dialogFits()) && (await noHorizontalScroll()));
  await clickInDialog('Зарегистрировать');
  record(
    'по пояснению: «Отправка № 3 · На бумаге», «Зарегистрирована без сверки», «Состав отправки не сверялся», «Повторная», «Основание — только пояснение, файла нет»',
    await waitFor(`!document.querySelector('dialog[open]') && ${text('Отправка № 3 · На бумаге')} && ${text('Зарегистрирована без сверки')} && ${text('Повторная')} && ${text('Основание — только пояснение, файла нет')}`, 30_000),
    await lacks('Отправка № 3 · На бумаге', 'Зарегистрирована без сверки', 'Повторная', 'Основание — только пояснение, файла нет'),
  );
  await evaluate(`(() => { const d = [...document.querySelectorAll('details')].filter((x) => x.innerText.startsWith('Вложения письма')); d.forEach((x) => { x.open = true; }); return d.length; })()`);
  record(
    'вложения письма: «файл комплекта: 01 Письмо КП.docx» и «Подпись руководителя.png (встроено в письмо) — нет в комплекте»',
    await waitFor(`${text('файл комплекта: 01 Письмо КП.docx')} && ${text('Подпись руководителя.png (встроено в письмо) — нет в комплекте')}`, 10_000),
    await lacks('файл комплекта: 01 Письмо КП.docx', 'Подпись руководителя.png (встроено в письмо) — нет в комплекте'),
  );
  await toSends();
  await sleep(300);
  await shot('390-sends');
  for (const [w, h] of [[360, 780], [390, 844], [430, 932]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    await sleep(300);
    record(`${w} px: блок «Отправка» с записями без горизонтальной прокрутки`, await noHorizontalScroll(), await overflowers());
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  // ---- Тестовый выпуск: только нарушение
  const inTest = (fn) => `(() => { const el = [...document.querySelectorAll('[aria-label="Отправка"]')].find((x) => x.innerText.includes('Тестовый выпуск не отправляется')); return el ? (${fn})(el) : false; })()`;
  record('у тестового выпуска нет «Зарегистрировать отправку…», есть «Зарегистрировать нарушение…»', await evaluate(inTest(`(el) => { const b = [...el.querySelectorAll('button')].map((x) => x.innerText.trim()); return !b.includes('Зарегистрировать отправку…') && b.includes('Зарегистрировать нарушение…'); }`)));
  await evaluate(inTest(`(el) => { const b = [...el.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Зарегистрировать нарушение…'); b?.click(); return Boolean(b); }`));
  await waitFor(`document.querySelector('dialog[open]')`);
  record('диалог нарушения: фокус «Отмена», «Нарушение — не отправка», вид «Тестовый комплект ушёл заказчику»', await waitFor(`document.activeElement?.innerText?.trim() === 'Отмена' && ${text('Нарушение — не отправка')} && ${text('Тестовый комплект ушёл заказчику')}`));
  await setInput('Описание', 'Тестовый комплект ошибочно отправлен заказчику письмом');
  record('390 px: диалог нарушения без горизонтальной прокрутки', (await dialogFits()) && (await noHorizontalScroll()));
  await clickInDialog('Зарегистрировать');
  record(
    'нарушение записано отдельно: «Нарушение: Тестовый комплект ушёл заказчику», «Отправкой не является»; выпуск остаётся тестовым',
    await waitFor(`!document.querySelector('dialog[open]') && ${text('Нарушение: Тестовый комплект ушёл заказчику')} && ${text('Отправкой не является')} && ${text('Нарушений: 1')} && ${text('Тестовый выпуск не отправляется')}`, 30_000),
    `${await lacks('Нарушение: Тестовый комплект ушёл заказчику', 'Отправкой не является', 'Нарушений: 1', 'Тестовый выпуск не отправляется')} диалог: ${await evaluate(`Boolean(document.querySelector('dialog[open]'))`)}`,
  );
  const state = (await api(`/releases/${RELEASE}/send-events`)).body;
  record('API: у боевого выпуска три записи — подтверждена, состав не совпал, зарегистрирована; засчитано 2', state?.items?.map((x) => x.status).join(',') === 'verified,disputed,registered' && state.summary.counted === 2, state?.items?.map((x) => x.status).join(','));
  await logout();

  // ---- Руководитель: принять лишние вложения
  record('вход руководителя', await login('demo.admin'));
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=release` });
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Принять лишние вложения…')`, 30_000);
  record('руководитель отправку не регистрирует: кнопки «Зарегистрировать отправку…» нет', !(await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Зарегистрировать отправку…')`)));
  await clickButton('Принять лишние вложения…');
  await waitFor(`document.querySelector('dialog[open] textarea')`);
  record('«Принять лишние вложения…»: фокус «Отмена», пояснение «Отменить решение нельзя»', await waitFor(`document.activeElement?.innerText?.trim() === 'Отмена' && ${text('Отменить решение нельзя')}`));
  await fillDialogText('Картинка подписи руководителя: к комплекту не относится');
  await clickInDialog('Принять');
  record('отправка № 2 — «Подтверждена», «Лишние вложения приняты»; расхождения больше нет', await waitFor(`!document.querySelector('dialog[open]') && ${text('Лишние вложения приняты')} && !${text('Не считается отправкой утверждённого комплекта')}`, 30_000), await excerpt('Отправка № 2'));
  // Цепочка выпуска в карточке комплекта.
  record(`карточка комплекта № ${prod.seq}: цепочка «Отправка зарегистрирована (3)»`, (await openCandidate(prod.seq)) && (await waitFor(text('Отправка зарегистрирована (3)'), 20_000)), await excerpt('Отправка зарегистрирована'));

  // ---- Раздел тендера «Сравнение выпусков»
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=compare` });
  record('раздел «Сравнение выпусков»: выбор двух выпусков, сравнений ещё нет', await waitFor(`${text('Первый выпуск')} && ${text('Второй выпуск')} && ${text('Сравнений ещё нет')}`, 30_000), await excerpt('Сравн'));
  const setSelect = (label, value) =>
    evaluate(`(() => { const l = [...document.querySelectorAll('label')].find((x) => x.innerText.startsWith(${JSON.stringify(label)}));
      const el = l && document.getElementById(l.htmlFor); if (!el) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const chosen = (await setSelect('Первый выпуск', relTest.body?.release?.id)) && (await setSelect('Второй выпуск', RELEASE));
  await clickButton('Сравнить');
  record(
    'сравнение построено по закреплённым записям: стороны «Было» и «Стало», расчёт не менялся, метод и хэш результата',
    chosen && (await waitFor(`${text('Сравнение построено по закреплённым записям выпусков')} && ${text('Было')} && ${text('Стало')} && ${text('Ревизия расчёта у выпусков одна')} && ${text('Метод release-compare/15-2')}`, 60_000)),
    await excerpt('Сравнение построено'),
  );
  record('отдельный блок «Получено между выпусками» с интервалом; причины выводов — «не установлено»', await waitFor(`${text('Получено между выпусками')} && ${text('Интервал — от закрепления входов левого комплекта до правого')} && ${text('не установлено')}`, 10_000));
  const openSection = (title) => evaluate(`(() => { const d = [...document.querySelectorAll('details')].find((x) => x.querySelector('summary')?.innerText.startsWith(${JSON.stringify(title)})); if (!d) return false; d.open = true; d.dispatchEvent(new Event('toggle')); return true; })()`);
  await openSection('Приложения и файлы');
  record('раздел «Приложения и файлы»: файл комплекта «Изменено», «Было» и «Стало» с SHA-256, доказательства, «Причина не установлена»', await waitFor(`${text('Файл комплекта')} && ${text('Изменено')} && ${text('SHA-256')} && ${text('Доказательства:')} && ${text('Причина не установлена')}`, 30_000), await excerpt('Файл комплекта'));
  await sleep(300);
  await shot('390-comparison-section');
  await clickButton('Указать причину…');
  await waitFor(`document.querySelector('dialog[open]')`);
  const reasoned = await setInput('Пояснение', 'Тестовый комплект несёт отметку «ТЕСТОВЫЙ ВЫПУСК», боевой — без неё');
  await clickInDialog('Записать');
  record(
    'причина вывода записана человеком: «Причина — гипотеза» с автором и версией; раскрытый раздел остаётся раскрытым',
    reasoned && (await waitFor(`!document.querySelector('dialog[open]') && ${text('Причина — гипотеза')} && ${text('версия 1')} && ${text('Файл комплекта')}`, 30_000)),
    await lacks('Причина — гипотеза', 'версия 1', 'Файл комплекта'),
  );
  for (const [w, h] of [[360, 780], [390, 844], [430, 932]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=compare` });
    await waitFor(text('Сравнение построено по закреплённым записям выпусков'), 30_000);
    await openSection('Приложения и файлы');
    await waitFor(text('Файл комплекта'), 20_000);
    record(`${w} px: сравнение выпусков с раскрытым разделом без горизонтальной прокрутки`, await noHorizontalScroll(), await overflowers());
    if (w === 390) await shot('390-comparison');
  }

  // ---- 1280 px, тёмная тема
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=release` });
  await waitFor(text('Лишние вложения приняты'), 30_000);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  const wide = await evaluate(`(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > w + 1 && el.closest('[aria-label="Отправка"]')).slice(0, 5).map((el) => el.tagName + '.' + el.className).join(', '); })()`);
  record('тёмная тема, 1280 px: блок «Отправка» не шире страницы, статусы читаются', wide === '' && (await waitFor(`${text('Подтверждена')} && ${text('Зарегистрирована без сверки')}`)), wide);
  await toSends();
  await sleep(300);
  await shot('1280-dark-sends');
  await evaluate(`document.documentElement.removeAttribute('data-theme'), true`);
  const audit = (await api(`/tenders/${demo.id}/audit-events`)).body.items ?? [];
  const leaked = audit.filter((e) => /^send\.|^release\.comparison/u.test(e.action) && /КП по корпусу|customer@example|Подпись руководителя|Картинка подписи|ТЕСТОВЫЙ ВЫПУСК/u.test(JSON.stringify(e.details ?? {})));
  record('журнал тендера: события отправки и сравнения есть, содержимого писем и пояснений в них нет', audit.some((e) => e.action === 'send.register') && audit.some((e) => e.action === 'release.comparison.create') && leaked.length === 0, `${audit.filter((e) => e.action.startsWith('send.')).length} событий отправки`);
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

const out = join(ROOT, 'artifacts', 'stage-15');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker, LibreOffice; данные ПОДДЕЛЬНЫЕ: TenderHub и модель — поддельные, боевой выпуск — на данных фикстуры (verified по контрактной фикстуре X-01, форма без отметки «демо»), письма — синтетические EML; MailHub не участвует (BLOCKED_EXTERNAL)\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
