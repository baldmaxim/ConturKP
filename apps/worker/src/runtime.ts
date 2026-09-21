// Цикл worker (ADR-004, state-machines §2): захват, heartbeat, условное по токену завершение,
// повтор с задержкой, recovery истёкших аренд, планирование сканов наблюдаемых папок.
import { hostname } from 'node:os';
import type { IAppConfig } from '@kontur/config';
import {
  claimJob,
  confirmCancel,
  dueChannels,
  enqueueJob,
  failJob,
  heartbeatJob,
  lockOwnedJob,
  markScanStarted,
  recoverExpiredJobs,
  requeueJob,
  succeedJob,
  withTransaction,
  type IJobRow,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';

export class LeaseLostError extends Error {
  constructor() {
    super('аренда задания потеряна');
  }
}
export class JobCancelledError extends Error {}
export class RetryableJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export class PermanentJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface IJobContext {
  job: IJobRow;
  token: string;
  pool: Pool;
  store: BlobStore;
  config: IAppConfig;
  signal: AbortSignal;
  // Короткая транзакция под действующей арендой: сначала блокировка задания с проверкой токена.
  withLease: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  // Доменный результат и перевод задания в succeeded — в одной транзакции (R01-06 п. 2).
  complete: (fn?: (client: PoolClient) => Promise<void>) => Promise<void>;
  throwIfStopped: () => void;
}

export interface IJobFailure {
  code: string;
  message: string;
}

// Обработчик задания. onTerminalFailure — доменная фиксация терминальной ошибки (попытки
// исчерпаны или ошибка неповторяемая): выполняется в одной транзакции с переводом задания
// в failed и под действующей арендой (R03-05). Потеря аренды означает, что не пишется ничего.
export interface IJobHandlerSpec {
  run: (ctx: IJobContext) => Promise<void>;
  onTerminalFailure?: (client: PoolClient, ctx: IJobContext, failure: IJobFailure) => Promise<void>;
}

export type JobHandler = IJobHandlerSpec | ((ctx: IJobContext) => Promise<void>);

const specOf = (handler: JobHandler): IJobHandlerSpec => (typeof handler === 'function' ? { run: handler } : handler);

export interface IWorkerOptions {
  pool: Pool;
  store: BlobStore;
  config: IAppConfig;
  handlers: Record<string, JobHandler>;
  workerId?: string;
  log?: (line: string) => void;
}

export class WorkerRuntime {
  readonly workerId: string;
  private readonly o: IWorkerOptions;
  private readonly log: (line: string) => void;

  constructor(o: IWorkerOptions) {
    this.o = o;
    this.workerId = o.workerId ?? `worker:${hostname()}:${process.pid}`;
    this.log = o.log ?? (() => undefined);
  }

  private get leaseMs(): number {
    return this.o.config.jobLeaseSeconds * 1000;
  }

  async recover(): Promise<string[]> {
    return recoverExpiredJobs(this.o.pool);
  }

  // Каналы, которым пора сканировать, получают задание (dedupe — одно активное на канал).
  async scheduleScans(): Promise<number> {
    const due = await dueChannels(this.o.pool);
    for (const ch of due) {
      await withTransaction(this.o.pool, async (client) => {
        await enqueueJob(client, { kind: 'intake.scan', dedupeKey: `scan:${ch.id}`, payload: { channelId: ch.id }, tenderId: ch.tender_id, resourceClass: 'network' });
        await markScanStarted(client, ch.id);
      });
    }
    return due.length;
  }

  // Захватывает и выполняет одно задание. Возвращает false, если очередь пуста.
  async runOnce(kinds?: string[]): Promise<boolean> {
    const job = await claimJob(this.o.pool, {
      workerId: this.workerId,
      leaseMs: this.leaseMs,
      gpuGraceMs: this.o.config.gpuTakeoverGraceSeconds * 1000,
      ...(kinds ? { kinds } : {}),
    });
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  async execute(job: IJobRow): Promise<void> {
    const token = job.lease_token!;
    const controller = new AbortController();
    let stopReason: 'lost' | 'cancel' | null = null;
    // После подтверждённой потери аренды новые heartbeat не отправляются (R03-11):
    // обработчик может ещё не завершиться по AbortSignal, но трогать аренду он больше не должен.
    let beating = false;
    const beat: NodeJS.Timeout = setInterval(() => {
      if (beating || stopReason === 'lost') return;
      beating = true;
      heartbeatJob(this.o.pool, job.id, token, this.leaseMs).then(
        (hb) => {
          beating = false;
          if (!hb.ok) {
            stopReason = 'lost';
            clearInterval(beat);
          } else if (hb.cancelRequested) {
            stopReason = stopReason ?? 'cancel';
          }
          if (stopReason) controller.abort();
        },
        () => {
          beating = false;
        },
      );
    }, Math.max(200, Math.floor(this.leaseMs / 3)));
    let completed = false;
    const withLease = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
      withTransaction(this.o.pool, async (client) => {
        if (!(await lockOwnedJob(client, job.id, token))) throw new LeaseLostError();
        return fn(client);
      });
    const ctx: IJobContext = {
      job,
      token,
      pool: this.o.pool,
      store: this.o.store,
      config: this.o.config,
      signal: controller.signal,
      withLease,
      complete: async (fn) => {
        await withLease(async (client) => {
          if (fn) await fn(client);
          if (!(await succeedJob(client, job.id, token))) throw new LeaseLostError();
        });
        completed = true;
      },
      throwIfStopped: () => {
        if (stopReason === 'lost') throw new LeaseLostError();
        if (stopReason === 'cancel') throw new JobCancelledError('отмена запрошена');
      },
    };
    const spec = this.o.handlers[job.kind] ? specOf(this.o.handlers[job.kind]!) : null;
    try {
      if (!spec) throw new PermanentJobError('unknown_kind', `нет обработчика ${job.kind}`);
      await spec.run(ctx);
      if (!completed) await ctx.complete();
      this.log(`задание ${job.kind} ${job.id} выполнено`);
    } catch (err) {
      await this.onError(job, token, err, spec, ctx);
    } finally {
      clearInterval(beat);
    }
  }

  private async onError(job: IJobRow, token: string, err: unknown, spec: IJobHandlerSpec | null, ctx: IJobContext): Promise<void> {
    if (err instanceof LeaseLostError) {
      // Аренда перехвачена: ничего не пишем (R01-06 п. 1).
      this.log(`задание ${job.id}: аренда потеряна, результат не записан`);
      return;
    }
    if (err instanceof JobCancelledError) {
      const ok = await confirmCancel(this.o.pool, job.id, token);
      this.log(`задание ${job.id}: отмена ${ok ? 'подтверждена' : 'не подтверждена (аренда потеряна)'}`);
      return;
    }
    const retryable = !(err instanceof PermanentJobError);
    const code = err instanceof RetryableJobError || err instanceof PermanentJobError ? err.code : 'internal';
    const message = err instanceof Error ? err.message : 'неизвестная ошибка';
    const terminal = !retryable || job.attempts >= job.max_attempts;
    // Граница терминальной ошибки: доменный отказ и статус задания фиксируются вместе,
    // после проверки аренды (R03-05). Отдельного «добивания» после failJob быть не должно.
    if (terminal && spec?.onTerminalFailure) {
      try {
        await withTransaction(this.o.pool, async (client) => {
          if (!(await lockOwnedJob(client, job.id, token))) throw new LeaseLostError();
          await spec.onTerminalFailure!(client, ctx, { code, message });
          if (!(await failJob(client, job, token, { retryable: false, code, message })).ok) throw new LeaseLostError();
        });
        this.log(`задание ${job.kind} ${job.id}: терминальная ошибка ${code} → failed, доменный отказ зафиксирован`);
        return;
      } catch (terminalErr) {
        if (terminalErr instanceof LeaseLostError) {
          this.log(`задание ${job.id}: аренда потеряна при фиксации терминальной ошибки, результат не записан`);
          return;
        }
        // Доменный отказ не зафиксирован (откат транзакции): объявлять задание failed нельзя —
        // это вернуло бы расхождение «задание failed, партия running». Задание возвращается
        // в очередь с задержкой и остаётся видимым как незавершённое (R03-05).
        const detail = terminalErr instanceof Error ? terminalErr.message : 'unknown';
        const requeued = await requeueJob(this.o.pool, job, token, {
          code: 'terminal_fixation_failed',
          message: `${code}: доменный отказ не зафиксирован (${detail})`,
        });
        this.log(
          `задание ${job.kind} ${job.id}: фиксация терминальной ошибки не удалась (${detail}) → ${requeued ? 'возвращено в очередь' : 'аренда потеряна'}; failed не выставляется`,
        );
        return;
      }
    }
    const r = await failJob(this.o.pool, job, token, { retryable, code, message });
    this.log(`задание ${job.kind} ${job.id}: ошибка ${code} → ${r.ok ? r.status : 'аренда потеряна'}`);
  }

  // Основной цикл процесса worker.
  async loop(signal: AbortSignal, pollMs = 500): Promise<void> {
    let lastMaintenance = 0;
    while (!signal.aborted) {
      try {
        if (Date.now() - lastMaintenance > 5000) {
          lastMaintenance = Date.now();
          const recovered = await this.recover();
          if (recovered.length > 0) this.log(`возвращено в очередь после истечения аренды: ${recovered.length}`);
          await this.scheduleScans();
        }
        const worked = await this.runOnce();
        if (!worked) await new Promise((r) => setTimeout(r, pollMs));
      } catch (err) {
        this.log(`ошибка цикла: ${err instanceof Error ? err.message : 'unknown'}`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }
}

export const isStopped = (e: unknown): boolean => e instanceof LeaseLostError || e instanceof JobCancelledError;
