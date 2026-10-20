// Контекстное меню: «невидимый треугольник» к подменю и размещение панелей в окне.
import { describe, expect, it } from 'vitest';
import { SUBMENU_OVERLAP, VIEWPORT_MARGIN, isAimingAtSubmenu, placeAtPoint, placeBeside, pointInTriangle } from '../apps/web/src/utils/menuAim.ts';

const viewport = { width: 1280, height: 800 };
// Родитель 200×300 у левого края, пункт-родитель — вторая строка; подменю справа, первый пункт на линии родителя.
const parent = { left: 0, top: 0, right: 200, bottom: 300 };
const submenuRight = { left: 196, top: 34, right: 396, bottom: 154 };
const submenuLeft = { left: -196, top: 34, right: 4, bottom: 154 };

describe('pointInTriangle', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  const c = { x: 0, y: 10 };

  it('внутри — да, снаружи и на границе — нет', () => {
    expect(pointInTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true);
    expect(pointInTriangle({ x: 8, y: 8 }, a, b, c)).toBe(false);
    expect(pointInTriangle({ x: 5, y: 0 }, a, b, c)).toBe(false);
  });

  it('порядок вершин не важен; вырожденный треугольник пуст', () => {
    expect(pointInTriangle({ x: 2, y: 2 }, a, c, b)).toBe(true);
    expect(pointInTriangle({ x: 0, y: 0 }, a, a, a)).toBe(false);
  });
});

describe('isAimingAtSubmenu', () => {
  const from = { x: 120, y: 50 };

  it('диагональ к подменю — через нижние пункты родителя — внутри треугольника', () => {
    expect(isAimingAtSubmenu(from, { x: 126, y: 54 }, submenuRight, parent)).toBe(true);
    // Строка ниже пункта-родителя: без треугольника она перехватила бы выделение.
    expect(isAimingAtSubmenu(from, { x: 140, y: 80 }, submenuRight, parent)).toBe(true);
  });

  it('вниз, вверх, назад и на месте — не к подменю', () => {
    expect(isAimingAtSubmenu(from, { x: 120, y: 60 }, submenuRight, parent)).toBe(false);
    expect(isAimingAtSubmenu(from, { x: 121, y: 30 }, submenuRight, parent)).toBe(false);
    expect(isAimingAtSubmenu(from, { x: 110, y: 52 }, submenuRight, parent)).toBe(false);
    expect(isAimingAtSubmenu(from, from, submenuRight, parent)).toBe(false);
  });

  it('круче угла к нижнему краю подменю (с запасом) — уже не к нему', () => {
    // Нижний угол с запасом: (196, 174); от from наклон 124/76 ≈ 1,63.
    expect(isAimingAtSubmenu(from, { x: 130, y: 66 }, submenuRight, parent)).toBe(true);
    expect(isAimingAtSubmenu(from, { x: 130, y: 68 }, submenuRight, parent)).toBe(false);
    expect(isAimingAtSubmenu(from, { x: 130, y: 68 }, submenuRight, parent, 40)).toBe(true);
  });

  it('подменю слева от родителя — треугольник смотрит влево', () => {
    expect(isAimingAtSubmenu({ x: 80, y: 50 }, { x: 70, y: 60 }, submenuLeft, parent)).toBe(true);
    expect(isAimingAtSubmenu({ x: 80, y: 50 }, { x: 90, y: 60 }, submenuLeft, parent)).toBe(false);
  });
});

describe('placeAtPoint', () => {
  const size = { width: 220, height: 180 };

  it('влезает — левый верхний угол в точке щелчка', () => {
    expect(placeAtPoint({ x: 300, y: 200 }, size, viewport)).toEqual({ x: 300, y: 200 });
  });

  it('у правого и нижнего края — открывается влево и вверх от точки', () => {
    expect(placeAtPoint({ x: 1200, y: 700 }, size, viewport)).toEqual({ x: 980, y: 520 });
  });

  it('у левого верхнего угла — не выходит за отступ окна', () => {
    expect(placeAtPoint({ x: 2, y: 3 }, size, viewport)).toEqual({ x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN });
  });

  it('узкий экран: ни вправо, ни влево не помещается — прижимается к левому краю окна', () => {
    expect(placeAtPoint({ x: 200, y: 100 }, size, { width: 360, height: 640 })).toEqual({ x: VIEWPORT_MARGIN, y: 100 });
  });
});

describe('placeBeside', () => {
  const size = { width: 200, height: 120 };
  const trigger = { left: 5, top: 40, right: 195, bottom: 68 };

  it('справа от родителя, первый пункт на линии пункта-родителя', () => {
    expect(placeBeside(trigger, parent, size, viewport, 6)).toEqual({ x: 200 - SUBMENU_OVERLAP, y: 34 });
  });

  it('справа не влезает — слева от родителя', () => {
    const right = { left: 1000, top: 0, right: 1200, bottom: 300 };
    const t = { left: 1005, top: 40, right: 1195, bottom: 68 };
    expect(placeBeside(t, right, size, viewport, 6)).toEqual({ x: 1000 - 200 + SUBMENU_OVERLAP, y: 34 });
  });

  it('у нижнего края — поднимается, чтобы влезть целиком', () => {
    const low = { left: 5, top: 740, right: 195, bottom: 768 };
    expect(placeBeside(low, parent, size, viewport, 6)).toEqual({ x: 196, y: 800 - VIEWPORT_MARGIN - 120 });
  });

  it('узкий экран: ни справа, ни слева — к стороне, где места больше, в пределах окна', () => {
    const phone = { width: 360, height: 640 };
    const middle = { left: 70, top: 0, right: 290, bottom: 300 };
    expect(placeBeside(trigger, middle, size, phone, 6)).toEqual({ x: 360 - VIEWPORT_MARGIN - 200, y: 34 });
  });
});
