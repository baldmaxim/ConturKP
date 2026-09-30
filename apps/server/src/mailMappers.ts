// Представления почты, вопросов–ответов и переговоров для API (этап 07, D-025). Служебные сведения ящика
// видит и администратор; шапку, тело, адреса и вложения письма — только читатель ящика (mail.read):
// вызывающий проверил это до построения представления.
import type { MailCapability } from '@kontur/core';
import type {
  ICommunicationIntegrationRow,
  ILinkCandidate,
  IMailAccessRow,
  IMailAttachmentRow,
  IMailBodyFragmentRow,
  IMailboxRow,
  IMailImportRow,
  IMailLinkRow,
  IMailMessageRow,
  IMailRevisionRow,
  IMailSiblingRow,
  INegotiationSessionRow,
  IParticipantRow,
  IQaItemRevisionRow,
  IQaThreadRow,
  ITranscriptRevisionRow,
  ITranscriptSegmentRow,
} from '@kontur/db';

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export const toMailbox = (m: IMailboxRow, capabilities: MailCapability[]) => ({
  id: m.id,
  system: m.system,
  externalAccountId: m.external_account_id,
  displayName: m.display_name,
  status: m.status,
  messages: m.messages,
  capabilities,
  createdAt: m.created_at.toISOString(),
  rowVersion: m.row_version,
});

// Автоматические каналы почты и переговоров: BLOCKED_EXTERNAL с внешней причиной (X-03, Q-06).
export const toCommunicationIntegration = (r: ICommunicationIntegrationRow) => ({
  system: r.system,
  component: r.component,
  status: r.status,
  blockedBy: r.status === 'BLOCKED_EXTERNAL' ? ((r.details.blockedBy as string | undefined) ?? null) : null,
  lastCheckedAt: iso(r.last_checked_at),
  lastSuccessAt: iso(r.last_success_at),
  lastErrorCode: r.last_error_code,
});

export const toMailAccess = (a: IMailAccessRow) => ({ userId: a.user_id, login: a.login, displayName: a.display_name, capabilities: a.capabilities });

// Импорт: имя файла и параметры видит только импортирующий или читатель ящика; исход — без содержимого.
export const toMailImport = (i: IMailImportRow) => ({
  id: i.id,
  mailboxId: i.mailbox_id,
  fileName: i.file_name,
  direction: i.direction,
  folder: i.folder,
  linkTenderId: i.link_tender_id,
  linkStageId: i.link_stage_id,
  status: i.status,
  failureCode: i.failure_code,
  failureDetail: i.failure_detail,
  messageId: i.message_id,
  revisionId: i.revision_id,
  createdRevision: i.created_revision,
  rawSha256: i.raw_blob_sha256,
  createdAt: i.created_at.toISOString(),
  finishedAt: iso(i.finished_at),
});

export const toMailMessage = (m: IMailMessageRow & { stage_id?: string | null }) => ({
  id: m.id,
  mailboxId: m.mailbox_id,
  mailboxName: m.mailbox_name,
  communicationId: m.communication_id,
  identityKind: m.identity_kind,
  revisionId: m.revision_id,
  revisionSeq: m.revision_seq,
  revisions: m.revisions,
  subject: m.subject,
  sentAt: iso(m.sent_at),
  from: m.from_address,
  direction: m.direction,
  folder: m.folder,
  attachments: m.attachments,
  links: m.links,
  ...(m.stage_id !== undefined ? { stageId: m.stage_id } : {}),
  createdAt: m.created_at.toISOString(),
});

export const toMailRevision = (r: IMailRevisionRow) => ({
  id: r.id,
  seq: r.seq,
  messageIdHeader: r.message_id_header,
  subject: r.subject,
  sentAt: iso(r.sent_at),
  from: r.from_address,
  participants: r.participants,
  direction: r.direction,
  folder: r.folder,
  inReplyTo: r.in_reply_to,
  references: r.reference_ids,
  source: r.source,
  warnings: r.parse_warnings,
  rawSha256: r.raw_blob_sha256,
  createdAt: r.created_at.toISOString(),
});

// Тело по блокам: цитата прежней переписки помечена и остаётся отдельным блоком (не новое утверждение).
export const toMailBody = (fragments: IMailBodyFragmentRow[]) =>
  fragments.map((f) => ({
    fragmentId: f.id,
    block: f.locator.block,
    quoted: f.locator.quoted,
    partIndex: f.part_index,
    partTotal: f.part_total,
    text: f.text,
  }));

export const toMailAttachment = (a: IMailAttachmentRow) => ({
  id: a.id,
  ordinal: a.ordinal,
  filename: a.filename,
  mimeType: a.mime_type,
  sizeBytes: Number(a.size_bytes),
  sha256: a.sha256,
  disposition: a.disposition,
  status: a.status,
  rejectReason: a.reject_reason,
  documentId: a.document_id,
  documentRevisionId: a.document_revision_id,
  runStatus: a.run_status,
  runEngine: a.run_engine,
  contentUrl: a.status === 'registered' ? `/api/v1/mail-attachments/${a.id}/content` : null,
});

export const toMailSibling = (s: IMailSiblingRow) => ({ messageId: s.id, mailboxId: s.mailbox_id, mailboxName: s.mailbox_name, folder: s.folder, direction: s.direction });

export const toMailLink = (l: IMailLinkRow) => ({
  id: l.id,
  messageId: l.message_id,
  tenderId: l.tender_id,
  tenderCode: l.tender_code,
  tenderTitle: l.tender_title,
  stageId: l.stage_id,
  status: l.status,
  linkedAt: l.linked_at.toISOString(),
  updatedAt: l.updated_at.toISOString(),
  rowVersion: l.row_version,
});

export const toLinkCandidate = (c: ILinkCandidate) => ({ tenderId: c.tenderId, tenderCode: c.tenderCode, tenderTitle: c.tenderTitle, reasons: c.reasons });

export const toQaThread = (t: IQaThreadRow) => ({
  id: t.id,
  tenderId: t.tender_id,
  stageId: t.stage_id,
  externalRef: t.external_ref,
  title: t.title,
  items: t.items,
  openItems: t.open_items,
  createdAt: t.created_at.toISOString(),
});

// Вопросы треда: у каждого — текущая ревизия и история (новые сверху).
export const toQaItems = (rows: IQaItemRevisionRow[]) => {
  const byItem = new Map<string, IQaItemRevisionRow[]>();
  for (const r of rows) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r]);
  return [...byItem.values()].map((revs) => {
    const cur = revs[0]!;
    const rev = (r: IQaItemRevisionRow) => ({
      id: r.id,
      seq: r.seq,
      question: r.question,
      answer: r.answer,
      status: r.status,
      askedAt: iso(r.asked_at),
      answeredAt: iso(r.answered_at),
      externalRef: r.external_ref,
      importId: r.import_id,
      createdAt: r.created_at.toISOString(),
    });
    return { itemId: cur.item_id, itemNo: cur.item_no, current: rev(cur), history: revs.map(rev) };
  });
};

export const toNegotiationSession = (s: INegotiationSessionRow) => ({
  id: s.id,
  tenderId: s.tender_id,
  stageId: s.stage_id,
  externalSessionId: s.external_session_id,
  title: s.title,
  startedAt: s.started_at.toISOString(),
  audioRef: s.audio_ref,
  audioSha256: s.audio_sha256,
  source: s.source,
  revisions: s.revisions,
  latestRevisionId: s.latest_revision_id,
  createdAt: s.created_at.toISOString(),
});

export const toParticipant = (p: IParticipantRow) => ({ speakerLabel: p.speaker_label, name: p.name, side: p.side });

export const toTranscriptRevision = (r: ITranscriptRevisionRow) => ({
  id: r.id,
  seq: r.seq,
  sourceRevision: r.source_revision,
  segments: r.segments,
  createdAt: r.created_at.toISOString(),
});

// Речь и подсказка участнику — разные виды (I06, A03): подсказка не выдаётся за слова заказчика.
export const toTranscriptSegment = (s: ITranscriptSegmentRow) => ({
  id: s.id,
  fragmentId: s.fragment_id,
  segmentNo: s.segment_no,
  speakerLabel: s.speaker_label,
  startMs: s.t_start_ms,
  endMs: s.t_end_ms,
  kind: s.segment_kind,
  text: s.text,
});
