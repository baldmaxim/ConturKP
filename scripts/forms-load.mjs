// Загрузка шаблона приложения и формулировок в портал через API (этап 11; D-031 В-11-1, В-11-2). Реальные формы
// компании и построенные по ним схемы хранятся вне Git; этот загрузчик данных не содержит. Ревизия схемы
// загружается черновиком: утверждает руководитель после проверки (Q-08). Формулировки — «предложены».
// Пароль — только из stdin (I17), в журнал не пишется.
//
//   node scripts/forms-load.mjs --base http://127.0.0.1:8080 --login demo.manager --name "Ключевые условия ГП" \
//        --schema pilot-forms/schemas/key-conditions-gp.forms.json [--wordings pilot-forms/schemas/key-conditions-gp.wordings.json] \
//        [--demo] [--tender <id тендера для шаблона заказчика>] < пароль
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);
const base = arg('base');
const login = arg('login');
const name = arg('name');
const schemaPath = arg('schema');
const wordingsPath = arg('wordings');
const tenderId = arg('tender') ?? null;
if (!base || !login || !name || !schemaPath) {
  console.error('использование: node scripts/forms-load.mjs --base <адрес портала> --login <логин> --name <название> --schema <файл forms/1> [--wordings <файл>] [--demo] [--tender <id>] < пароль');
  process.exitCode = 2;
} else {
  const password = readFileSync(0, 'utf8').trim();
  const cookies = new Map();
  const absorb = (r) => {
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'X-CSRF-Token': decodeURIComponent(cookies.get('kkp_csrf') ?? ''),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    absorb(r);
    const text = await r.text();
    return { status: r.status, etag: r.headers.get('etag'), body: text ? JSON.parse(text) : null };
  };
  const fail = (step, r) => {
    console.error(`${step}: HTTP ${r.status} ${JSON.stringify(r.body?.errors ?? r.body?.detail ?? '').slice(0, 500)}`);
    process.exitCode = 1;
  };
  const run = async () => {
    const auth = await call('POST', '/auth/login', { login, password });
    if (auth.status !== 200) return fail('вход', auth);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const t = await call('POST', '/application-templates', { ownerKind: tenderId ? 'customer' : 'company', tenderId, name, isDemo: flag('demo') }, { 'Idempotency-Key': randomUUID() });
    if (t.status !== 201) return fail('шаблон', t);
    const rev = await call('POST', `/application-templates/${t.body.id}/revisions`, { schema }, { 'Idempotency-Key': randomUUID() });
    if (rev.status !== 201) return fail('ревизия схемы', rev);
    console.log(`шаблон ${t.body.id}: ревизия № ${rev.body.seq} — черновик, полей ${rev.body.fieldCount}, SHA схемы ${rev.body.schemaSha256}; утвердить — после проверки`);
    if (wordingsPath) {
      let n = 0;
      for (const w of JSON.parse(readFileSync(wordingsPath, 'utf8'))) {
        const r = await call('POST', '/approved-wordings', { scopeTenderId: tenderId, title: w.title, text: w.text, tags: w.tags ?? [] }, { 'Idempotency-Key': randomUUID() });
        if (r.status !== 201) return fail(`формулировка «${w.title}»`, r);
        n += 1;
      }
      console.log(`формулировок предложено: ${n}; утверждает руководитель`);
    }
  };
  await run();
}
