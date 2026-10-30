import { describe, expect, it } from 'vitest';
import { officePopoverPosition, placeOfficeAlerts } from '../apps/web/src/pages/admin/office/officeAlerts.ts';
import { OFFICE_ROLES } from '../apps/web/src/pages/admin/office/officeModel.ts';

describe('ярлыки работы и окно прогресса', () => {
  it('окно остаётся на сцене при наведении на ярлыки у каждого края', () => {
    for (const sceneWidth of [248, 520, 960]) for (const sceneHeight of [520, 650]) {
      const width = Math.min(280, sceneWidth - 8), height = 260;
      for (const x of [4, sceneWidth / 2 - 43, sceneWidth - 90]) for (const y of [4, sceneHeight / 2, sceneHeight - 32]) {
        const p = officePopoverPosition({ x, y, width: 86, height: 28 }, sceneWidth, sceneHeight, width, height);
        expect(p.x).toBeGreaterThanOrEqual(4);expect(p.y).toBeGreaterThanOrEqual(4);
        expect(p.x + width).toBeLessThanOrEqual(sceneWidth - 4);expect(p.y + height).toBeLessThanOrEqual(sceneHeight - 4);
        // Если сверху или снизу есть место, окно не закрывает ярлык.
        if (y >= height + 12 || y + 28 + height + 12 <= sceneHeight) expect(p.y + height <= y || p.y >= y + 28).toBe(true);
      }
    }
  });
  it('десять маленьких ярлыков помещаются без пересечений на узкой сцене', () => {
    const anchors = OFFICE_ROLES.map((role, i) => ({ role, x: 124 + i % 3 * 4, y: 250 + i % 4 * 4, width: 86, height: 28 }));
    const positions = placeOfficeAlerts(anchors, 248, 520, 86, 28);
    expect(positions).toHaveLength(OFFICE_ROLES.length);
    for (const [i, p] of positions.entries()) {
      expect(p.x).toBeGreaterThanOrEqual(0);expect(p.y).toBeGreaterThanOrEqual(0);expect(p.x + 86).toBeLessThanOrEqual(248);expect(p.y + 28).toBeLessThanOrEqual(520);
      for (const q of positions.slice(i + 1)) expect(p.x + 86 <= q.x || q.x + 86 <= p.x || p.y + 28 <= q.y || q.y + 28 <= p.y).toBe(true);
    }
  });
});
