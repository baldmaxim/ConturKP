// Этап 15: регистрация отправки выпуска (D-035; state-machines §17; проект §3–§7, проверки задания). Боевой выпуск — на
// поддельных данных (sendFixtures): матрица блокеров не обходится. Письма — синтетические EML в ящике портала; MailHub не
// участвует (BLOCKED_EXTERNAL). Тесты идут по порядку и делят состояние этапа.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nodeDeliveryFs } from '../packages/storage/src/index.ts';
import { closeStage13, notApplicable, openHolds } from './approvalFixtures.ts';
import { createDestination, deliveriesOf, deliveryWorker, place, runDeliveries, tempFolders } from './deliveryFixtures.ts';
import { draftOf, act, fieldOf } from './formsFixtures.ts';
import { auditRows, drain, idem } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { completeDraft } from './releaseFixtures.ts';
import { uploadDocument } from './searchFixtures.ts';
import { buildStage15, internalAttachments, kitAttachments, registerByMail, registerSend, released, sentLetter, sends, settle, uploadEvidence, type IReleased, type ISendView, type IStage15 } from './sendFixtures.ts';

// Сценарии собирают настоящие комплекты через LibreOffice: лимит по умолчанию (30 с) на Windows мал (R15-04).
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let st: IStage15;
let r1: IReleased;
let r2: IReleased;
let first: ISendView;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n`, 'utf8');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// Письмо, связанное с тендером, — событие этапа: руководитель решает «не влияет», затем регистрация.
const registerCleared = async (releaseId: string, candidateId: string, revisionId: string) => {
  const held = await registerByMail(st, releaseId, revisionId);
  expect(held.status, held.text).toBe(409);
  expect(held.body.current).toMatchObject({ reason: 'not_ready', state: 'held' });
  expect(await notApplicable(st, candidateId, 'Наше исходящее письмо: на комплект не влияет')).toBeGreaterThan(0);
  return registerByMail(st, releaseId, revisionId);
};

beforeAll(async () => {
  st = await buildStage15();
  r1 = await released(st);
}, 600_000);
// Незавершённая фоновая сборка отказавшего теста не переходит в следующий (R15-04).
afterEach(async () => settle(st));
afterAll(async () => closeStage13(st));

describe('нет sent-письма в общей ленте; размещение — не отправка (A31, A33)', () => {
  it('выпуск боевой; отправка «не зарегистрирована» — не «не отправлено»; писем-кандидатов нет, и это ничего не доказывает', async () => {
    expect(r1.candidate.mode).toBe('production');
    const s = await sends(st, r1.releaseId);
    expect(s.summary).toMatchObject({ state: 'not_registered', events: 0, counted: 0, testRelease: false, provesReceipt: false });
    expect(s.mailhub.status).toBe('BLOCKED_EXTERNAL');
    expect(s.can).toMatchObject({ register: true, registerBlockedBy: null, registerIncident: true });
    const c = await st.e.s.eng1.get(`/releases/${r1.releaseId}/send-candidates`);
    expect(c.status, c.text).toBe(200);
    expect(c.body.items).toEqual([]);
    expect(c.body.note).toContain('не доказывает');
  });

  it('выпуск размещён в боевую сетевую папку — отправки от этого не появляется; до размещения — предупреждение, не запрет (В-15-2)', async () => {
    expect((await sends(st, r1.releaseId)).warnings).toEqual(['not_placed']);
    const f = tempFolders();
    await createDestination(st.e.s.admin, { title: 'Сетевая папка (боевая, фикстура)', kind: 'smb', environment: 'production', rootPath: join(f.base, 'prod') });
    mkdirSync(join(f.base, 'prod'), { recursive: true });
    const p = await place(st.e.s.eng1, r1.releaseId, 'Размещение боевого выпуска фикстуры');
    expect([200, 201], p.text).toContain(p.status);
    await runDeliveries(st, deliveryWorker(st, nodeDeliveryFs()));
    expect((await deliveriesOf(st.e.s.eng1, r1.releaseId)).summary).toMatchObject({ total: 1, delivered: 1 });
    const s = await sends(st, r1.releaseId);
    expect(s.summary.state).toBe('not_registered');
    expect(s.warnings).toEqual([]);
  });
});

describe('регистрация по письму: точные вложения, повторы, папки и ящики (A32, A34)', () => {
  let letter: { messageId: string; revisionId: string; header: string };

  it('письмо с точными файлами комплекта под другими именами — «подтверждена»; содержимое письма в журнал не попадает', async () => {
    const renamed = kitAttachments(st, r1.candidate).map((a, i) => ({ ...a, name: `КП для заказчика ${i + 1}.docx` }));
    letter = await sentLetter(st, { attachments: renamed, subject: 'КП: секретная тема письма' });
    const ok = await registerCleared(r1.releaseId, r1.candidate.id, letter.revisionId);
    expect(ok.status, ok.text).toBe(201);
    first = ok.body as ISendView;
    expect(first).toMatchObject({ seq: 1, channel: 'email', status: 'verified', attachmentCheck: 'matched', counted: true, repeat: false, extrasAccepted: false, recipients: [], note: null });
    expect(first.evidence.mail).toMatchObject({ restricted: false, subject: 'КП: секретная тема письма', recipients: ['customer@example.test'] });
    expect(first.files.length).toBeGreaterThan(0);
    expect(first.files.every((f) => f.class === 'kit' && f.kitPath !== null && f.fileName!.startsWith('КП для заказчика'))).toBe(true);
    // Запись — факт отправки: ни получения, ни согласия заказчика в ответе нет (A46).
    expect(Object.keys(first).some((k) => /receiv|deliver|accept(ed)?By|read/iu.test(k))).toBe(false);
    const audit = await auditRows(st.db.pool, "action = 'send.register' AND outcome = 'allowed'");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.details)).not.toMatch(/секретная|customer@example|КП для заказчика/u);
    expect(audit[0]!.details).toMatchObject({ status: 'verified', attachmentCheck: 'matched', warnings: [] });
  });

  it('то же письмо повторно — отказ со ссылкой на запись; удержаний попытка не создаёт', async () => {
    const before = (await openHolds(st, r1.candidate.id)).length;
    const again = await registerByMail(st, r1.releaseId, letter.revisionId);
    expect(again.status).toBe(409);
    expect(again.body.current).toMatchObject({ reason: 'evidence_already_registered', sendEventId: first.id });
    expect((await openHolds(st, r1.candidate.id)).length).toBe(before);
  });

  it('то же письмо во втором ящике и другой папке — одна отправка; копии видны как происхождения', async () => {
    const second = await createMailbox(st.e.s.admin, 'director@contractor.example.test', 'Директор');
    await setMailAccess(st.e.s.admin, second, st.e.s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
    // Решение по событию принимает тот, кто читает его предмет: руководителю нужен mail.read и на второй ящик.
    await setMailAccess(st.e.s.admin, second, st.e.s.ids.manager, ['mail.read']);
    const copy = await sentLetter(st, { attachments: kitAttachments(st, r1.candidate), messageId: letter.header, mailbox: second, folder: 'Sent Items' });
    const dup = await registerByMail(st, r1.releaseId, copy.revisionId);
    expect(dup.status).toBe(409);
    expect(dup.body.current).toMatchObject({ reason: 'evidence_already_registered', sendEventId: first.id });
    const s = await sends(st, r1.releaseId);
    expect(s.summary).toMatchObject({ events: 1, counted: 1 });
    expect(s.items[0]!.evidence.mail!.copies.map((c) => c.mailboxName).sort()).toEqual(['Директор', 'Тендерный отдел']);
    expect((await sends(st, r1.releaseId, st.e.s.manager)).items[0]!.evidence.mail!.copies).toHaveLength(2);
  });

  it('письмо без Message-ID теми же байтами в двух ящиках — тоже одна отправка (по байтам письма)', async () => {
    const r = await released(st);
    const second = await createMailbox(st.e.s.admin, 'archive@contractor.example.test', 'Архив');
    await setMailAccess(st.e.s.admin, second, st.e.s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
    await setMailAccess(st.e.s.admin, second, st.e.s.ids.manager, ['mail.read']);
    const raw = eml({ messageId: null, subject: 'КП без идентификатора', from: 'tender-out@contractor.example.test', to: 'customer@example.test', date: new Date(Date.now() + 2000).toUTCString(), text: 'КП', attachments: kitAttachments(st, r.candidate) });
    const a = await importEml(st.e.s.eng1, st.e.worker, st.mailbox, raw, { direction: 'outbound' });
    const b = await importEml(st.e.s.eng1, st.e.worker, second, raw, { direction: 'outbound', folder: 'Отправленные' });
    await linkMail(st.e.s.eng1, a.messageId!, st.e.s.tenderA, st.e.s.stageA);
    await linkMail(st.e.s.eng1, b.messageId!, st.e.s.tenderA, st.e.s.stageA);
    const ok = await registerCleared(r.releaseId, r.candidate.id, a.revisionId!);
    expect(ok.status, ok.text).toBe(201);
    const dup = await registerByMail(st, r.releaseId, b.revisionId!);
    expect(dup.body.current).toMatchObject({ reason: 'evidence_already_registered', sendEventId: ok.body.id });
    r2 = r;
  });

  it('другое письмо с теми же файлами — вторая запись «повторная»; после новых событий сначала решение руководителя (I04)', async () => {
    const letter2 = await sentLetter(st, { attachments: kitAttachments(st, r1.candidate) });
    // У отправленного выпуска новых удержаний нет: они создаются при попытке повторной отправки.
    const ok = await registerCleared(r1.releaseId, r1.candidate.id, letter2.revisionId);
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body).toMatchObject({ seq: 2, status: 'verified', repeat: true, counted: true });
    expect((await sends(st, r1.releaseId)).summary).toMatchObject({ state: 'verified', events: 2, counted: 2 });
  });

  it('повтор команды с тем же ключом — тот же ответ, одна запись', async () => {
    const key = idem();
    const body = { evidence: { kind: 'manual_note' }, channel: 'paper', sentAt: new Date().toISOString(), recipients: ['Заказчик, канцелярия'], note: 'Передано курьером, накладная № 15-001' };
    const a = await registerSend(st, r1.releaseId, body, st.e.s.eng1, key);
    const b = await registerSend(st, r1.releaseId, body, st.e.s.eng1, key);
    expect(a.status, a.text).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(a.body).toMatchObject({ status: 'registered', attachmentCheck: 'not_checked', channel: 'paper', counted: true, repeat: true, recipients: ['Заказчик, канцелярия'] });
    expect((await sends(st, r1.releaseId)).summary.events).toBe(3);
  });
});

describe('ручная регистрация с основанием (спецификация §9)', () => {
  it('файл-основание: «зарегистрирована, состав не сверялся»; файл скачивает участник тендера, чужой — 404', async () => {
    const bytes = pdf('скан накладной');
    const uploadId = await uploadEvidence(st, r1.releaseId, bytes, 'Накладная курьера.pdf');
    const r = await registerSend(st, r1.releaseId, { evidence: { kind: 'uploaded_file', uploadId }, channel: 'customer_portal', sentAt: new Date().toISOString(), recipients: [] });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'registered', attachmentCheck: 'not_checked', evidence: { kind: 'uploaded_file', file: { fileName: 'Накладная курьера.pdf', sha256: sha(bytes) } } });
    const file = await st.e.s.manager.getBuffer(`/send-events/${r.body.id}/evidence`);
    expect(file.status).toBe(200);
    expect(sha(file.body as Buffer)).toBe(sha(bytes));
    expect(file.headers['content-disposition']).toContain('attachment');
    expect(file.headers['content-type']).toContain('application/octet-stream');
    expect((await st.e.s.eng3.get(`/send-events/${r.body.id}/evidence`)).status).toBe(404);
    expect((await st.e.s.eng3.get(`/releases/${r1.releaseId}/send-events`)).status).toBe(404);
  });

  it('чужая загрузка и чужой файл хранилища основанием не становятся; пояснение короче 10 знаков — отказ', async () => {
    const uploadId = await uploadEvidence(st, r1.releaseId, pdf('чужое'), 'чужое.pdf', st.e.s.eng2);
    const foreign = await registerSend(st, r1.releaseId, { evidence: { kind: 'uploaded_file', uploadId }, channel: 'other', sentAt: new Date().toISOString() });
    expect(foreign.status).toBe(404);
    const other = await uploadEvidence(st, r2.releaseId, pdf('другой выпуск'), 'другой.pdf');
    expect((await registerSend(st, r1.releaseId, { evidence: { kind: 'uploaded_file', uploadId: other }, channel: 'other', sentAt: new Date().toISOString() })).status).toBe(404);
    expect((await registerSend(st, r1.releaseId, { evidence: { kind: 'manual_note' }, channel: 'paper', sentAt: new Date().toISOString(), note: 'коротко' })).status).toBe(400);
    expect((await registerSend(st, r1.releaseId, { evidence: { kind: 'manual_note' }, channel: 'paper', note: 'Передано курьером лично' })).status).toBe(400);
  });

  it('время отправки раньше выпуска или в будущем — отказ; права: руководитель не регистрирует, инженер 2 — да', async () => {
    const note = { evidence: { kind: 'manual_note' }, channel: 'paper', note: 'Передано нарочным под подпись' };
    const early = await registerSend(st, r1.releaseId, { ...note, sentAt: new Date(new Date(r1.releasedAt).getTime() - 60_000).toISOString() });
    expect(early.body.current).toMatchObject({ reason: 'sent_before_release' });
    const future = await registerSend(st, r1.releaseId, { ...note, sentAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    expect(future.body.current).toMatchObject({ reason: 'sent_in_future' });
    const boss = await registerSend(st, r1.releaseId, { ...note, sentAt: new Date().toISOString() }, st.e.s.manager);
    expect(boss.status).toBe(403);
    expect((await auditRows(st.db.pool, "action = 'send.register' AND outcome = 'denied'")).length).toBeGreaterThan(0);
    const eng2 = await registerSend(st, r1.releaseId, { ...note, sentAt: new Date().toISOString() }, st.e.s.eng2);
    expect(eng2.status, eng2.text).toBe(201);
  });
});

describe('дополнительное вложение (A32; D-035 В-15-1)', () => {
  let disputed: ISendView;

  it('комплект и лишние вложения — «состав не совпал», не засчитана; принять может только руководитель, с причиной', async () => {
    const r = await released(st);
    const extra = [...kitAttachments(st, r.candidate), { name: 'Сопроводительная записка.pdf', type: 'application/pdf', bytes: pdf('записка') }, { name: 'logo.png', type: 'image/png', bytes: png, inline: true }];
    const letter = await sentLetter(st, { attachments: extra });
    const res = await registerCleared(r.releaseId, r.candidate.id, letter.revisionId);
    expect(res.status, res.text).toBe(201);
    disputed = res.body as ISendView;
    expect(disputed).toMatchObject({ status: 'disputed', attachmentCheck: 'mismatched', counted: false, extrasAccepted: false });
    expect(disputed.check).toMatchObject({ missing: [], extras: { unknown: 2, inline: 1, internal: 0, otherRelease: 0 }, extrasOnly: true });
    expect(disputed.files.filter((f) => f.class === 'unknown').map((f) => f.fileName).sort()).toEqual(['logo.png', 'Сопроводительная записка.pdf']);
    expect((await sends(st, r.releaseId)).summary).toMatchObject({ state: 'disputed', counted: 0, disputed: 1 });
    const byEngineer = await st.e.s.eng1.post(`/send-events/${disputed.id}/accept-extras`, { reason: 'Это подпись и записка' }, { headers: { 'If-Match': disputed.etag, ...idem() } });
    expect(byEngineer.status).toBe(403);
    expect((await st.e.s.manager.post(`/send-events/${disputed.id}/accept-extras`, { reason: 'Это подпись и записка' }, { headers: idem() })).status).toBe(428);
    const ok = await st.e.s.manager.post(`/send-events/${disputed.id}/accept-extras`, { reason: 'Логотип подписи и сопроводительная записка: к комплекту не относятся' }, { headers: { 'If-Match': disputed.etag, ...idem() } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'verified', attachmentCheck: 'mismatched', extrasAccepted: true, counted: true });
    expect(ok.body.decisions[0]).toMatchObject({ action: 'accept_extras', restricted: false, reason: expect.stringContaining('Логотип') });
    expect((await sends(st, r.releaseId)).summary).toMatchObject({ state: 'verified', counted: 1, disputed: 0 });
    const audit = await auditRows(st.db.pool, "action = 'send.accept_extras' AND outcome = 'allowed'");
    expect(JSON.stringify(audit[0]!.details)).not.toContain('Логотип');
    const stale = await st.e.s.manager.post(`/send-events/${disputed.id}/accept-extras`, { reason: 'Повторное принятие' }, { headers: { 'If-Match': disputed.etag, ...idem() } });
    expect(stale.status).toBe(412);
  });

  it('отсутствующий файл комплекта и внутренний файл так не снимаются', async () => {
    const r = await released(st);
    const missing = await sentLetter(st, { attachments: [{ name: 'Не тот файл.pdf', type: 'application/pdf', bytes: pdf('не тот') }] });
    const m = await registerCleared(r.releaseId, r.candidate.id, missing.revisionId);
    expect(m.body).toMatchObject({ status: 'disputed', check: { extrasOnly: false } });
    expect(m.body.check.missing.length).toBeGreaterThan(0);
    const no = await st.e.s.manager.post(`/send-events/${m.body.id}/accept-extras`, { reason: 'Пробуем принять отсутствие файла' }, { headers: { 'If-Match': m.body.etag, ...idem() } });
    expect(no.body.current).toMatchObject({ reason: 'not_extras_only' });
    const leak = await sentLetter(st, { attachments: [...kitAttachments(st, r.candidate), ...internalAttachments(st, r.candidate)] });
    const l = await registerCleared(r.releaseId, r.candidate.id, leak.revisionId);
    expect(l.body).toMatchObject({ status: 'disputed', check: { missing: [], extrasOnly: false } });
    expect(l.body.check.extras.internal).toBeGreaterThan(0);
    expect(l.body.files.some((f: { class: string }) => f.class === 'internal')).toBe(true);
    const no2 = await st.e.s.manager.post(`/send-events/${l.body.id}/accept-extras`, { reason: 'Пробуем принять внутренний файл' }, { headers: { 'If-Match': l.body.etag, ...idem() } });
    expect(no2.body.current).toMatchObject({ reason: 'not_extras_only' });
    expect((await sends(st, r.releaseId)).summary).toMatchObject({ state: 'disputed', counted: 0, disputed: 2 });
  });
});

describe('исправленный выпуск и старый комплект в новом письме (A32)', () => {
  it('письмо с файлами исправленного выпуска против прежнего — «состав не совпал» (комплект № N); против своего — «подтверждена»; старый комплект против нового — тоже расхождение', async () => {
    const old = await released(st);
    const d = await draftOf(st.e.s.eng1, st.drafts.letter);
    const edit = await act(st.e.s.eng1, st.drafts.letter, 'subject', fieldOf(d, 'subject').etag, { action: 'set', value: 'Исправленный предмет предложения', bases: [] });
    expect(edit.status, edit.text).toBe(200);
    if ((await draftOf(st.e.s.eng1, st.drafts.letter)).status !== 'complete') await completeDraft(st.e.s.eng1, st.drafts.letter);
    const fixed = await released(st);
    expect(fixed.candidate.files.find((f) => f.audience === 'customer')!.sha256).not.toBe(old.candidate.files.find((f) => f.audience === 'customer')!.sha256);

    const newLetter = await sentLetter(st, { attachments: kitAttachments(st, fixed.candidate) });
    const vsOld = await registerCleared(old.releaseId, old.candidate.id, newLetter.revisionId);
    expect(vsOld.status, vsOld.text).toBe(201);
    expect(vsOld.body).toMatchObject({ status: 'disputed', counted: false, check: { extrasOnly: false } });
    expect(vsOld.body.files.every((f: { class: string; otherReleaseSeq: number }) => f.class === 'other_release' && f.otherReleaseSeq === fixed.candidate.seq)).toBe(true);
    await notApplicable(st, fixed.candidate.id, 'Наше исходящее письмо');
    const vsFixed = await registerByMail(st, fixed.releaseId, newLetter.revisionId);
    expect(vsFixed.status, vsFixed.text).toBe(201);
    expect(vsFixed.body).toMatchObject({ status: 'verified', attachmentCheck: 'matched' });

    // Старый комплект в новом письме: против нового выпуска — расхождение, вложения узнаны как комплект № старого.
    const oldLetter = await sentLetter(st, { attachments: kitAttachments(st, old.candidate) });
    const cands = await st.e.s.eng1.get(`/releases/${fixed.releaseId}/send-candidates`);
    const cand = (cands.body.items as { revisionId: string; check: string; otherReleaseSeqs: number[]; missing: number }[]).find((x) => x.revisionId === oldLetter.revisionId)!;
    expect(cand).toMatchObject({ check: 'mismatched', otherReleaseSeqs: [old.candidate.seq] });
    expect(cand.missing).toBeGreaterThan(0);
    const wrong = await registerCleared(fixed.releaseId, fixed.candidate.id, oldLetter.revisionId);
    expect(wrong.body).toMatchObject({ status: 'disputed', counted: false });
    expect(wrong.body.files[0]).toMatchObject({ class: 'other_release', otherReleaseSeq: old.candidate.seq });
    // Отправка исправленного выпуска сохраняется; у прежнего — только расхождение.
    expect((await sends(st, fixed.releaseId)).summary).toMatchObject({ state: 'verified', counted: 1, disputed: 1 });
    expect((await sends(st, old.releaseId)).summary).toMatchObject({ state: 'disputed', counted: 0 });
  });
});

describe('основание — только отправленное письмо, связанное с тендером', () => {
  it('входящее письмо, несвязанное письмо, письмо раньше выпуска — отказ с причиной', async () => {
    const r = await released(st);
    const inbound = await sentLetter(st, { attachments: kitAttachments(st, r.candidate), direction: 'inbound' });
    await notApplicable(st, r.candidate.id, 'Входящее письмо на комплект не влияет');
    expect((await registerByMail(st, r.releaseId, inbound.revisionId)).body.current).toMatchObject({ reason: 'mail_not_outbound' });
    const unlinked = await sentLetter(st, { attachments: kitAttachments(st, r.candidate), link: false });
    expect((await registerByMail(st, r.releaseId, unlinked.revisionId)).body.current).toMatchObject({ reason: 'mail_not_linked' });
    const early = await sentLetter(st, { attachments: kitAttachments(st, r.candidate), date: new Date(new Date(r.releasedAt).getTime() - 3_600_000) });
    await notApplicable(st, r.candidate.id, 'Письмо на комплект не влияет');
    expect((await registerByMail(st, r.releaseId, early.revisionId)).body.current).toMatchObject({ reason: 'sent_before_release' });
    expect((await sends(st, r.releaseId)).summary.events).toBe(0);
    r2 = r;
  });
});

describe('актуальность: новое событие после выпуска (I04, R13-03)', () => {
  it('новый документ удерживает неотправленный выпуск; «влияет» исключает отправку навсегда; фактическая отправка — нарушение, не отправка', async () => {
    await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Изменение ТЗ после выпуска.pdf');
    await drain(st.e.worker);
    const s = await sends(st, r2.releaseId);
    expect(s.summary.readiness.state).toBe('held');
    expect(s.can).toMatchObject({ register: false, registerBlockedBy: 'held' });
    const note = { evidence: { kind: 'manual_note' }, channel: 'paper', sentAt: new Date().toISOString(), note: 'Передано курьером лично' };
    expect((await registerSend(st, r2.releaseId, note)).body.current).toMatchObject({ reason: 'not_ready', state: 'held' });
    // Готовый к отправке выпуск — не нарушение.
    const holds = await openHolds(st, r2.candidate.id);
    const decided = await st.e.s.manager.post(`/release-candidates/${r2.candidate.id}/holds/resolve`, { holdIds: holds.map((h) => h.id), resolution: 'requires_new_candidate', reason: 'ТЗ изменилось' }, { headers: idem() });
    expect(decided.status, decided.text).toBe(200);
    expect((await registerSend(st, r2.releaseId, note)).body.current).toMatchObject({ reason: 'not_ready', state: 'excluded' });
    const incident = await st.e.s.eng1.post(`/releases/${r2.releaseId}/compliance-incidents`, { kind: 'sent_despite_blocker', occurredAt: new Date().toISOString(), description: 'Комплект отправлен заказчику до решения по новому ТЗ' }, { headers: idem() });
    expect(incident.status, incident.text).toBe(201);
    const after = await sends(st, r2.releaseId);
    expect(after.summary).toMatchObject({ state: 'not_registered', events: 0, incidents: 1 });
    expect(after.incidents[0]).toMatchObject({ kind: 'sent_despite_blocker', restricted: false });
    const ready = await st.e.s.eng1.post(`/releases/${r1.releaseId}/compliance-incidents`, { kind: 'test_release_sent_externally', occurredAt: new Date().toISOString(), description: 'Неверный вид нарушения для боевого выпуска' }, { headers: idem() });
    expect(ready.body.current).toMatchObject({ reason: 'incident_kind_mismatch' });
  });
});

describe('тестовый выпуск не регистрируется как отправка (RT-05)', () => {
  it('RELEASE_IS_TEST; нарушение «тестовый комплект ушёл заказчику» — отдельная запись, отправкой не становится', async () => {
    const t = await released(st, 'test');
    const s = await sends(st, t.releaseId);
    expect(s.summary).toMatchObject({ state: 'not_registered', testRelease: true });
    expect(s.can).toMatchObject({ register: false, registerBlockedBy: 'release_is_test', registerIncident: true });
    const r = await registerSend(st, t.releaseId, { evidence: { kind: 'manual_note' }, channel: 'email', sentAt: new Date().toISOString(), note: 'Отправили тестовый комплект' });
    expect(r.status).toBe(409);
    expect(r.body.current).toMatchObject({ reason: 'RELEASE_IS_TEST' });
    const letter = await sentLetter(st, { attachments: kitAttachments(st, t.candidate) });
    expect((await registerByMail(st, t.releaseId, letter.revisionId)).body.current).toMatchObject({ reason: 'RELEASE_IS_TEST' });
    const wrong = await st.e.s.eng1.post(`/releases/${t.releaseId}/compliance-incidents`, { kind: 'sent_despite_blocker', occurredAt: new Date().toISOString(), description: 'Неверный вид для тестового выпуска' }, { headers: idem() });
    expect(wrong.body.current).toMatchObject({ reason: 'incident_kind_mismatch' });
    const inc = await st.e.s.eng1.post(`/releases/${t.releaseId}/compliance-incidents`, { kind: 'test_release_sent_externally', occurredAt: new Date().toISOString(), description: 'Тестовый комплект ушёл заказчику письмом', mailMessageRevisionId: letter.revisionId }, { headers: idem() });
    expect(inc.status, inc.text).toBe(201);
    expect((await st.e.s.manager.post(`/releases/${t.releaseId}/compliance-incidents`, { kind: 'other', occurredAt: new Date().toISOString(), description: 'Руководитель нарушение не регистрирует' }, { headers: idem() })).status).toBe(403);
    const after = await sends(st, t.releaseId);
    expect(after.summary).toMatchObject({ state: 'not_registered', events: 0, counted: 0, incidents: 1, testRelease: true });
    expect((await st.e.s.eng1.get(`/releases/${t.releaseId}`)).body.mode).toBe('test');
  });
});
