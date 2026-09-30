// Этап 07: почтовый контур через API (D-025). Ящик регистрирует администратор, выдачи — строки по
// ящику; EML импортируется в конкретный ящик и разбирается worker; письмо — копия в одном ящике с
// неизменяемыми ревизиями; вложение — документ без тендера; связь с тендером подтверждает человек.
// Вопросы–ответы и переговоры — импорт manifest с ревизиями.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import {
  createMailbox,
  eml,
  importEml,
  linkMail,
  negotiationManifest,
  octet,
  postEml,
  postManifest,
  qaManifest,
  setMailAccess,
  unlinkMail,
} from './mailFixtures.ts';

let db: ITestDb;
let s: IScenario;
let worker: ReturnType<typeof makeWorker>;
let box: string;
const config = testConfig();

const CSV = Buffer.from('Позиция;Количество\nБетон B25;120\nАрматура A500;14\n', 'utf8');

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  worker = makeWorker(db, config);
  box = await createMailbox(s.admin, 'tender@contractor.example.test', 'Тендерный ящик');
  await setMailAccess(s.admin, box, s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
  await setMailAccess(s.admin, box, s.ids.manager, ['mail.read']);
});
afterAll(async () => {
  await db.drop();
});

describe('ящики и выдачи', () => {
  it('администратор регистрирует ящик и видит его служебно; повтор внешнего ID — 409', async () => {
    const list = await s.admin.get('/mailboxes');
    expect(list.status).toBe(200);
    expect(list.body.isMailboxAdmin).toBe(true);
    expect(list.body.items.find((m: { id: string }) => m.id === box)).toMatchObject({ displayName: 'Тендерный ящик', capabilities: [] });
    const again = await s.admin.post('/mailboxes', { system: 'manual', externalAccountId: 'tender@contractor.example.test', displayName: 'x' }, { headers: idem() });
    expect(again.status).toBe(409);
    expect(again.body.current).toMatchObject({ reason: 'mailbox_exists', mailboxId: box });
  });

  it('автоматические каналы MailHub и переговоров — BLOCKED_EXTERNAL с причиной', async () => {
    const list = await s.eng1.get('/mailboxes');
    expect(list.body.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: 'mailhub', status: 'BLOCKED_EXTERNAL', blockedBy: 'X-03' }),
        expect.objectContaining({ system: 'negotiations', status: 'BLOCKED_EXTERNAL', blockedBy: 'Q-06' }),
      ]),
    );
  });

  it('пользователь видит только ящики со своей выдачей; без выдачи — 404; не администратор не регистрирует ящики', async () => {
    expect((await s.eng1.get('/mailboxes')).body.items.map((m: { id: string }) => m.id)).toEqual([box]);
    expect((await s.eng2.get('/mailboxes')).body.items).toEqual([]);
    expect((await s.eng2.get(`/mailboxes/${box}`)).status).toBe(404);
    expect((await s.eng1.post('/mailboxes', { system: 'manual', externalAccountId: 'x@y', displayName: 'x' }, { headers: idem() })).status).toBe(403);
  });

  it('выдача пользователю без содержательной роли — 409; изменение выдач требует If-Match ящика', async () => {
    const r = await s.admin.put(`/mailboxes/${box}/access/${s.ids.admin}`, { capabilities: ['mail.read'] }, { headers: { 'If-Match': (await s.admin.get(`/mailboxes/${box}`)).headers.etag as string } });
    expect(r.status).toBe(409);
    const stale = await s.admin.put(`/mailboxes/${box}/access/${s.ids.eng2}`, { capabilities: ['mail.read'] }, { headers: { 'If-Match': `"${box}:1"` } });
    expect(stale.status).toBe(412);
  });
});

describe('импорт EML', () => {
  let messageId: string;
  let firstRevision: string;
  const raw = eml({
    messageId: 'q-100@customer.example.test',
    subject: 'A-1: разъяснение по бетону',
    text: 'Добрый день!\nМарка бетона фундаментов — B25, объём 120 м3.\n\n> Ранее вы писали:\n> бетон B20 допустим?\n',
    attachments: [{ name: 'объёмы.csv', type: 'text/csv', bytes: CSV }],
  });

  it('письмо разбирается worker: шапка, блоки тела с цитатой, вложение-документ без тендера', async () => {
    const r = await importEml(s.eng1, worker, box, raw);
    expect(r).toMatchObject({ status: 'done', createdRevision: true });
    messageId = r.messageId!;
    firstRevision = r.revisionId!;
    const m = await s.eng1.get(`/mail-messages/${messageId}`);
    expect(m.status, m.text).toBe(200);
    expect(m.body).toMatchObject({ mailboxId: box, subject: 'A-1: разъяснение по бетону', revisions: 1, identityKind: 'message_id' });
    expect(m.body.current.body.some((b: { quoted: boolean; text: string }) => !b.quoted && b.text.includes('B25'))).toBe(true);
    expect(m.body.current.body.some((b: { quoted: boolean; text: string }) => b.quoted && b.text.includes('B20'))).toBe(true);
    const att = m.body.current.attachments;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ filename: 'объёмы.csv', status: 'registered', sizeBytes: CSV.length });
    const doc = await db.pool.query('SELECT tender_id, contract_id, mail_attachment_id FROM document WHERE id = $1', [att[0].documentId]);
    expect(doc.rows[0]).toMatchObject({ tender_id: null, contract_id: null, mail_attachment_id: att[0].id });
    const content = await s.eng1.get(att[0].contentUrl.replace('/api', ''));
    expect(content.status).toBe(200);
    expect(content.headers['x-content-sha256']).toBe(att[0].sha256);
  });

  it('побайтный повтор идемпотентен: та же ревизия, новой нет', async () => {
    const again = await importEml(s.eng1, worker, box, raw);
    expect(again).toMatchObject({ status: 'done', messageId, revisionId: firstRevision, createdRevision: false });
    const n = await db.pool.query('SELECT count(*)::int AS n FROM mail_message_revision WHERE message_id = $1', [messageId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('тот же Message-ID с другим содержимым — новая ревизия за прежней, прежняя остаётся', async () => {
    const changed = eml({ messageId: 'q-100@customer.example.test', subject: 'A-1: разъяснение по бетону', text: 'Исправление: марка бетона — B30.' });
    const r = await importEml(s.eng1, worker, box, changed);
    expect(r).toMatchObject({ status: 'done', messageId, createdRevision: true });
    expect(r.revisionId).not.toBe(firstRevision);
    const m = await s.eng1.get(`/mail-messages/${messageId}`);
    expect(m.body.revisionList.map((x: { seq: number }) => x.seq)).toEqual([2, 1]);
    expect(m.body.current.body.map((b: { text: string }) => b.text).join('\n')).toContain('B30');
    const old = await s.eng1.get(`/mail-message-revisions/${firstRevision}`);
    expect(old.status).toBe(200);
    expect(old.body.body.map((b: { text: string }) => b.text).join('\n')).toContain('B25');
  });

  it('письмо без Message-ID — идентичность по SHA-256 исходника; HTML переводится в текст без разметки', async () => {
    const r = await importEml(s.eng1, worker, box, eml({ messageId: null, subject: 'HTML', html: '<p>Срок <b>поставки</b> — 30 дней</p><script>alert(1)</script>' }));
    const m = await s.eng1.get(`/mail-messages/${r.messageId}`);
    expect(m.body.identityKind).toBe('raw_sha256');
    const text = m.body.current.body.map((b: { text: string }) => b.text).join('\n');
    expect(text).toContain('Срок поставки — 30 дней');
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('alert');
  });

  it('повреждённый EML — детерминированный отказ без повторов; не .eml — 400 до записи', async () => {
    const bad = await postEml(s.eng1, box, Buffer.from('\x00\x01\x02 not a message', 'latin1'));
    expect(bad.status).toBe(400);
    const r = await importEml(s.eng1, worker, box, Buffer.from('X-Only: header\r\n\r\n', 'utf8'));
    expect(r.status).toBe('failed');
    expect(r.failureCode).toMatch(/^mail_/u);
    const job = await db.pool.query("SELECT status, attempts FROM job WHERE kind = 'mail.import' AND payload->>'importId' = $1", [r.id]);
    expect(job.rows[0]).toMatchObject({ status: 'failed', attempts: 1 });
    const other = await s.eng1.post(`/mailboxes/${box}/imports?name=${encodeURIComponent('письмо.txt')}`, eml({ subject: 'x', text: 'y' }), { headers: { ...octet, ...idem() } });
    expect(other.status).toBe(400);
  });

  it('.eml в общем импорте источников этапа — отказ элемента с пояснением (AD-07-3)', async () => {
    const r = await s.eng1.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent('письмо.eml')}`, eml({ subject: 'x', text: 'y' }), { headers: { ...octet, ...idem() } });
    expect(r.status, r.text).toBe(202);
    await drain(worker);
    const batch = await s.eng1.get(`/imports/${r.body.id}`);
    expect(batch.body.items[0]).toMatchObject({ status: 'rejected', rejectReason: 'type_not_allowed' });
    expect(batch.body.items[0].rejectDetail).toContain('почтовый ящик');
  });

  it('импорт требует mail.import; без выдачи ящик не раскрывается', async () => {
    await setMailAccess(s.admin, box, s.ids.eng2, ['mail.read']);
    expect((await postEml(s.eng2, box, eml({ subject: 'x', text: 'y' }))).status).toBe(403);
    expect((await postEml(s.eng3, box, eml({ subject: 'x', text: 'y' }))).status).toBe(404);
    await setMailAccess(s.admin, box, s.ids.eng2, []);
  });

  it('журнал импорта не содержит темы, имени файла и адресов', async () => {
    const rows = await auditRows(db.pool, "action = 'mail.import'");
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('разъяснение');
    expect(text).not.toContain('customer@example.test');
    expect(text).not.toContain('letter.eml');
  });
});

describe('связь письма с тендером (OD-07-7)', () => {
  let messageId: string;

  beforeAll(async () => {
    const r = await importEml(s.eng1, worker, box, eml({ messageId: 'link-1@example.test', subject: 'Тендер A-1: график поставки', text: 'График поставки бетона согласован.' }));
    messageId = r.messageId!;
  });

  it('кандидат — по точному коду тендера в теме; сам по себе связью не становится', async () => {
    const m = await s.eng1.get(`/mail-messages/${messageId}`);
    expect(m.body.candidates).toEqual([expect.objectContaining({ tenderId: s.tenderA, reasons: ['tender_code_in_subject'] })]);
    expect(m.body.tenderLinks).toEqual([]);
    expect(m.body.links).toBe(0);
  });

  it('связь подтверждает пользователь с mail.link и source.write; повтор — 409; письмо видно в переписке тендера', async () => {
    const l = await linkMail(s.eng1, messageId, s.tenderA, s.stageA);
    expect(l).toMatchObject({ tenderId: s.tenderA, stageId: s.stageA, status: 'linked' });
    expect((await s.eng1.post(`/mail-messages/${messageId}/tender-links`, { tenderId: s.tenderA, stageId: s.stageA }, { headers: idem() })).status).toBe(409);
    const list = await s.eng1.get(`/tenders/${s.tenderA}/mail-messages`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(messageId);
    const events = await db.pool.query("SELECT event_type FROM stage_input_event WHERE stage_id = $1 AND event_type = 'communication_linked'", [s.stageA]);
    expect(events.rowCount).toBeGreaterThan(0);
  });

  it('без mail.link — 403; без source.write по тендеру (тендер чужой) — 404', async () => {
    expect((await s.manager.post(`/mail-messages/${messageId}/tender-links`, { tenderId: s.tenderB }, { headers: idem() })).status).toBe(403);
    expect((await s.eng1.post(`/mail-messages/${messageId}/tender-links`, { tenderId: s.tenderB }, { headers: idem() })).status).toBe(404);
  });

  it('снятие связи сохраняет письмо и ревизии; повторная связь — тот же ряд', async () => {
    const before = await linkMail(s.eng1, messageId, s.tenderA);
    const off = await unlinkMail(s.eng1, messageId, s.tenderA);
    expect(off).toMatchObject({ id: before.id, status: 'unlinked' });
    expect((await s.eng1.get(`/mail-messages/${messageId}`)).status).toBe(200);
    expect((await s.eng1.get(`/tenders/${s.tenderA}/mail-messages`)).body.items.map((x: { id: string }) => x.id)).not.toContain(messageId);
    const again = await linkMail(s.eng1, messageId, s.tenderA);
    expect(again.id).toBe(before.id);
  });
});

describe('вопросы–ответы (OD-07-6)', () => {
  it('импорт manifest: тред и вопросы с устойчивыми номерами; повтор файла идемпотентен', async () => {
    const m = qaManifest([
      { no: '1', question: 'Допускается ли замена бетона B25 на B30?', answer: 'Допускается по согласованию.' },
      { no: '2', question: 'Срок поставки арматуры?' },
    ]);
    const r = await postManifest(s.eng1, s.tenderA, 'qa', m, { stageId: s.stageA });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ reused: false, threads: 1, newRevisions: 2 });
    const again = await postManifest(s.eng1, s.tenderA, 'qa', m);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, importId: r.body.importId, newRevisions: 0 });
    const threads = await s.eng2.get(`/tenders/${s.tenderA}/qa-threads`);
    expect(threads.body.items).toEqual([expect.objectContaining({ externalRef: 'Q-1', items: 2, openItems: 1 })]);
  });

  it('A → B → A: неизменённый вопрос ревизии не получает, возврат к прежнему ответу — новая ревизия', async () => {
    const q = 'Допускается ли замена бетона B25 на B30?';
    const b = await postManifest(s.eng1, s.tenderA, 'qa', qaManifest([{ no: '1', question: q, answer: 'Не допускается.' }, { no: '2', question: 'Срок поставки арматуры?' }]));
    expect(b.body.newRevisions).toBe(1);
    const a = await postManifest(s.eng1, s.tenderA, 'qa', qaManifest([{ no: '1', question: q, answer: 'Допускается по согласованию.' }, { no: '2', question: 'Срок поставки арматуры?' }, { no: '3', question: 'Новый вопрос?' }]));
    expect(a.status).toBe(201);
    expect(a.body.newRevisions).toBe(2);
    const threadId = (await s.eng1.get(`/tenders/${s.tenderA}/qa-threads`)).body.items[0].id;
    const t = await s.eng1.get(`/qa-threads/${threadId}`);
    const item1 = t.body.questions.find((i: { itemNo: string }) => i.itemNo === '1');
    expect(item1.history.map((h: { seq: number; answer: string }) => [h.seq, h.answer])).toEqual([
      [3, 'Допускается по согласованию.'],
      [2, 'Не допускается.'],
      [1, 'Допускается по согласованию.'],
    ]);
  });

  it('неизвестный формат и противоречивый вопрос — 400 без записи; чужой тендер — 404; без source.write — 403', async () => {
    expect((await postManifest(s.eng1, s.tenderA, 'qa', { format: 'kontur.qa.v9', threads: [] })).status).toBe(400);
    expect((await postManifest(s.eng1, s.tenderA, 'qa', qaManifest([{ no: '1', question: 'x', answer: null, status: 'answered' }]))).status).toBe(400);
    expect((await postManifest(s.eng3, s.tenderA, 'qa', qaManifest([{ no: '1', question: 'x' }]))).status).toBe(404);
    const imports = await db.pool.query('SELECT count(*)::int AS n FROM qa_import WHERE tender_id = $1', [s.tenderA]);
    expect(imports.rows[0].n).toBe(3);
  });
});

describe('переговоры (Q-06, файловый импорт)', () => {
  it('сессия: речь и подсказка — разные виды; фрагменты подсказки не индексируются как доказательство', async () => {
    const r = await postManifest(
      s.eng1,
      s.tenderA,
      'negotiation',
      negotiationManifest('r1', [
        { no: 1, speaker: 'S1', text: 'Мы рассмотрим снижение цены на пять процентов.' },
        { no: 2, speaker: 'S2', kind: 'hint', text: 'Подсказка: уточнить срок оплаты.' },
      ]),
    );
    expect(r.status, r.text).toBe(201);
    expect(r.body.createdRevision).toBe(true);
    const sess = await s.eng2.get(`/negotiation-sessions/${r.body.sessionId}`);
    expect(sess.status).toBe(200);
    expect(sess.body.segments.map((x: { kind: string }) => x.kind)).toEqual(['speech', 'hint']);
    expect(sess.body.participants).toHaveLength(2);
    const origins = await db.pool.query('SELECT origin FROM evidence_fragment WHERE transcript_revision_id = $1 ORDER BY ordinal', [r.body.revisionId]);
    expect(origins.rows.map((x) => x.origin)).toEqual(['negotiation_speech', 'negotiation_hint']);
  });

  it('исправление транскрипции — новая редакция; повтор того же содержания новой редакции не даёт', async () => {
    const fixed = negotiationManifest('r2', [
      { no: 1, speaker: 'S1', text: 'Мы рассмотрим снижение цены на три процента.' },
      { no: 2, speaker: 'S2', kind: 'hint', text: 'Подсказка: уточнить срок оплаты.' },
    ]);
    const r = await postManifest(s.eng1, s.tenderA, 'negotiation', fixed);
    expect(r.body).toMatchObject({ createdRevision: true });
    const same = await postManifest(s.eng1, s.tenderA, 'negotiation', { ...fixed, transcript: { ...fixed.transcript, revision: 'r2-copy' } });
    expect(same.status).toBe(201);
    expect(same.body).toMatchObject({ createdRevision: false, revisionId: r.body.revisionId });
    const sess = await s.eng1.get(`/negotiation-sessions/${r.body.sessionId}`);
    expect(sess.body.revisionList.map((x: { seq: number }) => x.seq)).toEqual([2, 1]);
    expect(sess.body.segments[0].text).toContain('три процента');
  });

  it('возврат к прежнему тексту транскрипции тем же файлом (A → B → A) — третья редакция', async () => {
    const a = negotiationManifest('a', [{ no: 1, speaker: 'S1', text: 'Вариант А.' }], 'N-ABA');
    const b = negotiationManifest('b', [{ no: 1, speaker: 'S1', text: 'Вариант Б.' }], 'N-ABA');
    const r1 = await postManifest(s.eng1, s.tenderA, 'negotiation', a);
    await postManifest(s.eng1, s.tenderA, 'negotiation', b);
    const r3 = await postManifest(s.eng1, s.tenderA, 'negotiation', a);
    expect(r3.status).toBe(201);
    expect(r3.body).toMatchObject({ reused: false, createdRevision: true });
    const sess = await s.eng1.get(`/negotiation-sessions/${r1.body.sessionId}`);
    expect(sess.body.revisionList.map((x: { seq: number }) => x.seq)).toEqual([3, 2, 1]);
  });

  it('участник другого тендера сессию не видит', async () => {
    const id = (await s.eng1.get(`/tenders/${s.tenderA}/negotiation-sessions`)).body.items[0].id;
    expect((await s.eng3.get(`/negotiation-sessions/${id}`)).status).toBe(404);
  });
});
