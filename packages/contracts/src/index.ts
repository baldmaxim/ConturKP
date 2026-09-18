// Схемы запросов и ответов API этапа 02 (docs/contracts/portal-api.md §2.1–2.2).
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));

export const ROLE = z.enum(['admin', 'manager', 'engineer']);
export const MEMBER_ROLE = z.enum(['engineer', 'manager']);
export const LOGIN = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/, 'логин: латиница, цифры, . _ -, от 2 символов');
const ISO_UTC = z.iso.datetime({ offset: true });

export const LoginRequest = z.object({ login: z.string().trim().toLowerCase().min(1).max(64), password: z.string().min(1).max(1024) }).strict();

export const ChangePasswordRequest = z
  .object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(1024) })
  .strict();

export const CreateUserRequest = z
  .object({
    login: LOGIN,
    displayName: text(200),
    roles: z.array(ROLE).min(1).max(3),
    password: z.string().min(12).max(1024),
  })
  .strict();

export const PatchUserRequest = z
  .object({
    displayName: text(200).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    roles: z.array(ROLE).max(3).optional(),
  })
  .strict();

export const ResetPasswordRequest = z.object({ password: z.string().min(12).max(1024) }).strict();

export const CreateTenderRequest = z
  .object({ code: text(64), title: text(500), customerName: optionalText(500), objectName: optionalText(500) })
  .strict();

export const PatchTenderRequest = z
  .object({
    title: text(500).optional(),
    customerName: optionalText(500),
    objectName: optionalText(500),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export const PutMemberRequest = z.object({ memberRole: MEMBER_ROLE }).strict();

export const CreateStageRequest = z
  .object({ title: text(500), submissionDeadline: ISO_UTC.nullable().optional() })
  .strict();

export const PatchStageRequest = z
  .object({ title: text(500).optional(), submissionDeadline: ISO_UTC.nullable().optional() })
  .strict();

export const AuditQuery = z.object({
  cursor: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---- ответы

export interface IMe {
  id: string;
  login: string;
  displayName: string;
  roles: string[];
  capabilities: string[];
  memberships: { tenderId: string; memberRole: string }[];
}

export interface IUser {
  id: string;
  login: string;
  displayName: string;
  status: 'active' | 'disabled';
  roles: string[];
  rowVersion: number;
  createdAt: string;
}

export interface ITender {
  id: string;
  code: string;
  title: string;
  customerName: string | null;
  objectName: string | null;
  status: 'active' | 'archived';
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  myRole: 'engineer' | 'manager' | null;
  capabilities: string[];
}

export interface IMember {
  userId: string;
  login: string;
  displayName: string;
  memberRole: 'engineer' | 'manager';
  assignedAt: string;
  assignedBy: { id: string; displayName: string } | null;
}

export interface IStage {
  id: string;
  tenderId: string;
  seq: number;
  title: string;
  submissionDeadline: string | null;
  status: 'active' | 'archived';
  inputVersion: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface IAuditEvent {
  id: string;
  occurredAt: string;
  actor: { id: string; login: string; displayName: string } | null;
  principalKind: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: 'allowed' | 'denied' | 'failed';
  details: Record<string, unknown>;
}

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PRECONDITION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface IProblem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  requestId: string;
  current?: unknown;
  errors?: { path: string; message: string }[];
}
