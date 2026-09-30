// Этап 07: проверка интерфейса почты, вопросов–ответов и переговоров в headless Chromium (CDP) против
// настоящих процессов server + worker. Проверяется: статус MailHub и сервиса переговоров BLOCKED_EXTERNAL;
// регистрация ящика и выдача доступа администратором; импорт EML через кнопку (worker разбирает, вложение
// становится документом); карточка письма — цитата прежней переписки, вложение, предложение связи и её
// подтверждение; переписка, вопросы–ответы (импорт, история ревизий) и переговоры (подсказка участнику
// отдельно) во вкладках тендера; поиск этапа находит письмо с меткой источника, доказательство письма;
// 390/360 px без горизонтальной прокрутки, тёмная тема 1280 px, нет ошибок консоли и CSP.
// Требует: npm run build, PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL), Chromium по CHROME_PATH.
// Запуск: CHROME_NO_SANDBOX=1 node artifacts/stage-07/ui-check.mjs → artifacts/stage-07/ui-check.log.
// UI_SHOTS=<каталог> — снимки экрана ключевых состояний для просмотра человеком (в Git не входят).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eml } from '../../tests/mailFixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BROWSER =
  process.env.CHROME_PATH ??
  process.env.EDGE_PATH ??
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_ui07_test';
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
const FILES = mkdtempSync(join(tmpdir(), 'kontur-ui07-files-'));
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-ui07-')),
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
const key = () => `ui07-${randomBytes(6).toString('hex')}`;
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


const MARKER = 'ГИДРОЗАТВОР-8842';
const writeFile = (name, bytes) => {
  const p = join(FILES, name);
  writeFileSync(p, bytes);
  return p;
};
const pickNth = async (path, index = 0) => {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const nodes = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  const nodeId = nodes.result?.nodeIds?.[index];
  if (!nodeId) return false;
  await send('DOM.setFileInputFiles', { nodeId, files: [path] });
  return true;
};

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

  // ---- Почта: статус интеграций и регистрация ящика
  await send('Page.navigate', { url: `${BASE}/` });
  record('пункт «Почта» в шапке администратора ящиков', await waitFor(`[...document.querySelectorAll('a')].some((a) => a.innerText.trim() === 'Почта')`));
  await send('Page.navigate', { url: `${BASE}/mail` });
  record(
    'MailHub и сервис переговоров — BLOCKED_EXTERNAL с причиной',
    await waitFor(`${text('Автоматическое чтение MailHub: заблокировано внешней зависимостью X-03')} && ${text('Сервис переговоров: заблокировано внешней зависимостью Q-06')}`),
  );
  await clickButton('Зарегистрировать ящик');
  await waitFor(text('Новый почтовый ящик'));
  await fillLabeled('Адрес ящика', 'tender@contractor.example.test');
  await fillLabeled('Название', 'Тендерный отдел');
  await clickButton('Зарегистрировать');
  record('ящик зарегистрирован, открыт раздел доступа', await waitFor(`${text('Тендерный отдел')} && ${text('Выдать доступ')}`));
  const mailboxId = new URL(await evaluate('location.href')).pathname.split('/')[2];
  await clickButton('Выдать доступ');
  await waitFor(text('Доступ к ящику'));
  await fillLabeled('Пользователь', me.id);
  await sleep(200);
  await checkLabel('Импорт EML', true);
  await checkLabel('Связь с тендерами', true);
  await clickButton('Сохранить');
  record('выдача сохранена: чтение, импорт, связь', await waitFor(`${text('Доступ к ящику сохранён')} && ${text('Чтение писем · Импорт EML · Связь с тендерами')}`));
  await shot('390-mailbox-access');

  // ---- Импорт EML кнопкой
  const raw = eml({
    messageId: 'ui07-1@customer.example.test',
    subject: 'DEMO-001: гидроизоляция фундамента',
    from: 'Заказчик <customer@example.test>',
    text: `Согласуем ${MARKER}: обмазочная гидроизоляция в два слоя.\n\n> Ранее предлагали битумную мастику.`,
    attachments: [{ name: 'ведомость.csv', type: 'text/csv', bytes: Buffer.from('Позиция;Количество\nГидроизоляция;120\n', 'utf8') }],
  });
  await send('Page.navigate', { url: `${BASE}/mailboxes/${mailboxId}?tab=imports` });
  await waitFor(text('Выбрать файлы .eml'));
  await pickNth(writeFile('письмо.eml', raw));
  record('импорт EML: worker разобрал письмо — новая ревизия', await waitFor(`${text('Новая ревизия')} && ${text('Открыть письмо')}`, 30_000));
  record('нет горизонтальной прокрутки на 390 px (импорт)', await noHorizontalScroll());
  await clickLink('Открыть письмо');
  record(
    'карточка письма: тема, отправитель, текст и отдельно цитата прежней переписки',
    await waitFor(`${text('DEMO-001: гидроизоляция фундамента')} && ${text(MARKER)} && ${text('Цитата прежней переписки')} && ${text('Ранее предлагали битумную мастику')}`),
  );
  record('вложение — документ письма со скачиванием', await waitFor(`${text('ведомость.csv')} && ${text('Скачать')}`));
  record('предложение связи по коду тендера в теме — не связь', await waitFor(`${text('Предложения связи')} && ${text('код тендера в теме')} && ${text('не связано ни с одним')}`));
  record('нет горизонтальной прокрутки на 390 px (карточка письма)', await noHorizontalScroll());
  record('390 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('390-mail-message');
  await clickButton('Подтвердить…');
  await waitFor(text('Связать письмо с тендером'));
  await sleep(500);
  await fillLabeled('Этап', stageId);
  await clickButton('Подтвердить связь');
  record('связь подтверждена человеком, письмо связано с этапом', await waitFor(`${text('Связь с тендером подтверждена')} && ${text('Этап тендера')} && ${text('Снять связь')}`));
  const messageUrl = await evaluate('location.href');

  // ---- Вкладки тендера: переписка, вопросы–ответы, переговоры
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=mail` });
  record('вкладка «Переписка» тендера показывает связанное письмо', await waitFor(`${text('DEMO-001: гидроизоляция фундамента')} && ${text('Тендерный отдел')}`));
  const qa = {
    format: 'kontur.qa.v1',
    threads: [{ externalRef: 'Q-1', title: 'Разъяснения документации', items: [{ no: '1', question: 'Допускается ли бетон B30 вместо B25?', answer: 'Допускается.', status: 'answered' }, { no: '2', question: 'Срок поставки арматуры?', status: 'open' }] }],
  };
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=qa` });
  await waitFor(text('Импортировать файл'));
  await pickNth(writeFile('qa-1.json', Buffer.from(JSON.stringify(qa))));
  record('вопросы–ответы: импорт файла, тред с числом вопросов', await waitFor(`${text('Импортировано. Новых ревизий вопросов: 2')} && ${text('Вопросов: 2, без ответа: 1')}`));
  qa.threads[0].items[0].answer = 'Не допускается.';
  await pickNth(writeFile('qa-2.json', Buffer.from(JSON.stringify(qa))));
  await waitFor(text('Новых ревизий вопросов: 1'));
  await clickButton('Вопросов: 2, без ответа: 1');
  await waitFor(text('История ревизий (2)'));
  await clickButton('История ревизий (2)');
  record('вопрос: текущий ответ и история ревизий', await waitFor(`${text('Не допускается.')} && ${text('Ревизия 1')} && ${text('Допускается.')}`));
  record('нет горизонтальной прокрутки на 390 px (вопросы–ответы)', await noHorizontalScroll());
  await shot('390-qa');
  const negotiation = {
    format: 'kontur.negotiation.v1',
    session: { externalId: 'N-1', title: 'Переговоры по цене', startedAt: '2026-09-02T09:00:00+05:00', audio: { ref: 'audio://negotiations/N-1.ogg', sha256: null } },
    participants: [
      { speakerLabel: 'S1', name: 'Представитель заказчика', side: 'customer' },
      { speakerLabel: 'S2', name: 'Инженер подрядчика', side: 'contractor' },
    ],
    transcript: {
      revision: 'r1',
      segments: [
        { no: 1, speakerLabel: 'S1', startMs: 0, endMs: 8000, kind: 'speech', text: 'Мы рассмотрим снижение цены на пять процентов.' },
        { no: 2, speakerLabel: 'S2', startMs: 9000, endMs: 12000, kind: 'hint', text: 'Подсказка: уточнить срок оплаты.' },
      ],
    },
  };
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=negotiations` });
  record('переговоры: сервис не подключён (Q-06) — импорт файлом', await waitFor(`${text('Сервис переговоров не подключён')} && ${text('Импортировать файл')}`));
  await pickNth(writeFile('negotiation.json', Buffer.from(JSON.stringify(negotiation))));
  record('сессия переговоров импортирована', await waitFor(`${text('Импортирована новая редакция транскрипции')} && ${text('Переговоры по цене')}`));
  await clickLink('Переговоры по цене');
  record(
    'сессия: участники, реплика и отдельно подсказка участнику',
    await waitFor(`${text('Представитель заказчика')} && ${text('Мы рассмотрим снижение цены')} && ${text('Подсказка участнику')} && ${text('00:00–00:08')}`),
  );
  await shot('390-negotiation');

  // ---- Поиск этапа находит письмо; доказательство письма
  const indexed = await poll(async () => {
    const r = await api('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { kind: 'tender', tenderId: demo.id, mode: 'working', stageId }, query: MARKER, limit: 5 }),
    });
    return r.status === 200 && r.body.fused?.items?.some((i) => i.text.includes(MARKER)) ? r.body : null;
  }, 60_000);
  record('worker проиндексировал ревизию письма', Boolean(indexed));
  await send('Page.navigate', { url: `${BASE}/stages/${stageId}?tab=search` });
  await waitFor(`document.querySelector('form[role=search] input[maxlength="500"]')`);
  await fill('form[role=search] input[maxlength="500"]', MARKER);
  await clickButton('Найти');
  record('поиск: попадание из письма с шапкой и происхождением «Текст письма»', await waitFor(`${text('Письмо «DEMO-001: гидроизоляция фундамента»')} && ${text('Текст письма')}`, 20_000));
  await shot('390-search-mail');
  await clickLink('Открыть доказательство');
  record('доказательство письма: текст, блок письма, ссылка на письмо', await waitFor(`${text(MARKER)} && ${text('Блок 1 текста письма')} && ${text('Отправитель')}`));

  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: messageUrl });
  await waitFor(text('Снять связь'));
  await sleep(300);
  record('нет горизонтальной прокрутки на 360 px (карточка письма)', await noHorizontalScroll());
  record('360 px: подписи кнопок не обрезаны, иконки видны', await buttonsFit());
  await shot('360-mail-message');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: messageUrl });
  await waitFor(text('Цитата прежней переписки'));
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark'), true`);
  record('тёмная тема, 1280 px: карточка письма читается', await waitFor(`${text(MARKER)} && ${text('Связи с тендерами')}`));
  if (SHOTS) await sleep(500);
  await shot('1280-dark-mail-message');

  // ---- Пользователь без выдачи по ящику: раздел «Почта» не показан, письмо закрыто
  await logout();
  record('вход инженера без выдачи по ящику', await login('demo.eng1'));
  record('у инженера без выдачи нет пункта «Почта»', !(await evaluate(`[...document.querySelectorAll('a')].some((a) => a.innerText.trim() === 'Почта')`)));
  await send('Page.navigate', { url: messageUrl });
  record('письмо без mail.read — «не найдено или нет доступа»', await waitFor(text('Письмо не найдено или нет доступа')));
  await send('Page.navigate', { url: `${BASE}/tenders/${demo.id}?tab=mail` });
  record('переписка тендера без mail.read пуста', await waitFor(text('Связанных писем нет')));

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

const out = join(ROOT, 'artifacts', 'stage-07');
mkdirSync(out, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
const sandbox = process.env.CHROME_NO_SANDBOX === '1' ? ', без песочницы (--no-sandbox, AppArmor)' : '';
writeFileSync(join(out, 'ui-check.log'), `# ui-check — ${new Date().toISOString()}, Chromium headless (CDP)${sandbox}, реальные server + worker\n${lines.join('\n')}\n${summary}\n`);
console.log(summary);
process.exit(failed ? 1 : 0);
