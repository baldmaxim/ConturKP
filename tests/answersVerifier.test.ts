// Этап 08a: необязательная проверка черновика моделью (AD-08a-6, `ANSWER_VERIFIER=same_model`). Проверяющий видит только
// утверждения, прошедшие правила, и может лишь сузить показанное: «не подтверждено» — утверждение не показано; конфликт —
// номерами цитат; «вопрос неоднозначен» — нужно уточнить. Сбой проверяющего не добавляет непроверенного: остаётся уровень
// правил, сбой записан в охвате.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatModelResult } from '../packages/adapters/src/index.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';
import { ask, buildAnswerStage, draftJson, newDialog, workingContext, type IAnswerStage } from './answerFixtures.ts';

let db: ITestDb;
let st: IAnswerStage;
const base = testConfig();
const config = { ...base, answer: { ...base.answer, verifierMode: 'same_model' as const } };
const WARRANTY = '6.1. Гарантийный срок составляет 5 лет с даты подписания акта.';
const ADVANCE = '3.1. Аванс в размере 30% от цены договора.';
const OTHER = 'Гарантийный срок кровли составляет 3 года по ведомости.';

const evidence = (user: string) => (JSON.parse(user) as { evidence: { label: string; text: string }[] }).evidence;
const labelIn = (user: string, includes: string): string => evidence(user).find((e) => e.text.includes(includes))?.label ?? 'E404';
const verdict = (v: unknown): ChatModelResult<string> => ({ ok: true, value: JSON.stringify(v) });

beforeAll(async () => {
  db = await createTestDb();
  st = await buildAnswerStage(db, config, {
    'Договор.pdf': { pages: [{ blocks: [ADVANCE, WARRANTY] }] },
    'Ведомость.pdf': { pages: [{ blocks: [OTHER] }] },
  });
});
afterAll(async () => {
  await db.drop();
});

// Черновик: два утверждения о гарантийном сроке по двум основаниям; оба проходят правила.
const twoClaims = (user: string) =>
  draftJson([
    { text: 'Гарантийный срок составляет 5 лет с даты подписания акта.', kind: 'period', evidence: [labelIn(user, '6.1.')] },
    { text: 'Гарантийный срок кровли составляет 3 года.', kind: 'period', evidence: [labelIn(user, 'кровли')] },
  ]);

describe('проверяющая модель (same_model)', () => {
  it('«не подтверждено» проверяющим — утверждение не показано; уровень «модель»; проверяющий видел только прошедшее правила', async () => {
    st.chat.scenario = (input) => {
      if (input.task === 'answer_draft') return twoClaims(input.user);
      const claims = (JSON.parse(input.user) as { claims: { claim_id: string }[] }).claims;
      expect(claims.map((c) => c.claim_id)).toEqual(['c1', 'c2']);
      return verdict({ overall: 'repair', claims: [{ claim_id: 'c1', status: 'supported', supported_by: [] }, { claim_id: 'c2', status: 'unsupported', issues: ['не о договоре'] }] });
    };
    const d = await newDialog(st.s.eng1, workingContext(st));
    const r = await ask(st, st.s.eng1, d, 'Какой гарантийный срок по договору?');
    expect(r).toMatchObject({ answerStatus: 'confirmed_by_citations', verificationLevel: 'model' });
    expect(r.answer!.claims.map((c) => c.text)).toEqual(['Гарантийный срок составляет 5 лет с даты подписания акта']);
    expect(r.answer!.droppedIssues).toMatchObject({ 'verifier:unsupported': 1 });
    expect(r.answer!.text).not.toContain('3 года');
    expect((r.coverage as { verifier: unknown }).verifier).toMatchObject({ mode: 'same_model', status: 'ok' });
  });

  it('проверяющий ответил не JSON — уровень «правила», сбой в охвате; непроверенного текста модели нет', async () => {
    st.chat.scenario = (input) => (input.task === 'answer_draft' ? twoClaims(input.user) : { ok: true, value: 'всё верно, проверено' });
    const d = await newDialog(st.s.eng1, workingContext(st));
    const r = await ask(st, st.s.eng1, d, 'Какой гарантийный срок по договору?');
    expect(r.verificationLevel).toBe('hard_checks');
    expect((r.coverage as { verifier: unknown }).verifier).toMatchObject({ mode: 'same_model', status: 'failed' });
    expect(JSON.stringify(r)).not.toContain('всё верно, проверено');
  });

  it('проверяющий счёл вопрос неоднозначным и ничего не подтвердил — «нужно уточнить», а не «подтверждено»', async () => {
    st.chat.scenario = (input) =>
      input.task === 'answer_draft'
        ? twoClaims(input.user)
        : verdict({ overall: 'clarify', claims: [{ claim_id: 'c1', status: 'ambiguous' }, { claim_id: 'c2', status: 'ambiguous' }] });
    const d = await newDialog(st.s.eng1, workingContext(st));
    const r = await ask(st, st.s.eng1, d, 'Какой гарантийный срок?');
    expect(r).toMatchObject({ answerStatus: 'needs_clarification', incompleteReason: null, answer: { shownClaims: 0 } });
  });

  it('конфликт, названный проверяющим, — показан номерами цитат, статус «основания расходятся»', async () => {
    st.chat.scenario = (input) =>
      input.task === 'answer_draft'
        ? twoClaims(input.user)
        : verdict({
            overall: 'pass',
            claims: [{ claim_id: 'c1', status: 'supported' }, { claim_id: 'c2', status: 'supported' }],
            conflicts: [{ evidence_ids: [labelIn(input.user, '6.1.'), labelIn(input.user, 'кровли')], note: 'разные сроки' }],
          });
    const d = await newDialog(st.s.eng1, workingContext(st));
    const r = await ask(st, st.s.eng1, d, 'Какой гарантийный срок?');
    expect(r.answerStatus).toBe('citations_disagree');
    expect(r.answer!.conflictCitations).toHaveLength(2);
    expect(r.answer!.text).toContain('В документах есть расхождение по этому вопросу');
    expect(r.answer!.text).not.toContain('разные сроки');
  });
});
