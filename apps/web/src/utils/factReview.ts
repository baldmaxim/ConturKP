import type { IGraphDocument, IGraphFact } from '../api/factTypes';
import type { IEvidenceDetail } from '../api/types';
import type { IFactValueGroup } from './factGroups';
import { factValue } from './factPresentation';

const types = ['party_customer', 'party_contractor', 'contract_price', 'estimate_total', 'vat_rate', 'advance_percent', 'advance_term', 'retention_percent', 'retention_return_term', 'warranty_period', 'work_start_date', 'work_end_date', 'penalty_rate'];
const collator = new Intl.Collator('ru', { numeric: true });
export const factTypeSections = (groups: readonly IFactValueGroup[]): { type: string; title: string; groups: IFactValueGroup[] }[] => {
  const sections = new Map<string, IFactValueGroup[]>();
  for (const group of groups) {
    const type = group.facts[0]!.type;
    const section = sections.get(type);
    if (section) section.push(group); else sections.set(type, [group]);
  }
  const rank = (type: string): number => types.includes(type) ? types.indexOf(type) : types.length;
  return [...sections].sort(([a], [b]) => rank(a) - rank(b) || collator.compare(a, b)).map(([type, members]) => ({
    type, title: members[0]!.facts[0]!.title,
    groups: [...members].sort((a, b) => Number(a.facts[0]!.retired) - Number(b.facts[0]!.retired) || collator.compare(factValue(a.facts[0]!), factValue(b.facts[0]!)) || collator.compare(a.id, b.id)),
  }));
};

export interface ICitationTextGroup {
  id: string;
  documentId: string;
  text: string;
  facts: IGraphFact[];
  evidence: IEvidenceDetail[];
}

/** Identical text in the same revision is displayed once; every page reference is retained. */
export const citationTextGroups = (facts: readonly IGraphFact[], evidence: ReadonlyMap<string, IEvidenceDetail>, documents: readonly IGraphDocument[]): ICitationTextGroup[] => {
  const groups = new Map<string, ICitationTextGroup>();
  for (const fact of facts) for (const id of fact.fragmentIds) {
    const source = evidence.get(id);
    if (!source || source.documentId !== fact.documentId || source.documentRevisionId !== fact.revisionId) continue;
    const key = JSON.stringify([fact.documentId, fact.revisionId, source.text.trim()]);
    let group = groups.get(key);
    if (!group) { group = { id, documentId: fact.documentId, text: source.text, facts: [], evidence: [] }; groups.set(key, group); }
    if (!group.facts.some((f) => f.id === fact.id)) group.facts.push(fact);
    if (!group.evidence.some((e) => e.id === id)) group.evidence.push(source);
  }
  const byPage = (a: IEvidenceDetail, b: IEvidenceDetail): number => (a.pageIndex ?? Number.MAX_SAFE_INTEGER) - (b.pageIndex ?? Number.MAX_SAFE_INTEGER) || (a.ordinal ?? 0) - (b.ordinal ?? 0) || collator.compare(a.id, b.id);
  const doc = (id: string): IGraphDocument | undefined => documents.find((d) => d.documentId === id);
  const result = [...groups.values()];
  for (const group of result) group.evidence.sort(byPage);
  return result.sort((a, b) => collator.compare(doc(a.documentId)?.documentDate ?? '9999', doc(b.documentId)?.documentDate ?? '9999') || collator.compare(doc(a.documentId)?.title ?? a.documentId, doc(b.documentId)?.title ?? b.documentId) || byPage(a.evidence[0]!, b.evidence[0]!));
};
