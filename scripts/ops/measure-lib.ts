// Оценка замеров этапа 17 (scripts/ops/measure.ts) — без сети и БД, для тестов.
// R17-06: подпись «живая модель» — только по фактически выбранным провайдерам конфигурации, а не по флагу командной
// строки; встроенные fake и none живым результатом не бывают. R17-07: успех поиска — по итогу каждого запроса и всех
// обязательных веток; отказ, деградация и истёкшее ожидание — неполный запрос, его время в p50/p95 полных не входит.
import { ConfigError, loadConfig } from '../../packages/config/src/index.ts';

export const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

export interface IModelSetup {
  live: boolean;
  // Непусто — настройка не годится: замер не выполняется (код 3).
  refusal: string[];
  // Строка журнала: идентичность моделей без ключей и без адресов целиком.
  identity: string;
  // Какой моделью должна быть построена активная версия индекса.
  embeddingModel: string | null;
  embeddingDim: number | null;
}

const host = (url: string | null): string => {
  if (!url) return '—';
  try {
    return new URL(url).host;
  } catch {
    return '—';
  }
};

export const modelSetup = (env: Record<string, string | undefined>, realModel: boolean): IModelSetup => {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    const problems = err instanceof ConfigError ? err.problems : [err instanceof Error ? err.message : 'конфигурация не прочитана'];
    return { live: realModel, refusal: problems.map((p) => `конфигурация: ${p}`), identity: 'не определена', embeddingModel: null, embeddingDim: null };
  }
  const m = config.chatModel;
  const e = config.embedding;
  if (!realModel) {
    const model = e.provider === 'fake' ? `fake-hash-${e.dim ?? 16}` : e.model;
    return {
      live: false,
      refusal: [],
      identity: `поддельная (генеративная ${m.provider}, эмбеддинги ${model ?? e.provider}) — синтетический замер: не живая проверка и не основание SLO`,
      embeddingModel: model,
      embeddingDim: e.dim,
    };
  }
  const refusal: string[] = [];
  if (m.provider !== 'openai_compatible') refusal.push(`MODEL_PROVIDER=${m.provider}: живой замер требует openai_compatible, встроенные fake и none — не живая модель`);
  if (e.provider !== 'openai_compatible') refusal.push(`EMBEDDING_PROVIDER=${e.provider}: живой замер требует openai_compatible, встроенные fake и none — не живая модель`);
  if (refusal.length > 0) return { live: true, refusal, identity: 'заявлена живая (--real-model), настройка не живая', embeddingModel: null, embeddingDim: null };
  return {
    live: true,
    refusal: [],
    identity:
      `живая: генеративная «${m.model}» (ревизия ${m.revision}, сервер ${host(m.baseUrl)}); ` +
      `эмбеддинги «${e.model}» (ревизия ${e.revision}, размерность ${e.dim ?? 'по пробе'}, шаблон ${e.template}, пачка ${e.batchSize}, сервер ${host(e.baseUrl)})`,
    embeddingModel: e.model,
    embeddingDim: e.dim,
  };
};

// Активная версия индекса построена той моделью, что заявлена в журнале.
export const indexModelProblem = (setup: IModelSetup, active: { model: string | null; dim: number | null } | null): string | null => {
  if (!active) return 'активной версии индекса нет';
  if (!active.model) return 'активная версия индекса без векторов';
  if (setup.embeddingModel !== null && active.model !== setup.embeddingModel) return `активная версия индекса построена моделью «${active.model}», заявлена «${setup.embeddingModel}»`;
  if (setup.embeddingDim !== null && active.dim !== setup.embeddingDim) return `размерность активной версии ${active.dim}, заявлена ${setup.embeddingDim}`;
  return null;
};

// Что нужно от представления прогона поиска (apps/server/src/searchMappers.ts searchRunView).
export interface ISearchRunView {
  status: string;
  semantic?: { status: string; reason: string | null } | null;
  scope?: { chunksWithoutVectors?: number; unitsNotIndexed?: number } | null;
  failureCode?: string | null;
  timings?: Record<string, number> | null;
  fused?: { items: unknown[] } | null;
}

// Обязательные ветки: точная, полнотекстовая, смысловая (векторная).
export const BRANCHES = [
  ['exactMs', 'точная'],
  ['ftsMs', 'полнотекстовая'],
  ['vectorMs', 'векторная'],
] as const;

// null — запрос полный; иначе причина неполноты.
export const searchIncompleteReason = (view: ISearchRunView | null): string | null => {
  if (!view || view.status === 'pending') return 'ожидание итога истекло';
  const sem = view.semantic ? `смысловая ветка ${view.semantic.status}${view.semantic.reason ? ` (${view.semantic.reason})` : ''}` : 'смысловая ветка не сообщена';
  if (view.status !== 'complete') return `итог ${view.status}${view.failureCode ? ` (${view.failureCode})` : ''}, ${sem}`;
  if (view.semantic?.status !== 'complete') return sem;
  const missing = BRANCHES.filter(([k]) => typeof view.timings?.[k] !== 'number').map(([, name]) => name);
  if (missing.length > 0) return `нет времени ветки: ${missing.join(', ')}`;
  const noVectors = view.scope?.chunksWithoutVectors ?? 0;
  if (noVectors > 0) return `чанков без векторов: ${noVectors}`;
  const notIndexed = view.scope?.unitsNotIndexed ?? 0;
  if (notIndexed > 0) return `единиц вне индекса: ${notIndexed}`;
  return null;
};

export interface ISearchOutcome {
  query: string;
  ms: number;
  reason: string | null;
  hits: number;
  timings: Record<string, number> | null;
}

export const searchOutcome = (query: string, ms: number, view: ISearchRunView | null): ISearchOutcome => ({
  query,
  ms,
  reason: searchIncompleteReason(view),
  hits: view?.fused?.items.length ?? 0,
  timings: view?.timings ?? null,
});

export interface ISearchSummary {
  passed: boolean;
  // Пояснение к FAIL шага; пусто при успехе.
  note: string;
  // Суммарное время полных запросов — значение шага журнала.
  totalMs: number;
  lines: string[];
}

const counted = (xs: string[]): string =>
  [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].map(([r, c]) => `«${r}» × ${c}`).join('; ');

export const summarizeSearch = (outcomes: ISearchOutcome[], expected: number): ISearchSummary => {
  const complete = outcomes.filter((o) => o.reason === null);
  const incomplete = outcomes.filter((o) => o.reason !== null);
  const times = complete.map((o) => o.ms);
  const firstHits = outcomes[0]?.hits ?? 0;
  const lines: string[] = [];
  lines.push(
    complete.length > 0
      ? `поиск, полные запросы: ${complete.length} из ${outcomes.length}; до итога p50 ${pct(times, 50)} мс, p95 ${pct(times, 95)} мс, максимум ${Math.max(...times)} мс (найдено в первом — ${firstHits})`
      : `поиск, полных запросов нет: 0 из ${outcomes.length}`,
  );
  if (incomplete.length > 0) {
    const t = incomplete.map((o) => o.ms);
    lines.push(
      `поиск, неполные запросы: ${incomplete.length} из ${outcomes.length} — ${counted(incomplete.map((o) => o.reason!))}; ` +
        `до итога p50 ${pct(t, 50)} мс, максимум ${Math.max(...t)} мс — в p50/p95 полных не входит`,
    );
  }
  if (complete.length > 0) {
    const branch = (k: string): string => {
      const xs = complete.map((o) => o.timings?.[k]).filter((x): x is number => typeof x === 'number');
      return xs.length ? `${pct(xs, 50)} мс` : '—';
    };
    lines.push(`ветки поиска (полные запросы), p50: ${BRANCHES.map(([k, name]) => `${name} ${branch(k)}`).join(', ')}`);
  }
  const perQuery = new Map<string, ISearchOutcome[]>();
  for (const o of outcomes) perQuery.set(o.query, [...(perQuery.get(o.query) ?? []), o]);
  lines.push(
    `по запросам, p50 до итога (полные): ${[...perQuery]
      .map(([q, xs]) => {
        const ok = xs.filter((x) => x.reason === null).map((x) => x.ms);
        const bad = xs.length - ok.length;
        return `«${q}» ${ok.length ? `${pct(ok, 50)} мс` : '—'}${bad ? ` (неполных ${bad} из ${xs.length})` : ''}`;
      })
      .join('; ')}`,
  );
  const note =
    incomplete.length > 0
      ? `неполных запросов ${incomplete.length} из ${outcomes.length}: ${counted(incomplete.map((o) => o.reason!))}`
      : outcomes.length !== expected
        ? `выполнено запросов ${outcomes.length} из ${expected}`
        : firstHits > 0
          ? ''
          : 'первый запрос ничего не нашёл';
  return { passed: note === '', note, totalMs: times.reduce((a, b) => a + b, 0), lines };
};
