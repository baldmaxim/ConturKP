// Сборка HTTP-приложения: API /api/v1 и раздача собранного интерфейса.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ILocalOcrEngineFactory } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import type { Pool } from '@kontur/db';
import { BlobStore, localOcrFactory } from '@kontur/storage';
import express, { type NextFunction, type Request, type Response } from 'express';
import { requestIdOf } from './http/context.ts';
import { HttpError, sendProblem } from './http/errors.ts';
import { csrfGuard, securityHeaders, sessionMiddleware } from './http/security.ts';
import { adminRouter } from './routes/admin.ts';
import { authRouter } from './routes/auth.ts';
import { documentsRouter } from './routes/documents.ts';
import { evidenceScopesRouter } from './routes/evidenceScopes.ts';
import { healthRouter } from './routes/health.ts';
import { importsRouter } from './routes/imports.ts';
import { intakeRouter } from './routes/intake.ts';
import { localRecognitionRouter } from './routes/localRecognition.ts';
import { mailboxesRouter } from './routes/mailboxes.ts';
import { mailMessagesRouter } from './routes/mailMessages.ts';
import { recognitionRouter } from './routes/recognition.ts';
import { searchRouter } from './routes/search.ts';
import { dialogsRouter } from './routes/dialogs.ts';
import { factsRouter } from './routes/facts.ts';
import { calculationsRouter } from './routes/calculations.ts';
import { economicsRouter } from './routes/economics.ts';
import { formDraftsRouter } from './routes/formDrafts.ts';
import { formSuggestionsRouter } from './routes/formSuggestions.ts';
import { formTemplatesRouter } from './routes/formTemplates.ts';
import { releaseCandidatesRouter } from './routes/releaseCandidates.ts';
import { approvalsRouter } from './routes/approvals.ts';
import { deliveriesRouter } from './routes/deliveries.ts';
import { mcpRouter } from './mcp/http.ts';
import { apiTokensRouter } from './routes/apiTokens.ts';
import { releaseComparisonsRouter } from './routes/releaseComparisons.ts';
import { sendsRouter } from './routes/sends.ts';
import { communicationsRouter } from './routes/communications.ts';
import { requirementCandidatesRouter } from './routes/requirementCandidates.ts';
import { requirementItemsRouter } from './routes/requirementItems.ts';
import { requirementRegistriesRouter } from './routes/requirementRegistries.ts';
import { discrepanciesRouter } from './routes/discrepancies.ts';
import { reviewsRouter } from './routes/reviews.ts';
import { stageRecordsRouter } from './routes/stageRecords.ts';
import { contractDocumentsRouter } from './routes/contractDocuments.ts';
import { contractLinksRouter } from './routes/contractLinks.ts';
import { contractsRouter } from './routes/contracts.ts';
import { sourceSetsRouter } from './routes/sourceSets.ts';
import { stagesRouter } from './routes/stages.ts';
import { tendersRouter } from './routes/tenders.ts';

export interface IAppDeps {
  config: IAppConfig;
  pool: Pool;
  clock?: () => Date;
  store?: BlobStore;
  logError?: (message: string, meta: Record<string, unknown>) => void;
  // Фабрика OCR для тестов; по умолчанию — по конфигурации (LOCAL_OCR_ENGINE).
  localOcr?: ILocalOcrEngineFactory | null;
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
  api.use(recognitionRouter(pool, store, config));
  api.use(localRecognitionRouter(pool, config, deps.localOcr !== undefined ? deps.localOcr : localOcrFactory(config.localRecognition.ocrEngine)));
  api.use(sourceSetsRouter(pool));
  api.use(evidenceScopesRouter(pool));
  api.use(contractsRouter(pool));
  api.use(contractLinksRouter(pool));
  api.use(contractDocumentsRouter(pool, store, config));
  api.use(searchRouter(pool, config, clock));
  api.use(dialogsRouter(pool, config, clock));
  api.use(factsRouter(pool));
  api.use(reviewsRouter(pool, config));
  api.use(discrepanciesRouter(pool));
  api.use(calculationsRouter(pool, config));
  api.use(economicsRouter(pool, config));
  api.use(formTemplatesRouter(pool, store, config));
  api.use(formDraftsRouter(pool));
  api.use(formSuggestionsRouter(pool, config));
  api.use(releaseCandidatesRouter(pool, store));
  api.use(approvalsRouter(pool, store));
  api.use(deliveriesRouter(pool, store));
  api.use(sendsRouter(pool, store, config));
  api.use(releaseComparisonsRouter(pool, store));
  api.use(apiTokensRouter(pool));
  api.use(mailboxesRouter(pool, store, config));
  api.use(mailMessagesRouter(pool, store));
  api.use(communicationsRouter(pool, store, config));
  api.use(requirementRegistriesRouter(pool, config));
  api.use(requirementCandidatesRouter(pool));
  api.use(requirementItemsRouter(pool));
  api.use(stageRecordsRouter(pool));
  api.use((_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'NOT_FOUND', 'Маршрут не найден')));
  app.use('/api/v1', api);
  // MCP портала (этап 16): отдельная точка вне /api/v1 — только токен, без cookie и без проверки CSRF.
  app.use('/mcp', mcpRouter({ pool, config, clock, logError }));
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
