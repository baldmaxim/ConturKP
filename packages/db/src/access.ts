// Контекст доступа (ADR-006 §6): каждый репозиторий данных тендера принимает его первым
// аргументом, поэтому запрос без контекста не компилируется. Контекст читается из БД
// на каждый запрос: снятие роли или назначения действует сразу.
import { effectiveContractCapabilities, effectiveMailCapabilities, hasContentRole, rolePermission, resolveAccessRoles, filterRoleCapabilities, type AccessRoles, type ContractCapability, type MailCapability, type MemberRole, type Role } from '@kontur/core';
import { createHash } from 'node:crypto';
import type { Queryable } from './pool.ts';

export interface IPrincipal {
  userId: string;
  kind: 'human';
  login: string;
  displayName: string;
}

export interface IAccessContext {
  readonly principal: IPrincipal;
  readonly roles: AccessRoles;
  readonly assignedRoles?: readonly string[];
  // Только действующие назначения (без снятых).
  readonly memberships: ReadonlyMap<string, MemberRole>;
  // Действующие (не отозванные) выдачи по договорам и глобальная выдача contract.create (D-022 OD-2).
  // Сами по себе права не дают: действуют только при роли инженера или руководителя (contractCaps).
  readonly contractGrants: ReadonlyMap<string, ReadonlySet<ContractCapability>>;
  readonly contractCreateGranted: boolean;
  // Действующие выдачи по почтовым ящикам (D-025, OD-07-3): как у договора — только при роли инженера
  // или руководителя (mailCaps). Связь письма с тендером права читать не даёт.
  readonly mailGrants: ReadonlyMap<string, ReadonlySet<MailCapability>>;
  // Общая область ПРОСМОТРА руководителя на текущий запрос. Реальные назначения/выдачи не меняются.
  readonly managerScope?: { tenderIds: readonly string[]; contractIds: readonly string[]; mailboxIds: readonly string[] };
  readonly requestId: string;
}

interface IUserRow {
  id: string;
  login: string;
  display_name: string;
  roles: Role[] | null;
  assigned_roles: string[];
  permissions: string[];
}

export const loadAccessContext = async (
  db: Queryable,
  userId: string,
  requestId: string,
): Promise<IAccessContext | null> => {
  const u = await db.query<IUserRow>(
    `SELECT u.id, u.login, u.display_name,
            array_agg(r.role) FILTER (WHERE r.role IS NOT NULL) AS roles,
            ARRAY(SELECT ur.role FROM user_role ur WHERE ur.user_id = u.id ORDER BY ur.role) AS assigned_roles,
            user_role_permissions(u.id) AS permissions
       FROM app_user u
       LEFT JOIN effective_user_role r ON r.user_id = u.id
      WHERE u.id = $1 AND u.kind = 'human' AND u.status = 'active'
      GROUP BY u.id`,
    [userId],
  );
  const row = u.rows[0];
  if (!row) return null;
  const m = await db.query<{ tender_id: string; member_role: MemberRole }>(
    'SELECT tender_id, member_role FROM tender_member WHERE user_id = $1 AND removed_at IS NULL',
    [userId],
  );
  const g = await db.query<{ contract_id: string | null; capability: string }>(
    'SELECT contract_id, capability FROM contract_access WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  const mg = await db.query<{ mailbox_id: string; capability: MailCapability }>(
    'SELECT mailbox_id, capability FROM mail_access WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  const mailGrants = new Map<string, Set<MailCapability>>();
  for (const r of mg.rows) {
    const set = mailGrants.get(r.mailbox_id) ?? new Set<MailCapability>();
    set.add(r.capability);
    mailGrants.set(r.mailbox_id, set);
  }
  const grants = new Map<string, Set<ContractCapability>>();
  for (const r of g.rows) {
    if (r.contract_id === null) continue;
    const set = grants.get(r.contract_id) ?? new Set<ContractCapability>();
    set.add(r.capability as ContractCapability);
    grants.set(r.contract_id, set);
  }
  const roles = resolveAccessRoles(row.roles ?? [], row.permissions);
  const allTenders = rolePermission(roles, 'tender.read.all') && rolePermission(roles, 'tender.read');
  const allContracts = rolePermission(roles, 'contract.read.all') && rolePermission(roles, 'contract.read');
  const allMailboxes = rolePermission(roles, 'mail.read.all') && rolePermission(roles, 'mail.read');
  const managerScope = allTenders || allContracts || allMailboxes
    ? (await db.query<{ tenderIds: string[]; contractIds: string[]; mailboxIds: string[] }>(
      `SELECT ARRAY(SELECT id FROM tender WHERE $1::boolean ORDER BY id) AS "tenderIds",
              ARRAY(SELECT id FROM contract WHERE $2::boolean ORDER BY id) AS "contractIds",
              ARRAY(SELECT id FROM mailbox WHERE $3::boolean ORDER BY id) AS "mailboxIds"`,
      [allTenders, allContracts, allMailboxes],
    )).rows[0]
    : undefined;
  return {
    principal: { userId: row.id, kind: 'human', login: row.login, displayName: row.display_name },
    roles,
    assignedRoles: row.assigned_roles,
    memberships: new Map(m.rows.map((r) => [r.tender_id, r.member_role])),
    contractGrants: grants,
    contractCreateGranted: g.rows.some((r) => r.contract_id === null && r.capability === 'contract.create'),
    mailGrants,
    ...(managerScope ? { managerScope } : {}),
    requestId,
  };
};

// Отпечаток прав пользователя: роли, действующие назначения, выдачи по договорам и почтовым ящикам. Любое изменение прав
// (отзыв `mail.read`, снятие назначения, роль, доступ к договору) меняет отпечаток. Им запись идемпотентности привязана к
// правам, с которыми был построен сохранённый ответ (S15-14, D-036).
export const accessFingerprint = (ctx: IAccessContext): string => {
  const pairs = <V>(m: ReadonlyMap<string, V>, value: (v: V) => unknown): [string, unknown][] => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, value(v)]);
  const snapshot = {
    roles: [...ctx.roles].sort(),
    assignedRoles: [...ctx.assignedRoles ?? []].sort(),
    permissions: ctx.roles.permissions ? [...ctx.roles.permissions].sort() : null,
    memberships: pairs(ctx.memberships, (role) => role),
    contractGrants: pairs(ctx.contractGrants, (caps) => [...caps].sort()),
    contractCreateGranted: ctx.contractCreateGranted,
    mailGrants: pairs(ctx.mailGrants, (caps) => [...caps].sort()),
  };
  return createHash('sha256').update(`kontur.access.v3\n${JSON.stringify(snapshot)}`, 'utf8').digest('hex');
};

export const memberRoleOf = (ctx: IAccessContext, tenderId: string): MemberRole | null =>
  ctx.memberships.get(tenderId) ?? null;

// Все тендеры для просмотра руководителем и действующие назначения остальных пользователей.
export const contentTenderIds = (ctx: IAccessContext): string[] => !rolePermission(ctx.roles, 'tender.read', true) ? [] : [...new Set([
  ...(rolePermission(ctx.roles, 'tender.read.all', ctx.roles.has('manager')) ? ctx.managerScope?.tenderIds ?? [] : []),
  ...[...ctx.memberships.entries()].filter(([, role]) => ctx.roles.has(role)).map(([id]) => id),
])];

// Действующие возможности пользователя по договору: выдача и роль инженера или руководителя.
export const contractCaps = (ctx: IAccessContext, contractId: string): ContractCapability[] =>
  effectiveContractCapabilities(ctx.roles, ctx.contractGrants.get(contractId));

export const canCreateContract = (ctx: IAccessContext): boolean => ctx.contractCreateGranted && hasContentRole(ctx.roles) && filterRoleCapabilities(ctx.roles, ['contract.create']).length > 0;

// Договоры, содержимое которых пользователь читает сейчас (contract.read). Включение единицы договора
// в снимок права не даёт (D-022 OD-3): чтение единицы договора всегда проверяется по этому списку.
export const readableContractIds = (ctx: IAccessContext): string[] =>
  [...new Set([...(rolePermission(ctx.roles, 'contract.read.all', ctx.roles.has('manager')) && rolePermission(ctx.roles, 'contract.read', true) ? ctx.managerScope?.contractIds ?? [] : []),
    ...[...ctx.contractGrants.keys()].filter((id) => contractCaps(ctx, id).includes('contract.read'))])];

// Договоры, карточка которых пользователю видна (любая действующая выдача).
export const grantedContractIds = (ctx: IAccessContext): string[] =>
  [...new Set([...(rolePermission(ctx.roles, 'contract.read.all', ctx.roles.has('manager')) && rolePermission(ctx.roles, 'contract.read', true) ? ctx.managerScope?.contractIds ?? [] : []),
    ...[...ctx.contractGrants.keys()].filter((id) => contractCaps(ctx, id).length > 0)])];

// Действующие возможности пользователя по ящику: выдача и роль инженера или руководителя.
export const mailCaps = (ctx: IAccessContext, mailboxId: string): MailCapability[] =>
  effectiveMailCapabilities(ctx.roles, ctx.mailGrants.get(mailboxId));

// Ящики, письма которых пользователь читает сейчас (mail.read). Связь с тендером и включение письма
// в снимок права не дают: чтение письма всегда проверяется по этому списку (D-025).
export const readableMailboxIds = (ctx: IAccessContext): string[] =>
  mailboxIdsWith(ctx, 'mail.read');

// Ящики, в которых у пользователя есть заданная возможность.
export const mailboxIdsWith = (ctx: IAccessContext, cap: MailCapability): string[] =>
  [...new Set([...(cap === 'mail.read' && rolePermission(ctx.roles, 'mail.read.all', ctx.roles.has('manager')) && rolePermission(ctx.roles, 'mail.read', true) ? ctx.managerScope?.mailboxIds ?? [] : []),
    ...[...ctx.mailGrants.keys()].filter((id) => mailCaps(ctx, id).includes(cap))])];
