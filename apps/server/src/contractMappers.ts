// Представление договорного контура для API (D-017, D-022, D-023). Без contract.read — только
// минимальные административные метаданные (OD-2): номер, название, статус, даты и автор карточки.
import type { ContractCapability } from '@kontur/core';
import type { IContractDocumentRow, IContractGrantRow, IContractLinkRow, IContractRow, IRevisionRow } from '@kontur/db';

export const toContract = (c: IContractRow, caps: readonly ContractCapability[]) => {
  const canRead = caps.includes('contract.read');
  return {
    id: c.id,
    number: c.number,
    title: c.title,
    status: c.status,
    createdBy: { id: c.created_by, displayName: c.created_by_name },
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
    archivedAt: c.archived_at?.toISOString() ?? null,
    rowVersion: c.row_version,
    capabilities: [...caps],
    // Содержательные поля карточки — только с contract.read.
    restricted: !canRead,
    counterparty: canRead ? c.counterparty : null,
    signedOn: canRead ? c.signed_on : null,
  };
};

export const toGrant = (g: IContractGrantRow) => ({
  id: g.id,
  userId: g.user_id,
  login: g.login,
  displayName: g.display_name,
  userRoles: g.user_roles,
  capability: g.capability,
  source: g.source,
  grantedBy: { id: g.granted_by, displayName: g.granted_by_name },
  grantedAt: g.granted_at.toISOString(),
});

export const toLink = (l: IContractLinkRow, contractCaps: readonly ContractCapability[]) => ({
  id: l.id,
  contractId: l.contract_id,
  contract: { number: l.contract_number, title: l.contract_title, status: l.contract_status, capabilities: [...contractCaps] },
  tenderId: l.tender_id,
  tender: { code: l.tender_code, title: l.tender_title },
  stageId: l.stage_id,
  stageTitle: l.stage_title,
  note: l.note,
  status: l.status,
  confirmedBy: { id: l.confirmed_by, displayName: l.confirmed_by_name },
  confirmedAt: l.confirmed_at.toISOString(),
  archivedAt: l.archived_at?.toISOString() ?? null,
  archiveReason: l.archive_reason,
  rowVersion: l.row_version,
  updatedAt: l.updated_at.toISOString(),
});

export const toContractDocument = (d: IContractDocumentRow) => ({
  id: d.id,
  contractId: d.contract_id,
  title: d.title,
  role: d.contract_role,
  mainDocumentId: d.main_document_id,
  revisions: d.revisions,
  latestRevision: {
    id: d.latest_revision_id,
    seq: d.latest_revision_seq,
    receivedAt: d.latest_received_at.toISOString(),
    mediaType: d.latest_media_type,
    sizeBytes: Number(d.latest_size_bytes),
    runStatus: d.latest_run_status,
  },
  rowVersion: d.row_version,
  createdAt: d.created_at.toISOString(),
  updatedAt: d.updated_at.toISOString(),
});

export const toContractRevision = (r: IRevisionRow) => ({
  id: r.id,
  documentId: r.document_id,
  seq: r.revision_seq,
  supersedesRevisionId: r.supersedes_revision_id,
  receivedAt: r.received_at.toISOString(),
  sizeBytes: Number(r.size_bytes),
  mediaType: r.media_type,
  sha256: r.blob_sha256,
});
