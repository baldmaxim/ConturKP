// Ответы API источников (этап 03).
import type { IBatchSummary, IChannelRow, IDocumentRow, IItemRow, IOccurrenceRow, IRevisionRow, IStageEventRow } from '@kontur/db';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toBatch = (b: IBatchSummary) => ({
  id: b.id,
  tenderId: b.tender_id,
  stageId: b.stage_id,
  sourceKind: b.source_kind,
  intakeChannelId: b.intake_channel_id,
  status: b.status,
  uploadName: b.upload_name,
  failureCode: b.failure_code,
  expanded: b.expanded_at !== null,
  createdAt: b.created_at.toISOString(),
  completedAt: iso(b.completed_at),
  counts: {
    total: b.items_total,
    pending: b.items_pending,
    registered: b.items_registered,
    duplicate: b.items_duplicate,
    rejected: b.items_rejected,
    unresolved: b.items_unresolved,
  },
});

export const toItem = (i: IItemRow) => ({
  id: i.id,
  batchId: i.batch_id,
  memberPath: i.member_path,
  observedName: i.observed_name,
  status: i.status,
  rejectReason: i.reject_reason,
  rejectDetail: i.reject_detail,
  sizeBytes: i.size_bytes,
  sha256: i.blob_sha256,
  documentRevisionId: i.document_revision_id,
  resolution: i.resolution,
  resolvedByItemId: i.resolved_by_item_id,
  resolutionDecisionId: i.resolution_decision_id,
  resolvedAt: iso(i.resolved_at),
  rowVersion: i.row_version,
});

export const toDocument = (d: IDocumentRow) => ({
  id: d.id,
  tenderId: d.tender_id,
  title: d.title,
  docType: d.doc_type,
  docCode: d.doc_code,
  scopeNote: d.scope_note,
  revisions: d.revisions,
  latestRevisionId: d.latest_revision_id,
  latestReceivedAt: iso(d.latest_received_at),
  rowVersion: d.row_version,
  updatedAt: d.updated_at.toISOString(),
});

export const toOccurrence = (o: IOccurrenceRow) => ({
  id: o.id,
  sourceKind: o.source_kind,
  sourceLocator: o.source_locator,
  observedName: o.observed_name,
  observedAt: o.observed_at.toISOString(),
  importItemId: o.import_item_id,
  intakeChannelId: o.intake_channel_id,
});

export const toRevision = (r: IRevisionRow, occurrences: IOccurrenceRow[]) => ({
  id: r.id,
  documentId: r.document_id,
  revisionSeq: r.revision_seq,
  sha256: r.blob_sha256,
  sizeBytes: r.size_bytes,
  mediaType: r.media_type,
  supersedesRevisionId: r.supersedes_revision_id,
  receivedAt: r.received_at.toISOString(),
  occurrences: occurrences.filter((o) => o.document_revision_id === r.id).map(toOccurrence),
});

export const toChannel = (c: IChannelRow, now: Date) => ({
  id: c.id,
  tenderId: c.tender_id,
  kind: c.kind,
  origin: c.origin,
  locator: c.locator,
  active: c.active,
  freshnessSeconds: c.freshness_seconds,
  scanIntervalSeconds: c.scan_interval_seconds,
  lastScanStartedAt: iso(c.last_scan_started_at),
  lastSuccessfulScanAt: iso(c.last_successful_scan_at),
  lastErrorCode: c.last_error_code,
  lastErrorAt: iso(c.last_error_at),
  pendingUnstable: c.pending_unstable,
  // Свежесть канала (state-machines §1.1): последний успешный скан в пределах окна.
  current: c.active && c.last_successful_scan_at !== null && now.getTime() - c.last_successful_scan_at.getTime() <= c.freshness_seconds * 1000,
  disabledReason: c.disabled_reason,
  rowVersion: c.row_version,
});

export const toStageEvent = (e: IStageEventRow) => ({
  id: e.id,
  seq: e.seq,
  eventClass: e.event_class,
  eventType: e.event_type,
  refType: e.ref_type,
  refId: e.ref_id,
  actorKind: e.actor_kind,
  createdAt: e.created_at.toISOString(),
});
