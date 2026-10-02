// Этап 08a: перекрытый пункт и конфликт оснований по графу фактов D-018 (D-028, AD-08a-1 = B). Допсоглашение с датой
// перекрывает пункт основного документа: семья — явная связь 06a (договор) или ссылка «к договору № … от …» (документы
// тендера). Заменённое значение не выдаётся за текущее (R08a-01 — и рядом с текущей цитатой), но может быть названо
// историей. Без даты допсоглашение ничего не перекрывает — расхождение показывается, а не разрешается. Граф считается
// по области хода: в снимке области без позднего допсоглашения прежний пункт действует (I05).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContract, grantCreator, uploadContractDocument, uploadMain } from './contractFixtures.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';
import { ask, buildAnswerStage, draftJson, newDialog, workingContext, type IAnswerStage } from './answerFixtures.ts';
import { buildIndex, fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let st: IAnswerStage;
let contractId: string;
let undatedContractId: string;
let snapshotId: string;
const config = testConfig();
const MAIN = { title: 'Договор подряда № Д-08A от 10.01.2026', advance: '3.1. Аванс в размере 20% от цены договора.', warranty: '4.1. Гарантийный срок составляет 5 лет.' };
const ADDENDUM = { title: 'Дополнительное соглашение № 1 от 15.03.2026', text: 'Пункт 3.1 договора изложить в новой редакции: «Аванс в размере 10% от цены договора».' };
const SUPPLY = { title: 'Договор поставки № П-7 от 01.02.2026', advance: '3.1. Аванс составляет 25% от цены договора.' };
const SUPPLY_DS = {
  title: 'Дополнительное соглашение № 2 от 01.04.2026 к договору поставки № П-7 от 01.02.2026',
  text: 'Пункт 3.1 договора изложить в новой редакции: «Аванс составляет 15% от цены договора».',
};
const label = (user: string, includes: string): string =>
  (JSON.parse(user) as { evidence: { label: string; text: string }[] }).evidence.find((e) => e.text.includes(includes))?.label ?? 'E404';
const packetOf = async (runId: string) =>
  (
    await db.pool.query<{ version_note: string; text: string; reason: string }>(
      'SELECT e.version_note, e.reason, f.text FROM answer_evidence e JOIN evidence_fragment f ON f.id = e.fragment_id WHERE e.run_id = $1 ORDER BY e.ordinal',
      [runId],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDb();
  // Документы тендера: договор поставки; снимок области фиксируется до допсоглашения.
  st = await buildAnswerStage(db, config, { 'Договор поставки П-7.pdf': { pages: [{ blocks: [SUPPLY.title, SUPPLY.advance] }] } });
  await setWorkingSet(st.s.manager, st.s.stageA, Object.values(st.revisions), true);
  snapshotId = await fixScope(st.s.manager, st.s.stageA);
  const ds = await uploadDocument(db, config, st.s.eng1, st.s.stageA, 'ДС-2 к П-7.pdf');
  await seedEvidenceRun(db.pool, ds, { pages: [{ blocks: [SUPPLY_DS.title, SUPPLY_DS.text] }] });
  await setWorkingSet(st.s.manager, st.s.stageA, [...Object.values(st.revisions), ds]);
  // Договор 06a: основной документ и датированное допсоглашение с явной связью.
  await grantCreator(st.s.admin, st.s.ids.manager);
  contractId = await createContract(st.s.manager, 'Д-08A');
  const main = await uploadMain(st.s.manager, contractId, 'договор.pdf');
  await seedEvidenceRun(db.pool, main.revisionId, { pages: [{ blocks: [MAIN.title, MAIN.advance, MAIN.warranty] }] });
  const addendum = await uploadContractDocument(st.s.manager, contractId, 'ДС-1.pdf', fakePdf('ДС-1 к Д-08A'), { role: 'addendum', mainDocumentId: main.documentId });
  expect(addendum.status, addendum.text).toBe(201);
  await seedEvidenceRun(db.pool, addendum.body.revisionId as string, { pages: [{ blocks: [ADDENDUM.title, ADDENDUM.text] }] });
  // Договор 06a с допсоглашением без даты.
  undatedContractId = await createContract(st.s.manager, 'Д-БЕЗ-ДАТЫ');
  const main2 = await uploadMain(st.s.manager, undatedContractId, 'договор-2.pdf');
  await seedEvidenceRun(db.pool, main2.revisionId, { pages: [{ blocks: ['Договор подряда № Д-2 от 10.01.2026', MAIN.advance] }] });
  const undated = await uploadContractDocument(st.s.manager, undatedContractId, 'ДС-без-даты.pdf', fakePdf('ДС без даты'), { role: 'addendum', mainDocumentId: main2.documentId });
  await seedEvidenceRun(db.pool, undated.body.revisionId as string, { pages: [{ blocks: ['Дополнительное соглашение № 1', ADDENDUM.text] }] });
  await buildIndex(db, st.worker);
});
afterAll(async () => {
  await db.drop();
});

const contractContext = (id = contractId) => ({ kind: 'contract', contractId: id });

describe('перекрытый пункт: допсоглашение с датой и явной связью 06a', () => {
  it('«какой сейчас аванс» — значение из допсоглашения; пункт основного договора перекрыт и не выдан за текущий', async () => {
    st.chat.scenario = null;
    const d = await newDialog(st.s.manager, contractContext());
    const r = await ask(st, st.s.manager, d, 'Какой сейчас размер аванса?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.text).toContain('10% от цены договора');
    expect(r.answer!.text).not.toContain('20%');
    const packet = await packetOf(r.id);
    expect(packet.find((p) => p.text === MAIN.advance)).toMatchObject({ version_note: 'superseded' });
    expect(packet.find((p) => p.text === MAIN.advance)!.reason).toContain('fact:advance_percent:superseded');
    expect(packet.find((p) => p.text === ADDENDUM.text)?.version_note).toBe('current');
  });

  it('R08a-01: прежнее значение со ссылкой и на старую, и на новую редакцию — отклонено; «ранее» — история', async () => {
    st.chat.scenario = (input) =>
      input.task === 'answer_draft'
        ? draftJson([
            { text: 'Действующий аванс составляет 20% от цены договора.', kind: 'percentage', evidence: [label(input.user, '3.1. Аванс'), label(input.user, 'Пункт 3.1')] },
            { text: 'Ранее аванс составлял 20% от цены договора.', kind: 'percentage', evidence: [label(input.user, '3.1. Аванс')] },
            { text: 'Аванс в размере 10% от цены договора.', kind: 'percentage', evidence: [label(input.user, 'Пункт 3.1')] },
          ])
        : null;
    const d = await newDialog(st.s.manager, contractContext());
    const r = await ask(st, st.s.manager, d, 'Какой сейчас размер аванса?');
    expect(r.answer!.claims.map((c) => c.text)).toEqual(['Ранее аванс составлял 20% от цены договора', 'Аванс в размере 10% от цены договора']);
    expect(r.answer!.droppedIssues).toMatchObject({ superseded_evidence: 1 });
    expect(r.answer!.text).not.toContain('Действующий аванс составляет 20%');
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

describe('документы тендера: связь по тексту «к договору № … от …» и снимок области', () => {
  it('рабочий состав: допсоглашение к договору поставки перекрывает пункт 3.1 — текущий аванс 15%', async () => {
    st.chat.scenario = null;
    const d = await newDialog(st.s.eng1, workingContext(st));
    const r = await ask(st, st.s.eng1, d, 'Какой аванс по договору поставки?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.text).toContain('15%');
    expect(r.answer!.text).not.toContain('25%');
    expect((await packetOf(r.id)).find((p) => p.text === SUPPLY.advance)?.version_note).toBe('superseded');
  });

  it('снимок области до допсоглашения (I05): позднее допсоглашение вне области ничего не перекрывает — действует 25%', async () => {
    st.chat.scenario = null;
    const d = await newDialog(st.s.eng1, { kind: 'tender', tenderId: st.s.tenderA, mode: 'review', stageId: st.s.stageA, evidenceScopeId: snapshotId });
    const r = await ask(st, st.s.eng1, d, 'Какой аванс по договору поставки?');
    expect(r.answerStatus).toBe('confirmed_by_citations');
    expect(r.answer!.text).toContain('25%');
    expect((await packetOf(r.id)).every((p) => p.version_note === 'current' && !p.text.includes('15%'))).toBe(true);
  });
});

describe('конфликт оснований: показан, а не разрешён', () => {
  it('допсоглашение без даты — порядок неизвестен: оба значения с пометкой, статус «основания расходятся»', async () => {
    st.chat.scenario = null;
    const d = await newDialog(st.s.manager, contractContext(undatedContractId));
    const r = await ask(st, st.s.manager, d, 'Какой размер аванса?');
    expect(r.answerStatus).toBe('citations_disagree');
    expect(r.answer!.text).toContain('В документах есть расхождение по этому вопросу: сравните');
    expect(r.answer!.text).toContain('20%');
    expect(r.answer!.text).toContain('10%');
    expect(r.answer!.citations.every((c) => c.versionNote === 'conflict')).toBe(true);
    expect(r.answer!.conflictCitations).toHaveLength(2);
  });
});
