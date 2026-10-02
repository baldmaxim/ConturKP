// Диалоги ответного ядра (этап 08a, D-019, D-027; portal-api §2.12, §3.4). Контекст диалога — контекст поиска 05:
// права и область проверяются тем же кодом (AD-08a-4). Вопрос — одной транзакцией: сообщение, прогон поиска, прогон
// ответа и задание gpu. Стриминга нет: интерфейс опрашивает GET /answer-runs/{id}. Диалог видит только автор;
// чужой — 404 (существование не раскрывается), в том числе администратору.
import type { IAppConfig } from '@kontur/config';
import { AskQuestionRequest, CreateDialogRequest } from '@kontur/contracts';
import { boundedHistory, DRAFT_PROMPT_VERSION, draftSystemPrompt, planQuestion, PLANNER_VERSION, retrievalQuery, sha256Hex } from '@kontur/core';
import {
  contractCaps,
  createDialog,
  createQuestion,
  getAnswerRun,
  getDialog,
  listDialogs,
  pendingRunOf,
  previousTurns,
  type IAccessContext,
  type IDialogRow,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { answerRunView, dialogView } from '../answerMappers.ts';
import { hasTenderCap } from './scope.ts';
import { resolveSearchContext, startScopedSearch } from './search.ts';

// Поиск вопроса берёт больше попаданий, чем войдёт в пакет: правило пакета убирает дубли и недоступное.
const QUESTION_SEARCH_LIMIT = 20;

const contextOf = (d: IDialogRow) =>
  d.context_kind === 'contract'
    ? { kind: 'contract' as const, contractId: d.contract_id! }
    : { kind: 'tender' as const, tenderId: d.tender_id!, mode: d.mode as 'working' | 'review', stageId: d.stage_id!, ...(d.evidence_scope_id ? { evidenceScopeId: d.evidence_scope_id } : {}) };

// Свой диалог с действующим правом на контекст (участник тендера или contract.read); иначе — как несуществующий.
const ownDialog = async (db: Pool | PoolClient, ctx: IAccessContext, id: string): Promise<{ dialog: IDialogRow }> => {
  const dialog = await getDialog(db, id);
  if (!dialog || dialog.created_by !== ctx.principal.userId) throw notFound({ entityType: 'dialog', entityId: id });
  const readable = dialog.context_kind === 'tender' ? hasTenderCap(ctx, dialog.tender_id!, 'tender.read') : contractCaps(ctx, dialog.contract_id!).includes('contract.read');
  if (!readable) throw notFound({ entityType: 'dialog', entityId: id });
  return { dialog };
};

export const dialogsRouter = (pool: Pool, config: IAppConfig, clock: () => Date): Router => {
  const router = Router();

  router.post(
    '/dialogs',
    command(pool, {
      action: 'dialog.create',
      entityType: 'dialog',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await resolveSearchContext(client, ctx, parseBody(CreateDialogRequest, req.body).context)),
      run: async (client, ctx, req) => {
        const body = parseBody(CreateDialogRequest, req.body);
        const t = await resolveSearchContext(client, ctx, body.context);
        const id = await createDialog(client, {
          contextKind: t.owner.kind,
          tenderId: t.owner.kind === 'tender' ? t.owner.tenderId : null,
          contractId: t.owner.kind === 'contract' ? t.owner.contractId : null,
          stageId: t.stageId,
          mode: t.owner.kind === 'contract' ? 'contract' : t.mode,
          evidenceScopeId: t.evidenceScopeId,
          title: body.title ?? 'Вопросы к документам',
          userId: ctx.principal.userId,
        });
        const tenderId = t.owner.kind === 'tender' ? t.owner.tenderId : null;
        return {
          status: 201,
          body: await dialogView(client, ctx, (await getDialog(client, id))!),
          audit: [{ action: 'dialog.create', entityType: 'dialog', entityId: id, tenderId, details: { context: t.owner.kind, mode: t.mode } }],
        };
      },
    }),
  );

  router.get(
    '/dialogs',
    query(pool, 'dialog.list', 'dialog', async (ctx, req, res) => {
      const str = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f-]{36}$/u.test(v) ? v : null);
      const rows = await listDialogs(pool, ctx.principal.userId, { tenderId: str(req.query.tenderId), stageId: str(req.query.stageId), contractId: str(req.query.contractId) });
      res.json({ items: rows.map((d) => ({ id: d.id, title: d.title, contextKind: d.context_kind, tenderId: d.tender_id, contractId: d.contract_id, stageId: d.stage_id, mode: d.mode, createdAt: d.created_at.toISOString() })) });
    }),
  );

  router.get(
    '/dialogs/:id',
    query(pool, 'dialog.read', 'dialog', async (ctx, req, res) => {
      const { dialog } = await ownDialog(pool, ctx, uuidParam(req, 'id', 'dialog'));
      res.json(await dialogView(pool, ctx, dialog));
    }),
  );

  router.post(
    '/dialogs/:id/messages',
    command(pool, {
      action: 'answer.request',
      entityType: 'dialog',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const { dialog } = await ownDialog(client, ctx, uuidParam(req, 'id', 'dialog'));
        await resolveSearchContext(client, ctx, contextOf(dialog));
      },
      run: async (client, ctx, req) => {
        const body = parseBody(AskQuestionRequest, req.body);
        const { dialog } = await ownDialog(client, ctx, uuidParam(req, 'id', 'dialog'));
        const tenderId = dialog.tender_id;
        // Права на контекст — на момент вопроса (а не создания диалога).
        const t = await resolveSearchContext(client, ctx, contextOf(dialog));
        const pending = await pendingRunOf(client, dialog.id);
        if (pending) {
          throw new HttpError(409, 'STATE_CONFLICT', 'предыдущий вопрос ещё обрабатывается — дождитесь ответа', { current: { reason: 'answer_pending', runId: pending.id } }, { tenderId, entityType: 'dialog', entityId: dialog.id });
        }
        const turns = await previousTurns(client, dialog.id, 2_000_000_000);
        const history = boundedHistory(turns);
        const plan = planQuestion(body.text, history);
        const search = await startScopedSearch(client, ctx, t, retrievalQuery(body.text, history).slice(0, 500), QUESTION_SEARCH_LIMIT, config, clock);
        const asked = await createQuestion(client, {
          dialogId: dialog.id,
          tenderId,
          text: body.text,
          userId: ctx.principal.userId,
          searchRunId: search.runId,
          plan: plan as unknown as Record<string, unknown>,
          plannerVersion: PLANNER_VERSION,
          promptVersion: DRAFT_PROMPT_VERSION,
          promptSha256: sha256Hex(draftSystemPrompt(plan)),
          verifierMode: config.answer.verifierMode,
        });
        return {
          status: 201,
          body: { runId: asked.runId, messageId: asked.messageId, dialog: await dialogView(client, ctx, dialog) },
          audit: [
            {
              action: 'answer.request',
              entityType: 'answer_run',
              entityId: asked.runId,
              tenderId,
              details: { dialogId: dialog.id, searchRunId: search.runId, intent: plan.intent, followUp: plan.followUp, scopeHash: search.scopeHash },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/answer-runs/:id',
    query(pool, 'answer.read', 'answer_run', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'answer_run');
      const run = await getAnswerRun(pool, id);
      if (!run || run.requested_by !== ctx.principal.userId) throw notFound({ entityType: 'answer_run', entityId: id });
      await ownDialog(pool, ctx, run.dialog_id);
      res.json(await answerRunView(pool, ctx, run));
    }),
  );

  return router;
};
