// Представления комплекта-кандидата и выпуска (этапы 12–13; D-032 В-12-7, D-033). Состав и файлы — только тому, кто
// видит все закреплённые входы (права текущие, входы закреплённые). Карточка этапа 13 добавляет состояние согласования
// и выпуска, оценку матрицы блокеров для согласования и выпуска (подсказка; разрешение даёт только команда под
// блокировкой этапа), удержания и готовность выпуска к отправке. Чтение кандидата его не пересобирает. Причины решений —
// по закрытости их предметов для читателя (R13-02); манифест выпуска — тому, кто видит предметы всех решений в нём.
import { formatEtag, type IGateResult, type IManifest, type IReleaseManifest } from '@kontur/core';
import {
  candidateChecks,
  candidateEventsAfter,
  candidateEventsAfterCount,
  candidateFieldVersionIds,
  candidateFiles,
  candidateInputs,
  candidateIsCurrent,
  candidateReturn,
  fieldVersionVisibility,
  getCandidate,
  getStandardAttachmentRevision,
  listApprovals,
  listHolds,
  releaseManifestReadableBy,
  releaseOfCandidate,
  releaseSendReadiness,
  type IAccessContext,
  type IApprovalRow,
  type IHoldRow,
  type IReleaseCandidateRow,
  type IReleaseRow,
  type IStandardAttachmentRevisionRow,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { notFound } from './http/errors.ts';
import { candidateComposition, candidateGate } from './releaseGate.ts';
import { readStoredBlob } from './releaseMarkup.ts';
import { decisionVisibility, type IDecisionVisibility } from './releaseVisibility.ts';
import { conflict } from './routes/reviewScope.ts';
import { hasTenderCap } from './routes/scope.ts';

export const candidateTarget = (c: IReleaseCandidateRow) => ({ tenderId: c.tender_id, entityType: 'release_candidate', entityId: c.id });

// Состав и файлы — только при видимости всех закреплённых значений полей (права — текущие, входы — закреплённые).
export const candidateVisible = async (db: Queryable, ctx: IAccessContext, c: IReleaseCandidateRow): Promise<boolean> => {
  const pinned = await candidateFieldVersionIds(db, c.id);
  const visible = await fieldVersionVisibility(db, ctx, pinned);
  return pinned.every(visible);
};

export const loadCandidate = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IReleaseCandidateRow> => {
  const c = await getCandidate(db, id);
  if (!c || !hasTenderCap(ctx, c.tender_id, 'tender.read')) throw notFound({ entityType: 'release_candidate', entityId: id });
  return c;
};

export const requireVisibleCandidate = async (db: Queryable, ctx: IAccessContext, c: IReleaseCandidateRow): Promise<void> => {
  if (!(await candidateVisible(db, ctx, c))) throw conflict('среди входов комплекта есть то, что вы не можете читать', 'restricted_inputs', candidateTarget(c));
};

export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const candidateShell = (c: IReleaseCandidateRow) => ({
  id: c.id,
  stageId: c.stage_id,
  tenderId: c.tender_id,
  seq: c.seq,
  mode: c.mode,
  status: c.status,
  createdAt: iso(c.created_at),
  finishedAt: iso(c.finished_at),
  createdBy: { id: c.created_by, name: c.created_by_name },
  supersededBy: c.superseded_by_candidate_id,
  etag: formatEtag(c.id, c.row_version),
});

export const approvalView = (a: IApprovalRow) => ({
  id: a.id,
  status: a.status,
  contentHash: a.candidate_content_hash,
  inputVersion: a.input_version,
  comment: a.comment,
  approvedBy: { id: a.approved_by, name: a.approved_by_name },
  approvedAt: iso(a.approved_at),
  acceptedRiskIds: a.accepted_risk_ids,
  revokedBy: a.revoked_by ? { id: a.revoked_by, name: a.revoked_by_name } : null,
  revokeReason: a.revoke_reason,
  endedAt: iso(a.ended_at),
  etag: formatEtag(a.id, a.row_version),
});

// Удержание: причина решения — только тому, кто видит предмет события (R13-02); иначе `restricted` без текста.
export const holdView = (h: IHoldRow, visible: boolean) => ({
  id: h.id,
  candidateId: h.candidate_id,
  candidateSeq: h.candidate_seq,
  status: h.status,
  // Идентификатор предмета события (письмо, документ) не отдаётся: по нему не раскрывается закрытый предмет.
  event: { id: h.input_event_id, seq: h.event_seq, type: h.event_type, class: h.event_class, refType: h.ref_type, at: iso(h.event_at) },
  covered: h.covered,
  restricted: !visible,
  reason: visible ? h.reason : null,
  resolvedBy: h.resolved_by ? { id: h.resolved_by, name: h.resolved_by_name } : null,
  resolvedAt: iso(h.resolved_at),
  etag: formatEtag(h.id, h.row_version),
});

// Манифест выпуска — точная неизменяемая запись с причинами решений: читает тот, кто сейчас видит предмет каждого
// решения в нём (R13-02). Проверка — `releaseManifestReadableBy` (@kontur/db): ту же выполняет worker перед размещением
// внутреннего набора (Review 14-1 R14-01).
export const releaseManifestReadable = async (db: Queryable, store: BlobStore, ctx: IAccessContext, r: IReleaseRow): Promise<boolean> =>
  releaseManifestReadableBy(db, ctx, r, JSON.parse((await readStoredBlob(store, r.release_manifest_blob_sha256)).toString('utf8')) as IReleaseManifest);

export const requireManifestReadable = async (db: Queryable, store: BlobStore, ctx: IAccessContext, r: IReleaseRow): Promise<void> => {
  if (!(await releaseManifestReadable(db, store, ctx, r))) {
    throw conflict('в манифесте выпуска — причины решений по основаниям, закрытым для вас', 'restricted_basis', { tenderId: r.tender_id, entityType: 'release', entityId: r.id });
  }
};

export const releaseView = async (db: Queryable, store: BlobStore, ctx: IAccessContext, r: IReleaseRow) => ({
  id: r.id,
  candidateId: r.candidate_id,
  candidateSeq: r.candidate_seq,
  approvalId: r.approval_id,
  stageId: r.stage_id,
  tenderId: r.tender_id,
  mode: r.mode,
  inputVersion: r.input_version,
  contentHash: r.content_hash,
  manifestSha256: r.release_manifest_sha256,
  releasedBy: { id: r.released_by, name: r.released_by_name },
  releasedAt: iso(r.released_at),
  sendReadiness: await releaseSendReadiness(db, r),
  manifestReadable: await releaseManifestReadable(db, store, ctx, r),
});

export const gateView = (g: IGateResult) => ({
  ok: g.ok,
  blockers: g.blockers.map((b) => ({
    code: b.code,
    class: b.class,
    acceptable: b.acceptable,
    open: b.open,
    items: b.items.map((i) => ({
      subjectType: i.subjectType,
      subjectId: i.subjectId,
      subjectKey: i.subjectKey ?? '',
      subjectVersion: i.subjectVersion ?? null,
      title: i.title,
      acceptable: b.acceptable && i.acceptable !== false,
      restricted: i.restricted === true,
      // Причина принятия наследует закрытость предмета (R13-02): у закрытого пункта — без текста.
      acceptance: i.acceptance
        ? { id: i.acceptance.id, reason: i.restricted ? null : i.acceptance.reason, acceptedBy: i.acceptance.acceptedBy, acceptedAt: i.acceptance.acceptedAt }
        : null,
    })),
  })),
});

// Видимость предметов событий удержаний для читателя.
export const holdsVisibility = async (db: Queryable, ctx: IAccessContext, stage: { id: string; tenderId: string }, holds: readonly IHoldRow[]): Promise<IDecisionVisibility> =>
  decisionVisibility(db, ctx, stage, { events: holds.map((h) => ({ refType: h.ref_type, refId: h.ref_id })) });

// Состояние согласования и выпуска для карточки: оценки матрицы с отпечатком показанного состава (R13-04), согласования,
// выпуск, удержания и решения по ним, права действий.
const approvalState = async (db: Queryable, store: BlobStore, ctx: IAccessContext, c: IReleaseCandidateRow) => {
  const approvals = await listApprovals(db, c.id);
  const active = approvals.find((a) => a.status === 'active') ?? null;
  const release = await releaseOfCandidate(db, c.id);
  const holds = await listHolds(db, c.stage_id, { candidateId: c.id });
  const holdVis = await holdsVisibility(db, ctx, { id: c.stage_id, tenderId: c.tender_id }, holds);
  const ret = await candidateReturn(db, c.id);
  // Возврат по решению «влияет» — текст закрыт вместе с предметом события (R13-02).
  const retHold = ret?.hold_id ? holds.find((h) => h.id === ret.hold_id) : undefined;
  const returnVisible = !retHold || holdVis.event(retHold.ref_type, retHold.ref_id);
  const evaluable = c.status === 'ready_for_approval' || c.status === 'approved';
  const approveGate = c.status === 'ready_for_approval' ? await candidateGate(db, ctx, c, { action: 'approve', actorAuthorized: true, actorSeesContent: true }) : null;
  const releaseGate = c.status === 'approved' ? await candidateGate(db, ctx, c, { action: 'release', actorAuthorized: true, actorSeesContent: true, approval: { active, requestedId: null } }) : null;
  const facts = approveGate?.db ?? releaseGate?.db ?? null;
  const fields = approveGate?.fields ?? releaseGate?.fields ?? null;
  return {
    gate: {
      approve: approveGate ? { ...gateView(approveGate.result), compositionHash: await candidateComposition(db, c, approveGate, null) } : null,
      release: releaseGate ? { ...gateView(releaseGate.result), compositionHash: await candidateComposition(db, c, releaseGate, active?.id ?? null) } : null,
      // Справка без блокирования: черновики вопросов (В-13-4), пустые необязательные поля (толкование D-033), риски этапа 09.
      warnings: evaluable && facts && fields
        ? {
            draftQuestions: facts.draftQuestions.map((q) => ({ id: q.subjectId, title: q.title })),
            emptyOptionalFields: fields.emptyOptional,
            reviewRisks: facts.reviewRisks.map((r) => ({ ...r, acceptedAt: iso(r.acceptedAt) })),
          }
        : null,
    },
    approval: active ? approvalView(active) : null,
    approvals: approvals.map(approvalView),
    release: release ? await releaseView(db, store, ctx, release) : null,
    returned: ret ? { reason: returnVisible ? ret.reason : null, restricted: !returnVisible, holdId: ret.hold_id, returnedBy: { id: ret.returned_by, name: ret.returned_by_name }, returnedAt: iso(ret.returned_at) } : null,
    holds: {
      open: holds.filter((h) => h.status === 'open').length,
      total: holds.length,
      // Решения по удержаниям — часть подтверждаемого состава (R13-04).
      resolved: holds.filter((h) => h.status !== 'open').map((h) => holdView(h, holdVis.event(h.ref_type, h.ref_id))),
    },
    can: {
      approve: hasTenderCap(ctx, c.tender_id, 'candidate.approve'),
      acceptRisk: hasTenderCap(ctx, c.tender_id, 'risk.accept'),
      resolveHolds: hasTenderCap(ctx, c.tender_id, 'hold.resolve'),
      release: hasTenderCap(ctx, c.tender_id, 'candidate.release'),
    },
  };
};

export const candidateView = async (db: Queryable, store: BlobStore, ctx: IAccessContext, c: IReleaseCandidateRow) => {
  if (!(await candidateVisible(db, ctx, c))) return { ...candidateShell(c), restricted: true };
  const inputs = await candidateInputs(db, c.id);
  const ids = (k: string) => inputs.filter((i) => i.kind === k).sort((a, b) => a.ordinal - b.ordinal).map((i) => i.ref_id);
  const files = await candidateFiles(db, c.id);
  const previews = new Map(files.filter((f) => f.role === 'preview').map((f) => [f.source_file_id, f.id]));
  const events = await candidateEventsAfter(db, c);
  const calc = (await db.query<{ seq: number; kind: string }>('SELECT seq, kind FROM calculation_revision WHERE id = $1', [c.calculation_revision_id])).rows[0]!;
  const drafts = (
    await db.query<{ id: string; title: string; is_demo: boolean; template_name: string; revision_seq: number }>(
      `SELECT a.id, a.title, t.is_demo, t.name AS template_name, r.seq AS revision_seq FROM application_draft a JOIN template_revision r ON r.id = a.template_revision_id
         JOIN application_template t ON t.id = r.template_id WHERE a.id = ANY($1::uuid[])`,
      [ids('application_draft')],
    )
  ).rows;
  const attachments: IStandardAttachmentRevisionRow[] = [];
  for (const id of ids('attachment_revision')) attachments.push((await getStandardAttachmentRevision(db, id))!);
  const run = ids('review_run')[0] ? (await db.query<{ id: string; status: string }>('SELECT id, status FROM review_run WHERE id = $1', [ids('review_run')[0]])).rows[0] : null;
  let manifest: IManifest | null = null;
  if (c.manifest_blob_sha256) manifest = JSON.parse((await readStoredBlob(store, c.manifest_blob_sha256)).toString('utf8')) as IManifest;
  const demo = drafts.some((d) => d.is_demo);
  const blockers = [
    ...(c.mode === 'production' && calc.kind === 'provisional' ? ['CALCULATION_PROVISIONAL'] : []),
    ...(c.mode === 'production' && demo ? ['TEMPLATE_DEMO'] : []),
  ];
  return {
    ...candidateShell(c),
    restricted: false,
    inputs: {
      calculationRevision: { id: c.calculation_revision_id, seq: Number(calc.seq), kind: calc.kind },
      evidenceScopeId: c.evidence_scope_id,
      reviewRun: run ? { id: run.id, status: run.status } : null,
      decisions: ids('decision').length,
      drafts: ids('application_draft').map((id) => {
        const d = drafts.find((x) => x.id === id)!;
        return { id, title: d.title, templateName: d.template_name, revisionSeq: Number(d.revision_seq), isDemo: d.is_demo };
      }),
      attachments: attachments.map((a) => ({ revisionId: a.id, title: a.title, fileName: a.file_name, seq: a.seq })),
      fieldVersions: ids('field_version').length,
      baselines: { calculation: Number(c.calculation_baseline_version), content: Number(c.content_baseline_version) },
      inputsSha256: c.inputs_sha256,
    },
    failure: c.failure_code ? { code: c.failure_code, detail: c.failure_detail } : null,
    converterVersion: c.converter_version,
    contentHash: c.manifest_sha256,
    checks: await candidateChecks(db, c.id),
    files: files
      .filter((f) => f.role !== 'preview')
      .map((f) => ({ id: f.id, path: f.path, role: f.role, audience: f.audience, mediaType: f.media_type, sizeBytes: f.size_bytes, sha256: f.blob_sha256, previewFileId: previews.get(f.id) ?? null })),
    previews: files.filter((f) => f.role === 'preview').map((f) => ({ id: f.id, path: f.path, sourceFileId: f.source_file_id, sizeBytes: f.size_bytes, sha256: f.blob_sha256, pages: f.pages, fonts: f.fonts })),
    notes: manifest?.notes ?? [],
    knownProductionBlockers: blockers,
    // Изменения входов после сборки (D-032 В-12-9): список ограничен (касающиеся — первыми); актуальность — по правилам
    // покрытия всех событий этапа (R12-03, S13-01).
    eventsAfter: events.map((e) => ({ seq: e.seq, type: e.type, at: iso(e.createdAt), affects: e.affects })),
    eventsAfterTotal: await candidateEventsAfterCount(db, c),
    current: await candidateIsCurrent(db, c),
    ...(await approvalState(db, store, ctx, c)),
  };
};

export const loadVisibleRelease = async (db: Queryable, ctx: IAccessContext, r: IReleaseRow | null, id: string): Promise<{ release: IReleaseRow; candidate: IReleaseCandidateRow }> => {
  if (!r || !hasTenderCap(ctx, r.tender_id, 'tender.read')) throw notFound({ entityType: 'release', entityId: id });
  const c = (await getCandidate(db, r.candidate_id))!;
  await requireVisibleCandidate(db, ctx, c);
  return { release: r, candidate: c };
};

