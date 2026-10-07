// Этап 13: согласование и выпуск в интерфейсе — headless Chromium (CDP) против настоящих server + worker с LibreOffice
// (D-033; BRAND.md §4.3, §9.1). Расчёт — поддельный TenderHub, модель — поддельный провайдер (MODEL_PROVIDER=fake),
// формы — демонстрационные (вымышленный текст). Подготовка через API: ТЗ, снимок, реестр с требованием и покрытием,
// завершённый проход, прогон проверок без пробелов обработки, заполненное письмо КП, тестовый комплект. Проверяется:
// руководитель на смартфоне видит матрицу блокеров и принимает риск по каждому бизнес-пункту с причиной; «Согласовать…»
// в липкой нижней панели в пределах экрана; диалог согласования — начальный фокус «Отмена», точный состав (файлы, хэши,
// принятые риски) читается без горизонтальной прокрутки на 360/390/430 px; согласование меняет цепочку выпуска. Инженер
// не видит согласования, выпускает «Выпустить…»; выпуск в списке выпусков этапа. Новый документ после выпуска — баннер
// «Отправка удержана»; инженер решения не принимает; руководитель «Не влияет…» — удержание снято. 1280 px, тёмная тема:
// цепочка в строку, журнал с согласованием и выпуском; нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH, LibreOffice.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-13/ui-check.mjs → artifacts/stage-13/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана для просмотра человеком (в Git не входят).
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
const DB = 'kontur_kp_ui13_test';
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
    tender_number: 'TH-UI-13',
    title: 'Корпус 13 — согласование',
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
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui13-')),
  TENDERHUB_INSTANCE_ID: 'th-ui-13',
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
const key = () => `ui13-${randomBytes(6).toString('hex')}`;
const json = { 'Content-Type': 'application/json' };
const post = (path, body, headers = {}) => api(path, { method: 'POST', headers: { ...json, 'Idempotency-Key': key(), ...headers }, body: JSON.stringify(body) });
const noHorizontalScroll = () => evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth');
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
  letter_number: '04/26-13-ТО',
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
  const reg = await post(`/stages/${STAGE}/requirement-registries`, { evidenceScopeId: scope.body.id, reason: 'Реестр UI этапа 13' });
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
        objects: [{ type: 'calculation_revision', calculationRevisionId: cap?.revisionId, externalPositionId: POS, externalItemId: LINE, match: 'explicit_line' }],
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
  // Шаблон письма с размеченной копией (как в шагах smoke этапа 12), заполненное приложение, тестовый комплект.
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
  const tpl = await post('/application-templates', { ownerKind: 'company', name: 'Письмо КП (демо, этап 13)', isDemo: true });
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
  const c = await post(`/stages/${STAGE}/release-candidates`, { mode: 'test', draftIds: [d.body.id] });
  const built = await poll(async () => {
    const v = (await api(`/release-candidates/${c.body.id}`)).body;
    return v?.status && v.status !== 'assembling' ? v : null;
  }, 180_000);
  record('тестовый комплект собран worker с LibreOffice', built?.status === 'ready_for_approval', built ? `${built.status}${built.failure ? `: ${built.failure.code}` : ''}` : `HTTP ${c.status}`);
  const seqNo = built?.seq ?? 1;

  // ---- Руководитель на смартфоне (390 px): матрица, принятие риска, согласование в нижнем листе
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  record('карточка комплекта: цепочка выпуска «Не согласовано», матрица согласования с бизнес-пунктом', (await openCandidate(seqNo)) && (await waitFor(`${text('Не согласовано')} && ${text('Согласование: что мешает')} && ${text('Покрытие требований не оценено')}`, 20_000)), await excerpt('Согласование'));
  await shot('390-manager-gate');
  let accepted = 0;
  for (let i = 0; i < 6; i += 1) {
    if (!(await clickButton('Принять риск…'))) break;
    await waitFor(`document.querySelector('dialog[open] textarea')`);
    await fillDialogText('Риск принят руководителем для тестового выпуска');
    await clickInDialog('Принять риск');
    await waitFor(`!document.querySelector('dialog[open]')`, 15_000);
    accepted += 1;
    await sleep(500);
  }
  record('бизнес-пункты: «Принять риск…» с причиной; пункт остаётся видимым как «Риск принят»', accepted > 0 && (await waitFor(text('Риск принят:'), 15_000)), `принято: ${accepted}`);
  // Руководитель читает карточку: прокрутка к матрице; зона действий — липкая нижняя панель карточки (BRAND.md §9.1 п. 2).
  await evaluate(`(() => { document.querySelector('[aria-label^="Согласование"]')?.scrollIntoView({ block: 'start' }); return true; })()`);
  await sleep(300);
  await shot('390-sticky-actions');
  record(
    '«Согласовать…» доступна, в нижней панели в пределах экрана; «Вернуть на доработку…» отделена промежутком',
    await waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Согласовать…' && !x.disabled); if (!b) return false;
      const r = b.getBoundingClientRect(); const back = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Вернуть на доработку…');
      const gap = back ? Math.abs(back.getBoundingClientRect().left - r.right) : 99; return r.bottom <= window.innerHeight + 1 && r.top >= 0 && (gap >= 24 || back.getBoundingClientRect().top > r.bottom); })()`, 15_000),
  );
  await clickButton('Согласовать…');
  await waitFor(`document.querySelector('dialog[open]')`);
  record('диалог согласования: начальный фокус «Отмена», точный состав — файлы с хэшами и принятые риски', await waitFor(`document.activeElement?.innerText?.trim() === 'Отмена' && ${text('Файлы')} && ${text('01 Письмо КП.docx')} && ${text('Принятые риски')}`));
  for (const [w, h] of [[360, 780], [390, 844], [430, 932]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    await sleep(300);
    record(`${w} px: состав в диалоге читается без горизонтальной прокрутки, кнопка подтверждения видна`, (await dialogFits()) && (await noHorizontalScroll()) && (await waitFor(`[...document.querySelectorAll('dialog[open] button')].some((b) => b.innerText.trim() === 'Согласовать комплект № ${seqNo}' && b.getBoundingClientRect().bottom <= window.innerHeight + 1)`, 3000)));
    await shot(`${w}-approve-dialog`);
  }
  await clickInDialog(`Согласовать комплект № ${seqNo}`);
  record('согласовано: цепочка «Согласовано» с автором, статус «Согласован»', await waitFor(`${text('Согласовано')} && ${text('Согласован')} && !document.querySelector('dialog[open]')`, 20_000));
  record('нет горизонтальной прокрутки после согласования (430 px)', await noHorizontalScroll());
  await logout();

  // ---- Инженер (390 px): выпуск
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  record('вход инженера', await login('demo.eng1'));
  await openCandidate(seqNo);
  record('инженер не согласует; видит «Выпустить…»', await waitFor(`${text('Выпустить…')} && ![...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Отозвать согласование…')`, 20_000));
  await clickButton('Выпустить…');
  await waitFor(`document.querySelector('dialog[open]')`);
  await shot('390-release-dialog');
  record('диалог выпуска: состав, кто согласовал, начальный фокус «Отмена»', await waitFor(`${text('Согласовал')} && ${text('01 Письмо КП.docx')} && document.activeElement?.innerText?.trim() === 'Отмена'`), await excerpt('Согласовал'));
  await clickInDialog(`Выпустить комплект № ${seqNo}`);
  record('выпущено: «Выпущено (тестовый выпуск)», выпуск в списке выпусков этапа', await waitFor(`${text('Выпущено (тестовый выпуск)')} && ${text('Выпуски этапа')} && ${text('Тестовый — не отправляется')}`, 20_000));
  await shot('390-released');
  const after = await uploadBytes(STAGE, 'ответ-заказчика.csv', Buffer.from('Раздел;Текст\nОтвет;Срок поставки окон — 30 дней.\n', 'utf8'));
  const afterRev = await registered(after.body.id);
  // Worker распознаёт CSV сам: решение принимается после всех событий обработки (иначе позднее событие — новое удержание).
  if (afterRev) await poll(async () => ((await api(`/document-revisions/${afterRev}/recognition-runs`)).body.items ?? []).some((r) => ['complete', 'partial', 'failed'].includes(r.status)), 30_000);
  await sleep(1500);
  await openCandidate(seqNo);
  record('новый документ после выпуска: баннер «Отправка удержана», событие ждёт решения', await waitFor(`${text('Отправка удержана')} && ${text('Ждут решения руководителя')}`, 20_000));
  record('инженер решения о применимости не принимает', await waitFor(text('Решение о применимости принимает руководитель тендера.')));
  await logout();

  // ---- Руководитель (1280 px, тёмная тема): «не влияет», журнал
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  record('вход руководителя', await login('demo.admin'));
  await openCandidate(seqNo);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  await waitFor(text('Ждут решения руководителя'), 20_000);
  await clickButton('Выбрать все');
  await clickButton('Не влияет…');
  await waitFor(`document.querySelector('dialog[open] textarea')`);
  await fillDialogText('Ответ о сроке поставки окон не меняет выпущенный комплект');
  await clickInDialog('Записать «не влияет»');
  record('«не влияет»: удержание снято, баннер исчез, решение видно', await waitFor(`!${text('Отправка удержана')} && ${text('Не влияет')}`, 20_000), await excerpt('Отправка'));
  record(
    'тёмная тема, 1280 px: цепочка выпуска в строку',
    await evaluate(`(() => { const li = [...document.querySelectorAll('[aria-label="Цепочка выпуска"] li')]; if (li.length < 3) return false;
      const t = li.map((x) => Math.round(x.getBoundingClientRect().top)); return Math.max(...t) - Math.min(...t) < 4; })()`),
  );
  await evaluate(`(() => { const d = [...document.querySelectorAll('details')].find((x) => x.innerText.startsWith('Журнал')); if (d) { d.open = true; d.dispatchEvent(new Event('toggle')); } return true; })()`);
  record('журнал: согласование, выпуск и решение по событию с автором', await waitFor(`${text('Согласовано')} && ${text('Выпущено')} && ${text('Решение по событию: не влияет')}`, 15_000));
  await shot('1280-dark-journal');
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

const out = join(ROOT, 'artifacts', 'stage-13');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker, LibreOffice, TenderHub и модель — поддельные, демонстрационные формы\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
