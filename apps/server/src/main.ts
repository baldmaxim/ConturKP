// Процесс server: API, раздача интерфейса, health/readiness (ADR-001 §6, ADR-011 §4).
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { ConfigError, loadConfig, readTls } from '@kontur/config';
import { checkSchema, createPool } from '@kontur/db';
import { createApp } from './app.ts';

const log = (message: string): void => console.log(`${new Date().toISOString()} [server] ${message}`);

const main = async (): Promise<void> => {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const schema = await checkSchema(pool);
  if (!schema.ok) {
    log(`схема БД не совпадает с кодом: ${schema.problem}. Выполните npm run db:migrate`);
    await pool.end();
    process.exit(3);
  }
  const app = createApp({ config, pool });
  const server = config.tls ? createHttpsServer(readTls(config.tls), app) : createHttpServer(app);
  server.listen(config.httpPort, config.httpHost, () => {
    log(`слушает ${config.tls ? 'https' : 'http'}://${config.httpHost}:${config.httpPort} (режим ${config.env}, схема ${schema.dbVersion})`);
  });
  const stop = (signal: string): void => {
    log(`остановка по ${signal}`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
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
