// Фикстуры этапа 10: две версии одного номера тендера в поддельном TenderHub (VERIFIED_FIXTURE, не рабочая
// интеграция). Данные синтетические, эталоны посчитаны заранее (test-plan.md:24):
//  - «Штукатурка стен» 100 × 10 → 110 × 12, коэффициент 1,2 → 1,25 (A20);
//  - «Кладка стен» разделена на наружные и внутренние (A22);
//  - «Стяжка пола» — две позиции с одним ключом change-impact (повтор ключа, пары — по номеру позиции);
//  - «Вывоз мусора» в USD: курс 90 → 100;
//  - «Светильники» — отклонения источника: количество привязанного материала ≠ выводу, нулевое количество без
//    коммерческой стоимости, тип вне перечня, отрицательная строка;
//  - «Окраска фасада» — новая позиция; cached_grand_total больше Σ строк на 15,5 и 20.
import { expect } from 'vitest';
import type { IModelGatewayChat } from '../packages/adapters/src/index.ts';
import type { IAppConfig } from '../packages/config/src/index.ts';
import { dec, mul, str, sum } from '../packages/core/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { fakeItem, fakePosition, fakeTender, type FakeRow, type IFakeTender } from '../scripts/tenderhub-fake-data.ts';
import { adminMember, captureNow, linkSource, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { buildScenario, idem, makeApp, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { fakeModel } from './reviewFixtures.ts';

const id = (block: string, k: number) => `7d1f0c8e-1010-4a6b-9c1d-${block}${String(k).padStart(12 - block.length, '0')}`;

export const E = {
  v1: id('1', 1),
  v2: id('1', 2),
  number: 'TH-2026-010',
  p: { s0: id('a', 0), A: id('a', 1), B: id('a', 2), C: id('a', 3), D: id('a', 4), E: id('a', 5), F: id('a', 6) },
  q: { s0: id('b', 0), A: id('b', 1), B1: id('b', 2), C: id('b', 3), D: id('b', 4), E: id('b', 5), F: id('b', 6), B2: id('b', 7), G: id('b', 8) },
};

interface ILineSpec {
  id: string;
  pos: string;
  type: string;
  desc: string;
  wn?: string | null;
  mn?: string | null;
  unit?: string;
  q: string;
  r: string;
  k?: string | null;
  currency?: string;
  fx?: string;
  materialType?: string | null;
  parent?: string | null;
  conv?: string | null;
  cons?: string | null;
  total?: string;
  comm?: 'work' | 'material' | 'none';
}

const buildTender = (tenderId: string, version: number, usd: string, positions: FakeRow[], specs: ILineSpec[], residual: string): IFakeTender => {
  const items = specs.map((x) => {
    const total = x.total ?? str(mul(mul(dec(x.q), dec(x.r)), dec(x.fx ?? '1')));
    const k = x.k === undefined ? '1' : x.k;
    const comm = k === null || x.comm === 'none' ? null : str(mul(dec(total), dec(k)));
    return fakeItem(tenderId, x.pos, x.id, {
      boq_item_type: x.type,
      material_type: x.materialType ?? null,
      description: x.desc,
      work_name_id: x.wn ?? null,
      material_name_id: x.mn ?? null,
      unit_code: x.unit ?? 'м2',
      quantity: n(x.q),
      base_quantity: n(x.q === '0' ? '1' : x.q),
      unit_rate: n(x.r),
      currency_type: x.currency ?? 'RUB',
      total_amount: n(total),
      commercial_markup: k === null ? null : n(k),
      total_commercial_material_cost: comm !== null && x.comm === 'material' ? n(comm) : x.comm === 'none' || comm === null ? null : n('0'),
      total_commercial_work_cost: comm !== null && x.comm !== 'material' ? n(comm) : x.comm === 'none' || comm === null ? null : n('0'),
      parent_work_item_id: x.parent ?? null,
      conversion_coefficient: x.conv === undefined ? n('1') : x.conv === null ? null : n(x.conv),
      consumption_coefficient: x.cons === undefined ? n('1') : x.cons === null ? null : n(x.cons),
    });
  });
  const num = (v: unknown): string | null => (v && typeof v === 'object' && '__num' in v ? (v as { __num: string }).__num : null);
  const filled = positions.map((p) => {
    const own = items.filter((i) => i.client_position_id === p.id);
    const total = (pick: (i: FakeRow) => string | null) => str(sum(own.map((i) => dec(pick(i) ?? '0'))));
    return {
      ...p,
      items_count: n(String(own.length)),
      base_total: n(total((i) => num(i.total_amount))),
      commercial_total: n(str(sum(own.map((i) => dec(num(i.total_commercial_material_cost) ?? '0').plus(dec(num(i.total_commercial_work_cost) ?? '0')))))),
      material_cost_total: n(total((i) => num(i.total_commercial_material_cost))),
      work_cost_total: n(total((i) => num(i.total_commercial_work_cost))),
    };
  });
  const lines = sum(items.map((i) => dec(num(i.total_commercial_material_cost) ?? '0').plus(dec(num(i.total_commercial_work_cost) ?? '0'))));
  return fakeTender({
    id: tenderId,
    tender_number: E.number,
    title: 'Корпус 10 — экономика',
    version,
    usd_rate: n(usd),
    cached_grand_total: n(str(dec(str(lines)).toDecimalPlaces(2).plus(dec(residual)))),
    positions: filled,
    items,
  });
};

const pos = (tenderId: string, pid: string, number: string, name: string, o: Partial<FakeRow> = {}): FakeRow =>
  fakePosition(tenderId, pid, { position_number: n(number), item_no: number, work_name: name, unit_code: 'м2', volume: n('100'), manual_volume: n('100'), ...o });

// Светильники: одинаковые строки в обеих версиях (новые uuid), отклонения от ограничений источника.
const lampLines = (pid: string, base: string, k0: number): ILineSpec[] => [
  { id: id(base, k0), pos: pid, type: 'раб', desc: 'Монтаж светильников', wn: 'w-lamp', unit: 'шт', q: '10', r: '50' },
  { id: id(base, k0 + 1), pos: pid, type: 'мат', materialType: 'основн.', desc: 'Светильник LED', mn: 'm-lamp', unit: 'шт', q: '25', r: '10', parent: id(base, k0), conv: '2', cons: '1', comm: 'material' },
  { id: id(base, k0 + 2), pos: pid, type: 'мат', desc: 'Кронштейн', mn: 'm-bracket', unit: 'шт', q: '0', r: '50', comm: 'none' },
  { id: id(base, k0 + 3), pos: pid, type: 'прочее', desc: 'Пусконаладка', unit: 'усл', q: '1', r: '5', total: '5' },
  { id: id(base, k0 + 4), pos: pid, type: 'суб-раб', desc: 'Согласованная скидка', wn: 'w-discount', unit: 'усл', q: '1', r: '-100' },
];

// plasterQty — количество штукатурки: вторая выгрузка той же версии с другим количеством даёт новую ревизию того же тендера.
export const v1Tender = (plasterQty = '100'): IFakeTender => {
  const t = E.v1;
  return buildTender(
    t,
    1,
    '90',
    [
      pos(t, E.p.s0, '1', 'Раздел 1', { is_section: true, item_no: null, unit_code: null, volume: null, manual_volume: null }),
      pos(t, E.p.A, '1.1', 'Штукатурка стен'),
      pos(t, E.p.B, '1.2', 'Кладка стен', { unit_code: 'м3' }),
      pos(t, E.p.C, '2.1', 'Стяжка пола', { item_no: null }),
      pos(t, E.p.D, '2.2', 'Стяжка пола', { item_no: null }),
      pos(t, E.p.E, '3', 'Вывоз мусора', { unit_code: 'т' }),
      pos(t, E.p.F, '4', 'Светильники', { unit_code: 'шт', manual_volume: null }),
    ],
    [
      { id: id('c', 1), pos: E.p.A, type: 'раб', desc: 'Штукатурка стен', wn: 'w-plaster', q: plasterQty, r: '10', k: '1.2' },
      { id: id('c', 2), pos: E.p.B, type: 'раб', desc: 'Кладка наружная', wn: 'w-out', unit: 'м3', q: '10', r: '100' },
      { id: id('c', 3), pos: E.p.B, type: 'раб', desc: 'Кладка внутренняя', wn: 'w-in', unit: 'м3', q: '20', r: '100' },
      { id: id('c', 4), pos: E.p.C, type: 'раб', desc: 'Стяжка цементная', wn: 'w-screed', q: '50', r: '20' },
      { id: id('c', 5), pos: E.p.D, type: 'раб', desc: 'Стяжка цементная', wn: 'w-screed', q: '50', r: '20' },
      { id: id('c', 6), pos: E.p.E, type: 'суб-раб', desc: 'Вывоз мусора', wn: 'w-waste', unit: 'т', q: '10', r: '2', currency: 'USD', fx: '90' },
      ...lampLines(E.p.F, 'c', 7),
    ],
    '15.5',
  );
};

export const v2Tender = (): IFakeTender => {
  const t = E.v2;
  return buildTender(
    t,
    2,
    '100',
    [
      pos(t, E.q.s0, '1', 'Раздел 1', { is_section: true, item_no: null, unit_code: null, volume: null, manual_volume: null }),
      pos(t, E.q.A, '1.1', 'Штукатурка стен', { volume: n('110'), manual_volume: n('110') }),
      pos(t, E.q.B1, '1.2', 'Кладка наружных стен', { item_no: '1.2.1', unit_code: 'м3' }),
      pos(t, E.q.B2, '1.3', 'Кладка внутренних стен', { item_no: '1.2.2', unit_code: 'м3' }),
      pos(t, E.q.C, '2.1', 'Стяжка пола', { item_no: null }),
      pos(t, E.q.D, '2.2', 'Стяжка пола', { item_no: null }),
      pos(t, E.q.E, '3', 'Вывоз мусора', { unit_code: 'т' }),
      pos(t, E.q.F, '4', 'Светильники', { unit_code: 'шт', manual_volume: null }),
      pos(t, E.q.G, '5', 'Окраска фасада'),
    ],
    [
      { id: id('d', 1), pos: E.q.A, type: 'раб', desc: 'Штукатурка стен', wn: 'w-plaster', q: '110', r: '12', k: '1.25' },
      { id: id('d', 2), pos: E.q.B1, type: 'раб', desc: 'Кладка наружная', wn: 'w-out', unit: 'м3', q: '12', r: '100' },
      { id: id('d', 3), pos: E.q.B2, type: 'раб', desc: 'Кладка внутренняя', wn: 'w-in', unit: 'м3', q: '20', r: '110' },
      { id: id('d', 4), pos: E.q.C, type: 'раб', desc: 'Стяжка цементная', wn: 'w-screed', q: '50', r: '22' },
      { id: id('d', 5), pos: E.q.D, type: 'раб', desc: 'Стяжка цементная', wn: 'w-screed', q: '50', r: '20' },
      { id: id('d', 6), pos: E.q.E, type: 'суб-раб', desc: 'Вывоз мусора', wn: 'w-waste', unit: 'т', q: '10', r: '2', currency: 'USD', fx: '100' },
      ...lampLines(E.q.F, 'd', 7),
      { id: id('d', 20), pos: E.q.G, type: 'раб', desc: 'Окраска фасада', wn: 'w-paint', q: '5', r: '40' },
    ],
    '20',
  );
};

export interface IEcon {
  db: ITestDb;
  config: IAppConfig;
  s: IScenario;
  hub: IFakeTenderHub;
  worker: WorkerRuntime;
  boss: TestClient;
  app: ReturnType<typeof makeApp>;
  rev1: string;
  rev2: string;
}

export const buildEcon = async (db: ITestDb, base: IAppConfig, o: { chat?: IModelGatewayChat | null; instanceId?: string | null } = {}): Promise<IEcon> => {
  const hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.tenders.set(E.v1, v1Tender());
  hub.tenders.set(E.v2, v2Tender());
  const config = tenderHubConfig(base, hub, { instanceId: o.instanceId ?? null });
  await new BlobStore(config.storageRoot).ensureDirs();
  const app = makeApp(db, undefined, config);
  const s = await buildScenario(db, app);
  const worker = workerWithChat(db, config, o.chat === undefined ? fakeModel() : o.chat, 'test-worker-10');
  const boss = await adminMember(db, s, app, s.tenderA);
  await linkSource(boss, s.stageA, E.v1, 1);
  const c1 = await captureNow(db, worker, s.eng1, s.stageA);
  expect(c1.status, JSON.stringify(c1.failure)).toBe('complete');
  await linkSource(boss, s.stageA, E.v2, 2);
  const c2 = await captureNow(db, worker, s.eng1, s.stageA);
  expect(c2.status, JSON.stringify(c2.failure)).toBe('complete');
  return { db, config, s, hub, worker, boss, app, rev1: c1.revisionId as string, rev2: c2.revisionId as string };
};

export const closeEcon = async (e: IEcon | undefined): Promise<void> => {
  await e?.hub.close();
};

export const compare = async (client: TestClient, stageId: string, left: string, right: string, headers: Record<string, string> = idem()) => {
  const r = await client.post(`/stages/${stageId}/comparisons`, { leftRevisionId: left, rightRevisionId: right }, { headers });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string; status: string; failureReason: string | null; totals: Record<string, { left: string; right: string; delta: string; targetKind: string }>; proposals: { systemConfirmed: number; proposed: number; ambiguous: number } };
};

export interface IUnitView {
  id: string;
  unitNo: number;
  kind: string;
  leftPositions: string[];
  rightPositions: string[];
  title: string;
  cost: { left: string; right: string; comparable: boolean; reason: string | null };
  commercial: { left: string; right: string; comparable: boolean; reason: string | null };
  effects: { measure: string; component: string; amount: string }[];
  explanation: { reasonKind: string; reasonStatus: string; rationale: string | null; restricted: boolean; basisChanged: boolean; bases: { fragmentId: string | null; text: string | null }[] } | null;
  explanationVersion: number;
  suggestions: { id: string; status: string; reasonKind: string; rationale: string | null; restricted: boolean; rowVersion: number; evidence: { fragmentId: string }[] }[];
}

export const units = async (client: TestClient, comparisonId: string): Promise<IUnitView[]> => {
  const out: IUnitView[] = [];
  let after = 0;
  for (;;) {
    const r = await client.get(`/comparisons/${comparisonId}/units?limit=200&after=${after}`);
    expect(r.status, r.text).toBe(200);
    out.push(...(r.body.items as IUnitView[]));
    if (!r.body.hasMore) return out;
    after = r.body.nextAfter;
  }
};

export const effectMap = (u: IUnitView, measure: 'cost' | 'commercial') => Object.fromEntries(u.effects.filter((e) => e.measure === measure).map((e) => [e.component, e.amount]));

export const unitOf = (list: IUnitView[], rightPosition: string) => list.find((u) => u.rightPositions.includes(rightPosition))!;

export const lineageOf = async (client: TestClient, comparisonId: string) => {
  const r = await client.get(`/comparisons/${comparisonId}/lineage`);
  expect(r.status, r.text).toBe(200);
  return { body: r.body as { version: number; items: { fromPositionId: string; toPositionId: string; method: string; status: string; decidedBySystem: boolean; decidedBy: string | null }[]; ambiguous: unknown[] }, etag: r.headers.etag as string };
};

export const decide = (client: TestClient, comparisonId: string, etag: string, decisions: { fromPositionId: string; toPositionId: string; status: 'confirmed' | 'rejected' }[]) =>
  client.post(`/comparisons/${comparisonId}/lineage-decisions`, { decisions }, { headers: { 'If-Match': etag } });
