import { describe, expect, it } from 'vitest';
import { groupFactValues, factSourceLabel } from '../apps/web/src/utils/factGroups.ts';

const fact = (id, changes = {}) => ({ id, type: 'vat_rate', display: '20 %', normalized: { percent: 20 }, unit: '%', condition: '', retired: false, documentId: id, fragmentIds: ['quote-' + id], state: { status: 'active', decidedBy: 'rule' }, ...changes });

describe('fact values with preserved source occurrences', () => {
  it('combines repeated VAT across documents and keeps every citation without modifying facts', () => {
    const input = [fact('contract'), fact('ds-1'), fact('ds-2')];
    const before = JSON.stringify(input), groups = groupFactValues(input);
    expect(groups).toHaveLength(1);
    expect(groups[0].facts).toEqual(input);
    expect(groups[0].sourceCount).toBe(3);
    expect(factSourceLabel(groups[0])).toBe('3 источника');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('does not merge different rates, types, penalty limits, conditions or scopes', () => {
    const input = [fact('a'), fact('b', { normalized: { percent: 18 }, display: '18 %' }), fact('c', { type: 'penalty_rate' }), fact('d', { normalized: { percent: 20, capPercent: 10 } }), fact('e', { condition: 'за просрочку оплаты' }), fact('f', { normalized: { percent: 20, comparisonScope: 'отдельная работа' } })];
    expect(groupFactValues(input)).toHaveLength(input.length);
  });
  it('does not equate distinct exact amounts just because their rounded display is identical', () => {
    const a = fact('a', { type: 'estimate_total', display: '100,00 ₽', normalized: { amount: '100.001', currency: 'RUB' } });
    expect(groupFactValues([a, { ...a, id: 'b', normalized: { amount: '100.002', currency: 'RUB' } }, { ...a, id: 'c', normalized: { amount: '100.001', currency: '' } }])).toHaveLength(3);
  });
  it('preserves conflicting, superseded and human source states while keeping historical revisions apart', () => {
    const input = [fact('a'), fact('b', { state: { status: 'conflict', decidedBy: 'rule' } }), fact('c', { state: { status: 'superseded', decidedBy: 'human', decisionId: 'decision' } }), fact('old', { retired: true })];
    const groups = groupFactValues(input);
    expect(groups).toHaveLength(2);
    expect(groups[0].facts.map(f => f.state)).toEqual(input.slice(0, 3).map(f => f.state));
    expect(groups[1].facts[0].retired).toBe(true);
  });
  it('ignores normalized property order and counts repeated passages in one document honestly', () => {
    const groups = groupFactValues([fact('a', { normalized: { percent: 20, other: 1 } }), fact('b', { documentId: 'a', normalized: { other: 1, percent: 20 } })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sourceCount).toBe(1);
    expect(factSourceLabel(groups[0])).toBe('2 упоминания');
  });
  it('supports older responses without normalized values and preserves nonrepresentative deep-link IDs', () => {
    const groups = groupFactValues([fact('a', { normalized: undefined }), fact('b', { normalized: undefined })]);
    expect(groups).toHaveLength(1);
    expect(groups.find(g => g.facts.some(f => f.id === 'b')).id).toBe('a');
    expect(groupFactValues([])).toEqual([]);
  });
});
