// Пересчёт нормализованных координат фрагмента в прямоугольник на отрисованной странице PDF.
// Экспорт RDWeb объявляет пространство normalized_page_top_left: начало в левом верхнем углу,
// ось Y вниз — как у canvas. Открытый вопрос — применён ли к этим числам поворот страницы.
// PDF-парсера в портале нет, поэтому пространство берётся из фрагмента (bboxSpace), а не
// угадывается: неверно нанесённая рамка хуже её отсутствия (I18, A17).

export type TBboxSpace = 'page_unrotated' | 'page_rotated';

export interface IRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface IViewport {
  width: number;
  height: number;
}

// Координаты вне [0,1] не обрезаются: обрезка превратила бы ошибку источника в
// правдоподобную, но ложную область оригинала. Такой фрагмент остаётся без выделения (R04-09).
const inRange01 = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= 1;

/** Поворот точки из неповёрнутого пространства страницы в растровое (по часовой стрелке). */
const rotatePoint = (x: number, y: number, rotation: number): [number, number] => {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [1 - y, x];
    case 180:
      return [1 - x, 1 - y];
    case 270:
      return [y, 1 - x];
    default:
      return [x, y];
  }
};

/**
 * bbox — [x0, y0, x1, y1] в долях страницы. viewport — размеры отрисованной страницы
 * (pdf.js уже применил к ней /Rotate). Результат — прямоугольник в пикселях этого viewport.
 */
export const bboxToRect = (bbox: readonly number[], space: TBboxSpace, rotation: number, viewport: IViewport): IRect | null => {
  if (bbox.length !== 4 || !bbox.every(inRange01)) {
    return null;
  }
  const [x0, y0, x1, y1] = bbox as unknown as [number, number, number, number];
  const rotated = space === 'page_rotated';
  const a: [number, number] = rotated ? [x0, y0] : rotatePoint(x0, y0, rotation);
  const b: [number, number] = rotated ? [x1, y1] : rotatePoint(x1, y1, rotation);
  const left = Math.min(a[0], b[0]);
  const right = Math.max(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  const bottom = Math.max(a[1], b[1]);
  return {
    left: left * viewport.width,
    top: top * viewport.height,
    width: (right - left) * viewport.width,
    height: (bottom - top) * viewport.height,
  };
};

/** Многоугольник блока в точки viewport (для polygon-блоков экспорта). */
export const polygonToPoints = (
  polygon: readonly number[],
  space: TBboxSpace,
  rotation: number,
  viewport: IViewport,
): { x: number; y: number }[] => {
  if (polygon.length < 6 || polygon.length % 2 !== 0 || !polygon.every(inRange01)) {
    return [];
  }
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < polygon.length; i += 2) {
    const [px, py] = space === 'page_rotated' ? [polygon[i]!, polygon[i + 1]!] : rotatePoint(polygon[i]!, polygon[i + 1]!, rotation);
    points.push({ x: px * viewport.width, y: py * viewport.height });
  }
  return points;
};

/**
 * Подсказка о пространстве координат: сверяет размеры страницы из экспорта с размерами,
 * которые даёт pdf.js после поворота. Расхождение — повод усомниться в рамке, а не тихо
 * её сдвинуть: вызывающий показывает предупреждение.
 */
export const bboxSpaceMatchesViewport = (
  page: { widthPx: number | null; heightPx: number | null },
  viewport: IViewport,
): boolean | null => {
  if (!page.widthPx || !page.heightPx || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const exportRatio = page.widthPx / page.heightPx;
  const viewRatio = viewport.width / viewport.height;
  return Math.abs(exportRatio - viewRatio) <= 0.05 * Math.max(exportRatio, viewRatio);
};

export interface IEvidenceOverlay {
  rect: IRect | null;
  polygon: { x: number; y: number }[];
  spaceMatches: boolean | null;
  /** Координаты у фрагмента есть, но наносить их нельзя: страница показывается без выделения. */
  suppressed: boolean;
}

/**
 * Решение о выделении на странице. Рамка наносится только там, где её положение доказуемо:
 * координаты в допустимом диапазоне и пространство экспорта сошлось с геометрией страницы PDF.
 * Иначе показывается страница и текст, а выделения нет — неверная рамка хуже её отсутствия
 * (I18, A17, R04-09).
 */
export const evidenceOverlay = (input: {
  bboxNorm: readonly number[] | null;
  polygonNorm: readonly number[] | null;
  space: TBboxSpace;
  rotation: number;
  viewport: IViewport;
  page: { widthPx: number | null; heightPx: number | null };
}): IEvidenceOverlay => {
  const spaceMatches = bboxSpaceMatchesViewport(input.page, input.viewport);
  const hasCoords = (input.bboxNorm?.length ?? 0) > 0 || (input.polygonNorm?.length ?? 0) > 0;
  if (spaceMatches === false) {
    return { rect: null, polygon: [], spaceMatches, suppressed: hasCoords };
  }
  const rect = input.bboxNorm ? bboxToRect(input.bboxNorm, input.space, input.rotation, input.viewport) : null;
  const polygon = input.polygonNorm ? polygonToPoints(input.polygonNorm, input.space, input.rotation, input.viewport) : [];
  return { rect, polygon, spaceMatches, suppressed: hasCoords && rect === null && polygon.length === 0 };
};
