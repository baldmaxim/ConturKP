// Задания этапа 09 (docs/architecture/09-review-checks-design.md §5.4, §5.5, §6). review.run — программные проверки
// C01–C11 на закреплённых входах одной транзакцией: исходы, замечания, основания, зависимости; гипотезы модели (C12) —
// отдельным заданием класса gpu. Модель не настроена или отказала — C12 неполна или с ошибкой, результаты правил
// сохраняются, прогон «с пробелами» (D-029 В-09-5). stage.invalidate — обработка одного события барьера.
import {
  hypothesisInputSha256,
  parseHypotheses,
  reviewSystemPrompt,
  reviewUserContent,
  runRuleChecks,
  runStatusOf,
  sha256Hex,
  type CheckOutcome,
  type IHypothesisInput,
} from '@kontur/core';
import {
  enqueueReviewModel,
  finishReviewRun,
  getReviewRun,
  hypothesisSource,
  insertCheckResults,
  insertSuggestions,
  loadAccessContext,
  loadReviewInput,
  processStageEvent,
  readableFragments,
  reviewCheckResults,
  stageContentFingerprint,
  startReviewRun,
  updateReviewCoverage,
  writeRuleFindings,
  type IReviewRunRow,
  type PoolClient,
} from '@kontur/db';
import { RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

const finishWithModel = async (client: PoolClient, run: IReviewRunRow, model: { outcome: CheckOutcome; reason: string | null; counts: Record<string, number> }, coverage: Record<string, unknown>) => {
  await insertCheckResults(client, run.id, [{ check: 'model_hypotheses', ...model }]);
  const outcomes = (await reviewCheckResults(client, run.id)).map((r) => r.outcome);
  await finishReviewRun(client, run.id, { status: runStatusOf(outcomes), failureCode: null, coverage: { ...coverage, model: { outcome: model.outcome, ...model.counts } } });
};

const failRun = async (client: PoolClient, runId: string, code: string) => {
  const run = await getReviewRun(client, runId);
  if (!run || !['queued', 'running'].includes(run.status)) return;
  await finishReviewRun(client, run.id, { status: 'failed', failureCode: code.slice(0, 60), coverage: run.coverage });
};

export const reviewRunHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.runId);
    const run = await getReviewRun(ctx.pool, runId);
    if (!run || !['queued', 'running'].includes(run.status)) {
      await ctx.complete();
      return;
    }
    if (run.status === 'queued') await ctx.withLease((client) => startReviewRun(client, run.id));
    const contentFingerprint = await stageContentFingerprint(ctx.pool, run.stage_id, run.registry_id);
    const { input } = await loadReviewInput(ctx.pool, run);
    const { results, findings } = runRuleChecks(input);
    ctx.throwIfStopped();
    await ctx.complete(
      async (client) => {
        const fresh = await getReviewRun(client, run.id);
        if (!fresh || fresh.status !== 'running') return;
        // Повтор задания после сбоя транзакции: исходы правил уже записаны — второй раз не пишутся.
        if ((await reviewCheckResults(client, run.id)).length > 0) return;
        await insertCheckResults(client, run.id, results);
        const written = await writeRuleFindings(client, fresh, findings);
        const coverage = {
          rules: { findings: findings.length, created: written.created, observed: written.observed },
          units: input.units.length,
          requirements: input.requirements.length,
          positions: input.positions.length,
          facts: input.facts.length,
          contentFingerprint,
        };
        if (!fresh.model_provider) {
          await finishWithModel(client, fresh, { outcome: 'incomplete', reason: 'модель не настроена: гипотезы не построены', counts: {} }, coverage);
        } else {
          await updateReviewCoverage(client, run.id, coverage);
        }
      },
      run.model_provider
        ? async (client) => {
            const fresh = await getReviewRun(client, run.id);
            if (fresh?.status === 'running') await enqueueReviewModel(client, fresh);
          }
        : undefined,
    );
  },
  onTerminalFailure: async (client, ctx, failure) => failRun(client, String(ctx.job.payload.runId), failure.code),
};

// Гипотезы модели: вход — требования, цитаты которых запустивший может читать, и позиции расчёта; ответ проверяется
// до записи. Отказ провайдера — повтор задания; после исчерпания попыток — C12 «ошибка», прогон «с пробелами».
const finishModel = (ctx: IJobContext, runId: string, outcome: CheckOutcome, reason: string | null, counts: Record<string, number>) =>
  ctx.complete(async (client) => {
    const run = await getReviewRun(client, runId);
    if (!run || run.status !== 'running') return;
    if ((await reviewCheckResults(client, run.id)).some((r) => r.check_code === 'model_hypotheses')) return;
    await finishWithModel(client, run, { outcome, reason, counts }, run.coverage);
  });

export const reviewModelHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.runId);
    const run = await getReviewRun(ctx.pool, runId);
    if (!run || run.status !== 'running') {
      await ctx.complete();
      return;
    }
    const chat = ctx.chat;
    if (!chat) return finishModel(ctx, run.id, 'incomplete', 'модель не настроена в worker: гипотезы не построены', {});
    if (chat.providerId !== run.model_provider || chat.model !== run.model_id || chat.version !== run.model_version) {
      return finishModel(ctx, run.id, 'error', 'модель worker отличается от закреплённой в прогоне', {});
    }
    const system = reviewSystemPrompt();
    if (sha256Hex(system) !== run.prompt_sha256) return finishModel(ctx, run.id, 'error', 'промпт изменился после запуска', {});
    const access = await loadAccessContext(ctx.pool, run.requested_by, `review-model:${run.id}`);
    if (!access) return finishModel(ctx, run.id, 'error', 'запустивший пользователь недоступен', {});
    const source = await hypothesisSource(ctx.pool, run, (ids) => readableFragments(ctx.pool, access, ids));
    const input: IHypothesisInput = { requirements: source.requirements, positions: source.positions };
    const counts = { requirements: input.requirements.length, positions: input.positions.length, restricted: source.restricted };
    if (input.requirements.length === 0) {
      const reason = source.restricted > 0 ? 'все требования содержат цитаты, недоступные запустившему' : null;
      return finishModel(ctx, run.id, source.restricted > 0 ? 'incomplete' : 'not_applicable', reason ?? 'нет подтверждённых требований для гипотез', counts);
    }
    // Пачки по требованиям: позиции расчёта — в каждой пачке; пачка больше предела модели — пробел охвата, а не
    // молча усечённый вход.
    const batches: IHypothesisInput[] = [];
    let cur: IHypothesisInput = { requirements: [], positions: input.positions };
    for (const r of input.requirements) {
      const next = { requirements: [...cur.requirements, r], positions: input.positions };
      if (cur.requirements.length > 0 && reviewUserContent(next).length > chat.maxInputChars) {
        batches.push(cur);
        cur = { requirements: [r], positions: input.positions };
      } else cur = next;
    }
    batches.push(cur);
    const oversized = batches.filter((b) => reviewUserContent(b).length > chat.maxInputChars).length;
    if (oversized > 0) return finishModel(ctx, run.id, 'incomplete', `вход превышает предел модели: пачек — ${oversized}`, { ...counts, batches: batches.length });
    const fragments = new Set(input.requirements.flatMap((r) => r.fragments.map((f) => f.fragmentId)));
    const positions = new Set(input.positions.map((p) => p.positionId));
    const items: Parameters<typeof insertSuggestions>[2][number][] = [];
    let dropped = 0;
    let invalid = 0;
    for (const b of batches) {
      ctx.throwIfStopped();
      const res = await chat.complete({ task: 'review_hypotheses', system, user: reviewUserContent(b), signal: ctx.signal });
      if (!res.ok) {
        const code = `model_${res.error.code.toLowerCase()}`;
        if (res.error.retryable) throw new RetryableJobError(code, res.error.message);
        return finishModel(ctx, run.id, 'error', `отказ модели: ${res.error.code}`, counts);
      }
      const parsed = parseHypotheses(res.value.content, fragments, positions);
      if (!parsed.ok) {
        invalid += 1;
        continue;
      }
      items.push(...parsed.items);
      dropped += parsed.dropped;
    }
    await ctx.complete(async (client) => {
      const fresh = await getReviewRun(client, run.id);
      if (!fresh || fresh.status !== 'running' || (await reviewCheckResults(client, run.id)).some((r) => r.check_code === 'model_hypotheses')) return;
      const saved = await insertSuggestions(client, fresh, items);
      const gaps = [
        source.restricted > 0 ? `требований с цитатами, недоступными запустившему, — ${source.restricted}` : '',
        invalid > 0 ? `ответов модели не прошли проверку — ${invalid} из ${batches.length}` : '',
      ].filter(Boolean);
      await finishWithModel(
        client,
        fresh,
        {
          outcome: gaps.length > 0 ? 'incomplete' : saved > 0 ? 'failed' : 'passed',
          reason: gaps.length > 0 ? gaps.join('; ') : null,
          counts: { ...counts, batches: batches.length, hypotheses: saved, dropped, invalidOutputs: invalid },
        },
        { ...fresh.coverage, modelInputSha256: hypothesisInputSha256(input) },
      );
    });
  },
  onTerminalFailure: async (client, ctx, failure) => {
    const run = await getReviewRun(client, String(ctx.job.payload.runId));
    if (!run || run.status !== 'running') return;
    if ((await reviewCheckResults(client, run.id)).some((r) => r.check_code === 'model_hypotheses')) return;
    await finishWithModel(client, run, { outcome: 'error', reason: `отказ модели: ${failure.code}`.slice(0, 2000), counts: {} }, run.coverage);
  },
};

export const stageInvalidateHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const eventId = String(ctx.job.payload.eventId);
    await ctx.complete(async (client) => void (await processStageEvent(client, eventId)));
  },
};
