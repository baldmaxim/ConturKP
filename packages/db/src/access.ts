// Контекст доступа (ADR-006 §6): каждый репозиторий данных тендера принимает его первым
// аргументом, поэтому запрос без контекста не компилируется. Контекст читается из БД
// на каждый запрос: снятие роли или назначения действует сразу.
import { effectiveContractCapabilities, effectiveMailCapabilities, hasContentRole, type ContractCapability, type MailCapability, type MemberRole, type Role } from '@kontur/core';
import type { Queryable } from './pool.ts';

export interface IPrincipal {
  userId: string;
  kind: 'human';
  login: string;
  displayName: string;
}

export interface IAccessContext {
  readonly principal: IPrincipal;
  readonly roles: ReadonlySet<Role>;
  // Только действующие назначения (без снятых).
  readonly memberships: ReadonlyMap<string, MemberRole>;
  // Действующие (не отозванные) выдачи по договорам и глобальная выдача contract.create (D-022 OD-2).
  // Сами по себе права не дают: действуют только при роли инженера или руководителя (contractCaps).
  readonly contractGrants: ReadonlyMap<string, ReadonlySet<ContractCapability>>;
  readonly contractCreateGranted: boolean;
  // Действующие выдачи по почтовым ящикам (D-025, OD-07-3): как у договора — только при роли инженера
  // или руководителя (mailCaps). Связь письма с тендером права читать не даёт.
  readonly mailGrants: ReadonlyMap<string, ReadonlySet<MailCapability>>;
  readonly requestId: string;
}

interface IUserRow {
  id: string;
  login: string;
  display_name: string;
  roles: Role[] | null;
}

export const loadAccessContext = async (
  db: Queryable,
  userId: string,
  requestId: string,
): Promise<IAccessContext | null> => {
  const u = await db.query<IUserRow>(
    `SELECT u.id, u.login, u.display_name,
            array_agg(r.role) FILTER (WHERE r.role IS NOT NULL) AS roles
       FROM app_user u
       LEFT JOIN user_role r ON r.user_id = u.id
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
  return {
    principal: { userId: row.id, kind: 'human', login: row.login, displayName: row.display_name },
    roles: new Set(row.roles ?? []),
    memberships: new Map(m.rows.map((r) => [r.tender_id, r.member_role])),
    contractGrants: grants,
    contractCreateGranted: g.rows.some((r) => r.contract_id === null && r.capability === 'contract.create'),
    mailGrants,
    requestId,
  };
};

export const memberRoleOf = (ctx: IAccessContext, tenderId: string): MemberRole | null =>
  ctx.memberships.get(tenderId) ?? null;

// Список тендеров, чьё содержимое доступно (действующее назначение и соответствующая роль).
export const contentTenderIds = (ctx: IAccessContext): string[] =>
  [...ctx.memberships.entries()].filter(([, role]) => ctx.roles.has(role)).map(([id]) => id);

// Действующие возможности пользователя по договору: выдача и роль инженера или руководителя.
export const contractCaps = (ctx: IAccessContext, contractId: string): ContractCapability[] =>
  effectiveContractCapabilities(ctx.roles, ctx.contractGrants.get(contractId));

export const canCreateContract = (ctx: IAccessContext): boolean => ctx.contractCreateGranted && hasContentRole(ctx.roles);

// Договоры, содержимое которых пользователь читает сейчас (contract.read). Включение единицы договора
// в снимок права не даёт (D-022 OD-3): чтение единицы договора всегда проверяется по этому списку.
export const readableContractIds = (ctx: IAccessContext): string[] =>
  [...ctx.contractGrants.keys()].filter((id) => contractCaps(ctx, id).includes('contract.read'));

// Договоры, карточка которых пользователю видна (любая действующая выдача).
export const grantedContractIds = (ctx: IAccessContext): string[] =>
  [...ctx.contractGrants.keys()].filter((id) => contractCaps(ctx, id).length > 0);

// Действующие возможности пользователя по ящику: выдача и роль инженера или руководителя.
export const mailCaps = (ctx: IAccessContext, mailboxId: string): MailCapability[] =>
  effectiveMailCapabilities(ctx.roles, ctx.mailGrants.get(mailboxId));

// Ящики, письма которых пользователь читает сейчас (mail.read). Связь с тендером и включение письма
// в снимок права не дают: чтение письма всегда проверяется по этому списку (D-025).
export const readableMailboxIds = (ctx: IAccessContext): string[] =>
  [...ctx.mailGrants.keys()].filter((id) => mailCaps(ctx, id).includes('mail.read'));

// Ящики, в которых у пользователя есть заданная возможность.
export const mailboxIdsWith = (ctx: IAccessContext, cap: MailCapability): string[] =>
  [...ctx.mailGrants.keys()].filter((id) => mailCaps(ctx, id).includes(cap));
