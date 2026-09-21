// Пересчёт координат доказательства в прямоугольник страницы (A17). Проверяются обе
// гипотезы пространства: координаты уже в растровом (повёрнутом) виде и координаты
// в неповёрнутом виде, когда поворот надо применить самим.
import { describe, expect, it } from 'vitest';
import { bboxSpaceMatchesViewport, bboxToRect, polygonToPoints } from '../apps/web/src/utils/bbox';

const viewport = { width: 1000, height: 500 };

// Доли страницы умножаются на пиксели: сравниваем с точностью до 1e-6, а не побитно.
const rounded = (r: { left: number; top: number; width: number; height: number } | null) =>
  r === null ? null : Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));
const roundedPoints = (p: { x: number; y: number }[]) => p.map((v) => ({ x: Math.round(v.x * 1e6) / 1e6, y: Math.round(v.y * 1e6) / 1e6 }));

describe('координаты доказательства', () => {
  it('растровое пространство: поворот уже применён экспортом', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const rect = rounded(bboxToRect([0.1, 0.2, 0.3, 0.6], 'page_rotated', rotation, viewport));
      expect(rect, `поворот ${rotation}`).toEqual({ left: 100, top: 100, width: 200, height: 200 });
    }
  });

  it('неповёрнутое пространство: поворот применяется к каждому углу', () => {
    const square = [0.1, 0.2, 0.3, 0.6] as const;
    expect(rounded(bboxToRect(square, 'page_unrotated', 0, viewport))).toEqual({ left: 100, top: 100, width: 200, height: 200 });
    // 90°: (x, y) → (1 − y, x). Углы (0.1,0.2) и (0.3,0.6) → (0.8,0.1) и (0.4,0.3).
    expect(rounded(bboxToRect(square, 'page_unrotated', 90, viewport))).toEqual({ left: 400, top: 50, width: 400, height: 100 });
    // 180°: (x, y) → (1 − x, 1 − y).
    expect(rounded(bboxToRect(square, 'page_unrotated', 180, viewport))).toEqual({ left: 700, top: 200, width: 200, height: 200 });
    // 270°: (x, y) → (y, 1 − x).
    expect(rounded(bboxToRect(square, 'page_unrotated', 270, viewport))).toEqual({ left: 200, top: 350, width: 400, height: 100 });
  });

  it('вырожденные значения не дают ложной рамки', () => {
    expect(bboxToRect([0.1, 0.2, 0.3], 'page_rotated', 0, viewport)).toBeNull();
    expect(bboxToRect([0.1, Number.NaN, 0.3, 0.6], 'page_rotated', 0, viewport)).toBeNull();
    // Значения вне [0, 1] усечены, а не отброшены: рамка остаётся внутри страницы.
    expect(rounded(bboxToRect([-0.5, 0, 1.5, 1], 'page_rotated', 0, viewport))).toEqual({ left: 0, top: 0, width: 1000, height: 500 });
  });

  it('многоугольник переводится в точки того же пространства', () => {
    expect(roundedPoints(polygonToPoints([0, 0, 1, 0, 1, 1], 'page_rotated', 0, viewport))).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 500 },
    ]);
    expect(roundedPoints(polygonToPoints([0, 0, 1, 0], 'page_unrotated', 90, viewport))).toEqual([
      { x: 1000, y: 0 },
      { x: 1000, y: 500 },
    ]);
  });

  it('сверка пространства по пропорциям страницы', () => {
    expect(bboxSpaceMatchesViewport({ widthPx: 2000, heightPx: 1000 }, viewport)).toBe(true);
    expect(bboxSpaceMatchesViewport({ widthPx: 1000, heightPx: 2000 }, viewport)).toBe(false);
    // Без размеров из экспорта вывода нет — и подсказка не выдумывается.
    expect(bboxSpaceMatchesViewport({ widthPx: null, heightPx: null }, viewport)).toBeNull();
  });
});
