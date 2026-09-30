// Почтовые ящики, выдачи и импорт EML (этап 07, D-025: OD-07-2, OD-07-3, OD-07-4, AD-07-3). Ящик
// регистрирует и выдачи ведёт администратор ящиков (admin.mailbox) — он видит только служебные сведения.
// Невидимый ящик — 404, видимый без нужной возможности — 403. Автоматического чтения MailHub нет (X-03):
// штатный путь — ручной импорт EML в конкретный ящик; разбирает worker.
import type { IAppConfig } from '@kontur/config';
import { CreateMailboxRequest, MailImportQuery, PatchMailboxRequest, PutMailAccessRequest } from '@kontur/contracts';
import { formatEtag, globalCapabilities, hasContentRole, type MailCapability, type Role } from '@kontur/core';
import {
  bumpMailboxVersion,
  communicationIntegrations,
  createMailbox,
  createMailImport,
  getMailbox,
  getMailImport,
  getStage,
  getUser,
  insertBlob,
  listMailAccess,
  listMailboxes,
  listMailboxMessages,
  listMailImports,
  mailCaps,
  setMailAccess,
  updateMailbox,
  type IAccessContext,
  type IMailboxRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import type { Request } from 'express';
import { Router } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { requireCtx } from '../http/context.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { receiveUpload, uploadName, uploadedBlob } from '../http/upload.ts';
import { toCommunicationIntegration, toMailAccess, toMailbox, toMailImport, toMailMessage } from '../mailMappers.ts';
import { requireMailCap } from './contractScope.ts';
import { hasTenderCap } from './scope.ts';

export const isMailboxAdmin = (ctx: IAccessContext): boolean => globalCapabilities(ctx.roles).includes('admin.mailbox');

const target = (mailboxId: string) => ({ entityType: 'mailbox', entityId: mailboxId, details: { mailboxId } });

// Ящик виден администратору ящиков и пользователю с любой действующей выдачей по нему.
export const loadMailbox = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IMailboxRow> => {
  const m = await getMailbox(db, id, lock);
  if (!m || (!isMailboxAdmin(ctx) && mailCaps(ctx, id).length === 0)) throw notFound({ entityType: 'mailbox', entityId: id });
  return m;
};

const requireMailboxAdmin = (ctx: IAccessContext, entityId: string | null = null): void => {
  if (!isMailboxAdmin(ctx)) throw forbidden('admin.mailbox', { entityType: 'mailbox', entityId });
};

const view = (ctx: IAccessContext, m: IMailboxRow) => toMailbox(m, mailCaps(ctx, m.id));

// Файл EML опознаётся по расширению и по началу содержимого (заголовки письма), а не по заявленному типу.
const EML_NAME = /\.eml$/iu;
const looksLikeEmlHead = (head: Buffer): boolean => /^[\x21-\x39\x3b-\x7e]+:/u.test(head.subarray(0, 200).toString('latin1').replace(/^\xEF\xBB\xBF/u, ''));

// Связь при импорте (OD-07-7): её подтверждает человек — mail.link на ящик и source.write по тендеру.
const requireImportLink = async (db: Queryable, ctx: IAccessContext, mailboxId: string, q: { tenderId?: string | undefined; stageId?: string | undefined }) => {
  if (!q.tenderId) {
    if (q.stageId) throw new HttpError(400, 'VALIDATION_FAILED', 'stageId задаётся вместе с tenderId');
    return;
  }
  requireMailCap(ctx, mailboxId, 'mail.link', target(mailboxId));
  if (!hasTenderCap(ctx, q.tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: q.tenderId });
  if (!hasTenderCap(ctx, q.tenderId, 'source.write')) throw forbidden('source.write', { entityType: 'mailbox', entityId: mailboxId, details: { mailboxId, tenderId: q.tenderId } });
  if (q.stageId) {
    const stage = await getStage(db, ctx, q.stageId);
    if (!stage || stage.tender_id !== q.tenderId) throw notFound({ entityType: 'tender_stage', entityId: q.stageId });
  }
};

export const mailboxesRouter = (pool: Pool, store: BlobStore, config: IAppConfig): Router => {
  const router = Router();

  router.get(
    '/mailboxes',
    query(pool, 'mailbox.list', 'mailbox', async (ctx, _req, res) => {
      const admin = isMailboxAdmin(ctx);
      res.json({
        items: (await listMailboxes(pool, ctx, admin)).map((m) => view(ctx, m)),
        isMailboxAdmin: admin,
        integrations: (await communicationIntegrations(pool)).map(toCommunicationIntegration),
      });
    }),
  );

  router.post(
    '/mailboxes',
    command(pool, {
      action: 'mailbox.create',
      entityType: 'mailbox',
      idempotent: true,
      authorize: async (_client, ctx) => requireMailboxAdmin(ctx),
      run: async (client, ctx, req) => {
        requireMailboxAdmin(ctx);
        const body = parseBody(CreateMailboxRequest, req.body);
        const r = await createMailbox(client, { system: body.system, externalAccountId: body.externalAccountId, displayName: body.displayName, createdBy: ctx.principal.userId });
        if ('conflict' in r) {
          throw new HttpError(409, 'STATE_CONFLICT', 'такой ящик уже зарегистрирован', { current: { reason: 'mailbox_exists', mailboxId: r.conflict } }, target(r.conflict));
        }
        const m = (await getMailbox(client, r.id))!;
        return {
          status: 201,
          body: view(ctx, m),
          etag: formatEtag(m.id, m.row_version),
          audit: [{ action: 'mailbox.create', entityType: 'mailbox', entityId: m.id, details: { mailboxId: m.id, system: m.system } }],
        };
      },
    }),
  );

  router.get(
    '/mailboxes/:id',
    query(pool, 'mailbox.read', 'mailbox', async (ctx, req, res) => {
      const m = await loadMailbox(pool, ctx, uuidParam(req, 'id', 'mailbox'));
      res.setHeader('ETag', formatEtag(m.id, m.row_version));
      res.json(view(ctx, m));
    }),
  );

  // Название и архив ящика — администратор ящиков или mail.manage; архивный ящик новых импортов не принимает.
  router.patch(
    '/mailboxes/:id',
    command(pool, {
      action: 'mailbox.update',
      entityType: 'mailbox',
      authorize: async (client, ctx, req) => {
        const m = await loadMailbox(client, ctx, uuidParam(req, 'id', 'mailbox'));
        if (!isMailboxAdmin(ctx)) requireMailCap(ctx, m.id, 'mail.manage', target(m.id));
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'mailbox');
        const m = await loadMailbox(client, ctx, id, true);
        if (!isMailboxAdmin(ctx)) requireMailCap(ctx, id, 'mail.manage', target(id));
        if (requireIfMatch(req, id) !== m.row_version) throw versionConflict(view(ctx, m));
        const body = parseBody(PatchMailboxRequest, req.body);
        await updateMailbox(client, id, body);
        const after = (await getMailbox(client, id))!;
        const changes: Record<string, unknown> = {};
        if (after.display_name !== m.display_name) changes.displayName = { changed: true };
        if (after.status !== m.status) changes.status = { from: m.status, to: after.status };
        return {
          status: 200,
          body: view(ctx, after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'mailbox.update', entityType: 'mailbox', entityId: id, details: { mailboxId: id, changes } }],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Выдачи (admin.mailbox)

  router.get(
    '/mailboxes/:id/access',
    query(pool, 'mailbox.access.read', 'mailbox', async (ctx, req, res) => {
      const m = await loadMailbox(pool, ctx, uuidParam(req, 'id', 'mailbox'));
      requireMailboxAdmin(ctx, m.id);
      res.setHeader('ETag', formatEtag(m.id, m.row_version));
      res.json({ items: (await listMailAccess(pool, m.id)).map(toMailAccess), mailboxRowVersion: m.row_version });
    }),
  );

  router.put(
    '/mailboxes/:id/access/:userId',
    command(pool, {
      action: 'mailbox.access.set',
      entityType: 'mail_access',
      authorize: async (client, ctx, req) => {
        const m = await loadMailbox(client, ctx, uuidParam(req, 'id', 'mailbox'));
        requireMailboxAdmin(ctx, m.id);
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'mailbox');
        const userId = uuidParam(req, 'userId', 'app_user');
        const m = await loadMailbox(client, ctx, id, true);
        requireMailboxAdmin(ctx, id);
        if (requireIfMatch(req, id) !== m.row_version) throw versionConflict(view(ctx, m));
        const { capabilities } = parseBody(PutMailAccessRequest, req.body);
        const wanted = [...new Set(capabilities)] as MailCapability[];
        // Выдача действует только при роли инженера или руководителя: иначе администратор получает отказ,
        // а не молчаливую бездействующую строку (как у договоров, D-022).
        if (wanted.length > 0) {
          const user = await getUser(client, userId);
          if (!user) throw notFound({ entityType: 'app_user', entityId: userId });
          if (user.status !== 'active' || !hasContentRole(new Set(user.roles as Role[]))) {
            throw new HttpError(409, 'STATE_CONFLICT', 'выдача по ящику действует только у активного инженера или руководителя', {}, { ...target(id), details: { mailboxId: id, userId } });
          }
        }
        await client.query('SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE', [userId]);
        const r = await setMailAccess(client, { mailboxId: id, userId, capabilities: wanted, actorId: ctx.principal.userId });
        if (r.granted.length + r.revoked.length > 0) await bumpMailboxVersion(client, id);
        const after = (await getMailbox(client, id))!;
        return {
          status: 200,
          body: { items: (await listMailAccess(client, id)).map(toMailAccess), mailboxRowVersion: after.row_version },
          etag: formatEtag(id, after.row_version),
          audit: [
            ...r.granted.map((capability) => ({ action: 'mailbox.access.grant', entityType: 'app_user', entityId: userId, details: { mailboxId: id, capability } })),
            ...r.revoked.map((capability) => ({ action: 'mailbox.access.revoke', entityType: 'app_user', entityId: userId, details: { mailboxId: id, capability } })),
          ],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- Письма и импорт

  router.get(
    '/mailboxes/:id/messages',
    query(pool, 'mail.message.list', 'mailbox', async (ctx, req, res) => {
      const m = await loadMailbox(pool, ctx, uuidParam(req, 'id', 'mailbox'));
      requireMailCap(ctx, m.id, 'mail.read', target(m.id));
      res.json({ items: (await listMailboxMessages(pool, m.id)).map(toMailMessage) });
    }),
  );

  router.get(
    '/mailboxes/:id/imports',
    query(pool, 'mail.import.list', 'mailbox', async (ctx, req, res) => {
      const m = await loadMailbox(pool, ctx, uuidParam(req, 'id', 'mailbox'));
      const caps = mailCaps(ctx, m.id);
      if (!caps.includes('mail.read') && !caps.includes('mail.import')) throw forbidden('mail.import', target(m.id));
      res.json({ items: (await listMailImports(pool, m.id)).map(toMailImport) });
    }),
  );

  const importAuthorize = async (req: Request): Promise<void> => {
    const ctx = requireCtx(req);
    const m = await loadMailbox(pool, ctx, uuidParam(req, 'id', 'mailbox'));
    requireMailCap(ctx, m.id, 'mail.import', target(m.id));
    await requireImportLink(pool, ctx, m.id, parseBody(MailImportQuery, req.query));
  };

  // Файл EML принимается хранилищем до транзакции; в транзакции — ящик, права, запись импорта и задание
  // разбора. Имя файла и тема письма в журнал не пишутся: журнал видят и те, кто письма не читает.
  router.post(
    '/mailboxes/:id/imports',
    receiveUpload({ pool, store, config, action: 'mail.import', entityType: 'mailbox', authorize: importAuthorize }),
    command(pool, {
      action: 'mail.import',
      entityType: 'mailbox',
      idempotent: true,
      requestKey: (req) => `mail-import ${req.params.id} ${uploadedBlob(req)?.sha256 ?? ''} ${JSON.stringify(req.query)}`,
      authorize: async (client, ctx, req) => {
        const m = await loadMailbox(client, ctx, uuidParam(req, 'id', 'mailbox'));
        requireMailCap(ctx, m.id, 'mail.import', target(m.id));
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'mailbox');
        const q = parseBody(MailImportQuery, req.query);
        const stored = uploadedBlob(req);
        if (!stored) throw new HttpError(400, 'VALIDATION_FAILED', 'файл не получен');
        const name = uploadName(req);
        const m = await loadMailbox(client, ctx, id, true);
        requireMailCap(ctx, id, 'mail.import', target(id));
        await requireImportLink(client, ctx, id, q);
        if (m.status !== 'active') throw new HttpError(409, 'STATE_CONFLICT', 'ящик в архиве: импорт не принимается', {}, target(id));
        if (!EML_NAME.test(name) || !looksLikeEmlHead(stored.head)) {
          throw new HttpError(400, 'VALIDATION_FAILED', 'принимается файл письма .eml (RFC 5322)', {}, target(id));
        }
        await insertBlob(client, { sha256: stored.sha256, sizeBytes: stored.sizeBytes, mediaType: 'message/rfc822', storageKey: stored.storageKey });
        const imp = await createMailImport(client, {
          mailboxId: id,
          rawSha256: stored.sha256,
          fileName: name,
          direction: q.direction,
          folder: q.folder ?? null,
          linkTenderId: q.tenderId ?? null,
          linkStageId: q.stageId ?? null,
          importedBy: ctx.principal.userId,
        });
        return {
          status: 202,
          body: toMailImport(imp),
          audit: [
            {
              action: 'mail.import',
              entityType: 'mail_import',
              entityId: imp.id,
              details: { mailboxId: id, sha256: stored.sha256, sizeBytes: stored.sizeBytes, direction: q.direction, linkTenderId: q.tenderId ?? null },
            },
          ],
        };
      },
    }),
  );

  // Исход импорта видит импортирующий и пользователи ящика с mail.read или mail.import.
  router.get(
    '/mail-imports/:id',
    query(pool, 'mail.import.read', 'mail_import', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'mail_import');
      const imp = await getMailImport(pool, id);
      const caps = imp ? mailCaps(ctx, imp.mailbox_id) : [];
      if (!imp || (imp.imported_by !== ctx.principal.userId && !caps.includes('mail.read') && !caps.includes('mail.import'))) {
        throw notFound({ entityType: 'mail_import', entityId: id });
      }
      res.json(toMailImport(imp));
    }),
  );

  return router;
};
