import { extractDocumentFacts, normalizedKey } from './extractor.ts';
import type { IFactSpan, IExtractedFact } from './types.ts';

export const CONTRACT_FACT_INPUT_PROFILE = 'contract-context/1';
export const CONTRACT_OCR_REPAIR_INPUT_PROFILE = 'contract-context/2';

// This optional input profile is part of the recognition fingerprint. Base rules
// retain their version; exclusions are recorded in extraction coverage, not decisions.
export const extractProfiledDocumentFacts = (spans: readonly IFactSpan[], profile: string | null = null) => {
  if (profile !== null && profile !== CONTRACT_FACT_INPUT_PROFILE && profile !== CONTRACT_OCR_REPAIR_INPUT_PROFILE) throw new Error('Unknown fact input profile');
  const original = extractDocumentFacts(spans);
  const excluded: { factType: string; normalizedKey: string; fragmentId: string; reason: string }[] = [];
  if (profile === null) return { facts: original, excluded };
  const byId = new Map(spans.map((s) => [s.fragmentId, s]));
  const facts: IExtractedFact[] = [];
  for (const fact of original) {
    if (profile === CONTRACT_OCR_REPAIR_INPUT_PROFILE && (fact.factType === 'party_customer' || fact.factType === 'party_contractor')) {
      const eligible = fact.fragmentIds.filter((id) => {
        const role = '(?:Генеральный\\s+подрядчик|Заказчик|Застройщик|Генподрядчик|Подрядчик)';
        const ambiguous = new RegExp(`${role}\\s*:?\\s+${role}\\s*:`, 'iu').test(byId.get(id)!.text);
        if (ambiguous) excluded.push({ factType: fact.factType, normalizedKey: fact.normalizedKey, fragmentId: id, reason: 'multi_column_party_layout' });
        return !ambiguous;
      });
      if (eligible.length) {
        const first = extractDocumentFacts([byId.get(eligible[0]!)!]).find((f) => f.factType === fact.factType && f.normalizedKey === fact.normalizedKey)!;
        facts.push({ ...first, fragmentIds: eligible });
      }
      continue;
    }
    if (fact.factType !== 'retention_percent') { facts.push(fact); continue; }
    const eligible: { id: string; candidate: IExtractedFact }[] = [];
    for (const id of fact.fragmentIds) {
      const span = byId.get(id)!;
      const candidate = extractDocumentFacts([span]).find((f) => f.factType === fact.factType && f.normalizedKey === fact.normalizedKey)!;
      const at = span.text.indexOf(candidate.rawValue);
      const before = span.text.slice(Math.max(0, at - 180), at);
      const after = span.text.slice(at + candidate.rawValue.length, at + candidate.rawValue.length + 250);
      const substitution = at >= 0
        && /(?:вправе|может|имеет\s+право)\s+заменить\s*$/iu.test(before)
        && /^\s+от\s+\S+\s+суммы\s+(?:независимой|банковской)\s+гарантией/iu.test(after);
      if (substitution) excluded.push({ factType: fact.factType, normalizedKey: fact.normalizedKey, fragmentId: id, reason: 'guarantee_substitution_share' });
      else eligible.push({ id, candidate });
    }
    if (eligible.length) facts.push({ ...eligible[0]!.candidate, fragmentIds: eligible.map((e) => e.id) });
  }
  if (profile === CONTRACT_OCR_REPAIR_INPUT_PROFILE) {
    // A printed PDF total is kept as its literal line, never promoted to contract
    // price. Unknown comparison scope keeps separate sheets from being equated.
    const money = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:[.,]\\d{2})|\\d+(?:[.,]\\d{2}))';
    const total = new RegExp(`^ИТОГО(?:[ \\t]+по[ \\t]+смете)?[ \\t,:]*руб\\.?[ \\t,:]+((?:с[ \\t]+НДС[ \\t]+\\d{1,2}(?:[.,]\\d+)?[ \\t]*%|без[ \\t]+НДС))[ \\t,:]+${money}[ \\t]*$`, 'iu');
    for (const span of spans) {
      if (span.tableRow) continue;
      for (const line of span.text.split(/\r?\n/u)) {
        const match = line.trim().match(total);
        if (!match) continue;
        const normalized = { amount: Number(match[2]!.replace(/[ \u00a0]/gu, '').replace(',', '.')), currency: 'RUB', comparisonScope: `unknown:${span.fragmentId}` };
        const key = normalizedKey(normalized);
        if (facts.some((f) => f.factType === 'estimate_total' && f.normalizedKey === key)) continue;
        facts.push({ factType: 'estimate_total', rawValue: match[0], normalized, normalizedKey: key, unit: 'RUB', condition: match[1]!, clauseRef: '', amends: false, fragmentIds: [span.fragmentId] });
      }
    }
  }
  return { facts, excluded };
};
