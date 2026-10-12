// Предложения чат-клиента (проект §5.2, §6): замечание, вопрос заказчику, текст условия, причина изменения. Предложение
// ничего не меняет и ждёт решения человека в портале; повтор с тем же `requestId` возвращает ту же запись (A37).
// Цитаты должны существовать, читаться пользователем и относиться к тендеру области — иначе `invalid_citation` без записи.
import { createMcpProposal, getRelease, getReleaseComparison, getReleaseComparisonItem, getScopedFragment, readableFragments, withTransaction, type INewMcpProposal, type PoolClient } from '@kontur/db';
import { z } from 'zod';
import { itemViews } from '../../releaseComparisonViews.ts';
import { hasTenderCap } from '../../routes/scope.ts';
import { resolveCase } from '../scope.ts';
import { McpToolError, outOfScope, type IMcpSession } from '../session.ts';
import { defineTool, type IToolOutcome } from '../tools.ts';

const uuid = z.string().uuid();
const requestId = z.string().trim().min(8).max(200);
const citations = (min: number) => z.array(uuid).min(min).max(20);

const NOTE = 'Предложение сохранено как открытое. Оно ничего не меняет в тендере, пока его не примет человек в портале (этап → «Предложения из чата»).';

// Цитаты: каждая существует, читается пользователем сейчас и относится к тендеру области (или входит в снимок этапа).
const requireCitations = async (db: PoolClient, s: IMcpSession, tenderId: string, stageId: string, fragmentIds: readonly string[]): Promise<string[]> => {
  const ids = [...new Set(fragmentIds.map((f) => f.toLowerCase()))];
  if (ids.length === 0) return ids;
  const readable = await readableFragments(db, s.ctx, ids);
  const inStage = new Set((await db.query<{ id: string }>('SELECT u.id FROM unnest($1::uuid[]) AS u(id) WHERE fragment_in_stage(u.id, $2)', [ids, stageId])).rows.map((r) => r.id));
  for (const id of ids) {
    const f = readable.has(id) ? await getScopedFragment(db, s.ctx, id) : null;
    if (!f || (f.tender_id !== tenderId && !inStage.has(id))) {
      throw new McpToolError('invalid_citation', 'цитата не существует, недоступна или не относится к области: предложение не создано', { fragmentId: id });
    }
  }
  return ids;
};

const requirePropose = (s: IMcpSession, tenderId: string): void => {
  // Возможность тендера проверяется при каждом вызове; область `propose` токена — в обёртке инструмента.
  if (!hasTenderCap(s.ctx, tenderId, 'mcp.propose')) throw outOfScope();
};

const save = async (db: PoolClient, s: IMcpSession, p: Omit<INewMcpProposal, 'tokenId' | 'userId'>): Promise<IToolOutcome> => {
  const made = await createMcpProposal(db, { ...p, tokenId: s.token.id, userId: s.ctx.principal.userId });
  if (made.state === 'request_reused') throw new McpToolError('invalid_request', 'этот requestId уже использован для другого предложения: для нового предложения нужен новый requestId');
  const r = made.row;
  return {
    result: { proposal: { id: r.id, kind: r.kind, status: r.status, createdAt: r.created_at.toISOString(), repeat: made.state === 'repeat' }, note: NOTE },
    tenderId: r.tender_id,
    entityType: 'mcp_proposal',
    entityId: r.id,
    details: { kind: r.kind, repeat: made.state === 'repeat', citations: p.fragmentIds.length, stageId: r.stage_id },
  };
};

const stageScope = { tenderId: uuid.optional(), stageId: uuid.optional() };

export const proposeFindingTool = defineTool({
  name: 'propose_finding',
  title: 'Предложить замечание',
  description: 'Сохраняет предложение замечания по этапу с цитатами-основаниями. Замечанием оно станет, только если его примет человек в портале. requestId — уникальная строка запроса: повтор с тем же requestId возвращает ту же запись.',
  scope: 'propose',
  input: z
    .object({ ...stageScope, title: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(4000), citedFragmentIds: citations(1), severityHint: z.enum(['critical', 'major', 'minor', 'info']).optional(), requestId })
    .strict(),
  run: (s, a) =>
    withTransaction(s.pool, async (db) => {
      const c = await resolveCase(db, s, { tenderId: a.tenderId, stageId: a.stageId });
      requirePropose(s, c.tenderId);
      const fragmentIds = await requireCitations(db, s, c.tenderId, c.stageId, a.citedFragmentIds);
      return save(db, s, { tenderId: c.tenderId, stageId: c.stageId, kind: 'finding', title: a.title, body: a.body, detail: a.severityHint ? { severityHint: a.severityHint } : {}, fragmentIds, requestId: a.requestId });
    }),
});

export const proposeQuestionTool = defineTool({
  name: 'propose_question',
  title: 'Предложить вопрос заказчику',
  description: 'Сохраняет предложение вопроса заказчику по этапу. Черновиком вопроса оно станет, только если его примет человек в портале. Повтор с тем же requestId возвращает ту же запись.',
  scope: 'propose',
  input: z.object({ ...stageScope, text: z.string().trim().min(1).max(4000), citedFragmentIds: citations(0).optional(), requestId }).strict(),
  run: (s, a) =>
    withTransaction(s.pool, async (db) => {
      const c = await resolveCase(db, s, { tenderId: a.tenderId, stageId: a.stageId });
      requirePropose(s, c.tenderId);
      const fragmentIds = await requireCitations(db, s, c.tenderId, c.stageId, a.citedFragmentIds ?? []);
      return save(db, s, { tenderId: c.tenderId, stageId: c.stageId, kind: 'question', title: null, body: a.text, detail: {}, fragmentIds, requestId: a.requestId });
    }),
});

export const proposeConditionTextTool = defineTool({
  name: 'propose_condition_text',
  title: 'Предложить текст условия',
  description: 'Сохраняет предложение формулировки условия для приложения (fieldKey — ключ поля, если известен). В приложение текст попадёт, только если его вставит человек в портале. Повтор с тем же requestId возвращает ту же запись.',
  scope: 'propose',
  input: z
    .object({ ...stageScope, fieldKey: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).optional(), text: z.string().trim().min(1).max(4000), citedFragmentIds: citations(0).optional(), requestId })
    .strict(),
  run: (s, a) =>
    withTransaction(s.pool, async (db) => {
      const c = await resolveCase(db, s, { tenderId: a.tenderId, stageId: a.stageId });
      requirePropose(s, c.tenderId);
      const fragmentIds = await requireCitations(db, s, c.tenderId, c.stageId, a.citedFragmentIds ?? []);
      return save(db, s, { tenderId: c.tenderId, stageId: c.stageId, kind: 'condition_text', title: null, body: a.text, detail: a.fieldKey ? { fieldKey: a.fieldKey } : {}, fragmentIds, requestId: a.requestId });
    }),
});

export const proposeChangeReasonTool = defineTool({
  name: 'propose_change_reason',
  title: 'Предложить причину изменения',
  description: 'Сохраняет предложение причины для вывода сравнения двух выпусков (comparisonId и itemId — из compare_releases). Причиной вывода оно станет, только если её запишет человек в портале, и только со статусом «гипотеза». Повтор с тем же requestId возвращает ту же запись.',
  scope: 'propose',
  input: z
    .object({ comparisonId: uuid, itemId: uuid, reasonKind: z.enum(['document', 'answer', 'supplier', 'internal_decision']), text: z.string().trim().min(1).max(4000), citedFragmentIds: citations(1), requestId })
    .strict(),
  run: (s, a) =>
    withTransaction(s.pool, async (db) => {
      const comparison = await getReleaseComparison(db, a.comparisonId.toLowerCase());
      const item = await getReleaseComparisonItem(db, a.itemId.toLowerCase());
      if (!comparison || !item || item.comparison_id !== comparison.id || comparison.status !== 'ready') throw outOfScope();
      requirePropose(s, comparison.tender_id);
      const [left, right] = [await getRelease(db, comparison.left_release_id), await getRelease(db, comparison.right_release_id)];
      if (!left || !right) throw outOfScope();
      // Вывод должен читаться пользователем: закрытому выводу причину не предлагают (как R08-02).
      const [view] = await itemViews(db, s.ctx, { tenderId: comparison.tender_id, leftStageId: left.stage_id, rightStageId: right.stage_id }, [item]);
      if (!view || view.closed) throw outOfScope();
      const ids = [...new Set(a.citedFragmentIds.map((f) => f.toLowerCase()))];
      const readable = await readableFragments(db, s.ctx, ids);
      const inStages = new Set((await db.query<{ id: string }>('SELECT u.id FROM unnest($1::uuid[]) AS u(id) WHERE fragment_in_stage(u.id, $2) OR fragment_in_stage(u.id, $3)', [ids, left.stage_id, right.stage_id])).rows.map((r) => r.id));
      const bad = ids.find((id) => !readable.has(id) || !inStages.has(id));
      if (bad) throw new McpToolError('invalid_citation', 'цитата не существует, недоступна или не входит в снимки этапов сравниваемых выпусков: предложение не создано', { fragmentId: bad });
      return save(db, s, { tenderId: comparison.tender_id, stageId: right.stage_id, kind: 'change_reason', title: null, body: a.text, detail: { comparisonId: comparison.id, itemId: item.id, reasonKind: a.reasonKind }, fragmentIds: ids, requestId: a.requestId });
    }),
});
