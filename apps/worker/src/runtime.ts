// Цикл worker (ADR-004, state-machines §2): захват, heartbeat, условное по токену завершение,
// повтор с задержкой, recovery истёкших аренд, штатная остановка. Типы и ошибки заданий — jobTypes.ts,
// планирование по состоянию БД — scheduling.ts (этап 17).
import { hostname } from 'node:os';
import { createChatModel, type ILocalOcrEngineFactory, type IModelGatewayChat } from '@kontur/adapters';
import { embeddingInputVersion } from '@kontur/core';
import {
  claimJob,
  confirmCancel,
  enqueueJob,
  failJob,
  getActiveVersion,
  getModelStatus,
  heartbeatJob,
  lockOwnedJob,
  recordChatModelStatus,
  recoverExpiredJobs,
  releaseJob,
  requeueJob,
  succeedJob,
  withTransaction,
  type IJobRow,
  type PoolClient,
} from '@kontur/db';
import { isStorageFull, localOcrFactory, nodeDeliveryFs } from '@kontur/storage';
import { MODEL_PROBE_KIND, MODEL_PROBE_PRIORITY } from './handlers/modelProbe.ts';
import {
  EXTERNAL_KINDS,
  INTERACTIVE_KINDS,
  JobCancelledError,
  LeaseLostError,
  PermanentJobError,
  RetryableJobError,
  specOf,
  STORAGE_FULL_DELAY_MS,
  WorkerStoppingError,
  type IJobContext,
  type IJobHandlerSpec,
  type IWorkerOptions,
  type WorkerLoop,
} from './jobTypes.ts';
import { guardGateway, pause } from './loopUtils.ts';
import { runSearchMaintenance, versionOutdated, type IMaintenanceReport } from './maintenance.ts';
import { scheduleCalculationCaptures, scheduleFactExtraction, scheduleLocalRecognition, scheduleScans, scheduleStageInvalidation } from './scheduling.ts';

export * from './jobTypes.ts';

interface IActiveJob {
  stop: () => void;
  done: Promise<void>;
}

export class WorkerRuntime {
  readonly workerId: string;
  private readonly o: IWorkerOptions;
  private readonly log: (line: string) => void;

  private readonly localOcr: ILocalOcrEngineFactory | null;
  private readonly chat: IModelGatewayChat | null;
  private stopping = false;
  private refundOnStop = true;
  private readonly active = new Map<string, IActiveJob>();
  private readonly ticks = new Map<WorkerLoop, number>();
  private readonly busy = new Set<WorkerLoop>();

  constructor(o: IWorkerOptions) {
    this.o = o;
    this.localOcr = o.localOcr !== undefined ? o.localOcr : localOcrFactory(o.config.localRecognition.ocrEngine);
    this.chat = o.chat !== undefined ? o.chat : createChatModel(o.config.chatModel);
    this.workerId = o.workerId ?? `worker:${hostname()}:${process.pid}`;
    this.log = o.log ?? (() => undefined);
  }

  private get leaseMs(): number {
    return this.o.config.jobLeaseSeconds * 1000;
  }

  // Задания, которые выполняет этот экземпляр, recovery не трогает (проект §3.3).
  // Список читается после получения соединения: пока запрос ждал соединения, захват мог завершиться.
  async recover(): Promise<string[]> {
    const client = await this.o.pool.connect();
    try {
      return await recoverExpiredJobs(client, [...this.active.keys()]);
    } finally {
      client.release();
    }
  }

  private lastModelCheck = 0;

  // Проход обслуживания поиска: просроченные прогоны, модель, версии, задания индексации,
  // активация и удаление выведенных версий (state-machines §20–21, G05-02).
  async maintain(o: { checkModel?: boolean } = {}): Promise<IMaintenanceReport> {
    const report = await this.maintainSearch(o);
    await this.scheduleFactExtraction();
    await this.scheduleStageInvalidation();
    return report;
  }

  // Проба модели эмбеддингов — настоящий запрос: у LM Studio он загружает модель и продлевает её срок в памяти.
  // Поэтому, пока модель отвечает, — редко; пока нет — раз в минуту (такой запрос модель не загружает). И не из
  // прохода обслуживания, а заданием model.probe класса gpu: проба ждёт слот, как любое GPU-задание, — к модели
  // портал одновременно обращается не больше одного раза (S17-07, проект §7.5). Явная проверка (checkModel: true —
  // тесты и команды) выполняется сразу, как раньше.
  async maintainSearch(o: { checkModel?: boolean } = {}): Promise<IMaintenanceReport> {
    if (o.checkModel !== undefined) {
      return runSearchMaintenance({ pool: this.o.pool, config: this.o.config, embeddings: this.o.embeddings ?? null, log: this.log }, { checkModel: o.checkModel });
    }
    const status = this.o.embeddings ? await getModelStatus(this.o.pool) : null;
    const modelOk = Boolean(status?.last_success_at && !status.last_error_code);
    // Активная версия построена не настроенной моделью — текстовая версия первого запуска, другое имя или ревизия,
    // другая версия входа (S17-26, R17-08). Проба, пришедшая на постройку другой версии, новую не создаёт: пока
    // отпечаток активной версии не совпал с отпечатком последней успешной пробы, проба идёт с интервалом повтора,
    // а не раз в час. Нет отпечатка пробы — модель ещё не проверена этой конфигурацией: тоже повтор.
    const active = this.o.embeddings ? await getActiveVersion(this.o.pool) : null;
    const fingerprint = typeof status?.details.fingerprint === 'string' ? status.details.fingerprint : null;
    const behind =
      Boolean(this.o.embeddings) &&
      (!active || fingerprint === null || versionOutdated(active, { fingerprint, inputVersion: embeddingInputVersion(this.o.config.embedding.template) }));
    const interval = modelOk && !behind ? this.o.config.search.modelCheckIntervalMs : this.o.config.search.modelRetryIntervalMs;
    const due = Date.now() - this.lastModelCheck >= interval;
    if (due) this.lastModelCheck = Date.now();
    if (due && this.o.embeddings) {
      await enqueueJob(this.o.pool, { kind: MODEL_PROBE_KIND, dedupeKey: 'model-probe', resourceClass: 'gpu', priority: MODEL_PROBE_PRIORITY, maxAttempts: 1 });
    }
    // Без модели проверка — только запись «не настроена», внешних вызовов нет.
    return runSearchMaintenance({ pool: this.o.pool, config: this.o.config, embeddings: this.o.embeddings ?? null, log: this.log }, { checkModel: due && !this.o.embeddings });
  }

  // Обслуживание очереди — только БД (проект §3.3): каждый шаг отдельно, сбой одного не останавливает остальные.
  async maintainQueue(): Promise<void> {
    const steps: Array<[string, () => Promise<unknown>]> = [
      [
        'recovery',
        async () => {
          const recovered = await this.recover();
          if (recovered.length > 0) this.log(`возвращено в очередь после истечения аренды: ${recovered.length}`);
        },
      ],
      // При остановке записи хранилища новые сканы не ставятся: файлы всё равно не запишутся (ADR-011 §10).
      ['сканы', async () => (this.restoreCheck || (await this.o.store.space.level()).level === 'stop' ? 0 : this.scheduleScans())],
      ['выгрузки по сроку', () => (this.restoreCheck ? Promise.resolve(0) : this.scheduleCalculationCaptures())],
      ['локальное распознавание', () => this.scheduleLocalRecognition()],
      ['извлечение фактов', () => this.scheduleFactExtraction()],
      ['инвалидация', () => this.scheduleStageInvalidation()],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (err) {
        this.log(`обслуживание очереди (${name}): ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }

  // Планирование заданий по состоянию БД (scheduling.ts): методы — для прохода обслуживания и тестов.
  scheduleStageInvalidation(): Promise<number> {
    return scheduleStageInvalidation(this.o.pool);
  }

  scheduleFactExtraction(): Promise<number> {
    return scheduleFactExtraction(this.o.pool);
  }

  scheduleScans(): Promise<number> {
    return scheduleScans(this.o.pool);
  }

  scheduleCalculationCaptures(): Promise<number> {
    return scheduleCalculationCaptures(this.o.pool, this.o.config, this.log);
  }

  scheduleLocalRecognition(): Promise<number> {
    return scheduleLocalRecognition(this.o.pool, this.o.config, this.localOcr, this.log);
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
    // Захвачено в момент остановки — обработчик не запускается, задание сразу возвращается.
    if (this.stopping) {
      await this.releaseOnStop(job, token);
      return;
    }
    const controller = new AbortController();
    // Отмена, запрошенная до захвата (в том числе у задания, вернувшегося в очередь после
    // recovery), проходит тем же доменно-осведомлённым путём, что и отмена на ходу (R04-02).
    // Остановка worker (shutdown) не перекрывает отмену и потерю аренды: они сильнее.
    // Тип задан приведением: значение меняют замыкания (heartbeat, остановка), сужать его по инициализатору нельзя.
    let stopReason = (job.cancel_requested ? 'cancel' : null) as 'lost' | 'cancel' | 'shutdown' | null;
    if (stopReason) controller.abort();
    let resolveDone: () => void = () => undefined;
    this.active.set(job.id, {
      stop: () => {
        stopReason = stopReason ?? 'shutdown';
        controller.abort();
      },
      done: new Promise<void>((r) => {
        resolveDone = r;
      }),
    });
    // После подтверждённой потери аренды новые heartbeat не отправляются (R03-11):
    // обработчик может ещё не завершиться по AbortSignal, но трогать аренду он больше не должен.
    // Heartbeat не проходит дольше аренды (БД недоступна) — аренда считается потерянной: иначе
    // вызов модели продолжал бы занимать GPU после того, как задание могли передать другому.
    let beating = false;
    let lastBeatOk = Date.now();
    const beat: NodeJS.Timeout = setInterval(() => {
      if (beating || stopReason === 'lost') return;
      beating = true;
      heartbeatJob(this.o.pool, job.id, token, this.leaseMs).then(
        (hb) => {
          beating = false;
          if (!hb.ok) {
            stopReason = 'lost';
            clearInterval(beat);
          } else {
            lastBeatOk = Date.now();
            if (hb.cancelRequested && stopReason !== 'shutdown') stopReason = stopReason ?? 'cancel';
          }
          if (stopReason) controller.abort();
        },
        () => {
          beating = false;
          if (Date.now() - lastBeatOk > this.leaseMs) {
            stopReason = 'lost';
            clearInterval(beat);
            controller.abort();
          }
        },
      );
    }, Math.max(200, Math.floor(this.leaseMs / 3)));
    let completed = false;
    const throwIfStopped = (): void => {
      if (stopReason === 'lost') throw new LeaseLostError();
      if (stopReason === 'cancel') throw new JobCancelledError('отмена запрошена');
      if (stopReason === 'shutdown') throw new WorkerStoppingError();
    };
    // После остановки новых доменных транзакций нет; начатая до неё доходит до конца (проект §3.1).
    const withLease = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      if (stopReason === 'shutdown') throw new WorkerStoppingError();
      return withTransaction(this.o.pool, async (client) => {
        if (!(await lockOwnedJob(client, job.id, token))) throw new LeaseLostError();
        return fn(client);
      });
    };
    const ctx: IJobContext = {
      job,
      token,
      pool: this.o.pool,
      store: this.o.store,
      config: this.o.config,
      embeddings: guardGateway(this.o.embeddings ?? null, ['embed', 'probe'], throwIfStopped),
      localOcr: this.localOcr,
      chat: guardGateway(this.chat, ['complete'], throwIfStopped, (out) => this.noteChatResult(out)),
      deliveryFs: this.o.deliveryFs ?? nodeDeliveryFs(),
      signal: controller.signal,
      withLease,
      complete: async (fn, then) => {
        await withLease(async (client) => {
          if (fn) await fn(client);
          if (!(await succeedJob(client, job.id, token))) throw new LeaseLostError();
          if (then) await then(client);
        });
        completed = true;
      },
      throwIfStopped,
    };
    const spec = this.o.handlers[job.kind] ? specOf(this.o.handlers[job.kind]!) : null;
    try {
      if (!spec) throw new PermanentJobError('unknown_kind', `нет обработчика ${job.kind}`);
      // Отменённое до захвата задание не выполняется вовсе: сразу доменная отмена (R04-02).
      ctx.throwIfStopped();
      await spec.run(ctx);
      if (!completed) await ctx.complete();
      this.log(`задание ${job.kind} ${job.id} выполнено`);
    } catch (err) {
      // Остановка worker: задание возвращает сам владелец, попытка не теряется. Отмена и потеря аренды —
      // прежними путями (у них stopReason другой).
      if (stopReason === 'shutdown' && !completed && !(err instanceof LeaseLostError)) await this.releaseOnStop(job, token);
      else await this.onError(job, token, err, spec, ctx);
    } finally {
      clearInterval(beat);
      this.active.delete(job.id);
      resolveDone();
    }
  }

  // Статус генеративной модели по результату вызова (S17-12): видно, отвечает ли модель и почему нет.
  private async noteChatResult(out: unknown): Promise<void> {
    const r = out as { ok: boolean; error?: { code: string } };
    await recordChatModelStatus(this.o.pool, {
      ok: r.ok,
      errorCode: r.ok ? null : (r.error?.code ?? 'UNKNOWN'),
      details: { provider: this.chat?.providerId ?? null, model: this.chat?.model ?? null },
    });
  }

  private async releaseOnStop(job: IJobRow, token: string): Promise<void> {
    try {
      const ok = await releaseJob(this.o.pool, job, token, {
        code: 'worker_stopped',
        message: 'задание прервано остановкой worker и возвращено в очередь',
        delayMs: 0,
        refundAttempt: this.refundOnStop,
      });
      this.log(`задание ${job.kind} ${job.id}: остановка worker → ${ok ? 'возвращено в очередь' : 'аренда уже потеряна'}`);
    } catch (err) {
      // БД недоступна: задание вернёт recovery после истечения аренды.
      this.log(`задание ${job.kind} ${job.id}: вернуть при остановке не удалось (${err instanceof Error ? err.message : 'unknown'})`);
    }
  }

  // Штатная остановка (проект §3.1): новых заданий нет, активные прерываются и возвращаются владельцем.
  // Не уложились в срок — остаются running, их вернёт recovery после аренды (прежний путь).
  async shutdown(o: { deadlineMs: number; refundAttempt: boolean }): Promise<{ released: number; abandoned: number }> {
    this.stopping = true;
    this.refundOnStop = o.refundAttempt;
    const jobs = [...this.active.values()];
    for (const j of jobs) j.stop();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(jobs.map((j) => j.done)).then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), o.deadlineMs);
      }),
    ]);
    clearTimeout(timer);
    const abandoned = timedOut ? this.active.size : 0;
    return { released: jobs.length - abandoned, abandoned };
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  activeJobIds(): string[] {
    return [...this.active.keys()];
  }

  // Живость для heartbeat процесса (проект §3.3): каждый запущенный цикл недавно сделал шаг или выполняет
  // задание. Heartbeat пишется только при живости — /ready видит зависший цикл (S17-06).
  liveness(maxAgeMs: number): { ok: boolean; stale: WorkerLoop[] } {
    const now = Date.now();
    const stale = [...this.ticks.entries()].filter(([loop, at]) => !this.busy.has(loop) && now - at > maxAgeMs).map(([loop]) => loop);
    return { ok: stale.length === 0, stale };
  }

  private tick(loop: WorkerLoop): void {
    this.ticks.set(loop, Date.now());
  }

  private async onError(job: IJobRow, token: string, err: unknown, spec: IJobHandlerSpec | null, ctx: IJobContext): Promise<void> {
    // Нет места в хранилище (ADR-011 §10): задание ждёт с явным кодом и без списания попытки — продолжится само,
    // когда место освободят; доменный отказ не пишется (этап 17, проект §6).
    if (isStorageFull(err)) {
      const ok = await releaseJob(this.o.pool, job, token, {
        code: 'storage_full',
        message: err instanceof Error ? err.message : 'в хранилище закончилось место',
        delayMs: STORAGE_FULL_DELAY_MS,
        refundAttempt: true,
      }).catch(() => false);
      this.log(`задание ${job.kind} ${job.id}: нет места в хранилище → ${ok ? 'ждёт в очереди' : 'аренда потеряна'}`);
      return;
    }
    if (err instanceof LeaseLostError) {
      // Аренда перехвачена: ничего не пишем (R01-06 п. 1).
      this.log(`задание ${job.id}: аренда потеряна, результат не записан`);
      return;
    }
    if (err instanceof JobCancelledError) {
      // Доменная отмена и статус задания фиксируются одной транзакцией под действующей арендой:
      // расхождения «задание cancelled, прогон running» быть не должно (R04-02). Не удалось —
      // задание возвращается в очередь, как при неудачной фиксации терминальной ошибки (R03-05).
      try {
        const ok = await withTransaction(this.o.pool, async (client) => {
          if (!(await lockOwnedJob(client, job.id, token))) return false;
          if (spec?.onCancel) await spec.onCancel(client, ctx);
          return confirmCancel(client, job.id, token);
        });
        this.log(`задание ${job.id}: отмена ${ok ? 'подтверждена' : 'не подтверждена (аренда потеряна)'}`);
      } catch (cancelErr) {
        const detail = cancelErr instanceof Error ? cancelErr.message : 'unknown';
        const requeued = await requeueJob(this.o.pool, job, token, {
          code: 'cancel_fixation_failed',
          message: `доменная отмена не зафиксирована (${detail})`,
        });
        this.log(
          `задание ${job.id}: фиксация отмены не удалась (${detail}) → ${requeued ? 'возвращено в очередь' : 'аренда потеряна'}`,
        );
      }
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

  private get restoreCheck(): boolean {
    return this.o.config.workerMode === 'restore_check';
  }

  // Основной цикл процесса worker: две полосы заданий и два прохода обслуживания (проект §3.3).
  async loop(signal: AbortSignal, pollMs = 500): Promise<void> {
    const interval = this.o.config.search.maintenanceIntervalMs;
    const background = this.restoreCheck ? Object.keys(this.o.handlers).filter((k) => !EXTERNAL_KINDS.includes(k)) : null;
    await Promise.all([
      this.laneLoop(signal, background, pollMs, 'background'),
      this.laneLoop(signal, INTERACTIVE_KINDS, Math.min(pollMs, 200), 'interactive'),
      this.periodicLoop(signal, 'queue', interval, () => this.maintainQueue()),
      this.periodicLoop(signal, 'search', interval, () => this.maintainSearch()),
    ]);
  }

  // Полоса захвата с тем же протоколом аренды; kinds = null — все виды заданий (фоновая полоса).
  async laneLoop(signal: AbortSignal, kinds: readonly string[] | null, pollMs: number, name: WorkerLoop = 'interactive'): Promise<void> {
    this.tick(name);
    while (!signal.aborted) {
      this.tick(name);
      this.busy.add(name);
      let worked = false;
      try {
        worked = await this.runOnce(kinds ? [...kinds] : undefined);
      } catch (err) {
        this.log(`ошибка полосы ${name}: ${err instanceof Error ? err.message : 'unknown'}`);
      } finally {
        this.busy.delete(name);
        this.tick(name);
      }
      if (!worked) await pause(pollMs, signal);
    }
  }

  private async periodicLoop(signal: AbortSignal, name: WorkerLoop, intervalMs: number, fn: () => Promise<unknown>): Promise<void> {
    this.tick(name);
    while (!signal.aborted) {
      try {
        await fn();
      } catch (err) {
        this.log(`ошибка обслуживания ${name}: ${err instanceof Error ? err.message : 'unknown'}`);
      }
      this.tick(name);
      await pause(intervalMs, signal);
    }
  }
}
