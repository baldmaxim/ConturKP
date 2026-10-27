import { describe, expect, it } from 'vitest';
import { buildOffice, type IOfficeView } from '../apps/web/src/pages/admin/office/officeModel.js';
import { officeExecution } from '../apps/web/src/pages/admin/office/officeExecution.js';
import { placeOfficeAlerts } from '../apps/web/src/pages/admin/office/officeAlerts.js';

const person = (running: number, queued: number, failed = 0) => {
  const view: IOfficeView = { at: '2026-10-24T12:00:00Z', workersAlive: 1, tenders: [], items: (['running', 'queued', 'failed'] as const).map((status) => ({ kind: 'mailhub.fetch', status, count: { running, queued, failed }[status], tenderId: null, hidden: false, lastErrorCode: status === 'failed' ? 'HTTP_409' : null, lastFailedAt: status === 'failed' ? '2026-10-24T09:00:00Z' : null })).filter((item) => item.count > 0) };
  const office = buildOffice(view);return office.desks.find((item) => item.role === 'intake') ?? office.lounge.find((item) => item.role === 'intake')!;
};

describe('фактическая загрузка агента', () => {
  it('показывает выполнение и очередь одновременно с историческими ошибками', () => {
    expect(officeExecution(person(2, 7, 20), 1, false)).toMatchObject({ state: 'running', label: 'Выполняется: 2', running: 2, queued: 7, active: 9 });
  });
  it('отличает ожидание запуска от выполняющегося задания', () => {
    expect(officeExecution(person(0, 5), 1, false)).toMatchObject({ state: 'queued', label: 'В очереди: 5', active: 5 });
  });
  it('ошибки без активных заданий не означают загрузку', () => {
    expect(officeExecution(person(0, 0, 20), 1, false)).toMatchObject({ state: 'idle', label: 'Свободен', active: 0 });
  });
  it('не выдаёт старое выполнение за текущее при потере связи', () => {
    const result = officeExecution(person(2, 7), 1, true);
    expect(result).toMatchObject({ state: 'stale', label: 'Нет связи', running: 2, queued: 7 });
    expect(result.caption).toContain('Последний снимок');
  });
  it('отражает остановку worker, даже если снимок содержит running', () => {
    expect(officeExecution(person(2, 7), 0, false)).toMatchObject({ state: 'down', label: 'Нет worker' });
    expect(officeExecution(person(2, 7), 0, true).state).toBe('stale');
  });
});

it('подписи всех агентов разной высоты помещаются без пересечений', () => {
  const roles = ['intake', 'recognition', 'archive', 'analyst', 'estimator', 'reviewer', 'assembler', 'courier', 'model', 'other'] as const;
  for (const width of [248, 520, 900]) for (const allFailed of [false, true]) {
    const anchors = roles.map((role, i) => ({ role, x: width / 2 + (i % 3 - 1) * 20, y: 300 + i % 4 * 5, width: width === 248 ? 116 : 154, height: allFailed || i < 4 ? 96 : 50 }));
    const placed = placeOfficeAlerts(anchors, width, 520, 154, 96);
    expect(placed).toHaveLength(10);
    for (const [i, point] of placed.entries()) {
      const box = anchors.find((anchor) => anchor.role === point.role)!;
      expect(point.x).toBeGreaterThanOrEqual(0);expect(point.y).toBeGreaterThanOrEqual(0);expect(point.x + box.width).toBeLessThanOrEqual(width);expect(point.y + box.height).toBeLessThanOrEqual(520);
      for (const other of placed.slice(i + 1)) {
        const otherBox = anchors.find((anchor) => anchor.role === other.role)!;
        expect(point.x + box.width <= other.x || other.x + otherBox.width <= point.x || point.y + box.height <= other.y || other.y + otherBox.height <= point.y).toBe(true);
      }
    }
  }
});
