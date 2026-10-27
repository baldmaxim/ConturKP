import type { IGraphFact } from '../api/factTypes';

export interface IFactValueGroup {
  id: string;
  facts: IGraphFact[];
  sourceCount: number;
}

/** A presentation group, never a decision about which source or condition prevails. */
export const groupFactValues = (facts: readonly IGraphFact[]): IFactValueGroup[] => {
  const groups = new Map<string, IGraphFact[]>();
  for (const fact of facts) {
    // Compare full source values, not the rounded monetary labels. Keep different scopes,
    // conditions, units and historical revisions separate even when their labels look alike.
    const normalized = fact.normalized && Object.keys(fact.normalized).length
      ? Object.entries(fact.normalized).sort(([a], [b]) => a.localeCompare(b, 'en'))
      : fact.display.trim().replace(/\s+/gu, ' ');
    const key = JSON.stringify([fact.type, normalized, fact.unit, fact.condition, fact.retired]);
    const group = groups.get(key);
    if (group) group.push(fact);
    else groups.set(key, [fact]);
  }
  return [...groups.values()].map((members) => ({ id: members[0]!.id, facts: members, sourceCount: new Set(members.map((f) => f.documentId)).size }));
};

const countLabel = (n: number, forms: readonly [string, string, string]): string => {
  const lastTwo = n % 100, last = n % 10;
  return `${n} ${forms[lastTwo >= 11 && lastTwo <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2]}`;
};

export const factSourceLabel = (group: IFactValueGroup): string => group.sourceCount === 1 && group.facts.length > 1
  ? countLabel(group.facts.length, ['упоминание', 'упоминания', 'упоминаний'])
  : countLabel(group.sourceCount, ['источник', 'источника', 'источников']);
