// S17-26 (найдено регрессией Review 17-4): пока модель не проверена, worker строит текстовую версию индекса; векторную
// создаёт проба модели. Проба, пришедшаяся на постройку текстовой версии, ничего не создавала, а следующая — после
// успеха — ждала полный интервал проверки (час): смысловой поиск недоступен до часа после первого запуска с готовой
// моделью. Требуется: пока активная версия построена не настроенной моделью, проба повторяется с интервалом повтора.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeEmbeddings } from '../packages/adapters/src/index.ts';
import { getActiveVersion, getBuildingVersion } from '../packages/db/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { buildScenario, createTestDb, drain, makeApp, makeWorker, testConfig, type ITestDb } from './helpers.ts';
import { seedEvidenceRun, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let worker: WorkerRuntime;
const fake = new FakeEmbeddings({ dim: 16, batchSize: 4 });
// Повтор — сразу, полный интервал — час: без исправления вторая проба не наступает.
const config = testConfig({
  embedding: { provider: 'fake', baseUrl: null, model: null, revision: fake.revision, apiKey: null, dim: 16, template: 'plain', timeoutMs: 5000, batchSize: 4 },
  search: { ...testConfig().search, modelCheckIntervalMs: 3_600_000, modelRetryIntervalMs: 0 },
});

beforeAll(async () => {
  db = await createTestDb();
  const s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config, 'probe-race-worker', fake);
  const rev = await uploadDocument(db, config, s.eng1, s.stageA, 'Проба.pdf');
  await seedEvidenceRun(db.pool, rev, { pages: Array.from({ length: 6 }, (_, i) => ({ blocks: [`Раздел ${i + 1}: гидроизоляция кровли секции ${i + 1}`] })) });
});
afterAll(async () => {
  await db.drop();
});

describe('S17-26: векторная версия после пробы во время постройки текстовой', () => {
  it('проба во время постройки текстовой версии не создаёт векторную; следующая проба — с интервалом повтора, версия модели становится активной', async () => {
    // Первый проход: модель ещё не проверена — текстовая версия (строится), проба в очереди.
    await worker.maintainSearch();
    const text = (await getBuildingVersion(db.pool))!;
    expect(text.embedding_model).toBeNull();
    // Проба приходится на постройку текстовой версии: модель отвечает, но новая версия не создаётся.
    expect(await worker.runOnce(['model.probe'])).toBe(true);
    expect((await getBuildingVersion(db.pool))!.id).toBe(text.id);
    await drain(worker);
    expect((await getActiveVersion(db.pool))!.id).toBe(text.id);
    // Обычные проходы обслуживания: активная версия не той модели — проба повторяется, векторная версия строится.
    for (let i = 0; i < 3 && (await getActiveVersion(db.pool))!.embedding_model !== fake.model; i += 1) {
      await worker.maintainSearch();
      await drain(worker);
    }
    const active = (await getActiveVersion(db.pool))!;
    expect(active.embedding_model).toBe(fake.model);
    expect(active.embedding_dim).toBe(16);
  });
});
