// Разбор импорта EML (этап 07, D-025: AD-07-3, AD-07-2a, OD-07-7). Письмо — копия в ящике импорта;
// принятые вложения — документы с владельцем-вложением, их распознаёт общий путь 05a (автопроход
// DOCX/XLSX/CSV, PDF — командой). Отклонённое вложение хранит метаданные и хэш без байтов.
// Детерминированный отказ разбора — failed с причиной, без повторов (PermanentJobError).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { communicationGroupKey, DEFAULT_MAIL_LIMITS, MailParseError, mailIdentity, parseEml } from '@kontur/adapters';
import { classifyFile } from '@kontur/core';
import {
  enqueueLiveIndexBuilds,
  failMailImport,
  finishMailImport,
  getMailImport,
  insertBlob,
  linkMessage,
  persistMailRevision,
  type IMailAttachmentInput,
} from '@kontur/db';
import { HEAD_BYTES } from '@kontur/storage';
import { PermanentJobError, type IJobHandlerSpec } from '../runtime.ts';

// Длинный блок тела письма делится на части этого размера без потери текста (как фрагменты 05a).
const MAIL_FRAGMENT_CHARS = 20_000;

export const mailImportHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const importId = String(ctx.job.payload.importId);
    const imp = await getMailImport(ctx.pool, importId);
    if (!imp || imp.status !== 'queued') {
      await ctx.complete();
      return;
    }
    const raw = await readFile(ctx.store.pathOf(imp.raw_blob_sha256));
    let parsed;
    try {
      parsed = await parseEml(raw, { ...DEFAULT_MAIL_LIMITS, maxRawBytes: ctx.config.mail.maxEmlBytes });
    } catch (err) {
      if (err instanceof MailParseError) throw new PermanentJobError(`mail_${err.code}`, err.message);
      throw err;
    }
    ctx.throwIfStopped();
    // Вложения: тип — по содержимому (A38), а не по заявленному в письме; принятые байты — в хранилище
    // до транзакции (хранилище идемпотентно по SHA-256, лишний объект безвреден).
    const attachments: IMailAttachmentInput[] = [];
    const blobs: { sha256: string; sizeBytes: number; mediaType: string; storageKey: string }[] = [];
    for (const a of parsed.attachments) {
      const sha256 = createHash('sha256').update(a.bytes).digest('hex');
      const base = {
        ordinal: a.ordinal,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.bytes.length,
        sha256,
        disposition: a.disposition,
        contentId: a.contentId,
      };
      if (a.bytes.length > Math.min(ctx.config.mail.maxAttachmentBytes, ctx.config.limits.maxUploadBytes)) {
        attachments.push({ ...base, status: 'rejected', rejectReason: 'size_limit' });
        continue;
      }
      const verdict = classifyFile(a.filename, a.bytes.subarray(0, HEAD_BYTES), a.bytes.length);
      if (verdict.kind !== 'document') {
        attachments.push({ ...base, status: 'rejected', rejectReason: verdict.kind === 'archive' ? 'type_not_allowed' : verdict.reason });
        continue;
      }
      await ctx.store.ensureDirs();
      const stored = await ctx.store.putStream(Readable.from([a.bytes]), ctx.config.limits.maxUploadBytes);
      blobs.push({ sha256: stored.sha256, sizeBytes: stored.sizeBytes, mediaType: verdict.mediaType, storageKey: stored.storageKey });
      attachments.push({ ...base, status: 'registered', rejectReason: null });
    }
    const identity = mailIdentity({ messageId: parsed.messageId, rawSha256: imp.raw_blob_sha256 });
    await ctx.complete(async (client) => {
      const fresh = await getMailImport(client, importId, true);
      if (!fresh || fresh.status !== 'queued') return;
      for (const b of blobs) await insertBlob(client, b);
      const r = await persistMailRevision(client, {
        mailboxId: imp.mailbox_id,
        identity,
        groupKey: communicationGroupKey(parsed.messageId),
        rawSha256: imp.raw_blob_sha256,
        messageIdHeader: parsed.messageId,
        subject: parsed.subject,
        sentAt: parsed.sentAt,
        fromAddress: parsed.from?.address ?? null,
        participants: parsed.participants,
        direction: imp.direction,
        folder: imp.folder,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        source: 'eml_import',
        sourceItemId: null,
        warnings: parsed.warnings,
        blocks: parsed.blocks,
        attachments,
        importedBy: imp.imported_by,
        maxFragmentChars: MAIL_FRAGMENT_CHARS,
      });
      await finishMailImport(client, importId, { messageId: r.messageId, revisionId: r.revisionId, created: r.created });
      // Связь, заданная при импорте, подтверждена импортирующим (mail.link и source.write проверены командой).
      if (imp.link_tender_id) {
        await linkMessage(client, { messageId: r.messageId, tenderId: imp.link_tender_id, stageId: imp.link_stage_id, userId: imp.imported_by });
      }
      if (r.created) await enqueueLiveIndexBuilds(client);
    });
  },
  onTerminalFailure: async (client, ctx, failure) => {
    await failMailImport(client, String(ctx.job.payload.importId), failure.code, failure.message);
  },
};
