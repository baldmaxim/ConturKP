// Подписи экономики этапа 10 (D-030). Термины — сметного отдела: вклад, остаток, колонка КП, предложение пары.
import type { IEconomicsMoney } from '../api/economicsTypes';
import { formatDecimal } from './calculationLabels';

export const COMPONENT_LABEL: Record<string, string> = {
  volume: 'Объём',
  unit_rate: 'Цена в валюте',
  currency_change: 'Цена (смена валюты)',
  fx_rate: 'Курс',
  delivery: 'Доставка',
  coefficient: 'Коэффициент строки (наценки, тактика, раскладка)',
  source_tail: 'Хвост расчёта источника',
  composition_added: 'Состав: добавлено',
  composition_removed: 'Состав: удалено',
  composition_changed: 'Состав: изменён',
  not_decomposable: 'Без разложения',
  incomparable_units: 'Несопоставимые единицы',
  unexplained_remainder: 'Неподтверждённый остаток уровня тендера',
};

export const FACTOR_LABEL: Record<string, string> = {
  quantity: 'количество',
  unit_rate: 'цена в валюте',
  fx_rate: 'курс',
  delivery: 'доставка',
  coefficient: 'коэффициент',
};

export const UNIT_KIND_LABEL: Record<string, string> = {
  matched: 'Пара',
  added: 'Добавлено',
  removed: 'Удалено',
  split_merge: 'Разделение / объединение',
};

export const DEVIATION_LABEL: Record<string, string> = {
  quantity_nonpositive: 'Количество ≤ 0 или пусто',
  negative_amount: 'Отрицательная сумма',
  unknown_item_type: 'Тип строки вне перечня',
  missing_commercial: 'Пустая коммерческая стоимость (не 0)',
  missing_fx_rate: 'Валютная строка без курса ревизии',
  bound_quantity_mismatch: 'Количество привязанного материала ≠ вывод из работы',
  recompute_outside_tolerance: 'Пересчёт вне допуска',
};

export const COMPONENT_CODE_LABEL: Record<string, string> = {
  insurance: 'Страхование',
  reduction: 'Снижение',
  redistribution: 'Перераспределение',
  position_adjustments: 'Корректировки позиций',
  vat: 'НДС',
  fi_breakdown: 'Разбивка «Финансовых показателей»',
  calculation_state: 'Статус пересчёта расчёта',
};

export const LINEAGE_METHOD_LABEL: Record<string, string> = {
  source_lineage: 'Та же позиция источника',
  exact_key: 'Ключ TenderHub (№ ВОР, наименование, единица)',
  position_key: 'Номер позиции и наименование',
  manual: 'Вручную',
};

export const REASON_KIND_LABEL: Record<string, string> = {
  document: 'Документ',
  answer: 'Ответ заказчика',
  supplier: 'Поставщик',
  internal_decision: 'Внутреннее решение',
  unknown: 'Не установлена',
};

export const REASON_STATUS_LABEL: Record<string, string> = {
  unknown: 'не установлена',
  hypothesis: 'предполагаемая',
  confirmed: 'подтверждена',
};

export const RECONCILIATION_LABEL: Record<string, string> = {
  reconciled: 'Сходится с итогом TenderHub в пределах допуска',
  residual_unconfirmed: 'Есть неподтверждённый остаток',
  no_target: 'Итог TenderHub не получен',
};

// Сумма в рублях: знак ₽ — подтверждённая валюта (D-030); НДС не указывается — неизвестен.
export const rub = (m: IEconomicsMoney | null | undefined): string => (m ? `${formatDecimal(m.amount)} ₽` : '—');

export const signed = (amount: string | null): string => {
  if (amount === null) return '—';
  const text = formatDecimal(amount);
  return amount.startsWith('-') ? text.replace('-', '−') : amount === '0' ? text : `+${text}`;
};
