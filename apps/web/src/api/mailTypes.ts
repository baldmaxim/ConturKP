// Типы почтового контура, вопросов–ответов и переговоров (этап 07, D-025; portal-api §2.6).

export type TMailCapability = 'mail.read' | 'mail.import' | 'mail.link' | 'mail.manage';
export type TMailDirection = 'inbound' | 'outbound' | 'unknown';

export interface ICommunicationIntegration {
  system: 'mailhub' | 'negotiations' | string;
  component: string;
  status: 'NOT_IMPLEMENTED' | 'VERIFIED_FIXTURE' | 'VERIFIED_LIVE' | 'BLOCKED_EXTERNAL';
  blockedBy: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}

export interface IMailbox {
  id: string;
  system: 'manual' | 'mailhub';
  externalAccountId: string;
  displayName: string;
  status: 'active' | 'archived';
  messages: number;
  /** Мои действующие возможности по ящику; у администратора без выдачи — пусто. */
  capabilities: TMailCapability[];
  createdAt: string;
  rowVersion: number;
}

export interface IMailboxList {
  items: IMailbox[];
  isMailboxAdmin: boolean;
  integrations: ICommunicationIntegration[];
}

export interface IMailAccessRow {
  userId: string;
  login: string;
  displayName: string;
  capabilities: TMailCapability[];
}

export interface IMailAccessList {
  items: IMailAccessRow[];
  mailboxRowVersion: number;
}

export interface IMailImport {
  id: string;
  mailboxId: string;
  fileName: string;
  direction: TMailDirection;
  folder: string | null;
  linkTenderId: string | null;
  linkStageId: string | null;
  status: 'queued' | 'done' | 'failed';
  failureCode: string | null;
  failureDetail: string | null;
  messageId: string | null;
  revisionId: string | null;
  createdRevision: boolean | null;
  rawSha256: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface IMailMessage {
  id: string;
  mailboxId: string;
  mailboxName: string;
  communicationId: string;
  identityKind: 'source_id' | 'message_id' | 'raw_sha256';
  revisionId: string;
  revisionSeq: number;
  revisions: number;
  subject: string | null;
  sentAt: string | null;
  from: string | null;
  direction: TMailDirection;
  folder: string | null;
  attachments: number;
  links: number;
  stageId?: string | null;
  createdAt: string;
}

export interface IMailParticipant {
  role: 'from' | 'sender' | 'to' | 'cc' | 'bcc' | 'reply_to';
  address: string;
  name: string | null;
}

export interface IMailBodyBlock {
  fragmentId: string;
  block: number;
  quoted: boolean;
  partIndex: number;
  partTotal: number;
  text: string;
}

export interface IMailAttachment {
  id: string;
  ordinal: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  disposition: 'attachment' | 'inline';
  status: 'registered' | 'rejected';
  rejectReason: 'type_not_allowed' | 'size_limit' | 'corrupt' | null;
  documentId: string | null;
  documentRevisionId: string | null;
  runStatus: string | null;
  runEngine: string | null;
  contentUrl: string | null;
}

export interface IMailRevision {
  id: string;
  seq: number;
  messageIdHeader: string | null;
  subject: string | null;
  sentAt: string | null;
  from: string | null;
  participants: IMailParticipant[];
  direction: TMailDirection;
  folder: string | null;
  inReplyTo: string | null;
  references: string[];
  source: string;
  warnings: string[];
  rawSha256: string;
  createdAt: string;
}

export interface IMailRevisionDetail extends IMailRevision {
  body: IMailBodyBlock[];
  attachments: IMailAttachment[];
}

export interface IMailLink {
  id: string;
  messageId: string;
  tenderId: string;
  tenderCode: string;
  tenderTitle: string;
  stageId: string | null;
  status: 'linked' | 'unlinked';
  linkedAt: string;
  updatedAt: string;
  rowVersion: number;
}

export type TLinkReason = 'tender_code_in_subject' | 'tender_code_in_body' | 'tenderhub_number_in_subject' | 'tenderhub_number_in_body';

export interface ILinkCandidate {
  tenderId: string;
  tenderCode: string;
  tenderTitle: string;
  reasons: TLinkReason[];
}

export interface IMailSibling {
  messageId: string;
  mailboxId: string;
  mailboxName: string;
  folder: string | null;
  direction: TMailDirection;
}

export interface IMailMessageDetail extends IMailMessage {
  capabilities: TMailCapability[];
  current: IMailRevisionDetail;
  revisionList: IMailRevision[];
  siblings: IMailSibling[];
  tenderLinks: IMailLink[];
  candidates: ILinkCandidate[];
}

// ---------------------------------------------------------------- Вопросы–ответы

export interface IQaThread {
  id: string;
  tenderId: string;
  stageId: string | null;
  externalRef: string;
  title: string | null;
  items: number;
  openItems: number;
  createdAt: string;
}

export interface IQaItemRevision {
  id: string;
  seq: number;
  question: string;
  answer: string | null;
  status: 'open' | 'answered' | 'withdrawn';
  askedAt: string | null;
  answeredAt: string | null;
  externalRef: string | null;
  importId: string;
  createdAt: string;
}

export interface IQaItem {
  itemId: string;
  itemNo: string;
  current: IQaItemRevision;
  history: IQaItemRevision[];
}

export interface IQaThreadDetail extends IQaThread {
  questions: IQaItem[];
}

export interface IQaImportResult {
  importId: string;
  reused: boolean;
  threads: number;
  newRevisions: number;
}

// ---------------------------------------------------------------- Переговоры

export interface INegotiationSession {
  id: string;
  tenderId: string;
  stageId: string | null;
  externalSessionId: string;
  title: string | null;
  startedAt: string;
  audioRef: string | null;
  audioSha256: string | null;
  source: string;
  revisions: number;
  latestRevisionId: string | null;
  createdAt: string;
}

export interface ITranscriptRevision {
  id: string;
  seq: number;
  sourceRevision: string;
  segments: number;
  createdAt: string;
}

export interface ITranscriptSegment {
  id: string;
  fragmentId: string;
  segmentNo: number;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  kind: 'speech' | 'hint';
  text: string;
}

export interface INegotiationSessionDetail extends INegotiationSession {
  participants: { speakerLabel: string; name: string | null; side: 'customer' | 'contractor' | 'unknown' }[];
  revisionList: ITranscriptRevision[];
  revision: ITranscriptRevision | null;
  segments: ITranscriptSegment[];
}

export interface INegotiationImportResult {
  importId: string;
  reused: boolean;
  sessionId: string | null;
  revisionId: string | null;
  createdRevision: boolean;
}
