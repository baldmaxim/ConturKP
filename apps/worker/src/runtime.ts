// Цикл worker (ADR-004, state-machines §2): захват, heartbeat, условное по токену завершение,
// повтор с задержкой, recovery истёкших аренд, планирование сканов наблюдаемых папок.
import { hostname } from 'node:os';
import {
  createChatModel,
  describeLocalRecognizer,
  localSettings,
  type IDeliveryFs,
  type ILocalOcrEngineFactory,
  type IModelGatewayChat,
  type IModelGatewayEmbeddings,
  type LocalInputFormat,
} from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import {
  autoRecognitionCandidates,
  claimJob,
  confirmCancel,
  dueChannels,
  dueDeadlineCaptures,
  enqueueFactExtraction,
  enqueueJob,
  enqueueLocalRecognition,
  failJob,
  gpuSlotBusy,
  heartbeatJob,
  lockOwnedJob,
  markScanStarted,
  recognizerFingerprint,
  recoverExpiredJobs,
  releaseJob,
  requestCapture,
  requeueJob,
  runsAwaitingExtraction,
  eventsAwaitingInvalidation,
  enqueueInvalidation,
  succeedJob,
  withTransaction,
  type FingerprintByFormat,
  type IJobRow,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import { localOcrFactory, nodeDeliveryFs, type BlobStore } from '@kontur/storage';
import { runSearchMaintenance, type IMaintenanceReport } from './maintenance.ts';

export class LeaseLostError extends Error {
  constructor() {
    super('аренда задания потеряна');
  }
}
export class JobCancelledError extends Error {}
// Штатная остановка worker (этап 17, проект §3.1): доменные записи закрыты, задание вернёт сам владелец.
export class WorkerStoppingError extends Error {
  constructor() {
    super('worker останавливается');
  }
}
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
  // Шлюз модели эмбеддингов (ADR-012 §25); null — модель не настроена.
  embeddings: IModelGatewayEmbeddings | null;
  // Фабрика локального OCR (этап 05a); null — OCR не настроен (LOCAL_OCR_ENGINE=none).
  localOcr: ILocalOcrEngineFactory | null;
  // Генеративная модель этапа 08 (OD-08-2); null — модель не настроена (MODEL_PROVIDER=none).
  chat: IModelGatewayChat | null;
  // Файловые операции размещения (этап 14, D-034); в тестах — обёртка с внесением отказов.
  deliveryFs: IDeliveryFs;
  signal: AbortSignal;
  // Короткая транзакция под действующей арендой: сначала блокировка задания с проверкой токена.
  withLease: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  // Доменный результат и перевод задания в succeeded — в одной транзакции (R01-06 п. 2).
  // then выполняется в той же транзакции после перевода: следующая пачка того же вида
  // встаёт в очередь без конфликта dedupe_key с самим завершающимся заданием (ADR-004 §7a).
  complete: (fn?: (client: PoolClient) => Promise<void>, then?: (client: PoolClient) => Promise<void>) => Promise<void>;
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
  // Доменная отмена: выполняется в одной транзакции с переводом задания в cancelled и под
  // действующей арендой (R04-02). Без неё доменный объект остаётся активным без задания.
  onCancel?: (client: PoolClient, ctx: IJobContext) => Promise<void>;
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
  embeddings?: IModelGatewayEmbeddings | null;
  // Фабрика OCR для тестов; по умолчанию — по конфигурации (LOCAL_OCR_ENGINE).
  localOcr?: ILocalOcrEngineFactory | null;
  // Генеративная модель для тестов (сценарии отказов); по умолчанию — по конфигурации (MODEL_PROVIDER).
  chat?: IModelGatewayChat | null;
  // Файловые операции размещения для тестов (отказы сети, прав, места, неизвестный исход); по умолчанию — node:fs.
  deliveryFs?: IDeliveryFs;
}

// Интерактивная полоса (ADR-004 §7a): только смысловые запросы поиска. Worker выполняет задания
// последовательно, поэтому без отдельной полосы запрос ждал бы окончания любого долгого задания.
// Интерактивная полоса (ADR-004 §7a): смысловая ветка поиска и ответ ответного ядра (этап 08a).
export const INTERACTIVE_KINDS: readonly string[] = ['search.semantic', 'answer.generate'];

// Циклы процесса worker (этап 17, проект §3.3): полосы заданий и два прохода обслуживания идут независимо,
// поэтому долгое задание фоновой полосы не останавливает recovery и планирование (S17-05).
export type WorkerLoop = 'background' | 'interactive' | 'queue' | 'search';

// Виды заданий с внешними действиями: на восстановленной копии (WORKER_MODE=restore_check) не выполняются и не
// планируются — пути назначений, папки и TenderHub в копии настоящие (проект §4.4, толкование §16 п. 3).
export const EXTERNAL_KINDS: readonly string[] = ['delivery.place', 'delivery.probe', 'calculation.capture', 'intake.scan'];

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

interface IActiveJob {
  stop: () => void;
  done: Promise<void>;
}

// Методы шлюзов модели, после которых проверяется остановка: прерванный вызов возвращает «недоступна»,
// и без проверки обработчик записал бы ложную деградацию модели (S17-04).
const guardGateway = <T extends object>(inner: T | null, methods: readonly string[], check: () => void): T | null =>
  inner === null
    ? null
    : new Proxy(inner, {
        get: (target, prop, receiver) => {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          if (!methods.includes(String(prop))) return value.bind(target);
          return async (...args: unknown[]) => {
            const out: unknown = await value.apply(target, args);
            check();
            return out;
          };
        },
      });

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
  async recover(): Promise<string[]> {
    return recoverExpiredJobs(this.o.pool, [...this.active.keys()]);
  }

  private lastModelCheck = 0;
  private lastModelOk = false;

  // Проход обслуживания поиска: просроченные прогоны, модель, версии, задания индексации,
  // активация и удаление выведенных версий (state-machines §20–21, G05-02).
  async maintain(o: { checkModel?: boolean } = {}): Promise<IMaintenanceReport> {
    const report = await this.maintainSearch(o);
    await this.scheduleFactExtraction();
    await this.scheduleStageInvalidation();
    return report;
  }

  // Проба модели эмбеддингов — настоящий запрос: у LM Studio он загружает модель и продлевает её срок
  // в памяти. Поэтому, пока модель отвечает, — редко; пока нет — раз в минуту (такой запрос модель не
  // загружает); и никогда при занятом слоте GPU, чтобы не встать рядом с заданием портала (S17-07).
  async maintainSearch(o: { checkModel?: boolean } = {}): Promise<IMaintenanceReport> {
    const interval = this.lastModelOk ? this.o.config.search.modelCheckIntervalMs : this.o.config.search.modelRetryIntervalMs;
    const due = Date.now() - this.lastModelCheck >= interval;
    const checkModel = o.checkModel ?? (due && !(this.o.embeddings && (await gpuSlotBusy(this.o.pool))));
    if (checkModel) this.lastModelCheck = Date.now();
    const report = await runSearchMaintenance({ pool: this.o.pool, config: this.o.config, embeddings: this.o.embeddings ?? null, log: this.log }, { checkModel });
    if (checkModel) this.lastModelOk = report.model === 'ok';
    return report;
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
      ['сканы', () => (this.restoreCheck ? Promise.resolve(0) : this.scheduleScans())],
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

  // Инвалидация (этап 09, §5.4): каждое необработанное событие барьера получает задание `stage.invalidate` (dedupe —
  // одно на событие). Барьер от задания не зависит: устаревание прогона видно сразу по версии входов.
  async scheduleStageInvalidation(): Promise<number> {
    const events = await eventsAwaitingInvalidation(this.o.pool);
    for (const e of events) await enqueueInvalidation(this.o.pool, e.id, e.tender_id);
    return events.length;
  }

  // Извлечение фактов D-018 (D-028): предпочтительные завершённые прогоны распознавания документов тендера и договора
  // без извлечения текущей версии правил получают задание `fact.extract` (dedupe — одно на прогон).
  async scheduleFactExtraction(): Promise<number> {
    const runs = await runsAwaitingExtraction(this.o.pool);
    for (const r of runs) await enqueueFactExtraction(this.o.pool, r.id, r.tender_id);
    return runs.length;
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

  // Срок подачи из TenderHub наступил — выгрузка расчёта (ADR-007 §7): сигнал, а не закрытие. Ставится
  // один раз на срок; ревизия остаётся provisional. Без настроенного TenderHub не планируется.
  async scheduleCalculationCaptures(): Promise<number> {
    const th = this.o.config.tenderhub;
    if (!th.baseUrl || !th.apiKey) return 0;
    let scheduled = 0;
    for (const d of await dueDeadlineCaptures(this.o.pool)) {
      try {
        await withTransaction(this.o.pool, async (client) => {
          await requestCapture(client, {
            stageId: d.stage_id,
            tenderId: d.tender_id,
            source: { id: d.source_id, external_tender_id: d.external_tender_id },
            trigger: 'deadline',
            requestedBy: null,
            deadlineBasis: d.deadline,
            maxAttempts: th.captureAttempts,
          });
        });
        scheduled += 1;
      } catch (err) {
        // Параллельная выгрузка того же этапа уже идёт (уникальность) — следующий проход решит сам.
        this.log(`выгрузка по сроку для этапа ${d.stage_id} не поставлена: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
    return scheduled;
  }

  // Автоматическая постановка локального распознавания (OD-2): DOCX, XLSX, CSV и PDF с политикой local
  // без успешного локального прогона и без прогона текущей идентичности. PDF с политикой auto сюда
  // не попадает никогда — его распознаёт только явная команда (OD-1).
  async scheduleLocalRecognition(): Promise<number> {
    const settings = localSettings(this.o.config, this.localOcr);
    const formats: LocalInputFormat[] = ['pdf', 'docx', 'xlsx', 'csv'];
    const descriptors = new Map<LocalInputFormat, Awaited<ReturnType<typeof describeLocalRecognizer>>>();
    const fps: Partial<FingerprintByFormat> = {};
    for (const f of formats) {
      const d = await describeLocalRecognizer(f, settings);
      descriptors.set(f, d);
      fps[f] = await recognizerFingerprint(this.o.pool, d);
    }
    let created = 0;
    for (const c of await autoRecognitionCandidates(this.o.pool, fps as FingerprintByFormat, this.o.config.localRecognition.autoBatch)) {
      try {
        const out = await withTransaction(this.o.pool, (client) =>
          enqueueLocalRecognition(client, { revisionId: c.revision_id, descriptor: descriptors.get(c.input_format)!, createdBy: null }),
        );
        if (out.kind === 'created') created += 1;
      } catch (err) {
        // Гонка с приёмом RDWeb или командой пользователя: охранник БД отказал — следующий проход решит сам.
        this.log(`локальное распознавание редакции ${c.revision_id} не поставлено: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
    return created;
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
      chat: guardGateway(this.chat, ['complete'], throwIfStopped),
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

export const isStopped = (e: unknown): boolean => e instanceof LeaseLostError || e instanceof JobCancelledError || e instanceof WorkerStoppingError;
