// Этап 05a: проверка интерфейса локального распознавания в headless Chromium (CDP) против настоящих
// процессов server + worker (OCR — tesseract.js внутри worker, без сети). Проверяется: автоматическое
// распознавание XLSX — движок, итог, «используется в снимке и поиске», листы-единицы и якорь строки,
// пометка «координаты недоступны», доказательство без рамки; PDF — команда «Распознать локально»;
// «требует проверки» с причиной; политика маршрута PDF в карточке документа; поиск этапа с меткой
// локального распознавания и якорем; 390/360 px без горизонтальной прокрутки, тёмная тема 1280 px.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-05a/ui-check.mjs → artifacts/stage-05a/ui-check.log.
// UI_SHOTS=<каталог> — дополнительно снимки экрана ключевых состояний для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formulaWithoutValueXlsx, smetaStromynkaXlsx, uniqueCopy } from '../../tests/localFixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui05a_test';
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
const FILES = mkdtempSync(join(tmpdir(), 'kontur-ui05a-files-'));
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui05a-')),
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
const key = () => `ui05a-${randomBytes(6).toString('hex')}`;
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
const documentOf = async (revisionId) => (await api(`/document-revisions/${revisionId}/recognition-runs`)).body.items?.[0]?.documentId ?? null;
const runOf = (revisionId) =>
  poll(async () => {
    const r = (await api(`/document-revisions/${revisionId}/recognition-runs`)).body.items?.[0];
    return r && ['complete', 'partial', 'failed'].includes(r.status) ? r : null;
  }, 60_000);

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
  await api(`/tenders/${demo.id}/members/${me.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': card.etag }, body: JSON.stringify({ memberRole: 'manager' }) });
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;

  // ---- XLSX: автоматическое локальное распознавание
  const up = await uploadBytes(stageId, 'Смета Стромынки.xlsx', uniqueCopy(smetaStromynkaXlsx(), 'zip'));
  const xlsxRev = await registered(up.body.id);
  const xlsxRun = await runOf(xlsxRev);
  record('XLSX распознан автоматически worker', xlsxRun?.engine === 'local_ocr' && xlsxRun.status === 'complete', xlsxRun ? `итог ${xlsxRun.outcome}` : 'нет прогона');
  const xlsxDoc = await documentOf(xlsxRev);
  await send('Page.navigate', { url: `${BASE}/documents/${xlsxDoc}` });
  record(
    'панель распознавания: движок, итог, используется в снимке и поиске, постановка автоматическая',
    await waitFor(`${text('Локальное распознавание · разбор структуры')} && ${text('Полностью')} && ${text('Используется в снимке и поиске')} && ${text('поставлено автоматически')}`),
  );
  record('XLSX: кнопки загрузки экспорта RDWeb нет, есть «Распознать заново»', !(await evaluate(text('Загрузить экспорт RDWeb'))) && (await evaluate(text('Распознать заново'))));
  await clickButton('Показать единицы и фрагменты');
  record('единицы — листы книги с именами', await waitFor(`${text('Сводная')} && ${text('Материалы')} && ${text('лист книги')}`));
  record('пометка: у фрагментов нет координат', await waitFor(text('у фрагментов нет координат')));
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('Сводная')); b?.click(); return Boolean(b); })()`);
  record('фрагмент строки — якорь «Лист «Сводная», A7:E7» и «Открыть доказательство»', await waitFor(`${text('Лист «Сводная», A7:E7')} && ${text('Открыть доказательство')}`));
  record('нет горизонтальной прокрутки на 390 px (единицы и фрагменты)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('390-xlsx-units');
  // Самый вложенный элемент списка с якорем строки 12: внешний элемент — карточка редакции целиком.
  await evaluate(`(() => { const T = 'Лист «Сводная», A12:E12';
    const lis = [...document.querySelectorAll('li')].filter((x) => x.innerText.includes(T));
    const li = lis.find((x) => ![...x.querySelectorAll('li')].some((c) => c.innerText.includes(T)));
    const a = li && [...li.querySelectorAll('a')].find((x) => x.innerText.includes('Открыть доказательство')); a?.click(); return Boolean(a); })()`);
  record(
    'доказательство: место в документе, «координаты недоступны», страницы не рисуется',
    await waitFor(`${text('Место в документе')} && ${text('Координаты недоступны: у этого формата нет страниц')} && ${text('244 800 000')}`) &&
      !(await evaluate(`Boolean(document.querySelector('canvas'))`)),
  );
  await shot('390-evidence-xlsx');

  // ---- «требует проверки» с причиной
  const upF = await uploadBytes(stageId, 'Расчёт с формулой.xlsx', uniqueCopy(formulaWithoutValueXlsx(), 'zip'));
  const fRev = await registered(upF.body.id);
  await runOf(fRev);
  await send('Page.navigate', { url: `${BASE}/documents/${await documentOf(fRev)}` });
  record('итог «Требует проверки» и объяснение', await waitFor(`${text('Требует проверки')} && ${text('не прошла шлюз качества')}`));
  await clickButton('Показать единицы и фрагменты');
  record('причина проверки названа: формула без сохранённого значения', await waitFor(text('формула без сохранённого значения')));

  // ---- PDF: явная команда
  const pdfBytes = uniqueCopy(readFileSync(join(ROOT, 'tests', 'fixtures', 'local', 'letter-text.pdf')), 'pdf');
  const upP = await uploadBytes(stageId, 'Письмо-текст.pdf', pdfBytes);
  const pdfRev = await registered(upP.body.id);
  const pdfDoc = (await api(`/stages/${stageId}/documents`)).body.items.find((d) => d.latestRevisionId === pdfRev);
  await send('Page.navigate', { url: `${BASE}/documents/${pdfDoc.id}` });
  record('PDF с политикой auto: распознавания нет, доступны экспорт RDWeb и «Распознать локально»', await waitFor(`${text('Распознавание не выполнялось')} && ${text('Распознать локально')} && ${text('Загрузить экспорт RDWeb')}`));
  await clickButton('Распознать локально');
  record('команда «Распознать локально» — прогон завершён', await waitFor(`${text('Локальное распознавание · текстовый слой')} && ${text('поставлено командой')} && ${text('Полностью')}`, 60_000));
  await shot('390-pdf-local');

  // ---- политика маршрута PDF в карточке документа
  await clickButton('Изменить');
  await waitFor(`[...document.querySelectorAll('label')].some((l) => l.innerText.startsWith('Маршрут распознавания PDF'))`);
  await fillLabeled('Маршрут распознавания PDF', 'rdweb');
  await clickButton('Сохранить');
  record('политика маршрута сохранена: «Только RDWeb»', await waitFor(`${text('Документ сохранён')} && ${text('Только RDWeb')}`));

  // ---- поиск этапа: метка локального распознавания и якорь
  const draft = await api(`/stages/${stageId}/source-set-revisions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key() }, body: '{}' });
  await api(`/source-set-revisions/${draft.body.id}/items`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': draft.etag },
    body: JSON.stringify({ items: [{ documentRevisionId: xlsxRev, inclusion: 'included' }] }),
  });
  const indexed = await poll(async () => {
    const r = await api('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { kind: 'tender', tenderId: demo.id, mode: 'working', stageId }, query: 'монолитные железобетонные работы', limit: 5 }),
    });
    return r.status === 200 && r.body.fused?.items?.length ? r.body : null;
  }, 60_000);
  record('worker проиндексировал локальный прогон', Boolean(indexed));
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=search` });
  await waitFor(`document.querySelector('form[role=search] input[maxlength="500"]')`);
  await fill('form[role=search] input[maxlength="500"]', 'монолитные железобетонные работы');
  await clickButton('Найти');
  record(
    'поиск: якорь листа и строки, происхождение «локально», охват с локальными единицами',
    await waitFor(`${text('Лист «Сводная», A7:E7')} && ${text('Текст документа · локально')} && ${text('Локальное распознавание в области: 1 ед.')}`, 20_000),
  );
  await shot('390-search-local');

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/documents/${xlsxDoc}` });
  await waitFor(text('Показать единицы и фрагменты'));
  await clickButton('Показать единицы и фрагменты');
  await waitFor(text('лист книги'));
  await sleep(500);
  record('нет горизонтальной прокрутки на 360 px (панель распознавания)', await noHorizontalScroll());
  record('360 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('360-xlsx-panel');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/documents/${xlsxDoc}` });
  await waitFor(text('Используется в снимке и поиске'));
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record('тёмная тема, 1280 px: панель распознавания читается', await waitFor(`${text('Локальное распознавание')} && ${text('Полностью')}`));
  if (SHOTS) await sleep(500);
  await shot('1280-dark-recognition');

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

const out = join(ROOT, 'artifacts', 'stage-05a');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(join(out, 'ui-check.log'), `# ui-check — ${new Date().toISOString()}, Chromium headless (CDP)${sandbox}, реальные server + worker\n${lines.join('\n')}\n${summary}\n`);
console.log(summary);
process.exit(failed ? 1 : 0);
