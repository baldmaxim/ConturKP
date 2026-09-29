// Типы договорного контура (этап 06a; portal-api §2.6, D-017, D-022, D-023).

export type TContractCapability = 'contract.read' | 'contract.link' | 'contract.manage';
export type TContractRole = 'contract' | 'addendum' | 'appendix';
export type TContractStatus = 'active' | 'archived';

export interface IContract {
  id: string;
  number: string;
  title: string;
  status: TContractStatus;
  createdBy: { id: string; displayName: string };
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  rowVersion: number;
  capabilities: TContractCapability[];
  /** Без contract.read — только административные метаданные: содержательные поля пусты. */
  restricted: boolean;
  counterparty: string | null;
  signedOn: string | null;
}

export interface IContractList {
  items: IContract[];
  canCreate: boolean;
  isContractAdmin: boolean;
}

export interface IContractCreateInput {
  number: string;
  title: string;
  counterparty?: string | null;
  signedOn?: string | null;
}

export interface IContractPatch {
  number?: string;
  title?: string;
  counterparty?: string | null;
  signedOn?: string | null;
}

export interface IContractGrant {
  id: string;
  userId: string;
  login: string;
  displayName: string;
  userRoles: string[];
  capability: TContractCapability | 'contract.create';
  source: 'admin' | 'creator';
  grantedBy: { id: string; displayName: string };
  grantedAt: string;
}

export interface IContractGrants {
  items: IContractGrant[];
  contractRowVersion?: number;
}

export interface IContractLink {
  id: string;
  contractId: string;
  contract: { number: string; title: string; status: TContractStatus; capabilities: TContractCapability[] };
  tenderId: string;
  tender: { code: string; title: string };
  stageId: string | null;
  stageTitle: string | null;
  note: string | null;
  status: 'active' | 'archived';
  confirmedBy: { id: string; displayName: string };
  confirmedAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
  rowVersion: number;
  updatedAt: string;
}

export interface IContractDocument {
  id: string;
  contractId: string;
  title: string;
  role: TContractRole;
  mainDocumentId: string | null;
  revisions: number;
  latestRevision: { id: string; seq: number; receivedAt: string; mediaType: string; sizeBytes: number; runStatus: string | null };
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface IContractRevision {
  id: string;
  documentId: string;
  seq: number;
  supersedesRevisionId: string | null;
  receivedAt: string;
  sizeBytes: number;
  mediaType: string;
  sha256: string;
}

export interface IContractDocumentDetail extends IContractDocument {
  revisionList: IContractRevision[];
}

export interface IContractUploadResult {
  status: 'registered' | 'duplicate';
  documentId: string;
  revisionId: string;
  revisionSeq: number;
  document: IContractDocument;
}

export interface IContractCandidate {
  contractId: string;
  contractNumber: string;
  contractTitle: string;
  documentId: string;
  documentTitle: string;
  role: TContractRole;
  documentRevisionId: string;
  revisionSeq: number;
  runStatus: string | null;
}
