// Допущения, вопросы заказчику и пометки этапа (OD-08-6, вариант A): отдельные типы, не требования и не факты.
// Допущение — ревизии со статусом (подтверждение и отклонение — requirement.confirm); вопрос — статусы и ответ
// из ревизии Q&A или пояснение, отправки нет (C04); пометка — заметка вне полноты, фактов и входа модели.
// Текст допущения и вопроса, связанного с требованием, — по замыканию закрытости (R08-02, requirementTaint.ts).
import { CreateAssumptionRequest, CreateCustomerQuestionRequest, CreateStageNoteRequest, ReviseAssumptionRequest, UpdateCustomerQuestionRequest } from '@kontur/contracts';
import { formatEtag } from '@kontur/core';
import {
  assumptionRevisions,
  createAssumption,
  createCustomerQuestion,
  createStageNote,
  getAssumption,
  getCustomerQuestion,
  linksOf,
  listAssumptions,
  listCustomerQuestions,
  listStageNotes,
  readableFragments,
  reviseAssumption,
  stageVisibility,
  updateCustomerQuestion,
  type IAccessContext,
  type IStageVisibility,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { HttpError } from '../http/errors.ts';
import { toAssumption, toCustomerQuestion, toStageNote } from '../requirementMappers.ts';
import { loadStageWith, requireInScope, requireVisible } from './requirementScope.ts';

const assumptionCard = async (db: Pool | PoolClient, ctx: IAccessContext, id: string) => {
  const a = (await getAssumption(db, id))!;
  const links = (await linksOf(db, 'assumption_revision_id', [a.current_revision_id])).get(a.current_revision_id) ?? [];
  const vis = await stageVisibility(db, ctx, a.stage_id);
  const body = toAssumption(a, links, vis.readable, vis.visible('assumption', id));
  return { row: a, body: { ...body, revisions: body.visible ? await assumptionRevisions(db, id) : [] } };
};

const questionView = async (db: Pool | PoolClient, ctx: IAccessContext, id: string) => {
  const q = (await getCustomerQuestion(db, id))!;
  return { row: q, body: toCustomerQuestion(q, (await stageVisibility(db, ctx, q.stage_id)).visible('question', id)) };
};

// Связь с требованием — только с видимым (R08-02): иначе вопрос или допущение унаследует закрытый текст.
const requireRequirementVisible = (vis: IStageVisibility, requirementId: string | null | undefined, target: { tenderId: string; entityType: string; entityId: string }) => {
  if (requirementId) requireVisible(vis, 'requirement', requirementId, target);
};

const requireReadableEvidence = async (client: PoolClient, ctx: IAccessContext, ids: string[], target: { tenderId: string; entityType: string; entityId: string }) => {
  const readable = await readableFragments(client, ctx, ids);
  if (ids.some((f) => !readable.has(f))) {
    throw new HttpError(409, 'STATE_CONFLICT', 'среди оснований есть фрагменты, которые вы не можете читать', { current: { reason: 'restricted_fragments' } }, target);
  }
};

export const stageRecordsRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/stages/:id/assumptions',
    query(pool, 'assumption.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.read');
      const rows = await listAssumptions(pool, stage.id);
      const links = await linksOf(pool, 'assumption_revision_id', rows.map((r) => r.current_revision_id));
      const vis = await stageVisibility(pool, ctx, stage.id);
      res.json({ items: rows.map((r) => toAssumption(r, links.get(r.current_revision_id) ?? [], vis.readable, vis.visible('assumption', r.id))) });
    }),
  );

  router.get(
    '/assumptions/:id',
    query(pool, 'assumption.read', 'assumption', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'assumption');
      requireInScope(ctx, await getAssumption(pool, id), 'assumption', id, 'requirement.read');
      const card = await assumptionCard(pool, ctx, id);
      res.set('ETag', formatEtag(id, card.row.row_version)).json(card.body);
    }),
  );

  router.post(
    '/stages/:id/assumptions',
    command(pool, {
      action: 'assumption.create',
      entityType: 'assumption',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.create')),
      run: async (client, ctx, req) => {
        const body = parseBody(CreateAssumptionRequest, req.body);
        const stage = await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.create');
        const target = { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id };
        await requireReadableEvidence(client, ctx, body.evidence.map((e) => e.fragmentId), target);
        requireRequirementVisible(await stageVisibility(client, ctx, stage.id), body.requirementId, target);
        const id = await createAssumption(client, {
          tenderId: stage.tender_id,
          stageId: stage.id,
          requirementId: body.requirementId ?? null,
          statement: body.statement,
          evidence: body.evidence.length > 0 ? body.evidence : null,
          userId: ctx.principal.userId,
        });
        const card = await assumptionCard(client, ctx, id);
        return {
          status: 201,
          body: card.body,
          etag: formatEtag(id, card.row.row_version),
          audit: [{ action: 'assumption.create', entityType: 'assumption', entityId: id, tenderId: stage.tender_id, details: { requirementId: body.requirementId ?? null } }],
        };
      },
    }),
  );

  router.post(
    '/assumptions/:id/revisions',
    command(pool, {
      action: 'assumption.revise',
      entityType: 'assumption',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'assumption');
        requireInScope(ctx, await getAssumption(client, id), 'assumption', id, 'requirement.create');
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'assumption');
        const rowVersion = requireIfMatch(req, id);
        const body = parseBody(ReviseAssumptionRequest, req.body);
        const a = (await getAssumption(client, id))!;
        const cap = body.status === 'confirmed' || body.status === 'rejected' || (body.status === 'superseded' && a.status === 'confirmed') ? 'requirement.confirm' : 'requirement.create';
        requireInScope(ctx, a, 'assumption', id, cap);
        const target = { tenderId: a.tender_id, entityType: 'assumption', entityId: id };
        const vis = await stageVisibility(client, ctx, a.stage_id);
        requireVisible(vis, 'assumption', id, target);
        if (body.supersededByAssumptionId) requireVisible(vis, 'assumption', body.supersededByAssumptionId, target);
        const rev = await reviseAssumption(client, a, rowVersion, {
          statement: body.statement ?? a.statement,
          status: body.status,
          reason: body.reason ?? null,
          supersededBy: body.supersededByAssumptionId ?? null,
          userId: ctx.principal.userId,
        });
        if (!rev) throw versionConflict({ rowVersion: a.row_version });
        const card = await assumptionCard(client, ctx, id);
        return {
          status: 200,
          body: card.body,
          etag: formatEtag(id, card.row.row_version),
          audit: [{ action: 'assumption.revise', entityType: 'assumption', entityId: id, tenderId: a.tender_id, details: { from: a.status, to: body.status, revisionId: rev } }],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/customer-questions',
    query(pool, 'customer_question.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.read');
      const vis = await stageVisibility(pool, ctx, stage.id);
      res.json({ items: (await listCustomerQuestions(pool, stage.id)).map((q) => toCustomerQuestion(q, vis.visible('question', q.id))) });
    }),
  );

  router.post(
    '/stages/:id/customer-questions',
    command(pool, {
      action: 'customer_question.create',
      entityType: 'customer_question',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.create')),
      run: async (client, ctx, req) => {
        const body = parseBody(CreateCustomerQuestionRequest, req.body);
        const stage = await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.create');
        requireRequirementVisible(await stageVisibility(client, ctx, stage.id), body.requirementId, { tenderId: stage.tender_id, entityType: 'tender_stage', entityId: stage.id });
        const id = await createCustomerQuestion(client, {
          tenderId: stage.tender_id,
          stageId: stage.id,
          requirementId: body.requirementId ?? null,
          text: body.text,
          responsibleUserId: body.responsibleUserId ?? null,
          userId: ctx.principal.userId,
        });
        const { row: q, body: view } = await questionView(client, ctx, id);
        return {
          status: 201,
          body: view,
          etag: formatEtag(id, q.row_version),
          audit: [{ action: 'customer_question.create', entityType: 'customer_question', entityId: id, tenderId: stage.tender_id, details: { requirementId: q.requirement_id } }],
        };
      },
    }),
  );

  router.patch(
    '/customer-questions/:id',
    command(pool, {
      action: 'customer_question.update',
      entityType: 'customer_question',
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'customer_question');
        requireInScope(ctx, await getCustomerQuestion(client, id), 'customer_question', id, 'requirement.create');
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'customer_question');
        const rowVersion = requireIfMatch(req, id);
        const body = parseBody(UpdateCustomerQuestionRequest, req.body);
        const q = requireInScope(ctx, await getCustomerQuestion(client, id), 'customer_question', id, 'requirement.create');
        const target = { tenderId: q.tender_id, entityType: 'customer_question', entityId: id };
        const vis = await stageVisibility(client, ctx, q.stage_id);
        requireVisible(vis, 'question', id, target);
        if (body.requirementId !== undefined) requireRequirementVisible(vis, body.requirementId, target);
        const status = body.status ?? q.status;
        // Время отправки и ответа ставится при переходе, если не указано явно.
        const askedAt = body.askedAt !== undefined ? (body.askedAt ? new Date(body.askedAt) : null) : status === 'sent' && !q.asked_at ? new Date() : q.asked_at;
        const answeredAt =
          body.answeredAt !== undefined ? (body.answeredAt ? new Date(body.answeredAt) : null) : status === 'answered' && !q.answered_at ? new Date() : q.answered_at;
        const ok = await updateCustomerQuestion(
          client,
          id,
          rowVersion,
          {
            text: body.text ?? q.text,
            requirementId: body.requirementId !== undefined ? body.requirementId : q.requirement_id,
            status,
            askedAt,
            answeredAt,
            answerQaItemRevisionId: body.answerQaItemRevisionId !== undefined ? body.answerQaItemRevisionId : q.answer_qa_item_revision_id,
            answerNote: body.answerNote !== undefined ? (body.answerNote ?? null) : q.answer_note,
            responsibleUserId: body.responsibleUserId !== undefined ? body.responsibleUserId : q.responsible_user_id,
          },
          ctx.principal.userId,
        );
        if (!ok) throw versionConflict({ rowVersion: q.row_version, status: q.status });
        const { row: next, body: view } = await questionView(client, ctx, id);
        return {
          status: 200,
          body: view,
          etag: formatEtag(id, next.row_version),
          audit: [{ action: 'customer_question.update', entityType: 'customer_question', entityId: id, tenderId: q.tender_id, details: { from: q.status, to: next.status } }],
        };
      },
    }),
  );

  router.get(
    '/stages/:id/notes',
    query(pool, 'stage_note.list', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStageWith(pool, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.read');
      res.json({ items: (await listStageNotes(pool, stage.id)).map(toStageNote) });
    }),
  );

  router.post(
    '/stages/:id/notes',
    command(pool, {
      action: 'stage_note.create',
      entityType: 'stage_note',
      idempotent: true,
      authorize: async (client, ctx, req) => void (await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.create')),
      run: async (client, ctx, req) => {
        const body = parseBody(CreateStageNoteRequest, req.body);
        const stage = await loadStageWith(client, ctx, uuidParam(req, 'id', 'tender_stage'), 'requirement.create');
        const id = await createStageNote(client, { tenderId: stage.tender_id, stageId: stage.id, text: body.text, supersedesNoteId: body.supersedesNoteId ?? null, userId: ctx.principal.userId });
        const note = (await listStageNotes(client, stage.id)).find((n) => n.id === id)!;
        return {
          status: 201,
          body: toStageNote(note),
          audit: [{ action: 'stage_note.create', entityType: 'stage_note', entityId: id, tenderId: stage.tender_id, details: { supersedesNoteId: body.supersedesNoteId ?? null } }],
        };
      },
    }),
  );

  return router;
};
