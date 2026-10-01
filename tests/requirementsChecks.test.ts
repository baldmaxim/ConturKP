// R08-01 (Review 08-1): неверная единица и конфликтующие требования — минимальное поведение этапа 08.
// Несовпадение единиц и конфликт явно показываются пользователю и не засчитываются молча: «покрыто» с
// несовпадающей единицей и подтверждение конфликтующего требования — только с пояснением. Вторая линия — БД
// (миграция 0020). Автоматическое разрешение конфликтов — этап 09 (G11).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRequirementCandidate, recordCoverage, confirmRequirementCandidate } from '../packages/db/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { createTestDb, idem, makeWorker, testConfig, type ITestDb, type TestClient } from './helpers.ts';
import { buildStage08, confirm, propose, supports, type IStage08 } from './requirementFixtures.ts';

let db: ITestDb;
let st: IStage08;
let hub: IFakeTenderHub;
let calc1: string;

const record = (client: TestClient, revisionId: string, body: object) => client.post(`/requirement-revisions/${revisionId}/coverage`, body, { headers: idem() });
const line = (positionId: string, itemId: string) => ({ type: 'calculation_revision', calculationRevisionId: calc1, externalPositionId: positionId, externalItemId: itemId, match: 'explicit_line' });

// Требование с параметрами и областью: предложение инженера, подтверждение руководителем.
const requirement = async (statement: string, parameters: object[], objectScope: object = {}, fragment = st.frag.facade) => {
  const c = await propose(st.s.eng1, st.registryId, statement, supports(fragment), { parameters, objectScope });
  const r = await confirm(st.s.manager, c.id);
  expect(r.status, r.text).toBe(200);
  return { candidateId: c.id, requirementId: r.body.requirementId as string, revisionId: r.body.revisionId as string };
};

const card = async (requirementId: string) => (await st.s.eng1.get(`/requirements/${requirementId}`)).body;
const listItem = async (requirementId: string) =>
  ((await st.s.eng1.get(`/requirement-registries/${st.registryId}/requirements`)).body.items as { id: string }[]).find((x) => x.id === requirementId) as Record<string, unknown>;

// Транзакция под ролью приложения в обход API: итог — код ошибки или ok.
const tx = async (fn: (c: pg.PoolClient) => Promise<void>): Promise<string> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return (e as { code?: string }).code ?? String(e);
  } finally {
    c.release();
  }
};

beforeAll(async () => {
  db = await createTestDb();
  hub = await startFakeTenderHub({ apiKey: TH_KEY });
  hub.tenders.set(TH.tender, standardTender());
  const config = tenderHubConfig(testConfig(), hub);
  await new BlobStore(config.storageRoot).ensureDirs();
  st = await buildStage08(db, config);
  const worker = makeWorker(db, config);
  const boss = await adminMember(db, st.s, st.app, st.s.tenderA);
  await linkSource(boss, st.s.stageA, TH.tender);
  const cap = await captureNow(db, worker, st.s.eng1, st.s.stageA);
  expect(cap.status).toBe('complete');
  calc1 = cap.revisionId as string;
});
afterAll(async () => {
  await hub.close();
  await db.drop();
});

describe('неверная единица (R08-01)', () => {
  it('единица требования м² против строки расчёта м³: «покрыто» без пояснения — 409 с деталями, с пояснением — запись и явный признак', async () => {
    const r = await requirement('Утепление стен — 120 м²', [{ name: 'Площадь утепления', value: '120', unit: 'м²' }]);
    const bad = await record(st.s.manager, r.revisionId, { state: 'covered', objects: [line(TH.p1, TH.l2)] });
    expect(bad.status, bad.text).toBe(409);
    expect(bad.body.current).toMatchObject({ reason: 'unit_mismatch', objects: [{ index: 0, requirementUnits: ['м2'], calculationUnit: 'м3' }] });
    // «Частично» — тоже засчитанное покрытие: без пояснения не принимается.
    expect((await record(st.s.manager, r.revisionId, { state: 'partial', objects: [line(TH.p1, TH.l2)] })).body.current.reason).toBe('unit_mismatch');
    expect((await card(r.requirementId)).coverageState).toBeNull();

    const ok = await record(st.s.manager, r.revisionId, { state: 'covered', unitMismatchReason: 'В расчёте объём утеплителя; площадь пересчитана по толщине 0,1 м', objects: [line(TH.p1, TH.l2)] });
    expect(ok.status, ok.text).toBe(201);
    const c = await card(r.requirementId);
    expect(c.coverageState).toBe('covered');
    expect(c.coverageUnitMismatch).toBe(true);
    expect(c.coverage[0]).toMatchObject({
      unitMismatch: true,
      unitMismatchReason: 'В расчёте объём утеплителя; площадь пересчитана по толщине 0,1 м',
      objects: [{ type: 'calculation_revision', requirementUnits: ['м2'], calculationUnit: 'м3', unitStatus: 'mismatch' }],
    });
    expect(await listItem(r.requirementId)).toMatchObject({ coverageState: 'covered', coverageUnitMismatch: true });
  });

  it('несовпадение хотя бы одного объекта из нескольких — тоже только с пояснением; статус единиц — у каждого объекта', async () => {
    const r = await requirement('Арматура и бетон ростверка', [{ name: 'Масса арматуры', value: '2', unit: 'т' }]);
    const objects = [line(TH.p3, TH.l3), line(TH.p1, TH.l2)];
    const bad = await record(st.s.manager, r.revisionId, { state: 'covered', objects });
    expect(bad.status).toBe(409);
    expect(bad.body.current.objects).toEqual([{ index: 1, requirementUnits: ['т'], calculationUnit: 'м3' }]);
    const ok = await record(st.s.manager, r.revisionId, { state: 'partial', unitMismatchReason: 'Бетон ростверка учтён отдельной строкой', objects });
    expect(ok.status, ok.text).toBe(201);
    expect((await card(r.requirementId)).coverage[0].objects.map((o: { unitStatus: string }) => o.unitStatus).sort()).toEqual(['match', 'mismatch']);
  });

  it('совпадение с учётом записи единицы (куб.м = м³) и несравнимые случаи — без пояснения; лишнее пояснение — 409', async () => {
    const r = await requirement('Бетон плиты — 50 куб.м', [{ name: 'Объём бетона', value: '50', unit: 'куб.м' }]);
    const extra = await record(st.s.manager, r.revisionId, { state: 'covered', unitMismatchReason: 'лишнее', objects: [line(TH.p1, TH.l2)] });
    expect(extra.status).toBe(409);
    expect(extra.body.current.reason).toBe('unit_mismatch_reason_unexpected');
    const ok = await record(st.s.manager, r.revisionId, { state: 'covered', objects: [line(TH.p1, TH.l2)] });
    expect(ok.status, ok.text).toBe(201);
    expect((await card(r.requirementId)).coverage[0]).toMatchObject({ unitMismatch: false, objects: [{ requirementUnits: ['м3'], calculationUnit: 'м3', unitStatus: 'match' }] });

    // У требования нет единиц — сравнить нечего.
    const plain = await requirement('Кровля — профнастил', []);
    expect((await record(st.s.manager, plain.revisionId, { state: 'covered', objects: [line(TH.p1, TH.l2)] })).status).toBe(201);
    expect((await card(plain.requirementId)).coverage[0].objects[0]).toMatchObject({ requirementUnits: [], unitStatus: 'not_comparable' });
  });

  it('вторая линия БД: «покрыто» с несовпадением без пояснения в обход API — 23514; единицы считает БД, не клиент', async () => {
    const r = await requirement('Облицовка — 300 м²', [{ name: 'Площадь облицовки', value: '300', unit: 'м2' }]);
    const objects = [{ type: 'calculation_revision' as const, calculationRevisionId: calc1, externalPositionId: TH.p1, externalItemId: TH.l2, match: 'explicit_line' as const, note: null }];
    const base = { tenderId: st.s.tenderA, stageId: st.s.stageA, revisionId: r.revisionId, state: 'covered' as const, reason: null, objects, userId: st.s.ids.manager };
    expect(await tx(async (c) => void (await recordCoverage(c, { ...base, unitMismatchReason: null })))).toBe('23514');
    // Клиентское «совпадение» игнорируется: единицы и статус пишет охранник объекта, проверка на COMMIT — 23514.
    const forged = await tx(async (c) => {
      const cov = await c.query<{ id: string }>(
        `INSERT INTO requirement_coverage (tender_id, stage_id, requirement_revision_id, seq, state, origin, assessed_by)
         VALUES ($1, $2, $3, 1, 'covered', 'human', $4) RETURNING id`,
        [st.s.tenderA, st.s.stageA, r.revisionId, st.s.ids.manager],
      );
      await c.query(
        `INSERT INTO requirement_coverage_object (coverage_id, tender_id, object_type, calculation_revision_id, external_position_id, external_item_id, match,
                                                  requirement_units, calculation_unit, unit_status)
         VALUES ($1, $2, 'calculation_revision', $3, $4, $5, 'explicit_line', '{м3}', 'м3', 'match')`,
        [cov.rows[0]!.id, st.s.tenderA, calc1, TH.p1, TH.l2],
      );
      const stored = await c.query('SELECT requirement_units, calculation_unit, unit_status FROM requirement_coverage_object WHERE coverage_id = $1', [cov.rows[0]!.id]);
      expect(stored.rows[0]).toEqual({ requirement_units: ['м2'], calculation_unit: 'м3', unit_status: 'mismatch' });
    });
    expect(forged).toBe('23514');
    expect((await card(r.requirementId)).coverageState).toBeNull();
  });
});

describe('конфликтующие требования (R08-01)', () => {
  it('тот же параметр, та же область, другое значение: подтверждение без пояснения — 409 с кодом конфликта; с пояснением — конфликт виден у обоих', async () => {
    const a = await requirement('Класс бетона перекрытия 2 этажа — B30', [{ name: 'Класс бетона', value: 'B30' }], { floor: '2' });
    const c = await propose(st.s.eng1, st.registryId, 'Класс бетона перекрытия 2 этажа — B40', supports(st.frag.waterproofing), {
      parameters: [{ name: ' класс  бетона ', value: 'B40' }],
      objectScope: { floor: '2' },
    });
    const queued = ((await st.s.manager.get(`/requirement-registries/${st.registryId}/candidates?status=proposed`)).body.items as { id: string }[]).find((x) => x.id === c.id);
    const codeA = (await card(a.requirementId)).code as string;
    expect(queued).toMatchObject({ contradicted: false, conflicts: [{ requirementId: a.requirementId, code: codeA, parameter: 'класс бетона' }] });

    const bad = await confirm(st.s.manager, c.id);
    expect(bad.status, bad.text).toBe(409);
    expect(bad.body.current).toMatchObject({ reason: 'requirement_conflict', contradicted: false, conflicts: [{ requirementId: a.requirementId, code: codeA }] });
    expect(bad.body.detail).toContain(codeA);
    expect((await st.s.manager.get(`/requirement-candidates/${c.id}`)).body.status).toBe('proposed');

    const ok = await confirm(st.s.manager, c.id, { conflictNote: 'В письме заказчика от 12.09 класс повышен до B40; уточнить в вопросе' });
    expect(ok.status, ok.text).toBe(200);
    const b = await card(ok.body.requirementId);
    expect(b).toMatchObject({ conflictNote: 'В письме заказчика от 12.09 класс повышен до B40; уточнить в вопросе', conflicts: [{ requirementId: a.requirementId, code: codeA, parameter: 'класс бетона' }] });
    expect(b.revisions[0].conflictNote).toBe('В письме заказчика от 12.09 класс повышен до B40; уточнить в вопросе');
    expect((await card(a.requirementId)).conflicts).toEqual([{ requirementId: b.id, code: b.code, parameter: 'класс бетона' }]);
    expect(await listItem(a.requirementId)).toMatchObject({ conflicts: [{ requirementId: b.id }] });
  });

  it('разные этажи — не конфликт; общая область (без этажа) пересекается с любым этажом', async () => {
    await requirement('Марка раствора 3 этажа — М150', [{ name: 'Марка раствора', value: 'М150' }], { floor: '3' });
    const other = await propose(st.s.eng1, st.registryId, 'Марка раствора 4 этажа — М200', supports(st.frag.note), { parameters: [{ name: 'Марка раствора', value: 'М200' }], objectScope: { floor: '4' } });
    expect((await confirm(st.s.manager, other.id, { conflictNote: 'лишнее' })).body.current.reason).toBe('conflict_note_unexpected');
    expect((await confirm(st.s.manager, other.id)).status).toBe(200);
    const whole = await propose(st.s.eng1, st.registryId, 'Марка раствора — М100', supports(st.frag.roof), { parameters: [{ name: 'Марка раствора', value: 'М100' }] });
    const bad = await confirm(st.s.manager, whole.id);
    expect(bad.status).toBe(409);
    expect((bad.body.current.conflicts as unknown[]).length).toBe(2);
  });

  it('противоречащее основание (contradicts): без пояснения — 409, с пояснением — требование помечено contradicted', async () => {
    const c = await propose(st.s.eng1, st.registryId, 'Гидроизоляция — обмазочная', [...supports(st.frag.waterproofing), { fragmentId: st.frag.roof, role: 'contradicts' }]);
    const bad = await confirm(st.s.manager, c.id);
    expect(bad.status).toBe(409);
    expect(bad.body.current).toMatchObject({ reason: 'requirement_conflict', contradicted: true, conflicts: [] });
    const ok = await confirm(st.s.manager, c.id, { conflictNote: 'Кровля к гидроизоляции плиты не относится' });
    expect(ok.status, ok.text).toBe(200);
    expect(await card(ok.body.requirementId)).toMatchObject({ contradicted: true, conflictNote: 'Кровля к гидроизоляции плиты не относится', evidenceCounts: { supports: 1, contradicts: 1 } });
  });

  it('вторая линия БД: подтверждение конфликта без пояснения в обход API — 23514', async () => {
    await requirement('Толщина утеплителя — 100 мм', [{ name: 'Толщина утеплителя', value: '100', unit: 'мм' }]);
    const c = await propose(st.s.eng1, st.registryId, 'Толщина утеплителя — 150 мм', supports(st.frag.note), { parameters: [{ name: 'Толщина утеплителя', value: '150', unit: 'мм' }] });
    const row = (await getRequirementCandidate(db.pool, c.id))!;
    const edit = { statement: row.statement, parameters: row.parameters, objectScope: row.object_scope };
    expect(await tx(async (cl) => void (await confirmRequirementCandidate(cl, row, row.row_version, st.s.ids.manager, { ...edit, conflictNote: null })))).toBe('23514');
    // Пояснение без конфликта — тоже отказ второй линии.
    const free = await propose(st.s.eng1, st.registryId, 'Цвет кладки — красный', supports(st.frag.facade), { parameters: [{ name: 'Цвет кладки', value: 'красный' }] });
    const freeRow = (await getRequirementCandidate(db.pool, free.id))!;
    expect(
      await tx(async (cl) =>
        void (await confirmRequirementCandidate(cl, freeRow, freeRow.row_version, st.s.ids.manager, {
          statement: freeRow.statement,
          parameters: freeRow.parameters,
          objectScope: freeRow.object_scope,
          conflictNote: 'нет конфликта',
        })),
      ),
    ).toBe('23514');
  });
});
