// Задание analysis.extract (OD-08-2, ADR-009, D-026 «Model run»): одна пачка входа прогона за задание,
// следующая — новым заданием в транзакции результата (ADR-004 §7a: слот gpu не занят надолго). Ответ модели
// проверяется до записи: схема, ID только из входа пачки, вид факта из справочника, происхождение основания
// факта (D-018). Повторяемый отказ провайдера (недоступен, таймаут, 429, 5xx) — повтор задания, после
// исчерпания попыток прогон failed; детерминированный (невалидный ответ — отказ пачки без повтора; 401/403,
// нарушение протокола — отказ прогона). Модель ничего не подтверждает: пишутся только кандидаты.
import { configHash, FACT_BASIS_ORIGINS, modelUserContent, parseFactOutput, parseRequirementOutput, sha256Hex, systemPrompt } from '@kontur/core';
import {
  analysisRunInputs,
  enqueueAnalysisBatch,
  factKindCodes,
  finishAnalysisRun,
  getAnalysisRun,
  insertModelFactCandidates,
  insertModelRequirementCandidates,
  startAnalysisRun,
  updateAnalysisProgress,
  type IAnalysisRunRow,
} from '@kontur/db';
import { RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

interface IInput {
  id: string;
  origin: string;
  text: string;
}

interface IBatch {
  fragments: IInput[];
  truncated: number;
}

interface ICoverage {
  fragmentsTotal: number;
  batchesTotal: number;
  batchesProcessed: number;
  batchesFailed: number;
  candidatesSaved: number;
  truncatedFragments: number;
  dropped: Record<string, number>;
  invalidOutputs: Record<string, number>;
}

// Пачки по порядку входа: сумма текста не больше предела; фрагмент длиннее предела — один в пачке, усечённым
// (это отмечается как пробел охвата, а не молча).
const legacyBatches = (inputs: readonly IInput[], maxChars: number): IBatch[] => {
  const out: IBatch[] = [];
  let cur: IBatch = { fragments: [], truncated: 0 };
  let size = 0;
  for (const f of inputs) {
    if (f.text.length > maxChars) {
      if (cur.fragments.length > 0) out.push(cur);
      out.push({ fragments: [{ ...f, text: f.text.slice(0, maxChars) }], truncated: 1 });
      cur = { fragments: [], truncated: 0 };
      size = 0;
      continue;
    }
    if (size + f.text.length > maxChars && cur.fragments.length > 0) {
      out.push(cur);
      cur = { fragments: [], truncated: 0 };
      size = 0;
    }
    cur.fragments.push(f);
    size += f.text.length;
  }
  if (cur.fragments.length > 0) out.push(cur);
  return out;
};

// v2: бюджет всего сериализованного входа, включая ID и JSON; длинный текст передаётся
// целиком несколькими частями с исходным fragmentId. Источник и цитата не подменяются.
export const splitBatches = (inputs: readonly IInput[], maxChars: number): IBatch[] => {
  const out: IBatch[] = [];
  let current: IInput[] = [];
  for (const input of inputs) {
    let rest = input.text;
    do {
      if (modelUserContent([...current, { ...input, text: rest }]).length <= maxChars) {
        current.push({ ...input, text: rest });
        break;
      }
      if (current.length) {
        out.push({ fragments: current, truncated: 0 });
        current = [];
        continue;
      }
      let low = 0;
      let high = rest.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (modelUserContent([{ ...input, text: rest.slice(0, mid) }]).length <= maxChars) low = mid;
        else high = mid - 1;
      }
      if (!low) throw new Error('analysis input budget cannot fit fragment metadata');
      // Не разрываем суррогатную пару Unicode.
      if (low < rest.length && /[\uD800-\uDBFF]/u.test(rest[low - 1]!)) low -= 1;
      if (!low) throw new Error('analysis input budget cannot fit one code point');
      const boundary = rest.slice(0, low).search(/\s+\S*$/u);
      if (boundary > low / 2) low = boundary + 1;
      out.push({ fragments: [{ ...input, text: rest.slice(0, low) }], truncated: 0 });
      rest = rest.slice(low);
    } while (rest.length);
  }
  if (current.length) out.push({ fragments: current, truncated: 0 });
  return out;
};

export const splitTruncatedBatch = (batch: IBatch): IBatch[] | null => {
  if (batch.fragments.length > 1) {
    const mid = Math.ceil(batch.fragments.length / 2);
    return [batch.fragments.slice(0, mid), batch.fragments.slice(mid)].map((fragments) => ({ fragments, truncated: 0 }));
  }
  const f = batch.fragments[0];
  if (!f || f.text.length <= 128) return null;
  let mid = Math.ceil(f.text.length / 2);
  if (/[\uD800-\uDBFF]/u.test(f.text[mid - 1]!)) mid -= 1;
  return [f.text.slice(0, mid), f.text.slice(mid)].map((text) => ({ fragments: [{ ...f, text }], truncated: 0 }));
};

const coverageOf = (run: IAnalysisRunRow, fragments: number, batches: number): ICoverage => {
  const c = run.coverage as Partial<ICoverage>;
  return {
    fragmentsTotal: fragments,
    batchesTotal: c.batchesTotal ?? batches,
    batchesProcessed: c.batchesProcessed ?? 0,
    batchesFailed: c.batchesFailed ?? 0,
    candidatesSaved: c.candidatesSaved ?? 0,
    truncatedFragments: c.truncatedFragments ?? 0,
    dropped: { ...(c.dropped ?? {}) },
    invalidOutputs: { ...(c.invalidOutputs ?? {}) },
  };
};

const finishWith = (ctx: IJobContext, runId: string, failureCode: string, coverage: Record<string, unknown>) =>
  ctx.complete(async (client) => {
    await finishAnalysisRun(client, runId, { status: 'failed', failureCode, coverage, result: null });
  });

export const analysisExtractHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.runId);
    const run = await getAnalysisRun(ctx.pool, runId);
    if (!run || !['queued', 'running'].includes(run.status)) {
      await ctx.complete();
      return;
    }
    const chat = ctx.chat;
    if (!chat) return finishWith(ctx, run.id, 'model_not_configured', run.coverage);
    if (chat.providerId !== run.provider_id || chat.model !== run.model_id || chat.version !== run.model_version) {
      return finishWith(ctx, run.id, 'model_changed', run.coverage);
    }
    const kinds = run.task === 'fact_extraction' ? await factKindCodes(ctx.pool) : [];
    const system = systemPrompt(run.task, kinds);
    if (sha256Hex(system) !== run.prompt_sha256) return finishWith(ctx, run.id, 'prompt_changed', run.coverage);
    const { batchingVersion, ...pinnedConfig } = run.inference_config;
    if (configHash(pinnedConfig) !== configHash(chat.inferenceConfig)) return finishWith(ctx, run.id, 'model_config_changed', run.coverage);
    const inputs = await analysisRunInputs(ctx.pool, run.id);
    const batches = (batchingVersion === 2 ? splitBatches : legacyBatches)(inputs, chat.maxInputChars);
    const coverage = coverageOf(run, inputs.length, batches.length);
    const result = { batches: [...(((run.result as { batches?: unknown[] } | null)?.batches) ?? [])] as unknown[] };
    if (run.status === 'queued') await ctx.withLease((client) => startAnalysisRun(client, run.id));
    const index = Number((run.progress as { batch?: number }).batch ?? 0);
    if (index >= batches.length) {
      await ctx.complete(async (client) => {
        await finishAnalysisRun(client, run.id, { status: 'completed', failureCode: null, coverage: { ...coverage }, result });
      });
      return;
    }
    const pending = (run.progress.pending as IBatch[] | undefined) ?? [batches[index]!];
    const batch = pending[0]!;
    ctx.throwIfStopped();
    const res = await chat.complete({ task: run.task, system, user: modelUserContent(batch.fragments), signal: ctx.signal });
    if (!res.ok) {
      const code = `model_${res.error.code.toLowerCase()}`;
      if (res.error.retryable) throw new RetryableJobError(code, res.error.message);
      if (res.error.code !== 'TRUNCATED' || batchingVersion !== 2) return finishWith(ctx, run.id, code, { ...coverage });
      const smaller = splitTruncatedBatch(batch);
      if (smaller) {
        coverage.batchesTotal += 1;
        result.batches.push({ index, outcome: 'model_truncated_split', inputSha256: sha256Hex(modelUserContent(batch.fragments)) });
        await ctx.complete(
          async (client) => void (await updateAnalysisProgress(client, run.id, { batch: index, pending: [...smaller, ...pending.slice(1)] }, { ...coverage }, result)),
          async (client) => void (await enqueueAnalysisBatch(client, run)),
        );
        return;
      }
    }
    const allowed = new Set(batch.fragments.map((f) => f.id));
    const origins = new Map(batch.fragments.map((f) => [f.id, f.origin]));
    const parsed = !res.ok ? { ok: false as const, reason: 'model_truncated' } :
      run.task === 'requirement_extraction'
        ? parseRequirementOutput(res.value.content, allowed)
        : parseFactOutput(res.value.content, allowed, new Set(kinds), (id) => FACT_BASIS_ORIGINS.includes(origins.get(id) ?? ''));
    coverage.batchesProcessed += 1;
    coverage.truncatedFragments += batch.truncated;
    const entry: Record<string, unknown> = {
      index,
      fragments: batch.fragments.length,
      inputSha256: sha256Hex(modelUserContent(batch.fragments)),
      startedAt: res.ok ? res.value.startedAt.toISOString() : null,
      finishedAt: res.ok ? res.value.finishedAt.toISOString() : null,
      raw: res.ok ? res.value.content.slice(0, 200_000) : null,
    };
    if (!parsed.ok) {
      coverage.batchesFailed += 1;
      coverage.invalidOutputs[parsed.reason] = (coverage.invalidOutputs[parsed.reason] ?? 0) + 1;
      entry.outcome = parsed.reason;
    } else {
      for (const d of parsed.dropped) coverage.dropped[d.reason] = (coverage.dropped[d.reason] ?? 0) + 1;
      entry.outcome = 'ok';
      entry.dropped = parsed.dropped;
    }
    result.batches.push(entry);
    const remaining = pending.slice(1);
    const next = remaining.length ? index : index + 1;
    await ctx.complete(
      async (client) => {
        if (parsed.ok) {
          coverage.candidatesSaved +=
            run.task === 'requirement_extraction'
              ? await insertModelRequirementCandidates(client, run, parsed.items as Parameters<typeof insertModelRequirementCandidates>[2])
              : await insertModelFactCandidates(client, run, parsed.items as Parameters<typeof insertModelFactCandidates>[2]);
        }
        if (next < batches.length) {
          await updateAnalysisProgress(client, run.id, { batch: next, ...(remaining.length ? { pending: remaining } : {}) }, { ...coverage }, result);
        } else {
          const gaps = coverage.batchesFailed > 0 || coverage.truncatedFragments > 0;
          await finishAnalysisRun(client, run.id, { status: gaps ? 'completed_with_gaps' : 'completed', failureCode: null, coverage: { ...coverage }, result });
        }
      },
      next < batches.length ? async (client) => void (await enqueueAnalysisBatch(client, run)) : undefined,
    );
  },
  // Попытки исчерпаны (провайдер недоступен) или ошибка неповторяема: прогон failed, накопленный охват сохраняется.
  onTerminalFailure: async (client, ctx, failure) => {
    const run = await getAnalysisRun(client, String(ctx.job.payload.runId));
    if (!run) return;
    await finishAnalysisRun(client, run.id, { status: 'failed', failureCode: failure.code.slice(0, 60), coverage: run.coverage, result: run.result ?? null });
  },
};
