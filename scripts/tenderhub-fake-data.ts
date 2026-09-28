// Данные поддельного TenderHub: числа-лексемы, строки ответа, построители и эталонный тендер для тестов,
// smoke и ui-check (сервер — scripts/tenderhub-fake.ts). Рабочей интеграцией не является.

// Число ответа — текст лексемы, выводится в JSON без кавычек.
export interface INum {
  __num: string;
}
export const n = (lexeme: string): INum => ({ __num: lexeme });

export type Json = null | undefined | boolean | string | INum | Json[] | { [k: string]: Json };

export const isNum = (v: unknown): v is INum => typeof v === 'object' && v !== null && '__num' in v;

export const toJson = (v: Json): string => {
  if (v === null || v === undefined) return 'null';
  if (isNum(v)) return v.__num;
  if (Array.isArray(v)) return `[${v.map(toJson).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}:${toJson(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
};

export type FakeRow = { [k: string]: Json };

export interface IFakeTender {
  id: string;
  tender_number: string;
  title: string;
  client_name: string;
  version: number | null;
  is_archived: boolean;
  housing_class: string | null;
  construction_scope: string | null;
  submission_deadline: string | null;
  created_at: string;
  updated_at: string;
  cached_grand_total: INum;
  usd_rate: INum | null;
  eur_rate: INum | null;
  cny_rate: INum | null;
  positions: FakeRow[];
  items: FakeRow[];
}

// ---------------------------------------------------------------- Построители данных

const PAST = '2026-09-01T10:00:00Z';

export const fakePosition = (tenderId: string, id: string, p: Partial<FakeRow> & { position_number: INum; work_name: string }): FakeRow => ({
  id,
  tender_id: tenderId,
  item_no: null,
  client_note: null,
  unit_code: 'м3',
  volume: n('1'),
  manual_volume: null,
  manual_note: null,
  hierarchy_level: n('1'),
  is_additional: false,
  parent_position_id: null,
  total_material: n('0'),
  total_works: n('0'),
  material_cost_per_unit: n('0'),
  work_cost_per_unit: n('0'),
  total_commercial_material: n('0'),
  total_commercial_work: n('0'),
  total_commercial_material_per_unit: n('0'),
  total_commercial_work_per_unit: n('0'),
  rich_runs: null,
  created_at: PAST,
  updated_at: PAST,
  base_total: n('0'),
  commercial_total: n('0'),
  material_cost_total: n('0'),
  work_cost_total: n('0'),
  markup_percentage: n('0'),
  items_count: n('0'),
  section_number: null,
  position_name: null,
  is_section: false,
  cost_category_id: null,
  cost_category_name: null,
  ...p,
});

export const fakeItem = (tenderId: string, positionId: string, id: string, i: Partial<FakeRow> & { boq_item_type: string }): FakeRow => ({
  id,
  tender_id: tenderId,
  client_position_id: positionId,
  sort_number: n('1'),
  material_type: null,
  description: null,
  unit_code: 'м3',
  quantity: n('1'),
  base_quantity: n('1'),
  consumption_coefficient: n('1'),
  conversion_coefficient: n('1'),
  unit_rate: n('0'),
  currency_type: 'RUB',
  delivery_price_type: 'в цене',
  delivery_amount: n('0'),
  total_amount: n('0'),
  commercial_markup: n('1'),
  total_commercial_material_cost: n('0'),
  total_commercial_work_cost: n('0'),
  detail_cost_category_id: null,
  material_name_id: null,
  work_name_id: null,
  parent_work_item_id: null,
  quote_link: null,
  import_session_id: null,
  created_at: PAST,
  updated_at: PAST,
  work_names: null,
  material_names: null,
  parent_work: null,
  detail_cost_categories: null,
  ...i,
});

export const fakeTender = (t: Partial<IFakeTender> & { id: string; tender_number: string }): IFakeTender => ({
  title: `Тендер ${t.tender_number}`,
  client_name: 'Заказчик',
  version: 1,
  is_archived: false,
  housing_class: null,
  construction_scope: 'генподряд',
  submission_deadline: null,
  created_at: PAST,
  updated_at: PAST,
  cached_grand_total: n('0'),
  usd_rate: n('90.5'),
  eur_rate: n('99.25'),
  cny_rate: n('12.75'),
  positions: [],
  items: [],
  ...t,
});

// ---------------------------------------------------------------- Эталонный тендер (тесты, smoke, ui-check)

// Ключ поддельного сервера — не секрет: настоящий ключ живёт только в окружении (U-04).
export const TH_KEY = 'thk_test_1234567890abcdef';

// Внешние id эталонного тендера (TenderHub отдаёт uuid).
export const TH = {
  tender: '7d1f0c8e-1111-4a6b-9c1d-000000000001',
  p0: '7d1f0c8e-2222-4a6b-9c1d-000000000000',
  p1: '7d1f0c8e-2222-4a6b-9c1d-000000000001',
  p2: '7d1f0c8e-2222-4a6b-9c1d-000000000002',
  p3: '7d1f0c8e-2222-4a6b-9c1d-000000000003',
  l1: '7d1f0c8e-3333-4a6b-9c1d-000000000001',
  l2: '7d1f0c8e-3333-4a6b-9c1d-000000000002',
  l3: '7d1f0c8e-3333-4a6b-9c1d-000000000003',
};

// Цена с 21 значащей цифрой: float64 её не удержал бы — проверка цепочки ответ → разбор → БД → API.
export const PRECISE_RATE = '123456789012345.678901';

// Раздел (заголовок), позиция с работой и комплексной строкой материала к ней, пустая позиция,
// дополнительная позиция со строкой в долларах и manual_volume без подтверждённой семантики.
export const standardTender = (id = TH.tender, number = 'TH-2026-001'): IFakeTender => {
  const p = (pid: string, row: Parameters<typeof fakePosition>[2]) => fakePosition(id, pid, row);
  const i = (pos: string, iid: string, row: Parameters<typeof fakeItem>[3]) => fakeItem(id, pos, iid, row);
  return fakeTender({
    id,
    tender_number: number,
    title: 'ЖК «Северный» — корпус 2',
    client_name: 'ООО «Заказчик»',
    version: 3,
    submission_deadline: '2026-10-15 12:00:00+03',
    cached_grand_total: n('1860.9'),
    positions: [
      p(TH.p0, { position_number: n('1'), work_name: 'Раздел 1. Монолитные работы', is_section: true, hierarchy_level: n('1'), unit_code: null, volume: null }),
      p(TH.p1, {
        position_number: n('1.1'),
        item_no: '1.1',
        work_name: 'Бетонирование плиты перекрытия',
        client_note: 'класс бетона по проекту',
        volume: n('125.5'),
        hierarchy_level: n('2'),
        parent_position_id: TH.p0,
        cost_category_name: 'МОНОЛИТНЫЕ РАБОТЫ',
        base_total: n('1500.75'),
        commercial_total: n('1800.9'),
        total_material: n('500.25'),
        total_works: n('1000.5'),
        total_commercial_material: n('600.3'),
        total_commercial_work: n('1200.6'),
        markup_percentage: n('20.0000000000001'),
        items_count: n('2'),
      }),
      p(TH.p2, { position_number: n('1.2'), item_no: '1.2', work_name: 'Устройство гидроизоляции', hierarchy_level: n('2'), parent_position_id: TH.p0 }),
      p(TH.p3, {
        position_number: n('2'),
        item_no: '2',
        work_name: 'Вывоз грунта',
        is_additional: true,
        manual_volume: n('40'),
        manual_note: 'по факту вывоза',
        base_total: n('50'),
        commercial_total: n('60'),
        total_works: n('50'),
        total_commercial_work: n('60'),
        items_count: n('1'),
      }),
    ],
    items: [
      i(TH.p1, TH.l1, {
        boq_item_type: 'раб',
        sort_number: n('1'),
        description: 'Бетонирование',
        quantity: n('125.5'),
        unit_rate: n('7.97211155378486'),
        total_amount: n('1000.5'),
        total_commercial_work_cost: n('1200.6'),
        work_names: { name: 'Бетонирование конструкций', unit: 'м3' },
        detail_cost_categories: { name: 'Бетонные работы', location: 'Корпус 2', cost_categories: { name: 'МОНОЛИТНЫЕ РАБОТЫ' } },
      }),
      i(TH.p1, TH.l2, {
        boq_item_type: 'мат-комп.',
        material_type: 'основн.',
        sort_number: n('2'),
        quantity: n('1e-7'),
        consumption_coefficient: n('1.02'),
        unit_rate: n(PRECISE_RATE),
        total_amount: n('500.25'),
        total_commercial_material_cost: n('600.3'),
        parent_work_item_id: TH.l1,
        material_names: { name: 'Бетон B30', unit: 'м3' },
        parent_work: { work_names: { name: 'Бетонирование конструкций' } },
      }),
      i(TH.p3, TH.l3, {
        boq_item_type: 'суб-раб',
        sort_number: n('1'),
        unit_code: 'т',
        quantity: n('40'),
        unit_rate: n('12.5'),
        currency_type: 'USD',
        total_amount: n('50'),
        total_commercial_work_cost: n('60'),
        work_names: { name: 'Вывоз грунта самосвалами', unit: 'т' },
      }),
    ],
  });
};
