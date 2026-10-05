// Этап 10: отчёт ревизии, сравнение двух ревизий, решения по парам позиций и причины изменений вручную (D-030;
// проект §4, §5, §7). Поддельный TenderHub — VERIFIED_FIXTURE; эталоны — в economicsFixtures.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureNow } from './calculationFixtures.ts';
import { buildEcon, closeEcon, compare, decide, E, effectMap, lineageOf, unitOf, units, type IEcon, type IUnitView } from './economicsFixtures.ts';
import { createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';

let db: ITestDb;
let e: IEcon;

beforeAll(async () => {
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});

const linesOf = async (revisionId: string) =>
  (
    await db.pool.query<{ external_item_id: string; total_amount: string; quantity: string }>(
      'SELECT l.external_item_id, l.total_amount::text AS total_amount, l.quantity::text AS quantity FROM calculation_line l JOIN calculation_revision r ON r.content_id = l.content_id WHERE r.id = $1 ORDER BY 1',
      [revisionId],
    )
  ).rows;

describe('отчёт ревизии (§5.5, §5.9; D-030 В-10-1, п. 4, 7, 11)', () => {
  it('суммы — по строкам; остаток отдельно, не итог КП и ничем не объяснён; пересчёт и отклонения — отдельно; исходные суммы не меняются', async () => {
    const before = await linesOf(e.rev1);
    const r = await e.s.eng1.get(`/calculation-revisions/${e.rev1}/economics`);
    expect(r.status, r.text).toBe(200);
    const b = r.body;
    expect(b.totals.cost).toMatchObject({ amount: '8455', currency: 'RUB', vat: 'unknown', priceKind: 'cost' });
    expect(b.totals.commercial).toMatchObject({ amount: '8655', currency: 'RUB', vat: 'unknown', priceKind: 'commercial', source: { derivation: 'derived_from_formula' } });
    expect(b.reconciliation).toMatchObject({ status: 'residual_unconfirmed', tolerance: '0.01', isKpTotal: false, targetKind: 'cached_grand_total' });
    expect(b.reconciliation.target.amount).toBe('8670.5');
    expect(b.reconciliation.residual.amount).toBe('15.5');
    expect(b.reconciliation.note).toMatch(/не объясняется ни страхованием, ни округлением, ни задержкой пересчёта/u);
    expect(b.components).toHaveLength(7);
    expect(b.components.every((c: { status: string }) => c.status === 'unavailable_by_key')).toBe(true);
    expect(b.deviations).toEqual({
      quantity_nonpositive: 1,
      negative_amount: 1,
      unknown_item_type: 1,
      missing_commercial: 1,
      missing_fx_rate: 0,
      bound_quantity_mismatch: 1,
      recompute_outside_tolerance: 0,
    });
    expect(b.lineCheck).toMatchObject({ lines: 11, within: 10, outside: 0, notApplicable: 1, tolerance: { relative: '0.000000001', absolute: '0.000001' } });
    expect(b.rates).toMatchObject({ USD: '90' });
    expect(b.rates.observedAt).toEqual(expect.any(String));
    expect(b.rates.note).toMatch(/дата наблюдения/u);
    expect(b.linesWithoutCommercial.lines).toBe(1);
    expect(b.positionsUnitPriceUndefined).toBe(1);
    expect(b.foreignCurrency).toEqual([expect.objectContaining({ currency: 'USD', lines: 1 })]);
    // Отчёт пишется один раз и далее неизменен; полученные суммы строк не тронуты.
    const again = await e.s.manager.get(`/calculation-revisions/${e.rev1}/economics`);
    expect(again.body.computedAt).toBe(b.computedAt);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM revision_economics WHERE revision_id = $1', [e.rev1])).rows[0].n).toBe(1);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM revision_line_check c JOIN revision_economics x ON x.id = c.economics_id WHERE x.revision_id = $1', [e.rev1])).rows[0].n).toBe(11);
    expect(await linesOf(e.rev1)).toEqual(before);
    // Выведенное количество привязанного материала — диагностика: показано отдельно, хранимое количество — прежнее.
    const dev = await e.s.eng1.get(`/calculation-revisions/${e.rev1}/economics/deviations?flag=bound_quantity_mismatch`);
    expect(dev.status, dev.text).toBe(200);
    expect(dev.body.items).toEqual([expect.objectContaining({ quantity: '25', derivedQuantity: '20', flags: ['bound_quantity_mismatch'] })]);
    const zero = await e.s.eng1.get(`/calculation-revisions/${e.rev1}/economics/deviations?flag=quantity_nonpositive`);
    expect(zero.body.items).toEqual([expect.objectContaining({ quantity: '0', flags: expect.arrayContaining(['quantity_nonpositive', 'missing_commercial']) })]);
  });

  it('API ревизии: колонки КП — коммерческие суммы в RUB, курс с датой наблюдения', async () => {
    const r = await e.s.eng1.get(`/calculation-revisions/${e.rev1}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.source.fxRatesObservedAt).toEqual(expect.any(String));
    expect(r.body.source.grandTotal).toMatchObject({ currency: 'RUB', priceKind: 'commercial' });
  });

  it('пользователь вне тендера отчёт не видит', async () => {
    expect((await e.s.eng3.get(`/calculation-revisions/${e.rev1}/economics`)).status).toBe(404);
  });
});

describe('сравнение ревизий (§5.1–5.4; D-030 В-10-2…В-10-5)', () => {
  let firstId = '';
  let secondId = '';
  let list: IUnitView[] = [];

  it('пары по ключам — только предложения; без подтверждённых пар позиции «удалены» и «добавлены»; Σ = Δ', async () => {
    const first = await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2);
    firstId = first.id;
    expect(first.status).toBe('ready');
    expect(first.proposals).toEqual({ systemConfirmed: 0, proposed: 5, ambiguous: 0 });
    expect(first.totals.cost).toMatchObject({ targetKind: 'lines_sum', left: '8455', right: '9675', delta: '1220' });
    expect(first.totals.commercial).toMatchObject({ targetKind: 'cached_grand_total', left: '8670.5', right: '10025', delta: '1354.5' });
    const all = await units(e.s.eng1, first.id);
    expect(all.filter((u) => u.kind === 'removed')).toHaveLength(6);
    expect(all.filter((u) => u.kind === 'added')).toHaveLength(8);
    const { body } = await lineageOf(e.s.eng1, first.id);
    expect(body.items).toHaveLength(5);
    expect(body.items.every((i) => i.status === 'proposed' && !i.decidedBySystem && i.decidedBy === null)).toBe(true);
    expect(body.items.map((i) => i.method).sort()).toEqual(['exact_key', 'exact_key', 'exact_key', 'position_key', 'position_key']);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM position_lineage l JOIN app_user u ON u.id = l.decided_by WHERE u.kind = 'service'")).rows[0].n).toBe(0);
  });

  it('инженер подтверждает предложения пакетом и задаёт разделение вручную; устаревшая версия — 412; прежнее сравнение «устарело»', async () => {
    const { body, etag } = await lineageOf(e.s.eng1, firstId);
    const decisions = [
      ...body.items.map((i) => ({ fromPositionId: i.fromPositionId, toPositionId: i.toPositionId, status: 'confirmed' as const })),
      { fromPositionId: E.p.B, toPositionId: E.q.B1, status: 'confirmed' as const },
      { fromPositionId: E.p.B, toPositionId: E.q.B2, status: 'confirmed' as const },
    ];
    expect((await decide(e.s.eng1, firstId, `"${firstId}:0"`, decisions)).status).toBe(412);
    expect((await e.s.eng1.post(`/comparisons/${firstId}/lineage-decisions`, { decisions })).status).toBe(428);
    const ok = await decide(e.s.eng1, firstId, etag, decisions);
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.recorded).toBe(7);
    expect((await decide(e.s.eng2, firstId, etag, decisions)).status).toBe(412);
    const after = await lineageOf(e.s.manager, firstId);
    expect(after.body.items.filter((i) => i.status === 'confirmed')).toHaveLength(7);
    const methods = Object.fromEntries(after.body.items.map((i) => [`${i.fromPositionId}>${i.toPositionId}`, i.method]));
    expect(methods[`${E.p.A}>${E.q.A}`]).toBe('exact_key');
    expect(methods[`${E.p.C}>${E.q.C}`]).toBe('position_key');
    expect(methods[`${E.p.B}>${E.q.B1}`]).toBe('manual');
    const view = await e.s.eng1.get(`/comparisons/${firstId}`);
    expect(view.body.outdated).toMatchObject({ value: true, lineageChanged: true });
  });

  it('новое сравнение: вклады по эталонам A20, A22, курс; несопоставимая единица и остаток — отдельными строками уровня тендера; Σ = Δ', async () => {
    const second = await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2);
    secondId = second.id;
    list = await units(e.s.eng1, second.id);
    const A = unitOf(list, E.q.A);
    expect(A.kind).toBe('matched');
    expect(effectMap(A, 'cost')).toEqual({ volume: '100', unit_rate: '220' });
    expect(effectMap(A, 'commercial')).toEqual({ volume: '120', unit_rate: '264', coefficient: '66' });
    const B = unitOf(list, E.q.B1);
    expect(B).toMatchObject({ kind: 'split_merge', leftPositions: [E.p.B] });
    expect(B.rightPositions.sort()).toEqual([E.q.B1, E.q.B2].sort());
    expect(effectMap(B, 'cost')).toEqual({ volume: '200', unit_rate: '200' });
    expect(effectMap(unitOf(list, E.q.C), 'cost')).toEqual({ unit_rate: '100' });
    expect(unitOf(list, E.q.D).effects).toEqual([]);
    expect(effectMap(unitOf(list, E.q.E), 'cost')).toEqual({ fx_rate: '200' });
    const F = unitOf(list, E.q.F);
    expect(F.commercial).toMatchObject({ comparable: false, reason: 'у строки пустая коммерческая стоимость (не 0)' });
    expect(F.effects.filter((x) => x.measure === 'commercial')).toEqual([]);
    expect(effectMap(unitOf(list, E.q.G), 'cost')).toEqual({ composition_added: '200' });
    const v = await e.s.eng1.get(`/comparisons/${second.id}`);
    expect(v.status, v.text).toBe(200);
    const tender = (measure: string, component: string) => v.body.summary.effects.find((x: { measure: string; component: string; level: string }) => x.measure === measure && x.component === component && x.level === 'tender')?.amount;
    expect(tender('commercial', 'unexplained_remainder')).toBe('4.5');
    expect(tender('commercial', 'incomparable_units')).toBe('0');
    expect(tender('cost', 'unexplained_remainder')).toBe('0');
    expect(v.body.method).toMatchObject({ order: ['quantity', 'unit_rate', 'fx_rate', 'delivery', 'coefficient'], jointEffectRule: expect.stringMatching(/более позднему фактору/u) });
    expect(v.body.method.coefficient).toMatch(/изменением НДС не называется/u);
    expect(v.body.outdated.value).toBe(false);
    // Σ вкладов единиц и строк уровня тендера = дельта итога по каждой мере.
    for (const m of ['cost', 'commercial'] as const) {
      const all = v.body.summary.effects.filter((x: { measure: string }) => x.measure === m).reduce((acc: number, x: { amount: string }) => acc + Number(x.amount) * 100, 0);
      expect(Math.round(all)).toBe(Math.round(Number(second.totals[m]!.delta) * 100));
    }
  });

  it('повтор запроса с тем же ключом — то же сравнение; повтор выгрузки без изменений ревизию не создаёт и результат не меняет', async () => {
    const headers = idem();
    const a = await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2, headers);
    const b = await e.s.eng1.post(`/stages/${e.s.stageA}/comparisons`, { leftRevisionId: e.rev1, rightRevisionId: e.rev2 }, { headers });
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const recaptured = await captureNow(db, e.worker, e.s.eng1, e.s.stageA);
    expect(recaptured.revisionId).toBe(e.rev2);
    const sha = async (id: string) => (await e.s.eng1.get(`/comparisons/${id}`)).body.resultSha256 as string;
    const c = await compare(e.s.eng1, e.s.stageA, e.rev1, e.rev2);
    expect(await sha(c.id)).toBe(await sha(secondId));
  });

  it('участник другого тендера этап не видит; сравнение одной и той же ревизии отвергается', async () => {
    expect((await e.s.eng3.post(`/stages/${e.s.stageA}/comparisons`, { leftRevisionId: e.rev1, rightRevisionId: e.rev2 }, { headers: idem() })).status).toBe(404);
    expect((await e.s.eng1.post(`/stages/${e.s.stageA}/comparisons`, { leftRevisionId: e.rev1, rightRevisionId: e.rev1 }, { headers: idem() })).status).toBe(400);
  });

  it('причина вручную: по умолчанию «неизвестно»; «подтверждено» без основания своего вида отвергается; If-Match по версии', async () => {
    const A = unitOf(list, E.q.A);
    expect(A.explanation).toBeNull();
    expect(A.explanationVersion).toBe(0);
    const path = `/comparison-units/${A.id}/explanation`;
    expect((await e.s.eng1.put(path, { reasonKind: 'unknown', reasonStatus: 'unknown' })).status).toBe(428);
    const bad = await e.s.eng1.put(path, { reasonKind: 'document', reasonStatus: 'confirmed', rationale: 'Изменение площади по проекту' }, { headers: { 'If-Match': `"${A.id}:0"` } });
    expect(bad.status, bad.text).toBe(409);
    const hyp = await e.s.eng1.put(path, { reasonKind: 'internal_decision', reasonStatus: 'hypothesis', rationale: 'Предположительно — решение сметчика' }, { headers: { 'If-Match': `"${A.id}:0"` } });
    expect(hyp.status, hyp.text).toBe(200);
    expect(hyp.body.explanation).toMatchObject({ version: 1, reasonKind: 'internal_decision', reasonStatus: 'hypothesis', restricted: false });
    expect((await e.s.eng2.put(path, { reasonKind: 'unknown', reasonStatus: 'unknown' }, { headers: { 'If-Match': `"${A.id}:0"` } })).status).toBe(412);
    const unk = await e.s.eng2.put(path, { reasonKind: 'unknown', reasonStatus: 'unknown' }, { headers: { 'If-Match': hyp.headers.etag as string } });
    expect(unk.status, unk.text).toBe(200);
    const hist = await e.s.eng1.get(`/comparison-units/${A.id}/explanations`);
    expect(hist.body.items.map((x: { version: number; reasonStatus: string }) => [x.version, x.reasonStatus])).toEqual([
      [2, 'unknown'],
      [1, 'hypothesis'],
    ]);
  });
});
