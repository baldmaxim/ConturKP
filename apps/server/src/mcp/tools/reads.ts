// Инструменты чтения этапа и выпуска (проект §5.1): обзор, документы, требования, расчёт, экономика, замечания, вопросы,
// решения, готовность. Каждый вызывает те же функции чтения и те же проверки закрытости, что и экран портала: своей
// логики прав у MCP нет. Суммы считает сервер; отсутствие данных — явное «нет данных» с причиной, а не ноль.
import {
  activeApproval,
  activeRegistryOf,
  candidateIsCurrent,
  ensureRevisionEconomics,
  evidenceScopeItems,
  getCalculationRevision,
  getCandidate,
  getEvidenceScope,
  getRelease,
  getRevisionEconomics,
  latestFrozenRevision,
  latestWorkingRevision,
  linksOf,
  listCalculationRevisions,
  listCandidates,
  listCustomerQuestions,
  listDeliveries,
  listDocuments,
  listFindings,
  listHolds,
  listQaThreads,
  listRequirements,
  listReviewRuns,
  listSetItems,
  listTenderReleases,
  loadEconomicsRevision,
  openMcpProposalCount,
  primaryCalculationSource,
  readableContractIds,
  readableMailboxIds,
  releaseOfCandidate,
  releaseSendReadiness,
  requirementDecisions,
  revisionLines,
  revisionPositions,
  sendSummaries,
  stageVisibility,
  withTransaction,
  type ICalcRevisionView,
  type Queryable,
} from '@kontur/db';
import { z } from 'zod';
import { toLine, toPosition, toRevision } from '../../calculationMappers.ts';
import { toRevisionEconomics } from '../../economicsMappers.ts';
import { toQaThread } from '../../mailMappers.ts';
import { candidateGate } from '../../releaseGate.ts';
import { candidateShell, candidateVisible, gateView, holdsVisibility, holdView } from '../../releaseViews.ts';
import { toCustomerQuestion, toDecision } from '../../requirementMappers.ts';
import { findingsList, runBrief } from '../../reviewMappers.ts';
import { projectRequirement } from '../../routes/requirementItems.ts';
import { toEvidenceScope } from '../../searchMappers.ts';
import { toDocument } from '../../sourceMappers.ts';
import { paginate } from '../limits.ts';
import { resolveCase, type ICaseScope } from '../scope.ts';
import { McpToolError, type IMcpSession } from '../session.ts';
import { DATA_NOTICE, defineTool } from '../tools.ts';

const uuid = z.string().uuid();
const caseArgs = { tenderId: uuid.optional(), stageId: uuid.optional(), releaseId: uuid.optional() };
const paging = { cursor: z.string().max(400).optional(), limit: z.number().int().min(1).max(50).optional() };
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const scopeKey = (c: ICaseScope): string => `${c.tenderId}:${c.releaseId ?? c.stageId}`;
const noData = (reason: string, message: string) => ({ reason, message });

// Ревизия расчёта области: у выпуска — закреплённая его комплектом, у этапа — последняя полученная.
const revisionOf = async (db: Queryable, s: IMcpSession, c: ICaseScope): Promise<ICalcRevisionView | null> => {
  if (c.releaseId) {
    const release = (await getRelease(db, c.releaseId))!;
    const candidate = (await getCandidate(db, release.candidate_id))!;
    return getCalculationRevision(db, s.ctx, candidate.calculation_revision_id);
  }
  return (await listCalculationRevisions(db, c.stageId))[0] ?? null;
};

// Краткая карточка ревизии: вид (предварительная или подтверждённая), итоги источника и запрет боевого выпуска.
const revisionBrief = (rev: ICalcRevisionView) => {
  const v = toRevision(rev) as Record<string, unknown>;
  return { id: v.id, seq: v.seq, kind: v.kind, system: v.system, externalVersion: v.externalVersion, createdAt: v.createdAt, contentHash: v.contentHash, counts: v.counts, productionGate: v.productionGate };
};

export const caseOverviewTool = defineTool({
  name: 'get_case_overview',
  title: 'Обзор этапа',
  description: 'Состояние этапа: набор источников, ревизия расчёта, последняя проверка, комплекты и выпуски, число открытых предложений из чата. Подробности — отдельными инструментами.',
  scope: 'read',
  input: z.object({ tenderId: uuid.optional(), stageId: uuid.optional() }).strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const [working, frozen, source, revisions, runs, candidates, releases] = await Promise.all([
      latestWorkingRevision(s.pool, c.stageId),
      latestFrozenRevision(s.pool, c.stageId),
      primaryCalculationSource(s.pool, c.stageId),
      listCalculationRevisions(s.pool, c.stageId),
      listReviewRuns(s.pool, c.stageId, 1),
      listCandidates(s.pool, c.stageId),
      listTenderReleases(s.pool, c.tenderId),
    ]);
    const stageReleases = releases.filter((r) => r.stage_id === c.stageId);
    const summaries = await sendSummaries(s.pool, stageReleases.map((r) => r.id));
    const releaseItems = [];
    for (const r of stageReleases) {
      const visible = await candidateVisible(s.pool, s.ctx, (await getCandidate(s.pool, r.candidate_id))!);
      const send = summaries.get(r.id);
      releaseItems.push({ releaseId: r.id, candidateSeq: Number(r.candidate_seq), mode: r.mode, releasedAt: iso(r.released_at), restricted: !visible, send: send ? { events: send.events, counted: send.counted, disputed: send.disputed, incidents: send.incidents } : null });
    }
    const latest = candidates[0];
    return {
      result: {
        tenderId: c.tenderId,
        stageId: c.stageId,
        sourceSet: { working: working ? { revisionId: working.id, status: working.status, contentHash: working.content_hash } : null, frozen: frozen ? { revisionId: frozen.id, contentHash: frozen.content_hash } : null },
        calculation: {
          source: source ? { system: source.system, externalTenderId: source.external_tender_id } : null,
          latestRevision: revisions[0] ? revisionBrief(revisions[0]) : null,
          revisions: revisions.length,
          ...(revisions[0] ? {} : { noData: noData('no_calculation_revision', 'у этапа нет полученной ревизии расчёта') }),
        },
        lastReviewRun: runs[0] ? runBrief(runs[0]) : null,
        latestCandidate: latest ? { ...candidateShell(latest), restricted: !(await candidateVisible(s.pool, s.ctx, latest)), current: await candidateIsCurrent(s.pool, latest) } : null,
        releases: releaseItems,
        openChatProposals: await openMcpProposalCount(s.pool, c.stageId),
      },
      tenderId: c.tenderId,
      entityType: 'tender_stage',
      entityId: c.stageId,
    };
  },
});

export const listDocumentsTool = defineTool({
  name: 'list_documents',
  title: 'Документы области',
  description: `Документы и редакции области. Для этапа — документы тендера и текущий состав источников этапа; для выпуска — единицы снимка источников его комплекта (документы, письма, протоколы, вопросы–ответы). Закрытые для пользователя единицы показаны без названий. ${DATA_NOTICE}`,
  scope: 'read',
  input: z.object({ ...caseArgs, docType: z.string().trim().min(1).max(60).optional(), ...paging }).strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const contracts = new Set(readableContractIds(s.ctx));
    const mailboxes = new Set(readableMailboxIds(s.ctx));
    if (c.releaseId) {
      const scope = await getEvidenceScope(s.pool, s.ctx, c.evidenceScopeId!);
      if (!scope) throw new McpToolError('out_of_scope', 'объект вне области запроса или недоступен');
      const view = toEvidenceScope(scope, await evidenceScopeItems(s.pool, scope.id), contracts, mailboxes) as unknown as { items?: Record<string, unknown>[]; contentHash: string };
      const page = paginate('list_documents', scopeKey(c), view.items ?? [], a.cursor, a.limit);
      return { result: { scope: 'release', releaseId: c.releaseId, evidenceScopeId: scope.id, contentHash: view.contentHash, units: page.items, nextCursor: page.nextCursor, total: (view.items ?? []).length }, tenderId: c.tenderId, entityType: 'release', entityId: c.releaseId };
    }
    const working = await latestWorkingRevision(s.pool, c.stageId);
    const inclusion = new Map<string, { inclusion: string; restricted: boolean }>();
    const outside: Record<string, unknown>[] = [];
    for (const i of working ? await listSetItems(s.pool, working.id) : []) {
      const restricted = (i.contract_id !== null && !contracts.has(i.contract_id)) || (i.mailbox_id !== null && !mailboxes.has(i.mailbox_id));
      inclusion.set(i.document_revision_id, { inclusion: i.inclusion, restricted });
      // Редакции договора и вложения писем в составе этапа: документами тендера они не являются.
      if (i.contract_id !== null || i.mailbox_id !== null) {
        outside.push({ documentRevisionId: i.document_revision_id, source: i.contract_id !== null ? 'contract' : 'mail_attachment', restricted, title: restricted ? null : i.document_title, revisionSeq: restricted ? null : i.revision_seq, inclusion: i.inclusion });
      }
    }
    const documents = (await listDocuments(s.pool, s.ctx, c.tenderId))
      .map((d) => toDocument(d) as Record<string, unknown>)
      .filter((d) => !a.docType || d.docType === a.docType)
      .map((d) => ({ documentId: d.id, title: d.title, docType: d.docType, docCode: d.docCode, revisions: d.revisions, latestRevisionId: d.latestRevisionId, latestReceivedAt: d.latestReceivedAt, inStageSet: typeof d.latestRevisionId === 'string' ? (inclusion.get(d.latestRevisionId)?.inclusion ?? null) : null }));
    const all = [...documents, ...(a.docType ? [] : outside)];
    const page = paginate('list_documents', `${scopeKey(c)}:${a.docType ?? ''}`, all, a.cursor, a.limit);
    return { result: { scope: 'stage', stageId: c.stageId, workingSet: working ? { revisionId: working.id, status: working.status } : null, documents: page.items, nextCursor: page.nextCursor, total: all.length }, tenderId: c.tenderId, entityType: 'tender_stage', entityId: c.stageId };
  },
});

export const listRequirementsTool = defineTool({
  name: 'list_requirements',
  title: 'Требования этапа',
  description: `Требования действующего реестра этапа: код, формулировка, параметры, статус, покрытие расчётом, противоречия. Закрытое для пользователя требование показано без текста. Основания — по ID фрагментов через get_citation. ${DATA_NOTICE}`,
  scope: 'read',
  input: z.object({ tenderId: uuid.optional(), stageId: uuid.optional(), ...paging }).strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const registry = await activeRegistryOf(s.pool, c.stageId);
    if (!registry) return { result: { requirements: [], nextCursor: null, total: 0, noData: noData('no_active_registry', 'у этапа нет действующего реестра требований') }, tenderId: c.tenderId, entityType: 'tender_stage', entityId: c.stageId };
    const rows = await listRequirements(s.pool, registry.id);
    const links = await linksOf(s.pool, 'requirement_revision_id', rows.map((r) => r.current_revision_id));
    const vis = await stageVisibility(s.pool, s.ctx, registry.stage_id);
    const all = rows.map((r) => {
      const fragments = (links.get(r.current_revision_id) ?? []).filter((l) => vis.readable.has(l.fragment_id)).map((l) => ({ fragmentId: l.fragment_id, role: l.role }));
      const v = projectRequirement(r, links.get(r.current_revision_id) ?? [], vis) as Record<string, unknown>;
      return { ...v, evidence: v.restricted ? [] : fragments };
    });
    const page = paginate('list_requirements', scopeKey(c), all, a.cursor, a.limit);
    return { result: { registryId: registry.id, requirements: page.items, nextCursor: page.nextCursor, total: all.length }, tenderId: c.tenderId, entityType: 'requirement_registry', entityId: registry.id };
  },
});

export const getCalculationTool = defineTool({
  name: 'get_calculation',
  title: 'Расчёт',
  description: `Ревизия расчёта области: у выпуска — закреплённая его комплектом, у этапа — последняя полученная. view: totals — итоги и вид ревизии, positions — позиции, lines — строки (positionId — строки одной позиции). Каждая сумма несёт валюту, признак НДС и вид цены (cost — себестоимость, commercial — коммерческая): суммы разных видов не складываются. ${DATA_NOTICE}`,
  scope: 'read',
  input: z.object({ ...caseArgs, view: z.enum(['totals', 'positions', 'lines']), positionId: uuid.optional(), cursor: z.string().max(400).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const rev = await revisionOf(s.pool, s, c);
    const base = { tenderId: c.tenderId, entityType: 'calculation_revision', entityId: rev?.id ?? null };
    if (!rev) return { result: { revision: null, noData: noData('no_calculation_revision', 'у области нет ревизии расчёта: цен и объёмов нет') }, ...base };
    const limit = a.limit ?? 20;
    if (a.view === 'totals') {
      const v = toRevision(rev) as Record<string, unknown>;
      return { result: { revision: revisionBrief(rev), totals: { source: v.source, kpTotal: v.kpTotal, aggregates: v.aggregates }, note: 'подробная экономика с проверкой итога — инструмент get_economics' }, ...base, details: { view: a.view } };
    }
    if (a.view === 'positions') {
      const cut = a.cursor ? a.cursor.lastIndexOf(':') : -1;
      if (a.cursor && cut <= 0) throw new McpToolError('invalid_request', 'курсор не относится к позициям расчёта');
      const after = a.cursor ? { positionNumber: a.cursor.slice(0, cut), id: a.cursor.slice(cut + 1) } : null;
      const rows = await revisionPositions(s.pool, rev.content_id, { after, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { result: { revision: revisionBrief(rev), positions: page.map((p) => toPosition(rev.id, p)), nextCursor: rows.length > limit && last ? `${last.position_number}:${last.external_position_id}` : null }, ...base, details: { view: a.view, items: page.length } };
    }
    const parts = a.cursor ? a.cursor.split(':') : [];
    if (a.cursor && (parts.length !== 3 || !Number.isFinite(Number(parts[1])))) throw new McpToolError('invalid_request', 'курсор не относится к строкам расчёта');
    const after = a.cursor ? { positionId: parts[0]!, order: Number(parts[1]), id: parts[2]! } : null;
    const rows = await revisionLines(s.pool, rev.content_id, { positionId: a.positionId?.toLowerCase() ?? null, after, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page.at(-1) as { external_position_id: string; order_key: number; external_item_id: string } | undefined;
    return { result: { revision: revisionBrief(rev), lines: page.map((l) => toLine(rev.id, l)), nextCursor: rows.length > limit && last ? `${last.external_position_id}:${last.order_key}:${last.external_item_id}` : null }, ...base, details: { view: a.view, items: page.length } };
  },
});

export const getEconomicsTool = defineTool({
  name: 'get_economics',
  title: 'Экономика',
  description: 'Экономика ревизии расчёта области: итоги себестоимости и коммерческой цены, составляющие, известная и неизвестная части, сверка с итогом источника. Считает сервер; неизвестное значение — null с причиной, а не ноль. Итог КП этим отчётом не является, пока правило итога не утверждено.',
  scope: 'read',
  input: z.object(caseArgs).strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const rev = await revisionOf(s.pool, s, c);
    const base = { tenderId: c.tenderId, entityType: 'calculation_revision', entityId: rev?.id ?? null };
    if (!rev) return { result: { economics: null, noData: noData('no_calculation_revision', 'у области нет ревизии расчёта: экономики нет') }, ...base };
    // Отчёт — производная запись от ревизии: при первом чтении портал считает и сохраняет его, MCP делает то же.
    const row = (await getRevisionEconomics(s.pool, rev.id)) ?? (await withTransaction(s.pool, (client) => ensureRevisionEconomics(client, rev.id, s.ctx.principal.userId)));
    const loaded = await loadEconomicsRevision(s.pool, rev.id);
    if (!row || !loaded) return { result: { economics: null, revision: revisionBrief(rev), noData: noData('economics_unavailable', 'экономика этой ревизии не рассчитана') }, ...base };
    return { result: { revision: revisionBrief(rev), economics: toRevisionEconomics(loaded, row) }, ...base };
  },
});

export const listFindingsTool = defineTool({
  name: 'list_findings',
  title: 'Замечания',
  description: `Замечания проверки этапа: вид, серьёзность, уверенность, статус, позиции расчёта и требования. Закрытое для пользователя замечание показано без текста. ${DATA_NOTICE}`,
  scope: 'read',
  input: z
    .object({ tenderId: uuid.optional(), stageId: uuid.optional(), status: z.enum(['open', 'in_progress', 'resolved', 'accepted_risk', 'rejected', 'stale']).optional(), severity: z.enum(['critical', 'major', 'minor']).optional(), ...paging })
    .strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const rows = await listFindings(s.pool, c.stageId, { status: a.status ?? null, kind: null, severity: a.severity ?? null, runId: null });
    const all = (await findingsList(s.pool, s.ctx, c.stageId, rows)).map((f) => {
      const v = f as Record<string, unknown>;
      // У закрытого замечания текст позиций расчёта тоже не отдаётся.
      return v.restricted ? { ...v, positions: [] } : v;
    });
    const page = paginate('list_findings', `${scopeKey(c)}:${a.status ?? ''}:${a.severity ?? ''}`, all, a.cursor, a.limit);
    return { result: { findings: page.items, nextCursor: page.nextCursor, total: all.length }, tenderId: c.tenderId, entityType: 'tender_stage', entityId: c.stageId, details: { total: all.length } };
  },
});

export const listQuestionsTool = defineTool({
  name: 'list_questions',
  title: 'Вопросы и ответы',
  description: `Вопросы заказчику этапа со статусом и ответом, и ветки вопросов–ответов тендера. Закрытый для пользователя вопрос показан без текста. ${DATA_NOTICE}`,
  scope: 'read',
  input: z.object({ tenderId: uuid.optional(), stageId: uuid.optional(), ...paging }).strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const vis = await stageVisibility(s.pool, s.ctx, c.stageId);
    const all = (await listCustomerQuestions(s.pool, c.stageId)).map((q) => toCustomerQuestion(q, vis.visible('question', q.id)));
    const page = paginate('list_questions', scopeKey(c), all, a.cursor, a.limit);
    const threads = (await listQaThreads(s.pool, c.tenderId)).map(toQaThread);
    return { result: { questions: page.items, nextCursor: page.nextCursor, total: all.length, qaThreads: threads.slice(0, 50) }, tenderId: c.tenderId, entityType: 'tender_stage', entityId: c.stageId };
  },
});

export const listDecisionsTool = defineTool({
  name: 'list_decisions',
  title: 'Решения',
  description: `Решения этапа: решения по требованиям действующего реестра (формулировка, обоснование, автор, основания) и решения руководителя по удержаниям комплектов. Решения по замечаниям — в самих замечаниях. Закрытое решение показано без текста. ${DATA_NOTICE}`,
  scope: 'read',
  input: z.object({ tenderId: uuid.optional(), stageId: uuid.optional(), ...paging }).strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const vis = await stageVisibility(s.pool, s.ctx, c.stageId);
    const registry = await activeRegistryOf(s.pool, c.stageId);
    const requirements = registry ? await listRequirements(s.pool, registry.id) : [];
    const decisions = await requirementDecisions(s.pool, requirements.map((r) => r.id));
    const links = await linksOf(s.pool, 'decision_id', decisions.map((d) => d.id));
    const codes = new Map(requirements.map((r) => [r.id, r.code]));
    const onRequirements = decisions.map((d) => ({ subject: 'requirement', requirementCode: codes.get(d.subject_id) ?? null, ...toDecision(d, links.get(d.id) ?? [], vis.readable, vis.visible('decision', d.id)) }));
    const holds = (await listHolds(s.pool, c.stageId)).filter((h) => h.status !== 'open');
    const holdVis = await holdsVisibility(s.pool, s.ctx, { id: c.stageId, tenderId: c.tenderId }, holds);
    const onHolds = holds.map((h) => ({ subject: 'hold', ...holdView(h, holdVis.event(h.ref_type, h.ref_id)) }));
    const all = [...onRequirements, ...onHolds];
    const page = paginate('list_decisions', scopeKey(c), all, a.cursor, a.limit);
    return { result: { decisions: page.items, nextCursor: page.nextCursor, total: all.length }, tenderId: c.tenderId, entityType: 'tender_stage', entityId: c.stageId };
  },
});

export const getReadinessTool = defineTool({
  name: 'get_readiness',
  title: 'Готовность',
  description: 'Готовность к согласованию, выпуску и отправке: последний комплект этапа (или комплект указанного выпуска), блокеры, удержания, выпуск, размещение и отправка. Только чтение: согласование, выпуск, отправка и решения по удержаниям выполняет человек в портале.',
  scope: 'read',
  input: z.object(caseArgs).strict(),
  run: async (s, a) => {
    const c = await resolveCase(s.pool, s, a);
    const candidate = c.releaseId ? await getCandidate(s.pool, (await getRelease(s.pool, c.releaseId))!.candidate_id) : ((await listCandidates(s.pool, c.stageId))[0] ?? null);
    const base = { tenderId: c.tenderId, entityType: 'release_candidate', entityId: candidate?.id ?? null };
    if (!candidate) return { result: { candidate: null, noData: noData('no_candidate', 'у этапа нет комплекта-кандидата') }, ...base };
    const shell = { ...candidateShell(candidate), current: await candidateIsCurrent(s.pool, candidate) };
    if (!(await candidateVisible(s.pool, s.ctx, candidate))) return { result: { candidate: { ...shell, restricted: true }, note: 'среди входов комплекта есть то, что вы не можете читать: блокеры и состав закрыты' }, ...base };
    let gate: Record<string, unknown> | null = null;
    if (candidate.status === 'ready_for_approval') {
      gate = { action: 'approve', ...gateView((await candidateGate(s.pool, s.ctx, candidate, { action: 'approve', actorAuthorized: true, actorSeesContent: true })).result) };
    } else if (candidate.status === 'approved') {
      gate = { action: 'release', ...gateView((await candidateGate(s.pool, s.ctx, candidate, { action: 'release', actorAuthorized: true, actorSeesContent: true, approval: { active: await activeApproval(s.pool, candidate.id), requestedId: null } })).result) };
    }
    const holds = await listHolds(s.pool, c.stageId, { candidateId: candidate.id });
    const holdVis = await holdsVisibility(s.pool, s.ctx, { id: c.stageId, tenderId: c.tenderId }, holds);
    const release = await releaseOfCandidate(s.pool, candidate.id);
    let released: Record<string, unknown> | null = null;
    if (release) {
      const readiness = await releaseSendReadiness(s.pool, release);
      const deliveries = (await listDeliveries(s.pool, release.id)).filter((d) => d.status !== 'superseded');
      const send = (await sendSummaries(s.pool, [release.id])).get(release.id);
      released = {
        releaseId: release.id,
        mode: release.mode,
        releasedAt: iso(release.released_at),
        sendReadiness: { state: readiness.state, sendable: readiness.sendable, testRelease: readiness.testRelease, events: readiness.events },
        deliveries: { total: deliveries.length, delivered: deliveries.filter((d) => d.status === 'delivered').length },
        // Запись об отправке фиксирует отправку; получение заказчиком ею не подтверждается (I08).
        send: send ? { events: send.events, counted: send.counted, disputed: send.disputed, incidents: send.incidents, provesReceipt: false } : { events: 0, counted: 0, disputed: 0, incidents: 0, provesReceipt: false },
      };
    }
    return {
      result: {
        candidate: { ...shell, restricted: false },
        gate,
        holds: { open: holds.filter((h) => h.status === 'open').length, total: holds.length, items: holds.map((h) => holdView(h, holdVis.event(h.ref_type, h.ref_id))) },
        release: released,
      },
      ...base,
    };
  },
});
