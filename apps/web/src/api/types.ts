// Типы контракта портального API /api/v1 (этапы 02–03).

export type TGlobalRole = 'admin' | 'manager' | 'engineer';
export type TMemberRole = 'engineer' | 'manager';
export type TTenderStatus = 'active' | 'archived';
export type TStageStatus = 'active' | 'archived';
export type TUserStatus = 'active' | 'disabled';
export type TPrincipalKind = 'human' | 'model_via_mcp' | 'integration' | 'system' | 'anonymous';
export type TAuditOutcome = 'allowed' | 'denied' | 'failed';

/** Глобальные возможности пользователя. */
export type TGlobalCapability = 'admin.users' | 'admin.tender' | 'admin.audit' | 'admin.intake';

/** Возможности пользователя в конкретном тендере. */
export type TTenderCapability =
  | 'tender.read'
  | 'stage.write'
  | 'stage.manage'
  | 'audit.read'
  | 'admin.tender'
  | 'source.write'
  | 'hold.resolve';

export interface IMembership {
  tenderId: string;
  memberRole: TMemberRole;
}

export interface IMe {
  id: string;
  login: string;
  displayName: string;
  roles: TGlobalRole[];
  capabilities: string[];
  memberships: IMembership[];
}

export interface ITender {
  id: string;
  code: string;
  title: string;
  customerName: string | null;
  objectName: string | null;
  status: TTenderStatus;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  myRole: TMemberRole | null;
  capabilities: string[];
}

export interface ITenderCreateInput {
  code: string;
  title: string;
  customerName?: string;
  objectName?: string;
}

export interface ITenderPatch {
  title?: string;
  customerName?: string | null;
  objectName?: string | null;
  status?: TTenderStatus;
}

export interface IUserRef {
  id: string;
  displayName: string;
}

export interface IMember {
  userId: string;
  login: string;
  displayName: string;
  memberRole: TMemberRole;
  assignedAt: string;
  assignedBy: IUserRef | null;
}

export interface IMembersResponse {
  items: IMember[];
  tenderRowVersion: number;
}

export interface IStage {
  id: string;
  tenderId: string;
  seq: number;
  title: string;
  /** ISO 8601 в UTC. */
  submissionDeadline: string | null;
  status: TStageStatus;
  inputVersion: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface IStageCreateInput {
  title: string;
  submissionDeadline?: string | null;
}

export interface IStagePatch {
  title?: string;
  submissionDeadline?: string | null;
}

export interface IAuditActor {
  id: string;
  login: string;
  displayName: string;
}

export interface IAuditEvent {
  id: string;
  occurredAt: string;
  actor: IAuditActor | null;
  principalKind: TPrincipalKind;
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: TAuditOutcome;
  details: Record<string, unknown>;
}

export interface IAuditPage {
  items: IAuditEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface IUser {
  id: string;
  login: string;
  displayName: string;
  status: TUserStatus;
  roles: string[];
  rowVersion: number;
  createdAt: string;
}

export interface IUserCreateInput {
  login: string;
  displayName: string;
  roles: TGlobalRole[];
  password: string;
}

export interface IUserPatch {
  displayName?: string;
  status?: TUserStatus;
  roles?: TGlobalRole[];
}

export interface IListResponse<T> {
  items: T[];
}

export type TProblemCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PRECONDITION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'STATE_CONFLICT'
  | 'INTERNAL';

export interface IProblemFieldError {
  path: string;
  message: string;
}

/** Ответ об ошибке application/problem+json. */
export interface IProblem {
  type: string;
  title: string;
  status: number;
  code: TProblemCode | string;
  detail?: string;
  requestId: string;
  current?: unknown;
  errors?: IProblemFieldError[];
}

// ---- Источники (этап 03)

export type TBatchStatus = 'running' | 'completed' | 'completed_with_errors' | 'failed';
export type TBatchSourceKind = 'upload' | 'watched_folder';
export type TItemStatus = 'pending' | 'registered' | 'duplicate' | 'rejected' | 'skipped_partial';
export type TRejectReason = 'path_traversal' | 'size_limit' | 'type_not_allowed' | 'unstable_file' | 'corrupt';
export type TItemResolution = 'none' | 'reimported' | 'not_applicable';
export type TOccurrenceKind = 'upload' | 'archive_member' | 'watched_folder' | 'yandex_disk' | 'smb' | 'rdweb_export';
export type TDocType = 'tz' | 'pd' | 'rd' | 'contract' | 'boq' | 'qa_form' | 'letter' | 'minutes' | 'supplier_quote' | 'other';
export type TSourceSetStatus = 'draft' | 'frozen';
export type TInclusion = 'included' | 'excluded_not_applicable';
export type TChannelOrigin = 'local' | 'yandex_disk' | 'smb';
export type TChannelErrorCode = 'share_unavailable' | 'outside_intake_root' | 'intake_root_not_configured' | 'overlaps_storage' | 'internal';

export interface IBatchCounts {
  total: number;
  pending: number;
  registered: number;
  duplicate: number;
  rejected: number;
  /** Отклонённые и недокопированные элементы без исхода. */
  unresolved: number;
}

export interface IImportBatch {
  id: string;
  tenderId: string;
  stageId: string | null;
  sourceKind: TBatchSourceKind;
  intakeChannelId: string | null;
  status: TBatchStatus;
  uploadName: string | null;
  failureCode: string | null;
  expanded: boolean;
  createdAt: string;
  completedAt: string | null;
  counts: IBatchCounts;
}

export interface IImportItem {
  id: string;
  batchId: string;
  memberPath: string;
  observedName: string;
  status: TItemStatus;
  rejectReason: TRejectReason | null;
  rejectDetail: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  documentRevisionId: string | null;
  resolution: TItemResolution;
  resolvedByItemId: string | null;
  resolutionDecisionId: string | null;
  resolvedAt: string | null;
  rowVersion: number;
}

export interface IImportBatchDetail extends IImportBatch {
  items: IImportItem[];
  /** Задания разбора партии по статусам. */
  jobs: Record<string, number>;
}

export type TResolveItemInput =
  | { resolution: 'reimported'; resolvedByItemId: string }
  | { resolution: 'not_applicable'; reason: string };

export interface IDocument {
  id: string;
  tenderId: string;
  title: string;
  docType: TDocType;
  docCode: string | null;
  scopeNote: string | null;
  revisions: number;
  latestRevisionId: string | null;
  latestReceivedAt: string | null;
  rowVersion: number;
  updatedAt: string;
}

export interface IOccurrence {
  id: string;
  sourceKind: TOccurrenceKind;
  sourceLocator: string;
  observedName: string;
  observedAt: string;
  importItemId: string | null;
  intakeChannelId: string | null;
}

export interface IRevision {
  id: string;
  documentId: string;
  revisionSeq: number;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  supersedesRevisionId: string | null;
  receivedAt: string;
  occurrences: IOccurrence[];
}

export interface IDocumentDetail extends IDocument {
  revisionList: IRevision[];
}

export interface IDocumentPatch {
  title?: string;
  docType?: TDocType;
  docCode?: string | null;
  scopeNote?: string | null;
}

export interface ISourceSetRevision {
  id: string;
  sourceSetId: string;
  stageId: string;
  seq: number;
  status: TSourceSetStatus;
  baseRevisionId: string | null;
  contentHash: string | null;
  rowVersion: number;
  updatedAt: string;
}

export interface ISourceSetLatestItem {
  documentRevisionId: string;
  documentId: string;
  documentTitle: string;
  revisionSeq: number;
  inclusion: TInclusion;
  reason: string | null;
}

export interface ISourceSet {
  id: string;
  purpose: string;
  revisions: ISourceSetRevision[];
  latestItems: ISourceSetLatestItem[];
}

export interface ISourceSetItemInput {
  documentRevisionId: string;
  inclusion: TInclusion;
  reason?: string | null;
}

export interface IStageInputEvent {
  id?: string;
  seq: number;
  eventType: string;
  refType: string | null;
  refId: string | null;
  actorKind: string;
  createdAt: string;
}

export interface IStageInputEvents {
  inputVersion: number;
  items: IStageInputEvent[];
}

export interface IIntakeChannel {
  id: string;
  tenderId: string;
  kind: 'watched_folder';
  origin: TChannelOrigin;
  locator: string;
  active: boolean;
  freshnessSeconds: number;
  scanIntervalSeconds: number;
  lastScanStartedAt: string | null;
  lastSuccessfulScanAt: string | null;
  lastErrorCode: TChannelErrorCode | string | null;
  lastErrorAt: string | null;
  pendingUnstable: number;
  /** Свежесть: последний успешный скан в пределах окна. */
  current: boolean;
  disabledReason: string | null;
  rowVersion: number;
}

export interface IIntakeChannelCreateInput {
  origin: TChannelOrigin;
  locator: string;
  freshnessSeconds?: number;
  scanIntervalSeconds?: number;
}

export interface IIntakeChannelPatch {
  origin?: TChannelOrigin;
  locator?: string;
  freshnessSeconds?: number;
  scanIntervalSeconds?: number;
  active?: boolean;
  disabledReason?: string;
}

export interface IScanAccepted {
  jobId: string;
  created: boolean;
}

// ---- распознавание и доказательства (этап 04)

export type TRecognitionStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
export type TRecognitionPageStatus = 'recognized' | 'missing' | 'failed';
export type TFragmentOrigin = 'document_text' | 'recognized_text' | 'model_description' | 'negotiation_speech' | 'negotiation_hint' | 'email_body' | 'attachment_text';
export type TFragmentKind =
  | 'text_block'
  | 'image_block'
  | 'stamp_block'
  | 'unknown_block'
  | 'summary'
  | 'description'
  | 'entities'
  | 'verification'
  | 'unknown_section';
export type TBboxSpace = 'page_unrotated' | 'page_rotated';

export interface IRecognitionRun {
  id: string;
  documentRevisionId: string;
  documentId: string;
  tenderId: string;
  engine: string;
  engineSchemaVersion: string | null;
  sourceArtifactSha256: string;
  sourceArtifactName: string | null;
  status: TRecognitionStatus;
  pagesTotal: number | null;
  pagesRecognized: number;
  supersedesRunId: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  contentUrl: string;
}

export interface IRecognitionRunAccepted extends IRecognitionRun {
  /** true — архив уже импортировался: второго прогона той же пары не создаётся. */
  reused: boolean;
}

export interface IRecognitionPage {
  pageIndex: number;
  pageLabel: string | null;
  /** Номер листа из штампа: это НЕ номер страницы файла. */
  sheetLabel: string | null;
  widthPx: number | null;
  heightPx: number | null;
  rotation: number;
  status: TRecognitionPageStatus;
}

export interface IRecognitionWarning {
  code: string;
  count: number;
  sample: string;
}

export interface IRecognitionQuality {
  documentName?: string | null;
  coordinateSpace?: string;
  counts?: Record<string, number>;
  warnings?: IRecognitionWarning[];
  archive?: { pdfMember: string | null; extras: string[]; ignored: string[] };
}

export interface IRecognitionRunDetail extends IRecognitionRun {
  supersededByRunId: string | null;
  quality: IRecognitionQuality;
  missingPages: number[];
  pages: IRecognitionPage[];
}

export interface IEvidenceFragment {
  id: string;
  runId: string | null;
  documentRevisionId: string | null;
  origin: TFragmentOrigin;
  fragmentKind: TFragmentKind;
  externalBlockId: string | null;
  ordinal: number | null;
  pageIndex: number | null;
  bboxNorm: number[] | null;
  bboxSpace: TBboxSpace | null;
  shapeType: 'rectangle' | 'polygon' | null;
  polygonNorm: number[] | null;
  rotation: number | null;
  text: string;
  textSha256: string;
  derivedModelRef: string | null;
  /** Справочная ссылка экспорта. Портал её не загружает — показывается текстом (A38). */
  externalCropUrl: string | null;
  warnings: string[];
  /** Часть длинного текста блока: доказательство разбито, а не усечено. */
  partIndex: number;
  partTotal: number;
}

export interface IFragmentPage {
  items: IEvidenceFragment[];
  nextCursor: string | null;
}

export interface IEvidenceDetail extends IEvidenceFragment {
  tenderId: string;
  documentId: string | null;
  runStatus: TRecognitionStatus | null;
  pageLabel: string | null;
  sheetLabel: string | null;
  pageWidthPx: number | null;
  pageHeightPx: number | null;
  pageStatus: TRecognitionPageStatus | null;
  contentUrl: string | null;
}

export interface IFreezeBlockingItem {
  documentRevisionId: string;
  documentId: string;
  documentTitle: string;
  revisionSeq: number;
  reason: 'no_recognition' | 'recognition_in_progress' | 'recognition_failed' | 'recognition_cancelled';
}
