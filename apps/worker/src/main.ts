// Процесс worker (ADR-001 §6). На этапе 02 — только запуск, сверка схемы и heartbeat для /ready;
// очередь заданий и обработчики появляются на этапе 03 (ADR-004).
import { hostname } from 'node:os';
import { ConfigError, loadConfig } from '@kontur/config';
import { beat, checkSchema, createPool } from '@kontur/db';

const log = (message: string): void => console.log(`${new Date().toISOString()} [worker] ${message}`);

const main = async (): Promise<void> => {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 2);
  const schema = await checkSchema(pool);
  if (!schema.ok) {
    log(`схема БД не совпадает с кодом: ${schema.problem}. Выполните npm run db:migrate`);
    await pool.end();
    process.exit(3);
  }
  const startedAt = new Date();
  const processId = `worker:${hostname()}:${process.pid}:${startedAt.getTime()}`;
  const tick = async (): Promise<void> => {
    try {
      await beat(pool, { processId, kind: 'worker', pid: process.pid, startedAt });
    } catch (err) {
      log(`heartbeat не записан: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  };
  await tick();
  const timer = setInterval(() => void tick(), config.workerHeartbeatSeconds * 1000);
  log(`запущен (схема ${schema.dbVersion}), heartbeat каждые ${config.workerHeartbeatSeconds} с`);
  const stop = (signal: string): void => {
    log(`остановка по ${signal}`);
    clearInterval(timer);
    void pool.end().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
};

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    for (const p of err.problems) log(`конфигурация: ${p}`);
    process.exit(2);
  }
  log(`ошибка запуска: ${err instanceof Error ? err.message : 'unknown'}`);
  process.exit(1);
});
