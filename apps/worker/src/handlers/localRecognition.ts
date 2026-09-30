// Задание recognition.local (этап 05a, D-014, D-024): локальное распознавание редакции в форматах
// вне охвата RDWeb. Класс default, приоритет 5 (ADR-004 §7a–7b); отмена и потеря аренды проверяются
// между страницами; страницы, фрагменты, итог, событие барьера и дочитывание индекса — одной
// финальной транзакцией по протоколу этапа 04. Распознаватель при выполнении обязан совпасть
// с записанным в прогон: иначе прогон не выдаёт себя за результат другой конфигурации (AD-05a-2).
import { readFile, stat } from 'node:fs/promises';
import {
  describeLocalRecognizer,
  LocalRecognitionError,
  localSettings,
  outcomeOf,
  recognizeLocal,
  type ILocalResult,
  type LocalInputFormat,
} from '@kontur/adapters';
import { sha256Hex } from '@kontur/core';
import {
  cancelRun,
  emitStageEvents,
  enqueueLiveIndexBuilds,
  failLocalRun,
  failRun,
  finishRun,
  getRun,
  insertFragments,
  insertPages,
  lockTenderStages,
  recognizerFingerprint,
  stagesAffectedByRevision,
  stagesIncludingRevision,
  startRun,
} from '@kontur/db';
import { PermanentJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

// Качество прогона — метрики и признаки единиц без текста документа (утечки к contract.manage
// без contract.read через качество нет: имена листов лежат в страницах, которые читаются с правом).
const qualityOf = (r: ILocalResult, verdict: string, timings: Record<string, number>): Record<string, unknown> => ({
  verdict,
  units: r.units.map((u) => ({ index: u.index, kind: u.kind, status: u.status, method: u.method, metrics: u.metrics, issues: u.issues })),
  counts: {
    units: r.units.length,
    recognized: r.units.filter((u) => u.status === 'recognized').length,
    needsReview: r.units.filter((u) => u.status === 'needs_review').length,
    missing: r.units.filter((u) => u.status === 'missing').length,
    failed: r.units.filter((u) => u.status === 'failed').length,
    fragments: r.fragments.length,
  },
  skipped: r.skipped,
  facts: r.facts,
  timings,
});

export const localRecognitionHandler: IJobHandlerSpec = {
  run: async (ctx: IJobContext): Promise<void> => {
    const runId = String(ctx.job.payload.runId);
    const run = await getRun(ctx.pool, runId);
    if (!run) throw new PermanentJobError('not_found', 'прогон распознавания не найден');
    if (run.status !== 'queued' && run.status !== 'running') {
      await ctx.complete();
      return;
    }
    const format = (run.recognizer?.inputFormat ?? '') as LocalInputFormat;
    const settings = localSettings(ctx.config, ctx.localOcr);
    const descriptor = await describeLocalRecognizer(format, settings);
    if ((await recognizerFingerprint(ctx.pool, descriptor)) !== run.recognizer_fingerprint) {
      throw new PermanentJobError('recognizer_changed', 'распознаватель или его конфигурация изменились после постановки: нужна новая постановка');
    }
    await ctx.withLease((client) => startRun(client, runId));
    const limits = settings.limitsFor(format);
    const path = ctx.store.pathOf(run.revision_blob_sha256);
    const size = (await stat(path)).size;
    if (size > limits.maxInputBytes) throw new PermanentJobError('too_large', `оригинал ${size} байт больше предела ${limits.maxInputBytes}`);
    const started = Date.now();
    let result: ILocalResult;
    try {
      result = await recognizeLocal({
        format,
        bytes: await readFile(path),
        limits,
        ocr: settings.ocr,
        ocrDpi: settings.ocrDpi,
        ocrPageTimeoutMs: settings.ocrPageTimeoutMs,
        throwIfStopped: ctx.throwIfStopped,
      });
    } catch (err) {
      if (err instanceof LocalRecognitionError) throw new PermanentJobError(err.code, err.message);
      throw err;
    }
    const outcome = outcomeOf(result);
    const timings = { totalMs: Date.now() - started };
    if (outcome.status === 'failed') {
      // Пригодного текста нет: прогон — failed с диагностикой единиц, задание выполнено (OD-6).
      await ctx.complete(async (client) => {
        const fresh = await getRun(client, runId, true);
        if (fresh?.status === 'running') await failLocalRun(client, runId, outcome.code, outcome.detail, qualityOf(result, 'failed', timings));
      });
      return;
    }
    await ctx.complete(async (client) => {
      // Порядок блокировок §1.2: этапы, затем строка прогона. Редакция договора затрагивает только
      // этапы, куда её явно включили (интерпретация 7 этапа 06a).
      const affected = run.tender_id
        ? [{ tenderId: run.tender_id, stageIds: await stagesAffectedByRevision(client, run.tender_id, run.document_revision_id) }]
        : await stagesIncludingRevision(client, run.document_revision_id);
      for (const a of affected) await lockTenderStages(client, a.tenderId, a.stageIds);
      const fresh = await getRun(client, runId, true);
      if (!fresh || fresh.status !== 'running') return;
      await insertPages(
        client,
        runId,
        result.units.map((u) => ({
          pageIndex: u.index,
          pageLabel: u.label,
          sheetLabel: null,
          widthPx: u.widthPx,
          heightPx: u.heightPx,
          rotation: u.rotation,
          status: u.status,
          unitKind: u.kind,
        })),
      );
      await insertFragments(
        client,
        { runId, tenderId: run.tender_id, contractId: run.contract_id, documentRevisionId: run.document_revision_id },
        result.fragments.map((f) => ({
          origin: f.origin,
          fragmentKind: 'text_block',
          fragmentKey: f.key,
          externalBlockId: null,
          ordinal: f.ordinal,
          pageIndex: f.unitIndex,
          bboxNorm: null,
          bboxSpace: null,
          shapeType: null,
          polygonNorm: null,
          rotation: null,
          text: f.text,
          textSha256: sha256Hex(f.text),
          derivedModelRef: null,
          externalCropUrl: null,
          warnings: f.warnings,
          partIndex: f.partIndex,
          partTotal: f.partTotal,
          locator: f.locator,
        })),
      );
      await finishRun(client, runId, {
        status: outcome.status,
        engineSchemaVersion: `${descriptor.recognizerId}@${descriptor.recognizerVersion}/${descriptor.processing}`.slice(0, 40),
        pagesTotal: outcome.pagesTotal,
        pagesRecognized: outcome.pagesRecognized,
        quality: qualityOf(result, outcome.status === 'complete' ? 'complete' : 'needs_review', timings),
      });
      for (const a of affected) {
        await emitStageEvents(client, {
          tenderId: a.tenderId,
          stageIds: a.stageIds,
          eventType: 'recognition_run_completed',
          refType: 'recognition_run',
          refId: runId,
          actorUserId: run.created_by,
        });
      }
      await enqueueLiveIndexBuilds(client);
    });
  },
  onTerminalFailure: async (client, ctx, failure) => {
    await failRun(client, String(ctx.job.payload.runId), failure.code, failure.message);
  },
  onCancel: async (client, ctx) => {
    await cancelRun(client, String(ctx.job.payload.runId));
  },
};
