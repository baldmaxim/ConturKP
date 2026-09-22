// Этап 04: проверка интерфейса распознавания в headless Microsoft Edge против настоящих
// процессов server + worker (не mock). Проверяется вертикальный результат этапа: загрузка
// экспортного архива RDWeb к редакции, явная неполнота (A16), участок оригинала на pdf.js
// поверх локального PDF (A17), разделение происхождения текста (I06) и заморозка состава.
// Требует: npm run build, запущенный кластер (npm run pg:start), Edge по пути EDGE_PATH.
// Запуск: node artifacts/stage-04/ui-check.mjs → artifacts/stage-04/ui-check.log; код 0 только при всех PASS.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRdwebExport } from '../../tests/rdweb.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui04_test';
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
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui04-')),
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
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
// Подпись сравнивается точно: «Заморозить» и «Заморозить состав» — разные кнопки,
// и вторая остаётся в DOM под открытым диалогом.
const clickButton = (label, scope = 'document') =>
  evaluate(`(() => { const root = ${scope}; if (!root) return false;
    const b = [...root.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)} && !x.disabled);
    if (!b) return false; b.click(); return true; })()`);
// Кнопка страницы прогона: номер лежит в первом span, остальное — подпись и бейдж.
const clickPage = (label) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => !x.disabled && x.querySelector('span')?.innerText.trim() === ${JSON.stringify(label)});
    if (!b) return false; b.click(); return true; })()`);
// Переход внутри приложения (без перезагрузки): ссылка «Открыть участок оригинала».
const clickEvidenceLink = (id) =>
  evaluate(`(() => { const a = document.querySelector('a[href="/evidence/' + ${JSON.stringify(id)} + '"]');
    if (!a) return false; a.click(); return true; })()`);
const overlayStyle = () =>
  evaluate(`(() => { const d = document.querySelector('canvas ~ div'); return d ? d.getAttribute('style') : null; })()`);

const setFiles = async (selector, files) => {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files });
};

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

  // Обезличенная фикстура: 4 страницы, вторая повёрнута, четвёртая без вывода (A16).
  const files = mkdtempSync(join(tmpdir(), 'kontur-ui04-files-'));
  const fixture = buildRdwebExport({ docName: 'Техническое задание', pages: 4, rotate90: [1], omitPagesInMd: [3] });
  const pdfPath = join(files, 'Техническое задание.pdf');
  const zipPath = join(files, 'Техническое задание_export.zip');
  writeFileSync(pdfPath, fixture.pdf);
  writeFileSync(zipPath, fixture.zip);

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

  // ---- регистрация оригинала (этап 03), затем импорт результатов распознавания (этап 04)
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=imports` });
  await waitFor(text('Выбрать файлы'));
  await setFiles('input[type=file]', [pdfPath]);
  record('оригинал загружен и зарегистрирован', await waitFor(text('Готово'), 30_000));

  const docId = await evaluate(`(async () => {
    const d = await (await fetch('/api/v1/stages/${stageId}/documents')).json();
    return d.items.find((x) => x.title === 'Техническое задание.pdf').id; })()`);
  await send('Page.navigate', { url: `${BASE}/documents/${docId}?stage=${stageId}` });
  record('карточка документа: распознавание ещё не выполнялось', await waitFor(text('Распознавание не выполнялось')));

  await setFiles('input[type=file]', [zipPath]);
  const partial = await waitFor(`${text('Распознано частично')} && ${text('Распознано 3 из 4')}`, 40_000);
  record('A16: экспорт разобран, неполнота названа числом', partial);
  record('нигде не написано «полностью проверено»', !(await evaluate(text('полностью проверено'))));

  await clickButton('Показать страницы и фрагменты');
  record('перечень нераспознанных страниц виден', await waitFor(text('Не распознаны')));

  const firstFragment = await evaluate(`(async () => {
    const d = await (await fetch('/api/v1/documents/${docId}')).json();
    const revisionId = d.latestRevisionId;
    const runs = await (await fetch('/api/v1/document-revisions/' + revisionId + '/recognition-runs')).json();
    const f = await (await fetch('/api/v1/recognition-runs/' + runs.items[0].id + '/fragments?pageIndex=1')).json();
    return f.items.find((x) => x.bboxNorm) ?? null; })()`);
  record('A17: у фрагмента повёрнутой страницы есть координаты и поворот', Boolean(firstFragment) && firstFragment.rotation === 90 && firstFragment.bboxNorm.length === 4);

  await send('Page.navigate', { url: `${BASE}/evidence/${firstFragment.id}` });
  const drawn = await waitFor(`(() => { const c = document.querySelector('canvas'); return c && c.width > 100 && c.height > 100; })()`, 40_000);
  record('участок оригинала отрисован pdf.js из локального PDF', drawn, await evaluate(`(document.querySelector('[role=alert], [role=status]')?.innerText ?? '').slice(0, 160)`));
  const highlighted = await waitFor(`document.querySelectorAll('canvas ~ div').length > 0 || document.querySelector('svg polygon') !== null`, 15_000);
  const stageDom = await evaluate(`(() => { const c = document.querySelector('canvas');
    const notices = [...document.querySelectorAll('[role=alert], [role=status]')].map((n) => n.innerText.trim()).join(' | ');
    return JSON.stringify({ siblings: c ? [...c.parentElement.children].map((e) => e.tagName) : null, w: c?.width, h: c?.height, notices }); })()`);
  record('выделение нанесено поверх страницы', highlighted, stageDom);
  record('I06: происхождение текста названо', await evaluate(`${text('Распознанный текст RDWeb')} || ${text('Описание модели')}`));
  record('crop_url не загружается: внешних запросов нет', await evaluate(`performance.getEntriesByType('resource').every((e) => new URL(e.name).origin === location.origin)`));

  // ---- R04-14: выделение принадлежит показанному фрагменту
  await send('Page.navigate', { url: `${BASE}/documents/${docId}?stage=${stageId}` });
  await waitFor(text('Показать страницы и фрагменты'));
  await clickButton('Показать страницы и фрагменты');
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.querySelector('span')?.innerText.trim() === '1')`);
  await clickPage('1');
  const page0Ready = await waitFor(text('blk-0-txt'), 20_000);
  record('страница 1 прогона открыта, её фрагменты видны', page0Ready);

  // Два фрагмента одной страницы одного PDF с разными прямоугольниками.
  const pair = await evaluate(`(async () => {
    const d = await (await fetch('/api/v1/documents/${docId}')).json();
    const runs = await (await fetch('/api/v1/document-revisions/' + d.latestRevisionId + '/recognition-runs')).json();
    const f = await (await fetch('/api/v1/recognition-runs/' + runs.items[0].id + '/fragments?pageIndex=0')).json();
    const rects = f.items.filter((x) => x.bboxNorm && x.shapeType !== 'polygon');
    const a = rects[0];
    const b = rects.find((x) => JSON.stringify(x.bboxNorm) !== JSON.stringify(a?.bboxNorm));
    return a && b ? { a: a.id, b: b.id } : null; })()`);
  record('на странице есть два фрагмента с разными рамками', pair !== null);

  await clickEvidenceLink(pair.a);
  const firstDrawn = await waitFor(`document.querySelector('canvas ~ div') !== null`, 40_000);
  const styleA = await overlayStyle();
  // Возврат назад — это переход внутри приложения: панель монтируется заново, поэтому
  // страницу прогона нужно выбрать снова, и только затем открыть второе доказательство.
  await evaluate('history.back()');
  await waitFor(text('Показать страницы и фрагменты'), 20_000);
  await clickButton('Показать страницы и фрагменты');
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.querySelector('span')?.innerText.trim() === '1')`, 20_000);
  await clickPage('1');
  await waitFor(text('blk-0-txt'), 20_000);
  await clickEvidenceLink(pair.b);
  // Переход внутри приложения между двумя фрагментами одной страницы одного PDF: рамка
  // обязана смениться, а не остаться от прежнего доказательства (R04-14).
  const styleChanged = await waitFor(`(() => { const d = document.querySelector('canvas ~ div');
    return d !== null && d.getAttribute('style') !== ${JSON.stringify(styleA)}; })()`, 40_000);
  const styleB = await overlayStyle();
  record('R04-14: переход между фрагментами меняет выделение', firstDrawn && styleChanged, `A=${styleA} B=${styleB}`);

  // ---- R04-15: выдача фрагментов принадлежит выбранной странице
  await send('Page.navigate', { url: `${BASE}/documents/${docId}?stage=${stageId}` });
  await waitFor(text('Показать страницы и фрагменты'));
  await clickButton('Показать страницы и фрагменты');
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.querySelector('span')?.innerText.trim() === '1')`);
  await clickPage('1');
  await waitFor(text('blk-0-txt'), 20_000);
  // Ответ на выдачу фрагментов задерживается: видно, что показывает интерфейс до ответа.
  await evaluate(`(() => { const f = window.fetch.bind(window);
    window.fetch = (...a) => (String(a[0]).includes('/fragments?') ? new Promise((r) => setTimeout(() => r(f(...a)), 2500)) : f(...a));
    return true; })()`);
  await clickPage('2');
  await sleep(600);
  const staleShown = await evaluate(text('blk-0-txt'));
  const staleMore = await evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim().startsWith('Показать ещё'))`);
  record('R04-15: до ответа фрагменты прежней страницы не показываются', !staleShown && !staleMore);
  const page1Ready = await waitFor(text('blk-1-txt'), 30_000);
  record('R04-15: после ответа видны фрагменты выбранной страницы', page1Ready && !(await evaluate(text('blk-0-txt'))));

  // ---- заморозка состава источников
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=sources` });
  await waitFor(text('Создать черновик состава'));
  await clickButton('Создать черновик состава');
  await waitFor(text('Включить все без решения'));
  await clickButton('Включить все без решения');
  await clickButton('Сохранить состав');
  await waitFor(text('Заморозить состав'));
  await clickButton('Заморозить состав');
  record('диалог подтверждения заморозки открыт', await waitFor(`document.querySelector('dialog[open]')`, 5000));
  await clickButton('Заморозить', "document.querySelector('dialog[open]')");
  const frozen = await waitFor(text('Заморожен'), 15_000);
  record('состав заморожен после распознавания', frozen, await evaluate(`(document.querySelector('[role=alert], [role=status]')?.innerText ?? '').slice(0, 200)`));

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  for (const [name, path] of [
    ['документ с распознаванием', `${BASE}/documents/${docId}?stage=${stageId}`],
    ['доказательство', `${BASE}/evidence/${firstFragment.id}`],
    ['состав источников', `${BASE}/stages/${stageId}?tab=sources`],
  ]) {
    await send('Page.navigate', { url: path });
    await waitFor(`document.querySelector('main')`);
    await sleep(800);
    record(`нет горизонтальной прокрутки на 360 px (${name})`, await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
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

const out = join(ROOT, 'artifacts', 'stage-04');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
writeFileSync(join(out, 'ui-check.log'), `# ui-check — ${new Date().toISOString()}, Microsoft Edge headless, реальные server + worker\n${lines.join('\n')}\n${summary}\n`);
console.log(summary);
process.exit(failed ? 1 : 0);
