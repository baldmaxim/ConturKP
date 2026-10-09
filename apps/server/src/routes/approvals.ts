// Согласование и выпуск кандидата (этап 13; D-033; portal-api §2.9.2; state-machines §11, §13–§15). Каждая команда —
// одна транзакция под блокировкой этапа (порядок «этап → кандидат → согласование и выпуск»); перед оценкой матрицы
// команды согласования, выпуска и принятия риска обрабатывают поступившие события этапа (инвалидация — в предварительной
// транзакции и повторно под блокировкой, D-033 ут. 3–4). Отказ матрицы — 409 BLOCKER_PRESENT со списком и аудит
// «запрещено». Возможности — только у человека (ADR-006 §3): модель и MCP их не получают; вторая линия — триггеры 0034.
// Согласуется и выпускается только показанный состав (R13-04): отпечаток из карточки сверяется под блокировкой. Решение
// по удержанию — только тем, кто видит предмет события (R13-02); причины и манифест — по закрытости предметов.
import { randomUUID } from 'node:crypto';
import {
  ApproveCandidateRequest,
  HoldsQuery,
  ReleaseArchiveQuery,
  ReleaseCandidateRequest,
  ResolveHoldRequest,
  ResolveHoldsRequest,
  ReturnCandidateRequest,
  RevokeApprovalRequest,
  RiskAcceptanceRequest,
} from '@kontur/contracts';
import { ACCEPTABLE_BLOCKERS, BLOCKERS, formatEtag, openBlockerCodes, type BlockerCode, type IGateResult } from '@kontur/core';
import {
  activeApproval,
  auditFor,
  candidateFiles,
  createDeliveriesForRelease,
  eventTitle,
  getApproval,
  getCandidate,
  getHold,
  getRelease,
  insertApproval,
  insertCandidateReturn,
  insertRelease,
  insertRiskAcceptance,
  listHolds,
  listReleases,
  lockTenderStages,
  processPendingStageEvents,
  resolveHold,
  revokeApproval,
  setCandidateStatus,
  writeAudit,
  type IAccessContext,
  type IHoldRow,
  type IReleaseCandidateRow,
  type Pool,
  type PoolClient,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { Router } from 'express';
import PizZip from 'pizzip';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { candidateComposition, candidateGate } from '../releaseGate.ts';
import { readStoredBlob } from '../releaseMarkup.ts';
import { buildReleaseManifest, candidateHistory, storeReleaseManifest } from '../releaseRecord.ts';
import {
  candidateTarget,
  candidateView,
  candidateVisible,
  gateView,
  holdsVisibility,
  holdView,
  loadCandidate,
  loadVisibleRelease,
  releaseManifestReadable,
  releaseView,
  requireManifestReadable,
  requireVisibleCandidate,
} from '../releaseViews.ts';
import { contentDisposition } from './documents.ts';
import { conflict, stageVersion } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';
import { loadStage } from './stages.ts';

const STATUS_TEXT: Record<string, string> = {
  assembling: 'собирается',
  assembly_failed: 'сборка не удалась',
  ready_for_approval: 'готов к согласованию',
  approved: 'согласован',
  returned: 'возвращён на доработку',
  released: 'выпущен',
  superseded: 'заменён',
};

// Кандидат под блокировкой: сначала строка этапа (та же, что у записи событий входов), затем строка кандидата.
const lockedCandidate = async (client: PoolClient, ctx: IAccessContext, id: string): Promise<IReleaseCandidateRow> => {
  const head = await loadCandidate(client, ctx, id);
  await lockTenderStages(client, head.tender_id, [head.stage_id]);
  return (await getCandidate(client, id, true))!;
};

const requireCandidateVersion = (req: Parameters<typeof requireIfMatch>[0], c: IReleaseCandidateRow): void => {
  if (requireIfMatch(req, c.id) !== Number(c.row_version)) throw versionConflict({ id: c.id, status: c.status, etag: formatEtag(c.id, c.row_version) });
};

const blockerError = (c: IReleaseCandidateRow, g: IGateResult, verb: string): HttpError => {
  const codes = openBlockerCodes(g);
  return new HttpError(409, 'BLOCKER_PRESENT', `${verb} запрещено: ${codes.join(', ')}`, { blockers: gateView(g).blockers.filter((b) => b.open > 0) }, {
    ...candidateTarget(c),
    details: { blockers: codes },
  });
};

const stateText = (c: IReleaseCandidateRow) => STATUS_TEXT[c.status] ?? c.status;

// Показанный состав (R13-04): изменился после открытия диалога — повторное ознакомление, не молчаливое согласование.
const requireComposition = (c: IReleaseCandidateRow, shown: string | undefined, actual: string): void => {
  if (!shown) throw new HttpError(400, 'VALIDATION_FAILED', 'compositionHash — отпечаток показанного состава из карточки комплекта — обязателен');
  if (shown !== actual) {
    throw conflict('после показа изменились принятые риски или решения по удержаниям: перечитайте карточку и проверьте состав', 'composition_changed', candidateTarget(c));
  }
};

const commandResult = async (client: Queryable, store: BlobStore, ctx: IAccessContext, id: string, status: number, audit: { action: string; details: Record<string, unknown> }) => {
  const c = (await getCandidate(client, id))!;
  return {
    status,
    body: await candidateView(client, store, ctx, c),
    etag: formatEtag(c.id, c.row_version),
    audit: [{ action: audit.action, entityType: 'release_candidate', entityId: c.id, tenderId: c.tender_id, details: { stageId: c.stage_id, seq: c.seq, ...audit.details } }],
  };
};

// Неразобранные элементы партии импорта — в основание решения «не влияет» (state-machines §3.1: пробелы видимы).
const importGaps = async (db: Queryable, h: IHoldRow): Promise<string> => {
  if (h.event_type !== 'import_accepted') return '';
  const rows = (
    await db.query<{ observed_name: string; status: string }>(
      `SELECT i.observed_name, i.status FROM import_item i JOIN release_candidate c ON c.id = $2 JOIN evidence_scope s ON s.id = c.evidence_scope_id
        WHERE i.batch_id = $1 AND NOT import_item_covered(s.source_set_revision_id, i.id) ORDER BY i.member_path LIMIT 50`,
      [h.ref_id, h.candidate_id],
    )
  ).rows;
  return rows.length > 0 ? `\nНеразобранные элементы партии: ${rows.map((r) => `${r.observed_name} (${r.status})`).join(', ')}` : '';
};

const resolveOne = async (
  client: PoolClient,
  h: IHoldRow,
  c: IReleaseCandidateRow,
  r: { resolution: 'not_applicable' | 'requires_new_candidate'; reason: string; userId: string; visible: boolean },
) => {
  const { resolution, reason, userId } = r;
  if (h.status !== 'open') throw conflict('по этому событию решение уже принято', 'hold_resolved', { tenderId: h.tender_id, entityType: 'readiness_hold', entityId: h.id });
  // Решение о применимости — по прочитанному предмету (D-033 ут. 4: проверки прав не отменяются; R13-02).
  if (!r.visible) {
    throw conflict(`предмет события № ${h.event_seq} закрыт для вас: решение о его применимости принимает тот, кто может его прочитать`, 'restricted_event', {
      tenderId: h.tender_id,
      entityType: 'readiness_hold',
      entityId: h.id,
    });
  }
  // Возвращённый — тоже: в группе «влияет» первое решение возвращает кандидата, остальные события решаются следом.
  if (!['assembling', 'ready_for_approval', 'approved', 'released', 'returned'].includes(c.status)) {
    throw conflict(`комплект ${stateText(c)}: удержание не решается`, 'candidate_inactive', candidateTarget(c));
  }
  if (resolution === 'requires_new_candidate' && c.status === 'assembling') {
    throw conflict('комплект ещё собирается: «влияет» — после сборки', 'candidate_assembling', candidateTarget(c));
  }
  const decisionId = await resolveHold(client, h, { resolution, reason: `${reason}${await importGaps(client, h)}`.slice(0, 4000), userId });
  // «Влияет»: невыпущенный кандидат возвращается, его согласование отзывается; у выпущенного отправка исключена навсегда.
  // Текст возврата и отзыва — без причины решения: она остаётся в решении по удержанию, закрытом вместе с предметом.
  if (resolution === 'requires_new_candidate' && (c.status === 'ready_for_approval' || c.status === 'approved')) {
    const text = `влияет событие № ${h.event_seq} (${eventTitle(h.event_type)}): решение по удержанию`;
    const active = await activeApproval(client, c.id);
    if (active) await revokeApproval(client, active.id, userId, text);
    await insertCandidateReturn(client, { candidate: c, reason: text, holdId: h.id, userId });
  }
  return decisionId;
};

export const approvalsRouter = (pool: Pool, store: BlobStore): Router => {
  const router = Router();
  const capCheck = (cap: 'candidate.approve' | 'candidate.release' | 'risk.accept' | 'hold.resolve') => async (client: PoolClient, ctx: IAccessContext, req: Parameters<typeof uuidParam>[0]) => {
    const c = await loadCandidate(client, ctx, uuidParam(req, 'id', 'release_candidate'));
    if (!hasTenderCap(ctx, c.tender_id, cap)) throw forbidden(cap, candidateTarget(c));
  };
  const syncEvents = async (client: PoolClient, _ctx: IAccessContext, req: Parameters<typeof uuidParam>[0]) => {
    const c = await getCandidate(client, uuidParam(req, 'id', 'release_candidate'));
    if (c) await processPendingStageEvents(client, c.stage_id);
  };

  // ---------------------------------------------------------------- Принятие риска (D-033 В-13-3)

  router.post(
    '/release-candidates/:id/risk-acceptances',
    command(pool, {
      action: 'release.risk.accept',
      entityType: 'release_candidate',
      idempotent: true,
      authorize: capCheck('risk.accept'),
      prepare: syncEvents,
      run: async (client, ctx, req) => {
        const c = await lockedCandidate(client, ctx, uuidParam(req, 'id', 'release_candidate'));
        await processPendingStageEvents(client, c.stage_id);
        const body = parseBody(RiskAcceptanceRequest, req.body);
        const code = body.blockerCode as BlockerCode;
        if (!(code in BLOCKERS) || !ACCEPTABLE_BLOCKERS.includes(code)) {
          throw conflict(`блокер ${body.blockerCode} риском не снимается: технические нарушения, права и целостность не обходятся (D-033)`, 'risk_not_acceptable', candidateTarget(c), {
            blockerCode: body.blockerCode,
          });
        }
        if (c.status === 'approved') throw conflict('комплект согласован: отзовите согласование, примите риск и согласуйте заново (В-13-3)', 'approved_revoke_first', candidateTarget(c));
        if (c.status !== 'ready_for_approval') throw conflict(`риск принимается по готовому комплекту; комплект ${stateText(c)}`, 'not_ready', candidateTarget(c));
        await requireVisibleCandidate(client, ctx, c);
        const gate = await candidateGate(client, ctx, c, { action: 'approve', actorAuthorized: true, actorSeesContent: true });
        const item = gate.result.blockers
          .find((b) => b.code === code)
          ?.items.find((i) => i.subjectType === body.subjectType && i.subjectId === body.subjectId.toLowerCase() && (i.subjectKey ?? '') === body.subjectKey);
        if (!item) throw conflict('такого пункта блокера у комплекта сейчас нет', 'not_a_blocker', candidateTarget(c), { blockerCode: code });
        if (item.restricted) {
          throw conflict('основания пункта закрыты для вас: принять по нему риск нельзя', 'restricted_fragments', candidateTarget(c));
        }
        if (item.acceptable === false) {
          throw conflict('у поля есть неснимаемая проблема (основание изменилось): нужно актуальное значение и пересборка (D-033 ут. 2)', 'field_not_current', candidateTarget(c));
        }
        if (item.acceptance) throw conflict('риск по этому пункту уже принят', 'already_accepted', candidateTarget(c), { acceptanceId: item.acceptance.id });
        const id = await insertRiskAcceptance(client, { candidate: c, code, item, reason: body.reason, userId: ctx.principal.userId });
        return commandResult(client, store, ctx, c.id, 201, { action: 'release.risk.accept', details: { acceptanceId: id, blockerCode: code, subjectType: item.subjectType, subjectId: item.subjectId } });
      },
    }),
  );

  // ---------------------------------------------------------------- Согласование, возврат, отзыв

  router.post(
    '/release-candidates/:id/approve',
    command(pool, {
      action: 'release.candidate.approve',
      entityType: 'release_candidate',
      idempotent: true,
      authorize: capCheck('candidate.approve'),
      prepare: syncEvents,
      run: async (client, ctx, req) => {
        const c = await lockedCandidate(client, ctx, uuidParam(req, 'id', 'release_candidate'));
        await processPendingStageEvents(client, c.stage_id);
        const body = parseBody(ApproveCandidateRequest, req.body);
        if (c.status === 'approved' || c.status === 'released') {
          throw conflict(`комплект уже ${stateText(c)}`, 'already_approved', candidateTarget(c), { approvalId: (await activeApproval(client, c.id))?.id ?? null });
        }
        if (c.status !== 'ready_for_approval') throw conflict(`согласуется готовый комплект; комплект ${stateText(c)}`, 'not_ready', candidateTarget(c));
        requireCandidateVersion(req, c);
        if (body.contentHash !== c.manifest_sha256) throw conflict('содержимое комплекта не то, что было показано: перечитайте карточку', 'content_changed', candidateTarget(c));
        const gate = await candidateGate(client, ctx, c, { action: 'approve', actorAuthorized: true, actorSeesContent: await candidateVisible(client, ctx, c), store });
        if (!gate.result.ok) throw blockerError(c, gate.result, 'Согласование');
        const composition = await candidateComposition(client, c, gate, null);
        requireComposition(c, body.compositionHash, composition);
        const approvalId = await insertApproval(client, {
          candidate: c,
          inputVersion: await stageVersion(client, c.stage_id),
          gate: { ...gateView(gate.result), compositionHash: composition },
          acceptedRiskIds: gate.result.usedAcceptanceIds,
          comment: body.comment ?? null,
          userId: ctx.principal.userId,
        });
        return commandResult(client, store, ctx, c.id, 200, {
          action: 'release.candidate.approve',
          details: { approvalId, contentHash: c.manifest_sha256, compositionHash: composition, acceptedRisks: gate.result.usedAcceptanceIds.length },
        });
      },
    }),
  );

  router.post(
    '/release-candidates/:id/return',
    command(pool, {
      action: 'release.candidate.return',
      entityType: 'release_candidate',
      idempotent: true,
      authorize: capCheck('candidate.approve'),
      run: async (client, ctx, req) => {
        const c = await lockedCandidate(client, ctx, uuidParam(req, 'id', 'release_candidate'));
        const body = parseBody(ReturnCandidateRequest, req.body);
        if (c.status === 'approved') throw conflict('комплект согласован: сначала отзовите согласование (В-13-9)', 'approved_revoke_first', candidateTarget(c));
        if (c.status !== 'ready_for_approval') throw conflict(`возвращается готовый к согласованию комплект; комплект ${stateText(c)}`, 'not_ready', candidateTarget(c));
        requireCandidateVersion(req, c);
        await insertCandidateReturn(client, { candidate: c, reason: body.reason, holdId: null, userId: ctx.principal.userId });
        return commandResult(client, store, ctx, c.id, 200, { action: 'release.candidate.return', details: { reason: body.reason } });
      },
    }),
  );

  router.post(
    '/approvals/:id/revoke',
    command(pool, {
      action: 'release.approval.revoke',
      entityType: 'approval',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'approval');
        const a = await getApproval(client, id);
        if (!a || !hasTenderCap(ctx, a.tender_id, 'tender.read')) throw notFound({ entityType: 'approval', entityId: id });
        if (!hasTenderCap(ctx, a.tender_id, 'candidate.approve')) throw forbidden('candidate.approve', { tenderId: a.tender_id, entityType: 'approval', entityId: a.id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'approval');
        const head = (await getApproval(client, id))!;
        const c = await lockedCandidate(client, ctx, head.candidate_id);
        const a = (await getApproval(client, id, true))!;
        const body = parseBody(RevokeApprovalRequest, req.body);
        const tgt = { tenderId: a.tender_id, entityType: 'approval', entityId: a.id };
        if (c.status === 'released') throw conflict('комплект выпущен: согласование выпуска не отзывается — исправление новым комплектом', 'already_released', tgt);
        if (a.status !== 'active') throw conflict('согласование уже не действует', 'approval_not_active', tgt, { status: a.status });
        if (requireIfMatch(req, a.id) !== a.row_version) throw versionConflict({ id: a.id, status: a.status, etag: formatEtag(a.id, a.row_version) });
        await revokeApproval(client, a.id, ctx.principal.userId, body.reason);
        await setCandidateStatus(client, c.id, 'ready_for_approval');
        return commandResult(client, store, ctx, c.id, 200, { action: 'release.approval.revoke', details: { approvalId: a.id, reason: body.reason } });
      },
    }),
  );

  // ---------------------------------------------------------------- Выпуск

  router.post(
    '/release-candidates/:id/release',
    command(pool, {
      action: 'release.candidate.release',
      entityType: 'release_candidate',
      idempotent: true,
      authorize: capCheck('candidate.release'),
      prepare: syncEvents,
      run: async (client, ctx, req) => {
        const c = await lockedCandidate(client, ctx, uuidParam(req, 'id', 'release_candidate'));
        await processPendingStageEvents(client, c.stage_id);
        const body = parseBody(ReleaseCandidateRequest, req.body);
        if (c.status === 'released') {
          const existing = (await client.query<{ id: string }>('SELECT id FROM release WHERE candidate_id = $1', [c.id])).rows[0];
          throw conflict('комплект уже выпущен', 'already_released', candidateTarget(c), { releaseId: existing?.id ?? null });
        }
        if (c.status !== 'approved') throw conflict(`выпускается согласованный комплект; комплект ${stateText(c)}`, 'not_approved', candidateTarget(c));
        requireCandidateVersion(req, c);
        if (body.contentHash !== c.manifest_sha256) throw conflict('содержимое комплекта не то, что было показано: перечитайте карточку', 'content_changed', candidateTarget(c));
        const active = await activeApproval(client, c.id);
        const gate = await candidateGate(client, ctx, c, {
          action: 'release',
          actorAuthorized: true,
          actorSeesContent: await candidateVisible(client, ctx, c),
          approval: { active, requestedId: body.approvalId.toLowerCase() },
          store,
        });
        if (!gate.result.ok || !active) throw blockerError(c, gate.result, 'Выпуск');
        const composition = await candidateComposition(client, c, gate, active.id);
        requireComposition(c, body.compositionHash, composition);
        const releasedAt = (await client.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
        const id = randomUUID();
        const inputVersion = await stageVersion(client, c.stage_id);
        const manifest = await buildReleaseManifest(client, store, {
          id,
          candidate: c,
          approval: active,
          gate: gate.result,
          reviewRisks: gate.db.reviewRisks,
          inputVersion,
          releasedBy: { id: ctx.principal.userId, name: ctx.principal.displayName },
          releasedAt,
        });
        const stored = await storeReleaseManifest(client, store, manifest);
        await insertRelease(client, {
          id,
          candidate: c,
          approvalId: active.id,
          inputVersion,
          manifest: stored,
          gate: { ...gateView(gate.result), compositionHash: composition },
          userId: ctx.principal.userId,
          releasedAt,
        });
        // Этап 14: доставки во все активные назначения среды выпуска — в той же транзакции; размещает worker. Внутренний набор
        // несёт манифест выпуска — только если выпускающий его читает (Review 14-1 R14-01); иначе назначение пропускается.
        const internalOk = await releaseManifestReadable(client, store, ctx, (await getRelease(client, id))!);
        const { created: deliveries, skipped } = await createDeliveriesForRelease(client, id, null, null, { internal: internalOk });
        const r = await commandResult(client, store, ctx, c.id, 201, { action: 'release.candidate.release', details: { releaseId: id, approvalId: active.id, mode: c.mode, manifestSha256: stored.sha256 } });
        return {
          ...r,
          audit: [...r.audit, { action: 'release.create', entityType: 'release', entityId: id, tenderId: c.tender_id, details: { candidateId: c.id, mode: c.mode, deliveries, deliveriesSkipped: skipped.map((destinationId) => ({ destinationId, reason: 'restricted_basis' })) } }],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Удержания (D-033 В-13-5)

  router.get(
    '/stages/:id/holds',
    query(pool, 'release.hold.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      if (!hasTenderCap(ctx, stage.tender_id, 'tender.read')) throw notFound({ entityType: 'tender_stage', entityId: stage.id });
      const q = HoldsQuery.safeParse(req.query);
      if (!q.success) throw new HttpError(400, 'VALIDATION_FAILED', 'candidateId — UUID, status — open | resolved_not_applicable | resolved_requires_new_candidate');
      const items = await listHolds(pool, stage.id, { candidateId: q.data.candidateId?.toLowerCase(), status: q.data.status });
      const vis = await holdsVisibility(pool, ctx, { id: stage.id, tenderId: stage.tender_id }, items);
      res.json({ items: items.map((h) => holdView(h, vis.event(h.ref_type, h.ref_id))), canResolve: hasTenderCap(ctx, stage.tender_id, 'hold.resolve') });
    }),
  );

  router.post(
    '/holds/:id/resolve',
    command(pool, {
      action: 'release.hold.resolve',
      entityType: 'readiness_hold',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'readiness_hold');
        const h = await getHold(client, id);
        if (!h || !hasTenderCap(ctx, h.tender_id, 'tender.read')) throw notFound({ entityType: 'readiness_hold', entityId: id });
        if (!hasTenderCap(ctx, h.tender_id, 'hold.resolve')) throw forbidden('hold.resolve', { tenderId: h.tender_id, entityType: 'readiness_hold', entityId: h.id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'readiness_hold');
        const head = (await getHold(client, id))!;
        const c = await lockedCandidate(client, ctx, head.candidate_id);
        const h = (await getHold(client, id, true))!;
        const body = parseBody(ResolveHoldRequest, req.body);
        if (requireIfMatch(req, h.id) !== h.row_version) throw versionConflict({ id: h.id, status: h.status, etag: formatEtag(h.id, h.row_version) });
        const vis = await holdsVisibility(client, ctx, { id: h.stage_id, tenderId: h.tender_id }, [h]);
        const decisionId = await resolveOne(client, h, c, { resolution: body.resolution, reason: body.reason, userId: ctx.principal.userId, visible: vis.event(h.ref_type, h.ref_id) });
        const fresh = (await getHold(client, id))!;
        return {
          status: 200,
          body: holdView(fresh, true),
          etag: formatEtag(fresh.id, fresh.row_version),
          audit: [{ action: 'release.hold.resolve', entityType: 'readiness_hold', entityId: h.id, tenderId: h.tender_id, details: { candidateId: c.id, eventSeq: h.event_seq, resolution: body.resolution, decisionId } }],
        };
      },
    }),
  );

  // Группой: одно основание, у каждого события — своё решение (В-13-5); всё или ничего в одной транзакции.
  router.post(
    '/release-candidates/:id/holds/resolve',
    command(pool, {
      action: 'release.hold.resolve',
      entityType: 'release_candidate',
      idempotent: true,
      authorize: capCheck('hold.resolve'),
      run: async (client, ctx, req) => {
        const c = await lockedCandidate(client, ctx, uuidParam(req, 'id', 'release_candidate'));
        const body = parseBody(ResolveHoldsRequest, req.body);
        const decisions: string[] = [];
        const holds: IHoldRow[] = [];
        for (const holdId of [...new Set(body.holdIds.map((x) => x.toLowerCase()))]) {
          const h = await getHold(client, holdId, true);
          if (!h || h.candidate_id !== c.id) throw notFound({ entityType: 'readiness_hold', entityId: holdId });
          holds.push(h);
        }
        // Всё или ничего: закрытый предмет хоть одного события — отказ всей группы.
        const vis = await holdsVisibility(client, ctx, { id: c.stage_id, tenderId: c.tender_id }, holds);
        for (const h of holds) {
          const visible = vis.event(h.ref_type, h.ref_id);
          decisions.push(await resolveOne(client, h, (await getCandidate(client, c.id))!, { resolution: body.resolution, reason: body.reason, userId: ctx.principal.userId, visible }));
        }
        return commandResult(client, store, ctx, c.id, 200, { action: 'release.hold.resolve', details: { holds: decisions.length, resolution: body.resolution } });
      },
    }),
  );

  // ---------------------------------------------------------------- Журнал и выпуски

  router.get(
    '/release-candidates/:id/history',
    query(pool, 'release.candidate.history', 'release_candidate', async (ctx, req, res) => {
      const c = await loadCandidate(pool, ctx, uuidParam(req, 'id', 'release_candidate'));
      await requireVisibleCandidate(pool, ctx, c);
      res.json({ items: await candidateHistory(pool, ctx, c) });
    }),
  );

  router.get(
    '/stages/:id/releases',
    query(pool, 'release.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      if (!hasTenderCap(ctx, stage.tender_id, 'tender.read')) throw notFound({ entityType: 'tender_stage', entityId: stage.id });
      const items = [];
      for (const r of await listReleases(pool, stage.id)) {
        const c = (await getCandidate(pool, r.candidate_id))!;
        items.push((await candidateVisible(pool, ctx, c)) ? { ...(await releaseView(pool, store, ctx, r)), restricted: false } : { id: r.id, candidateId: r.candidate_id, candidateSeq: r.candidate_seq, mode: r.mode, restricted: true });
      }
      res.json({ items });
    }),
  );

  router.get(
    '/releases/:id',
    query(pool, 'release.read', 'release', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'release');
      const { release } = await loadVisibleRelease(pool, ctx, await getRelease(pool, id), id);
      res.json(await releaseView(pool, store, ctx, release));
    }),
  );

  router.get(
    '/releases/:id/manifest',
    query(pool, 'release.manifest', 'release', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'release');
      const { release } = await loadVisibleRelease(pool, ctx, await getRelease(pool, id), id);
      await requireManifestReadable(pool, store, ctx, release);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-SHA256', release.release_manifest_sha256);
      res.send(await readStoredBlob(store, release.release_manifest_blob_sha256));
    }),
  );

  // ZIP выпуска — точные байты кандидата (I02): заказчику — файлы для заказчика; всё — с обоими манифестами.
  router.get(
    '/releases/:id/archive',
    query(pool, 'release.archive', 'release', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'release');
      const { release, candidate } = await loadVisibleRelease(pool, ctx, await getRelease(pool, id), id);
      const q = ReleaseArchiveQuery.safeParse(req.query);
      if (!q.success) throw new HttpError(400, 'VALIDATION_FAILED', 'set — customer или all');
      // ZIP всех файлов содержит манифест выпуска с причинами решений (R13-02); ZIP для заказчика — только файлы.
      if (q.data.set === 'all') await requireManifestReadable(pool, store, ctx, release);
      const files = (await candidateFiles(pool, candidate.id)).filter((f) => (q.data.set === 'all' ? true : f.audience === 'customer' && f.role !== 'preview'));
      const zip = new PizZip();
      const date = new Date(1980, 0, 1, 0, 0, 0);
      for (const f of files) zip.file(f.path, await readStoredBlob(store, f.blob_sha256), { date });
      if (q.data.set === 'all') {
        zip.file('manifest.json', await readStoredBlob(store, candidate.manifest_blob_sha256!), { date });
        zip.file('release-manifest.json', await readStoredBlob(store, release.release_manifest_blob_sha256), { date });
      }
      const bytes = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      await writeAudit(pool, auditFor(ctx, { action: 'release.archive', entityType: 'release', entityId: release.id, tenderId: release.tender_id, outcome: 'allowed', details: { set: q.data.set, files: files.length } }));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Content-Disposition', contentDisposition(false, `Выпуск комплекта ${candidate.seq}${q.data.set === 'all' ? ' (все файлы)' : ''}.zip`));
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(bytes);
    }),
  );

  return router;
};
