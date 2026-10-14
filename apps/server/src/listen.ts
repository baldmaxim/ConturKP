// Прослушиватель server (этап 17, проект §3.4 и §10): один код у процесса и у теста TLS. Без TLS — HTTP только
// на loopback (проверяет loadConfig); с TLS — пара PEM-файлов, читается один раз при старте.
import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readTls, type IAppConfig } from '@kontur/config';

export const createListener = (config: Pick<IAppConfig, 'tls'>, app: RequestListener): Server =>
  config.tls ? createHttpsServer(readTls(config.tls), app) : createHttpServer(app);

// Штатная остановка: новые соединения не принимаются, простаивающие закрываются сразу (Node ≥ 19), текущие
// запросы доходят до конца; за closeAllAfterMs до срока остановки закрываются и они.
export const closeListener = (server: Server, closeAllAfterMs: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), Math.max(0, closeAllAfterMs));
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
