// Сборка HTTP-приложения: API /api/v1 и раздача собранного интерфейса.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IAppConfig } from '@kontur/config';
import type { Pool } from '@kontur/db';
import { BlobStore } from '@kontur/storage';
import express, { type NextFunction, type Request, type Response } from 'express';
import { requestIdOf } from './http/context.ts';
import { HttpError, sendProblem } from './http/errors.ts';
import { csrfGuard, securityHeaders, sessionMiddleware } from './http/security.ts';
import { adminRouter } from './routes/admin.ts';
import { authRouter } from './routes/auth.ts';
import { documentsRouter } from './routes/documents.ts';
import { healthRouter } from './routes/health.ts';
import { importsRouter } from './routes/imports.ts';
import { intakeRouter } from './routes/intake.ts';
import { sourceSetsRouter } from './routes/sourceSets.ts';
import { stagesRouter } from './routes/stages.ts';
import { tendersRouter } from './routes/tenders.ts';

export interface IAppDeps {
  config: IAppConfig;
  pool: Pool;
  clock?: () => Date;
  store?: BlobStore;
  logError?: (message: string, meta: Record<string, unknown>) => void;
}

export const DEFAULT_WEB_DIST = resolve(import.meta.dirname, '..', '..', 'web', 'dist');

export const createApp = (deps: IAppDeps): express.Express => {
  const { config, pool } = deps;
  const clock = deps.clock ?? (() => new Date());
  const store = deps.store ?? new BlobStore(config.storageRoot);
  const logError = deps.logError ?? ((message, meta) => console.error(message, meta));
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(securityHeaders(config));

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use(healthRouter(config, pool));
  api.use(sessionMiddleware(config, pool, clock));
  api.use(csrfGuard(config, pool));
  api.use(authRouter(config, pool, clock));
  api.use(tendersRouter(pool));
  api.use(stagesRouter(pool));
  api.use(adminRouter(pool, clock));
  api.use(importsRouter(pool, store, config));
  api.use(documentsRouter(pool, store));
  api.use(intakeRouter(pool, config, clock));
  api.use(sourceSetsRouter(pool));
  api.use((_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'NOT_FOUND', 'Маршрут не найден')));
  app.use('/api/v1', api);
  app.use('/api', (_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'NOT_FOUND', 'Маршрут не найден')));

  const webDist = config.webDistDir ?? DEFAULT_WEB_DIST;
  if (existsSync(join(webDist, 'index.html'))) {
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, path) => {
          if (path.endsWith('sw.js') || path.endsWith('index.html') || path.endsWith('manifest.json')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = requestIdOf(req);
    if (err instanceof HttpError) return sendProblem(res, err, requestId);
    const e = err as { type?: string; status?: number };
    if (e.type === 'entity.parse.failed') return sendProblem(res, new HttpError(400, 'VALIDATION_FAILED', 'тело запроса — некорректный JSON'), requestId);
    if (e.type === 'entity.too.large') return sendProblem(res, new HttpError(400, 'VALIDATION_FAILED', 'тело запроса слишком большое'), requestId);
    // В журнал — только класс и сообщение ошибки, без тела запроса и заголовков (секреты, cookie).
    logError('unhandled error', { requestId, error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' });
    return sendProblem(res, new HttpError(500, 'INTERNAL', 'внутренняя ошибка; см. журнал по requestId'), requestId);
  });

  return app;
};
