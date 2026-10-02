// Проекция графа фактов D-018 (D-028; portal-api §2.12): документы владельца с видом, номером, датой и связью, факты с
// производным состоянием и основаниями, замечания для человека, решения. Стороны договора — судьба `contract_card`:
// показываются, поля карточки договора не меняются. Текст значения — из документа владельца, поэтому выдаётся тому,
// кто читает владельца (договор — contract.read, тендер — fact.read).
import { factDisplay, FACT_TYPE_META, type FactType } from '@kontur/core';
import type { IOwnerGraphView } from '@kontur/db';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const factGraphView = (owner: { kind: 'tender' | 'contract'; id: string }, v: IOwnerGraphView, canDecide: boolean) => {
  const relations = (v.graph?.relations ?? []) as { fromDocumentId: string; toDocumentId: string | null; relation: string; source: string; reason: string }[];
  const relationOf = new Map(relations.map((r) => [r.fromDocumentId, r]));
  const facts = v.facts.map((f) => ({
    id: f.id,
    type: f.fact_type,
    title: FACT_TYPE_META[f.fact_type as FactType]?.title ?? f.fact_type,
    fate: FACT_TYPE_META[f.fact_type as FactType]?.fate ?? null,
    display: factDisplay(f.normalized),
    normalized: f.normalized,
    rawValue: f.raw_value,
    unit: f.unit,
    condition: f.condition,
    clauseRef: f.clause_ref || null,
    amends: f.amends,
    documentId: f.document_id,
    revisionId: f.document_revision_id,
    fragmentIds: f.fragment_ids,
    retired: f.retired,
    state: f.status
      ? {
          status: f.status,
          supersededReason: f.superseded_reason,
          supersededByFactId: f.superseded_by_fact_id,
          validFrom: f.valid_from,
          validTo: f.valid_to,
          decidedBy: f.decided_by,
          decisionId: f.decision_id,
        }
      : null,
  }));
  return {
    owner,
    computedAt: v.graph ? iso(v.graph.computedAt) : null,
    graphHash: v.graph?.hash ?? null,
    coverage: v.graph?.coverage ?? {},
    canDecide,
    documents: v.documents.map((d) => ({
      documentId: d.document_id,
      revisionId: d.document_revision_id,
      title: d.document_title,
      kind: d.document_kind,
      number: d.document_number || null,
      documentDate: d.document_date,
      role: d.contract_role,
      relation: relationOf.get(d.document_id) ?? null,
    })),
    facts,
    parties: facts.filter((f) => f.fate === 'contract_card' && !f.retired).map((f) => ({ factId: f.id, type: f.type, title: f.title, name: f.display, status: f.state?.status ?? null })),
    remarks: v.remarks.map((r) => ({ id: r.id, kind: r.kind, message: r.message, factIds: r.fact_ids, documentIds: r.document_ids, status: r.status, openedAt: iso(r.opened_at), resolvedAt: iso(r.resolved_at) })),
    decisions: v.decisions.map((d) => ({ id: d.id, factId: d.fact_id, otherFactId: d.other_fact_id, kind: d.kind, reason: d.reason, decidedBy: d.decided_by, createdAt: iso(d.created_at) })),
  };
};
