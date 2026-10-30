import { describe, expect, it } from 'vitest';
import { formatOfficeDiagnostics, type IOfficeDiagnostics } from '../apps/web/src/pages/admin/office/officeDiagnostics.js';
import { roleOfKind, type IOfficeView } from '../apps/web/src/pages/admin/office/officeModel.js';
import { placeOfficeAlerts } from '../apps/web/src/pages/admin/office/officeAlerts.js';

const view: IOfficeView = { at: '2026-10-24T10:00:00Z', workersAlive: 1, tenders: [], items: [{ kind: 'mailhub.fetch', status: 'failed', count: 8, tenderId: null, hidden: true, lastErrorCode: 'HTTP_409', lastFailedAt: '2026-10-24T09:59:00Z' }, { kind: 'history.scan', status: 'queued', count: 3, tenderId: null, hidden: false, lastErrorCode: null, lastFailedAt: null }] };
const details: IOfficeDiagnostics = { at: view.at, build: 'test-build', total: 8, hidden: 6, limit: 50, truncated: false, entries: [{ jobId: 'job-visible', kind: 'mailhub.fetch', tenderId: null, errorCode: 'HTTP_409\nforged', failedAt: view.at, attempts: 2, maxAttempts: 3 }] };
describe('копируемая диагностика', () => {
  it('включает контекст, закрытые счётчики и безопасные коды', () => {
    const text = formatOfficeDiagnostics(view, details, true, null);
    for (const value of ['test-build', 'данные устарели', 'в очереди: 3', 'ошибок за 24 ч: 8', 'job=job-visible', 'попытки 2/3', 'закрытым тендерам: 6', 'HTTP_409_forged']) expect(text).toContain(value);
    expect(text).not.toContain('\nforged');
    expect(formatOfficeDiagnostics(view, { ...details, build: 'previous-release+'.repeat(40) + 'office-dashboard-current' }, false, null)).toContain('office-dashboard-current');
  });
  it('фильтрует роль и сохраняет сводку при недоступности журнала', () => {
    const text = formatOfficeDiagnostics(view, null, false, 'archive', 'TIMEOUT');
    expect(text).toContain('в очереди: 3');expect(text).not.toContain('mailhub.fetch');expect(text).toContain('TIMEOUT');
    expect(roleOfKind('mailhub.fetch')).toBe('intake');expect(roleOfKind('history.scan')).toBe('archive');
  });
});
it('крупные уведомления помещаются на узком экране без наложения', () => {
  const roles = ['intake', 'recognition', 'archive', 'analyst', 'estimator', 'reviewer', 'assembler', 'courier', 'model', 'other'] as const;
  const placed = placeOfficeAlerts(roles.map((role) => ({ role, x: 120, y: 200 })), 248, 440, 116, 76);
  expect(placed).toHaveLength(10);
  for (const [i, point] of placed.entries()) {
    expect(point.x).toBeGreaterThanOrEqual(0);expect(point.y).toBeGreaterThanOrEqual(0);expect(point.x + 116).toBeLessThanOrEqual(248);expect(point.y + 76).toBeLessThanOrEqual(440);
    for (const other of placed.slice(i + 1)) expect(Math.abs(point.x - other.x) >= 116 || Math.abs(point.y - other.y) >= 76).toBe(true);
  }
});
