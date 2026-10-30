import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfficeHover } from '../apps/web/src/pages/admin/office/officeHover.ts';
import { createOfficeAlertLayout } from '../apps/web/src/pages/admin/office/officeAlerts.ts';
import { officeComputer } from '../apps/web/src/pages/admin/office/officeExecution.ts';
import { buildOffice, type IOfficeView } from '../apps/web/src/pages/admin/office/officeModel.ts';

afterEach(() => vi.useRealTimers());

describe('устойчивое наведение в офисе', () => {
  it('не закрывает окно при переходе с персонажа через ярлык в подробности', () => {
    vi.useFakeTimers();
    const change = vi.fn(), hover = createOfficeHover(change);
    hover.set('scene', 'intake');hover.set('badge', 'intake');hover.set('scene', null);
    vi.advanceTimersByTime(1000);
    hover.set('badge', null);vi.advanceTimersByTime(150);hover.set('popover', 'intake');
    vi.advanceTimersByTime(1000);
    expect(change.mock.calls).toEqual([['intake']]);
    hover.set('popover', null);vi.advanceTimersByTime(250);
    expect(change.mock.calls).toEqual([['intake'], [null]]);
  });

  it('не даёт старому событию ухода с canvas закрыть окно под указателем', () => {
    vi.useFakeTimers();
    const change = vi.fn(), hover = createOfficeHover(change);
    hover.set('scene', 'archive');hover.set('scene', null);
    vi.advanceTimersByTime(200);hover.set('popover', 'archive');hover.set('scene', null);
    vi.advanceTimersByTime(1000);
    expect(change.mock.calls).toEqual([['archive']]);
    hover.dispose();
  });

  it('закрывается после ухода, даже когда указатель продолжает двигаться по пустому месту', () => {
    vi.useFakeTimers();
    const change = vi.fn(), hover = createOfficeHover(change);
    hover.set('scene', 'intake');hover.set('scene', null);
    vi.advanceTimersByTime(200);hover.set('scene', null);vi.advanceTimersByTime(50);
    expect(change.mock.calls).toEqual([['intake'], [null]]);
  });

  it('отменяет отложенное закрытие при выборе другого агента и при размонтировании', () => {
    vi.useFakeTimers();
    const change = vi.fn(), hover = createOfficeHover(change);
    hover.set('scene', 'intake');hover.set('scene', null);hover.set('badge', 'archive');
    vi.advanceTimersByTime(1000);
    expect(change.mock.calls).toEqual([['intake'], ['archive']]);
    hover.set('badge', null);hover.dispose();vi.advanceTimersByTime(1000);
    expect(change).toHaveBeenCalledTimes(2);
  });

  it('сохраняет положение ярлыка при движении героя и обновлении снимка, учитывает изменение ширины', () => {
    const layout = createOfficeAlertLayout();
    const first = layout([{ role: 'intake', x: 150, y: 250, width: 124, height: 26 }], 600, 520, false);
    const moved = [{ role: 'intake' as const, x: 380, y: 350, width: 124, height: 26 }];
    expect(layout(moved, 600, 520, true)).toEqual(first);
    expect(layout(moved, 600, 520, false)).not.toEqual(first);
    const narrow = layout([{ ...moved[0]!, width: 116 }], 248, 520, true)[0]!;
    expect(narrow.x + 116).toBeLessThanOrEqual(244);
  });
});

describe('компьютер Приёмщика', () => {
  const person = (running: number, queued: number, failed: number) => {
    const now = new Date().toISOString();
    const view: IOfficeView = { at: now, workersAlive: 1, tenders: [], items: (['running', 'queued', 'failed'] as const).filter(status => ({ running, queued, failed })[status] > 0).map(status => ({ kind: 'mailhub.fetch', status, count: { running, queued, failed }[status], tenderId: null, hidden: false, lastErrorCode: status === 'failed' ? 'SOURCE_UNAVAILABLE' : null, lastFailedAt: status === 'failed' ? now : null })) };
    const office = buildOffice(view);
    return office.desks.find(item => item.role === 'intake') ?? office.lounge.find(item => item.role === 'intake')!;
  };
  it('сохраняет работающий экран и набор текста при наличии другой ошибки', () => {
    expect(officeComputer(person(1, 2, 1), 1, false)).toBe('working');
  });
  it('показывает ошибку на включённом компьютере без имитации выполнения', () => {
    expect(officeComputer(person(0, 0, 1), 1, false)).toBe('attention');
  });
  it('различает ожидание, свободное место и потерю связи', () => {
    expect(officeComputer(person(0, 2, 0), 1, false)).toBe('waiting');
    expect(officeComputer(person(0, 0, 0), 1, false)).toBe('off');
    expect(officeComputer(person(1, 0, 1), 1, true)).toBe('offline');
    expect(officeComputer(person(1, 0, 1), 0, false)).toBe('offline');
  });
});
