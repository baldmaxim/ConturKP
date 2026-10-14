// Типы, ошибки и константы заданий worker (ADR-004, state-machines §2); вынесены из runtime.ts (этап 17).
import type { IDeliveryFs, ILocalOcrEngineFactory, IModelGatewayChat, IModelGatewayEmbeddings } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import type { IJobRow, Pool, PoolClient } from '@kontur/db';
import type { BlobStore } from '@kontur/storage';

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

export const specOf = (handler: JobHandler): IJobHandlerSpec => (typeof handler === 'function' ? { run: handler } : handler);

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
// Этап 17: проба модели эмбеддингов (model.probe) — короткое GPU-задание, ей не ждать долгих заданий фоновой полосы.
export const INTERACTIVE_KINDS: readonly string[] = ['search.semantic', 'answer.generate', 'model.probe'];

// Циклы процесса worker (этап 17, проект §3.3): полосы заданий и два прохода обслуживания идут независимо,
// поэтому долгое задание фоновой полосы не останавливает recovery и планирование (S17-05).
export type WorkerLoop = 'background' | 'interactive' | 'queue' | 'search';

// Виды заданий с внешними действиями: на восстановленной копии (WORKER_MODE=restore_check) не выполняются и не
// планируются — пути назначений, папки и TenderHub в копии настоящие (проект §4.4, толкование §16 п. 3).
export const EXTERNAL_KINDS: readonly string[] = ['delivery.place', 'delivery.probe', 'calculation.capture', 'intake.scan'];

// Задание, остановленное нехваткой места, повторяется не раньше чем через 5 минут.
export const STORAGE_FULL_DELAY_MS = 300_000;

export const isStopped = (e: unknown): boolean => e instanceof LeaseLostError || e instanceof JobCancelledError || e instanceof WorkerStoppingError;
