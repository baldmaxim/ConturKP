// Типы этапа 15 (D-035; portal-api §2.10): отправки и нарушения выпуска, сравнение двух выпусков и причины выводов.

export type TSendStatus = 'registered' | 'verified' | 'disputed';
export type TSendChannel = 'email' | 'customer_portal' | 'paper' | 'other';
export type TSendState = 'not_registered' | 'registered_unchecked' | 'verified' | 'disputed';
export type TSendFileClass = 'kit' | 'internal' | 'other_release' | 'unknown';

export interface ISendMail {
  restricted: boolean;
  messageId: string | null;
  revisionId: string | null;
  mailboxName: string | null;
  subject: string | null;
  from: string | null;
  recipients: string[];
  copies: { messageId: string; mailboxName: string; folder: string | null }[];
}

export interface ISendExtras {
  unknown: number;
  inline: number;
  internal: number;
  otherRelease: number;
}

export interface ISendView {
  id: string;
  releaseId: string;
  seq: number;
  channel: TSendChannel;
  sentAt: string;
  status: TSendStatus;
  attachmentCheck: 'matched' | 'mismatched' | 'not_checked';
  extrasAccepted: boolean;
  counted: boolean;
  repeat: boolean;
  evidence: { kind: 'mail_message' | 'uploaded_file' | 'manual_note'; mail: ISendMail | null; file: { fileName: string; sha256: string } | null };
  recipients: string[];
  note: string | null;
  check: { kitFiles?: number; missing?: { path: string; sha256: string; size: number }[]; extras?: ISendExtras; extrasOnly?: boolean };
  files: { ordinal: number; sha256: string; size: number; class: TSendFileClass; kitPath: string | null; otherReleaseSeq: number | null; inline: boolean; fileName: string | null }[];
  decisions: { action: string; actor: { id: string; name: string }; reason: string | null; restricted: boolean; createdAt: string }[];
  registeredBy: { id: string; name: string };
  registeredAt: string;
  etag: string;
  actions: { acceptExtras: boolean };
}

export interface IIncidentView {
  id: string;
  kind: 'test_release_sent_externally' | 'sent_despite_blocker' | 'other';
  occurredAt: string;
  description: string | null;
  restricted: boolean;
  evidence: { mail: { restricted: boolean; messageId: string | null } | null; file: { fileName: string; sha256: string } | null };
  registeredBy: { id: string; name: string };
  registeredAt: string;
}

export interface IReleaseSends {
  items: ISendView[];
  incidents: IIncidentView[];
  summary: {
    state: TSendState;
    events: number;
    counted: number;
    disputed: number;
    incidents: number;
    testRelease: boolean;
    readiness: { state: 'ready' | 'held' | 'excluded' | 'intake_not_current'; events: { seq: number; type: string }[] };
    provesReceipt: false;
  };
  warnings: ('not_placed' | 'cloud_unconfirmed')[];
  mailhub: { status: string; note: string };
  can: { register: boolean; registerBlockedBy: 'release_is_test' | 'held' | 'excluded' | 'intake_not_current' | null; registerIncident: boolean; acceptExtras: boolean };
}

export interface ISendCandidate {
  messageId: string;
  revisionId: string;
  mailboxName: string;
  folder: string | null;
  subject: string | null;
  from: string | null;
  recipients: string[];
  sentAt: string | null;
  attachments: number;
  check: 'matched' | 'mismatched';
  missing: number;
  extras: ISendExtras;
  extrasOnly: boolean;
  otherReleaseSeqs: number[];
  registeredSendEventId: string | null;
  sentBeforeRelease: boolean;
}

export interface ISendCandidates {
  items: ISendCandidate[];
  kitFiles: number;
  note: string;
}

export interface IEvidenceUpload {
  uploadId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export type TRegisterSendBody =
  | { evidence: { kind: 'mail_message'; mailMessageRevisionId: string } }
  | { evidence: { kind: 'uploaded_file'; uploadId: string } | { kind: 'manual_note' }; channel: TSendChannel; sentAt: string; recipients: string[]; note: string | null };

export interface IIncidentBody {
  kind: IIncidentView['kind'];
  occurredAt: string;
  description: string;
  uploadId?: string | null;
}

// ---------------------------------------------------------------- Сравнение выпусков

export type TCompareSection = 'sources' | 'requirements' | 'questions' | 'terms' | 'decisions' | 'applications' | 'received';
export type TReasonStatus = 'unknown' | 'hypothesis' | 'confirmed';
export type TReasonKind = 'document' | 'answer' | 'supplier' | 'internal_decision' | 'unknown';

export interface ITenderRelease {
  id: string;
  candidateSeq: number;
  stage: { id: string; seq: number; title: string };
  mode: 'test' | 'production';
  releasedAt: string;
  releasedBy: string;
  restricted: boolean;
  manifestSha256: string | null;
  send: { events: number; counted: number; disputed: number; incidents: number; firstCountedAt: string | null };
}

export interface IComparisonSide {
  releaseId: string;
  candidateSeq: number;
  stage: { id: string; seq: number; title: string };
  mode: 'test' | 'production';
  releasedAt: string;
  manifestSha256: string;
}

export interface IComparisonBrief {
  id: string;
  status: 'computing' | 'ready' | 'failed';
  failureReason: string | null;
  methodVersion: string;
  resultSha256: string | null;
  left: IComparisonSide;
  right: IComparisonSide;
  requestedBy: { id: string; name: string };
  createdAt: string;
  changes: Record<TCompareSection, number> | null;
}

export interface ISectionSummary {
  left: number;
  right: number;
  unchanged: number;
  changes: Record<string, number>;
  unavailable?: 'left' | 'right' | 'both';
}

export interface IComparisonView extends IComparisonBrief {
  sections: Record<TCompareSection, ISectionSummary> | null;
  interval: { from: string; to: string; empty: boolean } | null;
  unrecognizedRight: number;
  calculation: {
    state: 'same_revision' | 'compared' | 'failed';
    comparisonId: string | null;
    reason: string | null;
    totals: Record<string, { targetKind: string; left: string; right: string; delta: string }> | null;
    reasons: Record<TReasonStatus, number> | null;
    remainder: { measure: string; amount: string }[] | null;
    outdated: boolean;
  } | null;
  reasons: Record<TReasonStatus, number> | null;
  can: { setReason: boolean };
}

export interface IItemSide {
  ref: string | null;
  sha256: string | null;
  label: string | null;
  note: string | null;
  value?: unknown;
}

export interface IItemReason {
  id: string;
  version: number;
  reasonKind: TReasonKind;
  reasonStatus: TReasonStatus;
  rationale: string | null;
  restricted: boolean;
  actor: { id: string; name: string };
  createdAt: string;
  fragmentIds: string[];
  decisionIds: string[];
  bases: number;
}

export interface IComparisonItem {
  id: string;
  ordinal: number;
  section: TCompareSection;
  change: string;
  subjectType: string;
  closed: boolean;
  left: IItemSide | null;
  right: IItemSide | null;
  detail: Record<string, unknown>;
  evidence: { type: string; id: string }[];
  reason: IItemReason | null;
  reasonVersion: number;
  reasonStatus: TReasonStatus;
}

export interface IReasonBody {
  reasonKind: TReasonKind;
  reasonStatus: TReasonStatus;
  rationale: string | null;
  fragmentIds: string[];
  decisionIds: string[];
}
