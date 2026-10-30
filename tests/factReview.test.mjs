import { describe, expect, it } from 'vitest';
import { factTypeSections, citationTextGroups } from '../apps/web/src/utils/factReview.ts';
const fact = (id = 'fact', changes = {}) => ({ id, documentId: 'doc', revisionId: 'rev', type: 'vat_rate', title: 'Ставка НДС', normalized: { percent: 20 }, display: '20 %', fragmentIds: [], retired: false, ...changes });
const evidence = (id, page, text = 'НДС 20%', changes = {}) => ({ id, documentId: 'doc', documentRevisionId: 'rev', pageIndex: page - 1, ordinal: 0, text, ...changes });
const group = (f) => ({ id: f.id, facts: [f], sourceCount: 1 });

describe('fact review order and repeated citation texts', () => {
  it('sorts types and values deterministically rather than by API arrival order', () => {
    const groups = [group(fact('penalty', { type: 'penalty_rate', title: 'Неустойка' })), group(fact('20')), group(fact('18', { display: '18 %', normalized: { percent: 18 } })), group(fact('party', { type: 'party_contractor', title: 'Подрядчик' }))];
    const result = factTypeSections(groups);
    expect(result.map(s => s.type)).toEqual(['party_contractor', 'vat_rate', 'penalty_rate']);
    expect(result[1].groups.map(g => g.id)).toEqual(['18', '20']);
    expect(factTypeSections([...groups].reverse())).toEqual(result);
  });
  it('shows 26 identical texts once while retaining and sorting every page reference', () => {
    const items = Array.from({ length: 26 }, (_, n) => evidence('q' + n, 100 + n));
    const input = fact('fact', { fragmentIds: items.map(e => e.id).reverse() });
    const result = citationTextGroups([input], new Map(items.map(e => [e.id, e])), []);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('НДС 20%');
    expect(result[0].evidence.map(e => e.id)).toEqual(items.map(e => e.id));
    expect(input.fragmentIds[0]).toBe('q25');
  });
  it('keeps different texts, documents and revisions apart', () => {
    const a = fact('a', { fragmentIds: ['a', 'b'] }), b = fact('b', { documentId: 'ds', revisionId: 'rev2', fragmentIds: ['c'] });
    const items = [evidence('a', 1), evidence('b', 2, 'НДС 22%'), evidence('c', 3, 'НДС 20%', { documentId: 'ds', documentRevisionId: 'rev2' })];
    expect(citationTextGroups([a, b], new Map(items.map(e => [e.id, e])), [])).toHaveLength(3);
  });
  it('does not invent missing citations or show a fragment from another revision', () => {
    const f = fact('a', { fragmentIds: ['missing', 'wrong-revision', 'wrong-doc'] });
    const items = [evidence('wrong-revision', 1, 'НДС 20%', { documentRevisionId: 'other' }), evidence('wrong-doc', 2, 'НДС 20%', { documentId: 'other' })];
    expect(citationTextGroups([f], new Map(items.map(e => [e.id, e])), [])).toEqual([]);
  });
  it('deduplicates shared fragments without losing their contributing facts', () => {
    const facts = [fact('a', { fragmentIds: ['q'] }), fact('b', { fragmentIds: ['q'] })];
    const result = citationTextGroups(facts, new Map([['q', evidence('q', 1)]]), []);
    expect(result[0].evidence).toHaveLength(1);
    expect(result[0].facts.map(f => f.id)).toEqual(['a', 'b']);
  });
  it('sorts source documents chronologically, including references without page numbers', () => {
    const a = fact('a', { fragmentIds: ['a'] }), b = fact('b', { documentId: 'ds', revisionId: 'rev2', fragmentIds: ['b'] });
    const items = [evidence('a', 1), evidence('b', 1, 'НДС 20%', { documentId: 'ds', documentRevisionId: 'rev2', pageIndex: null, ordinal: null })];
    const docs = [{ documentId: 'doc', title: 'Договор', documentDate: '2025-02-07' }, { documentId: 'ds', title: 'ДС', documentDate: '2025-03-01' }];
    expect(citationTextGroups([b, a], new Map(items.map(e => [e.id, e])), docs).map(g => g.documentId)).toEqual(['doc', 'ds']);
  });
});
