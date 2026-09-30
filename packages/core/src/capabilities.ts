// Возможности вычисляются сервером из глобальных ролей и назначения на тендер (ADR-006 §1–3).
// Интерфейс только скрывает недоступные действия; решение всегда за сервером.

export type Role = 'admin' | 'manager' | 'engineer';
export type MemberRole = 'engineer' | 'manager';

export type GlobalCapability = 'admin.users' | 'admin.tender' | 'admin.audit' | 'admin.intake' | 'admin.contract' | 'admin.mailbox';
// Возможности договора (D-022 OD-2): выдаются явно строками contract_access, не ролью.
// contract.create — глобальная выдача; остальные — по договору.
export type ContractCapability = 'contract.read' | 'contract.link' | 'contract.manage';
export type ContractGrantCapability = 'contract.create' | ContractCapability;
// Возможности почтового ящика (D-025, OD-07-3): выдаются явно строками mail_access по ящику.
// Связь письма с тендером права читать не даёт.
export type MailCapability = 'mail.read' | 'mail.import' | 'mail.link' | 'mail.manage';
export type TenderCapability =
  | 'tender.read'
  | 'stage.write'
  | 'stage.manage'
  | 'audit.read'
  | 'admin.tender'
  | 'source.write'
  | 'hold.resolve'
  | 'calculation.capture';

export const ROLES: readonly Role[] = ['admin', 'manager', 'engineer'];
export const MEMBER_ROLES: readonly MemberRole[] = ['engineer', 'manager'];

export const globalCapabilities = (roles: ReadonlySet<Role>): GlobalCapability[] =>
  roles.has('admin') ? ['admin.users', 'admin.tender', 'admin.audit', 'admin.intake', 'admin.contract', 'admin.mailbox'] : [];

export const CONTRACT_CAPABILITIES: readonly ContractCapability[] = ['contract.read', 'contract.link', 'contract.manage'];
export const MAIL_CAPABILITIES: readonly MailCapability[] = ['mail.read', 'mail.import', 'mail.link', 'mail.manage'];

// Создатель получает доступ к созданному договору (OD-2): чтение и ведение — документы, метаданные,
// архив. Подтверждение связи с тендером — отдельное право contract.link, только явной выдачей (fail-closed).
export const CREATOR_CAPABILITIES: readonly ContractCapability[] = ['contract.read', 'contract.manage'];

// Выдача по договору действует, только пока у пользователя есть роль инженера или руководителя —
// как назначение на тендер. Одной системной роли администратора для содержимого договора мало
// (D-022 OD-2): admin.contract ведёт строки доступа, но содержимого не открывает.
export const hasContentRole = (roles: ReadonlySet<Role>): boolean => roles.has('engineer') || roles.has('manager');

export const effectiveContractCapabilities = (
  roles: ReadonlySet<Role>,
  granted: ReadonlySet<ContractCapability> | undefined,
): ContractCapability[] => (hasContentRole(roles) && granted ? CONTRACT_CAPABILITIES.filter((c) => granted.has(c)) : []);

// Выдача по ящику действует, как и по договору, только при роли инженера или руководителя:
// администратор ведёт ящики и выдачи (admin.mailbox), но содержимого писем без своей выдачи и
// содержательной роли не видит (OD-07-3).
export const effectiveMailCapabilities = (
  roles: ReadonlySet<Role>,
  granted: ReadonlySet<MailCapability> | undefined,
): MailCapability[] => (hasContentRole(roles) && granted ? MAIL_CAPABILITIES.filter((c) => granted.has(c)) : []);

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
  // Запрос выгрузки расчёта и решения по сопоставлению позиций — участник тендера (state-machines §6).
  if (role) caps.push('tender.read', 'stage.write', 'source.write', 'calculation.capture');
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
