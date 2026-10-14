// Процесс server: API, раздача интерфейса, health/readiness (ADR-001 §6, ADR-011 §4).
// Остановка и коды выхода — общий модуль жизненного цикла (этап 17, проект §3.4).
import { ConfigError, EXIT_FATAL, installShutdown, loadConfig } from '@kontur/config';
import { checkSchema, createPool } from '@kontur/db';
import { createApp } from './app.ts';
import { closeListener, createListener } from './listen.ts';

const log = (message: string): void => console.log(`${new Date().toISOString()} [server] ${message}`);

const main = async (): Promise<void> => {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 10, log);
  const schema = await checkSchema(pool);
  if (!schema.ok) {
    log(`схема БД не совпадает с кодом: ${schema.problem}. Выполните npm run db:migrate`);
    await pool.end();
    process.exitCode = 3;
    return;
  }
  const app = createApp({ config, pool });
  const server = createListener(config, app);
  server.on('error', (err) => {
    log(`прослушивание невозможно: ${err.message}`);
    process.exitCode = EXIT_FATAL;
    void pool.end();
  });
  server.listen(config.httpPort, config.httpHost, () => {
    log(`слушает ${config.tls ? 'https' : 'http'}://${config.httpHost}:${config.httpPort} (режим ${config.env}, схема ${schema.dbVersion})`);
  });
  const graceMs = config.shutdownGraceSeconds * 1000;
  installShutdown({
    name: 'server',
    graceMs,
    log,
    stop: async () => {
      await closeListener(server, graceMs - 2000);
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
