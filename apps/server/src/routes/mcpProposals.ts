// Этап 16 (проект §6): предложения чат-клиента в портале. Предложение ничего не меняет, пока его не принял человек:
// принятие — обычная команда человека с If-Match, под его именем и той возможностью, что нужна для такой записи.
// Текст предложения закрыт вместе с его цитатами; нельзя решать по тому, чего не можешь прочитать (R08-02, S15a-01).
// Запись, созданная принятием, несёт все цитаты предложения: замечание и причина — основаниями, вопрос — ссылкой на
// предложение (R16-01; вторая линия — охранник mcp_proposal, миграция 0041).
import { AcceptMcpProposalRequest, McpProposalsQuery, RejectMcpProposalRequest } from '@kontur/contracts';
import { formatEtag, type IEvidenceDraft, type TenderCapability } from '@kontur/core';
import {
  appendReleaseReason,
  createCustomerQuestion,
  createHumanFinding,
  decideMcpProposal,
  getFinding,
  getMcpProposal,
  getRelease,
  getReleaseComparison,
  getReleaseComparisonItem,
  listMcpProposals,
  mcpProposalFragments,
  readableFragments,
  releaseReasonVersion,
  type IAccessContext,
  type IMcpProposalRow,
  type McpProposalKind,
  type Pool,
  type PoolClient,
  type Queryable,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { itemViews } from '../releaseComparisonViews.ts';
import { loadStageWith } from './requirementScope.ts';
import { conflict, requireFindingVisible, stageVersion } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';

// Возможность, с которой человек создаёт такую запись сам (вторая линия — охранник mcp_proposal, миграция 0040).
const DECIDE_CAP: Record<McpProposalKind, TenderCapability> = { finding: 'finding.write', question: 'requirement.create', condition_text: 'application.fill', change_reason: 'change_reason.confirm' };

const view = (ctx: IAccessContext, p: IMcpProposalRow, fragmentIds: readonly string[], visible: boolean) => ({
  id: p.id,
  stageId: p.stage_id,
  kind: p.kind,
  status: p.status,
  restricted: !visible,
  title: visible ? p.title : null,
  body: visible ? p.body : null,
  // Коды без свободного текста: подсказка серьёзности, ключ поля, вид причины, вывод сравнения.
  detail: visible ? p.detail : {},
  citedFragmentIds: visible ? [...fragmentIds] : [],
  citations: fragmentIds.length,
  proposedVia: 'chat',
  proposedOnBehalfOf: { id: p.on_behalf_of_user_id, name: p.on_behalf_of_name },
  createdAt: p.created_at.toISOString(),
  decidedBy: p.decided_by ? { id: p.decided_by, name: p.decided_by_name } : null,
  decidedAt: p.decided_at ? p.decided_at.toISOString() : null,
  decisionReason: visible ? p.decision_reason : null,
  result: p.result_id ? { type: p.result_type, id: p.result_id } : null,
  etag: formatEtag(p.id, p.row_version),
  can: { decide: p.status === 'open' && visible && hasTenderCap(ctx, p.tender_id, DECIDE_CAP[p.kind]) },
});

const viewOf = async (db: Queryable, ctx: IAccessContext, p: IMcpProposalRow) => {
  const fragmentIds = (await mcpProposalFragments(db, [p.id])).get(p.id) ?? [];
  const readable = await readableFragments(db, ctx, fragmentIds);
  return view(ctx, p, fragmentIds, fragmentIds.every((f) => readable.has(f)));
};

export const mcpProposalsRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/stages/:id/mcp-proposals',
    query(pool, 'mcp.proposal.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'tender.read');
      const q = parseBody(McpProposalsQuery, req.query);
      const rows = await listMcpProposals(pool, stage.id, q.status);
      const fragments = await mcpProposalFragments(pool, rows.map((r) => r.id));
      const readable = await readableFragments(pool, ctx, [...fragments.values()].flat());
      res.json({
        items: rows.map((p) => {
          const ids = fragments.get(p.id) ?? [];
          return view(ctx, p, ids, ids.every((f) => readable.has(f)));
        }),
        open: rows.filter((r) => r.status === 'open').length,
      });
    }),
  );

  const load = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IMcpProposalRow> => {
    const p = await getMcpProposal(db, id, lock);
    if (!p || !hasTenderCap(ctx, p.tender_id, 'tender.read')) throw notFound({ entityType: 'mcp_proposal', entityId: id });
    return p;
  };
  const authorize = async (db: Queryable, ctx: IAccessContext, id: string): Promise<void> => {
    const p = await load(db, ctx, id);
    if (!hasTenderCap(ctx, p.tender_id, DECIDE_CAP[p.kind])) throw forbidden(DECIDE_CAP[p.kind], { tenderId: p.tender_id, entityType: 'mcp_proposal', entityId: p.id });
  };
  // Открытое предложение нужной версии, все цитаты которого решающий читает сам.
  const decidable = async (client: PoolClient, ctx: IAccessContext, req: Parameters<typeof requireIfMatch>[0]): Promise<{ p: IMcpProposalRow; fragmentIds: string[] }> => {
    const p = await load(client, ctx, uuidParam(req, 'id', 'mcp_proposal'), true);
    const t = { tenderId: p.tender_id, entityType: 'mcp_proposal', entityId: p.id };
    if (!hasTenderCap(ctx, p.tender_id, DECIDE_CAP[p.kind])) throw forbidden(DECIDE_CAP[p.kind], t);
    if (requireIfMatch(req, p.id) !== p.row_version) throw versionConflict({ id: p.id, status: p.status, etag: formatEtag(p.id, p.row_version) });
    if (p.status !== 'open') throw conflict('по предложению уже принято решение', 'proposal_not_open', t, { status: p.status });
    const fragmentIds = (await mcpProposalFragments(client, [p.id])).get(p.id) ?? [];
    const readable = await readableFragments(client, ctx, fragmentIds);
    if (fragmentIds.some((f) => !readable.has(f))) throw conflict('среди цитат предложения есть то, что вы не можете читать', 'restricted_fragments', t);
    return { p, fragmentIds };
  };

  // Причина вывода сравнения: те же проверки, что у записи причины человеком, статус — только «гипотеза».
  const acceptReason = async (client: PoolClient, ctx: IAccessContext, p: IMcpProposalRow, fragmentIds: string[]): Promise<string> => {
    const t = { tenderId: p.tender_id, entityType: 'mcp_proposal', entityId: p.id };
    const comparison = await getReleaseComparison(client, String(p.detail.comparisonId ?? ''));
    const item = await getReleaseComparisonItem(client, String(p.detail.itemId ?? ''));
    if (!comparison || !item || item.comparison_id !== comparison.id || comparison.tender_id !== p.tender_id || comparison.status !== 'ready') {
      throw conflict('сравнение или его вывод больше недоступны', 'comparison_not_ready', t);
    }
    const [left, right] = [(await getRelease(client, comparison.left_release_id))!, (await getRelease(client, comparison.right_release_id))!];
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['release_comparison_reason', item.id]);
    const [itemView] = await itemViews(client, ctx, { tenderId: comparison.tender_id, leftStageId: left.stage_id, rightStageId: right.stage_id }, [item]);
    if (!itemView || itemView.closed) throw conflict('вывод сравнения закрыт для вас', 'restricted_item', t);
    const inScope = (await client.query<{ id: string }>('SELECT u.id FROM unnest($1::uuid[]) AS u(id) WHERE fragment_in_stage(u.id, $2) OR fragment_in_stage(u.id, $3)', [fragmentIds, left.stage_id, right.stage_id])).rows;
    if (inScope.length !== fragmentIds.length) throw conflict('цитата предложения не входит в снимки этапов сравниваемых выпусков', 'basis_out_of_scope', t);
    const kind = String(p.detail.reasonKind ?? '');
    if (!['document', 'answer', 'supplier', 'internal_decision'].includes(kind)) throw conflict('у предложения неизвестный вид причины', 'invalid_proposal', t);
    return appendReleaseReason(client, {
      tenderId: comparison.tender_id,
      comparisonId: comparison.id,
      itemId: item.id,
      version: (await releaseReasonVersion(client, item.id)) + 1,
      reasonKind: kind as 'document' | 'answer' | 'supplier' | 'internal_decision',
      reasonStatus: 'hypothesis',
      rationale: p.body,
      fragmentIds,
      decisionIds: [],
      userId: ctx.principal.userId,
    });
  };

  router.post(
    '/mcp-proposals/:id/accept',
    command(pool, {
      action: 'mcp.proposal.accept',
      entityType: 'mcp_proposal',
      idempotent: true,
      authorize: async (client, ctx, req) => authorize(client, ctx, uuidParam(req, 'id', 'mcp_proposal')),
      run: async (client, ctx, req) => {
        const body = parseBody(AcceptMcpProposalRequest, req.body);
        const { p, fragmentIds } = await decidable(client, ctx, req);
        const t = { tenderId: p.tender_id, entityType: 'mcp_proposal', entityId: p.id };
        let result: { type: 'finding' | 'customer_question' | 'release_comparison_reason'; id: string } | null = null;
        if (p.kind === 'finding') {
          if (!body.severity || !body.confidence) throw new HttpError(400, 'VALIDATION_FAILED', 'для замечания укажите серьёзность и уверенность', {}, t);
          if (fragmentIds.length === 0) throw conflict('у предложения замечания нет цитат', 'invalid_proposal', t);
          const evidence: IEvidenceDraft[] = fragmentIds.map((fragmentId) => ({ side: 'context', objectType: 'fragment', fragmentId }));
          // Автор замечания — человек, принявший предложение; модель автором не становится (I12).
          const id = await createHumanFinding(client, {
            tenderId: p.tender_id,
            stageId: p.stage_id,
            userId: ctx.principal.userId,
            title: (p.title ?? p.body).slice(0, 500),
            detail: p.body,
            severity: body.severity,
            confidence: body.confidence,
            action: null,
            evidence,
            inputVersion: await stageVersion(client, p.stage_id),
          });
          await requireFindingVisible(client, ctx, (await getFinding(client, id))!);
          result = { type: 'finding', id };
        } else if (p.kind === 'question') {
          // Вопрос наследует закрытость цитат предложения через ссылку на него (R16-01): принятие права на источник не снимает.
          const id = await createCustomerQuestion(client, {
            tenderId: p.tender_id,
            stageId: p.stage_id,
            requirementId: null,
            text: p.body,
            responsibleUserId: null,
            userId: ctx.principal.userId,
            sourceProposalId: p.id,
          });
          result = { type: 'customer_question', id };
        } else if (p.kind === 'change_reason') {
          result = { type: 'release_comparison_reason', id: await acceptReason(client, ctx, p, fragmentIds) };
        }
        // Текст условия записи не создаёт: человек переносит его в поле приложения сам.
        await decideMcpProposal(client, p.id, { status: 'accepted', userId: ctx.principal.userId, reason: null, resultType: result?.type ?? null, resultId: result?.id ?? null });
        const fresh = (await getMcpProposal(client, p.id))!;
        return {
          status: 200,
          body: await viewOf(client, ctx, fresh),
          etag: formatEtag(fresh.id, fresh.row_version),
          // Текст предложения в журнал не пишется: журнал читают шире, чем источники.
          audit: [{ action: 'mcp.proposal.accept', entityType: 'mcp_proposal', entityId: p.id, tenderId: p.tender_id, details: { kind: p.kind, stageId: p.stage_id, resultType: result?.type ?? null, resultId: result?.id ?? null, proposedOnBehalfOf: p.on_behalf_of_user_id } }],
        };
      },
    }),
  );

  router.post(
    '/mcp-proposals/:id/reject',
    command(pool, {
      action: 'mcp.proposal.reject',
      entityType: 'mcp_proposal',
      idempotent: true,
      authorize: async (client, ctx, req) => authorize(client, ctx, uuidParam(req, 'id', 'mcp_proposal')),
      run: async (client, ctx, req) => {
        const body = parseBody(RejectMcpProposalRequest, req.body);
        const { p } = await decidable(client, ctx, req);
        await decideMcpProposal(client, p.id, { status: 'rejected', userId: ctx.principal.userId, reason: body.reason });
        const fresh = (await getMcpProposal(client, p.id))!;
        return {
          status: 200,
          body: await viewOf(client, ctx, fresh),
          etag: formatEtag(fresh.id, fresh.row_version),
          audit: [{ action: 'mcp.proposal.reject', entityType: 'mcp_proposal', entityId: p.id, tenderId: p.tender_id, details: { kind: p.kind, stageId: p.stage_id, proposedOnBehalfOf: p.on_behalf_of_user_id } }],
        };
      },
    }),
  );

  return router;
};
