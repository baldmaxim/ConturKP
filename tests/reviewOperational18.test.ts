import { describe, expect, it } from 'vitest';
import { computeFactGraph, extractDocumentFacts, type IFactSpan, type IGraphDocument, type IReviewInput, type IReviewPosition } from '../packages/core/src/index.ts';
import { checkQuantities } from '../packages/core/src/review/checksCalc.ts';

const position = (id: string, o: Partial<IReviewPosition> = {}): IReviewPosition => ({ externalPositionId: id, name: 'Монтаж насоса', unit: 'шт', section: null, volume: 1, total: 10, isSection: false, ...o });
const quantities = (positions: IReviewPosition[]) => checkQuantities({ positions, requirements: [], calculationRevisionId: 'c1' } as unknown as IReviewInput);
const span = (fragmentId: string, text: string, tableRow = false, tableScope = ''): IFactSpan => ({ fragmentId, text, tableRow, tableScope });
const document = (documentId: string, kind: IGraphDocument['kind'] = 'other', main: string | null = null): IGraphDocument => ({ documentId, kind, ownerKey: 'tender:t', number: '', documentDate: null, parentRef: null, explicit: main ? { role: 'appendix', mainDocumentId: main } : null });
const graphOf = (parts: { id: string; spans: IFactSpan[]; kind?: IGraphDocument['kind']; main?: string }[]) => {
  const facts = parts.flatMap(p => extractDocumentFacts(p.spans).map((f, i) => ({ ...f, factId: `${p.id}-${i}`, documentId: p.id })));
  const graph = computeFactGraph({ documents: parts.map(p => document(p.id, p.kind, p.main)), facts });
  return { facts, graph, conflicts: graph.remarks.filter(r => r.kind === 'value_conflict') };
};

describe('S18-07: область повторов расчёта', () => {
  it('два одноимённых заголовка разных ветвей — разные разделы; настоящий дубль в ветви остаётся', () => {
    const positions = [position('h1', { name: 'Оборудование', isSection: true, hierarchyLevel: 2 }), position('p1', { hierarchyLevel: 3 }), position('h2', { name: 'Оборудование', isSection: true, hierarchyLevel: 2 }), position('p2', { hierarchyLevel: 3 })];
    expect(quantities(positions).findings).toEqual([]);
    const actual = quantities([...positions, position('p3', { hierarchyLevel: 3 })]);
    expect(actual.findings).toHaveLength(1);
    expect(actual.findings[0]!.evidence.map(e => e.externalPositionId)).toEqual(['p2', 'p3']);
  });
  it('явные родители различают одинаковые номера разделов', () => {
    expect(quantities([position('p1', { section: '1', parentExternalPositionId: 'a' }), position('p2', { section: '1', parentExternalPositionId: 'b' })]).findings).toEqual([]);
    expect(quantities([position('p1', { parentExternalPositionId: 'a' }), position('p2', { parentExternalPositionId: 'a' })]).findings[0]!.confidence).toBe('high');
  });
  it('при неизвестном разделе — низкая уверенность, без утверждения об одном разделе', () => {
    const f = quantities([position('p1'), position('p2')]).findings[0]!;
    expect(f.confidence).toBe('low');
    expect(f.title).toContain('раздел не установлен');
  });
});

describe('S18-11: денежный итог и область сметы', () => {
  it('итог электрических нагрузок не является итогом сметы', () => {
    expect(extractDocumentFacts([span('f1', 'Итого на РП5 пожар | 0,897 | 0,49 | 8,3 | 4,1 | 9,3 | 14,1', true)])).toEqual([]);
  });
  it('слово «сшитого» в денежной таблице не является строкой «Итого»', () => {
    expect(extractDocumentFacts([span('h', 'Работа | Количество | Стоимость, руб.', true, 'Смета'), span('v', 'Разводка труб из сшитого полиэтилена | 10 | 1200', true, 'Смета')])).toEqual([]);
  });
  it('берёт денежную колонку, сохраняя пустые ячейки; таблица другого листа не наследует рубли', () => {
    const facts = extractDocumentFacts([span('h', 'Работа | Количество | Стоимость, руб. | Трудозатраты', true, 'Смета'), span('v', 'Итого | | 1200 | 42', true, 'Смета'), span('e', 'Итого на РП | 25 | 38', true, 'Нагрузки')]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.normalized).toMatchObject({ amount: 1200, currency: 'RUB' });
  });
  it('разные сметы не конфликтуют глобально; два итога одной сметы — конфликт', () => {
    const a = span('a', 'Итого по смете | 100', true), b = span('b', 'Итого по смете | 200', true);
    expect(graphOf([{ id: 'a', spans: [a] }, { id: 'b', spans: [b] }]).conflicts).toEqual([]);
    expect(graphOf([{ id: 'a', spans: [a, b] }]).conflicts).toHaveLength(1);
    expect(graphOf([{ id: 'book', spans: [{ ...a, tableScope: 'Смета 1' }, { ...b, tableScope: 'Смета 2' }] }]).conflicts).toEqual([]);
  });
  it('итог явно связанной сметы сравнивается с ценой её договора, а разделы не приравниваются к целому', () => {
    const base = { id: 'contract', kind: 'contract' as const, spans: [span('c', 'Цена договора составляет 100 рублей.')] };
    const estimate = { id: 'estimate', main: 'contract', spans: [span('total', 'Итого по смете | 200', true)] };
    expect(graphOf([base, estimate]).conflicts).toHaveLength(1);
    expect(graphOf([base, { ...estimate, spans: [span('same', 'Итого по смете | 100', true)] }]).conflicts).toEqual([]);
    expect(graphOf([base, { ...estimate, spans: [span('part', 'Итого по разделу, руб. | 20', true)] }]).conflicts).toEqual([]);
  });
});

describe('S18-12: событие и база неустойки', () => {
  const penalty = (id: string, event: string, rate: string, base: string) => span(id, `За ${event} начисляется неустойка в размере ${rate}% от ${base} за каждый день просрочки.`);
  it('разные события и базы сосуществуют; разные ставки того же события остаются конфликтом', () => {
    const completion = penalty('a', 'нарушение срока окончания работ', '0,1', 'цены работ');
    const milestone = penalty('b', 'нарушение срока ключевого события', '0,05', 'цены работ ключевого события');
    const otherBase = penalty('c', 'нарушение срока окончания работ', '0,2', 'невыплаченной суммы');
    expect(graphOf([{ id: 'c', spans: [completion, milestone, otherBase] }]).conflicts).toEqual([]);
    expect(graphOf([{ id: 'c', spans: [completion, penalty('d', 'нарушение срока окончания работ', '0,2', 'цены работ')] }]).conflicts).toHaveLength(1);
  });
  it('равные ставки разных событий сохраняют отдельные факты и основания', () => {
    const facts = extractDocumentFacts([penalty('a', 'просрочку оплаты', '0,1', 'невыплаченной суммы'), penalty('b', 'просрочку сдачи', '0,1', 'цены работ')]);
    expect(facts).toHaveLength(2);
    expect(facts.map(f => f.fragmentIds)).toEqual([['a'], ['b']]);
  });
});

describe('S18-13: типографика организаций', () => {
  it('тире, кавычки и регистр не создают конфликт; исходное написание сохранено', () => {
    const texts = ['Заказчик: ООО «ГК «СЕВЕР–ПРОЕКТ»»', 'Заказчик: ООО «ГК Север-Проект»'];
    const { facts, conflicts } = graphOf([{ id: 'a', spans: texts.map((t, i) => span(String(i), t)) }]);
    expect(facts).toHaveLength(1);
    expect(conflicts).toEqual([]);
    expect(facts[0]!.rawValue).toContain('«ГК «СЕВЕР–ПРОЕКТ»');
    expect(facts[0]!.fragmentIds).toHaveLength(2);
  });
  it('цифра 3 и буква З, а также разные организации остаются разными значениями', () => {
    for (const [a, b] of [['К3-Девелопмент', 'КЗ-Девелопмент'], ['Север', 'Юг']]) {
      expect(graphOf([{ id: 'a', spans: [span('a', `Заказчик: ООО «${a}»`), span('b', `Заказчик: ООО «${b}»`)] }]).conflicts).toHaveLength(1);
    }
  });
});
