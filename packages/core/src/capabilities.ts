// Возможности вычисляются сервером из глобальных ролей и назначения на тендер (ADR-006 §1–3).
// Интерфейс только скрывает недоступные действия; решение всегда за сервером.

import { rolePermission, filterRoleCapabilities, type AccessRoles } from './rolePolicy.ts';

export type Role = 'admin' | 'manager' | 'engineer';
export type MemberRole = 'engineer' | 'manager';

// Руководитель видит все тендеры, договоры, почту и шаблоны (ADR-006, 2026-10-26).
// Назначения и явные выдачи по-прежнему определяют права изменения; admin.* остаются отдельными.
// Этап 14 (D-034 В-14-5): назначения размещения (пути, политика внутренних материалов) — admin.delivery, администратор.
export type GlobalCapability =
  | 'history.read'
  | 'history.write'
  | 'history.manage'
  | 'office.read'
  | 'templates.read'
  | 'tender.read.all'
  | 'contract.read.all'
  | 'mail.read.all'
  | 'admin.roles'
  | 'admin.users'
  | 'admin.tender'
  | 'admin.audit'
  | 'admin.intake'
  | 'admin.contract'
  | 'admin.mailbox'
  | 'admin.delivery'
  | 'admin.templates'
  | 'wording.approve';
// Руководитель читает все договоры; остальные возможности — по выдачам contract_access.
// contract.create — глобальная выдача; остальные — по договору.
export type ContractCapability = 'contract.read' | 'contract.link' | 'contract.manage';
export type ContractGrantCapability = 'contract.create' | ContractCapability;
// Руководитель читает все ящики; остальные возможности — по выдачам mail_access.
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
  | 'calculation.capture'
  // Этап 08 (D-026, Р-08-8): требования, факты и анализ — из той же модели ролей; БД повторяет
  // таблицу функцией tender_capabilities (миграция 0019) — менять вместе.
  | 'requirement.read'
  | 'requirement.create'
  | 'requirement.confirm'
  | 'requirement.decide'
  | 'requirement.manage'
  | 'analysis.run'
  | 'fact.read'
  | 'fact.create'
  | 'fact.confirm'
  // Этап 09 (D-029): запуск проверки и ведение замечаний — участник; принятие риска и приоритет источников —
  // руководитель тендера (ADR-006 §3). БД повторяет в tender_capabilities (миграция 0024).
  | 'review.run'
  | 'finding.write'
  | 'finding.accept_risk'
  | 'source_priority.manage'
  // Этап 10 (D-030): сравнение ревизий расчёта и подтверждение причин изменений — участник тендера.
  // БД повторяет в tender_capabilities (миграция 0026).
  | 'economics.compare'
  | 'change_reason.confirm'
  // Этап 11 (D-031): заполнение приложений — участник; шаблон заказчика — руководитель тендера (миграция 0029).
  | 'application.fill'
  | 'template.manage'
  // Этап 12 (D-032 В-12-7): сборка комплекта-кандидата — участник тендера (руководитель или инженер); только human,
  // модель и MCP не получают (I12). БД повторяет в tender_capabilities (миграция 0032).
  | 'candidate.create'
  // Этап 13 (D-033; ADR-006 §3): согласование, возврат, отзыв и принятие риска — руководитель тендера, выпуск — инженер
  // тендера; только human (I12). БД повторяет в tender_capabilities (миграция 0034).
  | 'candidate.approve'
  | 'risk.accept'
  | 'candidate.release'
  // Этап 14 (D-034 В-14-5): размещение выпуска, повтор, «повторить после проверки», перенаправление и подтверждение облака —
  // участник тендера (инженер и руководитель), только human. Назначения — администратор. БД — tender_capabilities (0038).
  | 'delivery.manage'
  // Этап 15 (D-035; state-machines §17, ADR-006 п. 3): регистрация отправки и нарушения — инженер тендера; лишние
  // вложения письма об отправке принимает руководитель тендера (В-15-1); только human. БД — tender_capabilities (0039).
  | 'send.register'
  | 'send.accept_extras'
  // Этап 16 (D-037; ADR-006, ADR-010): предложение через чат-клиент (MCP) — участник тендера, инженер и руководитель.
  // Нужна и область `propose` у токена. Принятие предложения — возможностью соответствующей записи, только human (I12).
  // БД — tender_capabilities (миграция 0040).
  | 'mcp.propose'
  | 'calculation.close';

export const ROLES: readonly Role[] = ['admin', 'manager', 'engineer'];
export const MEMBER_ROLES: readonly MemberRole[] = ['engineer', 'manager'];

export const GLOBAL_CAPABILITIES: readonly GlobalCapability[] = ['admin.users','admin.tender','admin.audit','admin.intake','admin.contract','admin.mailbox','admin.delivery','admin.roles','admin.templates','wording.approve','office.read','templates.read','tender.read.all','contract.read.all','mail.read.all','history.read','history.write','history.manage'];
export const globalCapabilities = (roles: ReadonlySet<Role>): GlobalCapability[] => (roles as AccessRoles).permissions
  ? GLOBAL_CAPABILITIES.filter((cap) => rolePermission(roles, cap)) : [
  ...(roles.has('admin') ? (['admin.users', 'admin.tender', 'admin.audit', 'admin.intake', 'admin.contract', 'admin.mailbox', 'admin.delivery', 'admin.roles', 'office.read', 'history.manage'] as const) : []),
  ...(roles.has('manager') ? (['admin.templates', 'wording.approve', 'office.read', 'templates.read', 'tender.read.all', 'contract.read.all', 'mail.read.all', 'history.read', 'history.write'] as const) : []),
  ...(!roles.has('manager') && roles.has('engineer') ? (['templates.read', 'history.read', 'history.write'] as const) : []),
];

export const CONTRACT_CAPABILITIES: readonly ContractCapability[] = ['contract.read', 'contract.link', 'contract.manage'];
export const MAIL_CAPABILITIES: readonly MailCapability[] = ['mail.read', 'mail.import', 'mail.link', 'mail.manage'];

// Создатель получает доступ к созданному договору (OD-2): чтение и ведение — документы, метаданные,
// архив. Подтверждение связи с тендером — отдельное право contract.link, только явной выдачей (fail-closed).
export const CREATOR_CAPABILITIES: readonly ContractCapability[] = ['contract.read', 'contract.manage'];

// Выдача по договору действует, только пока у пользователя есть роль инженера или руководителя —
// как назначение на тендер. Одной системной роли администратора для содержимого договора мало
// (D-022 OD-2): admin.contract ведёт строки доступа, но содержимого не открывает.
export const hasContentRole = (roles: ReadonlySet<Role>): boolean => (roles as AccessRoles).permissions
  ? ['tender.read','contract.read','mail.read','templates.read','history.read'].some((cap) => rolePermission(roles, cap))
  : roles.has('engineer') || roles.has('manager');

export const effectiveContractCapabilities = (
  roles: ReadonlySet<Role>,
  granted: ReadonlySet<ContractCapability> | undefined,
): ContractCapability[] => hasContentRole(roles)
  ? filterRoleCapabilities(roles, CONTRACT_CAPABILITIES.filter((c) => (c === 'contract.read' && rolePermission(roles, 'contract.read.all', roles.has('manager'))) || granted?.has(c)))
  : [];

// Выдача по ящику действует, как и по договору, только при роли инженера или руководителя:
// администратор ведёт ящики и выдачи (admin.mailbox), но содержимого писем без своей выдачи и
// содержательной роли не видит (OD-07-3).
export const effectiveMailCapabilities = (
  roles: ReadonlySet<Role>,
  granted: ReadonlySet<MailCapability> | undefined,
): MailCapability[] => hasContentRole(roles)
  ? filterRoleCapabilities(roles, MAIL_CAPABILITIES.filter((c) => (c === 'mail.read' && rolePermission(roles, 'mail.read.all', roles.has('manager'))) || granted?.has(c)))
  : [];

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
  // Общая роль открывает только чтение; права изменения остаются по назначению.
  const caps: TenderCapability[] = rolePermission(roles, 'tender.read.all', roles.has('manager')) && !role ? ['tender.read', 'requirement.read', 'fact.read'] : [];
  // Запрос выгрузки расчёта и решения по сопоставлению позиций — участник тендера (state-machines §6).
  if (role) caps.push('tender.read', 'stage.write', 'source.write', 'calculation.capture');
  // Предложения, анализ и чтение реестра — участник тендера; создатель кандидата права подтверждения
  // не получает (OD-08-5).
  if (role) caps.push('requirement.read', 'requirement.create', 'analysis.run', 'fact.read', 'fact.create');
  if (role) caps.push('review.run', 'finding.write');
  if (role) caps.push('economics.compare', 'change_reason.confirm');
  if (role) caps.push('application.fill');
  if (role) caps.push('candidate.create');
  if (role) caps.push('delivery.manage');
  if (role) caps.push('mcp.propose');
  // Решения о неприменимости (элементы импорта, удержания) — только руководитель тендера (ADR-006 §3).
  if (role === 'manager') caps.push('stage.manage', 'hold.resolve');
  // Подтверждение, решение и ведение реестра — руководитель тендера (OD-08-5).
  if (role === 'manager') caps.push('requirement.confirm', 'requirement.decide', 'requirement.manage', 'fact.confirm');
  if (role === 'manager') caps.push('finding.accept_risk', 'source_priority.manage');
  if (role === 'manager') caps.push('template.manage');
  if (role === 'manager') caps.push('candidate.approve', 'risk.accept');
  if (role === 'manager') caps.push('send.accept_extras');
  // D-044: закрытый расчёт остаётся решением назначенного руководителя.
  if (role === 'manager') caps.push('calculation.close');
  if (role === 'engineer') caps.push('candidate.release');
  if (role === 'engineer') caps.push('send.register');
  if (rolePermission(roles, 'audit.read', roles.has('manager') || roles.has('admin')) && (role || rolePermission(roles, 'tender.read.all', roles.has('manager')) || globalCapabilities(roles).includes('admin.tender'))) caps.push('audit.read');
  if (globalCapabilities(roles).includes('admin.tender')) caps.push('admin.tender');
  return filterRoleCapabilities(roles, caps);
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
  if (!tenderCapabilities(roles, memberRole).includes('audit.read')) return { kind: 'none' };
  if (tenderCapabilities(roles, memberRole).includes('tender.read')) return { kind: 'all' };
  if (globalCapabilities(roles).includes('admin.tender')) return { kind: 'actions', actions: ADMIN_AUDIT_ACTIONS };
  return { kind: 'none' };
};

// Руководитель видит все карточки и содержимое. Инженер — по назначению.
// Администратор без назначения видит карточки и состав участников, без содержимого.
export const canSeeTenderCard = (roles: ReadonlySet<Role>, memberRole: MemberRole | null | undefined): boolean =>
  tenderCapabilities(roles, memberRole).includes('tender.read') || globalCapabilities(roles).includes('admin.tender');

export const defaultRolePermissions = (role: Role): string[] => {
  const roles = new Set<Role>([role]);
  return [...new Set<string>([...globalCapabilities(roles), ...tenderCapabilities(roles, role === 'admin' ? null : role),
    ...(role === 'admin' ? [] : [...CONTRACT_CAPABILITIES, ...MAIL_CAPABILITIES, 'contract.create', 'wording.propose'])])];
};
