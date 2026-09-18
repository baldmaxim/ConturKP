// Преобразование строк БД в ответы API.
import type { IAuditEvent, IMember, IStage, ITender, IUser } from '@kontur/contracts';
import { tenderCapabilities } from '@kontur/core';
import type { IAccessContext, IAuditEventRow, IMemberRow, IStageRow, ITenderRow, IUserRow } from '@kontur/db';

export const toUser = (u: IUserRow): IUser => ({
  id: u.id,
  login: u.login,
  displayName: u.display_name,
  status: u.status,
  roles: u.roles,
  rowVersion: u.row_version,
  createdAt: u.created_at.toISOString(),
});

export const toTender = (ctx: IAccessContext, t: ITenderRow): ITender => ({
  id: t.id,
  code: t.code,
  title: t.title,
  customerName: t.customer_name,
  objectName: t.object_name,
  status: t.status,
  rowVersion: t.row_version,
  createdAt: t.created_at.toISOString(),
  updatedAt: t.updated_at.toISOString(),
  myRole: t.member_role,
  capabilities: tenderCapabilities(ctx.roles, t.member_role),
});

export const toMember = (m: IMemberRow): IMember => ({
  userId: m.user_id,
  login: m.login,
  displayName: m.display_name,
  memberRole: m.member_role,
  assignedAt: m.assigned_at.toISOString(),
  assignedBy: m.assigned_by_id ? { id: m.assigned_by_id, displayName: m.assigned_by_name ?? '' } : null,
});

export const toStage = (s: IStageRow): IStage => ({
  id: s.id,
  tenderId: s.tender_id,
  seq: s.seq,
  title: s.title,
  submissionDeadline: s.submission_deadline ? s.submission_deadline.toISOString() : null,
  status: s.status,
  inputVersion: s.input_version,
  rowVersion: s.row_version,
  createdAt: s.created_at.toISOString(),
  updatedAt: s.updated_at.toISOString(),
});

export const toAuditEvent = (e: IAuditEventRow): IAuditEvent => ({
  id: e.id,
  occurredAt: e.occurred_at.toISOString(),
  actor: e.actor_id ? { id: e.actor_id, login: e.actor_login ?? '', displayName: e.actor_display_name ?? '' } : null,
  principalKind: e.principal_kind,
  action: e.action,
  entityType: e.entity_type,
  entityId: e.entity_id,
  outcome: e.outcome,
  details: e.details,
});
