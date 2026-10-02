// Общие помощники программных проверок этапа 09: исход по счётчикам, основания сторон, черновик замечания.
import type { IBasisFragment, ICoverageObject, IEvidenceDraft, IFindingDraft, IReviewRequirement } from './input.ts';
import { FINDING_KIND_META, type CheckOutcome, type RuleCheckCode } from './types.ts';

export const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export const outcomeOf = (findings: number, gaps: number, checked: number): CheckOutcome =>
  gaps > 0 ? 'incomplete' : findings > 0 ? 'failed' : checked > 0 ? 'passed' : 'not_applicable';

export const list = (items: readonly string[], max = 3): string => (items.length <= max ? items.join('; ') : `${items.slice(0, max).join('; ')} и ещё ${items.length - max}`);

export const basisEvidence = (side: IEvidenceDraft['side'], basis: readonly IBasisFragment[]): IEvidenceDraft[] =>
  basis.map((b) => ({ side, objectType: 'fragment', fragmentId: b.fragmentId }));

export const requirementContext = (r: IReviewRequirement): IEvidenceDraft => ({ side: 'context', objectType: 'requirement_revision', requirementRevisionId: r.revisionId });

export const calcEvidence = (side: IEvidenceDraft['side'], o: ICoverageObject): IEvidenceDraft => ({
  side,
  objectType: 'calculation_object',
  calculationRevisionId: o.calculationRevisionId!,
  externalPositionId: o.externalPositionId!,
  externalItemId: o.externalItemId,
});

export const confirmedCoverage = (r: IReviewRequirement): boolean => r.coverage !== null && ['covered', 'partial'].includes(r.coverage.state);

export const calcObjects = (r: IReviewRequirement): ICoverageObject[] =>
  (r.coverage?.objects ?? []).filter((o) => o.type === 'calculation_revision' && o.calculationRevisionId && o.externalPositionId);

export const draft = (d: Omit<IFindingDraft, 'check'> & { check?: RuleCheckCode }): IFindingDraft => ({ ...d, check: d.check ?? (FINDING_KIND_META[d.kind].check as RuleCheckCode) });
