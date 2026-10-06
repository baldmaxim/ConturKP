// Этап 11: проверка приложений в headless Chromium (CDP) против настоящих процессов server + worker. Модель не нужна.
// Руководитель в интерфейсе создаёт демонстрационный шаблон компании, загружает схему forms/1 файлом и утверждает
// ревизию, утверждает предложенную формулировку. Инженер на вкладке «Приложения» создаёт приложение по шаблону и
// заполняет его в мастере: демо-баннер, разделы-шаги, список незавершённых пунктов, «Выбрать» вариант, «Изменить»
// число, «Выбрать» утверждённую формулировку, «Обсудить», история правок, противоречие с письмом КП; 390/360 px без
// горизонтальной прокрутки, 1280 px — поля и список незавершённых в две колонки, тёмная тема; нет ошибок консоли и CSP.
// Демонстрационные формы — вымышленный текст в структуре реальных форм компании (реальные формы — вне Git).
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-11/ui-check.mjs → artifacts/stage-11/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана ключевых состояний для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui11_test';
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
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui11-')),
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
const key = () => `ui11-${randomBytes(6).toString('hex')}`;
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

  // Действия внутри карточки поля (id field-<ключ>).
  const inCard = (key, js) => evaluate(`(() => { const card = document.getElementById('field-${key}'); if (!card) return false; ${js} })()`);
  const clickIn = (key, label) => inCard(key, `const b = [...card.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true;`);
  const fillIn = (key, value) =>
    inCard(key, `const el = card.querySelector('input:not([type=checkbox]), textarea, select'); if (!el) return false;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true;`);
  const cardHas = (key, s) => `(document.getElementById('field-${key}')?.innerText ?? '').includes(${JSON.stringify(s)})`;
  const step = (title) => evaluate(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Шаги"] button')].find((x) => x.innerText.includes(${JSON.stringify(title)})); if (!b) return false; b.click(); return true; })()`);

  // ---- Руководитель: шаблон компании и формулировка в интерфейсе
  record('вход руководителя', await login('demo.manager'));
  await send('Page.navigate', { url: `${BASE}/forms` });
  await waitFor(text('Шаблоны приложений'));
  await fillField('Новый шаблон компании', 'Ключевые условия ГП (демо)');
  await clickButton('Создать');
  await waitFor(text('Ключевые условия ГП (демо)'));
  await waitFor(`document.querySelector('input[type=file]')`);
  await pickFile(join(ROOT, 'docs/forms/demo-key-conditions.forms.json'));
  await waitFor(text('Черновик'), 15_000);
  await clickButton('Утвердить');
  record(
    'руководитель создал демонстрационный шаблон компании, загрузил схему forms/1 файлом и утвердил ревизию',
    await waitFor(`${text('Действует ревизия № 1')} && ${text('Демо — не для выпуска')}`, 15_000),
  );
  await shot('390-forms-library');
  await fillField('Название формулировки', 'Сметы по этажам и секциям');
  await fillField('Текст', 'Сметы составляются с единицей измерения «этаж», «секция» или комплексом работ.');
  await clickButton('Предложить');
  await waitFor(text('Предложена'), 15_000);
  await clickButton('Утвердить');
  record('формулировка предложена и утверждена руководителем', await waitFor(`${text('Сметы по этажам и секциям · версия 1')} && ${text('Утверждена')}`, 15_000));
  // Второй шаблон — письмо КП — через API: нужен для противоречия между приложениями.
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;
  const kpTemplate = await api('/application-templates', { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: JSON.stringify({ ownerKind: 'company', name: 'Письмо КП (демо)', isDemo: true }) });
  const kpRev = await api(`/application-templates/${kpTemplate.body.id}/revisions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: JSON.stringify({ schema: JSON.parse(readFileSync(join(ROOT, 'docs/forms/demo-kp-letter.forms.json'), 'utf8')) }) });
  await api(`/template-revisions/${kpRev.body.id}/approve`, { method: 'POST', headers: { ...json, 'If-Match': kpRev.etag }, body: '{}' });
  await logout();

  // ---- Инженер, 390 px: приложение по шаблону и мастер
  record('вход инженера', await login('demo.eng1'));
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=applications` });
  await waitFor(text('Приложения этапа'), 15_000);
  const templates = (await api(`/application-templates?tenderId=${demo.id}`)).body.items;
  await fillField('Шаблон', templates.find((t) => t.name === 'Ключевые условия ГП (демо)').id);
  await clickButton('Создать приложение');
  record(
    'приложение создано; демо-баннер; разделы — шаги; незавершённые пункты видны',
    await waitFor(`${text('Демонстрационная форма с вымышленным текстом — не для выпуска')} && ${text('1. Общие условия')} && ${text('Незавершённые пункты')} && ${text('Не заполнено')}`, 15_000),
  );
  await clickIn('price_kind', 'Выбрать');
  await waitFor(`document.querySelector('#field-price_kind select')`);
  await fillIn('price_kind', 'firm');
  await clickIn('price_kind', 'Сохранить');
  record('«Выбрать» вариант: значение сохранено, состояние «Изменено вручную»', await waitFor(`${cardHas('price_kind', 'Твёрдая договорная цена')} && ${cardHas('price_kind', 'Изменено вручную')}`, 15_000));
  await clickIn('estimate_units', 'Выбрать');
  await waitFor(text('Утверждённые формулировки'), 15_000);
  await waitFor(text('Сметы по этажам и секциям · версия 1'), 15_000);
  await evaluate(`(() => { const b = [...document.querySelectorAll('dialog button')].find((x) => x.innerText.trim() === 'Выбрать'); b?.click(); return Boolean(b); })()`);
  record('«Выбрать» утверждённую формулировку: значение — текст формулировки, происхождение видно', await waitFor(`${cardHas('estimate_units', 'комплексом работ')} && ${cardHas('estimate_units', 'утверждённая формулировка')}`, 15_000));
  await clickIn('site_upkeep_month', 'Изменить');
  await waitFor(`document.querySelector('#field-site_upkeep_month input')`);
  await fillIn('site_upkeep_month', '25');
  await clickIn('site_upkeep_month', 'Сохранить');
  await waitFor(cardHas('site_upkeep_month', '25 млн руб.'), 15_000);
  await clickIn('site_upkeep_month', 'Обсудить');
  await waitFor(text('Что обсудить'), 15_000);
  await fillField('Что обсудить', 'Уточнить сумму компенсации у заказчика');
  await clickButton('Отметить «требует обсуждения»');
  record(
    '«Обсудить»: значение сохранено, «Требует обсуждения», пункт в списке незавершённых',
    await waitFor(`${cardHas('site_upkeep_month', 'Требует обсуждения')} && ${cardHas('site_upkeep_month', '25 млн руб.')} && ${text('Обсуждение')}`, 15_000),
  );
  await clickIn('site_upkeep_month', 'История');
  record('история правок: версии с автором и состоянием', await waitFor(`${cardHas('site_upkeep_month', 'Версия 2')} && ${cardHas('site_upkeep_month', 'Версия 1')} && ${cardHas('site_upkeep_month', 'Демо Инженер 1')}`, 15_000));
  record('нет горизонтальной прокрутки на 390 px (мастер)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны (мастер)', await buttonsFit());
  await shot('390-forms-wizard');
  await step('Авансы и расчёты');
  await waitFor(`document.getElementById('field-advance_percent')`);
  await clickIn('advance_percent', 'Изменить');
  await waitFor(`document.querySelector('#field-advance_percent input')`);
  await fillIn('advance_percent', '30');
  await clickIn('advance_percent', 'Сохранить');
  await waitFor(cardHas('advance_percent', '30 %'), 15_000);
  // Письмо КП с авансом 20 % — противоречие между приложениями.
  const kpDraft = await api(`/stages/${stageId}/application-drafts`, { method: 'POST', headers: { ...json, 'Idempotency-Key': key() }, body: JSON.stringify({ templateRevisionId: kpRev.body.id, title: 'Письмо КП' }) });
  const adv = kpDraft.body.sections.flatMap((s) => s.fields).find((f) => f.key === 'advance_percent');
  await api(`/application-drafts/${kpDraft.body.id}/fields/advance_percent`, { method: 'PUT', headers: { ...json, 'If-Match': adv.etag }, body: JSON.stringify({ action: 'set', value: '20', bases: [] }) });
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=applications` });
  await waitFor(text('Ключевые условия ГП (демо)'), 15_000);
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.startsWith('Ключевые условия ГП (демо)')); b?.click(); return Boolean(b); })()`);
  record('противоречие с письмом КП: «Противоречие» в списке незавершённых с названием другого приложения', await waitFor(`${text('Противоречие')} && ${text('в приложении «Письмо КП»')}`, 15_000));
  await shot('390-forms-issues');

  // ---- 360 px
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  record('нет горизонтальной прокрутки на 360 px', await noHorizontalScroll());

  // ---- 1280 px, тёмная тема: поля и список незавершённых — две колонки
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record(
    'тёмная тема, 1280 px: поля и список незавершённых в двух колонках',
    await waitFor(`(() => { const a = document.querySelector('section[aria-label="Разделы приложения"]'); const b = document.querySelector('section[aria-labelledby="draft-issues"]'); if (!a || !b) return false; const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect(); return rb.left > ra.left + 100 && Math.abs(rb.top - ra.top) < 40; })()`),
  );
  if (SHOTS) await sleep(500);
  await shot('1280-dark-forms');
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
  await sleep(500);
  dropDb();
}

const out = join(ROOT, 'artifacts', 'stage-11');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, ${process.platform} ${process.arch}, Node ${process.version}, Chromium headless (CDP)${sandbox}, реальные server + worker, демонстрационные формы\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exitCode = failed ? 1 : 0;
