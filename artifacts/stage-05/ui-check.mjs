// Этап 05: проверка интерфейса поиска в headless Chromium (CDP) против настоящих процессов
// server + worker (не mock). Проверяется вертикальный результат этапа: индекс строит worker,
// вкладка «Поиск» этапа находит цитату и открывает участок оригинала, честно сообщает о
// недоступной смысловой ветке и пустом итоге, снимок области фиксируется и ищется, фрагмент без
// страницы показывает состояние, а не вечную загрузку (R04-19). Модель эмбеддингов не настроена.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH
// (или EDGE_PATH). Запуск: node artifacts/stage-05/ui-check.mjs → artifacts/stage-05/ui-check.log.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRdwebExport } from '../../tests/rdweb.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui05_test';
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
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui05-')),
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
const waitFor = async (expression, timeoutMs = 15_000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evaluate(`Boolean(${expression})`).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};
const text = (s) => `(document.body?.innerText ?? '').includes(${JSON.stringify(s)})`;
const fill = (selector, value) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const choose = (selector, value) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const clickButton = (label) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.click(); return true; })()`);
// Запрос API из страницы: сессия и CSRF — те же, что у интерфейса.
const api = (path, init = {}) =>
  evaluate(`(async () => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('kkp_csrf=')) ?? '').slice(9));
    const init = ${JSON.stringify(init)};
    const headers = { 'X-CSRF-Token': csrf, ...(init.headers ?? {}) };
    let body = init.body;
    if (init.base64) body = Uint8Array.from(atob(init.base64), (c) => c.charCodeAt(0));
    const r = await fetch('/api/v1' + ${JSON.stringify(path)}, { method: init.method ?? 'GET', headers, body });
    const t = await r.text();
    return { status: r.status, etag: r.headers.get('etag'), body: t ? JSON.parse(t) : null };
  })()`);
const key = () => `ui05-${randomBytes(6).toString('hex')}`;
const poll = async (fn, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return null;
};
const noHorizontalScroll = () => evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth');

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

  // Обезличенная фикстура: 2 страницы; блок со ссылкой на страницу за пределами PDF даёт фрагмент без страницы.
  const fixture = buildRdwebExport({ docName: 'ТЗ-поиск', pages: 2, outOfRangePageBlocks: [5] });

  browser = spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      // Ubuntu 23.10+ запрещает песочнице непривилегированные пространства имён (AppArmor): браузер
      // открывает только локальный server на 127.0.0.1, поэтому песочница снимается явным флагом.
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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/\b(401|404|409|412)\b/.test(m.params.entry.text)) {
      problems.push(`${m.params.entry.source}: ${m.params.entry.text.slice(0, 200)}`);
    }
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(`document.querySelector('input[name=username]')`);
  await fill('input[name=username]', 'demo.eng1');
  await fill('input[name=password]', PASSWORD);
  await evaluate(`document.querySelector('form button[type=submit]').click(), true`);
  record('вход инженера', await waitFor(text('DEMO-001')));

  // ---- данные этапа через API интерфейса: оригинал, экспорт RDWeb, замороженный состав
  const tenders = await api('/tenders');
  const demo = tenders.body.items.find((t) => t.code === 'DEMO-001');
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;
  const up = await api(`/stages/${stageId}/imports?name=${encodeURIComponent('ТЗ-поиск.pdf')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': key() },
    base64: fixture.pdf.toString('base64'),
  });
  const batch = await poll(async () => {
    const b = await api(`/imports/${up.body.id}`);
    return b.body?.status === 'completed' ? b.body : null;
  }, 30_000);
  const revisionId = batch?.items?.[0]?.documentRevisionId;
  const rec = await api(`/document-revisions/${revisionId}/recognition-imports?name=export.zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': key() },
    base64: fixture.zip.toString('base64'),
  });
  const run = await poll(async () => {
    const r = await api(`/recognition-runs/${rec.body.id}`);
    return r.body?.status === 'complete' ? r.body : null;
  }, 30_000);
  const draft = await api(`/stages/${stageId}/source-set-revisions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key() }, body: '{}' });
  const items = await api(`/source-set-revisions/${draft.body.id}/items`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': draft.etag },
    body: JSON.stringify({ items: [{ documentRevisionId: revisionId, inclusion: 'included' }] }),
  });
  const frozen = await api(`/source-set-revisions/${draft.body.id}/freeze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': items.etag, 'Idempotency-Key': key() },
    body: '{}',
  });
  record('оригинал, экспорт RDWeb и замороженный состав этапа', Boolean(run) && frozen.status === 200);
  const indexed = await poll(async () => {
    const r = await api('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { kind: 'tender', tenderId: demo.id, mode: 'working', stageId }, query: 'ФИКС-АР', limit: 5 }),
    });
    return r.status === 200 && r.body.fused?.items?.length ? r.body : null;
  }, 60_000);
  record('worker построил индекс поиска', Boolean(indexed), indexed ? `версия ${indexed.index.seq}` : 'нет активной версии');

  // ---- вкладка «Поиск»
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=search` });
  record('у этапа есть вкладка «Поиск» с формой', await waitFor(`document.querySelector('form[role=search] input[maxlength="500"]')`));
  await fill('form[role=search] input[maxlength="500"]', 'ФИКС-АР');
  await clickButton('Найти');
  const hit = await waitFor(`${text('Открыть доказательство')} && ${text('Распознанный текст RDWeb')}`, 15_000);
  record('результат: цитата с документом, происхождением и веткой поиска', hit && (await evaluate(text('точное совпадение'))));
  record(
    'деградация смысловой ветки названа причиной, а не скрыта',
    await evaluate(`${text('Смысловой поиск не участвовал')} && ${text('модель эмбеддингов не подключена')}`),
  );
  await sleep(300);
  record('нет горизонтальной прокрутки на 390 px (результаты поиска)', await noHorizontalScroll());
  await evaluate(`document.querySelector('a[href^="/evidence/"]').click(), true`);
  const drawn = await waitFor(`(() => { const c = document.querySelector('canvas'); return c && c.width > 100 && c.height > 100; })()`, 40_000);
  record('переход к доказательству: участок оригинала отрисован', drawn && (await evaluate(`location.pathname.startsWith('/evidence/')`)));

  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=search` });
  await waitFor(`document.querySelector('form[role=search] input[maxlength="500"]')`);
  await fill('form[role=search] input[maxlength="500"]', 'насос задвижка фильтр');
  await clickButton('Найти');
  record(
    'описание модели не находится; пустой итог — «не найдено в области», а не «не предусмотрено»',
    await waitFor(`${text('Ничего не найдено')} && ${text('не найдено в области')}`, 15_000),
  );
  record('в пустом итоге нет утверждения об отсутствии требования', !(await evaluate(text('не предусмотрено'))));

  // ---- снимок области
  await clickButton('Зафиксировать снимок области');
  record('снимок области зафиксирован', await waitFor(text('Снимок области зафиксирован'), 10_000));
  const snapshotValue = await poll(
    () => evaluate(`(() => { const o = [...document.querySelectorAll('select option')].find((x) => x.value !== 'working'); return o ? o.value : null; })()`),
    10_000,
  );
  await choose('form[role=search] select', snapshotValue);
  await fill('form[role=search] input[maxlength="500"]', 'ФИКС-АР');
  await clickButton('Найти');
  record('поиск по снимку области', await waitFor(`${text('Открыть доказательство')} && ${text('снимок области')}`, 15_000));

  // ---- R04-19: фрагмент без страницы
  const unpaged = await api(`/recognition-runs/${rec.body.id}/fragments?limit=500`);
  const noPage = unpaged.body?.items?.find((f) => f.pageIndex === null && f.origin === 'recognized_text');
  record('у фикстуры есть фрагмент без страницы', Boolean(noPage));
  await send('Page.navigate', { url: `${BASE}/evidence/${noPage?.id}` });
  const stated = await waitFor(text('Фрагмент не привязан к странице; откройте оригинал целиком'), 15_000);
  await sleep(1500);
  record(
    'R04-19: фрагмент без страницы — честное состояние вместо «Страница оригинала загружается…»',
    stated && !(await evaluate(text('Страница оригинала загружается'))) && !(await evaluate(`Boolean(document.querySelector('canvas'))`)) && (await evaluate(text('Открыть оригинал целиком'))),
  );

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  for (const [name, path] of [
    ['вкладка поиска', `${BASE}/stages/${stageId}?tab=search`],
    ['доказательство без страницы', `${BASE}/evidence/${noPage?.id}`],
  ]) {
    await send('Page.navigate', { url: path });
    await waitFor(`document.querySelector('main')`);
    await sleep(800);
    record(`нет горизонтальной прокрутки на 360 px (${name})`, await noHorizontalScroll());
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=search` });
  await waitFor(`document.querySelector('form[role=search] input[maxlength="500"]')`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  await fill('form[role=search] input[maxlength="500"]', 'ФИКС-АР');
  await clickButton('Найти');
  record('тёмная тема, 1280 px: результаты поиска отображаются', await waitFor(text('Открыть доказательство'), 15_000));

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

const out = join(ROOT, 'artifacts', 'stage-05');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(join(out, 'ui-check.log'), `# ui-check — ${new Date().toISOString()}, Chromium headless (CDP)${sandbox}, реальные server + worker\n${lines.join('\n')}\n${summary}\n`);
console.log(summary);
process.exit(failed ? 1 : 0);
