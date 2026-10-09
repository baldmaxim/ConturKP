// Типы этапа 14 (D-034; portal-api §2.10): назначения размещения и доставки выпуска.

export type TDeliveryKind = 'yandex_disk' | 'smb';
export type TDeliveryStatus = 'pending' | 'staging' | 'committing' | 'verifying' | 'delivered' | 'failed' | 'outcome_unknown' | 'conflict' | 'superseded';
export type TCloudState = 'not_applicable' | 'unconfirmed' | 'confirmed';

export interface IDeliveryFile {
  path: string;
  kind: 'file' | 'manifest' | 'marker';
  size: number;
  sha256: string;
  remoteState: 'absent' | 'staged' | 'committed' | 'verified' | 'conflict' | 'unknown';
  checkedAt: string | null;
}

export interface IDeliveryView {
  id: string;
  releaseId: string;
  destination: { id: string; title: string; kind: TDeliveryKind; environment: 'test' | 'production'; version: number };
  targetFolder: string;
  fileSet: 'customer' | 'all';
  status: TDeliveryStatus;
  attemptCount: number;
  lastError: { code: string; detail: string | null } | null;
  supersededBy: string | null;
  deliveredAt: string | null;
  cloud: { state: TCloudState; confirmedBy: string | null; confirmedAt: string | null; note: string | null } | null;
  files: IDeliveryFile[];
  attempts: { seq: number; startedAt: string; finishedAt: string; outcome: string; errorCode: string | null; detail: string | null }[];
  events: { action: string; actor: string | null; reason: string | null; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
  etag: string;
  actions: { retry: boolean; resolveConflict: boolean; redirect: boolean; confirmCloud: boolean };
}

export interface IReleaseDeliveries {
  items: IDeliveryView[];
  summary: { total: number; delivered: number; cloudTotal: number; cloudConfirmed: number; missing: number };
  canPlace: boolean;
}

export interface IDestinationVersion {
  id: string;
  version: number;
  rootPath: string;
  stagingPath: string;
  includeInternal: boolean;
  reason: string;
  createdBy: { id: string; name: string };
  createdAt: string;
}

export interface IDestinationView {
  id: string;
  title: string;
  kind: TDeliveryKind;
  environment: 'test' | 'production';
  active: boolean;
  rowVersion: number;
  etag: string;
  current: IDestinationVersion;
  versions: IDestinationVersion[];
  lastProbe: { version: number; current: boolean; outcome: 'ok' | 'failed'; errorCode: string | null; detail: string | null; requestedBy: string; checkedAt: string } | null;
  probePending: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IDestinationInput {
  rootPath: string;
  stagingPath: string | null;
  includeInternal: boolean;
  reason: string;
}
