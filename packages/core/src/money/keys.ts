// Детерминированные ключи сопоставления позиций и строк между ревизиями (D-030 В-10-5; проект §5.3). Ключи дают
// только предложения: уникальность совпадения не доказывает устойчивую идентичность позиции. Нечёткого сопоставления
// нет — его запрещает и аналитика версий самого TenderHub (TENDER_CHANGE_IMPACT_ANALYTICS.md:36-51).
import type { ILineInput } from './lineCost.ts';
import { WORK_TYPES } from './lineCost.ts';

// Нормализация текста — как NormalizeComparisonText TenderHub (analytics/changeimpact/keys.go:9-12): нижний регистр,
// обрезка и схлопывание пробелов; цифры, марки и артикулы не удаляются.
export const normKeyText = (s: string | null): string => (s ?? '').toLowerCase().trim().split(/\s+/u).filter(Boolean).join(' ');

export interface IPositionKeyInput {
  externalPositionId: string;
  positionNumber: string;
  itemNo: string | null;
  workName: string;
  unitCode: string | null;
  isAdditional: boolean | null;
  isSection: boolean;
}

// exact_key — ключ change-impact TenderHub: item_no | work_name | unit_code.
export const exactPositionKey = (p: IPositionKeyInput): string => [normKeyText(p.itemNo), normKeyText(p.workName), normKeyText(p.unitCode)].join('\u001f');

// position_key — ключ clone TenderHub: position_number | is_additional | work_name (tender_clone.go:101-118).
export const clonePositionKey = (p: IPositionKeyInput): string => [p.positionNumber, String(p.isAdditional), p.workName].join('\u001f');

const nameIdOf = (l: ILineInput): string => (WORK_TYPES.includes(l.itemType) ? (l.workNameId ?? l.materialNameId) : (l.materialNameId ?? l.workNameId)) ?? '';

const shallowLineIdentity = (l: ILineInput): string => [l.itemType, nameIdOf(l), normKeyText(l.unitCode)].join('\u001e');

// Ключ строки внутри пары позиций — как BuildBoqComparisonKey TenderHub: тип, номенклатура, единица, категория,
// идентичность родительской работы (не uuid) и описание.
export const lineKey = (l: ILineInput, parent: ILineInput | undefined): string =>
  [l.itemType, nameIdOf(l), normKeyText(l.unitCode), l.detailCostCategoryId ?? '', parent ? shallowLineIdentity(parent) : '', normKeyText(l.description)].join('\u001f');

// Группировка по ключу: ключи, встретившиеся ровно один раз, и повторы.
export const groupByKey = <T>(items: readonly T[], keyOf: (x: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
};
