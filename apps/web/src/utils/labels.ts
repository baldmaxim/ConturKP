import type { TAuditOutcome, TGlobalRole, TMemberRole, TPrincipalKind } from '../api/types';

export const GLOBAL_ROLE_LABELS: Record<TGlobalRole, string> = {
  admin: 'Администратор',
  manager: 'Руководитель',
  engineer: 'Инженер',
};

export const GLOBAL_ROLES: TGlobalRole[] = ['engineer', 'manager', 'admin'];

export const MEMBER_ROLE_LABELS: Record<TMemberRole, string> = {
  engineer: 'Инженер',
  manager: 'Руководитель тендера',
};

export const PRINCIPAL_LABELS: Record<TPrincipalKind, string> = {
  human: 'Пользователь',
  model_via_mcp: 'Модель через MCP',
  integration: 'Интеграция',
  system: 'Система',
  anonymous: 'Без входа',
};

export const OUTCOME_LABELS: Record<TAuditOutcome, string> = {
  allowed: 'Выполнено',
  denied: 'Отказано',
  failed: 'Ошибка',
};

/** Подпись глобальной роли; неизвестный код показывается как есть. */
export const globalRoleLabel = (role: string): string =>
  role in GLOBAL_ROLE_LABELS ? GLOBAL_ROLE_LABELS[role as TGlobalRole] : role;

export const principalLabel = (kind: string): string =>
  kind in PRINCIPAL_LABELS ? PRINCIPAL_LABELS[kind as TPrincipalKind] : kind;
