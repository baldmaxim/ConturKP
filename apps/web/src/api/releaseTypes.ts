// Типы комплекта-кандидата выпуска и стандартных вложений (этап 12; D-032; portal-api §2.9); согласование, выпуск,
// удержания и матрица блокеров — этап 13 (D-033; portal-api §2.9.2).

export type TCandidateStatus = 'assembling' | 'assembly_failed' | 'ready_for_approval' | 'approved' | 'returned' | 'released' | 'superseded';

export interface IActor {
  id: string;
  name: string;
}

export interface IGateItem {
  subjectType: string;
  subjectId: string;
  subjectKey: string;
  subjectVersion: number | null;
  title: string;
  acceptable: boolean;
  restricted: boolean;
  // Причина закрыта вместе с предметом (R13-02) — null.
  acceptance: { id: string; reason: string | null; acceptedBy: string; acceptedAt: string } | null;
}

export interface IGateBlocker {
  code: string;
  class: 'authority' | 'technical' | 'integrity' | 'business';
  acceptable: boolean;
  open: number;
  items: IGateItem[];
}

export interface IGateView {
  ok: boolean;
  blockers: IGateBlocker[];
  // Отпечаток показанного состава (R13-04): передаётся в команду согласования или выпуска.
  compositionHash?: string;
}

export interface IApprovalView {
  id: string;
  status: 'active' | 'revoked' | 'superseded';
  contentHash: string;
  inputVersion: number;
  comment: string | null;
  approvedBy: IActor;
  approvedAt: string;
  acceptedRiskIds: string[];
  revokedBy: IActor | null;
  revokeReason: string | null;
  endedAt: string | null;
  etag: string;
}

export interface IReleaseView {
  id: string;
  candidateId: string;
  candidateSeq: number;
  approvalId: string;
  mode: 'test' | 'production';
  inputVersion: number;
  contentHash: string;
  manifestSha256: string;
  releasedBy: IActor;
  releasedAt: string;
  sendReadiness: { state: 'excluded' | 'held' | 'intake_not_current' | 'ready'; sendable: boolean; testRelease: boolean; events: { seq: number; type: string }[] };
  // Манифест выпуска (и ZIP всех файлов) — только при доступе к предметам всех решений в нём (R13-02).
  manifestReadable: boolean;
}

export interface IHoldView {
  id: string;
  candidateId: string;
  candidateSeq: number;
  status: 'open' | 'resolved_not_applicable' | 'resolved_requires_new_candidate';
  event: { id: string; seq: number; type: string; class: string; refType: string; at: string | null };
  covered: boolean;
  // Предмет события закрыт для читателя: причины нет, решение по нему не принимается (R13-02).
  restricted: boolean;
  reason: string | null;
  resolvedBy: IActor | null;
  resolvedAt: string | null;
  etag: string;
}

export interface IHistoryEntry {
  at: string;
  action: string;
  actor: IActor | null;
  basis: string | null;
  ref: { type: string; id: string } | null;
}

export interface ICandidateBrief {
  id: string;
  seq: number;
  mode: 'test' | 'production';
  status: TCandidateStatus;
  createdAt: string;
  finishedAt: string | null;
  createdBy: { id: string; name: string };
  restricted: boolean;
  current: boolean;
  failureCode: string | null;
}

export interface ICandidateCheck {
  ordinal: number;
  code: string;
  outcome: 'passed' | 'failed' | 'unverified' | 'not_applicable';
  path: string | null;
  detail: string | null;
}

export interface ICandidateFile {
  id: string;
  path: string;
  role: 'document' | 'attachment';
  audience: 'customer' | 'internal';
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  previewFileId: string | null;
}

export interface ICandidatePreview {
  id: string;
  path: string;
  sourceFileId: string;
  sizeBytes: number;
  sha256: string;
  pages: number | null;
  fonts: string[] | null;
}

export interface ICandidateView {
  id: string;
  stageId: string;
  tenderId: string;
  seq: number;
  mode: 'test' | 'production';
  status: TCandidateStatus;
  createdAt: string;
  finishedAt: string | null;
  createdBy: { id: string; name: string };
  supersededBy: string | null;
  restricted: boolean;
  inputs?: {
    calculationRevision: { id: string; seq: number; kind: string };
    evidenceScopeId: string;
    reviewRun: { id: string; status: string } | null;
    decisions: number;
    drafts: { id: string; title: string; templateName: string; revisionSeq: number; isDemo: boolean }[];
    attachments: { revisionId: string; title: string; fileName: string; seq: number }[];
    fieldVersions: number;
    baselines: { calculation: number; content: number };
    inputsSha256: string;
  };
  failure?: { code: string; detail: string } | null;
  converterVersion?: string | null;
  contentHash?: string | null;
  checks?: ICandidateCheck[];
  files?: ICandidateFile[];
  previews?: ICandidatePreview[];
  notes?: string[];
  knownProductionBlockers?: string[];
  eventsAfter?: { seq: number; type: string; at: string | null; affects: boolean }[];
  eventsAfterTotal?: number;
  current?: boolean;
  etag: string;
  // Этап 13: оценка матрицы для согласования и выпуска (подсказка; разрешение даёт команда), состояние согласования.
  gate?: {
    approve: IGateView | null;
    release: IGateView | null;
    warnings: {
      draftQuestions: { id: string; title: string }[];
      emptyOptionalFields: { draftTitle: string; fieldKey: string; label: string }[];
      reviewRisks: { findingId: string; kind: string; severity: string; title: string; reason: string; acceptedBy: string | null; acceptedAt: string | null }[];
    } | null;
  };
  approval?: IApprovalView | null;
  approvals?: IApprovalView[];
  release?: IReleaseView | null;
  returned?: { reason: string | null; restricted: boolean; holdId: string | null; returnedBy: IActor; returnedAt: string } | null;
  holds?: { open: number; total: number; resolved: IHoldView[] };
  can?: { approve: boolean; acceptRisk: boolean; resolveHolds: boolean; release: boolean };
}

export interface IStandardAttachment {
  revisionId: string;
  attachmentId: string;
  scopeTenderId: string | null;
  title: string;
  seq: number;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  audience: 'customer' | 'internal';
  status: 'draft' | 'approved' | 'retired';
  createdAt: string | null;
  approvedAt: string | null;
  etag: string;
  canManage: boolean;
}
