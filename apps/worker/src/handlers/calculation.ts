// Выгрузка расчёта TenderHub (state-machines §6, ADR-007 §5, этап 06). Задание читает официальный API
// вне транзакции, сохраняет каждый сырой ответ в хранилище и манифест выгрузки, затем одной транзакцией
// под арендой пишет содержимое, ревизию provisional и событие барьера. Изменение данных во время чтения —
// попытка inconsistent и повтор; после исчерпания попыток выгрузка inconsistent без ревизии.
import { Readable } from 'node:stream';
import {
  runPortalCapture,
  TENDERHUB_CONTRACT_VERSION,
  TenderHubApiSource,
  TenderHubError,
  TenderHubHttpClient,
  type IRawResponse,
  type ITenderHubSource,
} from '@kontur/adapters';
import type { ITenderHubConfig } from '@kontur/config';
import { calculationContentHash, KP_TOTAL_RULE_NOT_SET } from '@kontur/core';
import {
  appendCaptureAttempt,
  CalculationDomainError,
  completePortalCapture,
  finishCaptureWithFailure,
  getCapture,
  insertBlob,
  recordTenderHubStatus,
} from '@kontur/db';
import { isStopped, PermanentJobError, RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

// Сколько раз один запрос ждёт минутное окно после 429, прежде чем попытка завершится RATE_LIMITED.
const RATE_LIMIT_WAITS = 2;

// Источник данных задаётся конфигурацией; тест может подменить фабрику (поддельный сервер — тот же HTTP).
export const tenderHubSourceFrom = (th: ITenderHubConfig): ITenderHubSource =>
  new TenderHubApiSource(
    new TenderHubHttpClient({
      baseUrl: th.baseUrl!,
      apiKey: th.apiKey!,
      timeoutMs: th.timeoutMs,
      rateLimitPerMinute: th.rateLimitPerMinute,
      windowMs: th.rateLimitWindowMs,
      maxResponseBytes: th.maxResponseBytes,
      rateLimitWaits: RATE_LIMIT_WAITS,
    }),
  );

const captureIdOf = (ctx: IJobContext): string => {
  const id = (ctx.job.payload as { captureId?: unknown }).captureId;
  if (typeof id !== 'string') throw new PermanentJobError('bad_payload', 'в задании нет captureId');
  return id;
};

interface IStoredBundle {
  sha256: string;
  responses: { route: string; path: string; status: number; contentEncoding: string | null; sourceDate: string | null; receivedAt: string; sha256: string; bytes: number }[];
}

// Сырые ответы (тело после распаковки gzip) и манифест выгрузки — в хранилище по содержимому (ADR-003).
const storeRaws = async (ctx: IJobContext, captureId: string, externalTenderId: string, raws: IRawResponse[]): Promise<IStoredBundle> => {
  const stored: IStoredBundle['responses'] = [];
  const blobs: { sha256: string; sizeBytes: number; storageKey: string }[] = [];
  for (const raw of raws) {
    ctx.throwIfStopped();
    const s = await ctx.store.putStream(Readable.from([raw.body]), ctx.config.tenderhub.maxResponseBytes);
    blobs.push({ sha256: s.sha256, sizeBytes: s.sizeBytes, storageKey: s.storageKey });
    stored.push({
      route: raw.route,
      path: raw.path,
      status: raw.status,
      contentEncoding: raw.contentEncoding,
      sourceDate: raw.sourceDate,
      receivedAt: raw.receivedAt,
      sha256: s.sha256,
      bytes: s.sizeBytes,
    });
  }
  const manifest = Buffer.from(
    JSON.stringify({
      kind: 'kontur.tenderhub.capture.v1',
      captureId,
      externalTenderId,
      contractVersion: TENDERHUB_CONTRACT_VERSION,
      transport: 'api',
      origin: new URL(ctx.config.tenderhub.baseUrl!).origin,
      responses: stored,
    }),
    'utf8',
  );
  const m = await ctx.store.putStream(Readable.from([manifest]), ctx.config.tenderhub.maxResponseBytes);
  await ctx.withLease(async (client) => {
    for (const b of [...blobs, { sha256: m.sha256, sizeBytes: m.sizeBytes, storageKey: m.storageKey }]) {
      await insertBlob(client, { sha256: b.sha256, sizeBytes: b.sizeBytes, mediaType: 'application/json', storageKey: b.storageKey });
    }
  });
  return { sha256: m.sha256, responses: stored };
};

// Отказ, пришедший из БД при фиксации содержимого (сверка полноты и хэша миграции 0011), — неповторяемый.
const isDbInvariant = (err: unknown): boolean => {
  const code = (err as { code?: unknown }).code;
  return code === '23514' || code === '55000';
};

// Любой отказ попытки, кроме потери аренды и отмены, попадает в журнал попыток выгрузки. Ошибки
// адаптера и изменение данных журнал уже получили на месте — с подробностями.
const recordFailedAttempt = async (ctx: IJobContext, captureId: string, startedAt: string, err: unknown): Promise<void> => {
  if (isStopped(err) || (err instanceof Error && (err.name === 'AbortError' || logged.has(err)))) return;
  const code = err instanceof RetryableJobError || err instanceof PermanentJobError ? err.code : 'internal';
  await ctx
    .withLease((client) =>
      appendCaptureAttempt(client, captureId, {
        no: ctx.job.attempts,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: 'failed',
        code,
        message: (err instanceof Error ? err.message : 'неизвестная ошибка').slice(0, 300),
      }),
    )
    .catch(() => undefined);
};

// Ошибки, попытка которых уже записана в журнал на месте (с подробностями): повторно не пишутся.
const logged = new WeakSet<Error>();
const loggedError = <T extends Error>(err: T): T => {
  logged.add(err);
  return err;
};

const runCapture = async (ctx: IJobContext, captureId: string, startedAt: string): Promise<void> => {
  const capture = await getCapture(ctx.pool, captureId);
  if (!capture || capture.status !== 'capturing') return;
  const th = ctx.config.tenderhub;
  if (!th.baseUrl || !th.apiKey) {
    throw new PermanentJobError('integration_not_configured', 'TenderHub не настроен: нет TENDERHUB_URL или TENDERHUB_API_KEY (U-04)');
  }
  const attemptNo = ctx.job.attempts;
  let result;
  try {
    result = await runPortalCapture(tenderHubSourceFrom(th), capture.external_tender_id, ctx.signal);
  } catch (err) {
    ctx.throwIfStopped();
    if (!(err instanceof TenderHubError)) throw err;
    const e = err.error;
    await ctx.withLease(async (client) => {
      await appendCaptureAttempt(client, captureId, {
        no: attemptNo,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: 'failed',
        code: e.reason,
        adapterCode: e.code,
        message: e.message,
        retryable: e.retryable,
        ...(e.details ? { details: e.details } : {}),
      });
      await recordTenderHubStatus(client, { ok: false, errorCode: e.reason, details: { adapterCode: e.code, route: e.details?.route ?? null } });
    });
    if (e.retryable) throw loggedError(new RetryableJobError(e.reason, e.message));
    throw loggedError(new PermanentJobError(e.reason, e.message));
  }
  ctx.throwIfStopped();
  const bundle = await storeRaws(ctx, captureId, capture.external_tender_id, result.raws);
  const attempt = {
    no: attemptNo,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome: result.consistency.outcome,
    reasons: result.consistency.reasons,
    rawBundleSha256: bundle.sha256,
    responses: bundle.responses.length,
  };
  if (result.consistency.outcome === 'inconsistent') {
    // Ложную согласованную ревизию не создаём: попытка записана, выгрузка повторяется (ADR-007 §5).
    await ctx.withLease((client) => appendCaptureAttempt(client, captureId, attempt));
    throw loggedError(new RetryableJobError('source_changed', 'данные TenderHub менялись во время выгрузки'));
  }
  const content = result.content!;
  try {
    await ctx.complete(async (client) => {
      try {
        const r = await completePortalCapture(client, {
          captureId,
          content,
          contentHash: calculationContentHash(content),
          headerLexemes: result.headerLexemes,
          kpTotalSemantics: { ...KP_TOTAL_RULE_NOT_SET },
          rawBundleSha256: bundle.sha256,
          consistency: { ...result.consistency },
          sourceObserved: { ...result.observed },
          contractVersion: TENDERHUB_CONTRACT_VERSION,
          attempt,
        });
        await recordTenderHubStatus(client, {
          ok: true,
          errorCode: null,
          details: { lastCaptureId: captureId, revisionCreated: r.revisionCreated, positions: content.positions.length, lines: content.lines.length },
        });
      } catch (err) {
        if (err instanceof CalculationDomainError) throw new PermanentJobError(err.code, err.message);
        throw err;
      }
    });
  } catch (err) {
    if (isDbInvariant(err)) throw new PermanentJobError('content_rejected_by_db', `БД отклонила содержимое выгрузки: ${(err as Error).message}`);
    throw err;
  }
};

export const calculationCaptureHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const captureId = captureIdOf(ctx);
    const startedAt = new Date().toISOString();
    try {
      await runCapture(ctx, captureId, startedAt);
    } catch (err) {
      await recordFailedAttempt(ctx, captureId, startedAt, err);
      throw err;
    }
  },
  onTerminalFailure: async (client, ctx, failure) => {
    // source_changed во всех попытках — выгрузка inconsistent; иначе failed. Ревизии нет в обоих случаях.
    await finishCaptureWithFailure(client, captureIdOf(ctx), {
      status: failure.code === 'source_changed' ? 'inconsistent' : 'failed',
      code: failure.code,
      detail: failure.message,
    });
  },
  onCancel: async (client, ctx) => {
    await finishCaptureWithFailure(client, captureIdOf(ctx), { status: 'failed', code: 'cancelled', detail: 'выгрузка отменена' });
  },
};
