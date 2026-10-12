// Отправка выпуска и нарушения (этап 15; D-035; state-machines §17; проект docs/architecture/15-send-comparison-design.md
// §2–§7): регистрация с основанием (письмо из почты портала, собственный файл, пояснение), сверка точных вложений письма
// с комплектом для заказчика, принятие лишних вложений руководителем, учёт недопустимой отправки вне системы. Класс
// вложения считает БД (`send_file_class`), итог — ядро; вторая линия — охранники миграции 0039. Команды вызываются под
// блокировкой этапа.
import {
  sendCounted,
  sendKitSha256,
  sendStatusOf,
  summarizeSendMatch,
  type AttachmentCheck,
  type IClassifiedAttachment,
  type IKitFile,
  type ISendMatch,
  type SendChannel,
  type SendEvidenceKind,
  type SendStatus,
} from '@kontur/core';
import { readableMailboxIds, type IAccessContext } from './access.ts';
import type { IReleaseRow } from './approvals.ts';
import type { Queryable } from './pool.ts';

export interface ISendEventRow {
  id: string;
  release_id: string;
  tender_id: string;
  stage_id: string;
  seq: number;
  channel: SendChannel;
  sent_at: Date;
  recipients: string[];
  evidence_kind: SendEvidenceKind;
  mail_message_revision_id: string | null;
  mail_message_id: string | null;
  mail_communication_id: string | null;
  mail_raw_sha256: string | null;
  evidence_upload_id: string | null;
  evidence_blob_sha256: string | null;
  evidence_file_name: string | null;
  note: string | null;
  attachment_check: AttachmentCheck;
  check_detail: Record<string, unknown>;
  kit_sha256: string;
  release_manifest_sha256: string;
  status: SendStatus;
  extras_accepted: boolean;
  registered_by: string;
  registered_by_name: string;
  registered_at: Date;
  row_version: number;
}

export interface ISendFileRow {
  send_event_id: string;
  ordinal: number;
  sha256: string;
  size_bytes: number;
  class: IClassifiedAttachment['class'];
  kit_path: string | null;
  other_release_id: string | null;
  other_release_seq: number | null;
  mail_attachment_id: string;
  inline: boolean;
}

export interface ISendDecisionRow {
  id: string;
  send_event_id: string;
  action: 'accept_extras';
  actor_user_id: string;
  actor_name: string;
  reason: string;
  created_at: Date;
}

export interface IIncidentRow {
  id: string;
  release_id: string;
  tender_id: string;
  stage_id: string;
  incident_kind: 'test_release_sent_externally' | 'sent_despite_blocker' | 'other';
  occurred_at: Date;
  description: string;
  mail_message_revision_id: string | null;
  mail_message_id: string | null;
  evidence_upload_id: string | null;
  evidence_blob_sha256: string | null;
  evidence_file_name: string | null;
  registered_by: string;
  registered_by_name: string;
  registered_at: Date;
}

export interface IEvidenceUploadRow {
  id: string;
  release_id: string;
  tender_id: string;
  blob_sha256: string;
  file_name: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: Date;
}

// ---------------------------------------------------------------- Чтение

const SEND_SELECT = `SELECT s.*, u.display_name AS registered_by_name FROM send_event s JOIN app_user u ON u.id = s.registered_by`;

const sendOf = (r: ISendEventRow): ISendEventRow => ({ ...r, seq: Number(r.seq), row_version: Number(r.row_version) });

export const getSendEvent = async (db: Queryable, id: string, lock = false): Promise<ISendEventRow | null> => {
  const r = (await db.query<ISendEventRow>(`${SEND_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id])).rows[0];
  return r ? sendOf(r) : null;
};

export const listSendEvents = async (db: Queryable, releaseId: string): Promise<ISendEventRow[]> =>
  (await db.query<ISendEventRow>(`${SEND_SELECT} WHERE s.release_id = $1 ORDER BY s.seq`, [releaseId])).rows.map(sendOf);

export const sendEventFiles = async (db: Queryable, sendEventIds: readonly string[]): Promise<Map<string, ISendFileRow[]>> => {
  const out = new Map<string, ISendFileRow[]>(sendEventIds.map((id) => [id, []]));
  if (sendEventIds.length === 0) return out;
  const r = await db.query<ISendFileRow>(
    `SELECT f.*, c.seq AS other_release_seq FROM send_event_file f
       LEFT JOIN release o ON o.id = f.other_release_id LEFT JOIN release_candidate c ON c.id = o.candidate_id
      WHERE f.send_event_id = ANY($1::uuid[]) ORDER BY f.send_event_id, f.ordinal`,
    [[...sendEventIds]],
  );
  for (const f of r.rows) out.get(f.send_event_id)!.push({ ...f, size_bytes: Number(f.size_bytes), other_release_seq: f.other_release_seq === null ? null : Number(f.other_release_seq) });
  return out;
};

export const sendEventDecisions = async (db: Queryable, sendEventIds: readonly string[]): Promise<Map<string, ISendDecisionRow[]>> => {
  const out = new Map<string, ISendDecisionRow[]>(sendEventIds.map((id) => [id, []]));
  if (sendEventIds.length === 0) return out;
  const r = await db.query<ISendDecisionRow>(
    `SELECT d.id, d.send_event_id, d.action, d.actor_user_id, u.display_name AS actor_name, d.reason, d.created_at
       FROM send_event_decision d JOIN app_user u ON u.id = d.actor_user_id
      WHERE d.send_event_id = ANY($1::uuid[]) ORDER BY d.created_at, d.id`,
    [[...sendEventIds]],
  );
  for (const d of r.rows) out.get(d.send_event_id)!.push(d);
  return out;
};

const INCIDENT_SELECT = `SELECT i.*, u.display_name AS registered_by_name FROM compliance_incident i JOIN app_user u ON u.id = i.registered_by`;

export const listIncidents = async (db: Queryable, releaseId: string): Promise<IIncidentRow[]> =>
  (await db.query<IIncidentRow>(`${INCIDENT_SELECT} WHERE i.release_id = $1 ORDER BY i.registered_at, i.id`, [releaseId])).rows;

export const getIncident = async (db: Queryable, id: string): Promise<IIncidentRow | null> =>
  (await db.query<IIncidentRow>(`${INCIDENT_SELECT} WHERE i.id = $1`, [id])).rows[0] ?? null;

// Сводка отправок по выпускам: число записей и засчитанных (для карточек выпуска и списка выпусков тендера).
export const sendSummaries = async (db: Queryable, releaseIds: readonly string[]): Promise<Map<string, { events: number; counted: number; disputed: number; incidents: number; firstCountedAt: Date | null }>> => {
  const out = new Map(releaseIds.map((id) => [id, { events: 0, counted: 0, disputed: 0, incidents: 0, firstCountedAt: null as Date | null }]));
  if (releaseIds.length === 0) return out;
  const s = await db.query<{ release_id: string; status: SendStatus; n: number; first_at: Date }>(
    'SELECT release_id, status, count(*)::int AS n, min(sent_at) AS first_at FROM send_event WHERE release_id = ANY($1::uuid[]) GROUP BY release_id, status',
    [[...releaseIds]],
  );
  for (const x of s.rows) {
    const o = out.get(x.release_id)!;
    o.events += x.n;
    if (sendCounted(x.status)) {
      o.counted += x.n;
      if (!o.firstCountedAt || x.first_at < o.firstCountedAt) o.firstCountedAt = x.first_at;
    } else o.disputed += x.n;
  }
  const i = await db.query<{ release_id: string; n: number }>('SELECT release_id, count(*)::int AS n FROM compliance_incident WHERE release_id = ANY($1::uuid[]) GROUP BY release_id', [[...releaseIds]]);
  for (const x of i.rows) out.get(x.release_id)!.incidents = x.n;
  return out;
};

// ---------------------------------------------------------------- Сверка

export const sendKitFiles = async (db: Queryable, releaseId: string): Promise<IKitFile[]> =>
  (await db.query<{ path: string; sha256: string; size_bytes: number }>('SELECT path, sha256, size_bytes FROM send_kit_files($1) ORDER BY path', [releaseId])).rows.map((f) => ({
    path: f.path,
    sha256: f.sha256,
    size: Number(f.size_bytes),
  }));

export interface IClassifiedMailAttachment extends IClassifiedAttachment {
  mailAttachmentId: string;
}

// Вложения ревизии письма с классом относительно выпуска: одна реализация класса — SQL-функция второй линии.
export const classifyRevisionAttachments = async (db: Queryable, releaseId: string, revisionId: string): Promise<IClassifiedMailAttachment[]> =>
  (
    await db.query<{ id: string; ordinal: number; sha256: string; size_bytes: number; inline: boolean; class: IClassifiedAttachment['class']; kit_path: string | null; other_release_id: string | null }>(
      `SELECT a.id, a.ordinal, a.sha256, a.size_bytes, (a.disposition = 'inline') AS inline, c.class, c.kit_path, c.other_release_id
         FROM mail_attachment a, LATERAL send_file_class($1, a.sha256) c
        WHERE a.revision_id = $2 ORDER BY a.ordinal`,
      [releaseId, revisionId],
    )
  ).rows.map((a) => ({
    mailAttachmentId: a.id,
    ordinal: Number(a.ordinal),
    sha256: a.sha256,
    size: Number(a.size_bytes),
    inline: a.inline,
    class: a.class,
    kitPath: a.kit_path,
    otherReleaseId: a.other_release_id,
  }));

export const checkDetailOf = (kit: readonly IKitFile[], m: ISendMatch): Record<string, unknown> => ({
  kitFiles: kit.length,
  missing: m.missing.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
  extras: m.extras,
  extrasOnly: m.extrasOnly,
});

// ---------------------------------------------------------------- Кандидаты в основание (проект §5.2)

export interface ISendCandidateRow {
  message_id: string;
  mailbox_id: string;
  mailbox_name: string;
  communication_id: string;
  revision_id: string;
  raw_blob_sha256: string;
  subject: string | null;
  sent_at: Date | null;
  from_address: string | null;
  participants: { role: string; address: string; name: string | null }[];
  folder: string | null;
  attachments: number;
}

// Отправленные письма, связанные с тендером, в ящиках, которые пользователь читает (последняя ревизия письма).
// Письмо без mail.read не показывается и не считается (OD-07-3).
export const sendCandidateMessages = async (db: Queryable, ctx: IAccessContext, tenderId: string, limit = 100): Promise<ISendCandidateRow[]> =>
  (
    await db.query<ISendCandidateRow>(
      `SELECT m.id AS message_id, m.mailbox_id, b.display_name AS mailbox_name, m.communication_id, lr.id AS revision_id, lr.raw_blob_sha256,
              lr.subject, lr.sent_at, lr.from_address, lr.participants, lr.folder,
              (SELECT count(*)::int FROM mail_attachment a WHERE a.revision_id = lr.id) AS attachments
         FROM mail_message_tender l
         JOIN mail_message m ON m.id = l.message_id
         JOIN mailbox b ON b.id = m.mailbox_id
         JOIN LATERAL (SELECT r.* FROM mail_message_revision r WHERE r.message_id = m.id ORDER BY r.seq DESC LIMIT 1) lr ON true
        WHERE l.tender_id = $1 AND l.status = 'linked' AND m.mailbox_id = ANY($2::uuid[]) AND lr.direction = 'outbound'
        ORDER BY lr.sent_at DESC NULLS LAST, m.created_at DESC, m.id LIMIT $3`,
      [tenderId, readableMailboxIds(ctx), limit],
    )
  ).rows;

export interface ISendMailEvidence {
  revision_id: string;
  message_id: string;
  mailbox_id: string;
  communication_id: string;
  raw_blob_sha256: string;
  sent_at: Date | null;
  direction: string;
  latest: boolean;
  linked: boolean;
}

// Ревизия письма как основание: связь с тендером, направление и актуальность ревизии. Права на ящик проверяет вызывающий.
export const sendMailEvidence = async (db: Queryable, revisionId: string, tenderId: string): Promise<ISendMailEvidence | null> =>
  (
    await db.query<ISendMailEvidence>(
      `SELECT r.id AS revision_id, m.id AS message_id, m.mailbox_id, m.communication_id, r.raw_blob_sha256, r.sent_at, r.direction,
              NOT EXISTS (SELECT 1 FROM mail_message_revision n WHERE n.message_id = m.id AND n.seq > r.seq) AS latest,
              EXISTS (SELECT 1 FROM mail_message_tender l WHERE l.message_id = m.id AND l.tender_id = $2 AND l.status = 'linked') AS linked
         FROM mail_message_revision r JOIN mail_message m ON m.id = r.message_id WHERE r.id = $1`,
      [revisionId, tenderId],
    )
  ).rows[0] ?? null;

// Отправка выпуска по тому же письму (той же коммуникации или тем же байтам): одно письмо — одна отправка (A34).
export const sendEventOfLetter = async (db: Queryable, releaseId: string, communicationId: string, rawSha256: string): Promise<string | null> =>
  (await db.query<{ id: string }>('SELECT id FROM send_event WHERE release_id = $1 AND (mail_communication_id = $2 OR mail_raw_sha256 = $3) ORDER BY seq LIMIT 1', [releaseId, communicationId, rawSha256])).rows[0]?.id ?? null;

// Копии письма-основания (та же коммуникация) в ящиках, которые пользователь читает: происхождения одной отправки.
export const communicationCopies = async (
  db: Queryable,
  ctx: IAccessContext,
  communicationIds: readonly string[],
): Promise<Map<string, { messageId: string; mailboxId: string; mailboxName: string; folder: string | null }[]>> => {
  const out = new Map<string, { messageId: string; mailboxId: string; mailboxName: string; folder: string | null }[]>();
  if (communicationIds.length === 0) return out;
  const r = await db.query<{ communication_id: string; id: string; mailbox_id: string; mailbox_name: string; folder: string | null }>(
    `SELECT m.communication_id, m.id, m.mailbox_id, b.display_name AS mailbox_name, lr.folder
       FROM mail_message m JOIN mailbox b ON b.id = m.mailbox_id
       JOIN LATERAL (SELECT r.folder FROM mail_message_revision r WHERE r.message_id = m.id ORDER BY r.seq DESC LIMIT 1) lr ON true
      WHERE m.communication_id = ANY($1::uuid[]) AND m.mailbox_id = ANY($2::uuid[])
      ORDER BY b.display_name, m.id`,
    [[...communicationIds], readableMailboxIds(ctx)],
  );
  for (const x of r.rows) out.set(x.communication_id, [...(out.get(x.communication_id) ?? []), { messageId: x.id, mailboxId: x.mailbox_id, mailboxName: x.mailbox_name, folder: x.folder }]);
  return out;
};

// ---------------------------------------------------------------- Файл-основание

export const insertEvidenceUpload = async (db: Queryable, u: { releaseId: string; tenderId: string; blobSha256: string; fileName: string; sizeBytes: number; userId: string }): Promise<string> =>
  (
    await db.query<{ id: string }>(
      'INSERT INTO send_evidence_upload (release_id, tender_id, blob_sha256, file_name, size_bytes, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [u.releaseId, u.tenderId, u.blobSha256, u.fileName, u.sizeBytes, u.userId],
    )
  ).rows[0]!.id;

export const getEvidenceUpload = async (db: Queryable, id: string): Promise<IEvidenceUploadRow | null> => {
  const r = (await db.query<IEvidenceUploadRow>('SELECT * FROM send_evidence_upload WHERE id = $1', [id])).rows[0];
  return r ? { ...r, size_bytes: Number(r.size_bytes) } : null;
};

// ---------------------------------------------------------------- Команды (вызывающий держит блокировку этапа)

// Недостающие удержания выпущенного кандидата (повторная отправка после новых событий, проект §6).
export const ensureReleaseHolds = async (db: Queryable, candidateId: string): Promise<number> =>
  Number((await db.query<{ n: number }>('SELECT ensure_release_holds($1) AS n', [candidateId])).rows[0]!.n);

export type SendEvidenceInput =
  | { kind: 'mail_message'; mail: ISendMailEvidence }
  | { kind: 'uploaded_file'; upload: IEvidenceUploadRow }
  | { kind: 'manual_note' };

export interface IRegisterSendInput {
  release: IReleaseRow;
  userId: string;
  idempotencyKey: string;
  channel: SendChannel;
  // У письма-основания — время из ревизии письма.
  sentAt: Date;
  recipients: string[];
  note: string | null;
  evidence: SendEvidenceInput;
}

export interface IRegisteredSend {
  id: string;
  status: SendStatus;
  attachmentCheck: AttachmentCheck;
  match: ISendMatch | null;
  // До этой записи у выпуска уже была засчитанная отправка: повторная.
  repeat: boolean;
}

export const registerSendEvent = async (db: Queryable, i: IRegisterSendInput): Promise<IRegisteredSend> => {
  const kit = await sendKitFiles(db, i.release.id);
  const mail = i.evidence.kind === 'mail_message' ? i.evidence.mail : null;
  const files = mail ? await classifyRevisionAttachments(db, i.release.id, mail.revision_id) : [];
  const match = mail ? summarizeSendMatch(kit, files) : null;
  const check: AttachmentCheck = match ? match.check : 'not_checked';
  const status = sendStatusOf(check);
  const repeat = (await db.query('SELECT 1 FROM send_event WHERE release_id = $1 AND status IN (\'registered\', \'verified\') LIMIT 1', [i.release.id])).rowCount! > 0;
  const upload = i.evidence.kind === 'uploaded_file' ? i.evidence.upload : null;
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO send_event (release_id, tender_id, stage_id, seq, channel, sent_at, recipients, evidence_kind, mail_message_revision_id, mail_message_id,
                               mail_communication_id, mail_raw_sha256, evidence_upload_id, evidence_blob_sha256, evidence_file_name, note, attachment_check,
                               check_detail, kit_sha256, release_manifest_sha256, status, registered_by, idempotency_key)
       VALUES ($1, $2, $3, (SELECT coalesce(max(seq), 0) + 1 FROM send_event WHERE release_id = $1), $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17::jsonb, $18, $19, $20, $21, $22)
       RETURNING id`,
      [
        i.release.id, i.release.tender_id, i.release.stage_id, i.channel, i.sentAt, JSON.stringify(mail ? [] : i.recipients), i.evidence.kind,
        mail?.revision_id ?? null, mail?.message_id ?? null, mail?.communication_id ?? null, mail?.raw_blob_sha256 ?? null,
        upload?.id ?? null, upload?.blob_sha256 ?? null, upload?.file_name ?? null, mail ? null : i.note, check,
        JSON.stringify(match ? checkDetailOf(kit, match) : { kitFiles: kit.length }), sendKitSha256(kit), i.release.release_manifest_sha256, status, i.userId, i.idempotencyKey,
      ],
    )
  ).rows[0]!.id;
  if (files.length > 0) {
    await db.query(
      `INSERT INTO send_event_file (send_event_id, ordinal, sha256, size_bytes, class, kit_path, other_release_id, mail_attachment_id, inline)
       SELECT $1, x.ordinal, x.sha256, x.size_bytes, x.class, x.kit_path, x.other_release_id, x.mail_attachment_id, x.inline
         FROM jsonb_to_recordset($2::jsonb) AS x(ordinal int, sha256 text, size_bytes bigint, class text, kit_path text, other_release_id uuid, mail_attachment_id uuid, inline boolean)`,
      [
        id,
        JSON.stringify(files.map((f) => ({ ordinal: f.ordinal, sha256: f.sha256, size_bytes: f.size, class: f.class, kit_path: f.kitPath, other_release_id: f.otherReleaseId, mail_attachment_id: f.mailAttachmentId, inline: f.inline }))),
      ],
    );
  }
  return { id, status, attachmentCheck: check, match, repeat };
};

// «Состав не совпал» → «подтверждена, лишние вложения приняты»: решение руководителя и переход одной транзакцией.
export const acceptSendExtras = async (db: Queryable, sendEventId: string, userId: string, reason: string): Promise<void> => {
  await db.query("INSERT INTO send_event_decision (send_event_id, action, actor_user_id, reason) VALUES ($1, 'accept_extras', $2, $3)", [sendEventId, userId, reason]);
  await db.query("UPDATE send_event SET status = 'verified', extras_accepted = true, row_version = row_version + 1 WHERE id = $1 AND status = 'disputed'", [sendEventId]);
};

export interface IRegisterIncidentInput {
  release: IReleaseRow;
  userId: string;
  idempotencyKey: string;
  kind: IIncidentRow['incident_kind'];
  occurredAt: Date;
  description: string;
  mail: ISendMailEvidence | null;
  upload: IEvidenceUploadRow | null;
}

export const insertIncident = async (db: Queryable, i: IRegisterIncidentInput): Promise<string> =>
  (
    await db.query<{ id: string }>(
      `INSERT INTO compliance_incident (release_id, tender_id, stage_id, incident_kind, occurred_at, description, mail_message_revision_id, mail_message_id,
                                        evidence_upload_id, evidence_blob_sha256, evidence_file_name, registered_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        i.release.id, i.release.tender_id, i.release.stage_id, i.kind, i.occurredAt, i.description, i.mail?.revision_id ?? null, i.mail?.message_id ?? null,
        i.upload?.id ?? null, i.upload?.blob_sha256 ?? null, i.upload?.file_name ?? null, i.userId, i.idempotencyKey,
      ],
    )
  ).rows[0]!.id;

// Выпуски тендера по этапам (стороны сравнения и сводка отправок).
export interface ITenderReleaseRow {
  id: string;
  candidate_id: string;
  candidate_seq: number;
  tender_id: string;
  stage_id: string;
  stage_seq: number;
  stage_title: string;
  mode: 'test' | 'production';
  released_at: Date;
  released_by_name: string;
  release_manifest_sha256: string;
}

export const listTenderReleases = async (db: Queryable, tenderId: string): Promise<ITenderReleaseRow[]> =>
  (
    await db.query<ITenderReleaseRow>(
      `SELECT r.id, r.candidate_id, c.seq AS candidate_seq, r.tender_id, r.stage_id, s.seq AS stage_seq, s.title AS stage_title, r.mode, r.released_at,
              u.display_name AS released_by_name, r.release_manifest_sha256
         FROM release r JOIN release_candidate c ON c.id = r.candidate_id JOIN tender_stage s ON s.id = r.stage_id JOIN app_user u ON u.id = r.released_by
        WHERE r.tender_id = $1 ORDER BY r.released_at, r.id`,
      [tenderId],
    )
  ).rows.map((r) => ({ ...r, candidate_seq: Number(r.candidate_seq), stage_seq: Number(r.stage_seq) }));
