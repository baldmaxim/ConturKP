// Процесс worker (ADR-001 §6, ADR-004): сверка схемы, heartbeat для /ready, циклы заданий и обслуживания.
// Остановка (этап 17, проект §3): новые задания не берутся, текущие прерываются и возвращаются в очередь
// владельцем без потери попытки; heartbeat пишется только при живости всех циклов.
import { hostname } from 'node:os';
import { ConfigError, installShutdown, loadConfig } from '@kontur/config';
import { beat, checkSchema, createPool, retireHeartbeat } from '@kontur/db';
import { BlobStore } from '@kontur/storage';
import { createEmbeddings } from './embeddings.ts';
import { HANDLERS } from './handlers/index.ts';
import { WorkerRuntime } from './runtime.ts';

const log = (message: string): void => console.log(`${new Date().toISOString()} [worker] ${message}`);

const main = async (): Promise<void> => {
  const config = loadConfig();
  // Четыре цикла и heartbeat работают одновременно: соединений больше, чем у одного цикла (проект §3.3).
  const pool = createPool(config.databaseUrl, 8, log);
  const schema = await checkSchema(pool);
  if (!schema.ok) {
    log(`схема БД не совпадает с кодом: ${schema.problem}. Выполните npm run db:migrate`);
    await pool.end();
    process.exitCode = 3;
    return;
  }
  const store = new BlobStore(config.storageRoot);
  await store.init();
  const startedAt = new Date();
  const processId = `worker:${hostname()}:${process.pid}:${startedAt.getTime()}`;
  const embeddings = createEmbeddings(config.embedding);
  const runtime = new WorkerRuntime({ pool, store, config, handlers: HANDLERS, workerId: processId, log, embeddings });
  let lastStale = '';
  const tick = async (): Promise<void> => {
    if (runtime.isStopping) return;
    const live = runtime.liveness(config.workerStaleSeconds * 1000);
    if (!live.ok) {
      const stale = live.stale.join(', ');
      if (stale !== lastStale) log(`heartbeat не пишется: циклы без хода — ${stale}`);
      lastStale = stale;
      return;
    }
    lastStale = '';
    try {
      await beat(pool, { processId, kind: 'worker', pid: process.pid, startedAt });
    } catch (err) {
      log(`heartbeat не записан: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  };
  await tick();
  const timer = setInterval(() => void tick(), config.workerHeartbeatSeconds * 1000);
  const controller = new AbortController();
  const loop = runtime.loop(controller.signal);
  log(
    `запущен (схема ${schema.dbVersion}), обработчики: ${Object.keys(HANDLERS).join(', ')}; модель эмбеддингов: ${embeddings ? `${embeddings.kind} ${embeddings.model}` : 'не настроена'}; генеративная модель: ${config.chatModel.provider}`,
  );
  const graceMs = config.shutdownGraceSeconds * 1000;
  installShutdown({
    name: 'worker',
    graceMs,
    log,
    stop: async (_reason, fatal) => {
      clearInterval(timer);
      controller.abort();
      // Срок на возврат заданий — с запасом до принудительного выхода.
      const r = await runtime.shutdown({ deadlineMs: Math.max(1000, graceMs - 3000), refundAttempt: !fatal });
      if (r.released + r.abandoned > 0) log(`задания при остановке: возвращено ${r.released}, не завершилось ${r.abandoned}`);
      await retireHeartbeat(pool, processId).catch(() => undefined);
      // Незавершённое задание остаётся running до истечения аренды; его вернёт recovery (проект §3.2).
      if (r.abandoned > 0) return false;
      await loop;
      await pool.end();
      return true;
    },
  });
};

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    for (const p of err.problems) log(`конфигурация: ${p}`);
    process.exitCode = 2;
    return;
  }
  log(`ошибка запуска: ${err instanceof Error ? err.message : 'unknown'}`);
  process.exitCode = 1;
});
