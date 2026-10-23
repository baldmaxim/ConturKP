import { RECENT_FAILURE_MS, type IOfficeModel, type IOfficeView } from './officeModel.js';

export type TOfficeStatus = 'loading' | 'stale' | 'down' | 'error' | 'working' | 'queued' | 'idle';

/** Приоритет общего индикатора: связь, worker, недавний отказ, работа, очередь, отдых. */
export const officeStatus = (view: IOfficeView | null, office: IOfficeModel | null, stale: boolean, error: unknown): TOfficeStatus => {
  if (!view || !office) return error ? 'stale' : 'loading';
  if (stale) return 'stale';
  if (office.totals.workersAlive === 0) return 'down';
  const at = Date.parse(view.at);
  if (view.items.some((item) => item.status === 'failed' && item.lastFailedAt !== null && at - Date.parse(item.lastFailedAt) <= RECENT_FAILURE_MS)) return 'error';
  if (office.totals.running > 0) return 'working';
  if (office.totals.queued > 0) return 'queued';
  return 'idle';
};

export const officeStatusLabel = (status: TOfficeStatus, office: IOfficeModel | null): string => {
  switch (status) {
    case 'loading': return 'Загрузка…';
    case 'stale': return 'Нет связи';
    case 'down': return 'Нет worker';
    case 'error': return 'Нужна помощь';
    case 'working': return `${office?.totals.running ?? 0} в работе`;
    case 'queued': return `${office?.totals.queued ?? 0} в очереди`;
    case 'idle': return 'Нет заданий';
  }
};
