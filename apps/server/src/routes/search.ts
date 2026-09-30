// Поиск по области (portal-api §2.4, ADR-008, ADR-012 §14, state-machines §21). POST /search
// строит область на сервере и создаёт прогон; точная и полнотекстовая ветки — синхронно,
// смысловая — из кеша, заданием класса gpu или честным отказом. Итог читается GET /search-runs/{id}.
import type { IAppConfig } from '@kontur/config';
import { SearchRequest } from '@kontur/contracts';
import { searchScopeHash } from '@kontur/core';
import {
  activeLinkedContractIds,
  contractCaps,
  degradeIfExpired,
  enqueueSemantic,
  getActiveVersion,
  getContract,
  getEvidenceScope,
  getScopedSearchRun,
  readableContractIds,
  resolveContractScope,
  resolveSnapshotScope,
  resolveWorkingScope,
  setRunJob,
  startSearch,
  unitsNotPermitted,
  withTransaction,
  type IAccessContext,
  type IResolvedScope,
  type Pool,
  type PoolClient,
  type SearchOwner,
} from '@kontur/db';
import type { Request } from 'express';
import { Router } from 'express';
import { command, parseBody, query, uuidParam } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { searchRunView } from '../searchMappers.ts';
import { hasTenderCap } from './scope.ts';
import { loadStage } from './stages.ts';

interface ISearchContext {
  owner: SearchOwner;
  mode: 'working' | 'review';
  stageId: string | null;
  evidenceScopeId: string | null;
}

// Контекст запроса → проверенный контекст. Чужой тендер, чужой снимок и невидимый договор — 404:
// существование объекта вне области не раскрывается (ADR-006). Видимый договор без contract.read — 403.
const searchContext = async (db: PoolClient, ctx: IAccessContext, req: Request): Promise<ISearchContext> => {
  const body = parseBody(SearchRequest, req.body);
  const c = body.context;
  if (c.kind === 'contract') {
    const contract = await getContract(db, ctx, c.contractId);
    if (!contract) throw notFound({ entityType: 'contract', entityId: c.contractId });
    if (!contractCaps(ctx, contract.id).includes('contract.read')) {
      throw forbidden('contract.read', { entityType: 'contract', entityId: contract.id, details: { contractId: contract.id } });
    }
    return { owner: { kind: 'contract', contractId: contract.id }, mode: 'working', stageId: null, evidenceScopeId: null };
  }
  if (c.mode === 'release' || c.mode === 'comparison') {
    throw new HttpError(400, 'VALIDATION_FAILED', `режим ${c.mode} появится вместе с выпусками (этапы 13 и 15)`);
  }
  // Не участник — 404, как у любого ресурса тендера (portal-api §1, ADR-006): существование не раскрывается.
  if (!hasTenderCap(ctx, c.tenderId, 'tender.read')) throw notFound({ entityType: 'tender', entityId: c.tenderId });
  if (c.mode === 'working') {
    if (!c.stageId) throw new HttpError(400, 'VALIDATION_FAILED', 'режим working требует stageId');
    const stage = await loadStage(db, ctx, c.stageId);
    if (stage.tender_id !== c.tenderId) throw notFound({ entityType: 'tender_stage', entityId: c.stageId });
    return { owner: { kind: 'tender', tenderId: c.tenderId }, mode: 'working', stageId: stage.id, evidenceScopeId: null };
  }
  if (!c.evidenceScopeId) throw new HttpError(400, 'VALIDATION_FAILED', 'режим review требует evidenceScopeId');
  const scope = await getEvidenceScope(db, ctx, c.evidenceScopeId);
  if (!scope || scope.tender_id !== c.tenderId) throw notFound({ entityType: 'evidence_scope', entityId: c.evidenceScopeId });
  return { owner: { kind: 'tender', tenderId: c.tenderId }, mode: 'review', stageId: scope.stage_id, evidenceScopeId: scope.id };
};

// Фильтр прав поверх области до ранжирования (ADR-008 §4–5, D-022 OD-3): единица договора в тендерном
// контексте ищется, только если она в области (составе этапа или снимке) И у пользователя есть
// contract.read. В рабочем составе договор ещё и должен быть связан с тендером действующей связью;
// исторический снимок остаётся воспроизводимым и после архива связи. Почтовая единица (ревизия письма,
// прогон документа вложения) — только при mail.read на ящик письма и действующей связи письма с тендером
// контекста в любом режиме (AD-07-1a, условия 2–4). Исключённые — только числом.
const permittedScope = async (db: PoolClient, ctx: IAccessContext, t: ISearchContext, scope: IResolvedScope): Promise<{ scope: IResolvedScope; excluded: number }> => {
  if (t.owner.kind === 'contract' || (scope.contractOf.size === 0 && scope.mailOf.size === 0)) return { scope, excluded: 0 };
  const readable = new Set(readableContractIds(ctx));
  const linked = t.mode === 'working' ? new Set(await activeLinkedContractIds(db, t.owner.tenderId)) : null;
  const mailLost = new Set(scope.mailOf.size === 0 ? [] : await unitsNotPermitted(db, ctx, [...scope.mailOf.keys()], t.owner.tenderId, t.mode));
  const unitIds = scope.unitIds.filter((u) => {
    if (mailLost.has(u)) return false;
    const contractId = scope.contractOf.get(u);
    return contractId === undefined || (readable.has(contractId) && (linked === null || linked.has(contractId)));
  });
  return { scope: { ...scope, unitIds }, excluded: scope.unitIds.length - unitIds.length };
};

export const searchRouter = (pool: Pool, config: IAppConfig, clock: () => Date): Router => {
  const router = Router();

  router.post(
    '/search',
    command(pool, {
      action: 'search.run',
      entityType: 'search_run',
      authorize: async (client, ctx, req) => {
        await searchContext(client, ctx, req);
      },
      run: async (client, ctx, req) => {
        const body = parseBody(SearchRequest, req.body);
        const t = await searchContext(client, ctx, req);
        const tenderId = t.owner.kind === 'tender' ? t.owner.tenderId : null;
        // G05-03: без активной версии поиск не работает «по чему-то текущему» — явный отказ.
        // FOR SHARE закрепляет версию за прогоном: удаление её данных ждёт (state-machines §20).
        const version = await getActiveVersion(client, 'share');
        if (!version) {
          throw new HttpError(409, 'STATE_CONFLICT', 'индекс поиска ещё не построен', { current: { reason: 'search_index_not_ready' } }, { tenderId });
        }
        const resolved =
          t.owner.kind === 'contract'
            ? await resolveContractScope(client, t.owner.contractId)
            : t.mode === 'working'
              ? await resolveWorkingScope(client, t.stageId!)
              : await resolveSnapshotScope(client, (await getEvidenceScope(client, ctx, t.evidenceScopeId!))!);
        // Фильтр прав поверх области (ADR-008 §4): прогоны тендера и транскрипции — доступ к тендеру,
        // проверенный выше; прогоны договора — contract.read; письма и вложения — mail.read и связь (D-025).
        const { scope, excluded } = await permittedScope(client, ctx, t, resolved);
        const scopeHash = searchScopeHash(scope.snapshotHash, scope.unitIds);
        const started = await startSearch(client, {
          owner: t.owner,
          excludedByAcl: excluded,
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
          const job = await enqueueSemantic(client, started.runId, tenderId);
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
              tenderId,
              details: {
                mode: t.mode,
                ...(t.owner.kind === 'contract' ? { contractId: t.owner.contractId } : {}),
                scopeHash,
                status: view.status,
                semantic: view.semantic.status,
                units: view.scope.units,
                excludedByAcl: excluded,
                ...(view.failureCode ? { failureCode: view.failureCode } : {}),
              },
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
      // Права поверх закреплённой области проверяются при каждом чтении (ADR-008 §4, D-022 OD-3, AD-07-1a):
      // единица договора без contract.read, письмо или вложение без mail.read или без связи с тендером — отказ,
      // результат не проецируется; переиндексация для этого не нужна.
      const lost = await unitsNotPermitted(pool, ctx, run.allowed_source_unit_ids, run.tender_id, run.mode);
      if (lost.length > 0) {
        throw new HttpError(409, 'STATE_CONFLICT', 'права на часть области поиска отозваны; выполните поиск заново', { current: { reason: 'scope_changed' } }, { tenderId: run.tender_id, entityId: id });
      }
      res.json(await searchRunView(pool, id));
    }),
  );

  return router;
};
