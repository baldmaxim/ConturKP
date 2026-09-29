// Задания поиска (ADR-012 §14–15, ADR-004 §7a): пачки индексации версии, удаление данных
// выведенной версии и смысловая ветка прогона поиска. Индексация — ограниченные пачки: шаг не
// держит полосу и слот GPU долго, следующая пачка ставится в той же транзакции (хук then).
import {
  buildPageChunks,
  chunkText,
  embeddingInput,
  modelFingerprint,
  sha256Hex,
  templateOfInputVersion,
  type IChunkSourceFragment,
  type ISkippedFragment,
} from '@kontur/core';
import {
  activateVersion,
  cacheLookup,
  cacheStore,
  chunksWithoutVectors,
  completeSemantic,
  degradeSemantic,
  enqueueIndexBuild,
  enqueueIndexEmbed,
  fragmentsForIndex,
  getSearchRun,
  getVersion,
  indexUnit,
  insertChunkVectors,
  markSemanticRunning,
  noteModelSuccess,
  purgeVersion,
  queryEmbeddingKey,
  recordModelStatus,
  unitsMissingInVersion,
  type IUnitChunks,
} from '@kontur/db';
import { PermanentJobError, RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

const LIVE = new Set(['building', 'active']);

const tryActivate = async (ctx: IJobContext, versionId: string): Promise<void> => {
  const v = await getVersion(ctx.pool, versionId);
  if (v?.status === 'building') await activateVersion(ctx.pool, versionId);
};

// ---------------------------------------------------------------- index.build

// Страница прогона → чанки (packages/core, buildPageChunks); фрагменты без страницы — отдельная
// «страница x». Единица индексируется целиком одной транзакцией под арендой.
const chunkUnit = (rows: Awaited<ReturnType<typeof fragmentsForIndex>>) => {
  const byPage = new Map<number | null, IChunkSourceFragment[]>();
  for (const r of rows) {
    const list = byPage.get(r.page_index) ?? [];
    list.push({ id: r.id, origin: r.origin, kind: r.fragment_kind, text: r.text });
    byPage.set(r.page_index, list);
  }
  const pages: IUnitChunks[] = [];
  const indexed: string[] = [];
  const skipped: ISkippedFragment[] = [];
  for (const [pageIndex, fragments] of byPage) {
    const built = buildPageChunks(fragments);
    pages.push({ pageIndex, chunks: built.chunks });
    indexed.push(...built.indexed);
    skipped.push(...built.skipped);
  }
  return { pages, indexed, skipped };
};

export const indexBuildHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const versionId = String(ctx.job.payload.versionId);
    const v = await getVersion(ctx.pool, versionId);
    if (!v || !LIVE.has(v.status)) {
      await ctx.complete();
      return;
    }
    const units = await unitsMissingInVersion(ctx.pool, versionId, ctx.config.search.indexBuildUnitsPerBatch);
    for (const unit of units) {
      ctx.throwIfStopped();
      const { pages, indexed, skipped } = chunkUnit(await fragmentsForIndex(ctx.pool, unit.id));
      await ctx.withLease(async (client) => {
        const r = await indexUnit(client, versionId, unit, pages, indexed, skipped);
        // Зависимость build → embed (G05-01): чанки появились — векторная пачка встаёт в очередь
        // той же транзакцией. Если пачка уже выполняется, её хук then увидит новые чанки.
        if (r.chunks > 0 && v.embedding_model && ctx.embeddings) await enqueueIndexEmbed(client, versionId);
      });
    }
    await ctx.complete(undefined, async (client) => {
      if ((await unitsMissingInVersion(client, versionId, 1)).length > 0) await enqueueIndexBuild(client, versionId);
    });
    await tryActivate(ctx, versionId);
  },
};

// ---------------------------------------------------------------- index.embed

export const indexEmbedHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const versionId = String(ctx.job.payload.versionId);
    const v = await getVersion(ctx.pool, versionId);
    if (!v || !LIVE.has(v.status) || !v.embedding_model || !ctx.embeddings) {
      await ctx.complete();
      return;
    }
    // Модель провайдера обязана совпадать с моделью версии: чужие векторы в версию не пишутся.
    const e = ctx.embeddings;
    if (modelFingerprint(e.model, v.embedding_dim!, e.revision) !== v.embedding_model_fingerprint) {
      await recordModelStatus(ctx.pool, { ok: false, errorCode: 'model_fingerprint_mismatch', verification: 'VERIFIED_FIXTURE', details: { model: e.model } });
      throw new PermanentJobError('model_fingerprint_mismatch', 'модель провайдера не совпадает с моделью версии индекса');
    }
    const chunks = await chunksWithoutVectors(ctx.pool, versionId, e.batchSize);
    const template = templateOfInputVersion(v.embedding_input_version!);
    const key = { purpose: 'index' as const, model: v.embedding_model, fingerprint: v.embedding_model_fingerprint!, inputVersion: v.embedding_input_version!, dim: v.embedding_dim! };
    const inputs = chunks.map((c) => embeddingInput(template, 'index', chunkText({ headerText: c.header_text, bodyText: c.body_text })));
    const shas = inputs.map(sha256Hex);
    const cached = await cacheLookup(ctx.pool, key, shas);
    const missing = inputs.map((text, i) => ({ text, i })).filter((x) => !cached.has(shas[x.i]!));
    const fresh = new Map<string, number[]>();
    if (missing.length > 0) {
      const r = await e.embed({ texts: missing.map((m) => m.text), purpose: 'index', signal: ctx.signal });
      if (!r.ok) {
        await recordModelStatus(ctx.pool, { ok: false, errorCode: r.error.reason, verification: 'VERIFIED_FIXTURE', details: { code: r.error.code } });
        if (r.error.retryable) throw new RetryableJobError(r.error.reason, r.error.message);
        throw new PermanentJobError(r.error.reason, r.error.message);
      }
      // Размерность проверяется до записи: против версии индекса (ADR-012 §6, §25).
      if (r.value.dim !== v.embedding_dim) {
        await recordModelStatus(ctx.pool, { ok: false, errorCode: 'dimension_mismatch', verification: 'VERIFIED_FIXTURE', details: { dim: r.value.dim } });
        throw new PermanentJobError('dimension_mismatch', `модель вернула размерность ${r.value.dim}, у версии ${v.embedding_dim}`);
      }
      missing.forEach((m, j) => fresh.set(shas[m.i]!, r.value.vectors[j]!));
      await noteModelSuccess(ctx.pool);
    }
    ctx.throwIfStopped();
    await ctx.complete(
      async (client) => {
        await insertChunkVectors(
          client,
          versionId,
          v.embedding_dim!,
          chunks.map((c, i) => ({ chunkId: c.id, vector: cached.get(shas[i]!) ?? fresh.get(shas[i]!)! })),
        );
        await cacheStore(client, key, [...fresh].map(([textSha256, vector]) => ({ textSha256, vector })));
      },
      async (client) => {
        // Следующая пачка — если остались чанки без векторов. Пустая пачка при незавершённом
        // текстовом фронте ничего «навсегда» не закрывает: активация всё равно пересчитывает
        // полноту, а build поставит векторную пачку, когда появятся чанки (G05-01).
        if ((await chunksWithoutVectors(client, versionId, 1)).length > 0) await enqueueIndexEmbed(client, versionId);
      },
    );
    await tryActivate(ctx, versionId);
  },
};

// ---------------------------------------------------------------- index.purge

export const indexPurgeHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    // pending_runs — повтор поставит проход обслуживания, когда ожидающих прогонов не останется.
    await purgeVersion(ctx.pool, String(ctx.job.payload.versionId));
    await ctx.complete();
  },
};

// ---------------------------------------------------------------- search.semantic

const degrade = (ctx: IJobContext, runId: string, reason: string) =>
  ctx.complete(async (client) => {
    await degradeSemantic(client, runId, 'failed', reason);
  });

export const searchSemanticHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.searchRunId);
    const run = await getSearchRun(ctx.pool, runId);
    if (!run || run.status !== 'pending') {
      await ctx.complete();
      return;
    }
    await ctx.withLease((client) => markSemanticRunning(client, runId));
    const v = await getVersion(ctx.pool, run.index_version_id);
    const e = ctx.embeddings;
    if (!e || !v?.embedding_model) {
      await degrade(ctx, runId, 'model_unavailable');
      return;
    }
    if (modelFingerprint(e.model, v.embedding_dim!, e.revision) !== v.embedding_model_fingerprint) {
      await degrade(ctx, runId, 'model_fingerprint_mismatch');
      return;
    }
    const { key, input } = queryEmbeddingKey(v, run.query_text);
    const sha = sha256Hex(input);
    const t0 = Date.now();
    let vector = (await cacheLookup(ctx.pool, key, [sha])).get(sha) ?? null;
    if (!vector) {
      const r = await e.embed({ texts: [input], purpose: 'query', signal: ctx.signal });
      if (!r.ok) {
        await recordModelStatus(ctx.pool, { ok: false, errorCode: r.error.reason, verification: 'VERIFIED_FIXTURE', details: { code: r.error.code } });
        await degrade(ctx, runId, r.error.reason);
        return;
      }
      if (r.value.dim !== v.embedding_dim) {
        await degrade(ctx, runId, 'dimension_mismatch');
        return;
      }
      vector = r.value.vectors[0]!;
      await cacheStore(ctx.pool, key, [{ textSha256: sha, vector }]);
      await noteModelSuccess(ctx.pool);
    }
    ctx.throwIfStopped();
    const embedMs = Date.now() - t0;
    const queueWaitMs = Math.max(0, t0 - run.created_at.getTime());
    await ctx.complete(async (client) => {
      await completeSemantic(client, runId, vector!, { embedMs, queueWaitMs });
    });
  },
  // Отмена (в том числе по сроку) и терминальный отказ — деградация прогона с причиной в той же
  // транзакции, что и перевод задания. Уже терминальный прогон не меняется.
  onCancel: async (client, ctx) => {
    await degradeSemantic(client, String(ctx.job.payload.searchRunId), 'cancelled', 'cancelled');
  },
  onTerminalFailure: async (client, ctx) => {
    await degradeSemantic(client, String(ctx.job.payload.searchRunId), 'failed', 'semantic_failed');
  },
};
