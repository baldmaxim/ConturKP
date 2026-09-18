// Возможности вычисляются сервером из глобальных ролей и назначения на тендер (ADR-006 §1–3).
// Интерфейс только скрывает недоступные действия; решение всегда за сервером.

export type Role = 'admin' | 'manager' | 'engineer';
export type MemberRole = 'engineer' | 'manager';

export type GlobalCapability = 'admin.users' | 'admin.tender' | 'admin.audit' | 'admin.intake';
export type TenderCapability = 'tender.read' | 'stage.write' | 'stage.manage' | 'audit.read' | 'admin.tender' | 'source.write' | 'hold.resolve';

export const ROLES: readonly Role[] = ['admin', 'manager', 'engineer'];
export const MEMBER_ROLES: readonly MemberRole[] = ['engineer', 'manager'];

export const globalCapabilities = (roles: ReadonlySet<Role>): GlobalCapability[] =>
  roles.has('admin') ? ['admin.users', 'admin.tender', 'admin.audit', 'admin.intake'] : [];

// Назначение действует, только пока у пользователя есть соответствующая глобальная роль:
// снятие роли сразу лишает прав по тендеру без правки назначений.
export const effectiveMemberRole = (
  roles: ReadonlySet<Role>,
  memberRole: MemberRole | null | undefined,
): MemberRole | null => (memberRole && roles.has(memberRole) ? memberRole : null);

export const tenderCapabilities = (
  roles: ReadonlySet<Role>,
  memberRole: MemberRole | null | undefined,
): TenderCapability[] => {
  const role = effectiveMemberRole(roles, memberRole);
  const caps: TenderCapability[] = [];
  if (role) caps.push('tender.read', 'stage.write', 'source.write');
  // Решения о неприменимости (элементы импорта, удержания) — только руководитель тендера (ADR-006 §3).
  if (role === 'manager') caps.push('stage.manage', 'hold.resolve');
  if (role === 'manager' || roles.has('admin')) caps.push('audit.read');
  if (roles.has('admin')) caps.push('admin.tender');
  return caps;
};

// Журнал тендера — производное представление его данных (R02-02). Руководитель тендера видит
// все события. Администратор без назначения — только административные события карточки и
// участников: их содержимое ему и так доступно. События этапов и дальнейшего содержимого
// (названия, сроки, старые значения) ему не выдаются.
export const ADMIN_AUDIT_ACTIONS: readonly string[] = [
  'tender.create',
  'tender.update',
  'tender.member.assign',
  'tender.member.remove',
  'intake.channel.create',
  'intake.channel.update',
  'demo.seed',
];

export type AuditScope = { kind: 'all' } | { kind: 'actions'; actions: readonly string[] } | { kind: 'none' };

export const tenderAuditScope = (roles: ReadonlySet<Role>, memberRole: MemberRole | null | undefined): AuditScope => {
  if (effectiveMemberRole(roles, memberRole) === 'manager') return { kind: 'all' };
  if (roles.has('admin')) return { kind: 'actions', actions: ADMIN_AUDIT_ACTIONS };
  return { kind: 'none' };
};

// Карточку тендера и состав участников видит участник или администратор;
// содержимое тендера (этапы и далее) — только участник (ADR-006: администратор без
// назначения не видит данных тендера).
export const canSeeTenderCard = (roles: ReadonlySet<Role>, memberRole: MemberRole | null | undefined): boolean =>
  effectiveMemberRole(roles, memberRole) !== null || roles.has('admin');
