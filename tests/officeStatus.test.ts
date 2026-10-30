import { describe, expect, it } from 'vitest';
import { buildOffice, RECENT_FAILURE_MS, type IOfficeView } from '../apps/web/src/pages/admin/office/officeModel.ts';
import { officeStatus, officeStatusLabel } from '../apps/web/src/pages/admin/office/officeStatus.ts';

const at = '2026-10-23T10:00:00.000Z';
const view = (items: IOfficeView['items'] = [], workersAlive = 1): IOfficeView => ({ at, items, workersAlive, tenders: [] });
const job = (status: 'running' | 'queued' | 'failed', count = 1, failedAgo = 0): IOfficeView['items'][number] => ({ kind: 'review.run', status, count, hidden: false, tenderId: null, lastErrorCode: status === 'failed' ? 'E_TEST' : null, lastFailedAt: status === 'failed' ? new Date(Date.parse(at) - failedAgo).toISOString() : null });
const status = (data: IOfficeView, stale = false) => officeStatus(data, buildOffice(data), stale, null);

describe('общий индикатор офиса', () => {
  it('до первого ответа различает загрузку и недоступность; устаревший снимок не показывает работу как актуальную', () => {
    expect(officeStatus(null, null, false, null)).toBe('loading');
    expect(officeStatus(null, null, false, new Error('offline'))).toBe('stale');
    expect(status(view([job('running', 4)]), true)).toBe('stale');
  });

  it('отсутствующий worker важнее работы и ошибок, в том числе при пустой очереди', () => {
    expect(status(view([], 0))).toBe('down');
    expect(status(view([job('running'), job('failed')], 0))).toBe('down');
  });

  it('недавний отказ требует внимания и при параллельной работе другой роли', () => {
    expect(status(view([job('running', 3), job('failed', 1, 1000)]))).toBe('error');
    expect(status(view([job('running', 3), job('failed', 1, RECENT_FAILURE_MS + 1)]))).toBe('working');
    expect(status(view([job('failed', 1, RECENT_FAILURE_MS + 1)]))).toBe('idle');
  });

  it('показывает реальные количества работающих и ожидающих заданий', () => {
    const active = view([job('running', 3), job('queued', 8)]);
    expect(officeStatusLabel(status(active), buildOffice(active))).toBe('3 в работе');
    const queued = view([job('queued', 8)]);
    expect(officeStatusLabel(status(queued), buildOffice(queued))).toBe('8 в очереди');
    expect(officeStatusLabel(status(view()), buildOffice(view()))).toBe('Нет заданий');
  });
});
