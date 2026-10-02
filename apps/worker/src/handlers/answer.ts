// Задание ответного ядра `answer.generate` (этап 08a, D-019, D-027; ADR-004 §7a: класс gpu, приоритет 90, интерактивная
// полоса). Перенос Locus `verified-answer.js`: пакет оснований (правило) → черновик (модель) → детерминированные проверки
// → необязательный проверяющий (модель) → не больше заданного числа исправлений → отрисовка (правило). Стриминга нет:
// всё, что видит пользователь, записывается одной транзакцией завершения; непроверенный текст модели не хранится.
import { createHash } from 'node:crypto';
import {
  boundedHistory,
  buildPacket,
  checkClaims,
  configHash,
  DraftParseError,
  draftSystemPrompt,
  draftUserContent,
  factsForPlan,
  markVersions,
  parseDraft,
  parseVerdict,
  renderVerifiedAnswer,
  sha256Hex,
  verifierSystemPrompt,
  verifierUserContent,
  type AnswerStatus,
  type IAnswerPlan,
  type IClaimCheck,
  type IClaimVerdict,
  type IDraft,
  type IDraftFeedback,
  type IFragmentFact,
  type IncompleteReason,
  type IPacketItem,
  type IVerdict,
} from '@kontur/core';
import {
  completeAnswerRun,
  degradeIfExpired,
  failAnswerRun,
  fragmentCandidates,
  getAnswerRun,
  getSearchRun,
  hitDetails,
  loadAccessContext,
  markAnswerRunning,
  previousTurns,
  readableFragments,
  scopeFactGraph,
  searchCandidates,
  searchScopeCounts,
  unitsNotPermitted,
  type IAnswerCompletion,
  type IAnswerRunRow,
} from '@kontur/db';
import { RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

// Повторяемый отказ модели (недоступна, таймаут, 429) повторяет задание не больше этого числа попыток: пользователь
// ждёт ответа, и после них ход честно завершается неполнотой (I18).
const MODEL_RETRY_ATTEMPTS = 3;

const ANSWER_TEXT: Record<string, string> = {
  needs_clarification: 'Уточните вопрос: в нём нет слов или чисел, по которым можно искать.',
  no_data: 'В области ответа нет ни одного источника: состав этапа или договора пуст.',
  not_found_in_scope: 'По области ответа ничего не найдено. Это не значит, что условие документами не предусмотрено.',
  scope_incomplete: 'Ничего не найдено, но обработка области не завершена: часть документов не распознана или не проиндексирована.',
  no_readable_evidence: 'Найденные фрагменты вам недоступны по правам источника — ответ не составлен.',
  model_disabled: 'Модель не настроена: ответ не составлен. Найденные фрагменты — по ссылкам ниже, проверьте их по оригиналу.',
  model_failed: 'Модель не ответила: ответ не составлен. Найденные фрагменты — по ссылкам ниже.',
  draft_invalid: 'Ответ модели не прошёл проверку формата: ответ не составлен. Найденные фрагменты — по ссылкам ниже.',
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const placeOf = (d: Awaited<ReturnType<typeof hitDetails>> extends Map<string, infer R> ? R : never): string => {
  if (d.mail_subject && !d.document_title) return `Письмо «${d.mail_subject}»`;
  if (d.session_title) return `Переговоры «${d.session_title}»${d.speaker_label ? `, ${d.speaker_label}` : ''}`;
  const page = d.page_label ?? (d.page_index !== null ? String(d.page_index + 1) : null);
  return `${d.document_title ? `«${d.document_title}»` : 'Документ'}${d.sheet_label ? `, лист «${d.sheet_label}»` : ''}${page ? `, стр. ${page}` : ''}`;
};

const packetHash = (items: readonly IPacketItem[]): string =>
  sha(['kontur.answer_packet.v1', ...items.map((i) => `${i.label}:${i.fragmentId}:${sha(i.text)}:${i.versionNote}`)].join('\n'));

const feedbackFor = (draft: IDraft, checks: ReadonlyMap<string, IClaimCheck>, verdicts: ReadonlyMap<string, IClaimVerdict>): IDraftFeedback[] =>
  draft.claims.flatMap((claim) => {
    const check = checks.get(claim.claimId);
    const verdict = verdicts.get(claim.claimId);
    const reasons =
      check && !check.passed
        ? check.issues.map((issue) => `${issue.code}${issue.detail ? ` (${issue.detail})` : ''}`)
        : verdict && verdict.status !== 'supported'
          ? [`проверяющий: ${verdict.status}`]
          : [];
    return reasons.length ? [{ text: claim.text, reasons }] : [];
  });

interface IOutcome {
  answerStatus: AnswerStatus;
  incompleteReason: IncompleteReason | null;
  answerText: string;
}

const incomplete = (reason: IncompleteReason): IOutcome => ({ answerStatus: 'incomplete_processing', incompleteReason: reason, answerText: ANSWER_TEXT[reason]! });

export const answerGenerateHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const runId = String(ctx.job.payload.runId);
    const initial = await getAnswerRun(ctx.pool, runId);
    if (!initial || !['queued', 'running'].includes(initial.status)) {
      await ctx.complete();
      return;
    }
    // Смысловая ветка поиска дожидается своего срока; после него прогон поиска терминализуется деградацией.
    await ctx.withLease((client) => degradeIfExpired(client, initial.search_run_id));
    const search = (await getSearchRun(ctx.pool, initial.search_run_id))!;
    if (search.status === 'pending') throw new RetryableJobError('search_pending', 'смысловая ветка поиска ещё выполняется');
    const run = (await ctx.withLease((client) => markAnswerRunning(client, runId))) as IAnswerRunRow | null;
    if (!run) {
      await ctx.complete();
      return;
    }
    const plan = run.plan as unknown as IAnswerPlan;
    const question = (await ctx.pool.query<{ text: string }>('SELECT text FROM dialog_message WHERE id = $1', [run.question_message_id])).rows[0]!.text;
    const chat = ctx.chat;
    const base: Omit<IAnswerCompletion, keyof IOutcome | 'evidence' | 'claims' | 'coverage'> = {
      providerId: null,
      modelId: null,
      modelVersion: null,
      verificationLevel: 'none',
      inferenceConfig: null,
      configSha256: null,
      inputSha256: null,
      draftSha256: null,
      repairs: 0,
    };
    const finish = (o: IOutcome, rest: Partial<IAnswerCompletion> = {}): Promise<void> =>
      ctx.complete(async (client) => {
        await completeAnswerRun(client, run, { ...base, ...o, evidence: [], claims: [], coverage: {}, ...rest });
      });

    if (plan.needsClarification) return finish({ answerStatus: 'needs_clarification', incompleteReason: null, answerText: ANSWER_TEXT.needs_clarification! });

    // ---- Пакет оснований (правило): область прогона поиска, права автора — сейчас, а не на момент вопроса.
    const access = await loadAccessContext(ctx.pool, run.requested_by, ctx.job.id);
    const scope = await searchScopeCounts(ctx.pool, search.id);
    if (scope.units === 0) return finish({ answerStatus: 'no_data', incompleteReason: null, answerText: ANSWER_TEXT.no_data! });
    const lostUnits = access ? new Set(await unitsNotPermitted(ctx.pool, access, search.allowed_source_unit_ids, search.tender_id, search.mode === 'review' ? 'review' : 'working')) : null;
    const allowedUnits = search.allowed_source_unit_ids.filter((u) => lostUnits !== null && !lostUnits.has(u));
    const found = await searchCandidates(ctx.pool, search.id, search.allowed_source_unit_ids);
    // Граф фактов D-018 по области хода (D-028): фрагменты фактов запланированных типов — перед попаданиями поиска
    // (донор `factsForPlan`); состояние фактов даёт признак редакции основания.
    const scopeFacts = await scopeFactGraph(ctx.pool, search.allowed_source_unit_ids);
    const factHits = factsForPlan(plan, scopeFacts);
    const factCandidates = await fragmentCandidates(ctx.pool, factHits, search.allowed_source_unit_ids, -factHits.length);
    const candidates = [...factCandidates, ...found.filter((f) => !factCandidates.some((c) => c.fragmentId === f.fragmentId))];
    const readable = access ? await readableFragments(ctx.pool, access, candidates.map((c) => c.fragmentId)) : new Set<string>();
    const permitted = candidates.filter((c) => readable.has(c.fragmentId) && allowedUnits.includes(c.sourceUnitId));
    const counts = scope.counts as { unitsNotIndexed?: number; revisionsWithoutRun?: number };
    const scopeIncomplete = (counts.unitsNotIndexed ?? 0) > 0 || (counts.revisionsWithoutRun ?? 0) > 0;
    const coverage: Record<string, unknown> = {
      searchStatus: search.status,
      semanticStatus: search.semantic_status,
      candidates: candidates.length,
      excludedByAccess: candidates.length - permitted.length,
      scopeIncomplete,
    };
    if (permitted.length === 0) {
      const outcome = candidates.length > 0 ? incomplete('no_readable_evidence') : scopeIncomplete ? incomplete('scope_incomplete') : { answerStatus: 'not_found_in_scope' as const, incompleteReason: null, answerText: ANSWER_TEXT.not_found_in_scope! };
      return finish(outcome, { coverage });
    }
    // Состояния фактов — у каждого элемента пакета (R08a-01): гейт проверяет факт, значение которого использует
    // утверждение, а не сводную пометку фрагмента.
    const factsByFragment = new Map<string, IFragmentFact[]>();
    for (const f of scopeFacts) {
      const fact: IFragmentFact = { factId: f.factId, factType: f.factType, status: f.status, rawValue: f.rawValue };
      for (const id of f.fragmentIds) factsByFragment.set(id, [...(factsByFragment.get(id) ?? []), fact]);
    }
    const marks = markVersions(permitted, factsByFragment);
    const items = buildPacket(permitted, marks, ctx.config.answer.packetLimit, factsByFragment);
    const evidence = items.map((i, n) => ({ label: i.label, ordinal: n + 1, fragmentId: i.fragmentId, origin: i.origin, versionNote: i.versionNote, reason: i.reason }));
    Object.assign(coverage, {
      packet: items.length,
      superseded: items.filter((i) => i.versionNote === 'superseded').length,
      conflict: items.filter((i) => i.versionNote === 'conflict').length,
      facts: { inScope: scopeFacts.length, planned: factHits.length },
    });
    const withPacket = { evidence, coverage, inputSha256: packetHash(items) };

    if (!chat) return finish(incomplete('model_disabled'), withPacket);
    const system = draftSystemPrompt(plan);
    if (sha256Hex(system) !== run.prompt_sha256) {
      await ctx.complete(async (client) => failAnswerRun(client, run.id, 'prompt_changed'));
      return;
    }
    const model = {
      providerId: chat.providerId,
      modelId: chat.model,
      modelVersion: chat.version,
      inferenceConfig: chat.inferenceConfig,
      configSha256: configHash({ ...chat.inferenceConfig, verifier: run.verifier_mode, maxRepairs: ctx.config.answer.maxRepairs, packetLimit: ctx.config.answer.packetLimit }),
    };

    // ---- Черновик (модель) — проверки (правило) — проверяющий (модель) — исправление.
    const details = await hitDetails(ctx.pool, items.map((i) => i.fragmentId));
    const places = new Map(items.map((i) => [i.label, details.get(i.fragmentId) ? placeOf(details.get(i.fragmentId)!) : '']));
    const labelByFragment = new Map(items.map((i) => [i.fragmentId, i.label]));
    // R08a-02: история — с текущими правами автора (скрытый ответ — отметкой), до обращения к модели.
    const history = boundedHistory(await previousTurns(ctx.pool, access, run.dialog_id, run.seq));
    let draftSha: string | null = null;

    // Модель отказала: повторяемый отказ — повтор задания (не больше MODEL_RETRY_ATTEMPTS попыток), иначе неполнота.
    const modelFailure = async (retryable: boolean, code: string, message: string): Promise<void> => {
      if (retryable && run.attempt < MODEL_RETRY_ATTEMPTS) throw new RetryableJobError(code, message);
      await finish(incomplete('model_failed'), { ...withPacket, ...model, draftSha256: draftSha, coverage: { ...coverage, modelError: code } });
    };
    const draftOnce = async (feedback: IDraftFeedback[]): Promise<{ draft: IDraft | null; failed: { retryable: boolean; code: string; message: string } | null }> => {
      // Ответ не JSON или не по схеме — ещё одна попытка; повторный отказ — неполнота (draft_invalid).
      for (let attempt = 0; attempt < 2; attempt += 1) {
        ctx.throwIfStopped();
        const res = await chat.complete({ task: 'answer_draft', system, user: draftUserContent({ question, plan, history, items, places, feedback }), signal: ctx.signal });
        if (!res.ok) return { draft: null, failed: { retryable: res.error.retryable, code: `model_${res.error.code.toLowerCase()}`, message: res.error.message } };
        draftSha = sha(res.value.content);
        try {
          return { draft: parseDraft(res.value.content, labelByFragment), failed: null };
        } catch (error) {
          if (!(error instanceof DraftParseError)) throw error;
        }
      }
      return { draft: null, failed: null };
    };

    let { draft, failed } = await draftOnce([]);
    if (failed) return modelFailure(failed.retryable, failed.code, failed.message);
    if (!draft) return finish(incomplete('draft_invalid'), { ...withPacket, ...model, draftSha256: draftSha });

    const byLabel = new Map(items.map((i) => [i.label, i]));
    const context = { evidenceById: byLabel, allowedSourceUnitIds: new Set(allowedUnits), versionPolicy: plan.versionPolicy };
    let repairs = 0;
    let checks = new Map<string, IClaimCheck>();
    let verdict: IVerdict | null = null;
    let verifierStatus: 'off' | 'ok' | 'failed' = run.verifier_mode === 'off' ? 'off' : 'ok';
    for (;;) {
      checks = new Map(checkClaims(draft.claims, context).map((c) => [c.claimId, c]));
      verdict = null;
      const passed = draft.claims.filter((c) => checks.get(c.claimId)!.passed);
      if (run.verifier_mode === 'same_model' && passed.length) {
        ctx.throwIfStopped();
        const res = await chat.complete({ task: 'answer_verify', system: verifierSystemPrompt(), user: verifierUserContent({ question, plan, claims: passed, items }), signal: ctx.signal });
        try {
          verdict = res.ok ? parseVerdict(res.value.content, passed.map((c) => c.claimId)) : null;
        } catch {
          verdict = null;
        }
        verifierStatus = verdict ? 'ok' : 'failed';
      }
      const level = verdict ? 'model' : 'hard_checks';
      const shown = draft.claims.filter((c) => checks.get(c.claimId)!.passed && (level !== 'model' || verdict!.verdicts.get(c.claimId)?.status === 'supported'));
      // Исправление — только если не прошло ни одно утверждение (или черновик пуст), и не больше maxRepairs.
      if (shown.length || repairs >= ctx.config.answer.maxRepairs) break;
      repairs += 1;
      const feedback = draft.claims.length
        ? feedbackFor(draft, checks, verdict?.verdicts ?? new Map())
        : [{ text: '(черновик без утверждений)', reasons: ['в доказательствах есть факты по вопросу — перечисли их утверждениями со ссылками'] }];
      const redraft = await draftOnce(feedback);
      if (!redraft.draft) break;
      draft = redraft.draft;
    }

    // ---- Отрисовка (правило) и запись хода.
    const level = verdict ? 'model' : 'hard_checks';
    const rendered = renderVerifiedAnswer({ claims: draft.claims, checks, verdicts: verdict?.verdicts, conflicts: verdict?.conflicts, items, level, plan });
    const outcome: IOutcome =
      rendered.outcome === 'confirmed'
        ? { answerStatus: 'confirmed_by_citations', incompleteReason: null, answerText: rendered.answer }
        : rendered.outcome === 'conflict'
          ? { answerStatus: 'citations_disagree', incompleteReason: null, answerText: rendered.answer }
          : verdict?.overall === 'clarify'
            ? { answerStatus: 'needs_clarification', incompleteReason: null, answerText: 'Проверяющий счёл вопрос неоднозначным — уточните его.' }
            : { answerStatus: 'incomplete_processing', incompleteReason: 'insufficient_evidence', answerText: rendered.answer };
    const claims = rendered.claims.map((c, n) => ({
      claimNo: n + 1,
      kind: c.kind,
      // Непроверенный текст не хранится: текст — только у показанного утверждения, у остальных — хэш.
      text: c.shown ? c.text : null,
      textSha256: sha(c.text),
      labels: c.labels,
      checkStatus: c.checkStatus,
      issues: c.issues,
      verifierStatus: c.verifierStatus,
      finalStatus: c.status,
      shown: c.shown,
      citations: c.citations,
    }));
    await finish(outcome, {
      ...withPacket,
      ...model,
      verificationLevel: level,
      draftSha256: draftSha,
      repairs,
      claims,
      coverage: {
        ...coverage,
        claims: { total: claims.length, shown: claims.filter((c) => c.shown).length, dropped: claims.filter((c) => !c.shown).length },
        verifier: { mode: run.verifier_mode, status: verifierStatus, overall: verdict?.overall ?? null },
        openQuestions: draft.openQuestions,
        citations: rendered.sources.map((s) => s.label),
        conflictCitations: rendered.conflictCitations,
      },
    });
  },
  // Попытки исчерпаны или ошибка неповторяема: прогон failed — «ответ не получен», это неполнота, а не ответ.
  onTerminalFailure: async (client, ctx, failure) => {
    await failAnswerRun(client, String(ctx.job.payload.runId), failure.code);
  },
};
