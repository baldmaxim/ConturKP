// Письма (этап 07, D-025): копия в одном ящике → неизменяемые ревизии → вложения-документы и фрагменты
// тела. Всё, что относится к одной ревизии, пишется одной транзакцией её создания (охранники 0017–0018
// не дают дописать состав позже). Чтение — только с mail.read на ящик письма; связь с тендером права
// не даёт, логическая коммуникация не открывает копии чужих ящиков.
import { nameKeyOf, sha256Hex } from '@kontur/core';
import { readableMailboxIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export interface IMailAttachmentInput {
  ordinal: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  disposition: 'attachment' | 'inline';
  contentId: string | null;
  // registered — байты сохранены (blob есть), вложение станет документом; rejected — только метаданные.
  status: 'registered' | 'rejected';
  rejectReason: 'type_not_allowed' | 'size_limit' | 'corrupt' | null;
}

export interface IMailRevisionInput {
  mailboxId: string;
  identity: { kind: 'source_id' | 'message_id' | 'raw_sha256'; value: string };
  groupKey: string | null;
  rawSha256: string;
  messageIdHeader: string | null;
  subject: string | null;
  sentAt: string | null;
  fromAddress: string | null;
  participants: { role: string; address: string; name: string | null }[];
  direction: 'inbound' | 'outbound' | 'unknown';
  folder: string | null;
  inReplyTo: string | null;
  references: string[];
  source: 'eml_import' | 'mailhub_api';
  sourceItemId: string | null;
  warnings: string[];
  blocks: { block: number; quoted: boolean; text: string }[];
  attachments: IMailAttachmentInput[];
  importedBy: string;
  maxFragmentChars: number;
}

export interface IMailPersistResult {
  messageId: string;
  revisionId: string;
  created: boolean;
  // Редакции документов принятых вложений новой ревизии — их распознаёт движок 05a.
  attachmentRevisionIds: string[];
}

// Длинный блок делится на части без потери текста (как фрагменты 04/05a): по границе строки,
// иначе по кодовой точке.
const splitText = (text: string, max: number): string[] => {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/u, '');
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
};

const resolveCommunication = async (db: Queryable, groupKey: string | null): Promise<string> => {
  if (groupKey) {
    await db.query(
      'INSERT INTO mail_communication (group_key) VALUES ($1) ON CONFLICT (group_key) WHERE group_key IS NOT NULL DO NOTHING',
      [groupKey],
    );
    const r = await db.query<{ id: string }>('SELECT id FROM mail_communication WHERE group_key = $1', [groupKey]);
    return r.rows[0]!.id;
  }
  const r = await db.query<{ id: string }>('INSERT INTO mail_communication DEFAULT VALUES RETURNING id');
  return r.rows[0]!.id;
};

// Сериализация истории письма (как у 0008): неизменяемую строку роль приложения не блокирует, поэтому
// импорт, связь и охранник вставки ревизии берут одну advisory-блокировку письма.
export const lockMailMessage = async (db: Queryable, messageId: string): Promise<void> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('mail_message_revision'), hashtext($1::text))", [messageId]);
};

// Сохранение разобранного письма в транзакции вызывающего. Побайтный повтор в том же письме — прежняя
// ревизия (created = false); изменённая копия с той же идентичностью — новая ревизия за последней.
// Идентичность в ящике и история письма сериализуются: параллельный импорт того же письма ждёт и видит
// результат первого.
export const persistMailRevision = async (db: Queryable, m: IMailRevisionInput): Promise<IMailPersistResult> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('mail_message'), hashtext($1::text))", [`${m.mailboxId}|${m.identity.kind}|${m.identity.value}`]);
  const findMessage = async (): Promise<string | null> => {
    const r = await db.query<{ id: string }>('SELECT id FROM mail_message WHERE mailbox_id = $1 AND identity_kind = $2 AND identity_value = $3', [
      m.mailboxId,
      m.identity.kind,
      m.identity.value,
    ]);
    return r.rows[0]?.id ?? null;
  };
  let messageId = await findMessage();
  if (!messageId) {
    const communicationId = await resolveCommunication(db, m.groupKey);
    const ins = await db.query<{ id: string }>(
      `INSERT INTO mail_message (mailbox_id, communication_id, identity_kind, identity_value, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (mailbox_id, identity_kind, identity_value) DO NOTHING RETURNING id`,
      [m.mailboxId, communicationId, m.identity.kind, m.identity.value, m.importedBy],
    );
    messageId = ins.rows[0]?.id ?? (await findMessage());
  }
  await lockMailMessage(db, messageId!);
  const same = await db.query<{ id: string }>('SELECT id FROM mail_message_revision WHERE message_id = $1 AND raw_blob_sha256 = $2', [
    messageId,
    m.rawSha256,
  ]);
  if (same.rows[0]) return { messageId: messageId!, revisionId: same.rows[0].id, created: false, attachmentRevisionIds: [] };
  const last = await db.query<{ id: string; seq: number }>('SELECT id, seq FROM mail_message_revision WHERE message_id = $1 ORDER BY seq DESC LIMIT 1', [
    messageId,
  ]);
  const bodyText = m.blocks.map((b) => b.text).join('\n\n');
  const rev = await db.query<{ id: string }>(
    `INSERT INTO mail_message_revision (message_id, seq, raw_blob_sha256, message_id_header, subject, sent_at, from_address, participants,
                                        direction, folder, in_reply_to, reference_ids, source, source_item_id, body_text_sha256,
                                        parse_warnings, supersedes_revision_id, imported_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::text[], $13, $14, $15, $16::jsonb, $17, $18) RETURNING id`,
    [
      messageId,
      (last.rows[0]?.seq ?? 0) + 1,
      m.rawSha256,
      m.messageIdHeader,
      m.subject,
      m.sentAt,
      m.fromAddress,
      JSON.stringify(m.participants),
      m.direction,
      m.folder,
      m.inReplyTo,
      m.references,
      m.source,
      m.sourceItemId,
      bodyText.length > 0 ? sha256Hex(bodyText) : null,
      JSON.stringify(m.warnings),
      last.rows[0]?.id ?? null,
      m.importedBy,
    ],
  );
  const revisionId = rev.rows[0]!.id;
  const attachmentRevisionIds: string[] = [];
  for (const a of m.attachments) {
    const att = await db.query<{ id: string }>(
      `INSERT INTO mail_attachment (revision_id, ordinal, filename, mime_type, size_bytes, sha256, disposition, content_id, status, reject_reason, blob_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        revisionId,
        a.ordinal,
        a.filename,
        a.mimeType,
        a.sizeBytes,
        a.sha256,
        a.disposition,
        a.contentId,
        a.status,
        a.rejectReason,
        a.status === 'registered' ? a.sha256 : null,
      ],
    );
    if (a.status !== 'registered') continue;
    // Документ вложения (AD-07-2a): третья ветка владельца — само вложение; ни тендера, ни договора.
    const doc = await db.query<{ id: string }>(
      `INSERT INTO document (title, name_key, doc_type, mail_attachment_id) VALUES ($1, $2, 'other', $3) RETURNING id`,
      [a.filename.slice(0, 500), nameKeyOf(a.filename), att.rows[0]!.id],
    );
    const dr = await db.query<{ id: string }>(
      'INSERT INTO document_revision (document_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, 1, $3) RETURNING id',
      [doc.rows[0]!.id, a.sha256, m.importedBy],
    );
    attachmentRevisionIds.push(dr.rows[0]!.id);
  }
  // Фрагменты тела: блок — якорь { block, quoted }; длинный блок — части с общим номером.
  const frags = m.blocks.flatMap((b) => {
    const parts = splitText(b.text, m.maxFragmentChars);
    return parts.map((text, i) => ({ block: b.block, quoted: b.quoted, text, partIndex: i, partTotal: parts.length }));
  });
  if (frags.length > 0) {
    await db.query(
      `INSERT INTO evidence_fragment (source_unit_type, source_unit_id, mail_message_revision_id, origin, fragment_kind, fragment_key, ordinal,
                                      text, text_sha256, part_index, part_total, locator)
       SELECT 'mail_message_revision', $1, $1, 'email_body', 'text_block', x.fragment_key, x.ordinal, x.text, x.text_sha256, x.part_index, x.part_total,
              jsonb_build_object('kind', 'mail_body', 'block', x.block, 'quoted', x.quoted)
         FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::boolean[])
              AS x(fragment_key, ordinal, text, text_sha256, part_index, part_total, block, quoted)`,
      [
        revisionId,
        frags.map((f) => (f.partTotal > 1 ? `b${f.block}#p${f.partIndex + 1}` : `b${f.block}`)),
        frags.map((_, i) => i + 1),
        frags.map((f) => f.text),
        frags.map((f) => sha256Hex(f.text)),
        frags.map((f) => f.partIndex),
        frags.map((f) => f.partTotal),
        frags.map((f) => f.block),
        frags.map((f) => f.quoted),
      ],
    );
  }
  return { messageId: messageId!, revisionId, created: true, attachmentRevisionIds };
};

// ---------------------------------------------------------------- Чтение

export interface IMailMessageRow {
  id: string;
  mailbox_id: string;
  mailbox_name: string;
  communication_id: string;
  identity_kind: string;
  created_at: Date;
  revision_id: string;
  revision_seq: number;
  revisions: number;
  subject: string | null;
  sent_at: Date | null;
  from_address: string | null;
  direction: 'inbound' | 'outbound' | 'unknown';
  folder: string | null;
  attachments: number;
  links: number;
}

const SELECT_MESSAGE = `
  SELECT m.id, m.mailbox_id, b.display_name AS mailbox_name, m.communication_id, m.identity_kind, m.created_at,
         lr.id AS revision_id, lr.seq AS revision_seq, (SELECT count(*)::int FROM mail_message_revision x WHERE x.message_id = m.id) AS revisions,
         lr.subject, lr.sent_at, lr.from_address, lr.direction, lr.folder,
         (SELECT count(*)::int FROM mail_attachment a WHERE a.revision_id = lr.id) AS attachments,
         (SELECT count(*)::int FROM mail_message_tender l WHERE l.message_id = m.id AND l.status = 'linked') AS links
    FROM mail_message m
    JOIN mailbox b ON b.id = m.mailbox_id
    JOIN LATERAL (SELECT r.* FROM mail_message_revision r WHERE r.message_id = m.id ORDER BY r.seq DESC LIMIT 1) lr ON true`;

// Письма ящика (контекст ящика): вызывающий проверил mail.read на ящик.
export const listMailboxMessages = async (db: Queryable, mailboxId: string, limit = 200): Promise<IMailMessageRow[]> => {
  const r = await db.query<IMailMessageRow>(
    `${SELECT_MESSAGE} WHERE m.mailbox_id = $1 ORDER BY lr.sent_at DESC NULLS LAST, m.created_at DESC, m.id LIMIT $2`,
    [mailboxId, limit],
  );
  return r.rows;
};

// Письма в контексте тендера: действующая связь с тендером и mail.read на ящик. Письмо без mail.read
// не показывается и не считается — ни темой, ни числом (OD-07-3).
export const listTenderMessages = async (db: Queryable, ctx: IAccessContext, tenderId: string): Promise<(IMailMessageRow & { stage_id: string | null })[]> => {
  const r = await db.query<IMailMessageRow & { stage_id: string | null }>(
    `SELECT x.*, l.stage_id FROM (${SELECT_MESSAGE}) x
       JOIN mail_message_tender l ON l.message_id = x.id AND l.tender_id = $1 AND l.status = 'linked'
      WHERE x.mailbox_id = ANY($2::uuid[])
      ORDER BY x.sent_at DESC NULLS LAST, x.created_at DESC, x.id`,
    [tenderId, readableMailboxIds(ctx)],
  );
  return r.rows;
};

export const getMailMessage = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IMailMessageRow | null> => {
  const r = await db.query<IMailMessageRow>(`${SELECT_MESSAGE} WHERE m.id = $1 AND m.mailbox_id = ANY($2::uuid[])`, [id, readableMailboxIds(ctx)]);
  return r.rows[0] ?? null;
};

export interface IMailRevisionRow {
  id: string;
  message_id: string;
  seq: number;
  raw_blob_sha256: string;
  message_id_header: string | null;
  subject: string | null;
  sent_at: Date | null;
  from_address: string | null;
  participants: { role: string; address: string; name: string | null }[];
  direction: 'inbound' | 'outbound' | 'unknown';
  folder: string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  source: string;
  parse_warnings: string[];
  created_at: Date;
}

export const listMailRevisions = async (db: Queryable, messageId: string): Promise<IMailRevisionRow[]> => {
  const r = await db.query<IMailRevisionRow>('SELECT * FROM mail_message_revision WHERE message_id = $1 ORDER BY seq DESC', [messageId]);
  return r.rows;
};

// Ревизия письма с проверкой mail.read на его ящик.
export const getMailRevision = async (db: Queryable, ctx: IAccessContext, revisionId: string): Promise<(IMailRevisionRow & { mailbox_id: string }) | null> => {
  const r = await db.query<IMailRevisionRow & { mailbox_id: string }>(
    `SELECT r.*, m.mailbox_id FROM mail_message_revision r JOIN mail_message m ON m.id = r.message_id
      WHERE r.id = $1 AND m.mailbox_id = ANY($2::uuid[])`,
    [revisionId, readableMailboxIds(ctx)],
  );
  return r.rows[0] ?? null;
};

export interface IMailBodyFragmentRow {
  id: string;
  fragment_key: string;
  ordinal: number;
  text: string;
  part_index: number;
  part_total: number;
  locator: { kind: 'mail_body'; block: number; quoted: boolean };
}

export const mailBodyFragments = async (db: Queryable, revisionId: string): Promise<IMailBodyFragmentRow[]> => {
  const r = await db.query<IMailBodyFragmentRow>(
    `SELECT id, fragment_key, ordinal, text, part_index, part_total, locator FROM evidence_fragment
      WHERE mail_message_revision_id = $1 ORDER BY ordinal`,
    [revisionId],
  );
  return r.rows;
};

export interface IMailAttachmentRow {
  id: string;
  revision_id: string;
  ordinal: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  disposition: 'attachment' | 'inline';
  status: 'registered' | 'rejected';
  reject_reason: string | null;
  document_id: string | null;
  document_revision_id: string | null;
  run_status: string | null;
  run_engine: string | null;
}

export const listMailAttachments = async (db: Queryable, revisionId: string): Promise<IMailAttachmentRow[]> => {
  const r = await db.query<IMailAttachmentRow>(
    `SELECT a.id, a.revision_id, a.ordinal, a.filename, a.mime_type, a.size_bytes, a.sha256, a.disposition, a.status, a.reject_reason,
            d.id AS document_id, dr.id AS document_revision_id,
            (SELECT r.status FROM recognition_run r WHERE r.id = recognition_preferred_run(dr.id)) AS run_status,
            (SELECT r.engine FROM recognition_run r WHERE r.id = recognition_preferred_run(dr.id)) AS run_engine
       FROM mail_attachment a
       LEFT JOIN document d ON d.mail_attachment_id = a.id
       LEFT JOIN document_revision dr ON dr.document_id = d.id
      WHERE a.revision_id = $1
      ORDER BY a.ordinal`,
    [revisionId],
  );
  return r.rows;
};

// Вложение для скачивания — с проверкой mail.read на ящик письма (A35: известный ID не помогает).
export const getMailAttachment = async (
  db: Queryable,
  ctx: IAccessContext,
  id: string,
): Promise<(IMailAttachmentRow & { storage_key: string | null; blob_media_type: string | null; mailbox_id: string }) | null> => {
  const r = await db.query<IMailAttachmentRow & { storage_key: string | null; blob_media_type: string | null; mailbox_id: string }>(
    `SELECT a.id, a.revision_id, a.ordinal, a.filename, a.mime_type, a.size_bytes, a.sha256, a.disposition, a.status, a.reject_reason,
            NULL::uuid AS document_id, NULL::uuid AS document_revision_id, NULL::text AS run_status, NULL::text AS run_engine,
            bl.storage_key, bl.media_type AS blob_media_type, m.mailbox_id
       FROM mail_attachment a
       JOIN mail_message_revision r ON r.id = a.revision_id
       JOIN mail_message m ON m.id = r.message_id
       LEFT JOIN blob bl ON bl.sha256 = a.blob_sha256
      WHERE a.id = $1 AND m.mailbox_id = ANY($2::uuid[])`,
    [id, readableMailboxIds(ctx)],
  );
  return r.rows[0] ?? null;
};

export interface IMailSiblingRow {
  id: string;
  mailbox_id: string;
  mailbox_name: string;
  folder: string | null;
  direction: string;
}

// Другие копии той же коммуникации — только в ящиках, которые пользователь читает (И-07-1): группировка
// не раскрывает существование копии в чужом ящике.
export const mailSiblings = async (db: Queryable, ctx: IAccessContext, messageId: string): Promise<IMailSiblingRow[]> => {
  const r = await db.query<IMailSiblingRow>(
    `SELECT s.id, s.mailbox_id, b.display_name AS mailbox_name, lr.folder, lr.direction
       FROM mail_message m
       JOIN mail_message s ON s.communication_id = m.communication_id AND s.id <> m.id
       JOIN mailbox b ON b.id = s.mailbox_id
       JOIN LATERAL (SELECT r.folder, r.direction FROM mail_message_revision r WHERE r.message_id = s.id ORDER BY r.seq DESC LIMIT 1) lr ON true
      WHERE m.id = $1 AND s.mailbox_id = ANY($2::uuid[])
      ORDER BY b.display_name, s.id`,
    [messageId, readableMailboxIds(ctx)],
  );
  return r.rows;
};
