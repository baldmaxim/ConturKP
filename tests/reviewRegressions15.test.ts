// Регрессии Review 15-1 (docs/reviews/15-review-1.md): R15-01 — повтор команды по ключу идемпотентности не возвращает
// сохранённый закрытый текст; R15-02 — сторона сравнения показывает состояние вопроса на момент закрепления; R15-03 — у
// письма вне снимка есть закреплённая ревизия, позднейшая редакция вывод не меняет. Первые восемь проверок — независимые
// сценарии ревьюера с его ожиданиями (без записи наблюдений в файл); остальные — проверки исправления.
// Данные поддельные: боевой выпуск — на данных фикстуры (Q-01/X-01, Q-05, Q-08 в силе), письма — синтетические EML.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { formatEtag } from '@kontur/core';
import { closeStage13, notApplicable, rerunReview } from './approvalFixtures.ts';
import { idem } from './helpers.ts';
import { eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { buildStage15, kitAttachments, released, sentLetter, settle, type IReleased, type ISentLetter, type IStage15 } from './sendFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 900_000 });

let st: IStage15;
let left: IReleased;
let right: IReleased;
let cmpId: string;
let oldQ: string;
let newQ: string;
let letterId: string;
let letterRevision: string;
const afterText = 'Подтвердите аванс 10 процентов';
const frozenNewText = 'Подтвердите гарантию пять лет';
const letterSubject = 'Исходная тема письма вне снимка';
const laterSubject = 'Позднейшая тема, которой ещё не было в выпуске';

const questions = async () => {
  const r = await st.e.s.eng1.get(`/release-comparisons/${cmpId}/items?section=questions&limit=200`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as any[];
};
const received = async () => {
  const r = await st.e.s.eng1.get(`/release-comparisons/${cmpId}/items?section=received&limit=200`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as any[];
};
const createQuestion = async (text: string) => {
  const q = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/customer-questions`, { text }, { headers: idem() });
  expect(q.status, q.text).toBe(201);
  const sent = await st.e.s.eng1.patch(`/customer-questions/${q.body.id}`, { status: 'sent' }, { headers: { 'If-Match': q.headers.etag as string } });
  expect(sent.status, sent.text).toBe(200);
  return q.body.id as string;
};
const updateQuestion = async (id: string, body: Record<string, unknown>) => {
  const q = await st.e.s.eng1.get(`/stages/${st.e.s.stageA}/customer-questions`);
  expect(q.status, q.text).toBe(200);
  const current = q.body.items.find((item: any) => item.id === id);
  expect(current).toBeDefined();
  return st.e.s.eng1.patch(`/customer-questions/${id}`, body, { headers: { 'If-Match': formatEtag(id, current.rowVersion) } });
};

beforeAll(async () => {
  st = await buildStage15();
  oldQ = await createQuestion('Подтвердите аванс 20 процентов');
  await rerunReview(st);
  left = await released(st);
  newQ = await createQuestion(frozenNewText);
  const imported = await importEml(st.e.s.eng1, st.e.worker, st.mailbox,
    eml({ messageId: 'review15-outside@example.test', subject: letterSubject, text: 'Письмо получено между выпусками и не включено в их снимки.', date: new Date().toUTCString() }), { direction: 'inbound' });
  expect(imported.status).toBe('done');
  letterId = imported.messageId!;
  letterRevision = imported.revisionId!;
  await linkMail(st.e.s.eng1, letterId, st.e.s.tenderA, st.e.s.stageA);
  // Письмо остаётся вне закреплённого снимка источников.
  await rerunReview(st);
  right = await released(st);
  const comparison = await st.e.s.eng1.post(`/tenders/${st.e.s.tenderA}/release-comparisons`, { leftReleaseId: left.releaseId, rightReleaseId: right.releaseId }, { headers: idem() });
  expect(comparison.status, comparison.text).toBe(201);
  cmpId = comparison.body.id;
});
// Незавершённая фоновая работа отказавшего теста не переходит в следующий (R15-04).
afterEach(async () => settle(st));
afterAll(async () => { if (st) await closeStage13(st); });

// ---------------------------------------------------------------- Сценарии ревьюера

it('sent question text cannot be changed through the API (control)', async () => {
  const edit = await updateQuestion(oldQ, { text: afterText });
  expect(edit.status).toBe(409);
});

it('an already computed comparison retains the historical question status after it is answered', async () => {
  const before = (await questions()).find((i) => i.right?.ref === newQ)!;
  expect(before.right.label).toBe(frozenNewText);
  const c1 = await st.e.s.eng1.get(`/release-comparisons/${cmpId}`);
  const answered = await updateQuestion(newQ, { status: 'answered', answerNote: 'Заказчик подтвердил гарантию после правого выпуска' });
  expect(answered.status, answered.text).toBe(200);
  const after = (await questions()).find((i) => i.right?.ref === newQ)!;
  const c2 = await st.e.s.eng1.get(`/release-comparisons/${cmpId}`);
  expect(before.right.note).toBe('sent');
  expect(after.right.note, 'released historical status must not follow the current question row').toBe('sent');
  // Статус закреплён в самом выводе и покрыт хэшем результата.
  expect(after.detail).toMatchObject({ rightStatus: 'sent' });
  expect(after).toEqual(before);
  expect(c2.body.resultSha256).toBe(c1.body.resultSha256);
});

it('a received out-of-scope letter has evidence for its immutable revision', async () => {
  const item = (await received()).find((i) => i.subjectType === 'mail_message' && i.detail.subjectId === letterId)!;
  expect(item).toBeDefined();
  expect(item.change).toBe('out_of_scope');
  expect(item.right.label).toBe(letterSubject);
  expect(item.evidence).toContainEqual({ type: 'mail_message_revision', id: letterRevision });
  const raw = await st.e.db.pool.query<{ sha: string }>('SELECT raw_blob_sha256 AS sha FROM mail_message_revision WHERE id = $1', [letterRevision]);
  expect(item.right).toMatchObject({ ref: letterRevision, sha256: raw.rows[0]!.sha });
});

it('out-of-scope mail remains closed after mail.read is revoked (control)', async () => {
  await setMailAccess(st.e.s.admin, st.mailbox, st.e.s.ids.eng1, ['mail.import', 'mail.link']);
  const list = await received();
  const item = list.find((i) => i.subjectType === 'mail_message')!;
  expect(item).toMatchObject({ closed: true, left: null, right: null, detail: {}, evidence: [] });
  expect(JSON.stringify(item)).not.toContain(letterSubject);
  await setMailAccess(st.e.s.admin, st.mailbox, st.e.s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
});

it('out-of-scope mail in an existing comparison cannot follow a later imported revision', async () => {
  const before = (await received()).find((i) => i.subjectType === 'mail_message')!;
  const c1 = await st.e.s.eng1.get(`/release-comparisons/${cmpId}`);
  const revised = await importEml(st.e.s.eng1, st.e.worker, st.mailbox,
    eml({ messageId: 'review15-outside@example.test', subject: laterSubject, text: 'Другая редакция письма после правого выпуска.', date: new Date().toUTCString() }), { direction: 'inbound' });
  expect(revised.status).toBe('done');
  expect(revised.messageId).toBe(letterId);
  expect(revised.revisionId).not.toBe(letterRevision);
  const after = (await received()).find((i) => i.subjectType === 'mail_message')!;
  expect(after.right.label).toBe(letterSubject);
  expect(after).toEqual(before);
  expect(JSON.stringify(await received())).not.toContain(laterSubject);
  // Сравнение той же пары, построенное после новой редакции, даёт тот же результат: вход — ревизия на момент закрепления.
  const again = await st.e.s.eng1.post(`/tenders/${st.e.s.tenderA}/release-comparisons`, { leftReleaseId: left.releaseId, rightReleaseId: right.releaseId }, { headers: idem() });
  expect(again.status, again.text).toBe(201);
  expect(again.body.resultSha256).toBe(c1.body.resultSha256);
  const fresh = await st.e.s.eng1.get(`/release-comparisons/${again.body.id}/items?section=received&limit=200`);
  expect(fresh.body.items.find((i: any) => i.subjectType === 'mail_message').right).toMatchObject({ ref: letterRevision, label: letterSubject });
});

interface IPrivacy {
  mail: ISentLetter;
  reg: any;
  accepted: any;
  incident: any;
  registerBody: Record<string, unknown>;
  registerKey: Record<string, string>;
  extraKey: Record<string, string>;
  extraBody: Record<string, unknown>;
  incidentBody: Record<string, unknown>;
  incidentKey: Record<string, string>;
}
let privacyFixture: IPrivacy | undefined;
const preparePrivacy = async (): Promise<IPrivacy> => {
  if (privacyFixture) return privacyFixture;
  const mail = await sentLetter(st, { subject: 'Секретная тема повторного ответа', attachments: [
    ...kitAttachments(st, right.candidate), { name: 'Секретное дополнительное вложение.txt', type: 'text/plain', bytes: Buffer.from('extra private proof') },
  ] });
  await notApplicable(st, right.candidate.id, 'Письмо фиксирует передачу нашего комплекта');
  const registerBody = { evidence: { kind: 'mail_message', mailMessageRevisionId: mail.revisionId } };
  const registerKey = idem();
  const reg = await st.e.s.eng1.post(`/releases/${right.releaseId}/send-events`, registerBody, { headers: registerKey });
  expect(reg.status, reg.text).toBe(201);
  expect(reg.body.status).toBe('disputed');
  const extraKey = { ...idem(), 'If-Match': reg.body.etag as string };
  const extraBody = { reason: 'Закрытая причина принятия секретного вложения' };
  const accepted = await st.e.s.manager.post(`/send-events/${reg.body.id}/accept-extras`, extraBody, { headers: extraKey });
  expect(accepted.status, accepted.text).toBe(200);
  const incidentBody = { kind: 'other', occurredAt: new Date().toISOString(), description: 'Секретное описание нарушения по закрытому письму', mailMessageRevisionId: mail.revisionId };
  const incidentKey = idem();
  const incident = await st.e.s.eng1.post(`/releases/${right.releaseId}/compliance-incidents`, incidentBody, { headers: incidentKey });
  expect(incident.status, incident.text).toBe(201);
  privacyFixture = { mail, reg: reg.body, accepted: accepted.body, incident: incident.body, registerBody, registerKey, extraKey, extraBody, incidentBody, incidentKey };
  return privacyFixture;
};
const redact = async (actor: 'eng1' | 'manager', on: boolean) => {
  await setMailAccess(st.e.s.admin, st.mailbox, st.e.s.ids[actor], on ? (actor === 'eng1' ? ['mail.read', 'mail.import', 'mail.link'] : ['mail.read']) : (actor === 'eng1' ? ['mail.import', 'mail.link'] : []));
};

it('idempotent send registration rechecks mailbox visibility after access is revoked', async () => {
  const f = await preparePrivacy();
  await redact('eng1', false);
  try {
    const current = await st.e.s.eng1.get(`/releases/${right.releaseId}/send-events`);
    expect(current.body.items.find((i: any) => i.id === f.reg.id).evidence.mail.restricted).toBe(true);
    const replay = await st.e.s.eng1.post(`/releases/${right.releaseId}/send-events`, f.registerBody, { headers: f.registerKey });
    expect(JSON.stringify(replay.body)).not.toContain('Секретная тема');
    expect(JSON.stringify(replay.body)).not.toContain('Секретное дополнительное вложение');
  } finally { await redact('eng1', true); }
});

it('idempotent extras acceptance rechecks the closed basis instead of replaying private rationale', async () => {
  const f = await preparePrivacy();
  await redact('manager', false);
  try {
    const current = await st.e.s.manager.get(`/releases/${right.releaseId}/send-events`);
    expect(current.body.items.find((i: any) => i.id === f.reg.id).decisions[0].restricted).toBe(true);
    const replay = await st.e.s.manager.post(`/send-events/${f.reg.id}/accept-extras`, f.extraBody, { headers: f.extraKey });
    expect(JSON.stringify(replay.body)).not.toContain('Закрытая причина');
    expect(JSON.stringify(replay.body)).not.toContain('Секретная тема');
  } finally { await redact('manager', true); }
});

it('idempotent incident registration does not replay text derived from a now closed letter', async () => {
  const f = await preparePrivacy();
  await redact('eng1', false);
  try {
    const current = await st.e.s.eng1.get(`/releases/${right.releaseId}/send-events`);
    expect(current.body.incidents.some((i: any) => i.restricted && i.description === null)).toBe(true);
    const replay = await st.e.s.eng1.post(`/releases/${right.releaseId}/compliance-incidents`, f.incidentBody, { headers: f.incidentKey });
    expect(JSON.stringify(replay.body)).not.toContain('Секретное описание');
  } finally { await redact('eng1', true); }
});

// ---------------------------------------------------------------- Проверки исправления

const SECRETS = ['Секретная тема', 'Секретное дополнительное вложение', 'Закрытая причина', 'Секретное описание'];
const sendCount = async () => (await st.e.s.manager.get(`/releases/${right.releaseId}/send-events`)).body.items.length as number;

it('R15-01: повтор без отзыва прав — та же запись и открытое представление, второй записи нет', async () => {
  const f = await preparePrivacy();
  const before = await sendCount();
  const reg = await st.e.s.eng1.post(`/releases/${right.releaseId}/send-events`, f.registerBody, { headers: f.registerKey });
  expect(reg.status, reg.text).toBe(201);
  expect(reg.headers['idempotent-replayed']).toBe('true');
  // Повтор отвечает текущим представлением записи: её уже подтвердил руководитель.
  expect(reg.body).toMatchObject({ id: f.reg.id, status: 'verified', extrasAccepted: true, evidence: { mail: { restricted: false, subject: 'Секретная тема повторного ответа' } } });
  expect(reg.headers.etag).toBe(f.accepted.etag);
  const extras = await st.e.s.manager.post(`/send-events/${f.reg.id}/accept-extras`, f.extraBody, { headers: f.extraKey });
  expect(extras.status, extras.text).toBe(200);
  expect(extras.headers['idempotent-replayed']).toBe('true');
  expect(extras.body).toEqual(f.accepted);
  expect(extras.body.decisions[0]).toMatchObject({ restricted: false, reason: 'Закрытая причина принятия секретного вложения' });
  const incident = await st.e.s.eng1.post(`/releases/${right.releaseId}/compliance-incidents`, f.incidentBody, { headers: f.incidentKey });
  expect(incident.status, incident.text).toBe(201);
  expect(incident.headers['idempotent-replayed']).toBe('true');
  expect(incident.body).toEqual(f.incident);
  expect(await sendCount()).toBe(before);
  const list = await st.e.s.eng1.get(`/releases/${right.releaseId}/send-events`);
  expect(list.body.incidents).toHaveLength(1);
});

it('R15-01: после отзыва mail.read повтор отвечает тем же кодом и ограниченным представлением, как чтение', async () => {
  const f = await preparePrivacy();
  const before = await sendCount();
  await redact('eng1', false);
  await redact('manager', false);
  try {
    const reg = await st.e.s.eng1.post(`/releases/${right.releaseId}/send-events`, f.registerBody, { headers: f.registerKey });
    expect(reg.status, reg.text).toBe(201);
    expect(reg.headers['idempotent-replayed']).toBe('true');
    expect(reg.body).toMatchObject({ id: f.reg.id, evidence: { mail: { restricted: true } } });
    expect(reg.body.files.every((x: any) => x.fileName === null)).toBe(true);
    expect(reg.body.decisions[0]).toMatchObject({ restricted: true, reason: null });
    const listed = (await st.e.s.eng1.get(`/releases/${right.releaseId}/send-events`)).body.items.find((i: any) => i.id === f.reg.id);
    expect(reg.body).toEqual(listed);
    const extras = await st.e.s.manager.post(`/send-events/${f.reg.id}/accept-extras`, f.extraBody, { headers: f.extraKey });
    expect(extras.status, extras.text).toBe(200);
    expect(extras.body).toMatchObject({ id: f.reg.id, evidence: { mail: { restricted: true } } });
    expect(extras.body.decisions[0]).toMatchObject({ restricted: true, reason: null });
    const incident = await st.e.s.eng1.post(`/releases/${right.releaseId}/compliance-incidents`, f.incidentBody, { headers: f.incidentKey });
    expect(incident.status, incident.text).toBe(201);
    expect(incident.body).toMatchObject({ id: f.incident.id, restricted: true, description: null, evidence: { mail: { restricted: true, messageId: null, revisionId: null } } });
    for (const r of [reg, extras, incident]) for (const secret of SECRETS) expect(JSON.stringify(r.body)).not.toContain(secret);
    expect(await sendCount()).toBe(before);
  } finally {
    await redact('eng1', true);
    await redact('manager', true);
  }
});

it('R15-01: в записи идемпотентности закрытого текста нет — только ссылка на запись', async () => {
  const f = await preparePrivacy();
  const keys = [f.registerKey, f.extraKey, f.incidentKey].map((k) => k['Idempotency-Key']!);
  const stored = await st.e.db.pool.query<{ key: string; response_body: unknown }>('SELECT key, response_body FROM idempotency_record WHERE key = ANY($1::text[])', [keys]);
  expect(stored.rows).toHaveLength(3);
  for (const row of stored.rows) for (const secret of SECRETS) expect(JSON.stringify(row.response_body)).not.toContain(secret);
  expect(stored.rows.find((r) => r.key === keys[0])!.response_body).toEqual({ ref: { sendEventId: f.reg.id } });
  expect(stored.rows.find((r) => r.key === keys[2])!.response_body).toEqual({ ref: { incidentId: f.incident.id } });
});

it('R15-01: ключ с другим запросом — отказ; чужой пользователь по тому же ключу записи не получает (контроль)', async () => {
  const f = await preparePrivacy();
  const other = await st.e.s.eng1.post(`/releases/${right.releaseId}/send-events`, { evidence: { kind: 'manual_note' }, channel: 'paper', sentAt: new Date().toISOString(), recipients: ['Заказчик'], note: 'Передано курьером, накладная № 15-777' }, { headers: f.registerKey });
  expect(other.status).toBe(422);
  expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  // Посторонний с чужим ключом записи не получает: запись идемпотентности — своя у каждого пользователя.
  const stranger = await st.e.s.eng2.post(`/releases/${right.releaseId}/send-events`, f.registerBody, { headers: f.registerKey });
  expect([403, 404]).toContain(stranger.status);
  for (const secret of SECRETS) expect(JSON.stringify(stranger.body)).not.toContain(secret);
});

it('R15-01: повтор создания сравнения — то же сравнение, представление по текущим правам', async () => {
  const key = idem();
  const body = { leftReleaseId: left.releaseId, rightReleaseId: right.releaseId };
  const a = await st.e.s.eng1.post(`/tenders/${st.e.s.tenderA}/release-comparisons`, body, { headers: key });
  const b = await st.e.s.eng1.post(`/tenders/${st.e.s.tenderA}/release-comparisons`, body, { headers: key });
  expect(a.status, a.text).toBe(201);
  expect(b.status, b.text).toBe(201);
  expect(b.headers['idempotent-replayed']).toBe('true');
  expect(b.body).toEqual(a.body);
  const stored = await st.e.db.pool.query<{ response_body: unknown }>('SELECT response_body FROM idempotency_record WHERE key = $1', [key['Idempotency-Key']]);
  expect(stored.rows[0]!.response_body).toEqual({ ref: { comparisonId: a.body.id } });
});

it('R15-02: закрытый к правому выпуску вопрос — слева «отправлен», текущий статус в вывод не попадает', async () => {
  // Третий выпуск: вопрос о гарантии к нему уже отвечен, поэтому в его закреплённом входе вопроса нет.
  await rerunReview(st);
  const third = await released(st);
  const c = await st.e.s.eng1.post(`/tenders/${st.e.s.tenderA}/release-comparisons`, { leftReleaseId: right.releaseId, rightReleaseId: third.releaseId }, { headers: idem() });
  expect(c.status, c.text).toBe(201);
  const items = (await st.e.s.eng1.get(`/release-comparisons/${c.body.id}/items?section=questions&limit=200`)).body.items as any[];
  const closed = items.find((i) => i.left?.ref === newQ)!;
  expect(closed).toMatchObject({ change: 'closed', subjectType: 'customer_question', left: { label: frozenNewText, note: 'sent' }, right: null, detail: { leftStatus: 'sent' } });
  expect(JSON.stringify(closed)).not.toContain('answered');
});
