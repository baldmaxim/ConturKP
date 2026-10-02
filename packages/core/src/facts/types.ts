// Перечень типов фактов D-018 (D-028: 13 типов донора Locus `fact-extractor.js`, правила `rules/1`) и их судьбы:
// стороны — в карточку договора, цена договора и итог сметы — в экономику (этап 10), остальные девять — кандидаты
// требований. Справочник БД `evidence_fact_type` повторяет этот список (миграция 0023).
export const FACT_RULES_VERSION = 'rules/1-kontur';

export const FACT_TYPES = [
  'party_customer',
  'party_contractor',
  'contract_price',
  'vat_rate',
  'advance_percent',
  'advance_term',
  'retention_percent',
  'retention_return_term',
  'warranty_period',
  'work_start_date',
  'work_end_date',
  'penalty_rate',
  'estimate_total',
] as const;
export type FactType = (typeof FACT_TYPES)[number];

export type FactFate = 'contract_card' | 'economics' | 'requirement_candidate';

export const FACT_TYPE_META: Record<FactType, { title: string; fate: FactFate }> = {
  party_customer: { title: 'Заказчик', fate: 'contract_card' },
  party_contractor: { title: 'Подрядчик', fate: 'contract_card' },
  contract_price: { title: 'Цена договора', fate: 'economics' },
  vat_rate: { title: 'Ставка НДС', fate: 'requirement_candidate' },
  advance_percent: { title: 'Размер аванса', fate: 'requirement_candidate' },
  advance_term: { title: 'Срок перечисления аванса', fate: 'requirement_candidate' },
  retention_percent: { title: 'Гарантийное удержание', fate: 'requirement_candidate' },
  retention_return_term: { title: 'Срок возврата гарантийного удержания', fate: 'requirement_candidate' },
  warranty_period: { title: 'Гарантийный срок', fate: 'requirement_candidate' },
  work_start_date: { title: 'Начало работ', fate: 'requirement_candidate' },
  work_end_date: { title: 'Окончание работ', fate: 'requirement_candidate' },
  penalty_rate: { title: 'Неустойка', fate: 'requirement_candidate' },
  estimate_total: { title: 'Итог сметы', fate: 'economics' },
};

// Вид документа по классификатору донора; неизвестное остаётся `other` — граф не предполагает связь, которой нет в тексте.
export const DOCUMENT_KINDS = ['contract', 'amendment', 'appendix', 'estimate', 'act', 'letter', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface IParentRef {
  number: string;
  numberKey: string;
  date: string | null;
}

export interface IDocumentClass {
  kind: DocumentKind;
  title: string;
  number: string;
  documentDate: string | null;
  parentRef: IParentRef | null;
  method: string;
}

// Фрагмент, из которого читается факт: строка таблицы (лист, CSV, таблица DOCX) или абзац.
export interface IFactSpan {
  fragmentId: string;
  text: string;
  tableRow: boolean;
}

export type FactNormalized = Record<string, string | number>;

export interface IExtractedFact {
  factType: FactType;
  rawValue: string;
  normalized: FactNormalized;
  normalizedKey: string;
  unit: string;
  condition: string;
  clauseRef: string;
  amends: boolean;
  fragmentIds: string[];
}

// Как утверждение называет условие каждого типа (R08a-04): по этим словам гейт ответа связывает величину утверждения
// с фактом её типа, а не с любым фактом той же величины («НДС 20%» — не аванс 20%). Шире слов вопроса планировщика:
// утверждение может назвать условие иначе, чем вопрос.
export const FACT_TYPE_MENTIONS: readonly (readonly [FactType, RegExp])[] = [
  ['party_customer', /заказчик/iu],
  ['party_contractor', /(?:ген)?подрядчик/iu],
  // «…% от цены договора» — база процента, а не условие «цена договора».
  ['contract_price', /(?<!(?:^|[^\p{L}])от\s+)(?:цен\p{L}*|стоимост\p{L}*)|сумм\p{L}*\s+договор/iu],
  ['vat_rate', /ндс|налог\p{L}*\s+на\s+добавленн/iu],
  ['advance_percent', /аванс/iu],
  ['advance_term', /аванс/iu],
  ['retention_percent', /удержани/iu],
  ['retention_return_term', /удержани|возвра/iu],
  ['warranty_period', /гарант/iu],
  ['work_start_date', /начал/iu],
  ['work_end_date', /оконча|заверш|срок\p{L}*\s+(?:выполнени|окончани)/iu],
  ['penalty_rate', /неустойк|пени|штраф/iu],
  ['estimate_total', /смет|итог/iu],
];

export const mentionedFactTypes = (text: string): Set<FactType> => new Set(FACT_TYPE_MENTIONS.filter(([, pattern]) => pattern.test(text)).map(([type]) => type));
