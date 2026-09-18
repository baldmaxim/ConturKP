// Типы контракта портального API /api/v1 (этап 02).

export type TGlobalRole = 'admin' | 'manager' | 'engineer';
export type TMemberRole = 'engineer' | 'manager';
export type TTenderStatus = 'active' | 'archived';
export type TStageStatus = 'active' | 'archived';
export type TUserStatus = 'active' | 'disabled';
export type TPrincipalKind = 'human' | 'model_via_mcp' | 'integration' | 'system' | 'anonymous';
export type TAuditOutcome = 'allowed' | 'denied' | 'failed';

/** Глобальные возможности пользователя. */
export type TGlobalCapability = 'admin.users' | 'admin.tender' | 'admin.audit';

/** Возможности пользователя в конкретном тендере. */
export type TTenderCapability = 'tender.read' | 'stage.write' | 'stage.manage' | 'audit.read' | 'admin.tender';

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
