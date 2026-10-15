// S17-26 (найдено регрессией Review 17-4): пока модель не проверена, worker строит текстовую версию индекса; векторную
// создаёт проба модели. Проба, пришедшаяся на постройку текстовой версии, ничего не создавала, а следующая — после
// успеха — ждала полный интервал проверки (час): смысловой поиск недоступен до часа после первого запуска с готовой
// моделью. Требуется: пока активная версия построена не настроенной моделью, проба повторяется с интервалом повтора.
// R17-08 (Review 17-5): «не настроенной моделью» — по отпечатку (имя, ревизия, размерность) и версии входа, а не по
// имени: та же модель новой ревизии оставляла старую версию активной до часа. Контроль — другое имя модели.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddings } from '../packages/adapters/src/index.ts';
import { getActiveVersion, getBuildingVersion, getModelStatus } from '../packages/db/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { buildScenario, createTestDb, drain, makeApp, makeWorker, testConfig, type ITestDb } from './helpers.ts';
import type { IAppConfig } from '../packages/config/src/index.ts';
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

// Ревизия — часть отпечатка версии индекса. Старый worker строит версию прежней ревизии; проба новой конфигурации
// проходит, пока та ещё строится, и новую версию не создаёт; затем прежняя версия активируется. Дальше — только
// обычные проходы обслуживания worker новой конфигурации.
// Хранилище общее: обе конфигурации — один портал, меняется только модель.
const configOf = (e: FakeEmbeddings, base?: IAppConfig): IAppConfig => {
  const embedding = { provider: 'fake' as const, baseUrl: null, model: e.model, revision: e.revision, apiKey: null, dim: 16, template: 'plain' as const, timeoutMs: 5000, batchSize: 4 };
  return base ? { ...base, embedding } : testConfig({ embedding, search: { ...testConfig().search, modelCheckIntervalMs: 3_600_000, modelRetryIntervalMs: 0 } });
};

describe('R17-08: смена модели во время постройки прежней версии', () => {
  let db2: ITestDb;
  beforeEach(async () => {
    db2 = await createTestDb();
  });
  afterEach(async () => {
    await db2.drop();
  });

  it.each([
    ['та же модель, новая ревизия', 'review-model', 'new-revision'],
    ['контроль: другое имя модели', 'other-model', 'old-revision'],
  ])('%s — активной становится версия настроенной модели', async (_name, model, revision) => {
    const oldE = new FakeEmbeddings({ dim: 16, batchSize: 4, model: 'review-model', revision: 'old-revision' });
    const newE = new FakeEmbeddings({ dim: 16, batchSize: 4, model, revision });
    const newConfig = configOf(newE);
    const s = await buildScenario(db2, makeApp(db2, undefined, newConfig));
    const rev = await uploadDocument(db2, newConfig, s.eng1, s.stageA, 'Ревизия.pdf');
    await seedEvidenceRun(db2.pool, rev, { pages: Array.from({ length: 6 }, (_, i) => ({ blocks: [`Раздел ${i + 1}: армирование плиты секции ${i + 1}`] })) });
    const oldW = makeWorker(db2, configOf(oldE, newConfig), 'old-revision-worker', oldE);
    const newW = makeWorker(db2, newConfig, 'new-revision-worker', newE);
    // Прежняя конфигурация начинает версию своей модели.
    await oldW.maintainSearch({ checkModel: true });
    const old = (await getBuildingVersion(db2.pool))!;
    expect(old.embedding_model).toBe('review-model');
    // Новая конфигурация: проба проходит, пока прежняя версия строится, — новой версии нет.
    await newW.maintainSearch();
    expect(await newW.runOnce(['model.probe'])).toBe(true);
    expect((await getBuildingVersion(db2.pool))!.id).toBe(old.id);
    const probed = (await getModelStatus(db2.pool))!;
    expect(probed.last_error_code).toBeNull();
    expect(probed.details.fingerprint).not.toBe(old.embedding_model_fingerprint);
    // Индексные задания прежней версии завершает прежний worker; версия активируется.
    while (await oldW.runOnce(['index.build', 'index.embed'])) {
      // хвост индексации прежней версии
    }
    expect((await getActiveVersion(db2.pool))!.id).toBe(old.id);
    // Обычные проходы обслуживания новой конфигурации.
    for (let i = 0; i < 3 && (await getActiveVersion(db2.pool))!.embedding_model_fingerprint !== probed.details.fingerprint; i += 1) {
      await newW.maintainSearch();
      await drain(newW);
    }
    const active = (await getActiveVersion(db2.pool))!;
    expect(active.id).not.toBe(old.id);
    expect(active.embedding_model_fingerprint).toBe(probed.details.fingerprint);
    expect([active.embedding_model, active.embedding_dim]).toEqual([model, 16]);
  });
});
