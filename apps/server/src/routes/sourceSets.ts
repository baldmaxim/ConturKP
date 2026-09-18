// Состав источников этапа (portal-api §2.3; state-machines §5): набор working, draft-ревизия,
// включение или исключение редакции с причиной; каждое изменение — событие source_set_changed.
// Заморозка ревизии требует распознавания всех включённых редакций и появится на этапе 04.
import { PutSourceSetItemsRequest } from '@kontur/contracts';
import { formatEtag } from '@kontur/core';
import {
  createDraftRevision,
  emitStageEvents,
  ensureWorkingSet,
  getSetRevision,
  listSetItems,
  listSetRevisions,
  replaceSetItems,
  type IAccessContext,
  type ISourceSetRevisionRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { requireTenderCapById } from './scope.ts';
import { loadStage } from './stages.ts';

const toRevision = (r: ISourceSetRevisionRow) => ({
  id: r.id,
  sourceSetId: r.source_set_id,
  stageId: r.stage_id,
  seq: r.seq,
  status: r.status,
  baseRevisionId: r.base_revision_id,
  contentHash: r.content_hash,
  rowVersion: r.row_version,
  updatedAt: r.updated_at.toISOString(),
});

// Ревизия видна, только если виден её этап (область тендера пользователя).
const loadRevision = async (db: Queryable, ctx: IAccessContext, id: string, lock = false) => {
  const r = await getSetRevision(db, id, lock);
  if (!r) throw notFound({ entityType: 'source_set_revision', entityId: id });
  const stage = await loadStage(db, ctx, r.stage_id).catch(() => null);
  if (!stage) throw notFound({ entityType: 'source_set_revision', entityId: id });
  return { rev: r, stage };
};

export const sourceSetsRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/stages/:id/source-sets',
    query(pool, 'source.set.read', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      const sets = await pool.query<{ id: string; purpose: string }>('SELECT id, purpose FROM source_set WHERE stage_id = $1 ORDER BY purpose', [stage.id]);
      const out = [];
      for (const s of sets.rows) {
        const revisions = await listSetRevisions(pool, s.id);
        const latest = revisions[0];
        out.push({
          id: s.id,
          purpose: s.purpose,
          revisions: revisions.map(toRevision),
          latestItems: latest
            ? (await listSetItems(pool, latest.id)).map((i) => ({
                documentRevisionId: i.document_revision_id,
                documentId: i.document_id,
                documentTitle: i.document_title,
                revisionSeq: i.revision_seq,
                inclusion: i.inclusion,
                reason: i.reason,
              }))
            : [],
        });
      }
      res.json({ items: out });
    }),
  );

  // Новая draft-ревизии рабочего набора этапа (набор создаётся при первом обращении).
  router.post(
    '/stages/:id/source-set-revisions',
    command(pool, {
      action: 'source.set.revision.create',
      entityType: 'source_set_revision',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'));
        requireTenderCapById(ctx, stage.tender_id, 'source.write', { entityType: 'tender_stage', entityId: stage.id });
      },
      run: async (client, ctx, req) => {
        const stage = await loadStage(client, ctx, uuidParam(req, 'id', 'tender_stage'), true);
        const setId = await ensureWorkingSet(client, stage.id);
        const open = await client.query("SELECT 1 FROM source_set_revision WHERE source_set_id = $1 AND status = 'draft'", [setId]);
        if (open.rowCount) throw new HttpError(409, 'STATE_CONFLICT', 'у набора уже есть черновик ревизии', {}, { tenderId: stage.tender_id });
        const id = await createDraftRevision(client, setId, ctx.principal.userId);
        const rev = (await getSetRevision(client, id))!;
        return {
          status: 201,
          body: toRevision(rev),
          etag: formatEtag(id, rev.row_version),
          audit: [{ action: 'source.set.revision.create', entityType: 'source_set_revision', entityId: id, tenderId: stage.tender_id, details: { seq: rev.seq } }],
        };
      },
    }),
  );

  router.put(
    '/source-set-revisions/:id/items',
    command(pool, {
      action: 'source.set.items.replace',
      entityType: 'source_set_revision',
      authorize: async (client, ctx, req) => {
        const { stage } = await loadRevision(client, ctx, uuidParam(req, 'id', 'source_set_revision'));
        requireTenderCapById(ctx, stage.tender_id, 'source.write', { entityType: 'source_set_revision', entityId: req.params.id as string });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'source_set_revision');
        const probe = await loadRevision(client, ctx, id);
        // Порядок блокировок: этап → ревизия (state-machines §1.2); событие — под блокировкой этапа.
        await loadStage(client, ctx, probe.stage.id, true);
        const { rev, stage } = await loadRevision(client, ctx, id, true);
        if (requireIfMatch(req, id) !== rev.row_version) throw versionConflict(toRevision(rev));
        if (rev.status !== 'draft') throw new HttpError(409, 'STATE_CONFLICT', 'ревизия заморожена', {}, { tenderId: stage.tender_id, entityId: id });
        const body = parseBody(PutSourceSetItemsRequest, req.body);
        const ids = body.items.map((i) => i.documentRevisionId);
        if (new Set(ids).size !== ids.length) throw new HttpError(400, 'VALIDATION_FAILED', 'редакция указана дважды');
        const own = await client.query<{ id: string }>('SELECT id FROM document_revision WHERE id = ANY($1::uuid[]) AND tender_id = $2', [ids, stage.tender_id]);
        if (own.rows.length !== ids.length) throw new HttpError(400, 'VALIDATION_FAILED', 'редакция не относится к тендеру этапа');
        for (const it of body.items) {
          if (it.inclusion === 'excluded_not_applicable' && !it.reason) throw new HttpError(400, 'VALIDATION_FAILED', 'исключение требует причины');
        }
        await replaceSetItems(
          client,
          id,
          body.items.map((i) => ({ documentRevisionId: i.documentRevisionId, inclusion: i.inclusion, reason: i.reason ?? null })),
          ctx.principal.userId,
        );
        await emitStageEvents(client, { tenderId: stage.tender_id, stageIds: [stage.id], eventType: 'source_set_changed', refType: 'source_set_revision', refId: id, actorUserId: ctx.principal.userId });
        const after = (await getSetRevision(client, id))!;
        return {
          status: 200,
          body: { ...toRevision(after), items: body.items },
          etag: formatEtag(id, after.row_version),
          audit: [
            {
              action: 'source.set.items.replace',
              entityType: 'source_set_revision',
              entityId: id,
              tenderId: stage.tender_id,
              details: {
                included: body.items.filter((i) => i.inclusion === 'included').length,
                excluded: body.items.filter((i) => i.inclusion === 'excluded_not_applicable').length,
              },
            },
          ],
        };
      },
    }),
  );

  return router;
};
