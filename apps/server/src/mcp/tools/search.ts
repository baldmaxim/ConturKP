// Поиск оснований и цитата (проект §5.1): тот же прогон поиска, что у `POST /search`, и то же чтение фрагмента, что у
// экрана. Предварительный лексический результат за итог не выдаётся: итог — только из `get_search_run`.
import { getScopedFragment, withTransaction } from '@kontur/db';
import { z } from 'zod';
import { toEvidence } from '../../recognitionMappers.ts';
import { readScopedSearchRun, resolveSearchContext, startScopedSearch } from '../../routes/search.ts';
import { searchRunView } from '../../searchMappers.ts';
import { cutText } from '../limits.ts';
import { resolveCase } from '../scope.ts';
import { McpToolError, outOfScope, type IMcpSession } from '../session.ts';
import { DATA_NOTICE, defineTool } from '../tools.ts';

const uuid = z.string().uuid();

type RunView = Awaited<ReturnType<typeof searchRunView>>;

const hits = (items: readonly Record<string, unknown>[] | undefined) =>
  (items ?? []).map((h) => {
    const cut = cutText(typeof h.text === 'string' ? h.text : null);
    return { ...h, text: cut.text, textTruncated: cut.truncated || h.textTruncated === true };
  });

// Итог — только у завершённого прогона. Пока прогон идёт, лексические ранги помечены как предварительные.
const runResult = (view: RunView) => {
  const v = view as unknown as Record<string, unknown> & { lexical: { items: Record<string, unknown>[] } | null; fused: { items: Record<string, unknown>[] } | null };
  const terminal = v.status !== 'pending';
  return {
    searchRunId: v.searchRunId,
    status: v.status,
    scopeHash: v.scopeHash,
    scope: v.scope,
    incomplete: v.incomplete,
    semantic: v.semantic,
    final: terminal,
    fragments: terminal ? hits(v.fused?.items) : null,
    preliminary: terminal ? null : { note: 'предварительный лексический результат: итог читается инструментом get_search_run', fragments: hits(v.lexical?.items) },
    emptyMessage: v.emptyMessage ?? null,
    failureCode: v.failureCode ?? null,
  };
};

const contextOf = async (s: IMcpSession, a: { tenderId?: string | undefined; stageId?: string | undefined; releaseId?: string | undefined; contractId?: string | undefined }) => {
  if (a.contractId) {
    if (a.tenderId || a.stageId || a.releaseId) throw new McpToolError('invalid_request', 'контекст договора задаётся только contractId');
    return { context: { kind: 'contract' as const, contractId: a.contractId.toLowerCase() }, tenderId: null };
  }
  const c = await resolveCase(s.pool, s, a);
  return {
    tenderId: c.tenderId,
    context: c.releaseId
      ? { kind: 'tender' as const, tenderId: c.tenderId, mode: 'review' as const, evidenceScopeId: c.evidenceScopeId! }
      : { kind: 'tender' as const, tenderId: c.tenderId, mode: 'working' as const, stageId: c.stageId },
  };
};

export const searchEvidenceTool = defineTool({
  name: 'search_evidence',
  title: 'Поиск оснований',
  description: `Создаёт прогон поиска по источникам области: этап (текущий состав) или выпуск (снимок источников на момент выпуска — поздние документы в него не входят), либо договор (contractId). Возвращает searchRunId; итоговые фрагменты читаются инструментом get_search_run. ${DATA_NOTICE}`,
  scope: 'read',
  input: z
    .object({ tenderId: uuid.optional(), stageId: uuid.optional(), releaseId: uuid.optional(), contractId: uuid.optional(), query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() })
    .strict(),
  run: async (s, a) => {
    const { context, tenderId } = await contextOf(s, a);
    return withTransaction(s.pool, async (client) => {
      const t = await resolveSearchContext(client, s.ctx, context);
      const { runId, scopeHash, excluded } = await startScopedSearch(client, s.ctx, t, a.query, a.limit ?? 10, s.config, s.clock, true);
      const view = await searchRunView(client, runId);
      return {
        result: runResult(view),
        tenderId,
        entityType: 'search_run',
        entityId: runId,
        details: { mode: t.mode, scopeHash, status: view.status, excludedByAcl: excluded, ...(a.releaseId ? { releaseId: a.releaseId.toLowerCase() } : {}), ...(a.contractId ? { contractId: a.contractId.toLowerCase() } : {}) },
      };
    });
  },
});

export const getSearchRunTool = defineTool({
  name: 'get_search_run',
  title: 'Итог прогона поиска',
  description: `Статус и итоговые фрагменты прогона поиска, созданного search_evidence. Читает только пользователь, от имени которого создан прогон; права на область пересчитываются при каждом вызове. ${DATA_NOTICE}`,
  scope: 'read',
  input: z.object({ searchRunId: uuid }).strict(),
  run: async (s, a) => {
    const { run, view } = await readScopedSearchRun(s.pool, s.ctx, a.searchRunId.toLowerCase(), s.clock);
    return { result: runResult(view), tenderId: run.tender_id, entityType: 'search_run', entityId: run.id, details: { scopeHash: run.scope_hash, status: view.status } };
  },
});

export const getCitationTool = defineTool({
  name: 'get_citation',
  title: 'Цитата',
  description: `Точный текст фрагмента по его ID: документ, редакция, страница, происхождение. ID фрагмента стабилен и возвращается поиском, замечаниями и требованиями. ${DATA_NOTICE}`,
  scope: 'read',
  input: z.object({ fragmentId: uuid }).strict(),
  run: async (s, a) => {
    const f = await getScopedFragment(s.pool, s.ctx, a.fragmentId.toLowerCase());
    if (!f) throw outOfScope();
    const e = toEvidence(f) as Record<string, unknown>;
    // Адрес скачивания файла чат-клиенту не отдаётся: файлы через MCP не скачиваются (проект §5.4).
    const { contentUrl: _contentUrl, ...rest } = e;
    const cut = cutText(typeof rest.text === 'string' ? rest.text : null, 8000);
    return { result: { citation: { ...rest, text: cut.text, textTruncated: cut.truncated } }, tenderId: f.tender_id ?? null, entityType: 'evidence_fragment', entityId: f.id };
  },
});
