// Импорт (state-machines §3): import.expand разбирает загрузку (файл или ZIP) в элементы,
// import.register регистрирует элемент как редакцию или дубликат. Все записи — под арендой.
import { open } from 'node:fs/promises';
import { classifyFile, type FileVerdict } from '@kontur/core';
import {
  enqueueJob,
  failBatch,
  finalizeBatchIfDone,
  getBatch,
  getChannel,
  getItem,
  insertBlob,
  insertItem,
  markExpanded,
  registerItem,
  type INewItem,
  type OccurrenceKind,
  type PoolClient,
} from '@kontur/db';
import { BlobLimitError, HEAD_BYTES, type BlobStore } from '@kontur/storage';
import { ArchiveOpenError, readZip } from '../archive.ts';
import { PermanentJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

export const readHead = async (store: BlobStore, sha256: string): Promise<Buffer> => {
  const fh = await open(store.pathOf(sha256), 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
};

const mediaTypeOf = (v: FileVerdict): string => (v.kind === 'rejected' ? 'application/octet-stream' : v.mediaType);

// Элемент и задание его регистрации — в одной транзакции (задание не теряется при сбое).
export const addItem = async (client: PoolClient, item: INewItem): Promise<void> => {
  const r = await insertItem(client, item);
  if (item.status === 'pending') {
    await enqueueJob(client, {
      kind: 'import.register',
      dedupeKey: `import:${item.batchId}:${item.memberPath}`,
      payload: { itemId: r.id },
      tenderId: item.tenderId,
    });
  }
};

// Документ из хранилища → элемент pending или отказ по типу.
const itemFromBlob = (
  base: Pick<INewItem, 'batchId' | 'tenderId' | 'memberPath' | 'observedName'>,
  verdict: FileVerdict,
  sha256: string,
  size: number,
): INewItem => {
  if (verdict.kind === 'document') return { ...base, status: 'pending', blobSha: sha256, sizeBytes: size };
  if (verdict.kind === 'archive') {
    return { ...base, status: 'rejected', rejectReason: 'type_not_allowed', rejectDetail: 'вложенный архив не распаковывается', blobSha: sha256, sizeBytes: size };
  }
  return { ...base, status: 'rejected', rejectReason: verdict.reason, rejectDetail: verdict.detail, blobSha: sha256, sizeBytes: size };
};

const expandArchive = async (ctx: IJobContext, batchId: string, tenderId: string, archiveSha: string): Promise<void> => {
  const limits = ctx.config.limits;
  let entries = 0;
  let total = 0;
  // Повтор имени внутри одного архива — отдельный отказ, а не молчаливая потеря второго элемента.
  const seen = new Map<string, number>();
  const add = (item: INewItem): Promise<void> => ctx.withLease((client) => addItem(client, item));
  try {
    await readZip(ctx.store.pathOf(archiveSha), async (entry) => {
      ctx.throwIfStopped();
      entries += 1;
      if (entries > limits.maxArchiveEntries) {
        await add({
          batchId,
          tenderId,
          memberPath: '(элементы сверх лимита)',
          observedName: '(элементы сверх лимита)',
          status: 'rejected',
          rejectReason: 'size_limit',
          rejectDetail: `в архиве больше ${limits.maxArchiveEntries} элементов; остальные не разбирались`,
        });
        return 'stop';
      }
      const observedName = entry.memberPath.split('/').pop() ?? entry.memberPath;
      const key = entry.memberPath.toLowerCase();
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > 1) {
        const dupPath = `${entry.memberPath} (#${count})`;
        await add({ batchId, tenderId, memberPath: dupPath, observedName, status: 'rejected', rejectReason: 'corrupt', rejectDetail: 'повторяющееся имя элемента в архиве' });
        return 'continue';
      }
      const base = { batchId, tenderId, memberPath: entry.memberPath, observedName };
      if (entry.kind === 'rejected') {
        await add({ ...base, status: 'rejected', rejectReason: entry.reason, rejectDetail: entry.detail });
        return 'continue';
      }
      const ratio = entry.compressedSize > 0 ? entry.declaredSize / entry.compressedSize : 0;
      const remaining = limits.maxArchiveTotalBytes - total;
      if (entry.declaredSize > limits.maxEntryBytes || entry.declaredSize > remaining || ratio > limits.maxCompressionRatio) {
        const detail =
          ratio > limits.maxCompressionRatio ? `коэффициент сжатия ${Math.round(ratio)} выше допустимого` : `распакованный размер ${entry.declaredSize} превышает лимит`;
        await add({ ...base, status: 'rejected', rejectReason: 'size_limit', rejectDetail: detail });
        return 'continue';
      }
      // Ошибка чтения потока элемента (CRC, размер не совпал с заголовком, повреждённое сжатие) —
      // отказ corrupt этого элемента; ошибки хранилища и БД пробрасываются как сбой задания.
      let streamError: Error | null = null;
      let source;
      try {
        source = await entry.open();
      } catch (err) {
        await add({ ...base, status: 'rejected', rejectReason: 'corrupt', rejectDetail: `элемент не читается: ${(err as Error).message.slice(0, 200)}` });
        return 'continue';
      }
      source.on('error', (e: Error) => {
        streamError = e;
      });
      try {
        const stored = await ctx.store.putStream(source, Math.min(limits.maxEntryBytes, remaining));
        total += stored.sizeBytes;
        const verdict = classifyFile(entry.memberPath, stored.head, stored.sizeBytes);
        await ctx.withLease(async (client) => {
          await insertBlob(client, { sha256: stored.sha256, sizeBytes: stored.sizeBytes, mediaType: mediaTypeOf(verdict), storageKey: stored.storageKey });
          await addItem(client, itemFromBlob(base, verdict, stored.sha256, stored.sizeBytes));
        });
      } catch (err) {
        if (err instanceof BlobLimitError) {
          await add({ ...base, status: 'rejected', rejectReason: 'size_limit', rejectDetail: 'фактический размер превысил лимит при распаковке' });
        } else if (streamError) {
          await add({ ...base, status: 'rejected', rejectReason: 'corrupt', rejectDetail: `ошибка распаковки: ${(streamError as Error).message.slice(0, 200)}` });
        } else {
          throw err;
        }
      }
      return 'continue';
    });
  } catch (err) {
    if (!(err instanceof ArchiveOpenError)) throw err;
    // Повреждённый каталог архива: элементы после места сбоя неизвестны — явный отказ с исходом.
    const detail = entries > 0 ? `архив прочитан не полностью после ${entries - 1} элементов` : 'архив не читается';
    await add({ batchId, tenderId, memberPath: '(архив)', observedName: '(архив)', status: 'rejected', rejectReason: 'corrupt', rejectDetail: `${detail}: ${err.message.slice(0, 200)}` });
  }
};

export const handleImportExpand = async (ctx: IJobContext): Promise<void> => {
  const batchId = String(ctx.job.payload.batchId);
  await ctx.store.ensureDirs();
  const batch = await getBatch(ctx.pool, batchId);
  if (!batch) throw new PermanentJobError('not_found', 'партия не найдена');
  if (batch.status === 'running' && !batch.expanded_at && batch.upload_blob_sha256 && batch.upload_name) {
    const sha = batch.upload_blob_sha256;
    const size = (await ctx.pool.query<{ size_bytes: number }>('SELECT size_bytes FROM blob WHERE sha256 = $1', [sha])).rows[0]?.size_bytes ?? 0;
    const verdict = classifyFile(batch.upload_name, await readHead(ctx.store, sha), size);
    if (verdict.kind === 'archive') {
      await expandArchive(ctx, batch.id, batch.tender_id, sha);
    } else {
      await ctx.withLease((client) =>
        addItem(client, itemFromBlob({ batchId: batch.id, tenderId: batch.tender_id, memberPath: batch.upload_name!, observedName: batch.upload_name! }, verdict, sha, size)),
      );
    }
  }
  await ctx.complete(async (client) => {
    await markExpanded(client, batchId);
    await finalizeBatchIfDone(client, batchId);
  });
};

const occurrenceKindOf = (sourceKind: 'upload' | 'watched_folder', origin: string | null, isArchive: boolean): OccurrenceKind => {
  if (sourceKind === 'upload') return isArchive ? 'archive_member' : 'upload';
  if (origin === 'yandex_disk') return 'yandex_disk';
  if (origin === 'smb') return 'smb';
  return 'watched_folder';
};

export const handleImportRegister = async (ctx: IJobContext): Promise<void> => {
  const itemId = String(ctx.job.payload.itemId);
  await ctx.complete(async (client) => {
    const item = await getItem(client, itemId, true);
    if (!item) throw new PermanentJobError('not_found', 'элемент не найден');
    const batch = await getBatch(client, item.batch_id);
    if (!batch) throw new PermanentJobError('not_found', 'партия не найдена');
    if (item.status === 'pending' && batch.status === 'running') {
      const channel = batch.intake_channel_id ? await getChannel(client, batch.intake_channel_id) : null;
      const isArchive = batch.source_kind === 'upload' && batch.upload_name !== item.member_path;
      const locator =
        batch.source_kind === 'upload' ? `upload:${batch.id}/${item.member_path}` : `${channel?.locator ?? ''}/${item.member_path}`;
      await registerItem(client, item, {
        sourceKind: occurrenceKindOf(batch.source_kind, channel?.origin ?? null, isArchive),
        locator,
        channelId: batch.intake_channel_id,
        actorUserId: batch.created_by,
      });
    }
    await finalizeBatchIfDone(client, item.batch_id);
  });
};

// Терминальная ошибка разбора или регистрации: партия переводится в failed в одной транзакции
// с переводом задания (R03-05). Незавершённые элементы остаются pending — пробел виден в истории,
// событие import_accepted остаётся непокрытым.
export const importExpandHandler: IJobHandlerSpec = {
  run: handleImportExpand,
  onTerminalFailure: async (client, ctx, failure) => {
    await failBatch(client, String(ctx.job.payload.batchId), failure.code);
  },
};

export const importRegisterHandler: IJobHandlerSpec = {
  run: handleImportRegister,
  onTerminalFailure: async (client, ctx, failure) => {
    const item = await getItem(client, String(ctx.job.payload.itemId));
    if (item) await failBatch(client, item.batch_id, failure.code);
  },
};
