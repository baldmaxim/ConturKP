// Этап 08a, граф фактов D-018 (D-028): судьба девяти типов — кандидаты требований. Прогон анализа с провайдером
// `rules` (без модели, класс default) берёт факты графа снимка реестра, основания которых во входе прогона: перекрытые
// факты кандидатами не становятся, факт в конфликте — кандидат с пометкой. Происхождение кандидата — `rule`; решение
// остаётся человеку: подтверждение руководителем, создатель-правило ничего не подтверждает.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { confirm, workerWithChat } from './requirementFixtures.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let registryId: string;
const config = testConfig();

interface ICandidate {
  id: string;
  origin: string;
  statement: string;
  status: string;
  parameters: { name: string; value: string; unit: string | null }[];
  rationale: string | null;
}

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  // Модели нет вовсе: правила её не требуют.
  worker = workerWithChat(db, config, null);
  const contract = await uploadDocument(db, config, s.eng1, s.stageA, 'Договор подряда 15.pdf');
  await seedEvidenceRun(db.pool, contract, {
    pages: [
      {
        blocks: [
          'Договор подряда № 15 от 10.01.2026',
          'Заказчик: ООО «Альфа». Генподрядчик: ООО «Бета».',
          '2.1. Цена договора составляет 100 000 000 рублей, в том числе НДС 20%.',
          '3.1. Аванс в размере 20% от цены договора.',
          '6.1. Гарантийный срок составляет 5 лет.',
          '7.1. Неустойка в размере 0,1% от цены договора за каждый день просрочки.',
        ],
      },
    ],
  });
  const ds = await uploadDocument(db, config, s.eng1, s.stageA, 'ДС-1.pdf');
  await seedEvidenceRun(db.pool, ds, {
    pages: [{ blocks: ['Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 15 от 10.01.2026', 'Пункт 3.1 договора изложить в новой редакции: «Аванс в размере 10% от цены договора».'] }],
  });
  await setWorkingSet(s.manager, s.stageA, [contract, ds], true);
  await worker.scheduleFactExtraction();
  await drain(worker);
  const scopeId = await fixScope(s.manager, s.stageA);
  const reg = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scopeId, reason: 'Реестр с правилами D-018' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  registryId = reg.body.id as string;
});
afterAll(async () => {
  await db.drop();
});

const candidates = async (): Promise<ICandidate[]> => (await s.manager.get(`/requirement-registries/${registryId}/candidates`)).body.items as ICandidate[];

describe('кандидаты требований по правилам (D-028)', () => {
  it('прогон rules без модели: кандидаты из девяти типов; перекрытый аванс 20 % — не кандидат; стороны и цена — не кандидаты', async () => {
    const r = await s.eng1.post(`/requirement-registries/${registryId}/analysis-runs`, { task: 'requirement_extraction', method: 'rules' }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ providerId: 'rules' });
    const job = await db.pool.query('SELECT kind, resource_class FROM job WHERE id = (SELECT job_id FROM analysis_run WHERE id = $1)', [r.body.id]);
    expect(job.rows[0]).toEqual({ kind: 'analysis.rules', resource_class: 'default' });
    await drain(worker);
    const run = (await s.eng1.get(`/analysis-runs/${r.body.id}`)).body;
    expect(run.status).toBe('completed');
    const items = (await candidates()).filter((c) => c.origin === 'rule');
    expect(items.map((c) => c.statement).sort()).toEqual([
      'Гарантийный срок: 60 мес. (п. 6.1)',
      'Неустойка: 0.1 % (п. 7.1)',
      'Размер аванса: 10 % (п. 3.1)',
      'Ставка НДС: 20 % (п. 2.1)',
    ]);
    expect(items.find((c) => c.statement.startsWith('Размер аванса'))!.parameters).toEqual([{ name: 'Размер аванса', value: '10', unit: '%' }]);
    expect(run.coverage).toMatchObject({ skippedSuperseded: 1, candidatesSaved: 4 });
    // Повтор с тем же входом — тот же прогон, кандидатов не прибавилось.
    const again = await s.eng1.post(`/requirement-registries/${registryId}/analysis-runs`, { task: 'requirement_extraction', method: 'rules' }, { headers: idem() });
    expect(again.body).toMatchObject({ id: r.body.id, reused: true });
  });

  it('решение остаётся человеку: кандидат правила подтверждает руководитель; правила только для кандидатов требований', async () => {
    const c = (await candidates()).find((x) => x.origin === 'rule' && x.statement.startsWith('Размер аванса'))!;
    expect(c.status).toBe('proposed');
    const ok = await confirm(s.manager, c.id);
    expect(ok.status, ok.text).toBe(200);
    const bad = await s.eng1.post(`/requirement-registries/${registryId}/analysis-runs`, { task: 'fact_extraction', method: 'rules' }, { headers: idem() });
    expect(bad.status).toBe(400);
  });
});
