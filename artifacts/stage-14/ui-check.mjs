// Этап 14: размещение выпуска в интерфейсе — headless Chromium (CDP) против настоящих server + worker с LibreOffice
// (D-034; проект §12). Назначения — временные папки на этой машине (поддельные: «папка синхронизации» Яндекс Диска со
// служебной папкой вне её и сетевая папка), не живая проверка. Подготовка этапа и выпуск тестового комплекта — как в
// проверке этапа 13, через API. Проверяется: администратор на смартфоне заводит назначение в «Назначениях размещения» и
// запускает «Проверить назначение» (выполняет worker); инженер раздела не видит. После выпуска worker размещает в оба
// назначения: блок «Размещение» — «2 из 2», у Яндекс Диска «Проверено в локальной папке» и «Облако: не подтверждено»,
// подпись «Размещено ≠ отправлено». Инженер подтверждает облако с примечанием (диалог: фокус «Отмена»). Назначение без
// корня — «Ошибка» только у него; после исправления «Повторить…» с причиной — «Размещено», остальные не тронуты.
// 360/390/430 px без горизонтальной прокрутки; 1280 px, тёмная тема — файлы со статусами сверки; нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH, LibreOffice.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-14/ui-check.mjs → artifacts/stage-14/ui-check.log.
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
const DB = 'kontur_kp_ui14_test';
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
    tender_number: 'TH-UI-14',
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
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui14-')),
  TENDERHUB_INSTANCE_ID: 'th-ui-14',
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
const key = () => `ui14-${randomBytes(6).toString('hex')}`;
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
// Назначения — временные папки: длинные пути с кириллицей проверяют перенос строк на смартфоне.
const DEST = mkdtempSync(join(tmpdir(), 'kontur-ui14-dest-'));
const SYNC = join(DEST, 'Яндекс.Диск', 'Контур КП — тестовые выпуски для проверки интерфейса');
const STAGING = join(DEST, 'kontur-staging-вне-синхронизации');
const SHARE = join(DEST, 'share', 'Тендерный отдел', 'Контур КП тест');
const MISSING = join(DEST, 'share', 'Папка, которой пока нет');
for (const d of [SYNC, STAGING, SHARE]) mkdirSync(d, { recursive: true });

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
  const reg = await post(`/stages/${STAGE}/requirement-registries`, { evidenceScopeId: scope.body.id, reason: 'Реестр UI этапа 14' });
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
  const tpl = await post('/application-templates', { ownerKind: 'company', name: 'Письмо КП (демо, этап 14)', isDemo: true });
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

  // ---- Администратор на смартфоне (390 px): «Назначения размещения», новое назначение, проверка доступа worker
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/admin?tab=delivery` });
  record('администрирование: раздел «Назначения размещения», пусто — подсказка', await waitFor(`${text('Назначения размещения')} && ${text('Назначений нет')}`, 20_000), await excerpt('Назначения'));
  await clickButton('Новое назначение');
  await waitFor(`document.querySelector('dialog[open]')`);
  const setSelect = (label, value) =>
    evaluate(`(() => { const d = document.querySelector('dialog[open]'); const l = [...d.querySelectorAll('label')].find((x) => x.innerText.startsWith(${JSON.stringify(label)}));
      const el = l && d.querySelector('#' + CSS.escape(l.htmlFor)); if (!el) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const setInput = (label, value) =>
    evaluate(`(() => { const d = document.querySelector('dialog[open]'); const l = [...d.querySelectorAll('label')].find((x) => x.innerText.startsWith(${JSON.stringify(label)}));
      const el = l && d.querySelector('#' + CSS.escape(l.htmlFor)); if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const filled =
    (await setInput('Название', 'Яндекс Диск (тест)')) &&
    (await setSelect('Тип', 'yandex_disk')) &&
    (await sleep(200), await setInput('Папка внутри папки синхронизации', SYNC)) &&
    (await setInput('Служебная папка', STAGING)) &&
    (await setInput('Причина', 'Тестовое назначение для проверки интерфейса'));
  await shot('390-destination-dialog');
  record('диалог назначения: поля читаются без горизонтальной прокрутки (390 px)', filled && (await dialogFits()) && (await noHorizontalScroll()));
  await clickInDialog('Создать назначение');
  record('назначение создано: карточка с путями, «Доступ не проверялся»', await waitFor(`!document.querySelector('dialog[open]') && ${text('Яндекс Диск (тест)')} && ${text('Доступ не проверялся')}`, 20_000), await excerpt('Яндекс'));
  await clickButton('Проверить назначение');
  record('«Проверить назначение» выполняет worker: «Доступ проверен»', await waitFor(text('Доступ проверен'), 30_000), await excerpt('Доступ'));
  await shot('390-destinations');
  // Сетевая папка и назначение без корня — через API (тот же сервер); второе выключено до выпуска.
  const smb = await post('/delivery-destinations', { title: 'Сетевая папка (тест)', kind: 'smb', environment: 'test', rootPath: SHARE, reason: 'Тестовое назначение для проверки интерфейса' });
  for (const [w, h] of [[360, 780], [390, 844], [430, 932]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    await send('Page.navigate', { url: `${BASE}/admin?tab=delivery` });
    await waitFor(text('Сетевая папка (тест)'), 20_000);
    record(`${w} px: назначения с длинными путями — без горизонтальной прокрутки`, await noHorizontalScroll());
  }
  await logout();
  record('вход инженера', await login('demo.eng1'));
  await send('Page.navigate', { url: `${BASE}/admin?tab=delivery` });
  record('инженеру раздел назначений недоступен', await waitFor(`${text('Нет доступа')} && !${text('Яндекс Диск (тест)')}`, 15_000));
  await logout();

  // ---- Выпуск тестового комплекта через API: риски, согласование (руководитель), выпуск (инженер)
  record('вход руководителя', await login('demo.admin'));
  let cv = (await api(`/release-candidates/${built?.id}`)).body;
  for (const h of (await api(`/stages/${STAGE}/holds?candidateId=${cv.id}&status=open`)).body.items ?? []) {
    await post(`/release-candidates/${cv.id}/holds/resolve`, { holdIds: [h.id], resolution: 'not_applicable', reason: 'Не влияет на тестовый комплект' });
  }
  cv = (await api(`/release-candidates/${cv.id}`)).body;
  for (const b of cv.gate?.approve?.blockers ?? []) {
    if (!b.acceptable) continue;
    for (const i of b.items.filter((x) => !x.acceptance)) {
      await post(`/release-candidates/${cv.id}/risk-acceptances`, { blockerCode: b.code, subjectType: i.subjectType, subjectId: i.subjectId, subjectKey: i.subjectKey, reason: 'Риск принят руководителем для тестового выпуска' });
    }
  }
  cv = (await api(`/release-candidates/${cv.id}`)).body;
  const appr = await post(`/release-candidates/${cv.id}/approve`, { contentHash: cv.contentHash, compositionHash: cv.gate?.approve?.compositionHash }, { 'If-Match': cv.etag });
  await logout();
  record('вход инженера', await login('demo.eng1'));
  cv = (await api(`/release-candidates/${cv.id}`)).body;
  const rel = await post(`/release-candidates/${cv.id}/release`, { approvalId: appr.body?.approval?.id, contentHash: cv.contentHash, compositionHash: cv.gate?.release?.compositionHash }, { 'If-Match': cv.etag });
  record('комплект согласован и выпущен (тестовый выпуск)', appr.status === 200 && rel.status === 201, `HTTP ${appr.status}/${rel.status}`);
  const RELEASE = rel.body?.release?.id;

  // ---- Инженер на смартфоне (390 px): блок «Размещение»
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=release` });
  record(
    'worker разместил в оба назначения: «Размещение: 2 из 2», у Яндекс Диска «Проверено в локальной папке» и «Облако: не подтверждено»',
    await waitFor(`${text('Размещение: 2 из 2')} && ${text('Проверено в локальной папке')} && ${text('Облако: не подтверждено')} && ${text('Размещено')}`, 60_000),
    await excerpt('Размещение'),
  );
  record('подпись: «Размещено» не означает «отправлено заказчику»', await waitFor(text('«Размещено» не означает «отправлено заказчику»')));
  const placed = existsSync(SYNC) ? readdirSync(join(SYNC, 'DEMO-001')).length : 0;
  record('в «папке синхронизации» — папка выпуска; служебная папка Яндекс Диска пуста', placed === 1 && readdirSync(STAGING).length === 0);
  const toDeliveries = () => evaluate(`(() => { document.querySelector('[aria-label="Размещение"]')?.scrollIntoView({ block: 'start' }); return true; })()`);
  await toDeliveries();
  await sleep(300);
  await shot('390-deliveries');
  await clickButton('Подтвердить облако…');
  await waitFor(`document.querySelector('dialog[open] textarea')`);
  record('«Подтвердить облако…»: начальный фокус «Отмена», объяснение про локальную папку и delivery:compare', await waitFor(`document.activeElement?.innerText?.trim() === 'Отмена' && ${text('delivery:compare')}`));
  for (const [w, h] of [[360, 780], [430, 932]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    await sleep(300);
    record(`${w} px: диалог подтверждения облака без горизонтальной прокрутки`, (await dialogFits()) && (await noHorizontalScroll()));
  }
  await fillDialogText('Папка выпуска скачана из веб-интерфейса Диска, delivery:compare — совпадает');
  await clickInDialog('Подтвердить');
  record('облако подтверждено: «Облако: подтверждено» с автором и примечанием, сводка «облако подтверждено 1 из 1»', await waitFor(`${text('Облако: подтверждено')} && ${text('облако подтверждено 1 из 1')} && ${text('Облако подтвердил')}`, 20_000), await excerpt('Облако'));
  await logout();

  // ---- Назначение без корня: ошибка только у него; исправление и «Повторить…»
  record('вход руководителя', await login('demo.admin'));
  const broken = await post('/delivery-destinations', { title: 'Сетевая папка (нет корня)', kind: 'smb', environment: 'test', rootPath: MISSING, reason: 'Проверка ошибки размещения' });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/stages/${STAGE}?tab=release` });
  await waitFor(text('Разместить в новые назначения (1)'), 20_000);
  await clickButton('Разместить в новые назначения (1)');
  record(
    'назначение без корня — «Ошибка» с понятной причиной; два других — «Размещение: 2 из 3»',
    await waitFor(`${text('Размещение: 2 из 3')} && ${text('корень назначения не найден')} && ${text('Повторить…')}`, 60_000),
    await excerpt('Размещение'),
  );
  await toDeliveries();
  await sleep(300);
  await shot('390-delivery-failed');
  mkdirSync(MISSING, { recursive: true });
  await clickButton('Повторить…');
  await waitFor(`document.querySelector('dialog[open] textarea')`);
  await fillDialogText('Администратор создал папку на сервере');
  await clickInDialog('Повторить');
  record('«Повторить…» с причиной — «Размещение: 3 из 3»; прежние доставки не тронуты', await waitFor(text('Размещение: 3 из 3'), 60_000), await excerpt('Размещение'));
  const list = (await api(`/releases/${RELEASE}/deliveries`)).body;
  record(
    'журнал доставки: событие «повтор» с автором и причиной; у Яндекс Диска одна попытка',
    list?.items?.some((d) => d.events.some((e) => e.action === 'retry' && e.reason === 'Администратор создал папку на сервере')) && list.items.find((d) => d.destination.kind === 'yandex_disk')?.attempts.length === 1,
  );
  for (const [w, h] of [[360, 780], [390, 844], [430, 932]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    await sleep(300);
    record(`${w} px: блок «Размещение» без горизонтальной прокрутки`, await noHorizontalScroll());
  }

  // ---- 1280 px, тёмная тема: файлы и статусы сверки
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  await evaluate(`(() => { const d = [...document.querySelectorAll('details')].filter((x) => x.innerText.startsWith('Файлы (')); d.forEach((x) => { x.open = true; }); return d.length; })()`);
  record('тёмная тема, 1280 px: файлы набора и признак готовности — «сверен»', await waitFor(`${text('kontur-placement.json — признак готовности')} && ${text('сверен')}`, 10_000));
  const wide = await evaluate(`(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > w + 1 && el.closest('[aria-label="Размещение"]')).slice(0, 5).map((el) => el.tagName + '.' + el.className).join(', '); })()`);
  record('1280 px: блок «Размещение» не шире страницы', wide === '', wide);
  await toDeliveries();
  await sleep(300);
  await shot('1280-dark-deliveries');
  await evaluate(`document.documentElement.removeAttribute('data-theme'), true`);
  record('нет ошибок консоли и нарушений CSP', problems.length === 0, problems.join(' | '));
  record('назначение без корня создано через API', broken.status === 201 && smb.status === 201);
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
  rmSync(DEST, { recursive: true, force: true });
}

const out = join(ROOT, 'artifacts', 'stage-14');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker, LibreOffice, назначения — временные папки (не живая проверка), TenderHub и модель — поддельные, демонстрационные формы\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
