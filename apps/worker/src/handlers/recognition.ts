// Импорт экспортного архива RDWeb (state-machines §4). Задание читает локальный ZIP,
// разбирает его чистым адаптером и одной транзакцией пишет страницы, фрагменты,
// происхождение и терминальный статус прогона вместе с событием барьера.
// Класс ресурса — default: распознавание выполнил RDWeb, портал только принимает результат,
// поэтому единственный слот GPU (ADR-004) этим заданием не занимается.
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { classifyMember, importRdwebExport, pickMember, type IRdwebArchive } from '@kontur/adapters';
import {
  cancelRun,
  emitStageEvents,
  failRun,
  finishRun,
  getRun,
  insertFragments,
  insertOccurrence,
  insertPages,
  lockTenderStages,
  stagesAffectedByRevision,
  startRun,
} from '@kontur/db';
import { ArchiveOpenError, readZip } from '../archive.ts';
import { PdfTooLargeError, PdfUnreadableError, pdfPageCount } from '../pdfPages.ts';
import { PermanentJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

// Отказ архива по ресурсному контуру: тот же набор ограничений, что у обычного импорта
// (A38, R04-01). Отказ терминальный — доказательство из такого архива принимать нельзя.
class ArchiveRejectedError extends Error {
  readonly code: 'too_large' | 'archive_corrupt';
  constructor(code: 'too_large' | 'archive_corrupt', message: string) {
    super(message);
    this.code = code;
  }
}

const readAll = async (source: Readable, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      source.destroy();
      throw new ArchiveRejectedError('too_large', `элемент архива больше ${maxBytes} байт`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

// Хеш PDF считается потоково и с верхней границей: без неё огромный член архива занимал бы
// worker распаковкой, а заявленному размеру из каталога верить нельзя (R04-01).
const hashOf = async (source: Readable, maxBytes: number): Promise<{ sha256: string; bytes: number }> => {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of source) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      source.destroy();
      throw new ArchiveRejectedError('too_large', `элемент архива больше ${maxBytes} байт`);
    }
    hash.update(chunk as Buffer);
  }
  return { sha256: hash.digest('hex'), bytes: size };
};

// Чтение архива в структуру адаптера: сам адаптер ZIP не открывает и в файловую систему
// не ходит. Небезопасный элемент (выход за корень, ссылка, шифрование) отменяет весь
// импорт: доказательство из такого архива принимать нельзя (A38).
export const readRdwebArchive = async (ctx: IJobContext, sha256: string, expectPdfSha256: string): Promise<IRdwebArchive> => {
  const limits = ctx.config.limits;
  const maxMeta = ctx.config.recognition.maxMetadataBytes;
  const maxMetaTotal = ctx.config.recognition.maxMetadataTotalBytes;
  // Ресурсный контур архива — тот же, что у обычного импорта (apps/worker/src/handlers/imports.ts):
  // число элементов, размер элемента, суммарный распакованный объём и коэффициент сжатия.
  let entries = 0;
  let unpacked = 0;
  let metadataBytes = 0;
  const seen = new Set<string>();
  const archive: IRdwebArchive = {
    pdf: null,
    blocksJson: null,
    resultsMd: null,
    resultsHtmlPresent: false,
    extras: [],
    ignored: [],
    unsafe: [],
    corrupt: null,
  };
  const pdfs = new Map<string, { score: number; sha256: string }>();
  const jsons = new Map<string, { score: number; text: string }>();
  const mds = new Map<string, { score: number; text: string }>();
  try {
    await readZip(ctx.store.pathOf(sha256), async (entry) => {
      ctx.throwIfStopped();
      entries += 1;
      if (entries > limits.maxArchiveEntries) {
        throw new ArchiveRejectedError('too_large', `в архиве больше ${limits.maxArchiveEntries} элементов`);
      }
      if (entry.kind === 'rejected') {
        archive.unsafe.push({ memberPath: entry.memberPath, detail: `${entry.reason}: ${entry.detail}` });
        return 'stop';
      }
      // Повтор имени не должен молча перезаписывать кандидата: какой из двух членов архива
      // стал доказательством, было бы невозможно объяснить (R04-01).
      const key = entry.memberPath.toLowerCase();
      if (seen.has(key)) throw new ArchiveRejectedError('archive_corrupt', `повторяющееся имя элемента в архиве: ${entry.memberPath}`);
      seen.add(key);
      const ratio = entry.compressedSize > 0 ? entry.declaredSize / entry.compressedSize : 0;
      if (ratio > limits.maxCompressionRatio) {
        throw new ArchiveRejectedError('too_large', `${entry.memberPath}: коэффициент сжатия ${Math.round(ratio)} выше допустимого`);
      }
      const remaining = limits.maxArchiveTotalBytes - unpacked;
      if (entry.declaredSize > limits.maxEntryBytes) {
        throw new ArchiveRejectedError('too_large', `${entry.memberPath}: распакованный размер ${entry.declaredSize} превышает лимит элемента`);
      }
      if (entry.declaredSize > remaining) {
        throw new ArchiveRejectedError('too_large', `суммарный распакованный размер архива превышает ${limits.maxArchiveTotalBytes} байт`);
      }
      const { role, score } = classifyMember(entry.memberPath);
      if (role === 'other') {
        archive.extras.push(entry.memberPath);
        return 'continue';
      }
      if (role === 'results_html') {
        archive.resultsHtmlPresent = true;
        return 'continue';
      }
      if (role === 'pdf') {
        const read = await hashOf(await entry.open(), Math.min(limits.maxEntryBytes, remaining));
        unpacked += read.bytes;
        pdfs.set(entry.memberPath, { score, sha256: read.sha256 });
        return 'continue';
      }
      if (entry.declaredSize > maxMeta) throw new ArchiveRejectedError('too_large', `${entry.memberPath}: ${entry.declaredSize} байт`);
      // Отдельный бюджет памяти: кандидатов на роль может быть много, и лимита одного файла мало.
      const metaRemaining = maxMetaTotal - metadataBytes;
      if (entry.declaredSize > metaRemaining) {
        throw new ArchiveRejectedError('too_large', `суммарный объём metadata-элементов превышает ${maxMetaTotal} байт`);
      }
      const buf = await readAll(await entry.open(), Math.min(maxMeta, metaRemaining));
      metadataBytes += buf.length;
      unpacked += buf.length;
      const text = buf.toString('utf8');
      if (role === 'blocks_json') jsons.set(entry.memberPath, { score, text });
      else mds.set(entry.memberPath, { score, text });
      return 'continue';
    });
  } catch (err) {
    if (err instanceof ArchiveRejectedError) throw new PermanentJobError(err.code, err.message);
    if (!(err instanceof ArchiveOpenError)) throw err;
    archive.corrupt = err.message;
    return archive;
  }
  const asCandidates = (m: Map<string, { score: number }>) => [...m].map(([memberPath, v]) => ({ memberPath, score: v.score }));
  // Если PDF в архиве несколько, выигрывает тот, что совпал с зарегистрированной редакцией:
  // иначе верный результат отклонялся бы из-за порядка членов архива. Ни одного совпавшего —
  // берём обычного кандидата, и импорт честно закончится отказом pdf_mismatch.
  const matched = [...pdfs].find(([, v]) => v.sha256 === expectPdfSha256) ?? null;
  const pdf = matched
    ? { chosen: { memberPath: matched[0], score: 2 }, ignored: [...pdfs.keys()].filter((p) => p !== matched[0]) }
    : pickMember(asCandidates(pdfs));
  const json = pickMember(asCandidates(jsons));
  const md = pickMember(asCandidates(mds));
  archive.pdf = pdf.chosen ? { memberPath: pdf.chosen.memberPath, sha256: pdfs.get(pdf.chosen.memberPath)!.sha256 } : null;
  archive.blocksJson = json.chosen ? jsons.get(json.chosen.memberPath)!.text : null;
  archive.resultsMd = md.chosen ? mds.get(md.chosen.memberPath)!.text : null;
  archive.ignored = [...pdf.ignored, ...json.ignored, ...md.ignored];
  return archive;
};

export const handleRecognitionImport = async (ctx: IJobContext): Promise<void> => {
  const runId = String(ctx.job.payload.runId);
  const run = await getRun(ctx.pool, runId);
  if (!run) throw new PermanentJobError('not_found', 'прогон распознавания не найден');
  // Повторный захват уже завершённого прогона: результат записан, задание просто закрывается.
  if (run.status !== 'queued' && run.status !== 'running') {
    await ctx.complete();
    return;
  }
  await ctx.withLease((client) => startRun(client, runId));

  const archive = await readRdwebArchive(ctx, run.source_artifact_sha256, run.revision_blob_sha256);
  // Полнота меряется по фактическому числу страниц оригинала, а не по составу экспорта (R04-03).
  // Повреждённый и небезопасный архив отклоняет адаптер, и называет он именно архив,
  // поэтому оригинал в таком случае не читается вовсе.
  const archiveReadable = archive.corrupt === null && archive.unsafe.length === 0;
  let pageCount = 0;
  if (archiveReadable) {
    try {
      pageCount = await pdfPageCount(ctx.store.pathOf(run.revision_blob_sha256), ctx.config.recognition.maxPdfBytes);
    } catch (err) {
      if (err instanceof PdfTooLargeError) throw new PermanentJobError('too_large', err.message);
      if (err instanceof PdfUnreadableError) throw new PermanentJobError('pdf_unreadable', err.message);
      throw err;
    }
  }
  // Ожидание — SHA-256 зарегистрированной редакции: чужой или старый результат не принимается.
  const result = importRdwebExport({
    archive,
    expect: { pdfSha256: run.revision_blob_sha256, pdfPageCount: pageCount },
    limits: { maxTotalTextChars: ctx.config.recognition.maxTotalTextChars },
  });
  if (!result.ok) throw new PermanentJobError(result.error.code, result.error.message);
  const value = result.value;

  await ctx.complete(async (client) => {
    // Порядок блокировок §1.2: сначала этапы тендера, затем строка прогона.
    const stageIds = await stagesAffectedByRevision(client, run.tender_id, run.document_revision_id);
    await lockTenderStages(client, run.tender_id, stageIds);
    const fresh = await getRun(client, runId, true);
    if (!fresh || fresh.status !== 'running') return;

    await insertPages(client, runId, value.pages);
    await insertFragments(
      client,
      { runId, tenderId: run.tender_id, documentRevisionId: run.document_revision_id },
      value.fragments.map((f) => ({ ...f, warnings: f.warnings })),
    );
    await insertOccurrence(client, {
      documentRevisionId: run.document_revision_id,
      tenderId: run.tender_id,
      sourceKind: 'rdweb_export',
      locator: `rdweb_export:${runId}/${archive.pdf?.memberPath ?? ''}`,
      observedName: run.source_artifact_name ?? 'export.zip',
    });
    await finishRun(client, runId, {
      status: value.status,
      engineSchemaVersion: value.schemaVersion,
      pagesTotal: value.pagesTotal,
      pagesRecognized: value.pagesRecognized,
      quality: {
        documentName: value.documentName,
        coordinateSpace: value.coordinateSpace,
        counts: value.counts,
        warnings: value.warnings,
        archive: { pdfMember: archive.pdf?.memberPath ?? null, extras: archive.extras, ignored: archive.ignored },
      },
    });
    await emitStageEvents(client, {
      tenderId: run.tender_id,
      stageIds,
      eventType: 'recognition_run_completed',
      refType: 'recognition_run',
      refId: runId,
      actorUserId: run.created_by,
    });
  });
};

export const recognitionImportHandler: IJobHandlerSpec = {
  run: handleRecognitionImport,
  onTerminalFailure: async (client, ctx, failure) => {
    await failRun(client, String(ctx.job.payload.runId), failure.code, failure.message);
  },
  // Отмена задания обязана терминализовать и прогон: иначе он навсегда остаётся running,
  // блокирует заморозку состава и держит пару «редакция + архив» (R04-02).
  onCancel: async (client, ctx) => {
    await cancelRun(client, String(ctx.job.payload.runId));
  },
};
