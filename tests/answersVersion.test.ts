// Этап 08a: перекрытый пункт и конфликт оснований — временная трактовка AD-08a-1 и AD-08a-8 (D-027). Допсоглашение с явной
// связью 06a перекрывает пункт основного документа: заменённое значение не выдаётся за текущее, но может быть названо
// историей; без явной связи (документы тендера) правило не выбирает значение — расхождение показывается, а не разрешается.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContract, grantCreator, uploadContractDocument, uploadMain } from './contractFixtures.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';
import { ask, buildAnswerStage, draftJson, newDialog, workingContext, type IAnswerStage } from './answerFixtures.ts';
import { buildIndex, seedEvidenceRun } from './searchFixtures.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let st: IAnswerStage;
let contractId: string;
const config = testConfig();
const MAIN = { advance: '3.1. Аванс в размере 20% от цены договора.', warranty: '4.1. Гарантийный срок составляет 5 лет.' };
const ADDENDUM = 'Пункт 3.1 договора изложить в новой редакции: «Аванс в размере 10% от цены договора».';
const label = (user: string, includes: string): string =>
  (JSON.parse(user) as { evidence: { label: string; text: string }[] }).evidence.find((e) => e.text.includes(includes))?.label ?? 'E404';

beforeAll(async () => {
  db = await createTestDb();
  // Документы тендера без явной связи: договор и «допсоглашение» — отдельные документы этапа.
  st = await buildAnswerStage(db, config, {
    'Договор поставки.pdf': { pages: [{ blocks: ['3.1. Аванс в размере 20% от цены договора.'] }] },
    'Изменение к договору поставки.pdf': { pages: [{ blocks: ['Пункт 3.1 договора изложить в новой редакции: аванс в размере 15% от цены договора.'] }] },
  });
  // Договор 06a: основной документ и допсоглашение с явной связью.
  await grantCreator(st.s.admin, st.s.ids.manager);
  contractId = await createContract(st.s.manager, 'Д-08A');
  const main = await uploadMain(st.s.manager, contractId, 'договор.pdf');
  await seedEvidenceRun(db.pool, main.revisionId, { pages: [{ blocks: [MAIN.advance, MAIN.warranty] }] });
  const ds = await uploadContractDocument(st.s.manager, contractId, 'ДС-1.pdf', fakePdf('ДС-1 к Д-08A'), { role: 'addendum', mainDocumentId: main.documentId });
  expect(ds.status, ds.text).toBe(201);
  await seedEvidenceRun(db.pool, ds.body.revisionId as string, { pages: [{ blocks: [ADDENDUM] }] });
  await buildIndex(db, st.worker);
});
afterAll(async () => {
  await db.drop();
});

const contractContext = () => ({ kind: 'contract', contractId });

describe('перекрытый пункт: допсоглашение с явной связью 06a', () => {
  it('«какой сейчас аванс» — значение из допсоглашения; пункт основного договора помечен перекрытым и не выдан за текущий', async () => {
    st.chat.scenario = null;
    const d = await newDialog(st.s.manager, contractContext());
    const r = await ask(st, st.s.manager, d, 'Какой сейчас размер аванса?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.text).toContain('10% от цены договора');
    expect(r.answer!.text).not.toContain('20%');
    const packet = await db.pool.query<{ version_note: string; text: string }>(
      'SELECT e.version_note, f.text FROM answer_evidence e JOIN evidence_fragment f ON f.id = e.fragment_id WHERE e.run_id = $1 ORDER BY e.ordinal',
      [r.id],
    );
    expect(packet.rows.find((p) => p.text === MAIN.advance)?.version_note).toBe('superseded');
    expect(packet.rows.find((p) => p.text === ADDENDUM)?.version_note).toBe('current');
  });

  it('модель выдаёт прежнее значение за действующее — утверждение отклонено; «ранее» — допустимо как история', async () => {
    st.chat.scenario = (input) =>
      input.task === 'answer_draft'
        ? draftJson([
            { text: 'Аванс составляет 20% от цены договора.', kind: 'percentage', evidence: [label(input.user, '3.1. Аванс')] },
            { text: 'Ранее аванс составлял 20% от цены договора.', kind: 'percentage', evidence: [label(input.user, '3.1. Аванс')] },
            { text: 'Аванс в размере 10% от цены договора.', kind: 'percentage', evidence: [label(input.user, 'Пункт 3.1')] },
          ])
        : null;
    const d = await newDialog(st.s.manager, contractContext());
    const r = await ask(st, st.s.manager, d, 'Какой сейчас размер аванса?');
    expect(r.answer!.claims.map((c) => c.text)).toEqual(['Ранее аванс составлял 20% от цены договора', 'Аванс в размере 10% от цены договора']);
    expect(r.answer!.droppedIssues).toMatchObject({ superseded_evidence: 1 });
  });

  it('вопрос о прежней редакции — прежнее значение допустимо', async () => {
    st.chat.scenario = (input) =>
      input.task === 'answer_draft' ? draftJson([{ text: 'Аванс составлял 20% от цены договора.', kind: 'percentage', evidence: [label(input.user, '3.1. Аванс')] }]) : null;
    const d = await newDialog(st.s.manager, contractContext());
    const r = await ask(st, st.s.manager, d, 'Какой был аванс до подписания допсоглашения?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.citations[0]).toMatchObject({ versionNote: 'superseded', text: MAIN.advance });
  });

  it('другой пункт того же договора не перекрыт', async () => {
    st.chat.scenario = null;
    const d = await newDialog(st.s.manager, contractContext());
    const r = await ask(st, st.s.manager, d, 'Какой гарантийный срок?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.citations.find((c) => c.text === MAIN.warranty)?.versionNote).toBe('current');
  });
});

describe('конфликт оснований: показан, а не разрешён', () => {
  it('изменение пункта без явной связи (документы тендера) — расхождение: оба значения с пометкой, статус «основания расходятся»', async () => {
    st.chat.scenario = null;
    const d = await newDialog(st.s.eng1, workingContext(st));
    const r = await ask(st, st.s.eng1, d, 'Какой аванс по договору поставки?');
    expect(r.answerStatus).toBe('citations_disagree');
    expect(r.answer!.text).toContain('В документах есть расхождение по этому вопросу: сравните');
    expect(r.answer!.text).toContain('20%');
    expect(r.answer!.text).toContain('15%');
    expect(r.answer!.citations.every((c) => c.versionNote === 'conflict')).toBe(true);
    expect(r.answer!.conflictCitations).toHaveLength(2);
  });
});
