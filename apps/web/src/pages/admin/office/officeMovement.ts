import { OFFICE_ROLES, type TOfficeRole } from './officeModel.js';

export interface IOfficePoint { x: number; z: number }
export interface IOfficeWalk { points: IOfficePoint[]; length: number; distance: number }
export const WALK_SPEED = 3.4;

export const deskPosition = (role: TOfficeRole): IOfficePoint => {
  const index = OFFICE_ROLES.indexOf(role);
  return { x: (index % 4 - 1.5) * 7, z: Math.floor(index / 4) * 6 - 8 };
};

/** Кресло перед экраном; лицо сидящего направлено к монитору (rotation.y = PI). */
export const computerSeat = (role: TOfficeRole): IOfficePoint => {
  const desk = deskPosition(role);
  return { x: desk.x + .5, z: desk.z + 1.9 };
};

/** Посадка/подъём сохраняются между опросами и не меняются на замороженном кадре. */
export const advanceOfficeSeating = (amount: number, seated: boolean, seconds: number): number => {
  const target = seated ? 1 : 0, step = Math.max(0, seconds) / .28;
  return Math.max(0, Math.min(1, amount + Math.max(-step, Math.min(step, target - amount))));
};

export const REST_SPOTS: Record<TOfficeRole, IOfficePoint> = {
  intake: { x: -2, z: 13.2 }, recognition: { x: 6, z: 13.35 },
  archive: { x: 3.3, z: 17.2 }, analyst: { x: 9, z: 13.35 },
  estimator: { x: -4, z: 18 }, reviewer: { x: 0, z: 18 },
  assembler: { x: -11.8, z: 13.8 }, courier: { x: -8.7, z: 16.8 },
  model: { x: 12, z: 13.35 }, other: { x: 1.5, z: 13.3 },
};

/** Постоянный путь по проходам: стол → дверь → собственное место отдыха.
 * Пройденное расстояние сохраняется при опросе очереди; смена состояния разворачивает шаг. */
export const createOfficeWalk = (role: TOfficeRole): IOfficeWalk => {
  const desk = deskPosition(role), rest = REST_SPOTS[role];
  const points: IOfficePoint[] = [
    computerSeat(role), { x: desk.x - 3.2, z: desk.z + 1.9 },
    { x: desk.x - 3.2, z: 7.2 }, { x: 0, z: 7.2 }, { x: 0, z: 10.2 },
  ];
  if (role === 'recognition' || role === 'analyst' || role === 'model') {
    points.push({ x: 0, z: 14.4 }, { x: rest.x, z: 14.4 });
  } else if (role === 'courier') {
    points.push({ x: -4.5, z: 10.2 }, { x: -4.5, z: 17.5 }, { x: rest.x, z: 17.5 });
  } else if (role === 'archive') {
    points.push({ x: 0, z: 18.2 }, { x: rest.x, z: 18.2 });
  } else points.push({ x: rest.x, z: 10.2 });
  points.push({ ...rest });
  const length = points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - points[i]!.x, point.z - points[i]!.z), 0);
  return { points, length, distance: 0 };
};

export const pointOnOfficeWalk = (walk: IOfficeWalk): IOfficePoint => {
  if (walk.distance >= walk.length) return { ...walk.points[walk.points.length - 1]! };
  let remaining = Math.max(0, Math.min(walk.length, walk.distance));
  for (let i = 1; i < walk.points.length; i++) {
    const a = walk.points[i - 1]!, b = walk.points[i]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (remaining <= length && length > 0) return { x: a.x + (b.x - a.x) * remaining / length, z: a.z + (b.z - a.z) * remaining / length };
    remaining -= length;
  }
  return { ...walk.points[walk.points.length - 1]! };
};

export const advanceOfficeWalk = (walk: IOfficeWalk, target: number, seconds: number): boolean => {
  const delta = Math.max(-WALK_SPEED * seconds, Math.min(WALK_SPEED * seconds, target - walk.distance));
  walk.distance = Math.max(0, Math.min(walk.length, walk.distance + delta));
  return Math.abs(delta) > .00001;
};
