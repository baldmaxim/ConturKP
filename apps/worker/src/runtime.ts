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

export type JobHandler = (ctx: IJobContext) => Promise<void>;

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
    const beat = setInterval(() => {
      heartbeatJob(this.o.pool, job.id, token, this.leaseMs).then(
        (hb) => {
          if (!hb.ok) stopReason = 'lost';
          else if (hb.cancelRequested) stopReason = stopReason ?? 'cancel';
          if (stopReason) controller.abort();
        },
        () => undefined,
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
    try {
      const handler = this.o.handlers[job.kind];
      if (!handler) throw new PermanentJobError('unknown_kind', `нет обработчика ${job.kind}`);
      await handler(ctx);
      if (!completed) await ctx.complete();
      this.log(`задание ${job.kind} ${job.id} выполнено`);
    } catch (err) {
      await this.onError(job, token, err);
    } finally {
      clearInterval(beat);
    }
  }

  private async onError(job: IJobRow, token: string, err: unknown): Promise<void> {
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
