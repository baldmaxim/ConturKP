// Сквозная проверка чистого старта на реальных процессах (этап 02):
// setup БД → migrate → bootstrap → демо-данные → server + worker → /ready → вход → перезапуск server.
// Этап 06: выгрузка расчёта worker из поддельного TenderHub (scripts/tenderhub-fake.ts) по ключу-маркеру.
// Этап 05a (scripts/smoke-05a.mjs): локальное распознавание DOCX договора автоматически, PDF-скана — OCR по явной команде.
// База kontur_kp_smoke_test создаётся заново и удаляется в конце. Пароль генерируется и не выводится.
// Результат: artifacts/stage-02/smoke.log; код 0 только если все шаги PASS.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { buildRdwebExport } from '../tests/rdweb.ts';
import { smokeLocalRecognition } from './smoke-05a.mjs';
import { PRECISE_RATE, TH, standardTender, startFakeTenderHub } from './tenderhub-fake.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_smoke_test';
// Свободный порт выбирается системой: фиксированный порт может быть занят другим процессом.
const PORT = await new Promise((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const url = (user) => {
  const u = new URL(ADMIN);
  u.username = user;
  u.password = '';
  u.pathname = `/${DB}`;
  return u.toString();
};
const INTAKE_ROOT = mkdtempSync(join(tmpdir(), 'kontur-smoke-intake-'));
const SECRET_MARKER = `smoke-secret-${randomBytes(6).toString('hex')}`;
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
// Поддельный TenderHub принимает только ключ-маркер: он же проверяется на отсутствие в журналах.
const hub = await startFakeTenderHub({ apiKey: SECRET_MARKER });
hub.tenders.set(TH.tender, standardTender());
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'kontur-smoke-')),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
  TENDERHUB_URL: hub.url,
  TENDERHUB_API_KEY: SECRET_MARKER,
  INTAKE_ROOTS: INTAKE_ROOT,
  INTAKE_STABILITY_SECONDS: '1',
};

const lines = [];
let failed = false;
const record = (step, ok, note = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`;
  lines.push(line);
  console.log(line);
  if (!ok) failed = true;
};

const runNode = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, input, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const children = [];
const startProc = (name, script) => {
  const p = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  children.push(p);
  return { p, output: () => out, name };
};
const stopProc = (h) =>
  new Promise((res) => {
    if (h.p.exitCode !== null) return res();
    h.p.once('exit', () => res());
    h.p.kill();
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitReady = async (timeoutMs) => {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/v1/ready`);
      last = await r.json();
      if (r.status === 200) return { ok: true, body: last };
    } catch {
      // сервер ещё не слушает
    }
    await sleep(500);
  }
  return { ok: false, body: last };
};

const cookieJar = new Map();
const absorb = (res) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookieJar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
// Минимальный ZIP (метод stored) для проверки разбора архивов на реальных процессах.
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

const cookieHeader = () => [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');

try {
  runNode(['-e', `const pg=require('pg');const c=new pg.Client({connectionString:${JSON.stringify(ADMIN)}});c.connect().then(()=>c.query('DROP DATABASE IF EXISTS ${DB} WITH (FORCE)')).then(()=>c.end())`]);

  let r = runNode(['scripts/db-setup.ts']);
  record('db:setup — роли и база', r.code === 0, r.out.trim().split('\n').at(-1));

  r = runNode(['scripts/db-migrate.ts']);
  record('db:migrate — пустая БД', r.code === 0 && /применена 0001/.test(r.out), r.out.trim().split('\n').at(-1));

  r = runNode(['scripts/db-migrate.ts']);
  record('db:migrate — повторный запуск без изменений', r.code === 0 && /применено миграций: 0/.test(r.out));

  r = runNode(['scripts/bootstrap.ts', '--login', 'smoke.owner', '--name', 'Проверка', '--password-stdin'], PASSWORD);
  record('bootstrap — первый администратор-руководитель', r.code === 0 && !r.out.includes(PASSWORD));

  r = runNode(['scripts/bootstrap.ts', '--login', 'smoke.second', '--name', 'Второй', '--password-stdin'], PASSWORD);
  record('bootstrap — повтор отклонён', r.code === 4);

  r = runNode(['scripts/seed-demo.ts', '--password-stdin'], PASSWORD);
  record('db:seed-demo — синтетические данные', r.code === 0 && !r.out.includes(PASSWORD), r.out.trim().split('\n').at(-1));

  r = runNode(['scripts/config-check.ts']);
  record('config:check — без значений секретов', r.code === 0 && !r.out.includes(SECRET_MARKER) && /TENDERHUB_API_KEY\s+задано/.test(r.out));

  let worker = startProc('worker', 'apps/worker/src/main.ts');
  let server = startProc('server', 'apps/server/src/main.ts');
  let ready = await waitReady(30_000);
  record('server + worker — /ready 200', ready.ok, JSON.stringify(ready.body?.checks ?? null));
  if (!ready.ok) console.log(server.output(), worker.output());

  const anon = await fetch(`${BASE}/api/v1/tenders`);
  record('неаутентифицированный запрос — 401', anon.status === 401);

  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ login: 'smoke.owner', password: PASSWORD }),
  });
  absorb(login);
  record('вход администратора', login.status === 200, `HTTP ${login.status}`);

  const tenders = await fetch(`${BASE}/api/v1/tenders`, { headers: { Cookie: cookieHeader() } });
  const tBody = await tenders.json();
  record('список тендеров (демо)', tenders.status === 200 && tBody.items.length === 2, `тендеров: ${tBody.items?.length}`);

  const webDist = join(ROOT, 'apps', 'web', 'dist', 'index.html');
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  record(
    'интерфейс раздаётся сервером с CSP',
    existsSync(webDist) && page.status === 200 && html.includes('<div id="root">') && /script-src 'self'/.test(page.headers.get('content-security-policy') ?? ''),
    existsSync(webDist) ? '' : 'нет сборки apps/web/dist — выполните npm run build',
  );

  // ---- Этап 03: источники на реальных процессах
  const csrf = decodeURIComponent(cookieJar.get('kkp_csrf') ?? '');
  const api = (path, init = {}) =>
    fetch(`${BASE}/api/v1${path}`, { ...init, headers: { Cookie: cookieHeader(), Origin: BASE, 'X-CSRF-Token': csrf, ...(init.headers ?? {}) } });
  const demo = tBody.items.find((t) => t.code === 'DEMO-001');
  // Администратор-владелец назначается руководителем демо-тендера, чтобы видеть его содержимое.
  const members = await api(`/tenders/${demo.id}/members`);
  const put = await api(`/tenders/${demo.id}/members/${(await (await api('/me')).json()).id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': members.headers.get('etag') },
    body: JSON.stringify({ memberRole: 'manager' }),
  });
  const stages = await (await api(`/tenders/${demo.id}/stages`)).json();
  const stageId = stages.items?.[0]?.id;
  record('назначение на демо-тендер', put.status === 200 && Boolean(stageId));
  const waitFor = async (fn, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = await fn();
      if (v) return v;
      await sleep(500);
    }
    return null;
  };
  const zip = buildZip([
    ['Проект/ТЗ.pdf', Buffer.from('%PDF-1.4\n% smoke tz\n%%EOF\n')],
    ['../evil.pdf', Buffer.from('%PDF-1.4\n%%EOF\n')],
  ]);
  const up = await api(`/stages/${stageId}/imports?name=${encodeURIComponent('комплект.zip')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': `smoke-${randomBytes(6).toString('hex')}` },
    body: zip,
  });
  const batch = await up.json();
  const done = await waitFor(async () => {
    const b = await (await api(`/imports/${batch.id}`)).json();
    return b.status !== 'running' ? b : null;
  }, 30_000);
  record(
    'загрузка архива обработана worker: ТЗ зарегистрирован, ../ отклонён',
    up.status === 202 && done?.status === 'completed_with_errors' && done.items.some((i) => i.memberPath === 'Проект/ТЗ.pdf' && i.status === 'registered') && done.items.some((i) => i.rejectReason === 'path_traversal'),
    done ? `статус ${done.status}` : 'нет результата',
  );

  // Worker остановлен: загрузка принимается, задание ждёт; после запуска worker обработка завершается.
  await stopProc(worker);
  const up2 = await api(`/stages/${stageId}/imports?name=${encodeURIComponent('после-остановки.pdf')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': `smoke-${randomBytes(6).toString('hex')}` },
    body: Buffer.from('%PDF-1.4\n% while worker is down\n%%EOF\n'),
  });
  const b2 = await up2.json();
  await sleep(1500);
  const still = await (await api(`/imports/${b2.id}`)).json();
  worker = startProc('worker', 'apps/worker/src/main.ts');
  const done2 = await waitFor(async () => {
    const b = await (await api(`/imports/${b2.id}`)).json();
    return b.status === 'completed' ? b : null;
  }, 30_000);
  record('worker остановлен → задание не потеряно, выполнено после запуска', still.status === 'running' && Boolean(done2));

  // Наблюдаемая папка: файл появляется, импортируется после стабильности.
  const folder = join(INTAKE_ROOT, 'demo');
  mkdirSync(folder);
  const ch = await api(`/tenders/${demo.id}/intake-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `smoke-${randomBytes(6).toString('hex')}` },
    body: JSON.stringify({ origin: 'smb', locator: folder, scanIntervalSeconds: 5 }),
  });
  const channel = await ch.json();
  writeFileSync(join(folder, 'Договор.pdf'), '%PDF-1.4\n% smoke contract\n%%EOF\n');
  const scanned = await waitFor(async () => {
    const list = await (await api(`/tenders/${demo.id}/intake-channels`)).json();
    const c = list.items.find((x) => x.id === channel.id);
    const docs = await (await api(`/stages/${stageId}/documents`)).json();
    return c?.current && docs.items.some((d) => d.title === 'Договор.pdf') ? c : null;
  }, 45_000);
  record('наблюдаемая папка: файл импортирован worker, канал актуален', ch.status === 201 && Boolean(scanned));

  // ---- Этап 05: индекс и поиск на реальных процессах (модель эмбеддингов не настроена)
  const octet = { 'Content-Type': 'application/octet-stream' };
  const json = { 'Content-Type': 'application/json' };
  const idem = () => ({ 'Idempotency-Key': `smoke-${randomBytes(6).toString('hex')}` });
  const fx = buildRdwebExport({ docName: 'ТЗ-smoke', pages: 2 });
  const upPdf = await api(`/stages/${stageId}/imports?name=${encodeURIComponent('ТЗ-smoke.pdf')}`, { method: 'POST', headers: { ...octet, ...idem() }, body: fx.pdf });
  const pdfBatch = await upPdf.json();
  const pdfDone = await waitFor(async () => {
    const b = await (await api(`/imports/${pdfBatch.id}`)).json();
    return b.status === 'completed' ? b : null;
  }, 30_000);
  const revisionId = pdfDone?.items?.[0]?.documentRevisionId;
  const rec = await api(`/document-revisions/${revisionId}/recognition-imports?name=export.zip`, { method: 'POST', headers: { ...octet, ...idem() }, body: fx.zip });
  const recBody = await rec.json();
  const runDone = await waitFor(async () => {
    const r = await (await api(`/recognition-runs/${recBody.id}`)).json();
    return r.status === 'complete' ? r : null;
  }, 30_000);
  record('этап 05: экспорт RDWeb принят и разобран worker', rec.status === 202 && Boolean(runDone));
  const draft = await api(`/stages/${stageId}/source-set-revisions`, { method: 'POST', headers: { ...json, ...idem() }, body: '{}' });
  const draftBody = await draft.json();
  const itemsPut = await api(`/source-set-revisions/${draftBody.id}/items`, {
    method: 'PUT',
    headers: { ...json, 'If-Match': draft.headers.get('etag') },
    body: JSON.stringify({ items: [{ documentRevisionId: revisionId, inclusion: 'included' }] }),
  });
  const frozen = await api(`/source-set-revisions/${draftBody.id}/freeze`, { method: 'POST', headers: { ...json, 'If-Match': itemsPut.headers.get('etag'), ...idem() }, body: '{}' });
  record('этап 05: состав этапа заморожен', itemsPut.status === 200 && frozen.status === 200);
  const search = (body) => api('/search', { method: 'POST', headers: json, body: JSON.stringify(body) });
  const working = { kind: 'tender', tenderId: demo.id, mode: 'working', stageId };
  // Индекс строит worker (проход обслуживания и пачки index.build): поиск повторяется до активной версии.
  const found = await waitFor(async () => {
    const r = await search({ context: working, query: 'ФИКС-АР', limit: 5 });
    if (r.status !== 200) return null;
    const b = await r.json();
    return b.fused?.items?.length ? b : null;
  }, 60_000);
  record(
    'этап 05: worker построил индекс, шифр штампа найден точной веткой',
    Boolean(found) && found.fused.items[0].matchedVia.includes('exact') && found.fused.items[0].fragmentKind === 'stamp_block',
    found ? `версия индекса ${found.index.seq}, единиц в области ${found.scope.units}` : 'нет результата',
  );
  record('этап 05: без модели смысловая ветка честно недоступна с причиной', found?.status === 'degraded' && found.semantic.reason === 'index_without_embeddings');
  const described = await (await search({ context: working, query: 'насос задвижка фильтр', limit: 5 })).json();
  record(
    'этап 05: описание модели не находится; пустой итог — «не найдено в области»',
    described.fused?.items?.length === 0 && /^не найдено в области/.test(described.emptyMessage ?? ''),
    described.emptyMessage ?? '',
  );
  const scopeRes = await api(`/stages/${stageId}/evidence-scopes`, { method: 'POST', headers: { ...json, ...idem() }, body: '{}' });
  const scope = await scopeRes.json();
  const review = await (await search({ context: { kind: 'tender', tenderId: demo.id, mode: 'review', evidenceScopeId: scope.id }, query: 'ФИКС-АР', limit: 5 })).json();
  record('этап 05: снимок области зафиксирован, поиск по снимку', scopeRes.status === 201 && review.fused?.items?.length > 0 && review.context?.mode === 'review');
  const reread = await api(`/search-runs/${found?.searchRunId}`);
  record('этап 05: прогон поиска перечитывается тем же итогом', reread.status === 200 && JSON.stringify((await reread.json()).fused) === JSON.stringify(found?.fused));

  // ---- Этап 06: выгрузка расчёта TenderHub worker'ом (только чтение, X-API-Key)
  const srcCur = await api(`/stages/${stageId}/calculation-source`);
  const link = await api(`/stages/${stageId}/calculation-source`, {
    method: 'PUT',
    headers: { ...json, 'If-Match': srcCur.headers.get('etag') },
    body: JSON.stringify({ externalTenderId: TH.tender, externalVersion: 3 }),
  });
  record('этап 06: этап связан с тендером TenderHub', srcCur.status === 200 && link.status === 200, `HTTP ${link.status}`);
  const capReq = await api(`/stages/${stageId}/calculation-captures`, { method: 'POST', headers: { ...json, ...idem() }, body: '{}' });
  const cap = await capReq.json();
  const capDone = await waitFor(async () => {
    const c = await (await api(`/calculation-captures/${cap.id}`)).json();
    return c.status !== 'capturing' ? c : null;
  }, 60_000);
  record('этап 06: worker выгрузил расчёт — ревизия provisional', capReq.status === 202 && capDone?.status === 'complete', capDone ? `статус ${capDone.status}` : 'нет результата');
  const revs = await (await api(`/stages/${stageId}/calculation-revisions`)).json();
  const rev = revs.items?.[0];
  record(
    'этап 06: X-01 — боевой выпуск заблокирован CALCULATION_PROVISIONAL, закрытия у источника нет',
    revs.items?.length === 1 && rev.kind === 'provisional' && rev.productionGate.allowed === false && rev.productionGate.blockers.includes('CALCULATION_PROVISIONAL') && rev.closureAvailable === false,
  );
  record('этап 06: Q-05 — итог КП не заполнен, правило не задано', rev?.kpTotal?.value === null && rev.kpTotal.rule === null && rev.kpTotal.semantics?.status === 'rule_not_set');
  const lines = await (await api(`/calculation-revisions/${rev?.id}/lines?positionId=${TH.p1}`)).json();
  record('этап 06: цена 21 знака дошла до API без потери точности', lines.items?.some((l) => l.unitRate?.amount === PRECISE_RATE), `строк: ${lines.items?.length}`);
  record(
    'этап 06: к TenderHub только GET с X-API-Key, без Authorization',
    hub.requests.length > 0 && hub.requests.every((q) => q.method === 'GET' && q.apiKey === SECRET_MARKER && q.authorization === undefined),
    `запросов: ${hub.requests.length}`,
  );

  // ---- Этап 06a: договорной контур на реальных процессах — права fail-closed, распознавание, два контекста поиска
  const owner = await (await api('/me')).json();
  const creator = await api(`/admin/contract-creators/${owner.id}`, { method: 'PUT', headers: json, body: '{}' });
  const contractRes = await api('/contracts', { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ number: 'SMOKE-1', title: 'Договор smoke' }) });
  const contract = await contractRes.json();
  record(
    'этап 06a: contract.create — явной выдачей; создатель получает чтение и ведение',
    creator.status === 200 && contractRes.status === 201 && contract.capabilities?.join(',') === 'contract.read,contract.manage',
  );
  const cfx = buildRdwebExport({ docName: 'Договор-smoke', pages: 1 });
  const cdoc = await api(`/contracts/${contract.id}/documents?name=${encodeURIComponent('Договор-smoke.pdf')}&role=contract`, {
    method: 'POST',
    headers: { ...octet, ...idem() },
    body: cfx.pdf,
  });
  const cdocBody = await cdoc.json();
  const crec = await api(`/document-revisions/${cdocBody.revisionId}/recognition-imports?name=export.zip`, { method: 'POST', headers: { ...octet, ...idem() }, body: cfx.zip });
  const crecBody = await crec.json();
  const crun = await waitFor(async () => {
    const r = await (await api(`/recognition-runs/${crecBody.id}`)).json();
    return r.status === 'complete' ? r : null;
  }, 30_000);
  record('этап 06a: основной документ договора загружен и распознан worker по экспорту RDWeb', cdoc.status === 201 && crec.status === 202 && Boolean(crun));
  const cfound = await waitFor(async () => {
    const r = await search({ context: { kind: 'contract', contractId: contract.id }, query: 'ФИКС-АР', limit: 5 });
    if (r.status !== 200) return null;
    const b = await r.json();
    return b.fused?.items?.length ? b : null;
  }, 60_000);
  record(
    'этап 06a: поиск в контексте договора — только фрагменты договора',
    Boolean(cfound) && cfound.context.kind === 'contract' && cfound.fused.items.every((h) => h.contractId === contract.id),
  );
  const tenderOnly = await (await search({ context: working, query: 'ФИКС-АР', limit: 20 })).json();
  record('этап 06a: документ договора не попадает в поиск тендера без включения в состав', (tenderOnly.fused?.items ?? []).every((h) => h.contractId === null));
  const contractEtag = (await api(`/contracts/${contract.id}`)).headers.get('etag');
  const access = await api(`/contracts/${contract.id}/access/${owner.id}`, {
    method: 'PUT',
    headers: { ...json, 'If-Match': contractEtag },
    body: JSON.stringify({ capabilities: ['contract.read', 'contract.link', 'contract.manage'] }),
  });
  const linkRes = await api(`/contracts/${contract.id}/tenders`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ tenderId: demo.id }) });
  const candidates = await (await api(`/stages/${stageId}/contract-candidates`)).json();
  record(
    'этап 06a: связь с тендером подтверждена; единица договора — только кандидат в состав этапа',
    access.status === 200 && linkRes.status === 201 && candidates.items?.some((c) => c.documentRevisionId === cdocBody.revisionId),
  );
  // Вторая сессия: инженер демо-тендера без выдачи по договору.
  const jar2 = new Map();
  const login2 = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ login: 'demo.eng2', password: PASSWORD }),
  });
  for (const c of login2.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar2.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const api2 = (path, init = {}) =>
    fetch(`${BASE}/api/v1${path}`, {
      ...init,
      headers: {
        Cookie: [...jar2].map(([k, v]) => `${k}=${v}`).join('; '),
        Origin: BASE,
        'X-CSRF-Token': decodeURIComponent(jar2.get('kkp_csrf') ?? ''),
        ...(init.headers ?? {}),
      },
    });
  const hidden = await api2(`/contracts/${contract.id}`);
  const hiddenSearch = await api2('/search', { method: 'POST', headers: json, body: JSON.stringify({ context: { kind: 'contract', contractId: contract.id }, query: 'ФИКС-АР' }) });
  const hiddenFile = await api2(`/document-revisions/${cdocBody.revisionId}/content`);
  const hiddenLinks = await (await api2(`/tenders/${demo.id}/contracts`)).json();
  record(
    'этап 06a: пользователь без выдачи — договор, поиск и оригинал 404, связь тендера не названа',
    login2.status === 200 && hidden.status === 404 && hiddenSearch.status === 404 && hiddenFile.status === 404 && hiddenLinks.items?.length === 0,
  );

  // ---- Этап 05a: локальное распознавание — scripts/smoke-05a.mjs
  await smokeLocalRecognition({ root: ROOT, api, search, record, waitFor, sleep, idem, octet, json, contractId: contract.id, mainDocumentId: cdocBody.documentId, stageId });

  await stopProc(server);
  server = startProc('server', 'apps/server/src/main.ts');
  ready = await waitReady(30_000);
  record('перезапуск server — /ready 200', ready.ok);
  const me = await fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookieHeader() } });
  record('перезапуск server — сессия действительна', me.status === 200);

  await stopProc(server);
  await stopProc(worker);
  const logs = `${server.output()}${worker.output()}`;
  rmSync(INTAKE_ROOT, { recursive: true, force: true });
  record('журналы процессов без секретов', !logs.includes(PASSWORD) && !logs.includes(SECRET_MARKER));
} catch (err) {
  record('исключение сценария', false, err instanceof Error ? err.message : String(err));
} finally {
  for (const c of children) if (c.exitCode === null) c.kill();
  await hub.close();
  runNode(['-e', `const pg=require('pg');const c=new pg.Client({connectionString:${JSON.stringify(ADMIN)}});c.connect().then(()=>c.query('DROP DATABASE IF EXISTS ${DB} WITH (FORCE)')).then(()=>c.end())`]);
}

// Каталог артефактов текущего этапа (SMOKE_STAGE), логи прежних этапов не перезаписываются.
const dir = join(ROOT, 'artifacts', process.env.SMOKE_STAGE ?? 'stage-03');
mkdirSync(dir, { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
writeFileSync(
  join(dir, 'smoke.log'),
  `# npm run smoke — ${new Date().toISOString()}\n# Node ${process.version}, PostgreSQL ${ADMIN.replace(/\/\/[^@]*@/, '//***@')}\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
