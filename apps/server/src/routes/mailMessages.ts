// Письма, их ревизии, вложения и связи с тендерами (этап 07, D-025: OD-07-3, OD-07-7, И-07-1). Всё
// содержимое письма — только с mail.read на его ящик: письмо чужого ящика не отличается от
// несуществующего (404), известный ID вложения не помогает (A35). Связь с тендером подтверждает человек
// с mail.link и source.write по тендеру; система только предлагает кандидатов по точным признакам.
import { CreateMailLinkRequest } from '@kontur/contracts';
import { formatEtag } from '@kontur/core';
import {
  getMailAttachment,
  getMailMessage,
  getMailRevision,
  getMessageLink,
  getStage,
  linkCandidates,
  linkMessage,
  listMailAttachments,
  listMailRevisions,
  listMessageLinks,
  listTenderMessages,
  lockMailMessage,
  mailBodyFragments,
  mailCaps,
  mailSiblings,
  unlinkMessage,
  type IAccessContext,
  type IMailMessageRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import {
  toLinkCandidate,
  toMailAttachment,
  toMailBody,
  toMailLink,
  toMailMessage,
  toMailRevision,
  toMailSibling,
} from '../mailMappers.ts';
import { contentDisposition, CONTENT_CSP, INLINE_TYPES } from './documents.ts';
import { hasTenderCap } from './scope.ts';

// Письмо — только с mail.read на ящик (getMailMessage фильтрует по читаемым ящикам).
export const loadMessage = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IMailMessageRow> => {
  const m = await getMailMessage(db, ctx, id);
  if (!m) throw notFound({ entityType: 'mail_message', entityId: id });
  return m;
};

const target = (m: { id: string; mailbox_id: string }, details: Record<string, unknown> = {}) => ({
  entityType: 'mail_message',
  entityId: m.id,
  details: { mailboxId: m.mailbox_id, ...details },
});

// Связь меняет состав источников тендера: mail.link на ящик письма и source.write по тендеру (как у договора).
// События связи пишутся без tender_id (тендер — в деталях): журнал тендера видят и те, кто письмо не читает.
const requireLinkRights = (ctx: IAccessContext, m: IMailMessageRow, tenderId: string): void => {
  if (!mailCaps(ctx, m.mailbox_id).includes('mail.link')) throw forbidden('mail.link', target(m, { tenderId }));
  if (!hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
  if (!hasTenderCap(ctx, tenderId, 'source.write')) throw forbidden('source.write', target(m, { tenderId }));
};

const bodyTextOf = async (db: Queryable, revisionId: string): Promise<string> =>
  (await mailBodyFragments(db, revisionId))
    .filter((f) => !f.locator.quoted)
    .map((f) => f.text)
    .join('\n');

const revisionDetail = async (db: Queryable, revisionId: string) => ({
  body: toMailBody(await mailBodyFragments(db, revisionId)),
  attachments: (await listMailAttachments(db, revisionId)).map(toMailAttachment),
});

export const mailMessagesRouter = (pool: Pool, store: BlobStore): Router => {
  const router = Router();

  // Карточка письма: текущая ревизия с телом и вложениями, история ревизий, копии той же коммуникации
  // в читаемых ящиках, связи с видимыми тендерами и — с mail.link — кандидаты связи.
  router.get(
    '/mail-messages/:id',
    query(pool, 'mail.message.read', 'mail_message', async (ctx, req, res) => {
      const m = await loadMessage(pool, ctx, uuidParam(req, 'id', 'mail_message'));
      const revisions = await listMailRevisions(pool, m.id);
      const caps = mailCaps(ctx, m.mailbox_id);
      const current = revisions[0]!;
      res.json({
        ...toMailMessage(m),
        capabilities: caps,
        current: { ...toMailRevision(current), ...(await revisionDetail(pool, current.id)) },
        revisionList: revisions.map(toMailRevision),
        siblings: (await mailSiblings(pool, ctx, m.id)).map(toMailSibling),
        tenderLinks: (await listMessageLinks(pool, ctx, m.id)).map(toMailLink),
        candidates: caps.includes('mail.link')
          ? (await linkCandidates(pool, ctx, { messageId: m.id, subject: current.subject, bodyText: await bodyTextOf(pool, current.id) })).map(toLinkCandidate)
          : [],
      });
    }),
  );

  // Историческая ревизия: снимок фиксирует конкретную ревизию, поэтому прежняя остаётся читаемой.
  router.get(
    '/mail-message-revisions/:id',
    query(pool, 'mail.message.read', 'mail_message_revision', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'mail_message_revision');
      const r = await getMailRevision(pool, ctx, id);
      if (!r) throw notFound({ entityType: 'mail_message_revision', entityId: id });
      res.json({ ...toMailRevision(r), messageId: r.message_id, mailboxId: r.mailbox_id, ...(await revisionDetail(pool, r.id)) });
    }),
  );

  router.post(
    '/mail-messages/:id/tender-links',
    command(pool, {
      action: 'mail.tender.link',
      entityType: 'mail_message_tender',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const m = await loadMessage(client, ctx, uuidParam(req, 'id', 'mail_message'));
        requireLinkRights(ctx, m, parseBody(CreateMailLinkRequest, req.body).tenderId);
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'mail_message');
        const body = parseBody(CreateMailLinkRequest, req.body);
        // Порядок блокировок: письмо → тендер → этапы (события барьера); две связи одной пары — по очереди.
        await lockMailMessage(client, id);
        const m = await loadMessage(client, ctx, id);
        requireLinkRights(ctx, m, body.tenderId);
        if (body.stageId) {
          const stage = await getStage(client, ctx, body.stageId);
          if (!stage || stage.tender_id !== body.tenderId) throw notFound({ entityType: 'tender_stage', entityId: body.stageId });
        }
        const r = await linkMessage(client, { messageId: id, tenderId: body.tenderId, stageId: body.stageId ?? null, userId: ctx.principal.userId });
        if (r.outcome === 'already_linked') {
          throw new HttpError(409, 'STATE_CONFLICT', 'письмо уже связано с этим тендером', { current: toMailLink(r.link) }, target(m, { tenderId: body.tenderId }));
        }
        return {
          status: r.outcome === 'linked' ? 201 : 200,
          body: toMailLink(r.link),
          etag: formatEtag(r.link.id, r.link.row_version),
          audit: [
            {
              action: r.outcome === 'linked' ? 'mail.tender.link' : r.outcome === 'relinked' ? 'mail.tender.relink' : 'mail.tender.update',
              entityType: 'mail_message_tender',
              entityId: r.link.id,
              details: { mailboxId: m.mailbox_id, messageId: id, tenderId: body.tenderId, stageId: r.link.stage_id },
            },
          ],
        };
      },
    }),
  );

  // Снятие связи: письмо, ревизии и исторические снимки не меняются; в рабочую область письмо больше не входит.
  router.post(
    '/mail-messages/:id/tender-links/:tenderId/unlink',
    command(pool, {
      action: 'mail.tender.unlink',
      entityType: 'mail_message_tender',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const m = await loadMessage(client, ctx, uuidParam(req, 'id', 'mail_message'));
        requireLinkRights(ctx, m, uuidParam(req, 'tenderId', 'tender'));
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'mail_message');
        const tenderId = uuidParam(req, 'tenderId', 'tender');
        await lockMailMessage(client, id);
        const m = await loadMessage(client, ctx, id);
        requireLinkRights(ctx, m, tenderId);
        const before = await getMessageLink(client, id, tenderId, true);
        if (!before) throw notFound({ entityType: 'mail_message_tender', details: { mailboxId: m.mailbox_id, messageId: id, tenderId } });
        if (!(await unlinkMessage(client, { messageId: id, tenderId, userId: ctx.principal.userId }))) {
          throw new HttpError(409, 'STATE_CONFLICT', 'связь уже снята', { current: toMailLink(before) }, target(m, { tenderId }));
        }
        const after = (await getMessageLink(client, id, tenderId))!;
        return {
          status: 200,
          body: toMailLink(after),
          etag: formatEtag(after.id, after.row_version),
          audit: [{ action: 'mail.tender.unlink', entityType: 'mail_message_tender', entityId: after.id, details: { mailboxId: m.mailbox_id, messageId: id, tenderId } }],
        };
      },
    }),
  );

  // Переписка тендера: только письма с действующей связью и mail.read на ящик. Письмо без mail.read не
  // показывается и не считается (OD-07-3): участник тендера не узнаёт о нём ни темы, ни числа.
  router.get(
    '/tenders/:id/mail-messages',
    query(pool, 'mail.message.list', 'tender', async (ctx, req, res) => {
      const tenderId = uuidParam(req, 'id', 'tender');
      if (!hasTenderCap(ctx, tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: tenderId });
      res.json({ items: (await listTenderMessages(pool, ctx, tenderId)).map(toMailMessage) });
    }),
  );

  // Байты вложения: mail.read на ящик письма; отклонённое вложение байтов не хранит.
  router.get(
    '/mail-attachments/:id/content',
    query(pool, 'mail.attachment.read', 'mail_attachment', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'mail_attachment');
      const a = await getMailAttachment(pool, ctx, id);
      if (!a) throw notFound({ entityType: 'mail_attachment', entityId: id });
      if (a.status !== 'registered' || !a.storage_key) {
        throw new HttpError(409, 'STATE_CONFLICT', 'вложение отклонено при импорте: содержимое не сохранено', { current: { reason: a.reject_reason } }, { entityType: 'mail_attachment', entityId: id, details: { mailboxId: a.mailbox_id } });
      }
      // Тип — по содержимому (классификация при импорте), а не заявленный в письме.
      const media = a.blob_media_type ?? 'application/octet-stream';
      const inline = INLINE_TYPES.has(media);
      res.setHeader('Content-Type', inline ? media : 'application/octet-stream');
      res.setHeader('Content-Length', String(a.size_bytes));
      res.setHeader('Content-Disposition', contentDisposition(inline, a.filename));
      res.setHeader('Content-Security-Policy', CONTENT_CSP);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-SHA256', a.sha256);
      const stream = store.openRead(a.sha256);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  return router;
};
