import type { TOfficeRole } from './officeModel.js';
export interface IOfficeAgentAnchor { role: TOfficeRole; x: number; y: number; width?: number; height?: number }

/** Пока открыт ярлык, движение персонажей и опрос очереди не уводят его из-под указателя. */
export const createOfficeAlertLayout = () => {
  let previous: { width: number; height: number; positions: IOfficeAgentAnchor[] } | undefined;
  return (anchors: IOfficeAgentAnchor[], width: number, height: number, locked: boolean): IOfficeAgentAnchor[] => {
    if (locked && previous?.width === width && previous.height === height) return previous.positions;
    const positions = placeOfficeAlerts(anchors, width, height, 112, 26);
    previous = { width, height, positions };
    return positions;
  };
};

/** Окно подробностей не двигает ярлык под указателем и остаётся в пределах сцены. */
export const officePopoverPosition = (badge: { x: number; y: number; width: number; height: number }, sceneWidth: number, sceneHeight: number, width: number, height: number): { x: number; y: number } => {
  const x = Math.max(4, Math.min(sceneWidth - width - 4, badge.x + badge.width / 2 - width / 2));
  const above = badge.y - height - 8;
  const y = Math.max(4, Math.min(sceneHeight - height - 4, above >= 4 ? above : badge.y + badge.height + 8));
  return { x, y };
};
/** Подписи остаются в пределах сцены и не перекрывают друг друга. */
export const placeOfficeAlerts = (anchors: IOfficeAgentAnchor[], width: number, height: number, badgeWidth: number, badgeHeight: number): IOfficeAgentAnchor[] => {
  const gap = 6, edge = 4, placed: Array<IOfficeAgentAnchor & { width: number; height: number }> = [];
  for (const anchor of [...anchors].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const w = anchor.width ?? badgeWidth, h = anchor.height ?? badgeHeight;
    const wantedX = Math.max(edge, Math.min(width - w - edge, anchor.x - w / 2));
    const wantedY = Math.max(edge, Math.min(height - h - edge, anchor.y - h - 12));
    const xs = [wantedX, edge, width - w - edge, ...placed.flatMap((item) => [item.x - w - gap, item.x + item.width + gap])].filter((x) => x >= edge && x + w <= width - edge);
    const ys = [wantedY, edge, height - h - edge, ...placed.flatMap((item) => [item.y - h - gap, item.y + item.height + gap])].filter((y) => y >= edge && y + h <= height - edge);
    const candidates = xs.flatMap((x) => ys.map((y) => ({ x, y }))).sort((a, b) => Math.abs(a.x - wantedX) + Math.abs(a.y - wantedY) - Math.abs(b.x - wantedX) - Math.abs(b.y - wantedY));
    const position = candidates.find(({ x, y }) => placed.every((item) => x + w + gap <= item.x || item.x + item.width + gap <= x || y + h + gap <= item.y || item.y + item.height + gap <= y));
    if (!position) {
      // Плотная сцена: полки переменной высоты, включая компактные статусы свободных агентов.
      const sorted = [...anchors].sort((a, b) => a.y - b.y || a.x - b.x);
      let x = edge, y = edge, rowHeight = 0;
      return sorted.map((item) => {
        const itemWidth = item.width ?? badgeWidth, itemHeight = item.height ?? badgeHeight;
        if (x + itemWidth > width - edge) { x = edge;y += rowHeight + gap;rowHeight = 0; }
        const point = { role: item.role, x, y };x += itemWidth + gap;rowHeight = Math.max(rowHeight, itemHeight);return point;
      });
    }
    placed.push({ role: anchor.role, ...position, width: w, height: h });
  }
  return placed;
};
