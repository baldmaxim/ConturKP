// Регрессии замечаний независимого ревью c31e04e. Только обезличенные данные.
import { describe, expect, it } from 'vitest';
import {
  checkClaim, parseDraft, planQuestion, renderVerifiedAnswer,
  type IDraftClaim, type IPacketItem,
} from '../packages/core/src/index.ts';

const evidence: IPacketItem = {
  label: 'E1', fragmentId: 'f1', text: 'Стоимость предложения составляет 90 рублей.',
  origin: 'document_text', sourceUnitId: 'u1', documentKey: 'd1',
  documentTitle: 'КП 19.04.2027.pdf', versionNote: 'current', reason: 'test',
};
const modelClaims = (count: number) => Array.from({ length: count }, (_, i) => ({
  text: `Пункт ${i + 1}: самостоятельное условие.`, evidence_ids: ['E1'],
}));
const render = (items: IPacketItem[], claims: IDraftClaim[], question: string, openQuestions = 0) => {
  const context = { evidenceById: new Map(items.map(item => [item.label, item])), allowedSourceUnitIds: null, versionPolicy: 'all' as const };
  return renderVerifiedAnswer({
    claims, checks: new Map(claims.map(claim => [claim.claimId, checkClaim(claim, context)])),
    items, level: 'hard_checks', question, plan: planQuestion(question), openQuestions,
  });
};

describe('S18-32: замечания ревью — обрезка и даты', () => {
  it.each(['text', 'quote'])('исходный список из 21 утверждения (%s) даёт частичный ответ', mode => {
    const rows = modelClaims(21);
    const choices = new Map(rows.map((row, i) => [`@E1Q${i + 1}`, { id: `@E1Q${i + 1}`, evidenceId: 'E1', text: row.text }]));
    const raw = mode === 'quote' ? rows.map((row, i) => ({ ...row, text: `@E1Q${i + 1}` })) : rows;
    const draft = parseDraft(JSON.stringify({ claims: raw }), new Map(), mode === 'quote' ? choices : new Map());
    expect(draft.claims).toHaveLength(20);
    const item = { ...evidence, text: rows.map(row => row.text).join('. ') };
    const answer = render([item], draft.claims, 'Перечисли условия.', draft.openQuestions);
    expect(answer.claims.filter(claim => claim.shown)).toHaveLength(20);
    expect(answer.partial).toBe(true);
    expect(answer.outcome).toBe('insufficient');
  });

  it('обрезка исходного списка сохраняет фактическое число непустых вопросов модели', () => {
    const draft = parseDraft(JSON.stringify({ claims: modelClaims(21), open_questions: ['А', '', 'Б', null, 'В', 'Г', 'Д'] }));
    expect(draft.openQuestions).toBe(5);
  });

  it('обрезка добавленных продолжений также не заменяет число вопросов единицей', () => {
    const rows = modelClaims(21);
    const choices = rows.map((row, i) => ({ id: `@E1Q${i + 1}`, evidenceId: 'E1', text: row.text, contextIds: rows.map((_, j) => `@E1Q${j + 1}`) }));
    const draft = parseDraft(JSON.stringify({ claims: [{ text: '@E1Q1', evidence_ids: ['E1'] }], open_questions: ['А', 'Б', 'В', 'Г', 'Д'] }), new Map(), new Map(choices.map(choice => [choice.id, choice])));
    expect(draft.claims).toHaveLength(20);
    expect(draft.openQuestions).toBe(5);
  });

  it('ровно 20 исходных утверждений не считаются обрезкой', () => {
    const draft = parseDraft(JSON.stringify({ claims: modelClaims(20) }));
    expect(draft.claims).toHaveLength(20);
    expect(draft.openQuestions).toBe(0);
  });

  it('ошибка схемы за пределом лимита по-прежнему отвергает весь черновик', () => {
    expect(() => parseDraft(JSON.stringify({ claims: [...modelClaims(20), { text: 123 }] }))).toThrow('claim is not an object with text');
  });

  it('дата только в имени документа не подтверждает запрошенную дату', () => {
    const claim: IDraftClaim = { claimId: 'c1', text: evidence.text, kind: 'fact', evidenceIds: ['E1'] };
    const answer = render([evidence], [claim], 'Проследи историю стоимости КП 19.04.2027.');
    expect(answer.claims[0]?.shown).toBe(true);
    expect(answer.missingDates).toEqual(['19.04.2027']);
    expect(answer.partial).toBe(true);
    expect(answer.outcome).toBe('insufficient');
  });

  it('дата в тексте процитированного основания покрывает дату вопроса', () => {
    const item = { ...evidence, documentTitle: 'КП.pdf', text: 'Предложение направлено 19.04.2027. Стоимость предложения составляет 90 рублей.' };
    const claim: IDraftClaim = { claimId: 'c1', text: item.text, kind: 'fact', evidenceIds: ['E1'] };
    const answer = render([item], [claim], 'Проследи историю стоимости КП 19.04.2027.');
    expect(answer.missingDates).toEqual([]);
    expect(answer.partial).toBe(false);
  });

  it('дата в непроцитированном основании не покрывает дату вопроса', () => {
    const other = { ...evidence, label: 'E2', fragmentId: 'f2', text: 'Предложение направлено 19.04.2027.' };
    const claim: IDraftClaim = { claimId: 'c1', text: evidence.text, kind: 'fact', evidenceIds: ['E1'] };
    const answer = render([evidence, other], [claim], 'Проследи историю стоимости КП 19.04.2027.');
    expect(answer.missingDates).toEqual(['19.04.2027']);
    expect(answer.partial).toBe(true);
  });
});
