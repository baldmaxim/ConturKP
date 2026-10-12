// Отправка выпуска и нарушения (этап 15; D-035; portal-api §2.10; state-machines §17). Регистрирует инженер тендера
// (send.register), только человек; лишние вложения письма принимает руководитель (send.accept_extras, В-15-1). Команда —
// одна транзакция под блокировкой этапа: тестовый выпуск не регистрируется (RT-05), готовность — `releaseSendReadiness`
// (I04), размещение не требуется — только предупреждение и запись в аудите (В-15-2). Отправка — факт отправки: получения
// и согласия заказчика она не подтверждает (A46, I08). Содержимое письма-основания (тема, адреса, имена вложений) и
// причина решения по лишним вложениям — только при mail.read на ящик письма (OD-07-3, R13-02).
import { AcceptSendExtrasRequest, RegisterIncidentRequest, RegisterSendRequest } from '@kontur/contracts';
import { formatEtag, sendCounted } from '@kontur/core';
import {
  acceptSendExtras,
  classifyRevisionAttachments,
  communicationCopies,
  ensureReleaseHolds,
  getCandidate,
  getEvidenceUpload,
  getIncident,
  getRelease,
  getSendEvent,
  insertBlob,
  insertEvidenceUpload,
  insertIncident,
  listDeliveries,
  listIncidents,
  listSendEvents,
  listTenderReleases,
  lockTenderStages,
  missingDestinationsOf,
  readableMailboxIds,
  registerSendEvent,
  releaseSendReadiness,
  sendCandidateMessages,
  sendEventDecisions,
  sendEventFiles,
  sendEventOfLetter,
  sendKitFiles,
  sendMailEvidence,
  sendSummaries,
  type IAccessContext,
  type IIncidentRow,
  type IReleaseRow,
  type ISendEventRow,
  type ISendMailEvidence,
  type Pool,
  type PoolClient,
  type Queryable,
} from '@kontur/db';
import type { IAppConfig } from '@kontur/config';
import { summarizeSendMatch } from '@kontur/core';
import type { BlobStore } from '@kontur/storage';
import { Router, type Request } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { requireCtx } from '../http/context.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { receiveUpload, uploadedBlob, uploadName } from '../http/upload.ts';
import { candidateVisible, iso, loadVisibleRelease } from '../releaseViews.ts';
import { CONTENT_CSP, contentDisposition } from './documents.ts';
import { conflict } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';

const target = (r: { id: string; tender_id: string }) => ({ tenderId: r.tender_id, entityType: 'release', entityId: r.id });

// ---------------------------------------------------------------- Письмо-основание

interface IMailView {
  restricted: boolean;
  messageId: string | null;
  revisionId: string | null;
  mailboxName: string | null;
  subject: string | null;
  from: string | null;
  recipients: string[];
  copies: { messageId: string; mailboxName: string; folder: string | null }[];
}

const CLOSED_MAIL: IMailView = { restricted: true, messageId: null, revisionId: null, mailboxName: null, subject: null, from: null, recipients: [], copies: [] };

interface IRevisionHead {
  id: string;
  message_id: string;
  mailbox_id: string;
  mailbox_name: string;
  subject: string | null;
  from_address: string | null;
  participants: { role: string; address: string }[];
}

// Заголовки ревизий писем — только из ящиков, которые читает пользователь.
const revisionHeads = async (db: Queryable, ctx: IAccessContext, revisionIds: readonly string[]): Promise<Map<string, IRevisionHead>> => {
  if (revisionIds.length === 0) return new Map();
  const r = await db.query<IRevisionHead>(
    `SELECT r.id, r.message_id, m.mailbox_id, b.display_name AS mailbox_name, r.subject, r.from_address, r.participants
       FROM mail_message_revision r JOIN mail_message m ON m.id = r.message_id JOIN mailbox b ON b.id = m.mailbox_id
      WHERE r.id = ANY($1::uuid[]) AND m.mailbox_id = ANY($2::uuid[])`,
    [[...revisionIds], readableMailboxIds(ctx)],
  );
  return new Map(r.rows.map((x) => [x.id, x]));
};

const recipientsOf = (participants: readonly { role: string; address: string }[]): string[] => participants.filter((p) => ['to', 'cc', 'bcc'].includes(p.role)).map((p) => p.address);

const attachmentNames = async (db: Queryable, attachmentIds: readonly string[]): Promise<Map<string, string>> =>
  attachmentIds.length === 0
    ? new Map()
    : new Map((await db.query<{ id: string; filename: string }>('SELECT id, filename FROM mail_attachment WHERE id = ANY($1::uuid[])', [[...attachmentIds]])).rows.map((a) => [a.id, a.filename]));

// ---------------------------------------------------------------- Представления

const stateOf = (events: readonly ISendEventRow[]): 'not_registered' | 'registered_unchecked' | 'verified' | 'disputed' =>
  events.some((e) => e.status === 'verified') ? 'verified' : events.some((e) => e.status === 'registered') ? 'registered_unchecked' : events.length > 0 ? 'disputed' : 'not_registered';

// Размещение для регистрации не требуется (D-035 В-15-2): незавершённое размещение и неподтверждённое облако — предупреждения.
const placementWarnings = async (db: Queryable, r: IReleaseRow): Promise<string[]> => {
  const active = (await listDeliveries(db, r.id)).filter((d) => d.status !== 'superseded');
  const missing = await missingDestinationsOf(db, r.id, r.mode);
  const out: string[] = [];
  if (active.length === 0 || missing.length > 0 || active.some((d) => d.status !== 'delivered')) out.push('not_placed');
  if (active.some((d) => d.kind === 'yandex_disk' && d.cloud_state !== 'confirmed')) out.push('cloud_unconfirmed');
  return out;
};

const sendViews = async (db: Queryable, ctx: IAccessContext, r: IReleaseRow, events: readonly ISendEventRow[]) => {
  const ids = events.map((e) => e.id);
  const files = await sendEventFiles(db, ids);
  const decisions = await sendEventDecisions(db, ids);
  const heads = await revisionHeads(db, ctx, events.map((e) => e.mail_message_revision_id).filter((x): x is string => !!x));
  const copies = await communicationCopies(db, ctx, events.map((e) => e.mail_communication_id).filter((x): x is string => !!x));
  // Имена вложений — только у писем, которые пользователь читает.
  const readableEvents = events.filter((e) => e.mail_message_revision_id && heads.has(e.mail_message_revision_id));
  const names = await attachmentNames(db, readableEvents.flatMap((e) => (files.get(e.id) ?? []).map((f) => f.mail_attachment_id)));
  const canAccept = hasTenderCap(ctx, r.tender_id, 'send.accept_extras');
  let counted = 0;
  return events.map((e) => {
    const head = e.mail_message_revision_id ? heads.get(e.mail_message_revision_id) : undefined;
    const readable = e.evidence_kind !== 'mail_message' || !!head;
    const repeat = sendCounted(e.status) && counted > 0;
    if (sendCounted(e.status)) counted += 1;
    const mail: IMailView | null =
      e.evidence_kind !== 'mail_message'
        ? null
        : head
          ? {
              restricted: false,
              messageId: head.message_id,
              revisionId: head.id,
              mailboxName: head.mailbox_name,
              subject: head.subject,
              from: head.from_address,
              recipients: recipientsOf(head.participants),
              copies: (copies.get(e.mail_communication_id!) ?? []).map((c) => ({ messageId: c.messageId, mailboxName: c.mailboxName, folder: c.folder })),
            }
          : CLOSED_MAIL;
    return {
      id: e.id,
      releaseId: e.release_id,
      seq: e.seq,
      channel: e.channel,
      sentAt: iso(e.sent_at),
      status: e.status,
      attachmentCheck: e.attachment_check,
      extrasAccepted: e.extras_accepted,
      counted: sendCounted(e.status),
      repeat,
      evidence: {
        kind: e.evidence_kind,
        mail,
        file: e.evidence_kind === 'uploaded_file' ? { fileName: e.evidence_file_name, sha256: e.evidence_blob_sha256 } : null,
      },
      recipients: e.recipients,
      note: e.note,
      check: e.check_detail,
      // Имя вложения — из письма (только при mail.read); у файла комплекта — путь из выпуска.
      files: (files.get(e.id) ?? []).map((f) => ({
        ordinal: f.ordinal,
        sha256: f.sha256,
        size: f.size_bytes,
        class: f.class,
        kitPath: f.kit_path,
        otherReleaseSeq: f.other_release_seq,
        inline: f.inline,
        fileName: readable ? (names.get(f.mail_attachment_id) ?? null) : null,
      })),
      // Причина решения по лишним вложениям описывает содержимое письма: закрыта вместе с письмом (R13-02).
      decisions: (decisions.get(e.id) ?? []).map((d) => ({ action: d.action, actor: { id: d.actor_user_id, name: d.actor_name }, reason: readable ? d.reason : null, restricted: !readable, createdAt: iso(d.created_at) })),
      registeredBy: { id: e.registered_by, name: e.registered_by_name },
      registeredAt: iso(e.registered_at),
      rowVersion: e.row_version,
      etag: formatEtag(e.id, e.row_version),
      actions: { acceptExtras: canAccept && readable && e.status === 'disputed' && e.check_detail.extrasOnly === true },
    };
  });
};

const incidentView = (i: IIncidentRow, mailReadable: boolean) => ({
  id: i.id,
  releaseId: i.release_id,
  kind: i.incident_kind,
  occurredAt: iso(i.occurred_at),
  // Описание нарушения с письмом-основанием может пересказывать письмо: закрыто вместе с ним (R13-02).
  description: mailReadable ? i.description : null,
  restricted: !mailReadable,
  evidence: {
    mail: i.mail_message_revision_id ? (mailReadable ? { restricted: false, messageId: i.mail_message_id, revisionId: i.mail_message_revision_id } : { restricted: true, messageId: null, revisionId: null }) : null,
    file: i.evidence_blob_sha256 ? { fileName: i.evidence_file_name, sha256: i.evidence_blob_sha256 } : null,
  },
  registeredBy: { id: i.registered_by, name: i.registered_by_name },
  registeredAt: iso(i.registered_at),
});

const releaseSends = async (db: Queryable, ctx: IAccessContext, r: IReleaseRow) => {
  const events = await listSendEvents(db, r.id);
  const incidents = await listIncidents(db, r.id);
  const readiness = await releaseSendReadiness(db, r);
  const heads = await revisionHeads(db, ctx, incidents.map((i) => i.mail_message_revision_id).filter((x): x is string => !!x));
  const canRegister = hasTenderCap(ctx, r.tender_id, 'send.register');
  const blockedBy = r.mode === 'test' ? 'release_is_test' : readiness.state === 'ready' ? null : readiness.state;
  const mailhub = (await db.query<{ status: string }>("SELECT status FROM integration_status WHERE system = 'mailhub' AND component = 'MailHubSentReader'")).rows[0];
  return {
    items: await sendViews(db, ctx, r, events),
    incidents: incidents.map((i) => incidentView(i, !i.mail_message_revision_id || heads.has(i.mail_message_revision_id))),
    summary: {
      // «Не зарегистрирована» — нет данных об отправке; это не утверждение «не отправлено» (A33).
      state: stateOf(events),
      events: events.length,
      counted: events.filter((e) => sendCounted(e.status)).length,
      disputed: events.filter((e) => e.status === 'disputed').length,
      incidents: incidents.length,
      testRelease: r.mode === 'test',
      readiness: { state: readiness.state, events: readiness.events },
      // Запись фиксирует отправку; получение и согласие заказчика ею не подтверждаются (A46, I08).
      provesReceipt: false,
    },
    warnings: r.mode === 'production' ? await placementWarnings(db, r) : [],
    mailhub: { status: mailhub?.status ?? 'BLOCKED_EXTERNAL', note: 'автоматического чтения отправленных писем нет (X-03): отправленное письмо импортируется EML в ящик портала' },
    can: { register: canRegister && blockedBy === null, registerBlockedBy: blockedBy, registerIncident: canRegister, acceptExtras: hasTenderCap(ctx, r.tender_id, 'send.accept_extras') },
  };
};

// ---------------------------------------------------------------- Загрузка

const visibleRelease = async (db: Queryable, ctx: IAccessContext, id: string) => loadVisibleRelease(db, ctx, await getRelease(db, id), id);

const releaseFor = async (db: Queryable, ctx: IAccessContext, id: string, cap: 'send.register' | null): Promise<IReleaseRow> => {
  const { release } = await visibleRelease(db, ctx, id);
  if (cap && !hasTenderCap(ctx, release.tender_id, cap)) throw forbidden(cap, target(release));
  return release;
};

// Письмо-основание: читается регистрирующим (иначе 404 — существование не раскрывается), связано с тендером выпуска.
const mailEvidenceOf = async (db: Queryable, ctx: IAccessContext, r: IReleaseRow, revisionId: string): Promise<ISendMailEvidence> => {
  const m = await sendMailEvidence(db, revisionId, r.tender_id);
  if (!m || !readableMailboxIds(ctx).includes(m.mailbox_id)) throw notFound({ entityType: 'mail_message_revision', entityId: revisionId, tenderId: r.tender_id });
  if (!m.linked) throw conflict('письмо не связано с тендером выпуска', 'mail_not_linked', target(r));
  return m;
};

const uploadOf = async (db: Queryable, ctx: IAccessContext, r: IReleaseRow, uploadId: string) => {
  const u = await getEvidenceUpload(db, uploadId);
  if (!u || u.release_id !== r.id || u.uploaded_by !== ctx.principal.userId) throw notFound({ entityType: 'send_evidence_upload', entityId: uploadId, tenderId: r.tender_id });
  return u;
};

const sendResult = async (db: Queryable, ctx: IAccessContext, r: IReleaseRow, id: string, status: number, audit: { action: string; details: Record<string, unknown> }) => {
  const e = (await getSendEvent(db, id))!;
  const all = await sendViews(db, ctx, r, await listSendEvents(db, r.id));
  return {
    status,
    body: all.find((x) => x.id === id)!,
    etag: formatEtag(e.id, e.row_version),
    audit: [{ action: audit.action, entityType: 'send_event', entityId: e.id, tenderId: r.tender_id, details: { releaseId: r.id, seq: e.seq, channel: e.channel, evidenceKind: e.evidence_kind, status: e.status, attachmentCheck: e.attachment_check, ...audit.details } }],
  };
};

const streamBlob = (store: BlobStore, res: import('express').Response, sha256: string, name: string, size: number | null): void => {
  // Файл-основание — произвольный файл пользователя: только скачивание, без исполнения и без угадывания типа (A38).
  res.setHeader('Content-Type', 'application/octet-stream');
  if (size !== null) res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', contentDisposition(false, name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', CONTENT_CSP);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-SHA256', sha256);
  const stream = store.openRead(sha256);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
};

export const sendsRouter = (pool: Pool, store: BlobStore, config: IAppConfig): Router => {
  const router = Router();

  // Выпуски тендера по этапам: стороны сравнения и сводка отправок. Закрытый комплект — без состава.
  router.get(
    '/tenders/:id/releases',
    query(pool, 'release.tender.list', 'tender', async (ctx, req, res) => {
      const tenderId = uuidParam(req, 'id', 'tender');
      if (!hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
      const rows = await listTenderReleases(pool, tenderId);
      const sums = await sendSummaries(pool, rows.map((r) => r.id));
      const items = [];
      for (const r of rows) {
        const visible = await candidateVisible(pool, ctx, (await getCandidate(pool, r.candidate_id))!);
        const s = sums.get(r.id)!;
        items.push({
          id: r.id,
          candidateSeq: r.candidate_seq,
          stage: { id: r.stage_id, seq: r.stage_seq, title: r.stage_title },
          mode: r.mode,
          releasedAt: iso(r.released_at),
          releasedBy: r.released_by_name,
          restricted: !visible,
          manifestSha256: visible ? r.release_manifest_sha256 : null,
          send: { events: s.events, counted: s.counted, disputed: s.disputed, incidents: s.incidents, firstCountedAt: iso(s.firstCountedAt) },
        });
      }
      res.json({ items, canCompare: hasTenderCap(ctx, tenderId, 'economics.compare') });
    }),
  );

  router.get(
    '/releases/:id/send-events',
    query(pool, 'send.list', 'release', async (ctx, req, res) => {
      const r = await releaseFor(pool, ctx, uuidParam(req, 'id', 'release'), null);
      res.json(await releaseSends(pool, ctx, r));
    }),
  );

  // Кандидаты в основание: отправленные письма тендера, которые читает пользователь, со сверкой вложений. Ничего не
  // записывают; отсутствие писем не означает, что комплект не отправлен (A33).
  router.get(
    '/releases/:id/send-candidates',
    query(pool, 'send.candidates', 'release', async (ctx, req, res) => {
      const r = await releaseFor(pool, ctx, uuidParam(req, 'id', 'release'), 'send.register');
      const kit = await sendKitFiles(pool, r.id);
      const items = [];
      for (const m of await sendCandidateMessages(pool, ctx, r.tender_id)) {
        const files = await classifyRevisionAttachments(pool, r.id, m.revision_id);
        const match = summarizeSendMatch(kit, files);
        const others = [...new Set(files.filter((f) => f.class === 'other_release').map((f) => f.otherReleaseId!))];
        const seqs = others.length ? (await pool.query<{ seq: number }>('SELECT c.seq FROM release o JOIN release_candidate c ON c.id = o.candidate_id WHERE o.id = ANY($1::uuid[]) ORDER BY c.seq', [others])).rows.map((x) => Number(x.seq)) : [];
        items.push({
          messageId: m.message_id,
          revisionId: m.revision_id,
          mailboxName: m.mailbox_name,
          folder: m.folder,
          subject: m.subject,
          from: m.from_address,
          recipients: recipientsOf(m.participants),
          sentAt: iso(m.sent_at),
          attachments: m.attachments,
          check: match.check,
          missing: match.missing.length,
          extras: match.extras,
          extrasOnly: match.extrasOnly,
          otherReleaseSeqs: seqs,
          registeredSendEventId: await sendEventOfLetter(pool, r.id, m.communication_id, m.raw_blob_sha256),
          sentBeforeRelease: !!m.sent_at && m.sent_at.getTime() < Math.floor(r.released_at.getTime() / 60_000) * 60_000,
        });
      }
      res.json({ items, kitFiles: kit.length, note: 'Отсутствие письма в списке не доказывает, что комплект не отправлен: зарегистрируйте отправку по файлу или пояснению.' });
    }),
  );

  // ---------------------------------------------------------------- Файл-основание

  const uploadAuthorize = async (req: Request): Promise<void> => void (await releaseFor(pool, requireCtx(req), uuidParam(req, 'id', 'release'), 'send.register'));

  router.post(
    '/releases/:id/send-evidence',
    receiveUpload({ pool, store, config, action: 'send.evidence.upload', entityType: 'release', authorize: uploadAuthorize }),
    command(pool, {
      action: 'send.evidence.upload',
      entityType: 'release',
      idempotent: true,
      requestKey: (req) => `send-evidence ${req.params.id} ${uploadedBlob(req)?.sha256 ?? ''} ${JSON.stringify(req.query)}`,
      authorize: async (client, ctx, req) => void (await releaseFor(client, ctx, uuidParam(req, 'id', 'release'), 'send.register')),
      run: async (client, ctx, req) => {
        const r = await releaseFor(client, ctx, uuidParam(req, 'id', 'release'), 'send.register');
        const stored = uploadedBlob(req);
        if (!stored) throw new HttpError(400, 'VALIDATION_FAILED', 'файл не получен');
        if (stored.sizeBytes === 0) throw new HttpError(400, 'VALIDATION_FAILED', 'файл пустой');
        const name = uploadName(req);
        await insertBlob(client, { sha256: stored.sha256, sizeBytes: stored.sizeBytes, mediaType: 'application/octet-stream', storageKey: stored.storageKey });
        const id = await insertEvidenceUpload(client, { releaseId: r.id, tenderId: r.tender_id, blobSha256: stored.sha256, fileName: name, sizeBytes: stored.sizeBytes, userId: ctx.principal.userId });
        return {
          status: 201,
          body: { uploadId: id, fileName: name, sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
          // Имя файла в журнал не пишется: журнал читают шире, чем основание.
          audit: [{ action: 'send.evidence.upload', entityType: 'send_evidence_upload', entityId: id, tenderId: r.tender_id, details: { releaseId: r.id, sha256: stored.sha256, sizeBytes: stored.sizeBytes } }],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Регистрация отправки

  router.post(
    '/releases/:id/send-events',
    command(pool, {
      action: 'send.register',
      entityType: 'release',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await releaseFor(client, ctx, uuidParam(req, 'id', 'release'), 'send.register')),
      // Повторная отправка после новых событий этапа (проект §6): недостающие удержания создаются отдельной транзакцией —
      // они остаются, даже если сама регистрация получит отказ, и руководитель решает по ним как обычно.
      prepare: async (client, ctx, req) => {
        const r = await releaseFor(client, ctx, uuidParam(req, 'id', 'release'), 'send.register');
        if (r.mode !== 'production') return;
        // Повтор уже зарегистрированного письма удержаний не создаёт: это не новая отправка.
        const body = RegisterSendRequest.safeParse(req.body ?? {});
        if (body.success && body.data.evidence.kind === 'mail_message') {
          const m = await sendMailEvidence(client, body.data.evidence.mailMessageRevisionId.toLowerCase(), r.tender_id);
          if (m && (await sendEventOfLetter(client, r.id, m.communication_id, m.raw_blob_sha256))) return;
        }
        await lockTenderStages(client, r.tender_id, [r.stage_id]);
        await ensureReleaseHolds(client, r.candidate_id);
      },
      run: async (client, ctx, req) => {
        const head = await releaseFor(client, ctx, uuidParam(req, 'id', 'release'), 'send.register');
        await lockTenderStages(client, head.tender_id, [head.stage_id]);
        const r = (await getRelease(client, head.id))!;
        if (r.mode !== 'production') {
          throw conflict('тестовый выпуск не регистрируется как отправка; если комплект ушёл заказчику — зарегистрируйте нарушение', 'RELEASE_IS_TEST', target(r));
        }
        const body = parseBody(RegisterSendRequest, req.body);
        const key = req.header('idempotency-key')!;
        const now = new Date();
        let sentAt: Date;
        let evidence: Parameters<typeof registerSendEvent>[1]['evidence'];
        const mail = body.evidence.kind === 'mail_message' ? await mailEvidenceOf(client, ctx, r, body.evidence.mailMessageRevisionId.toLowerCase()) : null;
        if (mail) {
          const existing = await sendEventOfLetter(client, r.id, mail.communication_id, mail.raw_blob_sha256);
          // Одно письмо — одна отправка, в скольких бы папках и ящиках оно ни лежало (A34).
          if (existing) throw conflict('это письмо уже зарегистрировано как отправка выпуска', 'evidence_already_registered', target(r), { sendEventId: existing });
        }
        const readiness = await releaseSendReadiness(client, r);
        if (readiness.state !== 'ready') {
          throw conflict('выпуск не готов к отправке: сначала решение руководителя по событиям или проверка канала поступления', 'not_ready', target(r), { state: readiness.state, events: readiness.events });
        }
        if (mail) {
          const m = mail;
          if (m.direction !== 'outbound') throw conflict('основание — отправленное письмо (направление «исходящее»)', 'mail_not_outbound', target(r));
          if (!m.latest) throw conflict('у письма есть более новая ревизия: выберите её', 'mail_revision_outdated', target(r));
          if (!m.sent_at) throw conflict('в письме нет времени отправки: зарегистрируйте отправку по файлу или пояснению', 'mail_date_missing', target(r));
          sentAt = m.sent_at;
          evidence = { kind: 'mail_message', mail: m };
        } else {
          sentAt = new Date(body.sentAt!);
          evidence = body.evidence.kind === 'uploaded_file' ? { kind: 'uploaded_file', upload: await uploadOf(client, ctx, r, body.evidence.uploadId.toLowerCase()) } : { kind: 'manual_note' };
        }
        // Время ручной регистрации вводится с точностью до минуты: сравнение — с минутой выпуска (то же в охраннике БД).
        if (sentAt.getTime() < Math.floor(r.released_at.getTime() / 60_000) * 60_000) throw conflict('время отправки раньше выпуска: этот выпуск тогда отправить было нельзя', 'sent_before_release', target(r));
        if (sentAt.getTime() > now.getTime() + 24 * 3600 * 1000) throw conflict('время отправки в будущем', 'sent_in_future', target(r));
        const warnings = await placementWarnings(client, r);
        const done = await registerSendEvent(client, {
          release: r,
          userId: ctx.principal.userId,
          idempotencyKey: key,
          channel: body.evidence.kind === 'mail_message' ? 'email' : body.channel!,
          sentAt,
          recipients: body.recipients,
          note: body.note ?? null,
          evidence,
        });
        // Содержимое письма (тема, адреса, имена вложений) в журнал не пишется: журнал видят и те, кто письма не читает.
        return sendResult(client, ctx, r, done.id, 201, { action: 'send.register', details: { repeat: done.repeat, warnings, missing: done.match?.missing.length ?? null, extras: done.match?.extras ?? null } });
      },
    }),
  );

  const loadSend = async (db: Queryable, ctx: IAccessContext, id: string): Promise<{ send: ISendEventRow; release: IReleaseRow }> => {
    const s = await getSendEvent(db, id);
    if (!s) throw notFound({ entityType: 'send_event', entityId: id });
    const { release } = await visibleRelease(db, ctx, s.release_id).catch((err: unknown) => {
      if (err instanceof HttpError && err.status === 404) throw notFound({ entityType: 'send_event', entityId: id });
      throw err;
    });
    return { send: s, release };
  };

  // Лишние вложения не относятся к комплекту (D-035 В-15-1): руководитель тендера, с причиной; письмо он должен читать сам.
  router.post(
    '/send-events/:id/accept-extras',
    command(pool, {
      action: 'send.accept_extras',
      entityType: 'send_event',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const { release } = await loadSend(client, ctx, uuidParam(req, 'id', 'send_event'));
        if (!hasTenderCap(ctx, release.tender_id, 'send.accept_extras')) throw forbidden('send.accept_extras', { tenderId: release.tender_id, entityType: 'send_event', entityId: req.params.id as string });
      },
      run: async (client: PoolClient, ctx, req) => {
        const head = await loadSend(client, ctx, uuidParam(req, 'id', 'send_event'));
        const t = { tenderId: head.release.tender_id, entityType: 'send_event', entityId: head.send.id };
        await lockTenderStages(client, head.release.tender_id, [head.release.stage_id]);
        const s = (await getSendEvent(client, head.send.id, true))!;
        if (requireIfMatch(req, s.id) !== s.row_version) throw versionConflict({ id: s.id, status: s.status, etag: formatEtag(s.id, s.row_version) });
        const body = parseBody(AcceptSendExtrasRequest, req.body);
        if (s.status !== 'disputed') throw conflict('принять лишние вложения можно только у отправки «состав не совпал»', 'not_disputed', t);
        // Нельзя решать по тому, чего не можешь прочитать (как R08-02): письмо-основание — в читаемом ящике.
        if (!(await revisionHeads(client, ctx, [s.mail_message_revision_id!])).has(s.mail_message_revision_id!)) throw conflict('письмо-основание закрыто для вас', 'restricted_mail', t);
        if (s.check_detail.extrasOnly !== true) {
          throw conflict('так снимаются только лишние вложения: отсутствующий, внутренний или файл другого комплекта — это расхождение состава', 'not_extras_only', t);
        }
        await acceptSendExtras(client, s.id, ctx.principal.userId, body.reason);
        // Причина — в записи решения (закрыта вместе с письмом); в журнал не копируется (R13-02).
        return sendResult(client, ctx, head.release, s.id, 200, { action: 'send.accept_extras', details: { extras: s.check_detail.extras ?? null } });
      },
    }),
  );

  // Файл-основание отправки: тот, кто видит выпуск (те же проверки, что у скачивания файлов выпуска).
  router.get(
    '/send-events/:id/evidence',
    query(pool, 'send.evidence.read', 'send_event', async (ctx, req, res) => {
      const { send } = await loadSend(pool, ctx, uuidParam(req, 'id', 'send_event'));
      if (send.evidence_kind !== 'uploaded_file' || !send.evidence_blob_sha256) throw notFound({ entityType: 'send_event', entityId: send.id });
      const upload = send.evidence_upload_id ? await getEvidenceUpload(pool, send.evidence_upload_id) : null;
      streamBlob(store, res, send.evidence_blob_sha256, send.evidence_file_name ?? 'основание', upload?.size_bytes ?? null);
    }),
  );

  // ---------------------------------------------------------------- Нарушение

  // Недопустимая отправка вне системы (тестовый или не готовый к отправке комплект ушёл заказчику): не отправка,
  // выпуск не подтверждает, режим и готовность не меняет (RT-05).
  router.post(
    '/releases/:id/compliance-incidents',
    command(pool, {
      action: 'send.incident.register',
      entityType: 'release',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await releaseFor(client, ctx, uuidParam(req, 'id', 'release'), 'send.register')),
      run: async (client, ctx, req) => {
        const r = await releaseFor(client, ctx, uuidParam(req, 'id', 'release'), 'send.register');
        await lockTenderStages(client, r.tender_id, [r.stage_id]);
        const body = parseBody(RegisterIncidentRequest, req.body);
        if ((body.kind === 'test_release_sent_externally') !== (r.mode === 'test') && body.kind !== 'other') {
          throw conflict(r.mode === 'test' ? 'у тестового выпуска — «тестовый комплект ушёл заказчику» или «другое»' : 'у боевого выпуска — «отправлен несмотря на блокер» или «другое»', 'incident_kind_mismatch', target(r));
        }
        if (body.kind === 'sent_despite_blocker' && (await releaseSendReadiness(client, r)).state === 'ready') {
          throw conflict('выпуск готов к отправке: это обычная отправка, а не нарушение', 'release_ready', target(r));
        }
        const occurredAt = new Date(body.occurredAt);
        if (occurredAt.getTime() > Date.now() + 24 * 3600 * 1000) throw conflict('время нарушения в будущем', 'occurred_in_future', target(r));
        const mail = body.mailMessageRevisionId ? await mailEvidenceOf(client, ctx, r, body.mailMessageRevisionId.toLowerCase()) : null;
        const upload = body.uploadId ? await uploadOf(client, ctx, r, body.uploadId.toLowerCase()) : null;
        const id = await insertIncident(client, { release: r, userId: ctx.principal.userId, idempotencyKey: req.header('idempotency-key')!, kind: body.kind, occurredAt, description: body.description, mail, upload });
        return {
          status: 201,
          body: incidentView((await getIncident(client, id))!, true),
          audit: [{ action: 'send.incident.register', entityType: 'compliance_incident', entityId: id, tenderId: r.tender_id, details: { releaseId: r.id, mode: r.mode, kind: body.kind, evidence: mail ? 'mail_message' : upload ? 'uploaded_file' : 'none' } }],
        };
      },
    }),
  );

  router.get(
    '/compliance-incidents/:id/evidence',
    query(pool, 'send.incident.evidence', 'compliance_incident', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'compliance_incident');
      const i = await getIncident(pool, id);
      if (!i) throw notFound({ entityType: 'compliance_incident', entityId: id });
      await visibleRelease(pool, ctx, i.release_id).catch((err: unknown) => {
        if (err instanceof HttpError && err.status === 404) throw notFound({ entityType: 'compliance_incident', entityId: id });
        throw err;
      });
      if (!i.evidence_blob_sha256) throw notFound({ entityType: 'compliance_incident', entityId: id });
      const upload = i.evidence_upload_id ? await getEvidenceUpload(pool, i.evidence_upload_id) : null;
      streamBlob(store, res, i.evidence_blob_sha256, i.evidence_file_name ?? 'основание', upload?.size_bytes ?? null);
    }),
  );

  return router;
};
