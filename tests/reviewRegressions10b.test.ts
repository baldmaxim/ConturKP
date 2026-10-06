// Регрессии Review 10-2 (docs/reviews/10-review-2.md). На коде 469a03c тесты R10-03 и R10-04 падают; контрольные
// сценарии (действующий ответ; ненулевая денежная дельта, видимая и до исправления) проходят и до, и после.
// R10-03: заменённая редакция ответа заказчика (qa_item_revision) не принимается основанием новой причины — до и после
// обработки события, через API и прямой записью в БД; функция актуальности покрывает каждый тип источника фрагмента.
// R10-04: единица со сменой единицы строки видна в списке изменившихся при нулевой и ненулевой денежной дельте;
// неизменные строки (в том числе без курса и с неприменимой формулой) не дают ни вкладов, ни места в этом списке.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareRevisions, dec, mul, str, type ILineInput } from '../packages/core/src/index.ts';
import { captureNow, linkSource } from './calculationFixtures.ts';
import { buildEcon, closeEcon, compare, decide, E, lineageOf, unitOf, units, v1Tender, type IEcon, type IUnitView } from './economicsFixtures.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { postManifest, qaManifest } from './mailFixtures.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

const QUESTION = 'Изменена ли площадь штукатурки?';
const ANSWER_1 = 'Заказчик подтверждает увеличение площади штукатурки до 110 м2.';
const ANSWER_2 = 'Предыдущее разъяснение отменено: площадь штукатурки остаётся 100 м2.';

let db: ITestDb;
let e: IEcon;
let unitA = '';
const frag: Record<string, string> = {};

const processEvents = async () => {
  await e.worker.maintain({ checkModel: false });
  await drain(e.worker);
};

const versionNow = async (): Promise<number> =>
  (await db.pool.query<{ v: number }>('SELECT coalesce(max(version), 0)::int AS v FROM change_explanation WHERE unit_id = $1', [unitA])).rows[0]!.v;

const put = async (fragmentIds: string[]) =>
  e.s.eng1.put(
    `/comparison-units/${unitA}/explanation`,
    { reasonKind: 'answer', reasonStatus: 'confirmed', rationale: 'площадь изменена по ответу заказчика', fragmentIds, decisionIds: [] },
    { headers: { 'If-Match': `"${unitA}:${await versionNow()}"` } },
  );

const answerFragment = async (text: string): Promise<{ id: string; revisionId: string }> => {
  const r = await db.pool.query<{ id: string; revision_id: string }>(
    "SELECT f.id, f.qa_item_revision_id AS revision_id FROM evidence_fragment f WHERE f.origin = 'qa_answer' AND f.text = $1 AND f.tender_id = $2",
    [text, e.s.tenderA],
  );
  expect(r.rows, `фрагмент ответа «${text}»`).toHaveLength(1);
  return { id: r.rows[0]!.id, revisionId: r.rows[0]!.revision_id };
};

beforeAll(async () => {
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
  const doc = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
  await seedEvidenceRun(db.pool, doc, { pages: [{ blocks: ['Штукатурка стен по ТЗ.'] }] });
  const qa = await postManifest(e.s.eng1, e.s.tenderA, 'qa', qaManifest([{ no: '1', question: QUESTION, answer: ANSWER_1 }]));
  expect(qa.status, qa.text).toBe(201);
  frag.qa1 = (await answerFragment(ANSWER_1)).id;
  await setWorkingSet(e.s.manager, e.s.stageA, [doc], true);
  await fixScope(e.s.manager, e.s.stageA);
  await processEvents();
  const first = await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2);
  const { body, etag } = await lineageOf(e.s.eng1, first.id);
  const ok = await decide(e.s.eng1, first.id, etag, body.items.map((i) => ({ fromPositionId: i.fromPositionId, toPositionId: i.toPositionId, status: 'confirmed' as const })));
  expect(ok.status, ok.text).toBe(201);
  unitA = unitOf(await units(e.s.eng1, (await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2)).id), E.q.A).id;
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});

describe('R10-03 — заменённый ответ заказчика', () => {
  it('контроль: подтверждение по действующему ответу разрешено', async () => {
    const r = await put([frag.qa1!]);
    expect(r.status, r.text).toBe(200);
    expect(r.body.explanation).toMatchObject({ reasonKind: 'answer', reasonStatus: 'confirmed', basisChanged: false });
  });

  it('новая редакция ответа: старый ответ — 409 до и после обработки события; новый ответ принимается; история сохранена', async () => {
    const qa = await postManifest(e.s.eng1, e.s.tenderA, 'qa', qaManifest([{ no: '1', question: QUESTION, answer: ANSWER_2 }]));
    expect(qa.status, qa.text).toBe(201);
    const fresh = await answerFragment(ANSWER_2);
    frag.qa2 = fresh.id;
    const old = await answerFragment(ANSWER_1);
    expect((await db.pool.query('SELECT supersedes_revision_id FROM qa_item_revision WHERE id = $1', [fresh.revisionId])).rows[0].supersedes_revision_id).toBe(old.revisionId);
    const kept = await versionNow();
    const before = await put([frag.qa1!]);
    expect(before.status, before.text).toBe(409);
    expect(before.body.current).toMatchObject({ reason: 'basis_superseded', superseded: [expect.objectContaining({ fragmentId: frag.qa1, cause: 'qa_item_revision_superseded' })] });
    await fixScope(e.s.manager, e.s.stageA);
    await processEvents();
    const pending = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM stage_input_event x WHERE x.stage_id = $1 AND NOT EXISTS (SELECT 1 FROM stage_input_event_processing p WHERE p.event_id = x.id)',
      [e.s.stageA],
    );
    expect(pending.rows[0]!.n).toBe(0);
    const after = await put([frag.qa1!]);
    expect(after.status, after.text).toBe(409);
    expect(await versionNow()).toBe(kept);
    const h = (await e.s.eng1.get(`/comparison-units/${unitA}/explanations`)).body.items as { version: number; basisChanged: boolean; bases: { fragmentId: string }[] }[];
    expect(h[0]).toMatchObject({ version: kept, basisChanged: true, bases: [expect.objectContaining({ fragmentId: frag.qa1 })] });
    const ok = await put([frag.qa2]);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.explanation).toMatchObject({ basisChanged: false, bases: [expect.objectContaining({ fragmentId: frag.qa2 })] });
  });

  it('вторая линия: прямая запись причины по заменённому ответу в обход API отвергается (23514), версия не создаётся', async () => {
    const kept = await versionNow();
    const c: pg.PoolClient = await db.pool.connect();
    let err: { code?: string; message?: string } | null = null;
    try {
      await c.query('BEGIN');
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO change_explanation (tender_id, comparison_id, unit_id, version, reason_kind, reason_status, rationale, actor_user_id)
           SELECT c.tender_id, u.comparison_id, u.id, $2, 'answer', 'confirmed', 'в обход API', $3
             FROM comparison_unit u JOIN calculation_comparison c ON c.id = u.comparison_id WHERE u.id = $1 RETURNING id`,
          [unitA, kept + 1, e.s.ids.eng1],
        )
      ).rows[0]!.id;
      await c.query("INSERT INTO change_explanation_basis (explanation_id, tender_id, basis_type, fragment_id) VALUES ($1, $2, 'fragment', $3)", [id, e.s.tenderA, frag.qa1]);
      await c.query('COMMIT');
    } catch (x) {
      err = x as { code?: string; message?: string };
      await c.query('ROLLBACK').catch(() => undefined);
    } finally {
      c.release();
    }
    expect(err, 'запись должна быть отвергнута').not.toBeNull();
    expect(`${err!.code} ${err!.message}`).toMatch(/23514.*основание заменено \(qa_item_revision_superseded\)/u);
    expect(await versionNow()).toBe(kept);
  });

  it('функция актуальности покрывает каждый тип источника фрагмента из ограничения evidence_fragment', async () => {
    const check = await db.pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'evidence_fragment_source_unit_type_check'");
    const types = [...check.rows[0]!.def.matchAll(/'([a-z_]+)'::text/gu)].map((m) => m[1]!);
    expect(types).toEqual(expect.arrayContaining(['recognition_run', 'mail_message_revision', 'transcript_revision', 'qa_item_revision']));
    const fn = (await db.pool.query<{ def: string }>("SELECT pg_get_functiondef('change_basis_supersession'::regproc) AS def")).rows[0]!.def;
    for (const t of types) expect(fn, `ветка замены для ${t}`).toContain(`f.source_unit_type = '${t}'`);
  });
});

// ---------------------------------------------------------------- R10-04

const line = (id: string, type: string, o: Partial<ILineInput> = {}): ILineInput => ({
  externalItemId: id,
  externalPositionId: 'p',
  itemType: type,
  materialType: null,
  unitCode: 'усл',
  description: `строка ${id}`,
  workNameId: `w-${id}`,
  materialNameId: null,
  detailCostCategoryId: null,
  parentWorkExternalItemId: null,
  quantity: '1',
  consumptionCoefficient: null,
  conversionCoefficient: null,
  unitRate: '5',
  currency: 'RUB',
  deliveryPriceType: null,
  deliveryAmount: null,
  totalAmount: '5',
  commercialMarkup: '1.2',
  totalCommercialMaterial: '0',
  totalCommercialWork: str(mul(dec('5'), dec('1.2'))),
  ...o,
});

describe('R10-04 — нулевые вклады только у изменений (ядро)', () => {
  it('неизменные строки с неприменимой формулой и без курса ревизии вкладов не дают', () => {
    const side = (lines: ILineInput[]) => ({
      revisionId: 'a',
      contentHash: 'h',
      grandTotal: null,
      rates: { USD: null, EUR: null, CNY: null },
      positions: [{ externalPositionId: 'p', positionNumber: '1', itemNo: '1', workName: 'Пусконаладка', unitCode: 'усл', isAdditional: false, isSection: false, manualVolume: null }],
      lines,
    });
    const same = [line('a', 'прочее'), line('b', 'раб', { currency: 'USD' })];
    const r = compareRevisions(side(same), side(same), [{ lineageId: 'x', from: 'p', to: 'p' }]);
    expect(r.effects.filter((x) => x.unitNo === 1)).toEqual([]);
  });
});

describe('R10-04 — смена единицы в списке изменившихся', () => {
  const scenario = async (title: string, rate: string) => {
    const st = await e.s.manager.post(`/tenders/${e.s.tenderA}/stages`, { title }, { headers: idem() });
    expect(st.status, st.text).toBe(201);
    const stageId = st.body.id as string;
    e.hub.tenders.set(E.v1, v1Tender('100'));
    await linkSource(e.boss, stageId, E.v1, 1);
    const c1 = await captureNow(db, e.worker, e.s.eng1, stageId);
    e.hub.tenders.set(E.v1, v1Tender('1000000', { unit: 'см2', rate }));
    const c2 = await captureNow(db, e.worker, e.s.eng1, stageId);
    expect([c1.status, c2.status]).toEqual(['complete', 'complete']);
    const first = await compare(e.s.eng1, stageId, c1.revisionId as string, c2.revisionId as string);
    const { body, etag } = await lineageOf(e.s.eng1, first.id);
    const ok = await decide(e.s.eng1, first.id, etag, body.items.map((i) => ({ fromPositionId: i.fromPositionId, toPositionId: i.toPositionId, status: 'confirmed' as const })));
    expect(ok.status, ok.text).toBe(201);
    return (await compare(e.s.eng1, stageId, c1.revisionId as string, c2.revisionId as string)).id;
  };
  // Ожидаемый список изменившихся: позиция со сменой единицы и несопоставимые единицы (неизвестное не скрывается);
  // сопоставимые единицы с равными суммами и без диагностики изменения — вне списка.
  const expectChanged = async (comparisonId: string, list: IUnitView[]) => {
    const all = await units(e.s.eng1, comparisonId);
    const incomparable = (u: IUnitView) => !u.cost.comparable || !u.commercial.comparable;
    expect(list.map((u) => u.id).sort()).toEqual(all.filter((u) => u.leftPositions.includes(E.p.A) || incomparable(u)).map((u) => u.id).sort());
    const plain = all.filter((u) => !u.leftPositions.includes(E.p.A) && !incomparable(u));
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((u) => u.effects.length === 0 && u.cost.left === u.cost.right)).toBe(true);
    return all;
  };
  const changedOnly = async (comparisonId: string): Promise<IUnitView[]> => {
    const r = await e.s.eng1.get(`/comparisons/${comparisonId}/units?changed=true&limit=200`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.hasMore).toBe(false);
    return r.body.items as IUnitView[];
  };

  it('нулевая денежная дельта: позиция со сменой единицы — в changed=true; неизменные позиции — нет и без вкладов', async () => {
    const id = await scenario('R10-04 нулевая дельта', '0.001');
    const list = await changedOnly(id);
    const all = await expectChanged(id, list);
    const A = list.find((u) => u.leftPositions.includes(E.p.A))!;
    expect(A.cost).toMatchObject({ left: '1000', right: '1000' });
    expect(A.effects.map((x) => [x.measure, x.component, x.amount])).toEqual([
      ['cost', 'not_decomposable', '0'],
      ['commercial', 'not_decomposable', '0'],
    ]);
    // Неизменные строки (в том числе с неприменимой формулой) нулевых вкладов не дают.
    expect(all.filter((u) => !u.leftPositions.includes(E.p.A)).every((u) => u.effects.length === 0)).toBe(true);
  });

  it('ненулевая денежная дельта: позиция в changed=true, вся дельта пары — «без разложения» с причиной', async () => {
    const id = await scenario('R10-04 ненулевая дельта', '0.0012');
    const list = await changedOnly(id);
    await expectChanged(id, list);
    const effects = list.find((u) => u.leftPositions.includes(E.p.A))!.effects as { measure: string; component: string; amount: string; lineRefs: { notes?: { reason: string }[] } }[];
    expect(effects.map((x) => [x.measure, x.component, x.amount])).toEqual([
      ['cost', 'not_decomposable', '200'],
      ['commercial', 'not_decomposable', '240'],
    ]);
    expect(effects.every((x) => x.lineRefs.notes?.[0]?.reason === 'unit_changed')).toBe(true);
  });
});
