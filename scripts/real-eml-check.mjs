// Этап 07, Review 07-1: проверка настоящего EML владельца (OD-07-4) штатным путём
// `mailbox → import EML → worker → mail message/revision` на настоящих server + worker и отдельной
// временной базе. Проверяются 11 пунктов ревью; журнал безопасен для передачи ревьюеру: в нём только
// размер файла, структура MIME (типы, кодировки, способы передачи), наличие полей, числа и PASS/FAIL —
// без темы, адресов, тела, имён файлов и вложений. Ни путь к файлу, ни его имя в журнал не пишутся.
// Запуск: node scripts/real-eml-check.mjs <письмо.eml> → artifacts/stage-07/real-eml-check.log (REAL_EML_LOG — другой путь)
// Требует: npm run build не нужен; PostgreSQL ≥ 17 с pgvector (KONTUR_TEST_ADMIN_URL).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const FILE = process.argv[2];
if (!FILE || !existsSync(FILE)) {
  console.error('Укажите путь к файлу .eml: node scripts/real-eml-check.mjs <письмо.eml>');
  process.exit(2);
}
const RAW = readFileSync(FILE);
const ADMIN = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
const DB = 'kontur_kp_real_eml_test';
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
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;
const STORAGE = mkdtempSync(join(tmpdir(), 'kontur-real-eml-'));
const env = {
  ...process.env,
  KONTUR_ENV: 'test',
  DATABASE_ADMIN_URL: ADMIN,
  DATABASE_URL: url('kontur_app'),
  DATABASE_MIGRATOR_URL: url('kontur_migrator'),
  STORAGE_ROOT: STORAGE,
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: String(PORT),
  ALLOWED_ORIGINS: BASE,
};

const lines = [];
let failed = false;
const info = (line) => {
  lines.push(`      ${line}`);
  console.log(`      ${line}`);
};
const record = (step, ok, note = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${step}${note ? ` — ${note}` : ''}`;
  lines.push(line);
  console.log(line);
  if (!ok) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastOut = '';
const runNode = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, input, encoding: 'utf8' });
  lastOut = `${r.stdout}${r.stderr}`.trim().split('\n').at(-1) ?? '';
  return r.status;
};
const dropDb = () =>
  runNode(['-e', `const pg=require('pg');const c=new pg.Client({connectionString:${JSON.stringify(ADMIN)}});c.connect().then(()=>c.query('DROP DATABASE IF EXISTS ${DB} WITH (FORCE)')).then(()=>c.end())`]);
const children = [];
const start = (script) => {
  const p = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  children.push(p);
  return () => out;
};
const waitFor = async (fn, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  return null;
};

// ---------------------------------------------------------------- Структура MIME без содержимого

const headerBlock = (buf) => {
  const text = buf.toString('latin1');
  const end = text.search(/\r?\n\r?\n/u);
  const head = end < 0 ? text : text.slice(0, end);
  const body = end < 0 ? '' : text.slice(end).replace(/^\r?\n\r?\n/u, '');
  const headers = new Map();
  for (const line of head.replace(/\r?\n[ \t]+/gu, ' ').split(/\r?\n/u)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(i + 1).trim()]);
  }
  return { headers, body };
};
const param = (value, name) => {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'iu').exec(value ?? '');
  return m ? (m[2] ?? m[1]).trim() : null;
};
const describePart = (text, depth, out) => {
  const { headers, body } = headerBlock(Buffer.from(text, 'latin1'));
  const ctRaw = headers.get('content-type')?.[0] ?? 'text/plain';
  const type = ctRaw.split(';')[0].trim().toLowerCase();
  const charset = param(ctRaw, 'charset')?.toLowerCase() ?? null;
  const cte = (headers.get('content-transfer-encoding')?.[0] ?? '7bit').toLowerCase();
  const disposition = (headers.get('content-disposition')?.[0] ?? '').split(';')[0].trim().toLowerCase() || null;
  if (type.startsWith('multipart/') && depth < 10) {
    out.push(`${'  '.repeat(depth)}${type}`);
    const boundary = param(ctRaw, 'boundary');
    if (!boundary) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`, 'u')).slice(1, -1);
    for (const p of parts) if (p.trim()) describePart(p, depth + 1, out);
    return;
  }
  out.push(`${'  '.repeat(depth)}${type}${charset ? `; charset=${charset}` : ''}; ${cte}${disposition ? `; ${disposition}` : ''}`);
};
const encodedWords = (values) => {
  const words = values.flatMap((v) => [...v.matchAll(/=\?([^?]+)\?([bqBQ])\?/gu)].map((m) => `${m[1].toLowerCase()}/${m[2].toUpperCase()}`));
  return words.length === 0 ? 'нет' : [...new Set(words)].join(', ');
};

// Кириллица без повреждений: нет U+FFFD, нет остатков quoted-printable и encoded-word, нет «кракозябр»
// (UTF-8, прочитанный как CP1251 или Latin-1: доля «Р»/«С» среди кириллицы и пары Ð/Ñ).
const textHealth = (s) => {
  const cyr = (s.match(/[Ѐ-ӿ]/gu) ?? []).length;
  const rs = (s.match(/[РС]/gu) ?? []).length;
  return {
    cyrillic: cyr,
    replacement: s.includes('�'),
    latinMojibake: /[ÐÑ][\u0080-¿]/u.test(s),
    cp1251Mojibake: cyr >= 20 && rs / cyr > 0.25,
    qpLeftover: /(=[0-9A-F]{2}){3,}/u.test(s),
    encodedWordLeftover: /=\?[^?]+\?[bqBQ]\?/u.test(s),
    htmlLeftover: /<\/?(p|div|br|span|table|td|tr|html|body)\b[^>]*>/iu.test(s),
  };
};
const healthy = (h) => !h.replacement && !h.latinMojibake && !h.cp1251Mojibake && !h.qpLeftover && !h.encodedWordLeftover && !h.htmlLeftover;
const healthNote = (h) =>
  [
    `кириллических символов ${h.cyrillic}`,
    h.replacement ? 'есть U+FFFD' : null,
    h.latinMojibake || h.cp1251Mojibake ? 'признаки неверной кодировки' : null,
    h.qpLeftover ? 'остатки quoted-printable' : null,
    h.encodedWordLeftover ? 'остатки encoded-word' : null,
    h.htmlLeftover ? 'остатки разметки HTML' : null,
  ]
    .filter(Boolean)
    .join(', ');

let cookie = '';
let csrf = '';
const api = (path, init = {}) =>
  fetch(`${BASE}/api/v1${path}`, { ...init, headers: { Cookie: cookie, Origin: BASE, 'X-CSRF-Token': csrf, ...(init.headers ?? {}) } });
const idem = () => ({ 'Idempotency-Key': `real-eml-${randomBytes(6).toString('hex')}` });
const json = { 'Content-Type': 'application/json' };
const importEml = async (mailboxId) => {
  const r = await api(`/mailboxes/${mailboxId}/imports?name=real.eml`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...idem() }, body: RAW });
  if (r.status !== 202) return { status: r.status };
  const id = (await r.json()).id;
  return waitFor(async () => {
    const b = await (await api(`/mail-imports/${id}`)).json();
    return b.status === 'queued' ? null : b;
  }, 60_000);
};

let processOutput = () => '';
try {
  // ---- Файл: только размер и структура
  const top = headerBlock(RAW);
  const mime = [];
  describePart(RAW.toString('latin1'), 0, mime);
  info(`файл: ${RAW.length} байт`);
  info('структура MIME:');
  for (const m of mime) info(`  ${m}`);
  const has = (h) => (top.headers.has(h) ? 'есть' : 'нет');
  info(`заголовки: Subject ${has('subject')}, From ${has('from')}, To ${has('to')}, Cc ${has('cc')}, Date ${has('date')}, Message-ID ${has('message-id')}`);
  info(`encoded-word в Subject: ${encodedWords(top.headers.get('subject') ?? [])}; в From/To/Cc: ${encodedWords([...(top.headers.get('from') ?? []), ...(top.headers.get('to') ?? []), ...(top.headers.get('cc') ?? [])])}`);
  const parts = mime.filter((m) => !m.trim().startsWith('multipart/'));
  info(`частей: ${parts.length}; quoted-printable: ${parts.filter((m) => m.includes('quoted-printable')).length}; base64: ${parts.filter((m) => m.includes('base64')).length}; HTML: ${parts.filter((m) => m.includes('text/html')).length}`);

  // ---- Окружение: временная база, настоящие server + worker
  dropDb();
  if (runNode(['scripts/db-setup.ts']) !== 0 || runNode(['scripts/db-migrate.ts']) !== 0) throw new Error(`подготовка БД не удалась: ${lastOut}`);
  if (runNode(['scripts/bootstrap.ts', '--login', 'real.owner', '--name', 'Проверка EML', '--password-stdin'], PASSWORD) !== 0) throw new Error('bootstrap не удался');
  if (runNode(['scripts/seed-demo.ts', '--password-stdin'], PASSWORD) !== 0) throw new Error('демо-данные не созданы');
  const server = start('apps/server/src/main.ts');
  const worker = start('apps/worker/src/main.ts');
  processOutput = () => `${server()}${worker()}`;
  const ready = await waitFor(async () => (await fetch(`${BASE}/api/v1/ready`)).status === 200, 60_000);
  record('server + worker готовы (отдельная временная база)', Boolean(ready));
  const login = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { ...json, Origin: BASE }, body: JSON.stringify({ login: 'real.owner', password: PASSWORD }) });
  const jar = new Map();
  for (const c of login.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  csrf = decodeURIComponent(jar.get('kkp_csrf') ?? '');
  const me = await (await api('/me')).json();
  const tender = (await (await api('/tenders')).json()).items.find((t) => t.code === 'DEMO-001');
  const members = await api(`/tenders/${tender.id}/members`);
  await api(`/tenders/${tender.id}/members/${me.id}`, { method: 'PUT', headers: { ...json, 'If-Match': members.headers.get('etag') }, body: JSON.stringify({ memberRole: 'manager' }) });
  const stageId = (await (await api(`/tenders/${tender.id}/stages`)).json()).items[0].id;
  const box = await (await api('/mailboxes', { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ system: 'manual', externalAccountId: 'real-check@local', displayName: 'Проверка настоящего EML' }) })).json();
  const grant = async (capabilities) => {
    const card = await api(`/mailboxes/${box.id}`);
    return (await api(`/mailboxes/${box.id}/access/${me.id}`, { method: 'PUT', headers: { ...json, 'If-Match': card.headers.get('etag') }, body: JSON.stringify({ capabilities }) })).status;
  };
  record('ящик зарегистрирован, выданы чтение, импорт и связь', (await grant(['mail.read', 'mail.import', 'mail.link'])) === 200);

  // ---- 1. Импорт
  const first = await importEml(box.id);
  record('1. импорт завершён успешно', first?.status === 'done', first?.status === 'failed' ? `отказ ${first.failureCode}` : first ? `исход ${first.status}` : 'нет исхода за 60 с');
  if (first?.status !== 'done') throw new Error('импорт не завершён — дальнейшие проверки невозможны');
  const message = await (await api(`/mail-messages/${first.messageId}`)).json();
  const rev = message.current;

  // ---- 2. Шапка
  const roles = new Map();
  for (const p of rev.participants) roles.set(p.role, (roles.get(p.role) ?? 0) + 1);
  const subjectHealth = textHealth(rev.subject ?? '');
  record(
    '2. тема, отправитель, получатели и дата разобраны',
    Boolean(rev.subject) && Boolean(rev.from) && (roles.get('to') ?? 0) > 0 && Boolean(rev.sentAt) && healthy(subjectHealth),
    `тема ${rev.subject ? `есть (${rev.subject.length} симв.; ${healthNote(subjectHealth)})` : 'нет'}; отправитель ${rev.from ? 'есть' : 'нет'}; ` +
      `участники по ролям: ${[...roles].map(([r, n]) => `${r} ${n}`).join(', ') || 'нет'}; дата ${rev.sentAt ? 'есть' : 'нет'}`,
  );
  if (!top.headers.has('cc') && (roles.get('cc') ?? 0) > 0) record('2a. копия без заголовка Cc', false);

  // ---- 3. Тело
  const bodyText = rev.body.map((b) => b.text).join('\n');
  const bodyHealth = textHealth(bodyText);
  record(
    '3. тело без повреждения кириллицы',
    rev.body.length > 0 && bodyHealth.cyrillic > 0 && healthy(bodyHealth),
    `блоков ${rev.body.length} (цитат ${rev.body.filter((b) => b.quoted).length}), символов ${bodyText.length}; ${healthNote(bodyHealth)}; источник текста — ${rev.warnings.includes('body_from_html') ? 'HTML' : 'text/plain'}` +
      (bodyHealth.cyrillic === 0 && !bodyHealth.replacement ? '; в письме нет русского текста — для этой проверки нужно письмо с кириллицей' : ''),
  );
  info(`предупреждения разбора: ${rev.warnings.length ? rev.warnings.join(', ') : 'нет'}`);
  info(`вложений: ${rev.attachments.length} (принято ${rev.attachments.filter((a) => a.status === 'registered').length}, отклонено ${rev.attachments.filter((a) => a.status === 'rejected').length}${rev.attachments.some((a) => a.rejectReason) ? `: ${[...new Set(rev.attachments.map((a) => a.rejectReason).filter(Boolean))].join(', ')}` : ''})`);

  // ---- 4–5. Ревизия и исходник
  record('4. ревизия создана', message.revisions === 1 && rev.id === first.revisionId && first.createdRevision === true, `ревизий ${message.revisions}, идентичность ${message.identityKind}`);
  const owner = new pg.Client({ connectionString: url('kontur_migrator') });
  await owner.connect();
  const blob = (await owner.query('SELECT size_bytes, media_type, storage_key FROM blob WHERE sha256 = $1', [first.rawSha256])).rows[0];
  const sha = createHash('sha256').update(RAW).digest('hex');
  const stored = blob ? readFileSync(join(STORAGE, ...blob.storage_key.split('/'))) : null;
  record(
    '5. исходный EML сохранён в хранилище побайтно',
    Boolean(blob) && sha === first.rawSha256 && Number(blob.size_bytes) === RAW.length && Boolean(stored) && createHash('sha256').update(stored).digest('hex') === sha,
    blob ? `тип ${blob.media_type}, ${blob.size_bytes} байт, SHA-256 совпадает` : 'blob не найден',
  );

  // ---- 6. Повтор
  const again = await importEml(box.id);
  record('6. повтор того же EML идемпотентен', again?.status === 'done' && again.createdRevision === false && again.revisionId === first.revisionId && again.messageId === first.messageId);

  // ---- 7–8. Связь и контекст тендера
  const link = await api(`/mail-messages/${first.messageId}/tender-links`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ tenderId: tender.id, stageId }) });
  record('7. письмо связано с тестовым тендером', link.status === 201);
  const inTender = (await (await api(`/tenders/${tender.id}/mail-messages`)).json()).items.some((m) => m.id === first.messageId);
  record('8. письмо в текущем контексте тендера', inTender);

  // ---- 9. Поиск: запрос — самые длинные слова первого блока письма (в журнал не пишутся)
  const words = [...new Set((rev.body.find((b) => !b.quoted)?.text ?? bodyText).match(/[\p{L}]{5,}/gu) ?? [])].sort((a, b) => b.length - a.length).slice(0, 3);
  const working = { kind: 'tender', tenderId: tender.id, mode: 'working', stageId };
  let runId = null;
  let fragmentId = null;
  const hit = await waitFor(async () => {
    const r = await api('/search', { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ context: working, query: words.join(' '), limit: 10 }) });
    if (r.status !== 200) return null;
    const b = await r.json();
    const h = [...(b.fused?.items ?? []), ...(b.lexical?.items ?? [])].find((x) => x.mail?.messageId === first.messageId && x.sourceKind === 'mail_message_revision');
    if (h) {
      runId = b.searchRunId;
      fragmentId = h.fragmentId;
    }
    return h ?? null;
  }, 90_000);
  record('9. поиск этапа находит фрагмент письма', Boolean(hit) && words.length > 0, hit ? `ветки: ${hit.matchedVia.join(', ')}; слов в запросе ${words.length}` : `слов в запросе ${words.length}`);
  const citation = fragmentId ? (await api(`/evidence/${fragmentId}`)).status : 0;
  record('9a. цитата фрагмента письма открывается при mail.read', citation === 200);

  // ---- 10. Отзыв mail.read
  record('10a. mail.read отозван (импорт и связь оставлены)', (await grant(['mail.import', 'mail.link'])) === 200);
  const msg404 = (await api(`/mail-messages/${first.messageId}`)).status;
  const run409 = runId ? (await api(`/search-runs/${runId}`)).status : 0;
  const cite404 = fragmentId ? (await api(`/evidence/${fragmentId}`)).status : 0;
  const after = await (await api('/search', { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ context: working, query: words.join(' '), limit: 10 }) })).json();
  const leaked = [...(after.fused?.items ?? []), ...(after.lexical?.items ?? [])].some((x) => x.mail?.messageId === first.messageId);
  const tenderList = (await (await api(`/tenders/${tender.id}/mail-messages`)).json()).items.some((m) => m.id === first.messageId);
  record(
    '10. после отзыва mail.read письмо, поиск и цитата закрыты',
    msg404 === 404 && run409 === 409 && cite404 === 404 && !leaked && !tenderList && (after.scope?.excludedByAcl ?? 0) > 0,
    `письмо ${msg404}, прежний прогон ${run409}, цитата ${cite404}, новый поиск без письма, исключено единиц ${after.scope?.excludedByAcl ?? 0}`,
  );

  // ---- 11. Журнал аудита и журналы процессов без содержимого письма
  const audit = JSON.stringify((await owner.query('SELECT action, entity_type, details FROM audit_event')).rows);
  const addresses = rev.participants.map((p) => p.address);
  const probes = [rev.subject, ...addresses, ...rev.body.slice(0, 3).map((b) => b.text.slice(0, 40)), ...words].filter((x) => x && x.length >= 4);
  const leakedAudit = probes.filter((p) => audit.includes(p)).length;
  const leakedLogs = probes.filter((p) => processOutput().includes(p)).length;
  record('11. журнал аудита и журналы процессов без темы, адресов и текста письма', leakedAudit === 0 && leakedLogs === 0 && !processOutput().includes(PASSWORD), `проверено образцов ${probes.length}; найдено в аудите ${leakedAudit}, в журналах процессов ${leakedLogs}`);
  await owner.end();
} catch (err) {
  record('исключение сценария', false, err instanceof Error ? err.message : String(err));
} finally {
  for (const c of children) if (c.exitCode === null) c.kill();
  await sleep(500);
  dropDb();
}

// REAL_EML_LOG — другой путь журнала (самопроверка скрипта на синтетике не перезаписывает журнал приёмки).
const logPath = process.env.REAL_EML_LOG ?? join(ROOT, 'artifacts', 'stage-07', 'real-eml-check.log');
mkdirSync(resolve(logPath, '..'), { recursive: true });
const summary = `Итог: ${failed ? 'FAIL' : 'PASS'}`;
writeFileSync(
  logPath,
  `# real-eml-check — ${new Date().toISOString()}, Node ${process.version}, PostgreSQL ${ADMIN.replace(/\/\/[^@]*@/u, '//***@')}, настоящие server + worker, временная база ${DB}\n` +
    `# в журнале нет темы, адресов, тела, имён файлов и вложений письма (Review 07-1)\n${lines.join('\n')}\n${summary}\n`,
);
console.log(summary);
process.exit(failed ? 1 : 0);
