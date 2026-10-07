// Запись выпуска и журнал кандидата (этап 13; D-033 В-13-7; проект §8–§9). Манифест выпуска `kontur-release/1` —
// точные файлы кандидата с SHA-256, согласование, принятые риски (на кандидата и в этапе 09), решения по удержаниям,
// кто и когда выпустил. Журнал — хронология из неизменяемых записей: кто, когда, что и на каком основании.
import { Readable } from 'node:stream';
import { RELEASE_MANIFEST_SCHEMA, releaseManifestBytes, type IGateResult, type IManifest, type IReleaseManifest } from '@kontur/core';
import {
  candidateFiles,
  candidateReturn,
  eventTitle,
  insertBlob,
  listAcceptances,
  listApprovals,
  listHolds,
  releaseOfCandidate,
  type IApprovalRow,
  type ICandidateGateDbFacts,
  type IReleaseCandidateRow,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { readStoredBlob } from './releaseMarkup.ts';

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface IReleaseDraft {
  id: string;
  candidate: IReleaseCandidateRow;
  approval: IApprovalRow;
  gate: IGateResult;
  reviewRisks: ICandidateGateDbFacts['reviewRisks'];
  inputVersion: number;
  releasedBy: { id: string; name: string };
  releasedAt: Date;
}

export const buildReleaseManifest = async (db: Queryable, store: BlobStore, d: IReleaseDraft): Promise<IReleaseManifest> => {
  const c = d.candidate;
  const candidateManifest = JSON.parse((await readStoredBlob(store, c.manifest_blob_sha256!)).toString('utf8')) as IManifest;
  const titles = new Map<string, string>();
  for (const b of d.gate.blockers) for (const i of b.items) if (i.acceptance) titles.set(i.acceptance.id, i.title);
  const accepted = new Set(d.approval.accepted_risk_ids);
  const acceptances = (await listAcceptances(db, c.id)).filter((a) => accepted.has(a.id));
  const holds = (await listHolds(db, c.stage_id, { candidateId: c.id })).filter((h) => h.status !== 'open');
  const files = await candidateFiles(db, c.id);
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    release: {
      id: d.id,
      mode: c.mode,
      tenderId: c.tender_id,
      stageId: c.stage_id,
      inputVersion: d.inputVersion,
      releasedBy: d.releasedBy,
      releasedAt: d.releasedAt.toISOString(),
    },
    candidate: { id: c.id, seq: c.seq, contentHash: c.manifest_sha256!, marks: candidateManifest.candidate.marks },
    approval: {
      id: d.approval.id,
      approvedBy: { id: d.approval.approved_by, name: d.approval.approved_by_name },
      approvedAt: d.approval.approved_at.toISOString(),
      comment: d.approval.comment,
      inputVersion: d.approval.input_version,
      contentHash: d.approval.candidate_content_hash,
    },
    acceptedRisks: acceptances.map((a) => ({
      id: a.id,
      code: a.blocker_code,
      subjectType: a.subject_type,
      subjectId: a.subject_id,
      subjectKey: a.subject_key,
      subjectVersion: a.subject_version,
      title: titles.get(a.id) ?? `${a.subject_type} ${a.subject_id}`,
      reason: a.reason,
      acceptedBy: { id: a.accepted_by, name: a.accepted_by_name },
      acceptedAt: a.accepted_at.toISOString(),
    })),
    reviewRisks: d.reviewRisks.map((r) => ({
      findingId: r.findingId,
      kind: r.kind,
      severity: r.severity,
      title: r.title,
      reason: r.reason,
      acceptedBy: r.acceptedById ? { id: r.acceptedById, name: r.acceptedBy ?? '' } : null,
      acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
    })),
    holds: holds.map((h) => ({
      eventSeq: h.event_seq,
      eventType: h.event_type,
      decision: h.status === 'resolved_not_applicable' ? 'не влияет' : 'влияет',
      reason: h.reason ?? '',
      decidedBy: { id: h.resolved_by!, name: h.resolved_by_name ?? '' },
      decidedAt: h.resolved_at!.toISOString(),
    })),
    files: files
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((f) => ({ path: f.path, role: f.role, audience: f.audience, mediaType: f.media_type, sha256: f.blob_sha256, size: f.size_bytes })),
  };
};

// Манифест выпуска — неизменяемый файл хранилища и строка blob (в транзакции выпуска).
export const storeReleaseManifest = async (db: Queryable, store: BlobStore, m: IReleaseManifest): Promise<{ blobSha256: string; sha256: string }> => {
  const bytes = releaseManifestBytes(m);
  const s = await store.putStream(Readable.from([bytes]), MAX_MANIFEST_BYTES);
  await insertBlob(db, { sha256: s.sha256, sizeBytes: s.sizeBytes, mediaType: 'application/json', storageKey: s.storageKey });
  return { blobSha256: s.sha256, sha256: s.sha256 };
};

export interface IHistoryEntry {
  at: string;
  action: string;
  actor: { id: string; name: string } | null;
  basis: string | null;
  ref: { type: string; id: string } | null;
}

// Журнал кандидата: сборка, принятие рисков, согласования и их завершение, решения по удержаниям, возврат, выпуск,
// замена — по времени. Старое согласование остаётся в журнале со своим исходом (I04, A09).
export const candidateHistory = async (db: Queryable, c: IReleaseCandidateRow): Promise<IHistoryEntry[]> => {
  const out: IHistoryEntry[] = [];
  const at = (d: Date) => d.toISOString();
  out.push({ at: at(c.created_at), action: 'created', actor: { id: c.created_by, name: c.created_by_name }, basis: `режим ${c.mode === 'test' ? 'тестовый' : 'боевой'}`, ref: null });
  if (c.finished_at) {
    out.push({
      at: at(c.finished_at),
      action: c.failure_code ? 'assembly_failed' : 'assembled',
      actor: null,
      basis: c.failure_code ? `${c.failure_code}: ${c.failure_detail ?? ''}` : c.manifest_sha256 ? `SHA-256 манифеста ${c.manifest_sha256}` : null,
      ref: null,
    });
  }
  for (const a of await listAcceptances(db, c.id)) {
    out.push({ at: at(a.accepted_at), action: 'risk_accepted', actor: { id: a.accepted_by, name: a.accepted_by_name }, basis: `${a.blocker_code}: ${a.reason}`, ref: { type: 'risk_acceptance', id: a.id } });
  }
  for (const a of await listApprovals(db, c.id)) {
    out.push({ at: at(a.approved_at), action: 'approved', actor: { id: a.approved_by, name: a.approved_by_name }, basis: a.comment ?? `содержимое ${a.candidate_content_hash}`, ref: { type: 'approval', id: a.id } });
    if (a.status !== 'active' && a.ended_at) {
      out.push({
        at: at(a.ended_at),
        action: a.status === 'revoked' ? 'approval_revoked' : 'approval_superseded',
        actor: a.revoked_by ? { id: a.revoked_by, name: a.revoked_by_name ?? '' } : null,
        basis: a.revoke_reason ?? (a.status === 'superseded' ? 'собран новый комплект того же режима' : null),
        ref: { type: 'approval', id: a.id },
      });
    }
  }
  for (const h of await listHolds(db, c.stage_id, { candidateId: c.id })) {
    if (h.status === 'open' || !h.resolved_at) continue;
    out.push({
      at: at(h.resolved_at),
      action: h.status === 'resolved_not_applicable' ? 'hold_not_applicable' : 'hold_requires_new_candidate',
      actor: h.resolved_by ? { id: h.resolved_by, name: h.resolved_by_name ?? '' } : null,
      basis: `событие № ${h.event_seq} (${eventTitle(h.event_type)}): ${h.reason ?? ''}`,
      ref: { type: 'readiness_hold', id: h.id },
    });
  }
  const ret = await candidateReturn(db, c.id);
  if (ret) out.push({ at: at(ret.returned_at), action: 'returned', actor: { id: ret.returned_by, name: ret.returned_by_name }, basis: ret.reason, ref: ret.hold_id ? { type: 'readiness_hold', id: ret.hold_id } : null });
  const rel = await releaseOfCandidate(db, c.id);
  if (rel) out.push({ at: at(rel.released_at), action: 'released', actor: { id: rel.released_by, name: rel.released_by_name }, basis: `согласование ${rel.approval_id}; манифест выпуска ${rel.release_manifest_sha256}`, ref: { type: 'release', id: rel.id } });
  if (c.status === 'superseded' && c.superseded_by_candidate_id) {
    const by = (await db.query<{ seq: number; finished_at: Date | null }>('SELECT seq, finished_at FROM release_candidate WHERE id = $1', [c.superseded_by_candidate_id])).rows[0];
    if (by?.finished_at) out.push({ at: at(by.finished_at), action: 'superseded', actor: null, basis: `заменён комплектом № ${by.seq}`, ref: { type: 'release_candidate', id: c.superseded_by_candidate_id } });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
};
