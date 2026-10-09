// Подписи размещения (этап 14; D-034). «Размещено» — файлы сверены в папке назначения; это не «отправлено заказчику»
// (A31). У Яндекс Диска «размещено» — «проверено в локальной папке синхронизации»; облако подтверждается отдельно.
import type { IBadgeMeta } from './sourceLabels';

export const DELIVERY_KIND: Record<string, string> = { yandex_disk: 'Яндекс Диск', smb: 'Сетевая папка' };

export const DELIVERY_STATUS: Record<string, IBadgeMeta> = {
  pending: { label: 'Ожидает', icon: 'hourglass', tone: 'info' },
  staging: { label: 'Загружается', icon: 'upload', tone: 'info' },
  committing: { label: 'Переносится', icon: 'loader-circle', tone: 'info' },
  verifying: { label: 'Проверяется', icon: 'scan-search', tone: 'info' },
  delivered: { label: 'Размещено', icon: 'check', tone: 'success' },
  failed: { label: 'Ошибка', icon: 'circle-x', tone: 'danger' },
  outcome_unknown: { label: 'Исход неизвестен — сверяется', icon: 'clock-alert', tone: 'warning' },
  conflict: { label: 'Конфликт', icon: 'file-exclamation-point', tone: 'danger' },
  superseded: { label: 'Заменено', icon: 'repeat', tone: 'muted', dashed: true },
};

// Статус Яндекс Диска: «размещено» означает проверку в локальной папке, не в облаке.
export const statusMeta = (kind: string, status: string): IBadgeMeta => {
  const m = DELIVERY_STATUS[status] ?? { label: status, icon: 'info', tone: 'neutral' };
  return kind === 'yandex_disk' && status === 'delivered' ? { ...m, label: 'Проверено в локальной папке' } : m;
};

export const CLOUD_STATE: Record<string, IBadgeMeta> = {
  unconfirmed: { label: 'Облако: не подтверждено', icon: 'cloud', tone: 'warning', dashed: true },
  confirmed: { label: 'Облако: подтверждено', icon: 'cloud', tone: 'success' },
};

export const WORKING_STATUSES = new Set(['pending', 'staging', 'committing', 'verifying', 'outcome_unknown']);

export const DELIVERY_ERROR: Record<string, string> = {
  NETWORK: 'назначение недоступно (сеть)',
  OUTCOME_UNKNOWN: 'исход операции неизвестен',
  FORBIDDEN: 'нет прав у учётной записи службы',
  NO_SPACE: 'нет места в назначении',
  ROOT_NOT_FOUND: 'корень назначения не найден',
  STAGING_NOT_FOUND: 'служебная папка не найдена',
  CROSS_DEVICE: 'служебная папка и корень на разных дисках',
  CONTENT_MISMATCH: 'содержимое не совпадает с выпуском',
  INVALID_PATH: 'недопустимый путь',
  CONFLICT: 'в папке выпуска другое содержимое',
  RESTRICTED_BASIS: 'у запросившего размещение нет доступа к основаниям решений в манифесте выпуска',
  NO_ATOMIC_MOVE: 'назначение не поддерживает перенос без замены (жёсткие ссылки)',
  internal: 'внутренняя ошибка',
};

export const REMOTE_STATE: Record<string, string> = {
  absent: 'нет',
  staged: 'в служебной папке',
  committed: 'перенесён',
  verified: 'сверен',
  conflict: 'другое содержимое',
  unknown: 'не сверен',
};

export const DELIVERY_EVENT: Record<string, string> = {
  created: 'создано при выпуске',
  place: 'размещение запрошено',
  retry: 'повтор',
  resolve_conflict: 'повтор после проверки',
  redirect: 'перенаправлено',
  confirm_cloud: 'облако подтверждено',
};

export const ATTEMPT_OUTCOME: Record<string, string> = {
  delivered: 'размещено',
  failed: 'ошибка',
  outcome_unknown: 'исход неизвестен',
  conflict: 'конфликт',
  interrupted: 'прервано, повтор',
};
