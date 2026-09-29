// Этап 06a: проверка интерфейса договорного контура в headless Chromium (CDP) против настоящих процессов
// server + worker. Проверяется: выдача права создавать договоры, создание договора, загрузка основного
// документа и допсоглашения через интерфейс, распознавание по экспорту RDWeb, поиск в контексте договора,
// выдача права связи и подтверждение связи с тендером, договоры тендера, кандидат из договора в составе
// этапа, вид инженера без права (элемент — только факт, поиск — «исключено по правам»), 390/360 px, тёмная тема.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-06a/ui-check.mjs → artifacts/stage-06a/ui-check.log.
// UI_SHOTS=<каталог> — дополнительно снимки экрана ключевых состояний для просмотра человеком (в Git не входят).
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
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui06a_test';
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
const FILES = mkdtempSync(join(tmpdir(), 'kontur-ui06a-files-'));
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui06a-')),
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
const key = () => `ui06a-${randomBytes(6).toString('hex')}`;
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

const fixture = buildRdwebExport({ docName: 'Договор-подряда', pages: 2 });
const mainPath = join(FILES, 'Договор-подряда.pdf');
const addendumPath = join(FILES, 'ДС-1.pdf');
const exportPath = join(FILES, 'export.zip');
writeFileSync(mainPath, fixture.pdf);
writeFileSync(addendumPath, Buffer.from('%PDF-1.4\n% допсоглашение 1\n%%EOF\n', 'utf8'));
writeFileSync(exportPath, fixture.zip);

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

  // ---- администратор-руководитель: право создавать договоры
  record('вход администратора-руководителя', await login('demo.admin'));
  record('пункт «Договоры» в навигации — у администратора договоров', await evaluate(`[...document.querySelectorAll('a')].some((a) => a.innerText.trim() === 'Договоры')`));
  await send('Page.navigate', { url: `${BASE}/admin?tab=contracts` });
  record('вкладка «Создание договоров» у администратора', await waitFor(text('Разрешить создавать договоры')));
  await evaluate(`(() => { const card = [...document.querySelectorAll('li')].find((li) => li.innerText.includes('demo.admin'));
    const b = card && [...card.querySelectorAll('button')].find((x) => x.innerText.includes('Разрешить')); b?.click(); return Boolean(b); })()`);
  record('право создавать договоры выдано через интерфейс', await waitFor(text('Создаёт договоры')));

  // ---- создание договора
  await send('Page.navigate', { url: `${BASE}/contracts` });
  record('раздел «Договоры» открыт; договоров пока нет', await waitFor(text('Договоров пока нет')));
  await clickButton('Создать договор');
  await waitFor(`[...document.querySelectorAll('label')].some((l) => l.innerText.includes('Номер'))`);
  await fillLabeled('Номер', '12/2026-П');
  await fillLabeled('Предмет', 'Договор подряда на фасадные работы');
  await fillLabeled('Контрагент', 'ООО «Заказчик»');
  await fillLabeled('Дата подписания', '2026-09-01');
  await evaluate(`[...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Создать договор' && x.type === 'submit')?.click(), true`);
  record('договор создан, открыта его страница с вкладкой «Документы»', await waitFor(`${text('Загрузка документа')} && ${text('12/2026-П')}`));
  const contractId = (await evaluate('location.pathname')).split('/').pop();

  // ---- основной документ и допсоглашение через интерфейс
  await pickFile(mainPath);
  record('основной договор загружен через интерфейс', await waitFor(`${text('Договор-подряда.pdf')} && ${text('Основной договор')} && ${text('Не распознан')}`, 20_000));
  await waitFor(`[...document.querySelectorAll('label')].some((l) => l.innerText.includes('Роль документа'))`);
  await fillLabeled('Роль документа', 'addendum');
  await pickFile(addendumPath);
  record('допсоглашение загружено и связано с основным документом', await waitFor(`${text('ДС-1.pdf')} && ${text('Допсоглашение')}`, 20_000));
  await pickFile(mainPath);
  record('повтор того же файла — та же редакция, а не новый документ', await waitFor(text('уже есть в договоре'), 10_000));
  await sleep(300);
  record('нет горизонтальной прокрутки на 390 px (документы договора)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('390-contract-documents');

  // ---- распознавание основного документа по экспорту RDWeb
  await clickLink('Договор-подряда.pdf');
  record('страница документа договора: редакция и загрузка экспорта RDWeb', await waitFor(`${text('Ред. 1')} && ${text('Загрузить новую редакцию')}`));
  const docPath = await evaluate('location.pathname');
  // На странице документа два поля выбора файла: новая редакция и экспорт распознавания — нужен второй.
  await evaluate(`(() => { const inputs = document.querySelectorAll('input[type=file]'); inputs.forEach((i, n) => { if (n === 0) i.setAttribute('data-skip', '1'); }); return inputs.length; })()`);
  const doc = await send('DOM.getDocument', { depth: -1 });
  const exportInput = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]:not([data-skip])' });
  await send('DOM.setFileInputFiles', { nodeId: exportInput.result.nodeId, files: [exportPath] });
  record('экспорт RDWeb принят и распознан существующим конвейером', await waitFor(text('Распознано 2 из 2'), 60_000), docPath);

  // ---- поиск в контексте договора
  const indexed = await poll(async () => {
    const r = await api('/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: { kind: 'contract', contractId }, query: 'ФИКС-АР', limit: 5 }) });
    return r.status === 200 && r.body.fused?.items?.length ? r.body : null;
  }, 60_000);
  record('worker проиндексировал редакцию договора', Boolean(indexed));
  await send('Page.navigate', { url: `${BASE}/contracts/${contractId}?tab=search` });
  await waitFor(`document.querySelector('form[role=search] input[maxlength="500"]')`);
  await fill('form[role=search] input[maxlength="500"]', 'ФИКС-АР');
  await clickButton('Найти в договоре');
  record('поиск по договору: цитата помечена «Документ договора»', await waitFor(`${text('Документ договора')} && ${text('Открыть доказательство')}`, 15_000));
  await shot('390-contract-search');

  // ---- доступ: право связи себе, связь с тендером
  await send('Page.navigate', { url: `${BASE}/contracts/${contractId}?tab=tenders` });
  record('без права связи — пояснение, кнопки связи нет', await waitFor(text('Связь подтверждает пользователь с правом')));
  await send('Page.navigate', { url: `${BASE}/contracts/${contractId}?tab=access` });
  await waitFor(text('Выдать доступ'));
  await evaluate(`(() => { const card = [...document.querySelectorAll('li')].find((li) => li.innerText.includes('demo.admin'));
    const b = card && [...card.querySelectorAll('button')].find((x) => x.innerText.includes('Изменить')); b?.click(); return Boolean(b); })()`);
  await waitFor(text('Права по договору'));
  await checkLabel('Связь с тендерами', true);
  await clickButton('Сохранить');
  record('администратор договоров выдал право связи через вкладку «Доступ»', await waitFor(text('Доступ к договору сохранён')));
  const demo = (await api('/tenders')).body.items.find((t) => t.code === 'DEMO-001');
  const me = (await api('/me')).body;
  const card = await api(`/tenders/${demo.id}`);
  await api(`/tenders/${demo.id}/members/${me.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': card.etag }, body: JSON.stringify({ memberRole: 'manager' }) });
  await send('Page.navigate', { url: `${BASE}/contracts/${contractId}?tab=tenders` });
  await waitFor(text('Связать с тендером'));
  await clickButton('Связать с тендером');
  await waitFor(`[...document.querySelectorAll('label')].some((l) => l.innerText.startsWith('Тендер'))`);
  await sleep(500);
  await fillLabeled('Тендер', demo.id);
  await evaluate(`[...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Подтвердить связь')?.click(), true`);
  record('связь с тендером подтверждена через диалог и показана «Действует»', await waitFor(`${text('Связь с тендером подтверждена')} && ${text('Действует')} && ${text('DEMO-001')}`));
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=contracts` });
  record('договор виден во вкладке «Договоры» тендера', await waitFor(`${text('12/2026-П')} && ${text('чтение')}`));

  // ---- кандидат из договора в составе этапа
  const stageId = (await api(`/tenders/${demo.id}/stages`)).body.items[0].id;
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=sources` });
  await waitFor(`${text('Создать черновик состава')} || ${text('Изменить состав')}`);
  if (await evaluate(text('Создать черновик состава'))) await clickButton('Создать черновик состава');
  else await clickButton('Изменить состав');
  record('в редакторе состава — кандидат из связанного договора', await waitFor(`${text('Договор 12/2026-П')} && ${text('Договор-подряда.pdf')}`));
  await evaluate(`(() => { const li = [...document.querySelectorAll('li')].find((x) => x.innerText.includes('Договор 12/2026-П') && x.innerText.includes('Договор-подряда.pdf'));
    const radio = li && [...li.querySelectorAll('label')].find((l) => l.innerText.trim() === 'Включить')?.querySelector('input'); radio?.click(); return Boolean(radio); })()`);
  await clickButton('Сохранить состав');
  record('редакция договора включена в состав явно', await waitFor(`${text('Состав источников сохранён')} && ${text('Договор-подряда.pdf (договор)')}`));
  await logout();

  // ---- инженер без права по договору
  record('вход инженера', await login('demo.eng1'));
  record('у инженера без выдач нет раздела «Договоры»', !(await evaluate(`[...document.querySelectorAll('a')].some((a) => a.innerText.trim() === 'Договоры')`)));
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=sources` });
  record('элемент договора в составе — только факт, без названия', await waitFor(`${text('Документ договора (нет права чтения)')}`) && !(await evaluate(text('Договор-подряда.pdf'))));
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=contracts` });
  record('договоры тендера: связь без выдачи не называется', await waitFor(text('Связанных договоров нет')) && !(await evaluate(text('12/2026-П'))));
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=search` });
  await waitFor(`document.querySelector('form[role=search] input[maxlength="500"]')`);
  await fill('form[role=search] input[maxlength="500"]', 'ФИКС-АР');
  await clickButton('Найти');
  record('поиск этапа: единица договора исключена по правам и видна только числом', await waitFor(text('Исключено по правам единиц источника: 1'), 15_000) && !(await evaluate(text('Документ договора'))));
  await send('Page.navigate', { url: `${BASE}/contracts/${contractId}` });
  record('прямой переход к договору — «не найден или нет доступа»', await waitFor(text('Договор не найден или нет доступа')));

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=sources` });
  await waitFor(text('Документ договора (нет права чтения)'));
  await sleep(600);
  record('нет горизонтальной прокрутки на 360 px (состав с элементом договора)', await noHorizontalScroll());
  record('360 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('360-engineer-sources');
  await logout();

  // ---- тёмная тема, 1280 px: страница договора
  record('повторный вход администратора', await login('demo.admin'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/contracts/${contractId}?tab=card` });
  await waitFor(text('Мои права'));
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record('тёмная тема, 1280 px: карточка договора с правами пользователя', await waitFor(`${text('ООО «Заказчик»')} && ${text('Связь с тендерами')}`));
  if (SHOTS) await sleep(500);
  await shot('1280-dark-contract');

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

const out = join(ROOT, 'artifacts', 'stage-06a');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(join(out, 'ui-check.log'), `# ui-check — ${new Date().toISOString()}, Chromium headless (CDP)${sandbox}, реальные server + worker\n${lines.join('\n')}\n${summary}\n`);
console.log(summary);
process.exit(failed ? 1 : 0);
