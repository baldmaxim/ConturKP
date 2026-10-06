// Регрессии Review 10-1 (docs/reviews/10-review-1.md). На коде 2424ad8 тесты R10-01 и R10-02 падают; контрольные
// сценарии (текущее основание, неизменная единица) проходят и до, и после исправления.
// R10-01: новая действующая причина по уже заменённому основанию (новая редакция документа, новое распознавание той же
// редакции) отвергается — и когда событие уже обработано, и когда ещё нет; вторая линия — прямая запись в БД.
// R10-02: строка с тем же UUID в другой единице не раскладывается на «объём» и «цену»: пересчёт единиц не подтверждён,
// дельта пары — «без разложения» с причиной; при неизменной единице метод D-030 работает как прежде.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareRevisions, dec, mul, str, type ICompareSide, type IComparePosition, type ILineInput } from '../packages/core/src/index.ts';
import { captureNow, linkSource } from './calculationFixtures.ts';
import { buildEcon, closeEcon, compare, decide, E, lineageOf, unitOf, units, v1Tender, type IEcon } from './economicsFixtures.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

const TXT = 'Штукатурка стен: площадь увеличена до 110 м2, расценка штукатурки изменена.';

let db: ITestDb;
let e: IEcon;
let unitA = '';
const frag: Record<string, string> = {};
const rev: Record<string, string> = {};

const processEvents = async () => {
  await e.worker.maintain({ checkModel: false });
  await drain(e.worker);
};

const put = (version: number, fragmentIds: string[], reasonStatus: 'confirmed' | 'hypothesis' = 'confirmed') =>
  e.s.eng1.put(
    `/comparison-units/${unitA}/explanation`,
    { reasonKind: 'document', reasonStatus, rationale: 'площадь изменена по ТЗ', fragmentIds, decisionIds: [] },
    { headers: { 'If-Match': `"${unitA}:${version}"` } },
  );

const versionNow = async (): Promise<number> =>
  (await db.pool.query<{ v: number }>('SELECT coalesce(max(version), 0)::int AS v FROM change_explanation WHERE unit_id = $1', [unitA])).rows[0]!.v;

const history = async () => {
  const r = await e.s.eng1.get(`/comparison-units/${unitA}/explanations`);
  expect(r.status, r.text).toBe(200);
  return r.body.items as { version: number; reasonStatus: string; basisChanged: boolean; bases: { fragmentId: string | null }[] }[];
};

beforeAll(async () => {
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
  rev.r1 = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
  const run1 = await seedEvidenceRun(db.pool, rev.r1, { pages: [{ blocks: [TXT] }] });
  frag.r1 = await fragmentIdOf(db.pool, run1, TXT);
  await setWorkingSet(e.s.manager, e.s.stageA, [rev.r1], true);
  await fixScope(e.s.manager, e.s.stageA);
  await processEvents();
  const first = await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2);
  const { body, etag } = await lineageOf(e.s.eng1, first.id);
  const ok = await decide(e.s.eng1, first.id, etag, body.items.map((i) => ({ fromPositionId: i.fromPositionId, toPositionId: i.toPositionId, status: 'confirmed' as const })));
  expect(ok.status, ok.text).toBe(201);
  const cmp = await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2);
  unitA = unitOf(await units(e.s.eng1, cmp.id), E.q.A).id;
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});

describe('R10-01 — новая причина по уже заменённому основанию', () => {
  it('контроль: подтверждение по текущему фрагменту актуального снимка разрешено', async () => {
    const r = await put(0, [frag.r1!]);
    expect(r.status, r.text).toBe(200);
    expect(r.body.explanation).toMatchObject({ reasonStatus: 'confirmed', basisChanged: false });
  });

  it('новая редакция документа, событие обработано заранее: подтверждение и гипотеза по старой цитате — 409, ничего не записано, история сохранена', async () => {
    rev.r2 = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
    expect((await db.pool.query('SELECT supersedes_revision_id FROM document_revision WHERE id = $1', [rev.r2])).rows[0].supersedes_revision_id).toBe(rev.r1);
    await processEvents();
    const r = await put(await versionNow(), [frag.r1!]);
    expect(r.status, r.text).toBe(409);
    expect(r.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ fragmentId: frag.r1, cause: 'document_revision_superseded' })] });
    expect((await put(await versionNow(), [frag.r1!], 'hypothesis')).status).toBe(409);
    const h = await history();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ version: 1, reasonStatus: 'confirmed', basisChanged: true, bases: [expect.objectContaining({ fragmentId: frag.r1 })] });
  });

  it('новое распознавание той же редакции: старый фрагмент отвергается до и после обработки события; текущий — принимается', async () => {
    const run2 = await seedEvidenceRun(db.pool, rev.r2!, { pages: [{ blocks: [TXT] }] });
    frag.r2 = await fragmentIdOf(db.pool, run2, TXT);
    await setWorkingSet(e.s.manager, e.s.stageA, [rev.r2!], true);
    await fixScope(e.s.manager, e.s.stageA);
    await processEvents();
    const fresh = await put(await versionNow(), [frag.r2!]);
    expect(fresh.status, fresh.text).toBe(200);
    // Прогон run2 заменён новым распознаванием той же редакции; событие ещё не обработано.
    await seedEvidenceRun(db.pool, rev.r2!, { pages: [{ blocks: [TXT] }] });
    const kept = await versionNow();
    const before = await put(kept, [frag.r2!]);
    expect(before.status, before.text).toBe(409);
    expect(before.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ fragmentId: frag.r2, cause: 'recognition_run_superseded' })] });
    await processEvents();
    const after = await put(kept, [frag.r2!]);
    expect(after.status).toBe(409);
    expect(await versionNow()).toBe(kept);
    expect((await history())[0]).toMatchObject({ version: kept, reasonStatus: 'confirmed', bases: [expect.objectContaining({ fragmentId: frag.r2 })] });
  });

  it('вторая линия: прямая запись причины по заменённому основанию в обход API отвергается, действующей причины не остаётся', async () => {
    await processEvents();
    const kept = await versionNow();
    const write = async (fragmentId: string) => {
      const c: pg.PoolClient = await db.pool.connect();
      try {
        await c.query('BEGIN');
        const v = (await c.query<{ v: number }>('SELECT coalesce(max(version), 0)::int + 1 AS v FROM change_explanation WHERE unit_id = $1', [unitA])).rows[0]!.v;
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO change_explanation (tender_id, comparison_id, unit_id, version, reason_kind, reason_status, rationale, actor_user_id)
             SELECT c.tender_id, u.comparison_id, u.id, $2, 'document', 'confirmed', 'в обход API', $3
               FROM comparison_unit u JOIN calculation_comparison c ON c.id = u.comparison_id WHERE u.id = $1
             RETURNING id`,
            [unitA, v, e.s.ids.eng1],
          )
        ).rows[0]!.id;
        await c.query("INSERT INTO change_explanation_basis (explanation_id, tender_id, basis_type, fragment_id) VALUES ($1, $2, 'fragment', $3)", [id, e.s.tenderA, fragmentId]);
        await c.query('COMMIT');
        return null;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        return err as { code?: string; message?: string };
      } finally {
        c.release();
      }
    };
    for (const f of [frag.r1!, frag.r2!]) {
      const err = await write(f);
      expect(err, 'запись должна быть отвергнута').not.toBeNull();
      expect(`${err!.code} ${err!.message}`).toMatch(/23514.*основание заменено/u);
    }
    expect(await versionNow()).toBe(kept);
    expect((await history())[0]).toMatchObject({ version: kept, bases: [expect.objectContaining({ fragmentId: frag.r2 })] });
  });
});

describe('R10-01 — исключение из состава источников', () => {
  it('редакция, исключённая из состава источников этапа: новая причина по её фрагменту — 409; возвращённая в состав — принимается', async () => {
    const note = 'Письмо подрядчика: площадь штукатурки уточнена по обмерам.';
    const x1 = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'Обмеры.pdf');
    frag.x = await fragmentIdOf(db.pool, await seedEvidenceRun(db.pool, x1, { pages: [{ blocks: [note] }] }), note);
    await setWorkingSet(e.s.manager, e.s.stageA, [rev.r2!, x1], true);
    await fixScope(e.s.manager, e.s.stageA);
    await setWorkingSet(e.s.manager, e.s.stageA, [rev.r2!], true);
    await processEvents();
    const r = await put(await versionNow(), [frag.x]);
    expect(r.status, r.text).toBe(409);
    expect(r.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ fragmentId: frag.x, cause: 'excluded_from_source_set' })] });
    await setWorkingSet(e.s.manager, e.s.stageA, [rev.r2!, x1], true);
    await processEvents();
    const back = await put(await versionNow(), [frag.x]);
    expect(back.status, back.text).toBe(200);
  });
});

// ---------------------------------------------------------------- R10-02, ядро

const line = (id: string, pos: string, unit: string, q: string, r: string, total: string, o: Partial<ILineInput> = {}): ILineInput => ({
  externalItemId: id,
  externalPositionId: pos,
  itemType: 'раб',
  materialType: null,
  unitCode: unit,
  description: 'Монтаж',
  workNameId: `w-${id}`,
  materialNameId: null,
  detailCostCategoryId: null,
  parentWorkExternalItemId: null,
  quantity: q,
  consumptionCoefficient: null,
  conversionCoefficient: null,
  unitRate: r,
  currency: 'RUB',
  deliveryPriceType: null,
  deliveryAmount: null,
  totalAmount: total,
  commercialMarkup: '1.2',
  totalCommercialMaterial: '0',
  totalCommercialWork: str(mul(dec(total), dec('1.2'))),
  ...o,
});
const position: IComparePosition = { externalPositionId: 'p', positionNumber: '1', itemNo: '1', workName: 'Монтаж', unitCode: 'м', isAdditional: false, isSection: false, manualVolume: null };
const side = (revisionId: string, lines: ILineInput[]): ICompareSide => ({ revisionId, contentHash: `h-${revisionId}`, grandTotal: null, rates: { USD: null, EUR: null, CNY: null }, positions: [position], lines });
const run = (left: ILineInput[], right: ILineInput[]) => compareRevisions(side('a', left), side('b', right), [{ lineageId: 'x', from: 'p', to: 'p' }]);
const effects = (r: ReturnType<typeof compareRevisions>, measure: 'cost' | 'commercial') =>
  Object.fromEntries(r.effects.filter((x) => x.measure === measure && x.unitNo === 1).map((x) => [x.component, str(x.amount)]));

describe('R10-02 — смена единицы строки при том же UUID (ядро)', () => {
  it('1 м × 100 → 1000 мм × 0,1: вкладов «объём» и «цена» нет; пара — «без разложения» с причиной смены единицы', () => {
    const r = run([line('l1', 'p', 'м', '1', '100', '100')], [line('l1', 'p', 'мм', '1000', '0.1', '100')]);
    expect(effects(r, 'cost')).toEqual({ not_decomposable: '0' });
    expect(effects(r, 'commercial')).toEqual({ not_decomposable: '0' });
    const e0 = r.effects.find((x) => x.unitNo === 1 && x.measure === 'cost')!;
    expect(e0.lineRefs).toMatchObject({ left: ['l1'], right: ['l1'], notes: [{ left: 'l1', right: 'l1', reason: 'unit_changed', fromUnit: 'м', toUnit: 'мм' }] });
    expect(r.units[0]!.cost).toMatchObject({ comparable: true });
  });

  it('смена единицы с изменением суммы: вся дельта пары — «без разложения», соседняя строка той же единицы раскладывается; Σ = Δ', () => {
    const r = run(
      [line('l1', 'p', 'м', '1', '100', '100'), line('l2', 'p', 'м', '1', '100', '100')],
      [line('l1', 'p', 'мм', '1000', '0.12', '120'), line('l2', 'p', 'м', '2', '110', '220')],
    );
    expect(effects(r, 'cost')).toEqual({ volume: '100', unit_rate: '20', not_decomposable: '20' });
    expect(r.effects.filter((x) => x.unitNo === 1 && x.measure === 'cost').reduce((a, x) => a + Number(x.amount), 0)).toBe(140);
  });

  it('контроль: неизменная единица 1 м × 100 → 2 м × 110 — объём +100, цена +20 (метод D-030)', () => {
    const r = run([line('l1', 'p', 'м', '1', '100', '100')], [line('l1', 'p', 'м', '2', '110', '220')]);
    expect(effects(r, 'cost')).toEqual({ volume: '100', unit_rate: '20' });
    expect(effects(r, 'commercial')).toEqual({ volume: '120', unit_rate: '24' });
  });
});

// ---------------------------------------------------------------- R10-02, выгрузка → API → сохранённые вклады

describe('R10-02 — смена единицы через выгрузку и API', () => {
  it('100 м2 × 10 → 1 000 000 см2 × 0,001 (суммы 1000 и 1200 те же): сохранённых вкладов «объём» и «цена» нет, причина видна', async () => {
    const st = await e.s.manager.post(`/tenders/${e.s.tenderA}/stages`, { title: 'R10-02' }, { headers: idem() });
    expect(st.status, st.text).toBe(201);
    const stageId = st.body.id as string;
    e.hub.tenders.set(E.v1, v1Tender('100'));
    await linkSource(e.boss, stageId, E.v1, 1);
    const c1 = await captureNow(db, e.worker, e.s.eng1, stageId);
    e.hub.tenders.set(E.v1, v1Tender('1000000', { unit: 'см2', rate: '0.001' }));
    const c2 = await captureNow(db, e.worker, e.s.eng1, stageId);
    expect([c1.status, c2.status]).toEqual(['complete', 'complete']);
    const first = await compare(e.s.eng1, stageId, c1.revisionId as string, c2.revisionId as string);
    const { body, etag } = await lineageOf(e.s.eng1, first.id);
    const ok = await decide(e.s.eng1, first.id, etag, body.items.map((i) => ({ fromPositionId: i.fromPositionId, toPositionId: i.toPositionId, status: 'confirmed' as const })));
    expect(ok.status, ok.text).toBe(201);
    const cmp = await compare(e.s.eng1, stageId, c1.revisionId as string, c2.revisionId as string);
    expect(cmp.status).toBe('ready');
    const A = unitOf(await units(e.s.eng1, cmp.id), E.p.A);
    expect(A.cost).toMatchObject({ left: '1000', right: '1000', comparable: true });
    expect(A.commercial).toMatchObject({ left: '1200', right: '1200', comparable: true });
    const view = A.effects as { measure: string; component: string; amount: string; lineRefs: { notes?: { reason: string; fromUnit: string | null; toUnit: string | null }[] } }[];
    expect(view.map((x) => [x.measure, x.component, x.amount])).toEqual([
      ['cost', 'not_decomposable', '0'],
      ['commercial', 'not_decomposable', '0'],
    ]);
    expect(view.every((x) => x.lineRefs.notes?.[0]?.reason === 'unit_changed' && x.lineRefs.notes[0].fromUnit === 'м2' && x.lineRefs.notes[0].toUnit === 'см2')).toBe(true);
    const saved = await db.pool.query<{ component: string }>("SELECT component FROM comparison_effect WHERE unit_id = $1 AND component IN ('volume', 'unit_rate')", [A.id]);
    expect(saved.rows).toEqual([]);
    // Исходные количества, цены и единицы ревизий не изменены.
    const src = await e.s.eng1.get(`/calculation-revisions/${c2.revisionId}/lines?positionId=${E.p.A}`);
    expect(src.status, src.text).toBe(200);
    expect(src.body.items[0]).toMatchObject({ unitCode: 'см2', quantity: '1000000', unitRate: { amount: '0.001' } });
  });
});
