// Поиск по области (portal-api §2.4, ADR-008, ADR-012 §14, state-machines §21). POST /search
// строит область на сервере и создаёт прогон; точная и полнотекстовая ветки — синхронно,
// смысловая — из кеша, заданием класса gpu или честным отказом. Итог читается GET /search-runs/{id}.
import type { IAppConfig } from '@kontur/config';
import { SearchRequest } from '@kontur/contracts';
import { searchScopeHash } from '@kontur/core';
import {
  degradeIfExpired,
  enqueueSemantic,
  getActiveVersion,
  getEvidenceScope,
  getScopedSearchRun,
  resolveSnapshotScope,
  resolveWorkingScope,
  setRunJob,
  startSearch,
  unitsNotPermitted,
  withTransaction,
  type IAccessContext,
  type Pool,
  type PoolClient,
} from '@kontur/db';
import type { Request } from 'express';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { searchRunView } from '../searchMappers.ts';
import { hasTenderCap } from './scope.ts';
import { loadStage } from './stages.ts';

interface ITenderSearch {
  tenderId: string;
  mode: 'working' | 'review';
  stageId: string | null;
  evidenceScopeId: string | null;
}

// Контекст запроса → проверенный контекст тендера. Чужой тендер и чужой снимок — 404:
// существование объекта вне области не раскрывается (ADR-006).
const tenderContext = async (db: PoolClient, ctx: IAccessContext, req: Request): Promise<ITenderSearch> => {
  const body = parseBody(SearchRequest, req.body);
  const c = body.context;
  if (c.kind === 'contract') throw new HttpError(400, 'VALIDATION_FAILED', 'поиск по договору появится с договорным контуром (этап 06a)');
  if (c.mode === 'release' || c.mode === 'comparison') {
    throw new HttpError(400, 'VALIDATION_FAILED', `режим ${c.mode} появится вместе с выпусками (этапы 13 и 15)`);
  }
  // Не участник — 404, как у любого ресурса тендера (portal-api §1, ADR-006): существование не раскрывается.
  if (!hasTenderCap(ctx, c.tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: c.tenderId });
  if (c.mode === 'working') {
    if (!c.stageId) throw new HttpError(400, 'VALIDATION_FAILED', 'режим working требует stageId');
    const stage = await loadStage(db, ctx, c.stageId);
    if (stage.tender_id !== c.tenderId) throw notFound({ entityType: 'tender_stage', entityId: c.stageId });
    return { tenderId: c.tenderId, mode: 'working', stageId: stage.id, evidenceScopeId: null };
  }
  if (!c.evidenceScopeId) throw new HttpError(400, 'VALIDATION_FAILED', 'режим review требует evidenceScopeId');
  const scope = await getEvidenceScope(db, ctx, c.evidenceScopeId);
  if (!scope || scope.tender_id !== c.tenderId) throw notFound({ entityType: 'evidence_scope', entityId: c.evidenceScopeId });
  return { tenderId: c.tenderId, mode: 'review', stageId: scope.stage_id, evidenceScopeId: scope.id };
};

export const searchRouter = (pool: Pool, config: IAppConfig, clock: () => Date): Router => {
  const router = Router();

  router.post(
    '/search',
    command(pool, {
      action: 'search.run',
      entityType: 'search_run',
      authorize: async (client, ctx, req) => {
        await tenderContext(client, ctx, req);
      },
      run: async (client, ctx, req) => {
        const body = parseBody(SearchRequest, req.body);
        const t = await tenderContext(client, ctx, req);
        // G05-03: без активной версии поиск не работает «по чему-то текущему» — явный отказ.
        // FOR SHARE закрепляет версию за прогоном: удаление её данных ждёт (state-machines §20).
        const version = await getActiveVersion(client, 'share');
        if (!version) {
          throw new HttpError(409, 'STATE_CONFLICT', 'индекс поиска ещё не построен', { current: { reason: 'search_index_not_ready' } }, { tenderId: t.tenderId });
        }
        const scope =
          t.mode === 'working'
            ? await resolveWorkingScope(client, t.stageId!)
            : await resolveSnapshotScope(client, (await getEvidenceScope(client, ctx, t.evidenceScopeId!))!);
        // Фильтр прав поверх области (ADR-008 §4): для прогонов распознавания это доступ к тендеру,
        // проверенный выше; письма и их ящики (этап 07) добавят сюда исключение единиц.
        const scopeHash = searchScopeHash(scope.snapshotHash, scope.unitIds);
        const started = await startSearch(client, {
          tenderId: t.tenderId,
          stageId: t.stageId,
          mode: t.mode,
          evidenceScopeId: t.evidenceScopeId,
          requestedBy: ctx.principal.userId,
          rawQuery: body.query,
          limit: body.limit,
          deadlineMs: config.search.semanticDeadlineMs,
          scope,
          scopeHash,
          version,
          now: clock(),
        });
        if (started.needsJob) {
          const job = await enqueueSemantic(client, started.runId, t.tenderId);
          await setRunJob(client, started.runId, job.id);
        }
        const view = await searchRunView(client, started.runId);
        return {
          status: 200,
          body: view,
          audit: [
            {
              action: 'search.run',
              entityType: 'search_run',
              entityId: started.runId,
              tenderId: t.tenderId,
              details: { mode: t.mode, scopeHash, status: view.status, semantic: view.semantic.status, units: view.scope.units, ...(view.failureCode ? { failureCode: view.failureCode } : {}) },
            },
          ],
        };
      },
    }),
  );

  router.get(
    '/search-runs/:id',
    query(pool, 'search.run.read', 'search_run', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'search_run');
      const run = await getScopedSearchRun(pool, ctx, id);
      if (!run) throw notFound({ entityType: 'search_run', entityId: id });
      // Попутная терминализация по сроку; основной путь — проход обслуживания worker (G05-02).
      if (run.status === 'pending' && run.deadline_at.getTime() < clock().getTime()) {
        await withTransaction(pool, (c) => degradeIfExpired(c, id));
      }
      // Права поверх закреплённой области проверяются при каждом чтении (ADR-008 §4).
      const lost = await unitsNotPermitted(pool, ctx, run.allowed_source_unit_ids);
      if (lost.length > 0) {
        throw new HttpError(409, 'STATE_CONFLICT', 'права на часть области поиска отозваны; выполните поиск заново', { current: { reason: 'scope_changed' } }, { tenderId: run.tender_id, entityId: id });
      }
      res.json(await searchRunView(pool, id));
    }),
  );

  return router;
};
