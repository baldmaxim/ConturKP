// Состав источников этапа (portal-api §2.3; state-machines §5): набор working, draft-ревизия,
// включение или исключение редакции с причиной; каждое изменение — событие source_set_changed.
// Заморозка ревизии требует распознавания всех включённых редакций (этап 04).
import { FreezeSourceSetRequest, PutSourceSetItemsRequest } from '@kontur/contracts';
import { formatEtag, sourceSetContentHash } from '@kontur/core';
import {
  activeLinkedContractIds,
  blockingFreezeItems,
  createDraftRevision,
  emitStageEvents,
  ensureWorkingSet,
  freezeSetRevision,
  getSetRevision,
  listSetItems,
  listSetRevisions,
  readableContractIds,
  readableMailboxIds,
  replaceSetItems,
  revisionOwners,
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

// Элемент с редакцией договора виден участнику без contract.read только как факт (D-022 OD-2):
// ни названия, ни документа, ни идентификатора договора — лишь номер редакции в составе. Так же документ
// вложения без mail.read на ящик письма (D-025).
interface IReadable {
  contracts: ReadonlySet<string>;
  mailboxes: ReadonlySet<string>;
}

const readableOf = (ctx: IAccessContext): IReadable => ({ contracts: new Set(readableContractIds(ctx)), mailboxes: new Set(readableMailboxIds(ctx)) });

const restrictedOf = (readable: IReadable, i: { contract_id: string | null; mailbox_id: string | null }): boolean =>
  (i.contract_id !== null && !readable.contracts.has(i.contract_id)) || (i.mailbox_id !== null && !readable.mailboxes.has(i.mailbox_id));

// Письма, действующе связанные с тендером этапа (связь без этапа или с этим этапом): только их вложения
// входят в состав и снимок (охранник evidence_scope_item, 0018).
const stageLinkedMessages = async (db: Queryable, tenderId: string, stageId: string): Promise<Set<string>> =>
  new Set(
    (
      await db.query<{ message_id: string }>(
        "SELECT message_id FROM mail_message_tender WHERE tender_id = $1 AND status = 'linked' AND (stage_id IS NULL OR stage_id = $2)",
        [tenderId, stageId],
      )
    ).rows.map((x) => x.message_id),
  );

export const sourceSetsRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/stages/:id/source-sets',
    query(pool, 'source.set.read', 'tender_stage', async (ctx, req, res) => {
      const stage = await loadStage(pool, ctx, uuidParam(req, 'id', 'tender_stage'));
      const readable = readableOf(ctx);
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
            ? (await listSetItems(pool, latest.id)).map((i) => {
                const restricted = restrictedOf(readable, i);
                return {
                  documentRevisionId: i.document_revision_id,
                  contractId: restricted ? null : i.contract_id,
                  mailMessageId: restricted ? null : i.mail_message_id,
                  restricted,
                  documentId: restricted ? null : i.document_id,
                  documentTitle: restricted ? null : i.document_title,
                  revisionSeq: i.revision_seq,
                  inclusion: i.inclusion,
                  reason: i.reason,
                };
              })
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
        // Редакция — своего тендера, договора, действующе связанного с тендером (D-017), или документ
        // вложения письма, действующе связанного с тендером этапа (D-025): связь лишь предлагает кандидатов.
        // Новый или изменённый элемент договора требует contract.read, вложения — mail.read на ящик письма;
        // прежний элемент, оставленный как был, — нет: состав этапа ведёт участник тендера.
        const owners = await revisionOwners(client, ids);
        const linked = new Set(await activeLinkedContractIds(client, stage.tender_id));
        const linkedMail = await stageLinkedMessages(client, stage.tender_id, stage.id);
        const readable = readableOf(ctx);
        const before = new Map((await listSetItems(client, id)).map((i) => [i.document_revision_id, i]));
        for (const it of body.items) {
          const owner = owners.get(it.documentRevisionId);
          if (owner?.tenderId === stage.tender_id) continue;
          const byContract = owner?.contractId && linked.has(owner.contractId);
          const byMail = owner?.mailMessageId && linkedMail.has(owner.mailMessageId);
          if (!byContract && !byMail) {
            throw new HttpError(400, 'VALIDATION_FAILED', 'редакция не относится к тендеру этапа, связанному с ним договору или связанному письму');
          }
          const prev = before.get(it.documentRevisionId);
          const unchanged = prev !== undefined && prev.inclusion === it.inclusion && (prev.reason ?? null) === (it.reason ?? null);
          const capability = byContract ? 'contract.read' : 'mail.read';
          const allowed = byContract ? readable.contracts.has(owner!.contractId!) : readable.mailboxes.has(owner!.mailboxId!);
          if (!unchanged && !allowed) {
            // Отказ — без идентификатора договора и ящика: журнал тендера видят участники без выдачи.
            throw new HttpError(403, 'FORBIDDEN', `нет права ${capability}`, {}, {
              tenderId: stage.tender_id,
              entityType: 'source_set_revision',
              entityId: id,
              details: { capability },
            });
          }
        }
        const contractItems = body.items.filter((i) => owners.get(i.documentRevisionId)?.contractId).length;
        const attachmentItems = body.items.filter((i) => owners.get(i.documentRevisionId)?.mailMessageId).length;
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
                contractItems,
                attachmentItems,
              },
            },
          ],
        };
      },
    }),
  );

  // Заморозка состава (state-machines §5). Событий барьера не порождает: состав не меняется,
  // меняется только его статус. Охранное условие — распознавание включённых редакций (I18).
  router.post(
    '/source-set-revisions/:id/freeze',
    command(pool, {
      action: 'source.set.freeze',
      entityType: 'source_set_revision',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const { stage } = await loadRevision(client, ctx, uuidParam(req, 'id', 'source_set_revision'));
        requireTenderCapById(ctx, stage.tender_id, 'source.write', { entityType: 'source_set_revision', entityId: req.params.id as string });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'source_set_revision');
        parseBody(FreezeSourceSetRequest, req.body);
        const probe = await loadRevision(client, ctx, id);
        await loadStage(client, ctx, probe.stage.id, true);
        const { rev, stage } = await loadRevision(client, ctx, id, true);
        const target = { tenderId: stage.tender_id, entityId: id };
        if (requireIfMatch(req, id) !== rev.row_version) throw versionConflict(toRevision(rev));
        if (rev.status !== 'draft') throw new HttpError(409, 'STATE_CONFLICT', 'ревизия уже заморожена', { current: toRevision(rev) }, target);
        const items = await listSetItems(client, id);
        const included = items.filter((i) => i.inclusion !== 'excluded_not_applicable');
        if (included.length === 0) {
          throw new HttpError(409, 'STATE_CONFLICT', 'в составе нет ни одной включённой редакции', {}, target);
        }
        // Включённая редакция договора замораживается только при действующей связи договора с тендером:
        // снимок из такой ревизии БД иначе не примет (охранник evidence_scope_item, миграция 0012).
        const linked = new Set(await activeLinkedContractIds(client, stage.tender_id));
        const unlinked = included.filter((i) => i.contract_id !== null && !linked.has(i.contract_id));
        // Так же вложение письма: снимок примет его только при действующей связи письма с тендером этапа.
        const linkedMail = await stageLinkedMessages(client, stage.tender_id, stage.id);
        const unlinkedMail = included.filter((i) => i.mail_message_id !== null && !linkedMail.has(i.mail_message_id));
        if (unlinkedMail.length > 0) {
          throw new HttpError(
            409,
            'STATE_CONFLICT',
            'связь письма с тендером снята: исключите его вложения из состава или восстановите связь',
            { current: { reason: 'attachment_link_inactive', documentRevisionIds: unlinkedMail.map((i) => i.document_revision_id) } },
            target,
          );
        }
        if (unlinked.length > 0) {
          throw new HttpError(
            409,
            'STATE_CONFLICT',
            'связь договора с тендером в архиве: исключите его редакции из состава или восстановите связь',
            { current: { reason: 'contract_link_archived', documentRevisionIds: unlinked.map((i) => i.document_revision_id) } },
            target,
          );
        }
        const blocking = await blockingFreezeItems(client, id);
        if (blocking.length > 0) {
          const readable = readableOf(ctx);
          throw new HttpError(
            409,
            'STATE_CONFLICT',
            'заморозка требует распознавания включённых редакций',
            {
              current: {
                blocking: blocking.map((b) => {
                  const restricted = restrictedOf(readable, b);
                  return {
                    documentRevisionId: b.document_revision_id,
                    contractId: restricted ? null : b.contract_id,
                    restricted,
                    documentId: restricted ? null : b.document_id,
                    documentTitle: restricted ? null : b.document_title,
                    revisionSeq: b.revision_seq,
                    reason: b.reason,
                  };
                }),
              },
            },
            target,
          );
        }
        const contentHash = sourceSetContentHash(
          items.map((i) => ({ documentRevisionId: i.document_revision_id, blobSha256: i.blob_sha256, inclusion: i.inclusion })),
        );
        await freezeSetRevision(client, id, { contentHash, userId: ctx.principal.userId });
        const after = (await getSetRevision(client, id))!;
        return {
          status: 200,
          body: { ...toRevision(after), items: items.map((i) => ({ documentRevisionId: i.document_revision_id, inclusion: i.inclusion, reason: i.reason })) },
          etag: formatEtag(id, after.row_version),
          audit: [
            {
              action: 'source.set.freeze',
              entityType: 'source_set_revision',
              entityId: id,
              tenderId: stage.tender_id,
              details: { seq: after.seq, contentHash, included: included.length, excluded: items.length - included.length },
            },
          ],
        };
      },
    }),
  );

  return router;
};
