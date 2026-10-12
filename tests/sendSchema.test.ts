// Этап 15: закрытость письма-основания (OD-07-3, R13-02) и вторая линия БД для отправок и нарушений (миграция 0039;
// проект §12, §15), удержания после отправки (state-machines §1.1 п. 4) и обновление схемы 0038 → 0039. Прямые записи
// роли приложения в обход команд должны получать отказ. Данные — поддельные (sendFixtures).
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendKitSha256 } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, MIGRATIONS_DIR, migrate, setupDatabase } from '../packages/db/src/index.ts';
import { acceptAll, approve, assembled, buildStage13, closeStage13, notApplicable, openHolds, release, view, type IStage13 } from './approvalFixtures.ts';
import { ADMIN_URL, auditRows, createUser, drain, idem, type ITestDb } from './helpers.ts';
import { setMailAccess } from './mailFixtures.ts';
import { uploadDocument } from './searchFixtures.ts';
import { buildStage15, kitAttachments, registerByMail, registerSend, released, sentLetter, sends, type IReleased, type ISendView, type IStage15 } from './sendFixtures.ts';

let st: IStage15;
let sent: IReleased;
let unsent: IReleased;
let test: IReleased;
let verified: ISendView;
let extras: ISendView;
let letterRevision: string;

const pgCode = async (sql: string, params: unknown[]): Promise<string> =>
  st.db.pool.query(sql, params).then(
    () => 'ok',
    (x: { code?: string }) => x.code ?? 'error',
  );

// Отказ прав роли приложения (нет DELETE и UPDATE у неизменяемых таблиц) или охранника таблицы.
const DENIED = ['42501', '55000'];

const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n`, 'utf8');
const NOTE = 'Передано курьером под подпись';

const sendColumns = `release_id, tender_id, stage_id, seq, channel, sent_at, evidence_kind, note, attachment_check, kit_sha256, release_manifest_sha256, status, registered_by, idempotency_key`;
const insertNote = (r: IReleased, o: { user?: string; status?: string; check?: string; seq?: string } = {}) =>
  pgCode(
    `INSERT INTO send_event (${sendColumns})
     SELECT r.id, r.tender_id, r.stage_id, ${o.seq ?? '(SELECT coalesce(max(seq), 0) + 1 FROM send_event WHERE release_id = r.id)'}, 'paper', now(), 'manual_note', $3, $4, $5, r.release_manifest_sha256, $6, $2, $7
       FROM release r WHERE r.id = $1`,
    [r.releaseId, o.user ?? st.e.s.ids.eng1, NOTE, o.check ?? 'not_checked', kit(r), o.status ?? 'registered', `direct-${Math.random().toString(36).slice(2)}-key`],
  );
const kit = (r: IReleased): string => sendKitSha256(r.candidate.files.filter((f) => f.audience === 'customer').map((f) => ({ path: f.path, sha256: f.sha256, size: f.sizeBytes })));

beforeAll(async () => {
  st = await buildStage15();
  sent = await released(st);
  const letter = await sentLetter(st, { attachments: kitAttachments(st, sent.candidate), subject: 'КП: закрытая тема' });
  letterRevision = letter.revisionId;
  await notApplicable(st, sent.candidate.id, 'Наше исходящее письмо');
  const ok = await registerByMail(st, sent.releaseId, letter.revisionId);
  expect(ok.status, ok.text).toBe(201);
  verified = ok.body as ISendView;
  const more = await sentLetter(st, { attachments: [...kitAttachments(st, sent.candidate), { name: 'Подпись руководителя.png', type: 'image/png', bytes: Buffer.from('89504e470d0a1a0a', 'hex'), inline: true }] });
  const held = await registerByMail(st, sent.releaseId, more.revisionId);
  expect(held.status).toBe(409);
  await notApplicable(st, sent.candidate.id, 'Наше исходящее письмо');
  const d = await registerByMail(st, sent.releaseId, more.revisionId);
  expect(d.status, d.text).toBe(201);
  extras = d.body as ISendView;
  unsent = await released(st);
  test = await released(st, 'test');
}, 600_000);
afterAll(async () => closeStage13(st));

describe('закрытость письма-основания', () => {
  it('инженер без mail.read видит факт отправки и сверку, но не тему, адреса, имена вложений и причину решения', async () => {
    const accepted = await st.e.s.manager.post(`/send-events/${extras.id}/accept-extras`, { reason: 'Картинка подписи руководителя: к комплекту не относится' }, { headers: { 'If-Match': extras.etag, ...idem() } });
    expect(accepted.status, accepted.text).toBe(200);
    const own = await sends(st, sent.releaseId, st.e.s.eng1);
    expect(own.items[0]!.evidence.mail).toMatchObject({ restricted: false, subject: 'КП: закрытая тема' });
    expect(own.items[1]!.decisions[0]).toMatchObject({ restricted: false, reason: expect.stringContaining('Картинка подписи') });
    const other = await sends(st, sent.releaseId, st.e.s.eng2);
    expect(other.summary).toMatchObject({ state: 'verified', events: 2, counted: 2 });
    const [a, b] = other.items;
    expect(a!.evidence.mail).toEqual({ restricted: true, messageId: null, revisionId: null, mailboxName: null, subject: null, from: null, recipients: [], copies: [] });
    expect(a!.files.every((f) => f.fileName === null && f.kitPath !== null)).toBe(true);
    expect(b!.files.find((f) => f.class === 'unknown')).toMatchObject({ fileName: null, inline: true });
    expect(b!.decisions[0]).toMatchObject({ action: 'accept_extras', restricted: true, reason: null });
    expect(JSON.stringify(other)).not.toMatch(/закрытая тема|customer@example|Подпись руководителя|Картинка подписи/u);
  });

  it('без mail.read нет кандидатов и регистрации по известному ID; письмо из чужого ящика не раскрывается', async () => {
    const c = await st.e.s.eng2.get(`/releases/${unsent.releaseId}/send-candidates`);
    expect(c.status, c.text).toBe(200);
    expect(c.body.items).toEqual([]);
    const r = await registerByMail(st, unsent.releaseId, letterRevision, st.e.s.eng2);
    expect(r.status).toBe(404);
    expect((await st.e.s.manager.get(`/releases/${unsent.releaseId}/send-candidates`)).status).toBe(403);
    expect((await st.e.s.eng3.get(`/releases/${unsent.releaseId}/send-candidates`)).status).toBe(404);
    expect((await st.e.s.eng3.get(`/tenders/${st.e.s.tenderA}/releases`)).status).toBe(404);
    expect((await st.e.s.eng3.post(`/send-events/${verified.id}/accept-extras`, { reason: 'чужой тендер' }, { headers: { 'If-Match': verified.etag, ...idem() } })).status).toBe(404);
  });

  it('руководитель без mail.read лишние вложения не принимает: нельзя решать по тому, чего не читаешь', async () => {
    const letter = await sentLetter(st, { attachments: [...kitAttachments(st, unsent.candidate), { name: 'Записка.pdf', type: 'application/pdf', bytes: pdf('записка') }] });
    await notApplicable(st, unsent.candidate.id, 'Наше исходящее письмо');
    const d = await registerByMail(st, unsent.releaseId, letter.revisionId);
    expect(d.body).toMatchObject({ status: 'disputed', check: { extrasOnly: true } });
    await setMailAccess(st.e.s.admin, st.mailbox, st.e.s.ids.manager, []);
    const view = (await sends(st, unsent.releaseId, st.e.s.manager)).items[0]!;
    expect(view.evidence.mail!.restricted).toBe(true);
    expect(view.actions.acceptExtras).toBe(false);
    const no = await st.e.s.manager.post(`/send-events/${d.body.id}/accept-extras`, { reason: 'Записка к комплекту не относится' }, { headers: { 'If-Match': d.body.etag, ...idem() } });
    expect(no.status).toBe(409);
    expect(no.body.current).toMatchObject({ reason: 'restricted_mail' });
    await setMailAccess(st.e.s.admin, st.mailbox, st.e.s.ids.manager, ['mail.read']);
  });

  it('нарушение с письмом-основанием: описание закрыто тому, кто письмо не читает', async () => {
    const letter = await sentLetter(st, { attachments: kitAttachments(st, test.candidate) });
    const inc = await st.e.s.eng1.post(`/releases/${test.releaseId}/compliance-incidents`, { kind: 'test_release_sent_externally', occurredAt: new Date().toISOString(), description: 'В письме заказчику обещана скидка пять процентов', mailMessageRevisionId: letter.revisionId }, { headers: idem() });
    expect(inc.status, inc.text).toBe(201);
    expect((await sends(st, test.releaseId, st.e.s.eng1)).incidents[0]).toMatchObject({ restricted: false, description: expect.stringContaining('скидка') });
    const other = await sends(st, test.releaseId, st.e.s.eng2);
    expect(other.incidents[0]).toMatchObject({ kind: 'test_release_sent_externally', restricted: true, description: null });
    expect(JSON.stringify(await auditRows(st.db.pool, "action = 'send.incident.register'"))).not.toContain('скидка');
  });
});

describe('вторая линия БД: отправка', () => {
  it('возможности: send.register — инженер тендера, send.accept_extras — руководитель; модель и чужой — ничего', async () => {
    const caps = async (user: string) => (await st.db.pool.query('SELECT tender_capabilities($1, $2) AS caps', [user, st.e.s.tenderA])).rows[0].caps as string[];
    expect(await caps(st.e.s.ids.eng1)).toContain('send.register');
    expect(await caps(st.e.s.ids.eng1)).not.toContain('send.accept_extras');
    expect(await caps(st.e.s.ids.manager)).toContain('send.accept_extras');
    expect(await caps(st.e.s.ids.manager)).not.toContain('send.register');
    expect((await caps(st.e.s.ids.eng3)).filter((c) => c.startsWith('send.'))).toEqual([]);
  });

  it('тестовый выпуск, чужой автор, модель, неверный номер и статус — отказ; готовый выпуск инженером — проходит', async () => {
    expect(await insertNote(test)).toBe('23514');
    expect(await insertNote(unsent, { user: st.e.s.ids.manager })).toBe('42501');
    expect(await insertNote(unsent, { user: st.e.s.ids.eng3 })).toBe('42501');
    const model = await createUser(st.db.pool, 'model15', [], 'Модель');
    await st.db.pool.query("UPDATE app_user SET kind = 'service' WHERE id = $1", [model]).catch(() => undefined);
    expect(await insertNote(unsent, { user: model })).toBe('42501');
    expect(await insertNote(unsent, { seq: '99' })).toBe('23514');
    expect(await insertNote(unsent, { status: 'verified' })).toBe('23514');
    expect(await insertNote(unsent, { check: 'matched', status: 'verified' })).toBe('23514');
    // Время отправки раньше минуты выпуска — отказ; в ту же минуту (ввод с точностью до минуты) — допустимо.
    expect(await pgCode(`INSERT INTO send_event (${sendColumns}) SELECT r.id, r.tender_id, r.stage_id, (SELECT coalesce(max(seq), 0) + 1 FROM send_event WHERE release_id = r.id), 'paper', r.released_at - interval '1 hour', 'manual_note', $2, 'not_checked', $3, r.release_manifest_sha256, 'registered', $4, 'direct-early-key-01' FROM release r WHERE r.id = $1`, [unsent.releaseId, NOTE, kit(unsent), st.e.s.ids.eng1])).toBe('23514');
  });

  it('письмо-основание: итог сверки и вложения считает БД — «совпало» для письма с лишним файлом не записать; чужой файл хранилища основанием не сделать', async () => {
    const letter = await sentLetter(st, { attachments: [...kitAttachments(st, unsent.candidate), { name: 'лишнее.pdf', type: 'application/pdf', bytes: pdf('лишнее') }] });
    await notApplicable(st, unsent.candidate.id, 'Наше исходящее письмо');
    const mail = (await st.db.pool.query<{ message_id: string; communication_id: string; raw: string; sent_at: Date }>(
      'SELECT r.message_id, m.communication_id, r.raw_blob_sha256 AS raw, r.sent_at FROM mail_message_revision r JOIN mail_message m ON m.id = r.message_id WHERE r.id = $1',
      [letter.revisionId],
    )).rows[0]!;
    const insertMail = (check: string, status: string) =>
      pgCode(
        `INSERT INTO send_event (release_id, tender_id, stage_id, seq, channel, sent_at, evidence_kind, mail_message_revision_id, mail_message_id, mail_communication_id, mail_raw_sha256,
                                 attachment_check, kit_sha256, release_manifest_sha256, status, registered_by, idempotency_key)
         SELECT r.id, r.tender_id, r.stage_id, (SELECT coalesce(max(seq), 0) + 1 FROM send_event WHERE release_id = r.id), 'email', $2, 'mail_message', $3, $4, $5, $6, $7, $8,
                r.release_manifest_sha256, $9, $10, $11 FROM release r WHERE r.id = $1`,
        [unsent.releaseId, mail.sent_at, letter.revisionId, mail.message_id, mail.communication_id, mail.raw, check, kit(unsent), status, st.e.s.ids.eng1, `direct-mail-${Math.random().toString(36).slice(2)}`],
      );
    // Без закреплённых вложений и с неверным итогом — отказ в конце транзакции.
    expect(await insertMail('matched', 'verified')).toBe('23514');
    expect(await insertMail('mismatched', 'disputed')).toBe('23514');
    expect(await pgCode("INSERT INTO send_event_file (send_event_id, ordinal, sha256, size_bytes, class, mail_attachment_id, inline) SELECT $1, 9, sha256, size_bytes, 'unknown', id, false FROM mail_attachment LIMIT 1", [verified.id])).toBe('55000');
    const blob = (await st.db.pool.query<{ sha256: string }>('SELECT sha256 FROM blob LIMIT 1')).rows[0]!.sha256;
    expect(await pgCode(
      `INSERT INTO send_event (release_id, tender_id, stage_id, seq, channel, sent_at, evidence_kind, evidence_blob_sha256, evidence_file_name, attachment_check, kit_sha256, release_manifest_sha256, status, registered_by, idempotency_key)
       SELECT r.id, r.tender_id, r.stage_id, (SELECT coalesce(max(seq), 0) + 1 FROM send_event WHERE release_id = r.id), 'paper', now(), 'uploaded_file', $2, 'чужой.pdf', 'not_checked', $3, r.release_manifest_sha256, 'registered', $4, 'direct-file-key-0001' FROM release r WHERE r.id = $1`,
      [unsent.releaseId, blob, kit(unsent), st.e.s.ids.eng1],
    )).toBe('23514');
    // Команда на том же письме записывает «состав не совпал».
    const real = await registerByMail(st, unsent.releaseId, letter.revisionId);
    expect(real.status, real.text).toBe(201);
    expect(real.body).toMatchObject({ status: 'disputed', check: { extrasOnly: true } });
  });

  it('запись отправки неизменна: правка, удаление, «подтверждена» без решения руководителя и решение инженера — отказ', async () => {
    expect(await pgCode("UPDATE send_event SET note = 'исправлено' WHERE id = $1", [verified.id])).toBe('55000');
    expect(await pgCode("UPDATE send_event SET sent_at = now(), row_version = row_version + 1 WHERE id = $1", [verified.id])).toBe('55000');
    expect(DENIED).toContain(await pgCode('DELETE FROM send_event WHERE id = $1', [verified.id]));
    const disputed = (await sends(st, unsent.releaseId)).items.find((x) => x.status === 'disputed')!;
    expect(await pgCode("UPDATE send_event SET status = 'verified', extras_accepted = true, row_version = row_version + 1 WHERE id = $1", [disputed.id])).toBe('42501');
    expect(await pgCode("UPDATE send_event SET status = 'verified', row_version = row_version + 1 WHERE id = $1", [disputed.id])).toBe('55000');
    expect(await pgCode("INSERT INTO send_event_decision (send_event_id, action, actor_user_id, reason) VALUES ($1, 'accept_extras', $2, 'Инженер принимает сам')", [disputed.id, st.e.s.ids.eng1])).toBe('42501');
    expect(DENIED).toContain(await pgCode('DELETE FROM send_event_decision', []));
    expect(DENIED).toContain(await pgCode('DELETE FROM send_event_file WHERE send_event_id = $1', [verified.id]));
    expect(await pgCode('TRUNCATE send_event CASCADE', [])).not.toBe('ok');
  });

  it('нарушение: вид по режиму выпуска, автор — инженер тендера, запись неизменна', async () => {
    const insert = (r: IReleased, kind: string, user: string) =>
      pgCode(
        `INSERT INTO compliance_incident (release_id, tender_id, stage_id, incident_kind, occurred_at, description, registered_by, idempotency_key)
         SELECT r.id, r.tender_id, r.stage_id, $2, now(), 'Комплект ушёл заказчику вне системы', $3, $4 FROM release r WHERE r.id = $1`,
        [r.releaseId, kind, user, `direct-incident-${Math.random().toString(36).slice(2)}`],
      );
    expect(await insert(unsent, 'test_release_sent_externally', st.e.s.ids.eng1)).toBe('23514');
    expect(await insert(test, 'sent_despite_blocker', st.e.s.ids.eng1)).toBe('23514');
    expect(await insert(test, 'other', st.e.s.ids.manager)).toBe('42501');
    expect(await insert(test, 'other', st.e.s.ids.eng1)).toBe('ok');
    expect(DENIED).toContain(await pgCode("UPDATE compliance_incident SET description = 'переписано задним числом' WHERE release_id = $1", [test.releaseId]));
    expect(DENIED).toContain(await pgCode('DELETE FROM compliance_incident WHERE release_id = $1', [test.releaseId]));
    // Нарушение не создаёт отправку и не меняет режим выпуска.
    expect((await sends(st, test.releaseId)).summary).toMatchObject({ state: 'not_registered', events: 0, testRelease: true });
  });
});

describe('удержания после отправки (state-machines §1.1 п. 4) и вторая линия готовности', () => {
  it('новое событие удерживает неотправленный выпуск и не трогает отправленный; при повторной отправке удержание создаётся и блокирует её и в БД', async () => {
    const fresh = await released(st);
    const before = { sent: (await openHolds(st, sent.candidate.id)).length, fresh: (await openHolds(st, fresh.candidate.id)).length };
    await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Письмо заказчика после выпуска.pdf');
    await drain(st.e.worker);
    expect((await openHolds(st, fresh.candidate.id)).length).toBeGreaterThan(before.fresh);
    expect((await openHolds(st, sent.candidate.id)).length).toBe(before.sent);
    expect((await sends(st, sent.releaseId)).summary.readiness.state).toBe('held');
    expect(await insertNote(sent)).toBe('23514');
    expect(await insertNote(fresh)).toBe('23514');
    const r = await registerSend(st, sent.releaseId, { evidence: { kind: 'manual_note' }, channel: 'paper', sentAt: new Date().toISOString(), note: NOTE });
    expect(r.body.current).toMatchObject({ reason: 'not_ready', state: 'held' });
    // Удержания созданы отдельной транзакцией и остались после отказа команды.
    expect((await openHolds(st, sent.candidate.id)).length).toBeGreaterThan(before.sent);
    await notApplicable(st, sent.candidate.id, 'Письмо заказчика на комплект не влияет');
    const ok = await registerSend(st, sent.releaseId, { evidence: { kind: 'manual_note' }, channel: 'paper', sentAt: new Date().toISOString(), note: NOTE });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body).toMatchObject({ repeat: true });
  });
});

describe('обновление схемы 0038 → 0039', () => {
  it('данные этапов 13–14 переживают обновление: согласованный комплект и его удержания на месте, возможности и статус MailHub добавлены; после обновления комплект выпускается, новое событие его удерживает', async () => {
    const name = `kontur_kp_test_upgrade38_${Date.now().toString(36)}`;
    const urlFor = (user: string) => {
      const u = new URL(ADMIN_URL);
      u.username = user;
      u.password = '';
      u.pathname = `/${name}`;
      return u.toString();
    };
    const migrateTo = async (max: number): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), `kontur-mig38-${max}-`));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
      const mc = new pg.Client({ connectionString: urlFor('kontur_migrator') });
      await mc.connect();
      try {
        return (await migrate(mc, { testMode: true, dir })).length;
      } finally {
        await mc.end();
      }
    };
    await setupDatabase(ADMIN_URL, name);
    const db: ITestDb = { name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), pool: createPool(urlFor('kontur_app'), 5), drop: async () => undefined };
    let up: IStage13 | undefined;
    try {
      expect(await migrateTo(38)).toBe(38);
      up = await buildStage13({ db });
      const stage = up;
      // Комплект согласован на прежней схеме; новое событие после согласования — открытое удержание.
      let c = await assembled(stage);
      await notApplicable(stage, c.id).catch(() => 0);
      c = await view(stage, c.id);
      await acceptAll(stage, c);
      c = await view(stage, c.id);
      const a = await approve(stage, c);
      expect(a.status, a.text).toBe(200);
      await uploadDocument(db, stage.e.config, stage.e.s.eng1, stage.e.s.stageA, 'Документ до обновления.pdf');
      await drain(stage.e.worker);
      const holdsBefore = (await openHolds(stage, c.id)).length;
      expect(holdsBefore).toBeGreaterThan(0);
      expect(await migrateTo(39)).toBe(1);
      expect((await openHolds(stage, c.id)).length).toBe(holdsBefore);
      expect((await db.pool.query('SELECT tender_capabilities($1, $2) AS caps', [stage.e.s.ids.eng1, stage.e.s.tenderA])).rows[0].caps).toContain('send.register');
      expect((await db.pool.query('SELECT tender_capabilities($1, $2) AS caps', [stage.e.s.ids.manager, stage.e.s.tenderA])).rows[0].caps).toContain('send.accept_extras');
      expect((await db.pool.query("SELECT status FROM integration_status WHERE system = 'mailhub' AND component = 'MailHubSentReader'")).rows).toEqual([{ status: 'BLOCKED_EXTERNAL' }]);
      // После обновления: решение по удержанию, выпуск, блок отправки; заменённый триггер удерживает неотправленный выпуск.
      await notApplicable(stage, c.id, 'Документ до обновления на комплект не влияет');
      const rel = await release(stage, await view(stage, c.id, stage.e.s.eng1), a.body.approval.id as string);
      expect(rel.status, rel.text).toBe(201);
      const releaseId = rel.body.release.id as string;
      expect((await sends(stage, releaseId)).summary).toMatchObject({ state: 'not_registered', testRelease: true, readiness: { state: 'ready' } });
      await uploadDocument(db, stage.e.config, stage.e.s.eng1, stage.e.s.stageA, 'Документ после обновления.pdf');
      await drain(stage.e.worker);
      expect((await openHolds(stage, c.id)).length).toBeGreaterThan(0);
      expect((await sends(stage, releaseId)).summary.readiness.state).toBe('held');
      const r = await registerSend(stage, releaseId, { evidence: { kind: 'manual_note' }, channel: 'paper', sentAt: new Date().toISOString(), note: NOTE });
      expect(r.body.current).toMatchObject({ reason: 'RELEASE_IS_TEST' });
    } finally {
      await closeStage13(up);
      await db.pool.end().catch(() => undefined);
      await dropDatabase(ADMIN_URL, name);
    }
  }, 600_000);
});
