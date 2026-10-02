// Граф фактов D-018 (этап 08a, D-028; portal-api §2.12).
export type TFactStatus = 'active' | 'superseded' | 'conflict';
export type TSupersededReason = 'amendment' | 'human' | 'document_revision';
export type TFactDecisionKind = 'prevails' | 'distinct' | 'rule';
export type TRemarkKind = 'parent_not_found' | 'parent_ambiguous' | 'undated_amendment' | 'amendment_target_ambiguous' | 'value_conflict';

export interface IGraphFactState {
  status: TFactStatus;
  supersededReason: TSupersededReason | null;
  supersededByFactId: string | null;
  validFrom: string | null;
  validTo: string | null;
  decidedBy: 'rule' | 'human';
  decisionId: string | null;
}

export interface IGraphFact {
  id: string;
  type: string;
  title: string;
  fate: 'contract_card' | 'economics' | 'requirement_candidate' | null;
  display: string;
  rawValue: string;
  unit: string;
  condition: string;
  clauseRef: string | null;
  amends: boolean;
  documentId: string;
  revisionId: string;
  fragmentIds: string[];
  retired: boolean;
  state: IGraphFactState | null;
}

export interface IGraphDocument {
  documentId: string;
  revisionId: string;
  title: string;
  kind: string;
  number: string | null;
  documentDate: string | null;
  role: 'contract' | 'addendum' | 'appendix' | null;
  relation: { fromDocumentId: string; toDocumentId: string | null; relation: 'amends' | 'appendix_of' | 'unknown'; source: '06a' | 'text'; reason: string } | null;
}

export interface IGraphRemark {
  id: string;
  kind: TRemarkKind;
  message: string;
  factIds: string[];
  documentIds: string[];
  status: 'open' | 'resolved';
  openedAt: string | null;
  resolvedAt: string | null;
}

export interface IFactGraphView {
  owner: { kind: 'tender' | 'contract'; id: string };
  computedAt: string | null;
  graphHash: string | null;
  coverage: { documents?: number; facts?: number; documentsWithoutCurrentFacts?: number };
  canDecide: boolean;
  documents: IGraphDocument[];
  facts: IGraphFact[];
  parties: { factId: string; type: string; title: string; name: string; status: TFactStatus | null }[];
  remarks: IGraphRemark[];
  decisions: { id: string; factId: string; otherFactId: string; kind: TFactDecisionKind; reason: string; decidedBy: string; createdAt: string | null }[];
}
