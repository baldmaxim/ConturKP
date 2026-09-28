// Этап 06: выгрузка расчёта TenderHub против поддельного сервера по контракту (ADR-007 §5–8,
// state-machines §6, RT-04, A07). Настоящий TenderHub не вызывается: это VERIFIED_FIXTURE, не live.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, PRECISE_RATE, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb, type TestClient } from './helpers.ts';

let db: ITestDb;
let s: IScenario;
let hub: IFakeTenderHub;
let worker: WorkerRuntime;
let boss: TestClient;
const base = testConfig();

beforeAll(async () => {
  db = await createTestDb();
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.pageSize = 2;
  hub.tenders.set(TH.tender, standardTender());
  const config = tenderHubConfig(base, hub);
  await new BlobStore(config.storageRoot).ensureDirs();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  worker = makeWorker(db, config);
  boss = await adminMember(db, s, app, s.tenderA);
});
afterAll(async () => {
  await hub.close();
  await db.drop();
});

const revisionsOf = async (stageId: string) => (await s.eng1.get(`/stages/${stageId}/calculation-revisions`)).body.items as { id: string; seq: number; contentHash: string; supersedesRevisionId: string | null }[];

describe('связь этапа с TenderHub (Q-03)', () => {
  it('связь задаёт администратор-участник по If-Match; инженер — 403; без заголовка — 428; устаревший — 412', async () => {
    const cur = await s.eng1.get(`/stages/${s.stageA}/calculation-source`);
    expect(cur.status).toBe(200);
    expect(cur.body.primary).toBeNull();
    expect(cur.headers.etag).toBe(`"${s.stageA}:0"`);
    expect(cur.body.integration).toEqual([expect.objectContaining({ component: 'TenderHubRevisionReader', status: 'BLOCKED_EXTERNAL', blockedBy: 'X-01' })]);
    const byEngineer = await s.eng1.put(`/stages/${s.stageA}/calculation-source`, { externalTenderId: TH.tender }, { headers: { 'If-Match': cur.headers.etag as string } });
    expect(byEngineer.status).toBe(403);
    expect((await boss.put(`/stages/${s.stageA}/calculation-source`, { externalTenderId: TH.tender })).status).toBe(428);
    const linked = await linkSource(boss, s.stageA, TH.tender, 3);
    expect(linked.body.primary).toMatchObject({ externalTenderId: TH.tender, externalVersion: 3, role: 'primary' });
    const stale = await boss.put(`/stages/${s.stageA}/calculation-source`, { externalTenderId: TH.tender }, { headers: { 'If-Match': cur.headers.etag as string } });
    expect(stale.status).toBe(412);
    // Посторонний тендеру не видит ни этапа, ни связи.
    expect((await s.eng3.get(`/stages/${s.stageA}/calculation-source`)).status).toBe(404);
  });
});

describe('выгрузка portal_capture → ревизия provisional (ADR-007 §5)', () => {
  it('полная выгрузка: все страницы позиций, X-API-Key без Bearer, gzip, with-costs без кэша; ревизия provisional и событие барьера', async () => {
    const eventsBefore = (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stage_input_event WHERE stage_id = $1', [s.stageA])).rows[0]!.n;
    hub.requests.length = 0;
    const cap = await captureNow(db, worker, s.eng1, s.stageA);
    expect(cap).toMatchObject({ status: 'complete', captureKind: 'portal_capture', transport: 'api', trigger: 'manual', failure: null });
    expect(cap.consistency.outcome).toBe('consistent');
    expect(cap.sourceObserved).toMatchObject({ tenderNumber: 'TH-2026-001', version: 3, briefFound: true, submissionDeadline: '2026-10-15T09:00:00.000Z' });
    // Ключ — только в X-API-Key; Authorization не отправляется (README TenderHub: ошибка №1).
    expect(hub.requests.every((r) => r.apiKey === TH_KEY && r.authorization === undefined && /gzip/u.test(r.acceptEncoding ?? ''))).toBe(true);
    const paths = hub.requests.map((r) => r.path);
    // 4 позиции при странице 2 — две страницы по курсору; одна страница полным расчётом не считается.
    expect(paths.filter((p) => p.includes('/positions?'))).toHaveLength(2);
    expect(paths.filter((p) => p.includes('cursor='))).toHaveLength(1);
    expect(hub.requests.find((r) => r.path.endsWith('/positions/with-costs'))!.cacheControl).toBe('no-cache');
    expect(paths.filter((p) => p.endsWith('/overview'))).toHaveLength(2);

    const revs = await revisionsOf(s.stageA);
    expect(revs).toHaveLength(1);
    const rev = (await s.eng1.get(`/calculation-revisions/${cap.revisionId}`)).body;
    expect(rev).toMatchObject({ seq: 1, kind: 'provisional', externalTenderId: TH.tender, externalVersion: 3, externalRevisionRef: null, counts: { positions: 4, lines: 3 } });
    // Итог КП не выводится (Q-05); cached_grand_total — значение источника.
    expect(rev.kpTotal).toMatchObject({ value: null, rule: null, semantics: { status: 'rule_not_set', question: 'Q-05' } });
    expect(rev.source.grandTotal).toMatchObject({ amount: '1860.9', currency: 'UNKNOWN', vat: 'unknown', priceKind: 'commercial' });
    expect(rev.source.fxRates).toEqual({ USD: '90.5', EUR: '99.25', CNY: '12.75' });
    // Production gate: боевой выпуск с provisional-ревизией заблокирован.
    expect(rev.productionGate).toEqual({ mode: 'production', allowed: false, blockers: ['CALCULATION_PROVISIONAL'] });
    expect(rev.closureAvailable).toBe(false);
    expect(rev.sourceStatus).toEqual([]);
    // Событие барьера актуальности — одно на новую ревизию (state-machines §1.1).
    const events = await db.pool.query<{ event_type: string; event_class: string; ref_id: string }>(
      'SELECT event_type, event_class, ref_id FROM stage_input_event WHERE stage_id = $1 ORDER BY seq',
      [s.stageA],
    );
    expect(events.rows.length).toBe(eventsBefore + 1);
    expect(events.rows[events.rows.length - 1]).toEqual({ event_type: 'calculation_revision_added', event_class: 'calculation', ref_id: cap.revisionId });
  });

  it('сырые ответы и манифест лежат в хранилище по SHA-256 с версией контракта', async () => {
    const caps = (await s.eng1.get(`/stages/${s.stageA}/calculation-captures`)).body.items;
    const cap = caps[0];
    expect(cap.contractVersion).toBe('th-api-2026-09-02/adapter-1');
    const blob = await db.pool.query<{ size_bytes: number }>('SELECT size_bytes FROM blob WHERE sha256 = $1', [cap.rawBundleSha256]);
    expect(blob.rows).toHaveLength(1);
    const { readFile } = await import('node:fs/promises');
    const store = new BlobStore(base.storageRoot);
    const manifest = JSON.parse(await readFile(store.pathOf(cap.rawBundleSha256), 'utf8')) as { contractVersion: string; responses: { route: string; sha256: string; status: number }[] };
    expect(manifest.contractVersion).toBe('th-api-2026-09-02/adapter-1');
    expect(manifest.responses.map((r) => r.route)).toEqual(['overview', 'brief', 'positions', 'positions', 'positions_with_costs', 'boq_items_full', 'overview']);
    const boqRaw = await readFile(store.pathOf(manifest.responses.find((r) => r.route === 'boq_items_full')!.sha256), 'utf8');
    // Сырой ответ — ровно текст источника: лексема цены с 21 значащей цифрой сохранена.
    expect(boqRaw).toContain(`"unit_rate":${PRECISE_RATE}`);
    // Ключ в сохранённых данных не встречается.
    expect(JSON.stringify(manifest)).not.toContain(TH_KEY);
  });

  it('позиции: раздел — не работа, пустая и ДОП позиции сохранены, manual_volume без семантики, категория позиции строкам не присвоена', async () => {
    const rev = (await revisionsOf(s.stageA))[0]!;
    const page1 = await s.eng1.get(`/calculation-revisions/${rev.id}/positions?limit=2`);
    expect(page1.status, page1.text).toBe(200);
    expect(page1.body.items.map((p: { itemNo: string | null }) => p.itemNo)).toEqual([null, '1.1']);
    expect(page1.body.hasMore).toBe(true);
    const page2 = await s.eng1.get(`/calculation-revisions/${rev.id}/positions?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    expect(page2.body).toMatchObject({ hasMore: false, nextCursor: null });
    const all = [...page1.body.items, ...page2.body.items];
    const byId: Record<string, { totals: { baseTotal: unknown } }> = Object.fromEntries(
      all.map((p: { externalPositionId: string; totals: { baseTotal: unknown } }) => [p.externalPositionId, p]),
    );
    expect(byId[TH.p0]).toMatchObject({ isSection: true, lines: 0 });
    expect(byId[TH.p2]).toMatchObject({ isSection: false, lines: 0, itemsCount: 0 });
    expect(byId[TH.p3]).toMatchObject({ isAdditional: true, manualVolume: { value: '40', note: 'по факту вывоза', semantics: 'unconfirmed' }, volume: '1' });
    expect(byId[TH.p1]).toMatchObject({ dominantCostCategory: 'МОНОЛИТНЫЕ РАБОТЫ', markupPercentage: '20.0000000000001', lines: 2 });
    expect(byId[TH.p1]!.totals.baseTotal).toMatchObject({ amount: '1500.75', priceKind: 'cost', currency: 'UNKNOWN' });
    const lines = await s.eng1.get(`/calculation-revisions/${rev.id}/lines?positionId=${TH.p1}`);
    expect(lines.body.items.map((l: { externalItemId: string }) => l.externalItemId)).toEqual([TH.l1, TH.l2]);
    const [work, material] = lines.body.items;
    // Строка берёт категорию из своих справочников, а не «самую частую» категорию позиции.
    expect(work).toMatchObject({ itemType: 'раб', workName: 'Бетонирование конструкций', costCategory: 'МОНОЛИТНЫЕ РАБОТЫ', detailCostLocation: 'Корпус 2' });
    expect(material).toMatchObject({ itemType: 'мат-комп.', parentWorkExternalItemId: TH.l1, materialName: 'Бетон B30', costCategory: null, quotePriceDate: null });
  });

  it('точность: лексема с 21 значащей цифрой проходит ответ → разбор → БД → API без изменений', async () => {
    const rev = (await revisionsOf(s.stageA))[0]!;
    const lines = await s.eng1.get(`/calculation-revisions/${rev.id}/lines?positionId=${TH.p1}`);
    const material = lines.body.items[1];
    expect(material.unitRate).toEqual({
      amount: PRECISE_RATE,
      currency: 'RUB',
      vat: 'unknown',
      priceKind: 'cost',
      unit: 'м3',
      asOf: null,
      source: { type: 'calculation_line', revisionId: rev.id, externalId: TH.l2, field: 'unit_rate' },
    });
    // Экспонента источника хранится канонически, исходная лексема — в raw_lexemes (ADR-005 §1).
    expect(material.quantity).toBe('0.0000001');
    expect(material.rawLexemes).toMatchObject({ unit_rate: PRECISE_RATE, quantity: '1e-7' });
    const db1 = await db.pool.query<{ exact: boolean; text: string }>(
      `SELECT l.unit_rate = $2::numeric AS exact, l.unit_rate::text AS text FROM calculation_line l
         JOIN calculation_revision r ON r.content_id = l.content_id WHERE r.id = $1 AND l.external_item_id = $3`,
      [rev.id, PRECISE_RATE, TH.l2],
    );
    expect(db1.rows[0]).toEqual({ exact: true, text: PRECISE_RATE });
    // Строка в долларах несёт валюту источника; суммы без подтверждённой валюты — UNKNOWN.
    const usd = (await s.eng1.get(`/calculation-revisions/${rev.id}/lines?positionId=${TH.p3}`)).body.items[0];
    expect(usd.unitRate).toMatchObject({ amount: '12.5', currency: 'USD', unit: 'т' });
    expect(usd.totalAmount).toMatchObject({ amount: '50', currency: 'UNKNOWN' });
  });

  it('сверка агрегатов записана: суммы строк сходятся с итогами позиций и с cached_grand_total', async () => {
    const rev = (await s.eng1.get(`/calculation-revisions/${(await revisionsOf(s.stageA))[0]!.id}`)).body;
    expect(rev.aggregates.tolerance).toBe('0.01');
    for (const c of rev.aggregates.checks) expect(c).toMatchObject({ positions: 4, mismatch: 0 });
    expect(rev.aggregates.grandTotal).toMatchObject({ source: '1860.9', positionsCommercialSum: '1860.9', status: 'ok' });
  });
});

describe('идентичность ревизии (RT-04, R01-04, R01-08, A07)', () => {
  it('повтор той же выгрузки — та же ревизия, без нового события барьера', async () => {
    const before = await revisionsOf(s.stageA);
    const events = (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stage_input_event WHERE stage_id = $1', [s.stageA])).rows[0]!.n;
    const cap = await captureNow(db, worker, s.eng1, s.stageA);
    expect(cap.status).toBe('complete');
    expect(cap.revisionId).toBe(before[0]!.id);
    expect(await revisionsOf(s.stageA)).toHaveLength(before.length);
    expect((await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stage_input_event WHERE stage_id = $1', [s.stageA])).rows[0]!.n).toBe(events);
  });

  it('A07 / RT-04: изменение в TenderHub после выгрузки (те же строки, другие курсы) — новая ревизия, прежняя не меняется, влияние показано событием барьера', async () => {
    const [prev] = await revisionsOf(s.stageA);
    const prevView = (await s.eng1.get(`/calculation-revisions/${prev!.id}`)).body;
    const version = (await db.pool.query<{ v: number }>('SELECT input_version AS v FROM tender_stage WHERE id = $1', [s.stageA])).rows[0]!.v;
    hub.tenders.get(TH.tender)!.usd_rate = n('91');
    const cap = await captureNow(db, worker, s.eng1, s.stageA);
    const revs = await revisionsOf(s.stageA);
    expect(revs[0]).toMatchObject({ id: cap.revisionId, seq: 2, supersedesRevisionId: prev!.id });
    expect(revs[0]!.contentHash).not.toBe(prev!.contentHash);
    expect((await s.eng1.get(`/calculation-revisions/${prev!.id}`)).body).toEqual(prevView);
    // Влияние: версия входов этапа выросла, событие calculation_revision_added ссылается на новую ревизию.
    const ev = await db.pool.query<{ seq: number; ref_id: string; event_type: string }>(
      'SELECT seq, ref_id, event_type FROM stage_input_event WHERE stage_id = $1 ORDER BY seq DESC LIMIT 1',
      [s.stageA],
    );
    expect(ev.rows[0]).toEqual({ seq: version + 1, ref_id: cap.revisionId, event_type: 'calculation_revision_added' });
    const log = await s.eng1.get(`/stages/${s.stageA}/input-events`);
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.body)).toContain('calculation_revision_added');
  });

  it('одинаковые строки при разном итоге КП источника — разное содержимое (новая ревизия)', async () => {
    const t = hub.tenders.get(TH.tender)!;
    t.cached_grand_total = n('1900.9');
    const cap = await captureNow(db, worker, s.eng1, s.stageA);
    const revs = await revisionsOf(s.stageA);
    expect(revs[0]).toMatchObject({ id: cap.revisionId, seq: 3 });
    // Итог изменился, строки нет: сверка показывает расхождение, а не подгоняет его (ADR-005 §7).
    const rev = (await s.eng1.get(`/calculation-revisions/${cap.revisionId}`)).body;
    expect(rev.aggregates.grandTotal).toMatchObject({ source: '1900.9', positionsCommercialSum: '1860.9', diff: '40', status: 'mismatch' });
    t.cached_grand_total = n('1860.9');
  });

  it('A → B → A → повтор: возврат к A — новая ревизия со ссылкой на прежнее содержимое A; повтор идемпотентен', async () => {
    // Сейчас источник снова «курсы 91, итог 1860.9»: это содержимое ревизии 2, а последняя — 3.
    const a = await captureNow(db, worker, s.eng1, s.stageA);
    const revs = await revisionsOf(s.stageA);
    expect(revs[0]).toMatchObject({ id: a.revisionId, seq: 4 });
    expect(revs[0]!.contentHash).toBe(revs.find((r) => r.seq === 2)!.contentHash);
    const repeat = await captureNow(db, worker, s.eng1, s.stageA);
    expect(repeat.revisionId).toBe(a.revisionId);
    expect(await revisionsOf(s.stageA)).toHaveLength(4);
  });

  it('одинаковый итог при отличающихся строках — разное содержимое', async () => {
    const t = hub.tenders.get(TH.tender)!;
    const line = t.items.find((i) => i.id === TH.l1)!;
    line.description = 'Бетонирование с прогревом';
    line.updated_at = '2026-09-02T10:00:00Z';
    const cap = await captureNow(db, worker, s.eng1, s.stageA);
    const revs = await revisionsOf(s.stageA);
    expect(revs[0]).toMatchObject({ id: cap.revisionId, seq: 5 });
    const rev = (await s.eng1.get(`/calculation-revisions/${cap.revisionId}`)).body;
    expect(rev.source.grandTotal.amount).toBe('1860.9');
    expect(rev.contentHash).not.toBe(revs[1]!.contentHash);
  });

  it('provisional сама не становится verified: запись ревизии неизменна, verified без внешней ревизии непредставима', async () => {
    const [rev] = await revisionsOf(s.stageA);
    await expect(db.pool.query("UPDATE calculation_revision SET kind = 'verified' WHERE id = $1", [rev!.id])).rejects.toThrow(/permission denied|запрещена/u);
    await expect(
      db.pool.query(
        `INSERT INTO calculation_revision (stage_id, tender_id, content_id, capture_id, seq, kind, system, external_tender_id)
         SELECT stage_id, tender_id, content_id, capture_id, 99, 'verified', system, external_tender_id FROM calculation_revision WHERE id = $1`,
        [rev!.id],
      ),
    ).rejects.toThrow(/calculation_revision_kind_shape|незавершённая выгрузка/u);
  });
});

describe('запрос выгрузки: права, идемпотентность, одна активная выгрузка', () => {
  it('без связи — 409 no_calculation_source; посторонний — 404; вторая выгрузка при активной — 409', async () => {
    const noSource = await s.eng3.post(`/stages/${s.stageB}/calculation-captures`, {}, { headers: idem() });
    expect(noSource.status).toBe(409);
    expect(noSource.body.current).toEqual({ reason: 'no_calculation_source' });
    expect((await s.eng3.post(`/stages/${s.stageA}/calculation-captures`, {}, { headers: idem() })).status).toBe(404);
    const key = idem();
    const first = await s.eng1.post(`/stages/${s.stageA}/calculation-captures`, {}, { headers: key });
    expect(first.status).toBe(202);
    const replay = await s.eng1.post(`/stages/${s.stageA}/calculation-captures`, {}, { headers: key });
    expect(replay.status).toBe(202);
    expect(replay.body.id).toBe(first.body.id);
    const second = await s.eng2.post(`/stages/${s.stageA}/calculation-captures`, {}, { headers: idem() });
    expect(second.status).toBe(409);
    expect(second.body.current).toEqual({ reason: 'capture_in_progress', captureId: first.body.id });
    const { runCaptures } = await import('./calculationFixtures.ts');
    await runCaptures(db, worker);
  });
});
