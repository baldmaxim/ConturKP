import { Readable } from 'node:stream';
import { MailHubReader, MailHubReadError } from '@kontur/adapters';
import {
  createMailImport,
  getMailHubConnection,
  insertBlob,
  saveMailHubPage,
  writeAudit,
} from '@kontur/db';
import {
  PermanentJobError,
  RetryableJobError,
  type IJobContext,
  type IJobHandlerSpec,
} from '../runtime.ts';

const reader = (ctx: IJobContext) => {
  const cfg = ctx.config.mailhub;
  if (!cfg)
    throw new PermanentJobError(
      'MAILHUB_NOT_CONFIGURED',
      'MailHub не настроен',
    );
  return new MailHubReader({
    ...cfg,
    maxEmlBytes: ctx.config.mail.maxEmlBytes,
  });
};
const failure = (error: unknown): never => {
  if (error instanceof MailHubReadError) {
    if (error.retryable) throw new RetryableJobError(error.code, error.message);
    throw new PermanentJobError(error.code, error.message);
  }
  throw error;
};
export const mailhubSyncHandler: IJobHandlerSpec = {
  async run(ctx) {
    const api = reader(ctx);
    const key = String(ctx.job.payload.sourceKey);
    if (api.sourceKey !== key)
      throw new PermanentJobError(
        'MAILHUB_SOURCE_CHANGED',
        'Источник MailHub изменился',
      );
    const connection = await getMailHubConnection(ctx.pool, key);
    if (!connection?.enabled) {
      await ctx.complete();
      return;
    }
    try {
      const page = await api.changes(
        connection.cursor,
        connection.since_at?.toISOString() ?? null,
        ctx.signal,
      );
      if (
        page.items.some((item) =>
          item.copies.some(
            (copy) => !connection.allowed_mailboxes.includes(copy.mailboxId),
          ),
        )
      )
        throw new PermanentJobError(
          'MAILHUB_SCOPE_CHANGED',
          'Состав ящиков требует явного переподключения',
        );
      if (
        page.hasMore &&
        (!page.items.length ||
          !page.nextCursor ||
          page.nextCursor === connection.cursor)
      )
        throw new PermanentJobError(
          'MAILHUB_CURSOR_STALLED',
          'Курсор MailHub не продвинулся',
        );
      await ctx.complete(async (db) => {
        await saveMailHubPage(db, key, page);
      });
    } catch (error) {
      failure(error);
    }
  },
  async onTerminalFailure(db, ctx, error) {
    await db.query(
      "UPDATE mailhub_connection SET next_poll_at=now()+interval '1 minute',last_error_code=$2 WHERE source_key=$1",
      [String(ctx.job.payload.sourceKey), error.code],
    );
    await db.query(
      "UPDATE integration_status SET last_checked_at=now(),last_error_code=$1 WHERE system='mailhub'",
      [error.code],
    );
  },
};
export const mailhubFetchHandler: IJobHandlerSpec = {
  async run(ctx) {
    const api = reader(ctx);
    const key = String(ctx.job.payload.sourceKey),
      itemId = String(ctx.job.payload.itemId);
    if (api.sourceKey !== key)
      throw new PermanentJobError(
        'MAILHUB_SOURCE_CHANGED',
        'Источник MailHub изменился',
      );
    const connection = await getMailHubConnection(ctx.pool, key);
    const source = (
      await ctx.pool.query<{
        import_id: string | null;
        skipped: boolean;
        copies: Array<{ mailbox: string; folder: string; role: string }>;
      }>(
        "SELECT import_id,copies,retry_after='infinity'::timestamptz AS skipped FROM mailhub_message WHERE source_key=$1 AND external_id=$2",
        [key, itemId],
      )
    ).rows[0];
    if (!connection?.enabled || !source || source.import_id || source.skipped) {
      await ctx.complete();
      return;
    }
    try {
      const raw = await api.eml(itemId, ctx.signal);
      ctx.throwIfStopped();
      const stored = await ctx.store.putStream(
        Readable.from([raw]),
        ctx.config.mail.maxEmlBytes,
      );
      await ctx.complete(async (db) => {
        if (!(await getMailHubConnection(db, key))?.enabled) return;
        const locked = (
          await db.query<{ import_id: string | null; skipped: boolean }>(
            "SELECT import_id,retry_after='infinity'::timestamptz AS skipped FROM mailhub_message WHERE source_key=$1 AND external_id=$2 FOR UPDATE",
            [key, itemId],
          )
        ).rows[0];
        if (!locked || locked.import_id || locked.skipped) return;
        await insertBlob(db, { ...stored, mediaType: 'message/rfc822' });
        const imported = await createMailImport(db, {
          mailboxId: connection.mailbox_id,
          rawSha256: stored.sha256,
          fileName: `mailhub-${itemId}.eml`,
          direction: source.copies.some((x) => x.role === 'sent')
            ? 'outbound'
            : 'inbound',
          folder: null,
          linkTenderId: null,
          linkStageId: null,
          importedBy: connection.actor_user_id,
        });
        await db.query(
          'UPDATE mailhub_message SET import_id=$3,failure_code=NULL WHERE source_key=$1 AND external_id=$2',
          [key, itemId, imported.id],
        );
        await writeAudit(db, {
          actorUserId: connection.actor_user_id,
          principalKind: 'integration',
          action: 'mailhub.capture',
          entityType: 'mail_import',
          entityId: imported.id,
          outcome: 'allowed',
          details: { sourceKey: key, sourceItemId: itemId },
        });
      });
    } catch (error) {
      failure(error);
    }
  },
  async onTerminalFailure(db, ctx, error) {
    await db.query(
      "UPDATE mailhub_message SET failure_code=$3,retry_after=now()+make_interval(secs=>$4::int) WHERE source_key=$1 AND external_id=$2 AND import_id IS NULL AND isfinite(retry_after)",
      [
        String(ctx.job.payload.sourceKey),
        String(ctx.job.payload.itemId),
        error.code,
        error.code === 'ORIGINAL_NOT_AVAILABLE' ? 3600 :
          ['UNAVAILABLE', 'TIMEOUT', 'EMPTY_RESPONSE', 'HTTP_409', 'HTTP_429'].includes(error.code) || /^HTTP_5\d\d$/.test(error.code) ? 60 : 86400,
      ],
    );
  },
};
