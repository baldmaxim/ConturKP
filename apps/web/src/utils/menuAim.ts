// Геометрия контекстного меню: «невидимый треугольник» подменю (menu aim, как в macOS)
// и размещение панелей в окне. Чистые функции — без DOM.

export interface IPoint {
  x: number;
  y: number;
}

export interface IRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ISize {
  width: number;
  height: number;
}

/** Запас по вертикали к углам подменю: прощает дрожание руки у верхнего и нижнего края. */
export const AIM_TOLERANCE = 20;
/** Отступ панелей от краёв окна. */
export const VIEWPORT_MARGIN = 8;
/** Насколько подменю заходит на край родительской панели. */
export const SUBMENU_OVERLAP = 4;

// Знак векторного произведения (b − a) × (p − a): с какой стороны прямой ab лежит p.
const cross = (a: IPoint, b: IPoint, p: IPoint): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

/** Точка строго внутри треугольника abc (граница — снаружи, вырожденный треугольник пуст). */
export const pointInTriangle = (p: IPoint, a: IPoint, b: IPoint, c: IPoint): boolean => {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
};

/**
 * Указатель идёт к подменю: новая точка `to` лежит в треугольнике между прежней точкой `from`
 * и ближним к родителю краем подменю (верхний и нижний углы с запасом). Пока это так, пункты
 * родителя, через которые проходит указатель по диагонали, не перехватывают выделение.
 */
export const isAimingAtSubmenu = (from: IPoint, to: IPoint, submenu: IRect, parent: IRect, tolerance = AIM_TOLERANCE): boolean => {
  const toRight = submenu.left + submenu.right >= parent.left + parent.right;
  const edgeX = toRight ? submenu.left : submenu.right;
  return pointInTriangle(to, from, { x: edgeX, y: submenu.top - tolerance }, { x: edgeX, y: submenu.bottom + tolerance });
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/** Корневая панель у точки щелчка; не влезает вправо или вниз — открывается влево или вверх от неё. */
export const placeAtPoint = (point: IPoint, size: ISize, viewport: ISize, margin = VIEWPORT_MARGIN): IPoint => {
  const x = point.x + size.width > viewport.width - margin ? point.x - size.width : point.x;
  const y = point.y + size.height > viewport.height - margin ? point.y - size.height : point.y;
  return {
    x: clamp(x, margin, viewport.width - margin - size.width),
    y: clamp(y, margin, viewport.height - margin - size.height),
  };
};

/**
 * Подменю сбоку от родителя: первый пункт на одной линии с пунктом-родителем (выше на `inset` —
 * рамку и внутренний отступ панели). Справа не влезает — слева; нигде — туда, где места больше.
 */
export const placeBeside = (trigger: IRect, parent: IRect, size: ISize, viewport: ISize, inset: number, margin = VIEWPORT_MARGIN): IPoint => {
  const rightX = parent.right - SUBMENU_OVERLAP;
  const leftX = parent.left - size.width + SUBMENU_OVERLAP;
  const fitsRight = rightX + size.width <= viewport.width - margin;
  const fitsLeft = leftX >= margin;
  const roomierRight = viewport.width - parent.right >= parent.left;
  const x = fitsRight || (!fitsLeft && roomierRight) ? rightX : leftX;
  return {
    x: clamp(x, margin, viewport.width - margin - size.width),
    y: clamp(trigger.top - inset, margin, viewport.height - margin - size.height),
  };
};
