// Типы комплекта-кандидата выпуска и стандартных вложений (этап 12; D-032; portal-api §2.9).

export type TCandidateStatus = 'assembling' | 'assembly_failed' | 'ready_for_approval' | 'superseded';

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
  current?: boolean;
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
