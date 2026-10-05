// Гипотезы причин изменений (этап 10; проект §5.8, §6; D-030 В-10-8; I11, I12, A23). Вход закреплён при запуске
// (единицы и кандидаты-основания). Права запустившего — текущие (R09-04): перед моделью и перед каждой пачкой
// проверяются активность, участие в тендере и читаемость каждого фрагмента; недоступный сейчас фрагмент в модель не
// уходит, вход при этом не меняется. Гипотезы пишутся под блокировкой этапа и сверяются с уже обработанными событиями
// (R09-01). Модель не настроена или отказала — прогон «с пробелами», причины не меняются.
import { parseReasons, reasonSystemPrompt, reasonUserContent, sha256Hex, tenderCapabilities, type IParsedReason, type IReasonInput, type IReasonUnitInput } from '@kontur/core';
import {
  finishReasonRun,
  getReasonRun,
  insertReasonSuggestions,
  loadAccessContext,
  lockStageForReview,
  memberRoleOf,
  readableFragments,
  reasonRunInput,
  reconcileReasonRunWithProcessedEvents,
  startReasonRun,
  type IReasonRunRow,
  type PoolClient,
} from '@kontur/db';
import { RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

const finishOnce = async (client: PoolClient, runId: string, status: 'completed' | 'completed_with_gaps' | 'failed', coverage: Record<string, unknown>, failureCode: string | null = null) => {
  const run = await getReasonRun(client, runId);
  if (!run || !['queued', 'running'].includes(run.status)) return;
  await finishReasonRun(client, run.id, { status, coverage, failureCode });
};

const gap = (ctx: IJobContext, runId: string, reason: string, coverage: Record<string, unknown> = {}) =>
  ctx.complete((client) => finishOnce(client, runId, 'completed_with_gaps', { ...coverage, gap: reason }));

export const economicsReasonsHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.runId);
    const run = await getReasonRun(ctx.pool, runId);
    if (!run || !['queued', 'running'].includes(run.status)) {
      await ctx.complete();
      return;
    }
    if (run.status === 'queued') await ctx.withLease((client) => startReasonRun(client, run.id));
    const pinned = (await reasonRunInput(ctx.pool, run.id))?.input;
    if (!pinned) return ctx.complete((client) => finishOnce(client, run.id, 'failed', {}, 'input_not_pinned'));
    const chat = ctx.chat;
    if (!run.model_provider || !chat) return gap(ctx, run.id, 'модель не настроена: гипотезы причин не построены');
    if (chat.providerId !== run.model_provider || chat.model !== run.model_id || chat.version !== run.model_version) {
      return gap(ctx, run.id, 'модель worker отличается от закреплённой в прогоне');
    }
    const system = reasonSystemPrompt();
    if (sha256Hex(system) !== run.prompt_sha256) return gap(ctx, run.id, 'промпт изменился после запуска');

    // Права запустившего — сейчас: активен, участник тендера с economics.compare, фрагменты читаемы.
    const allowedNow = async (fragmentIds: readonly string[]): Promise<{ ok: true; readable: ReadonlySet<string> } | { ok: false; reason: string }> => {
      const access = await loadAccessContext(ctx.pool, run.requested_by, `economics-reasons:${run.id}`);
      if (!access) return { ok: false, reason: 'запустивший пользователь отключён или недоступен: гипотезы не построены' };
      if (!tenderCapabilities(access.roles, memberRoleOf(access, run.tender_id)).includes('economics.compare')) {
        return { ok: false, reason: 'запустивший больше не участник тендера: гипотезы не построены' };
      }
      return { ok: true, readable: await readableFragments(ctx.pool, access, fragmentIds) };
    };
    const allIds = pinned.units.flatMap((u) => u.fragmentIds);
    const first = await allowedNow(allIds);
    if (!first.ok) return gap(ctx, run.id, first.reason);
    const texts = new Map(
      (await ctx.pool.query<{ id: string; origin: string; text: string }>('SELECT id, origin, text FROM evidence_fragment WHERE id = ANY($1::uuid[])', [allIds])).rows.map((f) => [f.id, f]),
    );
    const unitInput = (u: (typeof pinned.units)[number], readable: ReadonlySet<string>): IReasonUnitInput => ({
      unitId: u.unitId,
      title: u.title,
      unitCode: u.unitCode,
      effects: u.effects,
      fragments: u.fragmentIds.filter((id) => readable.has(id) && texts.has(id)).map((id) => ({ fragmentId: id, origin: texts.get(id)!.origin, text: texts.get(id)!.text })),
    });
    const candidates = pinned.units.filter((u) => u.fragmentIds.length > 0);
    // Пачки по единицам; пачка больше предела модели — пробел охвата, а не усечённый вход.
    const batches: (typeof pinned.units)[] = [];
    let cur: typeof pinned.units = [];
    for (const u of candidates) {
      const next = [...cur, u];
      if (cur.length > 0 && reasonUserContent({ units: next.map((x) => unitInput(x, first.readable)) }).length > chat.maxInputChars) {
        batches.push(cur);
        cur = [u];
      } else cur = next;
    }
    if (cur.length > 0) batches.push(cur);
    const oversized = batches.filter((b) => reasonUserContent({ units: b.map((x) => unitInput(x, first.readable)) }).length > chat.maxInputChars).length;
    if (oversized > 0) return gap(ctx, run.id, `вход превышает предел модели: пачек — ${oversized}`);

    const items: IParsedReason[] = [];
    let dropped = 0;
    let invalid = 0;
    let sent = 0;
    let restrictedNow = 0;
    let accessLost: string | null = null;
    for (const b of batches) {
      ctx.throwIfStopped();
      // Права — перед каждой пачкой: отзыв во время прогона исключает закрытые фрагменты следующих пачек.
      const now = await allowedNow(b.flatMap((u) => u.fragmentIds));
      if (!now.ok) {
        accessLost = now.reason;
        break;
      }
      const input: IReasonInput = { units: b.map((u) => unitInput(u, now.readable)).filter((u) => u.fragments.length > 0) };
      restrictedNow += b.flatMap((u) => u.fragmentIds).filter((id) => !now.readable.has(id)).length;
      if (input.units.length === 0) continue;
      sent += 1;
      const res = await chat.complete({ task: 'change_reasons', system, user: reasonUserContent(input), signal: ctx.signal });
      if (!res.ok) {
        const code = `model_${res.error.code.toLowerCase()}`;
        if (res.error.retryable) throw new RetryableJobError(code, res.error.message);
        return gap(ctx, run.id, `отказ модели: ${res.error.code}`);
      }
      const parsed = parseReasons(res.value.content, input);
      if (!parsed.ok) {
        invalid += 1;
        continue;
      }
      items.push(...parsed.items);
      dropped += parsed.dropped;
    }
    await ctx.complete(async (client) => {
      await lockStageForReview(client, run.stage_id);
      const fresh = await getReasonRun(client, run.id);
      if (!fresh || fresh.status !== 'running') return;
      const savedIds = await insertReasonSuggestions(client, fresh as IReasonRunRow, items);
      const expired = await reconcileReasonRunWithProcessedEvents(client, fresh, new Set(savedIds));
      const gaps = [
        accessLost ?? '',
        pinned.restrictedAtStart + restrictedNow > 0 ? `фрагментов, недоступных запустившему, — ${pinned.restrictedAtStart + restrictedNow}` : '',
        invalid > 0 ? `ответов модели не прошли проверку — ${invalid} из ${sent}` : '',
        pinned.truncatedUnits > 0 ? `единиц сверх предела прогона — ${pinned.truncatedUnits}` : '',
      ].filter(Boolean);
      const coverage = {
        units: pinned.units.length,
        unitsWithCandidates: candidates.length,
        batches: sent,
        suggestions: savedIds.length,
        dropped,
        invalidOutputs: invalid,
        expiredOnWrite: expired,
        ...(gaps.length > 0 ? { gap: gaps.join('; ') } : {}),
      };
      await finishReasonRun(client, run.id, { status: gaps.length > 0 ? 'completed_with_gaps' : 'completed', coverage, failureCode: null });
    });
  },
  onTerminalFailure: async (client, ctx, failure) => finishOnce(client, String(ctx.job.payload.runId), 'completed_with_gaps', { gap: `отказ модели: ${failure.code}`.slice(0, 500) }),
};
