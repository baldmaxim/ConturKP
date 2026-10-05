// Контракт адаптера для коммерческих составляющих, которых нет в данных по ключу (проект §5.6, D-030 п. 11): значение
// не выводится из других полей — остаток итога не записывается ни в страхование, ни во что-либо иное.
export type CommercialComponentCode = 'insurance' | 'reduction' | 'redistribution' | 'position_adjustments' | 'vat' | 'fi_breakdown' | 'calculation_state';
export type CommercialComponentStatus = 'available' | 'unavailable_by_key' | 'not_in_source_model';

export interface ICommercialComponent {
  code: CommercialComponentCode;
  status: CommercialComponentStatus;
  reason: string;
  source: { route: string | null; contractVersion: string };
}

// Транспорт api (X-API-Key, tenders:read): все составляющие — только под JWT человека (семантика §4).
export const tenderHubApiComponents = (contractVersion: string): ICommercialComponent[] => {
  const c = (code: CommercialComponentCode, route: string, reason: string): ICommercialComponent => ({
    code,
    status: 'unavailable_by_key',
    reason,
    source: { route, contractVersion },
  });
  return [
    c('insurance', 'GET /api/v1/tenders/{id}/insurance', 'страхование тендера отдаётся только по JWT; в cached_grand_total входит по описанию исследованного кода'),
    c('reduction', 'GET /api/v1/tenders/{id}/fi-discounts', 'снижение (страница «Финансовые показатели») отдаётся только по JWT'),
    c('redistribution', 'GET /api/v1/redistributions', 'перераспределение отдаётся только по JWT'),
    c('position_adjustments', 'GET /api/v1/redistributions', 'корректировки позиций — часть правил перераспределения, только по JWT'),
    c('vat', 'GET /api/v1/tenders/{id}', 'признак НДС сумм не отдаётся; статус — неизвестен до ответа Т-10-1'),
    c('fi_breakdown', 'GET /api/v1/tenders/{id}', 'разбивка «Финансовых показателей» считается в интерфейсе TenderHub, по ключу не отдаётся'),
    c('calculation_state', 'GET /api/v1/tenders/{id}', 'ревизии и статус пересчёта расчёта отдаются только по JWT: свежесть итога неизвестна'),
  ];
};
