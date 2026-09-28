// Этап 06: проверка интерфейса расчёта TenderHub в headless Chromium (CDP) против настоящих процессов
// server + worker и поддельного TenderHub по контракту (scripts/tenderhub-fake.ts; настоящий TenderHub не
// вызывается — U-04). Проверяется: связь этапа с тендером TenderHub, выгрузка и её состояния (идёт,
// выгружено, не удалась, данные менялись), ревизия provisional с блокировкой боевого выпуска (X-01) и
// отсутствием итога КП (Q-05), разделы, ДОП и пустые позиции, строки с точной ценой, вид ревизии
// verified на фикстуре контракта X-01 (не продуктовый путь), вид инженера, 390/360 px, тёмная тема.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-06/ui-check.mjs → artifacts/stage-06/ui-check.log.
// UI_SHOTS=<каталог> — дополнительно снимки экрана ключевых состояний для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPortalCapture, TenderHubApiSource, TenderHubHttpClient } from '../../packages/adapters/src/index.ts';
import { calculationContentHash, KP_TOTAL_RULE_NOT_SET } from '../../packages/core/src/index.ts';
import { createPool, recordSourceRevision, withTransaction } from '../../packages/db/src/index.ts';
import { standardTender, startFakeTenderHub, TH, TH_KEY } from '../../scripts/tenderhub-fake.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui06_test';
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
const hub = await startFakeTenderHub({ apiKey: TH_KEY });
hub.tenders.set(TH.tender, standardTender());
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui06-')),
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
  TENDERHUB_URL: hub.url,
  TENDERHUB_API_KEY: TH_KEY,
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
const text = (s) => `(document.body?.innerText ?? '').includes(${JSON.stringify(s)})`;
const fillLabeled = (label, value) =>
  evaluate(`(() => { const l = [...document.querySelectorAll('label')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(label)}));
    const el = l && document.getElementById(l.htmlFor); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const fill = (selector, value) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clickButton = (label) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.click(); return true; })()`);
const clickStartingWith = (label) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().includes(${JSON.stringify(label)}) && !x.disabled);
    if (!b) return false; b.click(); return true; })()`);
const api = (path, init = {}) =>
  evaluate(`(async () => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('kkp_csrf=')) ?? '').slice(9));
    const init = ${JSON.stringify(init)};
    const headers = { 'X-CSRF-Token': csrf, ...(init.headers ?? {}) };
    const r = await fetch('/api/v1' + ${JSON.stringify(path)}, { method: init.method ?? 'GET', headers, body: init.body });
    const t = await r.text();
    return { status: r.status, etag: r.headers.get('etag'), body: t ? JSON.parse(t) : null };
  })()`);
const noHorizontalScroll = () => evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth');
// Подпись видимой кнопки не обрезана, иконка не сжата до нуля (узкий экран).
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
const captureCount = async (stageId) => (await api(`/stages/${stageId}/calculation-captures`)).body.items.length;

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
  record('server + worker готовы (worker с адресом поддельного TenderHub)', ready);

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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/\b(401|404|409|412)\b/.test(m.params.entry.text)) {
      problems.push(`${m.params.entry.source}: ${m.params.entry.text.slice(0, 200)}`);
    }
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  record('вход администратора-руководителя', await login('demo.admin'));
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const me = (await api('/me')).body;
  const card = await api(`/tenders/${demo.id}`);
  const assign = await api(`/tenders/${demo.id}/members/${me.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': card.etag },
    body: JSON.stringify({ memberRole: 'manager' }),
  });
  record('администратор назначен участником тендера (admin.tender для связи этапа)', assign.status === 200, `HTTP ${assign.status}`);
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;

  // ---- связь этапа с тендером TenderHub
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=calculation` });
  record('у этапа есть вкладка «Расчёт»; этап ещё не связан с TenderHub', await waitFor(text('Этап не связан с тендером TenderHub')));
  await clickButton('Связать с TenderHub');
  await waitFor(`[...document.querySelectorAll('label')].some((l) => l.innerText.includes('Id тендера TenderHub'))`);
  await fillLabeled('Id тендера TenderHub', TH.tender);
  await clickButton('Сохранить связь');
  record('связь сохранена через форму и показана', await waitFor(`${text('Связь с TenderHub сохранена')} && ${text(TH.tender)}`));

  // ---- выгрузка: идёт → выгружено
  hub.beforeResponse = (route) => (route === 'overview' ? { kind: 'delay', ms: 1500 } : undefined);
  await clickButton('Выгрузить расчёт');
  record('состояние «Выгрузка идёт» видно, пока worker читает TenderHub', await waitFor(text('Выгрузка идёт'), 10_000));
  const done = await waitFor(`${text('Выгружено')} && ${text('Ревизия № 1')}`, 30_000);
  hub.beforeResponse = null;
  record('выгрузка завершена: ревизия № 1', done);
  record('ревизия помечена предварительной (provisional)', await evaluate(text('Предварительная (provisional)')));
  record(
    'X-01: боевой выпуск с ревизией заблокирован (CALCULATION_PROVISIONAL), тестовый возможен',
    await evaluate(`${text('CALCULATION_PROVISIONAL')} && ${text('X-01')} && ${text('тестовый выпуск возможен')}`),
  );
  record('Q-05: итог КП не выводится, значения TenderHub показаны как есть', await evaluate(`${text('Q-05')} && ${text('итог КП не выводит')} && ${text('860,9')}`));
  record('закрытие у источника недоступно до X-01', await evaluate(text('недоступно до X-01')));
  await waitFor(text('Заголовок раздела — не работа.'), 10_000);
  record(
    'позиции: раздел не считается работой, ДОП и позиция без строк видны, manual_volume без семантики',
    await evaluate(`${text('Заголовок раздела — не работа.')} && ${text('ДОП')} && ${text('Без строк')} && ${text('семантика не подтверждена')}`),
  );
  await clickStartingWith('Бетонирование плиты перекрытия');
  record('строки позиции: комплексная строка к работе и точная цена 21 знака', await waitFor(`${text('мат-комп.')} && ${text('к работе')} && ${text('345,678901')}`, 10_000));
  // У строки работ коммерческая стоимость — составляющая работ; нулевая составляющая материалов её не подменяет.
  record('строки позиции: КП работ и КП материалов показаны раздельно', await evaluate(`${text('КП работ 1\u202F200,6')} && ${text('КП материалов 600,3')}`));
  await sleep(300);
  record('нет горизонтальной прокрутки на 390 px (ревизия со строками)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('390-revision-lines');

  // ---- отказ доступа: ключ отозван
  hub.apiKey = 'thk_revoked_key';
  const before = await captureCount(stageId);
  await clickButton('Выгрузить расчёт');
  const failedShown = await waitFor(`${text('Выгрузка не удалась')} && ${text('TenderHub отклонил ключ')}`, 20_000);
  record('отказ TenderHub (401) показан причиной, ключ на странице не виден', failedShown && !(await evaluate(text(TH_KEY))));
  record('после отказа новой ревизии нет', (await captureCount(stageId)) === before + 1 && !(await evaluate(text('Ревизия № 2'))));
  hub.apiKey = TH_KEY;

  // ---- данные менялись во время каждой попытки
  let tick = 0;
  hub.beforeResponse = (route) => {
    if (route === 'overview') {
      tick += 1;
      hub.tenders.get(TH.tender).updated_at = new Date(Date.parse('2026-09-01T00:00:00Z') + tick * 1000).toISOString();
    }
  };
  await clickButton('Выгрузить расчёт');
  record(
    'inconsistent: «Данные менялись» с причиной, ложной ревизии нет',
    await waitFor(`${text('Данные менялись')} && ${text('менялись во время каждой попытки')}`, 60_000) && !(await evaluate(text('Ревизия № 2'))),
  );
  await shot('390-failed-inconsistent');
  hub.beforeResponse = null;

  // ---- вид ревизии verified: фикстура контракта X-01 (в продукте такой ревизии создать нечем)
  const pool = createPool(url('kontur_app'), 2);
  try {
    const src = await pool.query("SELECT id FROM stage_calculation_source WHERE stage_id = $1 AND role = 'primary'", [stageId]);
    const user = await pool.query("SELECT id FROM app_user WHERE login = 'demo.admin'");
    const bundle = await pool.query("SELECT raw_bundle_sha256 AS sha FROM calculation_capture WHERE stage_id = $1 AND status = 'complete' LIMIT 1", [stageId]);
    const capId = randomUUID();
    await pool.query(
      `INSERT INTO calculation_capture (id, stage_id, tender_id, source_id, system, external_tender_id, capture_kind, transport, trigger, requested_by)
       VALUES ($1, $2, $3, $4, 'tenderhub', $5, 'tenderhub_revision', 'api', 'manual', $6)`,
      [capId, stageId, demo.id, src.rows[0].id, TH.tender, user.rows[0].id],
    );
    const http = new TenderHubHttpClient({ baseUrl: hub.url, apiKey: TH_KEY, timeoutMs: 5000, rateLimitPerMinute: 1000, maxResponseBytes: 8 << 20, rateLimitWaits: 0 });
    const r = await runPortalCapture(new TenderHubApiSource(http), TH.tender);
    await withTransaction(pool, (client) =>
      recordSourceRevision(client, {
        captureId: capId,
        externalRevisionRef: 'TH-FIXTURE-1',
        content: r.content,
        contentHash: calculationContentHash(r.content),
        headerLexemes: r.headerLexemes,
        kpTotalSemantics: { ...KP_TOTAL_RULE_NOT_SET },
        rawBundleSha256: bundle.rows[0].sha,
        contractVersion: 'x01-contract-fixture',
      }),
    );
  } finally {
    await pool.end();
  }
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=calculation` });
  await waitFor(text('Ревизия № 2'), 15_000);
  record(
    'фикстура X-01: ревизия verified отличается видом и не несёт блокировки X-01',
    (await evaluate(`${text('Ревизия TenderHub (verified)')} && ${text('событий нет')}`)) && !(await evaluate(text('CALCULATION_PROVISIONAL'))),
  );
  await shot('390-verified-fixture');

  // ---- вид инженера: без правки связи, с запросом выгрузки
  await api('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  record('вход инженера', await login('demo.eng1'));
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=calculation` });
  await waitFor(text('Источник расчёта'));
  record(
    'инженер видит ревизии и может запросить выгрузку, но не меняет связь этапа',
    (await waitFor(text('Выгрузить расчёт'))) && !(await evaluate(text('Изменить связь'))),
  );

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=calculation` });
  await waitFor(text('Ревизии расчёта'));
  await sleep(800);
  record('нет горизонтальной прокрутки на 360 px (вкладка «Расчёт»)', await noHorizontalScroll());
  record('360 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('360-engineer');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=calculation` });
  await waitFor(text('Ревизии расчёта'));
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record('тёмная тема, 1280 px: ревизии и позиции отображаются', await waitFor(`${text('Ревизия №')} && ${text('Бетонирование')}`, 15_000));
  // Снимок — после переходов цвета кнопок при смене темы.
  if (SHOTS) await sleep(500);
  await shot('1280-dark');

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
  await hub.close();
  dropDb();
}

const out = join(ROOT, 'artifacts', 'stage-06');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(
  join(out, 'ui-check.log'),
  `# ui-check — ${new Date().toISOString()}, Chromium headless (CDP)${sandbox}, реальные server + worker, поддельный TenderHub по контракту (не live)\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
