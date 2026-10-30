import type { Role } from './capabilities.ts';

export const ROLE_PERMISSION_CATALOG = [
  {
    "code": "office.read",
    "group": "Рабочие разделы",
    "label": "Офис: очередь и диагностика"
  },
  {
    "code": "templates.read",
    "group": "Рабочие разделы",
    "label": "Просмотр шаблонов"
  },
  {
    "code": "tender.read.all",
    "group": "Область просмотра",
    "label": "Все тендеры"
  },
  {
    "code": "contract.read.all",
    "group": "Область просмотра",
    "label": "Все договоры"
  },
  {
    "code": "mail.read.all",
    "group": "Область просмотра",
    "label": "Все почтовые ящики"
  },
  {
    "code": "tender.read",
    "group": "Тендеры по назначению",
    "label": "Просмотр тендера и материалов"
  },
  {
    "code": "stage.write",
    "group": "Тендеры по назначению",
    "label": "Изменение этапа"
  },
  {
    "code": "stage.manage",
    "group": "Тендеры по назначению",
    "label": "Создание этапов"
  },
  {
    "code": "source.write",
    "group": "Тендеры по назначению",
    "label": "Источники и переписка"
  },
  {
    "code": "calculation.capture",
    "group": "Тендеры по назначению",
    "label": "Получение расчёта"
  },
  {
    "code": "audit.read",
    "group": "Тендеры по назначению",
    "label": "Журнал тендера"
  },
  {
    "code": "hold.resolve",
    "group": "Решения руководителя тендера",
    "label": "Разрешение удержаний"
  },
  {
    "code": "requirement.read",
    "group": "Требования и факты",
    "label": "Просмотр требований"
  },
  {
    "code": "requirement.create",
    "group": "Требования и факты",
    "label": "Предложения требований"
  },
  {
    "code": "requirement.confirm",
    "group": "Требования и факты",
    "label": "Подтверждение требований"
  },
  {
    "code": "requirement.decide",
    "group": "Требования и факты",
    "label": "Решения по требованиям"
  },
  {
    "code": "requirement.manage",
    "group": "Требования и факты",
    "label": "Ведение реестра требований"
  },
  {
    "code": "analysis.run",
    "group": "Требования и факты",
    "label": "Запуск анализа"
  },
  {
    "code": "fact.read",
    "group": "Требования и факты",
    "label": "Просмотр фактов"
  },
  {
    "code": "fact.create",
    "group": "Требования и факты",
    "label": "Предложения фактов"
  },
  {
    "code": "fact.confirm",
    "group": "Требования и факты",
    "label": "Подтверждение фактов"
  },
  {
    "code": "review.run",
    "group": "Проверки и экономика",
    "label": "Запуск проверки"
  },
  {
    "code": "finding.write",
    "group": "Проверки и экономика",
    "label": "Ведение замечаний"
  },
  {
    "code": "finding.accept_risk",
    "group": "Решения руководителя тендера",
    "label": "Принятие риска по замечанию"
  },
  {
    "code": "source_priority.manage",
    "group": "Решения руководителя тендера",
    "label": "Приоритет источников"
  },
  {
    "code": "economics.compare",
    "group": "Проверки и экономика",
    "label": "Сравнение экономики"
  },
  {
    "code": "change_reason.confirm",
    "group": "Проверки и экономика",
    "label": "Подтверждение причин изменений"
  },
  {
    "code": "application.fill",
    "group": "Приложения и выпуск",
    "label": "Заполнение приложений"
  },
  {
    "code": "template.manage",
    "group": "Приложения и выпуск",
    "label": "Шаблоны заказчика"
  },
  {
    "code": "candidate.create",
    "group": "Приложения и выпуск",
    "label": "Сборка комплекта"
  },
  {
    "code": "candidate.approve",
    "group": "Решения руководителя тендера",
    "label": "Согласование комплекта"
  },
  {
    "code": "risk.accept",
    "group": "Решения руководителя тендера",
    "label": "Принятие бизнес-риска"
  },
  {
    "code": "calculation.close",
    "group": "Решения руководителя тендера",
    "label": "Решение о закрытом расчёте"
  },
  {
    "code": "candidate.release",
    "group": "Приложения и выпуск",
    "label": "Выпуск согласованного комплекта"
  },
  {
    "code": "delivery.manage",
    "group": "Приложения и выпуск",
    "label": "Размещение выпуска"
  },
  {
    "code": "send.register",
    "group": "Приложения и выпуск",
    "label": "Регистрация отправки"
  },
  {
    "code": "send.accept_extras",
    "group": "Решения руководителя тендера",
    "label": "Принятие лишних вложений"
  },
  {
    "code": "mcp.propose",
    "group": "Чат-клиенты",
    "label": "Предложения через чат-клиент"
  },
  {
    "code": "contract.create",
    "group": "Договоры по выдачам",
    "label": "Создание договоров"
  },
  {
    "code": "contract.read",
    "group": "Договоры по выдачам",
    "label": "Просмотр договора"
  },
  {
    "code": "contract.link",
    "group": "Договоры по выдачам",
    "label": "Связь договора с тендером"
  },
  {
    "code": "contract.manage",
    "group": "Договоры по выдачам",
    "label": "Ведение договора"
  },
  {
    "code": "mail.read",
    "group": "Почта по выдачам",
    "label": "Просмотр писем и вложений"
  },
  {
    "code": "mail.import",
    "group": "Почта по выдачам",
    "label": "Импорт писем"
  },
  {
    "code": "mail.link",
    "group": "Почта по выдачам",
    "label": "Связь письма с тендером"
  },
  {
    "code": "mail.manage",
    "group": "Почта по выдачам",
    "label": "Ведение почтовых материалов"
  },
  {
    "code": "admin.templates",
    "group": "Шаблоны и формулировки",
    "label": "Ведение шаблонов компании"
  },
  {
    "code": "wording.propose",
    "group": "Шаблоны и формулировки",
    "label": "Предложения формулировок"
  },
  {
    "code": "wording.approve",
    "group": "Шаблоны и формулировки",
    "label": "Подтверждение формулировок"
  },
  {
    "code": "admin.users",
    "group": "Администрирование",
    "label": "Пользователи и назначение ролей"
  },
  {
    "code": "admin.roles",
    "group": "Администрирование",
    "label": "Создание и настройка ролей"
  },
  {
    "code": "admin.tender",
    "group": "Администрирование",
    "label": "Карточки тендеров и назначения"
  },
  {
    "code": "admin.contract",
    "group": "Администрирование",
    "label": "Выдачи доступа к договорам"
  },
  {
    "code": "admin.mailbox",
    "group": "Администрирование",
    "label": "Почтовые ящики и выдачи доступа"
  },
  {
    "code": "admin.intake",
    "group": "Администрирование",
    "label": "Настройка каналов поступления"
  },
  {
    "code": "admin.delivery",
    "group": "Администрирование",
    "label": "Настройка размещения"
  },
  {
    "code": "admin.audit",
    "group": "Администрирование",
    "label": "Состояние установки и общий журнал"
  },
  {
    "code": "history.read",
    "group": "Общая история",
    "label": "Просмотр общей истории"
  },
  {
    "code": "history.write",
    "group": "Общая история",
    "label": "Ведение общих материалов и задач"
  },
  {
    "code": "history.manage",
    "group": "Общая история",
    "label": "Настройка каналов общей истории"
  }
] as const;
export type RolePermission = typeof ROLE_PERMISSION_CATALOG[number]['code'];
export interface AccessRoles extends ReadonlySet<Role> { readonly permissions?: ReadonlySet<string> }

/** Единственное место построения разрешённых профилей и прав из каталога ролей БД. */
export const resolveAccessRoles = (profiles: Iterable<Role>, permissions: Iterable<string>): AccessRoles =>
  Object.assign(new Set(profiles), { permissions: new Set(permissions) });

export const rolePermission = (roles: ReadonlySet<Role>, permission: string, fallback = false): boolean =>
  (roles as AccessRoles).permissions?.has(permission) ?? fallback;

export const filterRoleCapabilities = <T extends string>(roles: ReadonlySet<Role>, capabilities: T[]): T[] => {
  const permissions = (roles as AccessRoles).permissions;
  return permissions ? capabilities.filter((cap) => permissions.has(cap)) : capabilities;
};

export const normalizeRolePermissions = (permissions: readonly string[]): RolePermission[] => {
  const set = new Set(permissions);
  if (set.has('tender.read.all')) for (const cap of ['tender.read','requirement.read','fact.read','audit.read']) set.add(cap);
  if (set.has('contract.read.all') || set.has('contract.link') || set.has('contract.manage')) set.add('contract.read');
  if (set.has('mail.read.all') || set.has('mail.link') || set.has('mail.import') || set.has('mail.manage')) set.add('mail.read');
  if (set.has('history.write')) set.add('history.read');
  if (set.has('admin.templates') || set.has('wording.approve') || set.has('wording.propose')) set.add('templates.read');
  return ROLE_PERMISSION_CATALOG.map((p)=>p.code).filter((p)=>set.has(p));
};
