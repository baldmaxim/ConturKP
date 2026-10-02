// Этап 08a, граф фактов D-018 (D-028): извлечение заданием worker по прогону распознавания, граф договора (явная связь
// 06a) и тендера (связь по тексту), замечание о неоднозначности, решение человека через API (ребро графа, пересчёт
// в той же транзакции, замечание закрывается), стороны в карточке договора без перезаписи полей, права.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContract, grantCreator, setAccess, uploadContractDocument, uploadMain } from './contractFixtures.ts';
import { auditRows, buildScenario, createTestDb, drain, idem, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { seedEvidenceRun, uploadDocument } from './searchFixtures.ts';
import { fakePdf } from './zip.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
let contractId: string;
let undatedContractId: string;
let sameDateContractId: string;
const config = testConfig();

interface IGraphBody {
  owner: { kind: string; id: string };
  canDecide: boolean;
  documents: { documentId: string; kind: string; number: string | null; documentDate: string | null; role: string | null; relation: { relation: string; source: string; toDocumentId: string | null } | null }[];
  facts: { id: string; type: string; display: string; rawValue: string; clauseRef: string | null; documentId: string; fragmentIds: string[]; state: { status: string; supersededReason: string | null; supersededByFactId: string | null; decidedBy: string; validFrom: string | null; validTo: string | null } | null }[];
  parties: { type: string; name: string }[];
  remarks: { id: string; kind: string; status: string; factIds: string[] }[];
  decisions: { kind: string; reason: string }[];
  coverage: Record<string, unknown>;
}

const extract = async (): Promise<void> => {
  await worker.scheduleFactExtraction();
  await drain(worker);
};
const graphOf = async (client: IScenario['manager'], path: string): Promise<IGraphBody> => {
  const r = await client.get(path);
  expect(r.status, r.text).toBe(200);
  return r.body as IGraphBody;
};
const advance = (g: IGraphBody, display: string) => g.facts.find((f) => f.type === 'advance_percent' && f.display === display)!;

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = workerWithChat(db, config, null);
  // Договор 06a: основной документ, датированное допсоглашение с явной связью.
  await grantCreator(s.admin, s.ids.manager);
  contractId = await createContract(s.manager, 'Д-ГРАФ');
  const main = await uploadMain(s.manager, contractId, 'договор.pdf');
  await seedEvidenceRun(db.pool, main.revisionId, {
    pages: [{ blocks: ['Договор подряда № Д-ГРАФ от 10.01.2026', 'Заказчик: ООО «Альфа». Генподрядчик: ООО «Бета».', '3.1. Аванс в размере 20% от цены договора.', '6.1. Гарантийный срок составляет 5 лет.'] }],
  });
  const ds = await uploadContractDocument(s.manager, contractId, 'ДС-1.pdf', fakePdf('ДС-1 граф'), { role: 'addendum', mainDocumentId: main.documentId });
  expect(ds.status, ds.text).toBe(201);
  await seedEvidenceRun(db.pool, ds.body.revisionId as string, { pages: [{ blocks: ['Дополнительное соглашение № 1 от 15.03.2026', 'Пункт 3.1 договора изложить в новой редакции: «Аванс в размере 10% от цены договора».'] }] });
  // Договор с допсоглашением без даты.
  undatedContractId = await createContract(s.manager, 'Д-БЕЗ-ДАТЫ');
  const main2 = await uploadMain(s.manager, undatedContractId, 'договор-2.pdf');
  await seedEvidenceRun(db.pool, main2.revisionId, { pages: [{ blocks: ['Договор подряда № Д-2 от 10.01.2026', '3.1. Аванс в размере 20% от цены договора.'] }] });
  const ds2 = await uploadContractDocument(s.manager, undatedContractId, 'ДС-без-даты.pdf', fakePdf('ДС без даты'), { role: 'addendum', mainDocumentId: main2.documentId });
  await seedEvidenceRun(db.pool, ds2.body.revisionId as string, { pages: [{ blocks: ['Дополнительное соглашение № 1', 'Пункт 3.1 договора изложить в новой редакции: «Аванс в размере 10% от цены договора».'] }] });
  // Договор с двумя допсоглашениями одной даты к пункту 3.1 (10% и 15%) — сценарий R08a-03.
  sameDateContractId = await createContract(s.manager, 'Д-ОДНА-ДАТА');
  const main3 = await uploadMain(s.manager, sameDateContractId, 'договор-3.pdf');
  await seedEvidenceRun(db.pool, main3.revisionId, { pages: [{ blocks: ['Договор подряда № Д-3 от 10.01.2026', '3.1. Аванс в размере 20% от цены договора.'] }] });
  for (const [name, n, percent] of [['ДС-1.pdf', 1, 10], ['ДС-2.pdf', 2, 15]] as const) {
    const d = await uploadContractDocument(s.manager, sameDateContractId, name, fakePdf(`${name} одна дата`), { role: 'addendum', mainDocumentId: main3.documentId });
    expect(d.status, d.text).toBe(201);
    await seedEvidenceRun(db.pool, d.body.revisionId as string, {
      pages: [{ blocks: [`Дополнительное соглашение № ${n} от 01.03.2026`, `Пункт 3.1 договора изложить в новой редакции: «Аванс в размере ${percent}% от цены договора».`] }],
    });
  }
  // Документы тендера A: договор поставки и допсоглашение к нему по тексту.
  const supply = await uploadDocument(db, config, s.eng1, s.stageA, 'Договор поставки.pdf');
  await seedEvidenceRun(db.pool, supply, { pages: [{ blocks: ['Договор поставки № П-7 от 01.02.2026', '3.1. Аванс составляет 25% от цены договора.'] }] });
  const supplyDs = await uploadDocument(db, config, s.eng1, s.stageA, 'ДС-2.pdf');
  await seedEvidenceRun(db.pool, supplyDs, {
    pages: [{ blocks: ['Дополнительное соглашение № 2 от 01.04.2026 к договору поставки № П-7 от 01.02.2026', 'Пункт 3.1 договора изложить в новой редакции: «Аванс составляет 15% от цены договора».'] }],
  });
  await extract();
});
afterAll(async () => {
  await db.drop();
});

describe('извлечение и граф договора (явная связь 06a)', () => {
  it('задание извлекает факты; датированное допсоглашение перекрывает пункт 3.1 правилом; другие пункты действуют', async () => {
    const runs = await db.pool.query("SELECT j.kind, j.resource_class, j.status FROM job j WHERE j.kind = 'fact.extract'");
    expect(runs.rows.length).toBeGreaterThanOrEqual(6);
    expect(runs.rows.every((r) => r.resource_class === 'default' && r.status === 'succeeded')).toBe(true);
    const g = await graphOf(s.manager, `/contracts/${contractId}/fact-graph`);
    expect(g.documents.map((d) => [d.kind, d.number, d.documentDate]).sort()).toEqual([
      ['amendment', '1', '2026-03-15'],
      ['contract', 'Д-ГРАФ', '2026-01-10'],
    ]);
    expect(g.documents.find((d) => d.kind === 'amendment')!.relation).toMatchObject({ relation: 'amends', source: '06a' });
    expect(advance(g, '20 %').state).toMatchObject({ status: 'superseded', supersededReason: 'amendment', decidedBy: 'rule', validTo: '2026-03-15' });
    expect(advance(g, '10 %').state).toMatchObject({ status: 'active', validFrom: '2026-03-15' });
    expect(g.facts.find((f) => f.type === 'warranty_period')!.state!.status).toBe('active');
    expect(g.remarks.filter((r) => r.status === 'open')).toEqual([]);
    // Судьба contract_card: стороны показываются, поле карточки договора не меняется.
    expect(g.parties.map((p) => [p.type, p.name])).toEqual([
      ['party_contractor', 'ООО «Бета»'],
      ['party_customer', 'ООО «Альфа»'],
    ]);
    expect((await s.manager.get(`/contracts/${contractId}`)).body.counterparty ?? null).toBeNull();
    // Повтор планирования — нового прогона извлечения нет.
    expect(await worker.scheduleFactExtraction()).toBe(0);
  });

  it('допсоглашение без даты: оба значения в конфликте, открытые замечания человеку', async () => {
    const g = await graphOf(s.manager, `/contracts/${undatedContractId}/fact-graph`);
    expect(g.facts.filter((f) => f.type === 'advance_percent').map((f) => f.state!.status)).toEqual(['conflict', 'conflict']);
    expect(g.remarks.filter((r) => r.status === 'open').map((r) => r.kind).sort()).toEqual(['undated_amendment', 'value_conflict']);
    expect(g.canDecide).toBe(true);
  });

  it('решение человека: «действует 10 %» — ребро графа, пересчёт в той же транзакции, конфликт закрыт; решение неизменно в истории', async () => {
    const g = await graphOf(s.manager, `/contracts/${undatedContractId}/fact-graph`);
    const fresh = advance(g, '10 %');
    const old = advance(g, '20 %');
    const r = await s.manager.post(`/evidence-facts/${fresh.id}/decisions`, { otherFactId: old.id, kind: 'prevails', reason: 'ДС № 1 подписано после договора' }, { headers: idem() });
    expect(r.status, r.text).toBe(201);
    const after = r.body.graph as IGraphBody;
    expect(advance(after, '20 %').state).toMatchObject({ status: 'superseded', supersededReason: 'human', supersededByFactId: fresh.id, decidedBy: 'human' });
    expect(advance(after, '10 %').state!.status).toBe('active');
    const conflict = after.remarks.find((x) => x.kind === 'value_conflict')!;
    expect(conflict.status).toBe('resolved');
    // Решение по паре снимает и вопрос порядка недатированного допсоглашения.
    expect(after.remarks.find((x) => x.kind === 'undated_amendment')!.status).toBe('resolved');
    expect(after.decisions).toMatchObject([{ kind: 'prevails', reason: 'ДС № 1 подписано после договора' }]);
    expect(await auditRows(db.pool, "action = 'fact.decision' AND outcome = 'allowed'")).toHaveLength(1);
    // «Вернуть правилу» — конфликт снова открыт новым замечанием (закрытое неизменно).
    const back = await s.manager.post(`/evidence-facts/${old.id}/decisions`, { otherFactId: fresh.id, kind: 'rule', reason: 'проверить по оригиналу' }, { headers: idem() });
    expect(back.status, back.text).toBe(201);
    const remarks = (back.body.graph as IGraphBody).remarks.filter((x) => x.kind === 'value_conflict');
    expect(remarks.map((x) => x.status).sort()).toEqual(['open', 'resolved']);
  });

  it('права: без contract.read — 403; без contract.manage решение — 403; чужой факт пары — 409', async () => {
    const g = await graphOf(s.manager, `/contracts/${contractId}/fact-graph`);
    expect((await s.eng1.get(`/contracts/${contractId}/fact-graph`)).status).toBe(404);
    await setAccess(s.admin, contractId, s.ids.eng1, ['contract.read']);
    const eng = await graphOf(s.eng1, `/contracts/${contractId}/fact-graph`);
    expect(eng.canDecide).toBe(false);
    const denied = await s.eng1.post(`/evidence-facts/${advance(g, '10 %').id}/decisions`, { otherFactId: advance(g, '20 %').id, kind: 'distinct', reason: 'x' }, { headers: idem() });
    expect(denied.status).toBe(403);
    const other = await graphOf(s.manager, `/contracts/${undatedContractId}/fact-graph`);
    const cross = await s.manager.post(`/evidence-facts/${advance(g, '10 %').id}/decisions`, { otherFactId: other.facts[0]!.id, kind: 'distinct', reason: 'x' }, { headers: idem() });
    expect(cross.status).toBe(409);
    await setAccess(s.admin, contractId, s.ids.eng1, []);
    expect([403, 404]).toContain((await s.eng1.get(`/contracts/${contractId}/fact-graph`)).status);
  });
});

describe('R08a-03: допсоглашения одной даты через API', () => {
  it('два ДС от 01.03.2026 (10% и 15%) — все значения аванса в конфликте, взаимных перекрытий нет, открыто замечание человеку', async () => {
    const g = await graphOf(s.manager, `/contracts/${sameDateContractId}/fact-graph`);
    const adv = g.facts.filter((f) => f.type === 'advance_percent');
    expect(adv.map((f) => [f.display, f.state!.status]).sort()).toEqual([
      ['10 %', 'conflict'],
      ['15 %', 'conflict'],
      ['20 %', 'conflict'],
    ]);
    expect(adv.every((f) => f.state!.supersededByFactId === null)).toBe(true);
    const open = g.remarks.filter((r) => r.status === 'open' && r.kind === 'value_conflict');
    expect(open).toHaveLength(1);
    expect(open[0]!.factIds.sort()).toEqual(adv.map((f) => f.id).sort());
    expect(g.documents.filter((d) => d.kind === 'amendment').map((d) => d.documentDate)).toEqual(['2026-03-01', '2026-03-01']);
  });
});

describe('граф тендера (связь по тексту)', () => {
  it('«Дополнительное соглашение № 2 … к договору поставки № П-7 от …» перекрывает пункт 3.1 договора тендера', async () => {
    const g = await graphOf(s.eng1, `/tenders/${s.tenderA}/fact-graph`);
    expect(g.documents.find((d) => d.kind === 'amendment')!.relation).toMatchObject({ relation: 'amends', source: 'text' });
    expect(advance(g, '25 %').state).toMatchObject({ status: 'superseded', supersededReason: 'amendment' });
    expect(advance(g, '15 %').state!.status).toBe('active');
    expect(g.canDecide).toBe(false);
  });

  it('права тендера: не участник — 404; участник без fact.confirm решение не принимает — 403', async () => {
    expect((await s.eng3.get(`/tenders/${s.tenderA}/fact-graph`)).status).toBe(404);
    const g = await graphOf(s.eng1, `/tenders/${s.tenderA}/fact-graph`);
    const r = await s.eng1.post(`/evidence-facts/${advance(g, '15 %').id}/decisions`, { otherFactId: advance(g, '25 %').id, kind: 'distinct', reason: 'x' }, { headers: idem() });
    expect(r.status).toBe(403);
    expect((await s.manager.get(`/tenders/${s.tenderA}/fact-graph`)).body.canDecide).toBe(true);
  });
});
