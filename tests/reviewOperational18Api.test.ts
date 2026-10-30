import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertFactRulesUpgrade, withTransaction } from '../packages/db/src/index.ts';
import { captureNow } from './calculationFixtures.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';
import { buildStage09, closeHub, findings, RT, runReview, type IStage09 } from './reviewFixtures.ts';
import { fakePosition, fakeTender, n } from '../scripts/tenderhub-fake-data.ts';

let db: ITestDb;
let st: IStage09;
beforeAll(async () => {
  db = await createTestDb();
  st = await buildStage09(db, testConfig(), { extraDocs: [{ name: 'Условия синтетического договора.pdf', blocks: [
    'Договор подряда № ТЕСТ-18 от 01.01.2026',
    'Заказчик: ООО «ГК «СЕВЕР–ПРОЕКТ»»', 'Заказчик: ООО «ГК Север-Проект»',
    'За просрочку сдачи начисляется неустойка в размере 0,1% от цены работ за каждый день.',
    'За просрочку ключевого события начисляется неустойка в размере 0,05% от цены работ ключевого события за каждый день.',
    'За просрочку сдачи начисляется неустойка в размере 0,2% от цены работ за каждый день.',
  ] }] });
});
afterAll(async () => { await closeHub(st); if (db) await db.drop(); });

it('API и worker: разные события неустойки и типографика не дают ложных конфликтов; изменение ставки того же события даёт конфликт', async () => {
  const run = await runReview(st);
  const conflicts = (await findings(st, st.s.eng1, `?runId=${run.id}`)).filter(f => f.kind === 'source_conflict');
  expect(conflicts.filter(f => f.title.startsWith('Заказчик'))).toEqual([]);
  const penalties = conflicts.filter(f => f.title.startsWith('Неустойка'));
  expect(penalties).toHaveLength(1);
  expect(penalties[0]!.title).toContain('0,1%');
  expect(penalties[0]!.title).toContain('0,2%');
  expect(penalties[0]!.title).not.toContain('0,05%');
  const detail = (await st.s.eng1.get(`/findings/${penalties[0]!.id}`)).body;
  expect(detail.graphFacts.left).toHaveLength(1);
  expect(detail.graphFacts.right).toHaveLength(1);
});

it('настоящая выгрузка TenderHub закрепляет иерархию; повторная проверка показывает только дубль внутри одной ветви', async () => {
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const p = (i: number, isSection: boolean) => fakePosition(RT.tender, ids[i]!, {
    position_number: n(String(i + 1)), work_name: isSection ? 'Оборудование' : 'Монтаж насоса',
    section_number: null, hierarchy_level: n(isSection ? '2' : '3'), is_section: isSection,
    unit_code: isSection ? null : 'шт', volume: isSection ? null : n('1'),
  });
  st.hub.tenders.set(RT.tender, fakeTender({ id: RT.tender, tender_number: 'ТЕСТ-18', positions: [p(0, true), p(1, false), p(2, true), p(3, false), p(4, false)], items: [] }));
  const cap = await captureNow(db, st.worker, st.s.eng1, st.s.stageA);
  expect(cap.status).toBe('complete');
  const run = await runReview(st);
  const duplicates = (await findings(st, st.s.eng1, `?runId=${run.id}`)).filter(f => f.kind === 'duplicate_position');
  expect(duplicates).toHaveLength(1);
  const detail = (await st.s.eng1.get(`/findings/${duplicates[0]!.id}`)).body;
  const positions = detail.evidence.filter((e: { type: string }) => e.type === 'calculation_object').map((e: { calculation: { positionId: string } }) => e.calculation.positionId);
  expect(positions.sort()).toEqual([ids[3], ids[4]].sort());
});

it('обновление правил останавливается при решении по прежней версии; факт и решение сохраняются', async () => {
  const owner = { tenderId: st.s.tenderA, contractId: null };
  await expect(assertFactRulesUpgrade(db.pool, owner)).resolves.toBeUndefined();
  const oldId = await withTransaction(db.pool, async c => {
    const current = (await c.query(`SELECT f.*, x.recognition_run_id, x.document_revision_id, x.document_id FROM evidence_fact f
      JOIN fact_extraction_run x ON x.id=f.extraction_run_id WHERE x.tender_id=$1 ORDER BY f.id LIMIT 1`, [st.s.tenderA])).rows[0];
    const old = (await c.query(`INSERT INTO fact_extraction_run (recognition_run_id, document_revision_id, document_id, tender_id, rules_version, document_kind,
      document_number, classify_method, fragments_scanned, facts_found, coverage) VALUES ($1,$2,$3,$4,'rules/1-kontur','other','','fixture',1,1,'{}') RETURNING id`,
    [current.recognition_run_id, current.document_revision_id, current.document_id, st.s.tenderA])).rows[0].id;
    const fact = (await c.query(`INSERT INTO evidence_fact (extraction_run_id,fact_type,raw_value,normalized,normalized_key,unit,condition,clause_ref,amends)
      SELECT $1,fact_type,raw_value,normalized,normalized_key,unit,condition,clause_ref,amends FROM evidence_fact WHERE id=$2 RETURNING id`, [old,current.id])).rows[0].id;
    await c.query('INSERT INTO evidence_fact_fragment (evidence_fact_id,fragment_id,ordinal) SELECT $1,fragment_id,ordinal FROM evidence_fact_fragment WHERE evidence_fact_id=$2', [fact,current.id]);
    await c.query(`INSERT INTO fact_decision (tender_id,fact_id,other_fact_id,kind,reason,decided_by) VALUES ($1,$2,$3,'distinct','Синтетическое решение прежней версии',$4)`, [st.s.tenderA,fact,current.id,st.s.ids.manager]);
    return fact;
  });
  await expect(assertFactRulesUpgrade(db.pool, owner)).rejects.toThrow('fact_rules_upgrade_requires_decision_review');
  expect((await db.pool.query('SELECT id FROM evidence_fact WHERE id=$1', [oldId])).rowCount).toBe(1);
  expect((await db.pool.query('SELECT id FROM fact_decision WHERE fact_id=$1', [oldId])).rowCount).toBe(1);
});
