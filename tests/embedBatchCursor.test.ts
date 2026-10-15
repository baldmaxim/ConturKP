// Пачки векторов идут курсором по чанкам версии (этап 17, S17-23). Без курсора запрос выбора каждой пачки пропускал
// все уже векторизованные чанки с начала: на профиле D-040 (350 тыс. чанков) скорость падала с ~380 до ~23 векторов
// в секунду даже на поддельной модели. Здесь — смысл курсора: следующая пачка продолжает с места остановки, отставший
// чанк добирается проходом с начала, полнота векторов не теряется.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeEmbeddings } from '../packages/adapters/src/index.ts';
import { chunksWithoutVectors, enqueueIndexEmbed, getActiveVersion } from '../packages/db/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { buildScenario, createTestDb, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildIndex, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let versionId = '';
const fake = new FakeEmbeddings({ dim: 16, batchSize: 4 });
const config = testConfig({
  embedding: { provider: 'fake', baseUrl: null, model: null, revision: fake.revision, apiKey: null, dim: 16, template: 'plain', timeoutMs: 5000, batchSize: 4 },
});

const asOwner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: db.migratorUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};
const chunkIds = async (): Promise<string[]> =>
  (await db.pool.query<{ id: string }>('SELECT id FROM search_chunk WHERE index_version_id = $1 ORDER BY id', [versionId])).rows.map((r) => r.id);
const missing = async (): Promise<number> =>
  (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM search_chunk c WHERE c.index_version_id = $1 AND NOT EXISTS (SELECT 1 FROM search_chunk_vector v WHERE v.chunk_id = c.id)', [versionId])).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config, 'cursor-worker', fake);
  const rev = await uploadDocument(db, config, s.eng1, s.stageA, 'Курсор.pdf');
  await seedEvidenceRun(db.pool, rev, { pages: Array.from({ length: 24 }, (_, i) => ({ blocks: [`Раздел ${i + 1}: устройство монолитных конструкций секции ${i + 1}`] })) });
  await setWorkingSet(s.eng1, s.stageA, [rev]);
  versionId = await buildIndex(db, worker);
});
afterAll(async () => {
  await db.drop();
});

describe('S17-23: пачки векторов курсором', () => {
  it('версия полна; пачки после первой продолжают с курсора, а не с начала', async () => {
    expect((await getActiveVersion(db.pool))!.id).toBe(versionId);
    const ids = await chunkIds();
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(await missing()).toBe(0);
    const jobs = await db.pool.query<{ after: string | null }>(
      "SELECT payload ->> 'afterChunkId' AS after FROM job WHERE kind = 'index.embed' AND payload ->> 'versionId' = $1 AND status = 'succeeded' ORDER BY created_at, id",
      [versionId],
    );
    const cursors = jobs.rows.map((r) => r.after).filter((x): x is string => x !== null);
    expect(cursors.length, 'пачки с курсором').toBeGreaterThan(0);
    for (const c of cursors) expect(ids).toContain(c);
  });

  it('курсор: выбор только после него; отставший чанк до курсора добирается проходом с начала', async () => {
    const ids = await chunkIds();
    const first = ids[0]!;
    const lastId = ids.at(-1)!;
    // Два «отставших» — в начале и в середине прохода.
    const mid = ids[Math.floor(ids.length / 2)]!;
    await asOwner((c) => c.query('DELETE FROM search_chunk_vector WHERE chunk_id = ANY($1::uuid[])', [[first, mid]]));
    expect((await chunksWithoutVectors(db.pool, versionId, 10, first)).map((r) => r.id)).toEqual([mid]);
    expect((await chunksWithoutVectors(db.pool, versionId, 10, lastId)).map((r) => r.id)).toEqual([]);
    expect((await chunksWithoutVectors(db.pool, versionId, 10)).map((r) => r.id)).toEqual([first, mid]);
    // Пачка с курсором за концом прохода: после курсора пусто — проход с начала, оба чанка снова с векторами.
    await enqueueIndexEmbed(db.pool, versionId, lastId);
    while (await worker.runOnce(['index.embed'])) {
      // хвост векторов
    }
    expect(await missing()).toBe(0);
  });
});
