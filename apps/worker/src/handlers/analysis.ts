// Задание analysis.extract (OD-08-2, ADR-009, D-026 «Model run»): одна пачка входа прогона за задание,
// следующая — новым заданием в транзакции результата (ADR-004 §7a: слот gpu не занят надолго). Ответ модели
// проверяется до записи: схема, ID только из входа пачки, вид факта из справочника, происхождение основания
// факта (D-018). Повторяемый отказ провайдера (недоступен, таймаут, 429, 5xx) — повтор задания, после
// исчерпания попыток прогон failed; детерминированный (невалидный ответ — отказ пачки без повтора; 401/403,
// нарушение протокола — отказ прогона). Модель ничего не подтверждает: пишутся только кандидаты.
import { FACT_BASIS_ORIGINS, modelUserContent, parseFactOutput, parseRequirementOutput, sha256Hex, systemPrompt } from '@kontur/core';
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
export const splitBatches = (inputs: readonly IInput[], maxChars: number): IBatch[] => {
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

const coverageOf = (run: IAnalysisRunRow, fragments: number, batches: number): ICoverage => {
  const c = run.coverage as Partial<ICoverage>;
  return {
    fragmentsTotal: fragments,
    batchesTotal: batches,
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
    const inputs = await analysisRunInputs(ctx.pool, run.id);
    const batches = splitBatches(inputs, chat.maxInputChars);
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
    const batch = batches[index]!;
    ctx.throwIfStopped();
    const res = await chat.complete({ task: run.task, system, user: modelUserContent(batch.fragments), signal: ctx.signal });
    if (!res.ok) {
      const code = `model_${res.error.code.toLowerCase()}`;
      if (res.error.retryable) throw new RetryableJobError(code, res.error.message);
      return finishWith(ctx, run.id, code, { ...coverage });
    }
    const allowed = new Set(batch.fragments.map((f) => f.id));
    const origins = new Map(batch.fragments.map((f) => [f.id, f.origin]));
    const parsed =
      run.task === 'requirement_extraction'
        ? parseRequirementOutput(res.value.content, allowed)
        : parseFactOutput(res.value.content, allowed, new Set(kinds), (id) => FACT_BASIS_ORIGINS.includes(origins.get(id) ?? ''));
    coverage.batchesProcessed += 1;
    coverage.truncatedFragments += batch.truncated;
    const entry: Record<string, unknown> = {
      index,
      fragments: batch.fragments.length,
      startedAt: res.value.startedAt.toISOString(),
      finishedAt: res.value.finishedAt.toISOString(),
      raw: res.value.content.slice(0, 200_000),
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
    const next = index + 1;
    await ctx.complete(
      async (client) => {
        if (parsed.ok) {
          coverage.candidatesSaved +=
            run.task === 'requirement_extraction'
              ? await insertModelRequirementCandidates(client, run, parsed.items as Parameters<typeof insertModelRequirementCandidates>[2])
              : await insertModelFactCandidates(client, run, parsed.items as Parameters<typeof insertModelFactCandidates>[2]);
        }
        if (next < batches.length) {
          await updateAnalysisProgress(client, run.id, { batch: next }, { ...coverage }, result);
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
