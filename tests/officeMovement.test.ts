import { describe, expect, it } from 'vitest';
import { OFFICE_ROLES } from '../apps/web/src/pages/admin/office/officeModel.ts';
import { advanceOfficeSeating, advanceOfficeWalk, computerSeat, createOfficeWalk, deskPosition, pointOnOfficeWalk, REST_SPOTS, WALK_SPEED } from '../apps/web/src/pages/admin/office/officeMovement.ts';

describe('Пешие маршруты офиса', () => {
  it('каждый маршрут начинается у стола, проходит через дверь и заканчивается собственным местом отдыха', () => {
    for (const role of OFFICE_ROLES) {
      const walk = createOfficeWalk(role), desk = deskPosition(role);
      expect(pointOnOfficeWalk(walk)).toEqual(computerSeat(role));
      expect(computerSeat(role)).toEqual({ x: desk.x + .5, z: desk.z + 1.9 });
      expect(walk.points).toContainEqual({ x: 0, z: 10.2 });
      walk.distance = walk.length;
      expect(pointOnOfficeWalk(walk)).toEqual(REST_SPOTS[role]);
    }
    expect(new Set(Object.values(REST_SPOTS).map((p) => `${p.x}:${p.z}`)).size).toBe(OFFICE_ROLES.length);
  });

  it('движение непрерывно, в том числе на поворотах; столы и перегородки обходятся по проходам', () => {
    for (const role of OFFICE_ROLES) {
      const walk = createOfficeWalk(role);
      for (let step = 0; step < 1600; step++) {
        const before = pointOnOfficeWalk(walk);advanceOfficeWalk(walk, walk.length, .02);const point = pointOnOfficeWalk(walk);
        expect(Math.hypot(point.x - before.x, point.z - before.z)).toBeLessThanOrEqual(WALK_SPEED * .02 + .000001);
        if (point.z > 8.5 && point.z < 9.5) expect(Math.abs(point.x)).toBeLessThan(1);
        for (const deskRole of OFFICE_ROLES) {
          const desk = deskPosition(deskRole);
          expect(Math.abs(point.x - desk.x) < 2.3 && Math.abs(point.z - desk.z) < 1.35).toBe(false);
        }
      }
      expect(walk.distance).toBe(walk.length);
    }
  });

  it('новая задача разворачивает агента из текущей точки, затем он доходит до стола', () => {
    const walk = createOfficeWalk('recognition');advanceOfficeWalk(walk, walk.length, 2);
    const before = pointOnOfficeWalk(walk), distance = walk.distance;
    advanceOfficeWalk(walk, 0, .04);
    expect(walk.distance).toBeCloseTo(distance - WALK_SPEED * .04);
    expect(Math.hypot(pointOnOfficeWalk(walk).x - before.x, pointOnOfficeWalk(walk).z - before.z)).toBeLessThan(.14);
    advanceOfficeWalk(walk, 0, 100);expect(walk.distance).toBe(0);
  });

  it('пауза и повторное обновление цели не меняют пройденное расстояние', () => {
    const walk = createOfficeWalk('courier');advanceOfficeWalk(walk, walk.length, 1);
    const point = pointOnOfficeWalk(walk);advanceOfficeWalk(walk, walk.length, 0);
    expect(pointOnOfficeWalk(walk)).toEqual(point);
    advanceOfficeWalk(walk, walk.length, 1);expect(walk.distance).toBeCloseTo(WALK_SPEED * 2);
  });

  it('посадка и подъём непрерывны, на паузе поза сохраняется', () => {
    let sit = 0;
    for (let i = 0; i < 14; i++) { const before = sit;sit = advanceOfficeSeating(sit, true, .02);expect(sit - before).toBeLessThanOrEqual(.02 / .28 + 1e-9); }
    expect(sit).toBeCloseTo(1);expect(advanceOfficeSeating(sit, false, 0)).toBe(sit);
    sit = advanceOfficeSeating(sit, false, .04);expect(sit).toBeGreaterThan(0);expect(sit).toBeLessThan(1);
    expect(advanceOfficeSeating(sit, false, 1)).toBe(0);
  });
});
