// Импорт экспортного архива RDWeb (state-machines §4). Задание читает локальный ZIP,
// разбирает его чистым адаптером и одной транзакцией пишет страницы, фрагменты,
// происхождение и терминальный статус прогона вместе с событием барьера.
// Класс ресурса — default: распознавание выполнил RDWeb, портал только принимает результат,
// поэтому единственный слот GPU (ADR-004) этим заданием не занимается.
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { classifyMember, importRdwebExport, pickMember, type IRdwebArchive } from '@kontur/adapters';
import {
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
import { PermanentJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

class MetadataTooLargeError extends Error {}

const readAll = async (source: Readable, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      source.destroy();
      throw new MetadataTooLargeError(`элемент архива больше ${maxBytes} байт`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const hashOf = async (source: Readable): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of source) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

// Чтение архива в структуру адаптера: сам адаптер ZIP не открывает и в файловую систему
// не ходит. Небезопасный элемент (выход за корень, ссылка, шифрование) отменяет весь
// импорт: доказательство из такого архива принимать нельзя (A38).
export const readRdwebArchive = async (ctx: IJobContext, sha256: string): Promise<IRdwebArchive> => {
  const maxMeta = ctx.config.recognition.maxMetadataBytes;
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
      if (entry.kind === 'rejected') {
        archive.unsafe.push({ memberPath: entry.memberPath, detail: `${entry.reason}: ${entry.detail}` });
        return 'stop';
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
        pdfs.set(entry.memberPath, { score, sha256: await hashOf(await entry.open()) });
        return 'continue';
      }
      if (entry.declaredSize > maxMeta) throw new MetadataTooLargeError(`${entry.memberPath}: ${entry.declaredSize} байт`);
      const text = (await readAll(await entry.open(), maxMeta)).toString('utf8');
      if (role === 'blocks_json') jsons.set(entry.memberPath, { score, text });
      else mds.set(entry.memberPath, { score, text });
      return 'continue';
    });
  } catch (err) {
    if (err instanceof MetadataTooLargeError) throw new PermanentJobError('too_large', err.message);
    if (!(err instanceof ArchiveOpenError)) throw err;
    archive.corrupt = err.message;
    return archive;
  }
  const asCandidates = (m: Map<string, { score: number }>) => [...m].map(([memberPath, v]) => ({ memberPath, score: v.score }));
  const pdf = pickMember(asCandidates(pdfs));
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

  const archive = await readRdwebArchive(ctx, run.source_artifact_sha256);
  // Ожидание — SHA-256 зарегистрированной редакции: чужой или старый результат не принимается.
  const result = importRdwebExport({
    archive,
    expect: { pdfSha256: run.revision_blob_sha256 },
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
};
