// Этап 08a: решение человека в графе фактов D-018 (D-028) меняет ответ. Допсоглашение без даты — порядок изменений
// неизвестен, ответ показывает расхождение; человек решает «действует новое значение» — ребро графа; следующий ответ
// по той же области выдаёт новое значение, а прежнее — только как перекрытое основание. Правило C временной
// трактовки (замена факта этапа 08) снято: факты этапа 08 признак редакции больше не задают.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, idem, testConfig, type ITestDb } from './helpers.ts';
import { ask, buildAnswerStage, newDialog, workingContext, type IAnswerStage } from './answerFixtures.ts';

let db: ITestDb;
let st: IAnswerStage;
const config = testConfig();
const BASE = '3.1. Аванс в размере 30% от цены договора.';
const CHANGE = 'Пункт 3.1 договора изложить в новой редакции: «Аванс в размере 20% от цены договора».';

beforeAll(async () => {
  db = await createTestDb();
  st = await buildAnswerStage(db, config, {
    'Договор подряда 9.pdf': { pages: [{ blocks: ['Договор подряда № 9 от 01.01.2026', BASE] }] },
    'ДС-1 без даты.pdf': { pages: [{ blocks: ['Дополнительное соглашение № 1 к договору подряда № 9 от 01.01.2026', CHANGE] }] },
  });
});
afterAll(async () => {
  await db.drop();
});

describe('решение человека в графе фактов', () => {
  it('без даты — расхождение; после решения «действует 20 %» — ответ 20 %, 30 % — перекрытое основание', async () => {
    st.chat.scenario = null;
    const d = await newDialog(st.s.eng1, workingContext(st));
    const before = await ask(st, st.s.eng1, d, 'Какой аванс по договору?');
    expect(before.answerStatus).toBe('citations_disagree');

    const g = (await st.s.manager.get(`/tenders/${st.s.tenderA}/fact-graph`)).body as { facts: { id: string; type: string; display: string }[]; remarks: { kind: string; status: string }[] };
    expect(g.remarks.filter((r) => r.status === 'open').map((r) => r.kind).sort()).toEqual(['undated_amendment', 'value_conflict']);
    const fresh = g.facts.find((f) => f.type === 'advance_percent' && f.display === '20 %')!;
    const old = g.facts.find((f) => f.type === 'advance_percent' && f.display === '30 %')!;
    const decision = await st.s.manager.post(`/evidence-facts/${fresh.id}/decisions`, { otherFactId: old.id, kind: 'prevails', reason: 'ДС № 1 подписано позже договора' }, { headers: idem() });
    expect(decision.status, decision.text).toBe(201);

    const d2 = await newDialog(st.s.eng1, workingContext(st));
    const after = await ask(st, st.s.eng1, d2, 'Какой аванс по договору?');
    expect(after.answerStatus).toBe('confirmed_by_citations');
    expect(after.answer!.text).toContain('20%');
    expect(after.answer!.text).not.toContain('30%');
    const packet = await db.pool.query<{ version_note: string; text: string }>(
      'SELECT e.version_note, f.text FROM answer_evidence e JOIN evidence_fragment f ON f.id = e.fragment_id WHERE e.run_id = $1',
      [after.id],
    );
    expect(packet.rows.find((p) => p.text === BASE)?.version_note).toBe('superseded');
    // Прежний ответ не переписан: ход неизменен, его пакет помнит расхождение на момент ответа.
    const kept = await db.pool.query<{ version_note: string }>('SELECT version_note FROM answer_evidence WHERE run_id = $1', [before.id]);
    expect(kept.rows.some((p) => p.version_note === 'conflict')).toBe(true);
  });
});
