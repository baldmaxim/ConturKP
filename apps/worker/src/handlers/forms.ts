// Предложения значений полей приложения (этап 11; D-031 В-11-5; проект §6). Вход закреплён при запуске (поля и
// кандидаты-основания). Права запустившего — текущие (R09-04): перед моделью и перед каждой пачкой — активность,
// участие в тендере с application.fill и читаемость каждого фрагмента. Каждое предложение проходит гейт цитат
// (дословная фраза, письменное основание, число и дата — из цитаты); не прошедшее — «ложная цитата» в охвате и не
// пишется. Пишутся под блокировкой этапа, только по действующим основаниям, затем сверяются с обработанными
// событиями (R09-01). Значением предложение становится только принятием человека.
import {
  fieldMap,
  formSuggestSystemPrompt,
  formSuggestUserContent,
  parseFormSuggestions,
  sha256Hex,
  tenderCapabilities,
  type ISuggestFieldInput,
  type ISuggestInput,
} from '@kontur/core';
import {
  fieldBasisProblems,
  fieldSuggestionRunInput,
  finishFieldSuggestionRun,
  getDraft,
  getFieldSuggestionRun,
  insertFieldSuggestions,
  loadAccessContext,
  lockStageForReview,
  memberRoleOf,
  readableFragments,
  reconcileFieldSuggestionRunWithProcessedEvents,
  startFieldSuggestionRun,
  type IFieldSuggestionItem,
  type PoolClient,
} from '@kontur/db';
import { RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

const finishOnce = async (client: PoolClient, runId: string, status: 'completed' | 'completed_with_gaps' | 'failed', coverage: Record<string, unknown>, failureCode: string | null = null) => {
  const run = await getFieldSuggestionRun(client, runId);
  if (!run || !['queued', 'running'].includes(run.status)) return;
  await finishFieldSuggestionRun(client, run.id, { status, coverage, failureCode });
};

const gap = (ctx: IJobContext, runId: string, reason: string, coverage: Record<string, unknown> = {}) =>
  ctx.complete((client) => finishOnce(client, runId, 'completed_with_gaps', { ...coverage, gap: reason }));

export const formsSuggestHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.runId);
    const run = await getFieldSuggestionRun(ctx.pool, runId);
    if (!run || !['queued', 'running'].includes(run.status)) {
      await ctx.complete();
      return;
    }
    if (run.status === 'queued') await ctx.withLease((client) => startFieldSuggestionRun(client, run.id));
    const pinned = (await fieldSuggestionRunInput(ctx.pool, run.id))?.input;
    if (!pinned) return ctx.complete((client) => finishOnce(client, run.id, 'failed', {}, 'input_not_pinned'));
    const draft = await getDraft(ctx.pool, run.draft_id);
    if (!draft) return ctx.complete((client) => finishOnce(client, run.id, 'failed', {}, 'draft_missing'));
    const chat = ctx.chat;
    if (!run.model_provider || !chat) return gap(ctx, run.id, 'модель не настроена: предложения не построены');
    if (chat.providerId !== run.model_provider || chat.model !== run.model_id || chat.version !== run.model_version) {
      return gap(ctx, run.id, 'модель worker отличается от закреплённой в прогоне');
    }
    const system = formSuggestSystemPrompt();
    if (sha256Hex(system) !== run.prompt_sha256) return gap(ctx, run.id, 'промпт изменился после запуска');

    const allowedNow = async (fragmentIds: readonly string[]): Promise<{ ok: true; readable: ReadonlySet<string> } | { ok: false; reason: string }> => {
      const access = await loadAccessContext(ctx.pool, run.requested_by, `forms-suggest:${run.id}`);
      if (!access) return { ok: false, reason: 'запустивший пользователь отключён или недоступен: предложения не построены' };
      if (!tenderCapabilities(access.roles, memberRoleOf(access, run.tender_id)).includes('application.fill')) {
        return { ok: false, reason: 'запустивший больше не участник тендера: предложения не построены' };
      }
      return { ok: true, readable: await readableFragments(ctx.pool, access, fragmentIds) };
    };
    const allIds = pinned.fields.flatMap((f) => f.fragments.map((x) => x.fragmentId));
    const first = await allowedNow(allIds);
    if (!first.ok) return gap(ctx, run.id, first.reason);
    const texts = new Map(
      (await ctx.pool.query<{ id: string; origin: string; text: string }>('SELECT id, origin, text FROM evidence_fragment WHERE id = ANY($1::uuid[])', [allIds])).rows.map((f) => [f.id, f]),
    );
    const fieldInput = (f: (typeof pinned.fields)[number], readable: ReadonlySet<string>): ISuggestFieldInput => ({
      fieldKey: f.fieldKey,
      label: f.label,
      type: f.type,
      help: f.help,
      unit: f.unit,
      options: f.options,
      fragments: f.fragments
        .filter((x) => readable.has(x.fragmentId) && texts.has(x.fragmentId))
        .map((x, i) => ({ label: `E${i + 1}`, fragmentId: x.fragmentId, origin: texts.get(x.fragmentId)!.origin, text: texts.get(x.fragmentId)!.text })),
    });
    const candidates = pinned.fields.filter((f) => f.fragments.length > 0);
    const content = (list: typeof candidates, readable: ReadonlySet<string>) => formSuggestUserContent({ draftTitle: pinned.draftTitle, fields: list.map((x) => fieldInput(x, readable)) });
    const batches: (typeof candidates)[] = [];
    let cur: typeof candidates = [];
    for (const f of candidates) {
      const next = [...cur, f];
      if (cur.length > 0 && content(next, first.readable).length > chat.maxInputChars) {
        batches.push(cur);
        cur = [f];
      } else cur = next;
    }
    if (cur.length > 0) batches.push(cur);
    const oversized = batches.filter((b) => content(b, first.readable).length > chat.maxInputChars).length;
    if (oversized > 0) return gap(ctx, run.id, `вход превышает предел модели: пачек — ${oversized}`);

    const fields = fieldMap(draft.field_schema);
    const passed: IFieldSuggestionItem[] = [];
    const rejected: Record<string, number> = {};
    let invalid = 0;
    let sent = 0;
    let restrictedNow = 0;
    let accessLost: string | null = null;
    for (const b of batches) {
      ctx.throwIfStopped();
      const now = await allowedNow(b.flatMap((f) => f.fragments.map((x) => x.fragmentId)));
      if (!now.ok) {
        accessLost = now.reason;
        break;
      }
      const input: ISuggestInput = { draftTitle: pinned.draftTitle, fields: b.map((f) => fieldInput(f, now.readable)).filter((f) => f.fragments.length > 0) };
      restrictedNow += b.flatMap((f) => f.fragments).filter((x) => !now.readable.has(x.fragmentId)).length;
      if (input.fields.length === 0) continue;
      sent += 1;
      const res = await chat.complete({ task: 'form_suggestions', system, user: formSuggestUserContent(input), signal: ctx.signal });
      if (!res.ok) {
        const code = `model_${res.error.code.toLowerCase()}`;
        if (res.error.retryable) throw new RetryableJobError(code, res.error.message);
        return gap(ctx, run.id, `отказ модели: ${res.error.code}`);
      }
      const parsed = parseFormSuggestions(res.value.content, input, fields);
      if (!parsed.ok) {
        invalid += 1;
        continue;
      }
      for (const it of parsed.items) {
        if (it.passed && it.value !== null) passed.push({ fieldKey: it.fieldKey, value: it.value, rationale: it.rationale, citations: it.citations });
        else for (const i of it.issues) rejected[i.code] = (rejected[i.code] ?? 0) + 1;
      }
    }
    await ctx.complete(async (client) => {
      await lockStageForReview(client, run.stage_id);
      const fresh = await getFieldSuggestionRun(client, run.id);
      if (!fresh || fresh.status !== 'running') return;
      // Только по действующим основаниям: цитата из заменённого источника предложением не становится.
      const usable: IFieldSuggestionItem[] = [];
      let staleOnWrite = 0;
      for (const it of passed) {
        const problems = await fieldBasisProblems(client, run.stage_id, it.citations.map((c) => ({ basisType: 'fragment' as const, id: c.fragmentId })));
        if (problems.length > 0) staleOnWrite += 1;
        else usable.push(it);
      }
      const savedIds = await insertFieldSuggestions(client, fresh, usable);
      const expired = await reconcileFieldSuggestionRunWithProcessedEvents(client, fresh, new Set(savedIds));
      const falseQuotes = (rejected.quote_not_in_fragment ?? 0) + (rejected.unknown_evidence ?? 0) + (rejected.no_citation ?? 0) + (rejected.non_documentary ?? 0) + (rejected.value_not_in_quote ?? 0);
      const gaps = [
        accessLost ?? '',
        pinned.restrictedAtStart + restrictedNow > 0 ? `фрагментов, недоступных запустившему, — ${pinned.restrictedAtStart + restrictedNow}` : '',
        invalid > 0 ? `ответов модели не прошли проверку — ${invalid} из ${sent}` : '',
        pinned.truncatedFields > 0 ? `полей сверх предела прогона — ${pinned.truncatedFields}` : '',
      ].filter(Boolean);
      const coverage = {
        fields: pinned.fields.length,
        fieldsWithCandidates: candidates.length,
        batches: sent,
        suggestions: savedIds.length,
        falseQuotes,
        rejectedByGate: rejected,
        staleOnWrite,
        expiredOnWrite: expired,
        invalidOutputs: invalid,
        ...(gaps.length > 0 ? { gap: gaps.join('; ') } : {}),
      };
      await finishFieldSuggestionRun(client, run.id, { status: gaps.length > 0 ? 'completed_with_gaps' : 'completed', coverage, failureCode: null });
    });
  },
  onTerminalFailure: async (client, ctx, failure) => finishOnce(client, String(ctx.job.payload.runId), 'completed_with_gaps', { gap: `отказ модели: ${failure.code}`.slice(0, 500) }),
};
