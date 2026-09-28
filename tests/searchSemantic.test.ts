// Смысловая ветка, версия индекса и очередь (этап 05; ADR-012 §5–§17, §25, ADR-004 §7a,
// state-machines §20–21) на детерминированном поддельном провайдере эмбеддингов. Проверяются
// условия реализации ревью 05-pre-2: G05-01 (build → embed), G05-02 (прогон всегда проходит через
// pending, срок терминализуется без клиента), G05-04 (проекция чанка в цитату).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeEmbeddings } from '../packages/adapters/src/index.ts';
import { CHUNKER_VERSION, embeddingInputVersion, modelFingerprint, PROBE_TEXT } from '../packages/core/src/index.ts';
import {
  activateVersion,
  cacheLookup,
  claimJob,
  completeSemantic,
  createVersion,
  enqueueIndexEmbed,
  enqueueJob,
  enqueueSemantic,
  getActiveVersion,
  getModelStatus,
  getVersion,
  purgeVersion,
  queryLexemes,
  vectorBranch,
  versionCompleteness,
  VECTOR_TOP_SQL,
  withTransaction,
} from '../packages/db/src/index.ts';
import { HANDLERS } from '../apps/worker/src/handlers/index.ts';
import { INTERACTIVE_KINDS, WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { buildScenario, createTestDb, drain, makeApp, makeWorker, TestClient, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildIndex, fragmentIdOf, searchBody, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
const fake = new FakeEmbeddings({ dim: 16, batchSize: 8 });
const config = testConfig({
  embedding: { provider: 'fake', baseUrl: null, model: null, revision: fake.revision, apiKey: null, dim: 16, template: 'plain', timeoutMs: 5000, batchSize: 8 },
});
let worker: WorkerRuntime;
const ids: Record<string, string> = {};
const filler = (n: number, word: string): string => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config, 'semantic-worker', fake);
  ids.rev = await uploadDocument(db, config, s.eng1, s.stageA, 'Договор-A.pdf');
  ids.run = await seedEvidenceRun(db.pool, ids.rev, {
    pages: [
      { stamp: 'Договор подряда № 15-П', blocks: ['Неустойка определяется договором', 'Неустойка 0,1% за каждый день просрочки окончания работ'] },
      // Длинная страница: короткий фрагмент на стыке частей попадает в два перекрывающихся чанка.
      { blocks: [filler(330, 'альфа'), 'Опорный узел ригеля по оси Б', filler(330, 'бета')] },
      { blocks: ['Гарантийный срок на результат работ составляет пять лет', 'Аванс в размере двадцати процентов от цены договора'] },
    ],
  });
  ids.revB = await uploadDocument(db, config, s.eng3, s.stageB, 'Договор-B.pdf');
  ids.runB = await seedEvidenceRun(db.pool, ids.revB, { pages: [{ blocks: ['Гарантийный срок на результат работ составляет три года'] }] });
  await setWorkingSet(s.eng1, s.stageA, [ids.rev]);
  await setWorkingSet(s.eng3, s.stageB, [ids.revB]);
  ids.v1 = await buildIndex(db, worker);
});
afterAll(async () => db.drop());

const post = (body: unknown, client = s.eng1) => client.post('/search', body);

describe('версия индекса с моделью', () => {
  it('отпечаток, размерность, шаблон входа и пробный вектор закреплены в версии; векторы полны', async () => {
    const v = (await getActiveVersion(db.pool))!;
    expect(v.id).toBe(ids.v1);
    expect(v).toMatchObject({
      embedding_model: fake.model,
      embedding_dim: 16,
      embedding_input_version: embeddingInputVersion('plain'),
      embedding_model_fingerprint: modelFingerprint(fake.model, 16, fake.revision),
    });
    expect(v.probe_vector).not.toBeNull();
    expect(await versionCompleteness(db.pool, v)).toEqual({ missingUnits: 0, missingVectors: 0 });
    const status = await getModelStatus(db.pool);
    expect(status).toMatchObject({ status: 'VERIFIED_FIXTURE', last_error_code: null });
  });
});

describe('смысловая ветка (ADR-012 §14)', () => {
  it('вектор запроса не в кеше: pending, предварительный лексический результат, итог — после задания класса gpu', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'какой гарантийный срок на работы'));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'pending', semantic: { status: 'queued' }, fused: null, lexical: { preliminary: true } });
    expect(r.body.lexical.items.length).toBeGreaterThan(0);
    const job = await db.pool.query('SELECT kind, resource_class, priority, dedupe_key, status FROM job WHERE dedupe_key = $1', [`search:${r.body.searchRunId}`]);
    expect(job.rows[0]).toMatchObject({ kind: 'search.semantic', resource_class: 'gpu', priority: 100, status: 'queued' });
    expect(await worker.runOnce([...INTERACTIVE_KINDS])).toBe(true);
    const done = await s.eng1.get(`/search-runs/${r.body.searchRunId}`);
    expect(done.body).toMatchObject({ status: 'complete', semantic: { status: 'complete' }, lexical: null });
    expect(done.body.branchCounts.vector).toBeGreaterThan(0);
    expect(done.body.fused.items[0].text).toBe('Гарантийный срок на результат работ составляет пять лет');
    expect(done.body.timings).toHaveProperty('embedMs');
  });

  it('тот же запрос повторно: вектор из кеша, итог синхронно (без внешнего вызова на сервере)', async () => {
    const calls = fake.calls;
    const r = await post(searchBody(s.tenderA, s.stageA, 'какой гарантийный срок на работы'));
    expect(r.body).toMatchObject({ status: 'complete', semantic: { status: 'complete', reason: 'query_vector_cached' }, lexical: null });
    expect(fake.calls).toBe(calls);
    const jobs = await db.pool.query('SELECT 1 FROM job WHERE dedupe_key = $1', [`search:${r.body.searchRunId}`]);
    expect(jobs.rowCount).toBe(0);
  });

  it('модель недоступна: задание деградирует прогон с причиной; следующий поиск деградирует сразу по состоянию модели', async () => {
    fake.behaviour.unavailable = true;
    try {
      const r = await post(searchBody(s.tenderA, s.stageA, 'аванс двадцать процентов'));
      expect(r.body.status).toBe('pending');
      await worker.runOnce([...INTERACTIVE_KINDS]);
      const done = await s.eng1.get(`/search-runs/${r.body.searchRunId}`);
      expect(done.body).toMatchObject({ status: 'degraded', semantic: { status: 'failed', reason: 'model_unavailable' } });
      // Итог по {exact, fts} всё равно есть: деградация, а не пустота.
      expect(done.body.fused.items[0].text).toBe('Аванс в размере двадцати процентов от цены договора');
      expect(done.body.fused.items[0].matchedVia).not.toContain('vector');
      const next = await post(searchBody(s.tenderA, s.stageA, 'аванс от цены'));
      expect(next.body).toMatchObject({ status: 'degraded', semantic: { status: 'unavailable', reason: 'model_unavailable' } });
    } finally {
      fake.behaviour.unavailable = false;
    }
    await worker.maintain({ checkModel: true });
    const again = await post(searchBody(s.tenderA, s.stageA, 'аванс от цены договора'));
    expect(again.body.status).toBe('pending');
    await worker.runOnce([...INTERACTIVE_KINDS]);
  });

  it('веса подменены под тем же именем: пробный вектор не совпал — смысловая ветка недоступна с причиной', async () => {
    fake.behaviour.drift = true;
    try {
      const report = await worker.maintain({ checkModel: true });
      expect(report.model).toBe('fingerprint_mismatch');
      const r = await post(searchBody(s.tenderA, s.stageA, 'опорный узел'));
      expect(r.body).toMatchObject({ status: 'degraded', semantic: { status: 'unavailable', reason: 'model_fingerprint_mismatch' } });
    } finally {
      fake.behaviour.drift = false;
    }
    expect((await worker.maintain({ checkModel: true })).model).toBe('ok');
  });

  it('модель вернула чужую размерность: деградация dimension_mismatch, в кеш и индекс ничего не пишется', async () => {
    fake.behaviour.wrongDim = 20;
    try {
      const r = await post(searchBody(s.tenderA, s.stageA, 'ригель по оси'));
      await worker.runOnce([...INTERACTIVE_KINDS]);
      const done = await s.eng1.get(`/search-runs/${r.body.searchRunId}`);
      expect(done.body.semantic).toEqual({ status: 'failed', reason: 'dimension_mismatch' });
      const wrong = await db.pool.query('SELECT count(*)::int AS n FROM embedding_cache WHERE dim <> 16');
      expect(wrong.rows[0].n).toBe(0);
    } finally {
      fake.behaviour.wrongDim = null;
    }
  });
});

describe('срок смысловой ветки и удаление выведенной версии (G05-02)', () => {
  it('брошенный клиентом pending-прогон по сроку становится degraded без чтения; позднее задание его не перезаписывает', async () => {
    const short = testConfig({ ...config, search: { ...config.search, semanticDeadlineMs: 300 } });
    const app = makeApp(db, undefined, short);
    const c = new TestClient(app);
    await c.login('eng1');
    const r = await c.post('/search', searchBody(s.tenderA, s.stageA, 'неустойка за просрочку окончания'));
    expect(r.body.status).toBe('pending');
    await new Promise((res) => setTimeout(res, 400));
    // Клиент не читает прогон: терминализует проход обслуживания worker.
    const report = await worker.maintain({ checkModel: false });
    expect(report.expiredRuns).toBe(1);
    const row = await db.pool.query('SELECT status, semantic_status, semantic_reason FROM search_run WHERE id = $1', [r.body.searchRunId]);
    expect(row.rows[0]).toEqual({ status: 'degraded', semantic_status: 'timeout', semantic_reason: 'semantic_timeout' });
    const job = await db.pool.query('SELECT status, cancel_requested FROM job WHERE dedupe_key = $1', [`search:${r.body.searchRunId}`]);
    expect(job.rows[0].status).toBe('cancelled');
    // Позднее завершение смысловой ветки: условная запись по pending ничего не меняет.
    const late = await withTransaction(db.pool, (cl) => completeSemantic(cl, r.body.searchRunId, fake.vectorOf('x'), {}));
    expect(late).toBe('not_pending');
    const fused = await db.pool.query("SELECT count(*)::int AS n FROM search_run_result WHERE run_id = $1 AND branch = 'vector'", [r.body.searchRunId]);
    expect(fused.rows[0].n).toBe(0);
  });

  it('данные выведенной версии не удаляются, пока за ней закреплён ожидающий прогон; после срока — удаляются', async () => {
    const medium = testConfig({ ...config, search: { ...config.search, semanticDeadlineMs: 1500 } });
    const app = makeApp(db, undefined, medium);
    const c = new TestClient(app);
    await c.login('eng1');
    const old = (await getActiveVersion(db.pool))!.id;
    const pending = await c.post('/search', searchBody(s.tenderA, s.stageA, 'гарантийный срок пять лет результат'));
    expect(pending.body.status).toBe('pending');
    // Новая версия строится и активируется, пока прогон ждёт GPU (сценарий AR05-03).
    const v2 = await createVersion(db.pool, {
      chunkerVersion: CHUNKER_VERSION,
      embedding: { inputVersion: embeddingInputVersion('plain'), model: fake.model, fingerprint: modelFingerprint(fake.model, 16, fake.revision), dim: 16, probe: fake.vectorOf(PROBE_TEXT) },
      createdBy: null,
    });
    for (let i = 0; i < 10 && !(await activateVersion(db.pool, v2)).activated; i += 1) {
      await worker.maintain({ checkModel: false });
      while (await worker.runOnce(['index.build', 'index.embed'])) {
        // пачки индексации
      }
    }
    expect((await getVersion(db.pool, old))!.status).toBe('retired');
    expect(await purgeVersion(db.pool, old)).toBe('pending_runs');
    const chunks = await db.pool.query('SELECT count(*)::int AS n FROM search_chunk WHERE index_version_id = $1', [old]);
    expect(chunks.rows[0].n).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 1600));
    await worker.maintain({ checkModel: false });
    await drain(worker);
    expect((await getVersion(db.pool, old))!.purged_at).not.toBeNull();
    // Прогон остался закреплён за старой версией и читается (строка версии не удаляется).
    const reread = await c.get(`/search-runs/${pending.body.searchRunId}`);
    expect(reread.body).toMatchObject({ status: 'degraded', semantic: { status: 'timeout' }, index: { versionId: old } });
  });
});

describe('зависимость index.build → index.embed (G05-01)', () => {
  it('векторная пачка раньше текстовой ничего не «закрывает навсегда»: версия активируется только после векторов всех чанков', async () => {
    const other = new FakeEmbeddings({ dim: 16, model: 'fake-hash-16-b', revision: 'b', batchSize: 8 });
    const w = makeWorker(db, config, 'order-worker', other);
    const embeddedBefore = other.embeddedTexts;
    const v = await createVersion(db.pool, {
      chunkerVersion: CHUNKER_VERSION,
      embedding: { inputVersion: embeddingInputVersion('plain'), model: other.model, fingerprint: modelFingerprint(other.model, 16, other.revision), dim: 16, probe: other.vectorOf(PROBE_TEXT) },
      createdBy: null,
    });
    // Принудительный порядок: векторная пачка первой, чанков ещё нет.
    await enqueueIndexEmbed(db.pool, v);
    expect(await w.runOnce(['index.embed'])).toBe(true);
    expect((await getVersion(db.pool, v))!.status).toBe('building');
    const after = await versionCompleteness(db.pool, (await getVersion(db.pool, v))!);
    expect(after.missingUnits).toBeGreaterThan(0);
    // Текстовые пачки: чанки появляются и той же транзакцией ставят векторную пачку.
    await enqueueJob(db.pool, { kind: 'index.build', dedupeKey: `index-build:${v}`, payload: { versionId: v }, priority: 10 });
    while (await w.runOnce(['index.build'])) {
      // текстовый фронт
    }
    expect((await getVersion(db.pool, v))!.status).toBe('building');
    const queuedEmbed = await db.pool.query("SELECT 1 FROM job WHERE dedupe_key = $1 AND status = 'queued'", [`index-embed:${v}`]);
    expect(queuedEmbed.rowCount).toBe(1);
    while (await w.runOnce(['index.embed'])) {
      // векторный хвост
    }
    expect((await getVersion(db.pool, v))!.status).toBe('active');
    // Кеш другой модели не использовался: векторы этой версии посчитаны заново для всех чанков.
    const chunks = await db.pool.query('SELECT count(*)::int AS n FROM search_chunk WHERE index_version_id = $1', [v]);
    expect(other.embeddedTexts - embeddedBefore).toBeGreaterThanOrEqual(chunks.rows[0].n);
    const cross = await cacheLookup(db.pool, { purpose: 'index', model: fake.model, fingerprint: modelFingerprint(other.model, 16, other.revision), inputVersion: embeddingInputVersion('plain'), dim: 16 }, ['0'.repeat(64)]);
    expect(cross.size).toBe(0);
    // Возврат к версии рабочей модели: проход обслуживания видит другую модель и строит новую версию.
    const restored = await buildIndex(db, worker);
    expect((await getVersion(db.pool, restored))!.embedding_model).toBe(fake.model);
  });
});

describe('очередь: приоритет и интерактивная полоса (ADR-004 §7a)', () => {
  it('смысловой запрос обгоняет пачку индексации; вторую незавершённую пачку того же вида поставить нельзя', async () => {
    const v = (await getActiveVersion(db.pool))!.id;
    const first = await enqueueIndexEmbed(db.pool, v);
    const second = await enqueueIndexEmbed(db.pool, v);
    expect(second).toEqual({ id: first.id, created: false });
    const run = await db.pool.query<{ id: string }>("SELECT id FROM search_run ORDER BY created_at DESC LIMIT 1");
    await enqueueSemantic(db.pool, run.rows[0]!.id, s.tenderA);
    const claimed = await claimJob(db.pool, { workerId: 'probe', leaseMs: 60_000, gpuGraceMs: 0 });
    expect(claimed?.kind).toBe('search.semantic');
    // Возврат захваченного задания и очистка очереди теста.
    await db.pool.query("UPDATE resource_slot SET holder_job_id = NULL, lease_token = NULL, locked_until = NULL WHERE slot_key = 'gpu'");
    await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL, locked_until = NULL, finished_at = now() WHERE status IN ('queued', 'running')");
    // Обычное задание (импорт, разбор, приём распознавания) по умолчанию выше фоновой индексации.
    await enqueueJob(db.pool, { kind: 'index.build', dedupeKey: `index-build:${v}`, payload: { versionId: v }, priority: 10 });
    await enqueueJob(db.pool, { kind: 'import.expand', payload: { batchId: 'x' } });
    const ordinary = await claimJob(db.pool, { workerId: 'probe', leaseMs: 60_000, gpuGraceMs: 0 });
    expect(ordinary?.kind).toBe('import.expand');
    await db.pool.query("UPDATE job SET status = 'cancelled', lease_token = NULL, locked_until = NULL, finished_at = now() WHERE status IN ('queued', 'running')");
  });

  it('пока фоновая полоса занята долгим заданием, интерактивная выполняет смысловой запрос', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const w = new WorkerRuntime({
      pool: db.pool,
      store: new BlobStore(config.storageRoot),
      config,
      handlers: { ...HANDLERS, 'test.long': async () => gate },
      workerId: 'lanes',
      embeddings: fake,
    });
    await enqueueJob(db.pool, { kind: 'test.long', priority: 50 });
    const background = w.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    const r = await post(searchBody(s.tenderA, s.stageA, 'опорный узел ригеля по оси'));
    expect(r.body.status).toBe('pending');
    expect(await w.runOnce([...INTERACTIVE_KINDS])).toBe(true);
    const done = await s.eng1.get(`/search-runs/${r.body.searchRunId}`);
    expect(done.body.status).toBe('complete');
    const long = await db.pool.query("SELECT status FROM job WHERE kind = 'test.long'");
    expect(long.rows[0].status).toBe('running');
    release();
    await background;
  });
});

describe('проекция чанка в цитату (G05-04)', () => {
  it('в чанке два фрагмента, точная фраза только во втором — точная и полнотекстовая ветки цитируют второй', async () => {
    const second = await fragmentIdOf(db.pool, ids.run!, 'Неустойка 0,1% за каждый день просрочки окончания работ');
    const posted = await post(searchBody(s.tenderA, s.stageA, '0,1%'));
    await worker.runOnce([...INTERACTIVE_KINDS]);
    const exact = await s.eng1.get(`/search-runs/${posted.body.searchRunId}`);
    expect(exact.body.fused.items[0]).toMatchObject({ fragmentId: second });
    expect(exact.body.fused.items[0].matchedVia).toContain('exact');
    const exactRanks = await db.pool.query<{ fragment_id: string }>("SELECT fragment_id FROM search_run_result WHERE run_id = $1 AND branch = 'exact' ORDER BY rank", [posted.body.searchRunId]);
    expect(exactRanks.rows.map((x) => x.fragment_id)).toEqual([second]);
    const fts = await post(searchBody(s.tenderA, s.stageA, 'неустойка за каждый день просрочки'));
    await worker.runOnce([...INTERACTIVE_KINDS]);
    const ftsDone = await s.eng1.get(`/search-runs/${fts.body.searchRunId}`);
    const ftsRanks = await db.pool.query<{ fragment_id: string }>("SELECT fragment_id FROM search_run_result WHERE run_id = $1 AND branch = 'fts' ORDER BY rank", [fts.body.searchRunId]);
    expect(ftsRanks.rows[0]!.fragment_id).toBe(second);
    expect(ftsDone.body.fused.items[0].fragmentId).toBe(second);
  });

  it('фрагмент на стыке двух перекрывающихся чанков занимает в ветке один ранг', async () => {
    const joint = await fragmentIdOf(db.pool, ids.run!, 'Опорный узел ригеля по оси Б');
    const v = (await getActiveVersion(db.pool))!.id;
    const linked = await db.pool.query('SELECT count(*)::int AS n FROM search_chunk_fragment l JOIN search_chunk c ON c.id = l.chunk_id WHERE l.fragment_id = $1 AND c.index_version_id = $2', [joint, v]);
    expect(linked.rows[0].n).toBe(2);
    const r = await post(searchBody(s.tenderA, s.stageA, 'опорный узел ригеля'));
    const rows = await db.pool.query<{ branch: string; n: number }>('SELECT branch, count(*)::int AS n FROM search_run_result WHERE run_id = $1 AND fragment_id = $2 GROUP BY branch', [r.body.searchRunId, joint]);
    for (const row of rows.rows) expect(row.n).toBe(1);
    expect(rows.rows.map((x) => x.branch)).toContain('fts');
  });

  it('векторная ветка цитирует только фрагмент связей своего чанка и только из закреплённой области', async () => {
    const v = (await getActiveVersion(db.pool))!.id;
    const lexemes = await queryLexemes(db.pool, 'гарантийный срок');
    const hits = await vectorBranch(db.pool, v, [ids.run!], fake.vectorOf('гарантийный срок'), lexemes, 50);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      const ok = await db.pool.query(
        `SELECT 1 FROM search_chunk c JOIN search_chunk_fragment l ON l.chunk_id = c.id JOIN evidence_fragment f ON f.id = l.fragment_id
          WHERE c.chunk_key = $1 AND c.index_version_id = $2 AND l.fragment_id = $3 AND f.source_unit_id = $4`,
        [h.chunkKey, v, h.fragmentId, ids.run],
      );
      expect(ok.rowCount, h.fragmentId).toBe(1);
    }
    const onlyB = await vectorBranch(db.pool, v, [ids.runB!], fake.vectorOf('гарантийный срок'), lexemes, 50);
    const units = await db.pool.query<{ source_unit_id: string }>('SELECT DISTINCT source_unit_id FROM evidence_fragment WHERE id = ANY($1::uuid[])', [onlyB.map((h) => h.fragmentId)]);
    expect(units.rows.map((x) => x.source_unit_id)).toEqual([ids.runB]);
  });
});

describe('план векторной ветки: фильтр до ORDER BY … LIMIT, без ANN (ADR-012 §7)', () => {
  interface IPlanNode {
    'Node Type': string;
    'Relation Name'?: string;
    'Index Name'?: string;
    'Order By'?: string;
    'Filter'?: string;
    'Index Cond'?: string;
    'Recheck Cond'?: string;
    'Sort Key'?: string[];
    Plans?: IPlanNode[];
  }
  const walk = (n: IPlanNode, out: IPlanNode[] = []): IPlanNode[] => {
    out.push(n);
    for (const c of n.Plans ?? []) walk(c, out);
    return out;
  };
  // Нарушение: упорядочивание расстояния индексом (ANN) или отсутствие фильтра области в чтении векторов.
  const violations = (plan: IPlanNode, annIndexes: Set<string>): string[] => {
    const nodes = walk(plan);
    const out: string[] = [];
    for (const n of nodes) {
      if (n['Order By']) out.push(`индексное упорядочивание: ${n['Index Name'] ?? n['Node Type']}`);
      if (n['Index Name'] && annIndexes.has(n['Index Name'])) out.push(`ANN-индекс ${n['Index Name']}`);
    }
    const reads = nodes.filter((n) => n['Relation Name'] === 'search_chunk_vector' || (n['Index Name'] ?? '').startsWith('search_chunk_vector'));
    const filtered = nodes.some((n) => [n.Filter, n['Index Cond'], n['Recheck Cond']].some((c) => c?.includes('source_unit_id')));
    if (reads.length === 0 || !filtered) out.push('фильтр области не стоит в чтении векторов');
    const sort = nodes.find((n) => n['Node Type'] === 'Sort');
    if (!sort || !(sort['Sort Key'] ?? []).some((k) => k.includes('<=>'))) out.push('расстояние сортируется не перебором');
    return out;
  };
  const annIndexes = async (): Promise<Set<string>> =>
    new Set(
      (
        await db.pool.query<{ relname: string }>(
          "SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_am a ON a.oid = c.relam WHERE a.amname IN ('hnsw', 'ivfflat')",
        )
      ).rows.map((r) => r.relname),
    );

  it('точный перебор по отфильтрованной области: сортировка по расстоянию над чтением с фильтром единиц', async () => {
    const v = (await getActiveVersion(db.pool))!.id;
    const r = await db.pool.query<{ 'QUERY PLAN': { Plan: IPlanNode }[] }>(`EXPLAIN (FORMAT JSON) ${VECTOR_TOP_SQL}`, [v, [ids.run], `[${fake.vectorOf('срок').join(',')}]`, 10]);
    const plan = r.rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Node Type']).toBe('Limit');
    expect(violations(plan, await annIndexes())).toEqual([]);
  });

  it('проверка плана не пуста: ANN-индекс на таблице векторов непредставим, а план с индексным упорядочиванием отклоняется', async () => {
    const pg = (await import('pg')).default;
    const m = new pg.Client({ connectionString: db.migratorUrl });
    await m.connect();
    try {
      await expect(m.query('CREATE INDEX hack_hnsw ON search_chunk_vector USING hnsw (embedding halfvec_cosine_ops)')).rejects.toThrow(/dimensions/u);
    } finally {
      await m.end();
    }
    const annPlan: IPlanNode = {
      'Node Type': 'Limit',
      Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'search_chunk_vector', 'Index Name': 'hack_hnsw', 'Order By': '(embedding <=> $3)', Filter: '(source_unit_id = ANY ($2))' }],
    };
    expect(violations(annPlan, new Set(['hack_hnsw'])).length).toBeGreaterThan(0);
  });
});
