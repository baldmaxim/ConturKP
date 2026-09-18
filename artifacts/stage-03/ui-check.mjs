// Этап 03: проверка интерфейса источников в headless Microsoft Edge против настоящих процессов server + worker (не mock).
// Требует: npm run build, запущенный кластер (npm run pg:start), Edge по пути EDGE_PATH или по умолчанию.
// Запуск: node artifacts/stage-03/ui-check.mjs → artifacts/stage-03/ui-check.log; код 0 только при всех PASS.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui03_test';
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
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui-')),
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
};

// Минимальный ZIP (stored) с UTF-8 именами.
const buildZip = (entries) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
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
const waitFor = async (expression, timeoutMs = 10_000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // Сразу после перехода document.body может отсутствовать: ошибку вычисления считаем «ещё нет».
    if (await evaluate(`Boolean(${expression})`).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};
const text = (s) => `(document.body?.innerText ?? '').includes(${JSON.stringify(s)})`;
// Ввод значения в управляемое поле React: нативный setter + событие input.
const fill = (selector, value) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clickButton = (label) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.click(); return true; })()`);

let edge;
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

  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'kontur-edge-'))}`, 'about:blank'], { stdio: 'ignore' });
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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/\b(401|404|412)\b/.test(m.params.entry.text)) {
      problems.push(`${m.params.entry.source}: ${m.params.entry.text.slice(0, 200)}`);
    }
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  // ---- Этап 03: источники через интерфейс
  const files = mkdtempSync(join(tmpdir(), 'kontur-ui03-files-'));
  const pdfPath = join(files, 'Техническое задание.pdf');
  writeFileSync(pdfPath, '%PDF-1.4\n% ui03 tz\n%%EOF\n');
  const zipPath = join(files, 'комплект.zip');
  writeFileSync(zipPath, buildZip([
    ['Проект/ПД-01.pdf', Buffer.from('%PDF-1.4\n% ui03 pd\n%%EOF\n')],
    ['../evil.pdf', Buffer.from('%PDF-1.4\n%%EOF\n')],
  ]));

  await send('Page.navigate', { url: `${BASE}/` });
  record('без входа открывается форма входа', await waitFor(`document.querySelector('input[name=username]')`));
  await fill('input[name=username]', 'demo.eng1');
  await fill('input[name=password]', PASSWORD);
  await evaluate(`document.querySelector('form button[type=submit]').click(), true`);
  record('вход инженера', await waitFor(text('DEMO-001')));

  const stageId = await evaluate(`(async () => {
    const t = await (await fetch('/api/v1/tenders')).json();
    const demo = t.items.find((x) => x.code === 'DEMO-001');
    const s = await (await fetch('/api/v1/tenders/' + demo.id + '/stages')).json();
    return s.items[0].id; })()`);
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=imports` });
  record('вкладка «Импорт» открыта', await waitFor(text('Выбрать файлы')));

  // Настоящий input[type=file]: файлы передаются через CDP, дальше работает код интерфейса.
  await send('DOM.enable');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [pdfPath, zipPath] });
  const processed = await waitFor(`${text('Есть отклонённые файлы')} && ${text('Готово')}`, 30_000);
  record('загрузка двух файлов: партии обработаны worker, статусы в интерфейсе', processed);
  record('нет горизонтальной прокрутки на вкладке «Импорт» (390 px)', await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));

  const batches = await evaluate(`fetch('/api/v1/stages/${stageId}/imports').then((r) => r.json()).then((b) => b.items)`);
  const zipBatch = batches.find((b) => b.uploadName === 'комплект.zip');
  await send('Page.navigate', { url: `${BASE}/imports/${zipBatch.id}?stage=${stageId}` });
  record('карточка партии: отказ ../ с причиной и пометкой «Нужен исход»', await waitFor(`${text('../evil.pdf')} && ${text('Нужен исход')} && ${text('Путь вне архива или ссылка')}`));

  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=documents` });
  record('вкладка «Документы»: зарегистрированные документы', await waitFor(`${text('Техническое задание.pdf')} && ${text('ПД-01.pdf')}`));
  const rev = await evaluate(`(async () => {
    const d = await (await fetch('/api/v1/stages/${stageId}/documents')).json();
    const doc = d.items.find((x) => x.title === 'Техническое задание.pdf');
    const r = await fetch('/api/v1/document-revisions/' + doc.latestRevisionId + '/content');
    return { status: r.status, csp: r.headers.get('content-security-policy'), body: await r.text(), id: doc.id };
  })()`);
  record('оригинал выдаётся по правам в песочнице CSP', rev.status === 200 && /sandbox/.test(rev.csp ?? '') && rev.body.includes('ui03 tz'));
  await send('Page.navigate', { url: `${BASE}/documents/${rev.id}?stage=${stageId}` });
  await waitFor("document.querySelector('details')");
  // Происхождения свёрнуты в <details>: раскрываем, как это сделал бы пользователь.
  await evaluate("document.querySelectorAll('details').forEach((d) => { d.open = true; }), true");
  record('карточка документа: редакция и происхождение «Загрузка»', await waitFor(`${text('Техническое задание.pdf')} && ${text('Загрузка')}`));

  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=sources` });
  await waitFor(text('Создать черновик состава'));
  await clickButton('Создать черновик состава');
  record('состав источников: черновик создан', await waitFor(text('Включить все без решения')));

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  for (const tab of ['imports', 'documents', 'sources']) {
    await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=${tab}` });
    await waitFor(`document.querySelector('main')`);
    await sleep(500);
    record(`нет горизонтальной прокрутки на 360 px (${tab})`, await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
  }
  rmSync(files, { recursive: true, force: true });

  record('нет ошибок консоли и нарушений CSP', problems.length === 0, problems.join(' | '));
} catch (err) {
  record('исключение сценария', false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    ws?.close();
  } catch {
    // уже закрыт
  }
  edge?.kill();
  for (const p of procs) p.kill();
  await sleep(500);
  dropDb();
}

const out = join(ROOT, 'artifacts', 'stage-03');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
writeFileSync(join(out, 'ui-check.log'), `# ui-check — ${new Date().toISOString()}, Microsoft Edge headless, реальные server + worker\n${lines.join('\n')}\n${summary}\n`);
console.log(summary);
process.exit(failed ? 1 : 0);
