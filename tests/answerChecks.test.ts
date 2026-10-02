// Этап 08a: числовой гейт и проверки утверждений — перенос тестов Locus `tests/claim-checks.test.mjs` и
// `tests/answer-draft.test.mjs` (HEAD 33c6bcf) на перенесённый код. Ожидания донора сохранены; отличия Контура
// помечены «Контур:» — строгая схема черновика (ADR-009 §2), неизвестная ссылка — ложная цитата, письменное
// основание (AD-08a-7), признак редакции из пакета (AD-08a-1).
import { describe, expect, it } from 'vitest';
import {
  factsForPlan,
  markVersions,
  buildPacket,
  checkClaim,
  compareQuantities,
  DraftParseError,
  extractQuantities,
  normalizeEvidenceLabel,
  parseDraft,
  parseVerdict,
  planQuestion,
  renderVerifiedAnswer,
  retrievalQuery,
  stripInlineEvidenceLabels,
  type ClaimKind,
  type IFragmentFact,
  type IPacketCandidate,
  type IPacketItem,
} from '../packages/core/src/index.ts';

const units = (text: string) => extractQuantities(text).map((q) => `${q.unit}:${q.value}`);

describe('числовой гейт (перенос Locus claim-numbers)', () => {
  it('единицы, даты, доли; коды и ссылки на пункты числами не считаются', () => {
    expect(units('Цена 245 000 000 (двести сорок пять миллионов) рублей, НДС 20%.')).toEqual(['currency:245000000', 'percent:20']);
    expect(units('в течение 30 календарных дней, 10 рабочих дней, 15 банковских дней')).toEqual(['day:30', 'day:10', 'day:15']);
    expect(units('5 лет (60 месяцев), не менее 24 месяцев, 2 недели')).toEqual(['year:5', 'month:60', 'month:24', 'week:2']);
    expect(units('Окончание: 30.11.2026; подписан 1 марта 2026 года; в 2026 году')).toEqual(['date:2026-11-30', 'date:2026-03-01', 'calendar_year:2026']);
    expect(units('пени 1/300 ключевой ставки')).toEqual(['fraction:1/300']);
    expect(units('245 млн руб. и 1,5 тыс. рублей')).toEqual(['currency:245000000', 'currency:1500']);
    expect(units('цена 245 млн, 3 млрд руб.')).toEqual(['number:245000000', 'currency:3000000000']);
    expect(units('бетон B30 W8 F150, акты КС-2, договор № 15-П, п. 3.1, статья 719, ДС №1')).toEqual([]);
    expect(units('245 000 000 рублей')).toEqual(['currency:245000000']);
  });

  it('отсутствующее значение отличается от того же значения с другой единицей', () => {
    const evidence = ['Удержание 3% от стоимости работ.', 'Возврат в течение 30 календарных дней.', 'Гарантийный срок 5 лет.'];
    const status = (claim: string) => compareQuantities(claim, evidence).map((i) => i.status);
    expect(status('Удержание 3%, возврат через 30 дней')).toEqual(['ok', 'ok']);
    expect(status('Возврат в течение 3 лет')).toEqual(['unit_mismatch']);
    expect(status('Удержание 3 000 000 рублей')).toEqual(['missing']);
    expect(status('Гарантийный срок 60 месяцев')).toEqual(['ok']);
    expect(compareQuantities('Итого 244 800 000 рублей', ['| 12 | Итого по смете | 244 800 000 |']).map((i) => i.status)).toEqual(['ok']);
  });

  it('денежные сокращения без слова валюты — та же сумма', () => {
    const status = (claim: string, ev: string) => compareQuantities(claim, [ev]).map((i) => i.status);
    expect(status('Цена договора составляет 245 млн.', 'Цена договора составляет 245 млн руб.')).toEqual(['ok']);
    expect(status('Цена договора составляет 245 млн.', '2.1. Цена договора составляет 245 000 000 (двести сорок пять миллионов) рублей.')).toEqual(['ok']);
    expect(status('Цена договора составляет 245 000 000 рублей.', 'Цена договора 245 млн')).toEqual(['ok']);
    expect(status('Цена договора составляет 250 млн.', 'Цена договора составляет 245 млн руб.')).toEqual(['missing']);
  });
});

const item = (label: string, text: string, o: Partial<IPacketItem> = {}): IPacketItem => ({
  label,
  fragmentId: `00000000-0000-4000-8000-00000000000${label.slice(1)}`,
  text,
  origin: 'document_text',
  sourceUnitId: 'u1',
  documentKey: 'd1',
  versionNote: 'current',
  reason: 'search:1',
  ...o,
});
const RETENTION = item('E1', '5.1. Заказчик удерживает гарантийное удержание в размере 3% от стоимости выполненных работ.');
const RETURN_TERM = item('E2', '5.2. Сумма гарантийного удержания возвращается в течение 30 календарных дней после истечения гарантийного срока.');
const OLD_ADVANCE = item('E3', '3.1. Аванс в размере 20% от цены договора.', { versionNote: 'superseded' });
const NEW_ADVANCE = item('E4', 'Пункт 3.1 изложить в новой редакции: аванс в размере 10% от цены договора.', { documentKey: 'd2' });
const PRICE = item('E5', '2.1. Цена договора составляет 245 000 000 рублей.', { versionNote: 'conflict' });
const OTHER_UNIT = item('E6', '3.1. Аванс составляет 30% от цены договора.', { sourceUnitId: 'u2' });
const NO_TARGET = item('E7', 'Текст', { fragmentId: '' });
const MODEL_DESCRIPTION = item('E8', 'Описание модели: аванс 30% от цены договора.', { origin: 'model_description' });
const SPEECH = item('E9', 'Аванс будет 15 процентов, обсудим.', { origin: 'negotiation_speech' });
const evidenceById = new Map([RETENTION, RETURN_TERM, OLD_ADVANCE, NEW_ADVANCE, PRICE, OTHER_UNIT, NO_TARGET, MODEL_DESCRIPTION, SPEECH].map((i) => [i.label, i]));
const check = (text: string, kind: ClaimKind, evidenceIds: string[], o: { versionPolicy?: 'current' | 'historical' | 'all'; allowed?: Set<string> | null } = {}) =>
  checkClaim({ claimId: 'c1', text, kind, evidenceIds }, { evidenceById, allowedSourceUnitIds: o.allowed === undefined ? new Set(['u1']) : o.allowed, versionPolicy: o.versionPolicy ?? 'current' });
const codes = (r: ReturnType<typeof check>) => r.issues.map((i) => i.code);

describe('проверки утверждения (перенос Locus claim-checks)', () => {
  it('3% против 30 дней, 3 года против 30 дней, сумма против процента', () => {
    expect(check('Гарантийное удержание составляет 3% от стоимости выполненных работ.', 'percentage', ['E1']).passed).toBe(true);
    expect(check('Удержание возвращается в течение 30 календарных дней после истечения гарантийного срока.', 'period', ['E2']).passed).toBe(true);
    const percentAsTerm = check('Срок возврата гарантийного удержания — 3%.', 'period', ['E1', 'E2']);
    expect(percentAsTerm.status).toBe('contradicted');
    expect(codes(percentAsTerm)).toContain('type_mismatch');
    const daysAsSize = check('Гарантийное удержание составляет 30 дней.', 'percentage', ['E2']);
    expect(daysAsSize.status).toBe('contradicted');
    expect(codes(daysAsSize)).toContain('type_mismatch');
    const yearsVsDays = check('Удержание возвращается в течение 3 лет.', 'period', ['E2']);
    expect(yearsVsDays.passed).toBe(false);
    expect(codes(yearsVsDays)).toContain('number_not_in_evidence');
    const amountVsPercent = check('Гарантийное удержание составляет 3 рубля.', 'amount', ['E1']);
    expect(amountVsPercent.status).toBe('contradicted');
    expect(codes(amountVsPercent)).toContain('unit_mismatch');
    expect(codes(check('Гарантийное удержание составляет 3 000 000 рублей.', 'amount', ['E1']))).toContain('number_not_in_evidence');
    const percentAsAmount = check('Сумма аванса составляет 10% от цены договора.', 'amount', ['E4']);
    expect(percentAsAmount.status).toBe('contradicted');
    expect(codes(percentAsAmount)).toContain('type_mismatch');
    expect(codes(check('Пени составляют 1/300 ключевой ставки.', 'amount', ['E1']))).toContain('type_mismatch');
    expect(check('Цена договора составляет 245 000 000 рублей, в том числе НДС 20%.', 'amount', ['E5']).issues.some((i) => i.code === 'type_mismatch')).toBe(false);
    const bareVsPercent = check('Сумма аванса составляет 10.', 'amount', ['E4']);
    expect(bareVsPercent.status).toBe('contradicted');
    expect(codes(bareVsPercent)).toContain('unit_mismatch');
    expect(codes(check('Сумма удержания составляет 30.', 'amount', ['E2']))).toContain('unit_mismatch');
    expect(compareQuantities('Пени 300', ['Пени 1/300 ключевой ставки']).map((e) => e.status)).toEqual(['missing']);
    expect(compareQuantities('Итого 244 800 000', ['| 12 | Итого по смете | 244 800 000 |']).map((e) => e.status)).toEqual(['ok']);
    expect(compareQuantities('Итого 245 000 000', ['Цена 245 000 000 рублей']).map((e) => e.status)).toEqual(['ok']);
    const mixed = 'Аванс составляет 10% от цены договора, банковская комиссия — 10 рублей.';
    expect(compareQuantities('Сумма аванса составляет 10.', [mixed]).map((e) => e.status)).toEqual(['ambiguous']);
    expect(compareQuantities('Комиссия составляет 10 рублей.', [mixed]).map((e) => e.status)).toEqual(['ok']);
    expect(compareQuantities('Аванс составляет 10%.', [mixed]).map((e) => e.status)).toEqual(['ok']);
    const ambiguous = checkClaim(
      { claimId: 'c1', text: 'Сумма аванса составляет 10.', kind: 'amount', evidenceIds: ['E1'] },
      { evidenceById: new Map([['E1', item('E1', mixed)]]), allowedSourceUnitIds: new Set(['u1']), versionPolicy: 'current' },
    );
    expect(ambiguous.passed).toBe(false);
    expect(ambiguous.issues.map((i) => i.code)).toContain('ambiguous_number');
  });

  it('слово срока, которое не подписывает значение, — не ошибка типа', () => {
    const penalty = checkClaim(
      { claimId: 'c1', text: 'Неустойка за нарушение срока окончания работ — 0,1% от цены договора за каждый день просрочки.', kind: 'percentage', evidenceIds: ['E1'] },
      {
        evidenceById: new Map([['E1', item('E1', '7.1. За нарушение срока окончания работ Генподрядчик уплачивает неустойку в размере 0,1% от цены договора за каждый день просрочки.')]]),
        allowedSourceUnitIds: new Set(['u1']),
        versionPolicy: 'current',
      },
    );
    expect(penalty.passed, JSON.stringify(penalty.issues)).toBe(true);
    expect(codes(check('Удержание возвращается в течение 3%.', 'fact', ['E1']))).toContain('type_mismatch');
  });

  it('допсоглашение: заменённое значение как действующее — противоречие; как история — допустимо', () => {
    const stale = check('Аванс составляет 20% от цены договора.', 'percentage', ['E3']);
    expect(stale.status).toBe('contradicted');
    expect(codes(stale)).toContain('superseded_evidence');
    expect(check('Ранее аванс составлял 20% от цены договора.', 'percentage', ['E3']).passed).toBe(true);
    expect(check('Аванс составлял 20%, ДС изменило его на 10%.', 'comparison', ['E3', 'E4']).passed).toBe(true);
    expect(check('Аванс составляет 20% от цены договора.', 'percentage', ['E3'], { versionPolicy: 'historical' }).passed).toBe(true);
    expect(check('Аванс составляет 10% от цены договора.', 'percentage', ['E4']).passed).toBe(true);
  });

  it('R08a-01: текущая цитата рядом не снимает запрет — перекрытое основание не подтверждает действующее значение', () => {
    // Сценарий Review 08a-1: E1 — старая редакция (30 дней, перекрыта), E2 — новая редакция пункта 3.1 (90 дней).
    const old = item('E1', 'Срок оплаты составляет 30 дней.', { versionNote: 'superseded' });
    const fresh = item('E2', 'Пункт 3.1 изложить в новой редакции: срок оплаты составляет 90 дней.', { documentKey: 'd2' });
    const ctx = (versionPolicy: 'current' | 'historical' | 'all') => ({ evidenceById: new Map([old, fresh].map((i) => [i.label, i])), allowedSourceUnitIds: new Set(['u1']), versionPolicy });
    const mixed = checkClaim({ claimId: 'c1', text: 'Действующий срок оплаты составляет 30 дней.', kind: 'period', evidenceIds: ['E1', 'E2'] }, ctx('current'));
    expect(mixed.passed).toBe(false);
    expect(mixed.status).toBe('contradicted');
    expect(mixed.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['superseded_evidence', 'number_not_in_evidence']));
    // Верное значение с лишней ссылкой на перекрытую редакцию тоже отклоняется: старое основание не подтверждает текущее.
    expect(checkClaim({ claimId: 'c1', text: 'Срок оплаты составляет 90 дней.', kind: 'period', evidenceIds: ['E1', 'E2'] }, ctx('current')).issues.map((i) => i.code)).toEqual(['superseded_evidence']);
    expect(checkClaim({ claimId: 'c1', text: 'Срок оплаты составляет 90 дней.', kind: 'period', evidenceIds: ['E2'] }, ctx('current')).passed).toBe(true);
    // История и вопрос о прежней редакции — допустимы.
    expect(checkClaim({ claimId: 'c1', text: 'Ранее срок оплаты составлял 30 дней, теперь — 90 дней.', kind: 'comparison', evidenceIds: ['E1', 'E2'] }, ctx('current')).passed).toBe(true);
    expect(checkClaim({ claimId: 'c1', text: 'Срок оплаты составлял 30 дней.', kind: 'period', evidenceIds: ['E1', 'E2'] }, ctx('historical')).passed).toBe(true);
    // Отрисовка: смешанное утверждение не показывается, ответ не «подтверждён».
    const claims = [{ claimId: 'c1', text: 'Действующий срок оплаты составляет 30 дней.', kind: 'period' as const, evidenceIds: ['E1', 'E2'] }];
    const r = renderVerifiedAnswer({ claims, checks: new Map([['c1', mixed]]), items: [old, fresh], level: 'hard_checks' });
    expect(r.outcome).toBe('insufficient');
    expect(r.answer).not.toContain('30 дней');
  });

  it('цитаты обязаны существовать, лежать в области и указывать на фрагмент', () => {
    expect(codes(check('Удержание 3%.', 'percentage', []))).toEqual(['missing_evidence']);
    expect(codes(check('Удержание 3%.', 'percentage', ['E99']))).toContain('unknown_evidence');
    expect(codes(check('Аванс составляет 30% от цены договора.', 'percentage', ['E6']))).toContain('out_of_scope');
    expect(check('Аванс составляет 30% от цены договора.', 'percentage', ['E6'], { allowed: null }).passed).toBe(true);
    expect(codes(check('Текст', 'fact', ['E7']))).toContain('no_citation_target');
  });

  it('утверждение по основанию с расхождением помечается конфликтом, но не отклоняется', () => {
    const r = check('Цена договора составляет 245 000 000 рублей.', 'amount', ['E5']);
    expect(r.passed).toBe(true);
    expect(r.conflict).toBe(true);
  });

  it('Контур (AD-08a-7): описание модели и речь переговоров не подтверждают ни число, ни факт', () => {
    expect(codes(check('Аванс составляет 30% от цены договора.', 'percentage', ['E8']))).toContain('non_documentary_basis');
    expect(codes(check('Аванс составит 15 процентов.', 'percentage', ['E9']))).toContain('non_documentary_basis');
    // Описание модели рядом с письменным основанием число не подтверждает: 30% нет в письменном тексте.
    expect(codes(check('Аванс составляет 30% от цены договора.', 'percentage', ['E1', 'E8']))).toContain('number_not_in_evidence');
  });
});

describe('черновик и проверяющий (перенос Locus answer-draft)', () => {
  it('разбор: ответ в ограждении и с размышлением, нормализация меток, видов и дублей', () => {
    const draft = parseDraft(
      `<think>план</think>\n\`\`\`json\n${JSON.stringify({
        claims: [
          { claim_id: 'x', text: ' Аванс  10% ', kind: 'percentage', evidence_ids: ['[E1]', 'e2', '3', 'E1', 'bad'] },
          { claim_id: 'y', text: 'аванс 10%', kind: 'percentage', evidence_ids: ['E1'] },
          { claim_id: 'z', text: 'Срок 30 дней', kind: 'unknown', evidence_ids: ['E2'] },
          { claim_id: 'w', text: '', kind: 'fact', evidence_ids: ['E1'] },
        ],
        summary: 'Итог',
        open_questions: ['Нет ДС'],
      })}\n\`\`\``,
    );
    // Контур: «bad» — не метка и не фрагмент пакета; сохраняется как неизвестная ссылка (ложная цитата).
    expect(draft.claims).toEqual([
      { claimId: 'c1', text: 'Аванс 10%', kind: 'percentage', evidenceIds: ['E1', 'E2', 'E3', '?bad'] },
      { claimId: 'c2', text: 'Срок 30 дней', kind: 'fact', evidenceIds: ['E2'] },
    ]);
    expect(draft.openQuestions).toBe(1);
    expect(normalizeEvidenceLabel('Е4')).toBe('E4');
  });

  it('не JSON, JSON без claims и нарушение схемы — отказ черновика', () => {
    expect(() => parseDraft('Аванс 10% [1].')).toThrow(DraftParseError);
    expect(() => parseDraft('{"claims": [}')).toThrow(DraftParseError);
    expect(() => parseDraft('{"summary": "x"}')).toThrow(DraftParseError);
    // Контур: строгая схема (ADR-009 §2) — evidence_ids строкой, утверждение не объектом — отказ, без частичного сохранения.
    expect(() => parseDraft(JSON.stringify({ claims: [{ text: 'Срок 30 дней', evidence_ids: 'E2' }] }))).toThrow(DraftParseError);
    expect(() => parseDraft(JSON.stringify({ claims: ['Аванс 10%'] }))).toThrow(DraftParseError);
  });

  it('Контур: ID фрагмента вместо метки принимается, только если фрагмент есть в пакете', () => {
    const inPacket = '11111111-1111-4111-8111-111111111111';
    const outside = '22222222-2222-4222-8222-222222222222';
    const draft = parseDraft(JSON.stringify({ claims: [{ text: 'Аванс 10%', kind: 'percentage', evidence_ids: [inPacket, outside] }] }), new Map([[inPacket, 'E4']]));
    expect(draft.claims[0]!.evidenceIds).toEqual(['E4', `?${outside}`]);
  });

  it('метки, вписанные моделью в текст, переходят в ссылки', () => {
    expect(stripInlineEvidenceLabels('ГУ проекта является ООО «СЗ Балчуг эстейт». E1, E3, E5.')).toEqual({ text: 'ГУ проекта является ООО «СЗ Балчуг эстейт»', labels: ['E1', 'E3', 'E5'] });
    expect(stripInlineEvidenceLabels('Аванс составляет 10% от цены договора (E2).')).toEqual({ text: 'Аванс составляет 10% от цены договора', labels: ['E2'] });
    expect(stripInlineEvidenceLabels('Срок 30 дней [E1][E4]')).toEqual({ text: 'Срок 30 дней', labels: ['E1', 'E4'] });
    for (const text of ['Гарантийный срок 5 лет', 'Аванс 20% от цены договора.', 'Объект Е5 корпус 2 сдан', 'Бетон B30 W8 F150']) expect(stripInlineEvidenceLabels(text).labels, text).toEqual([]);
  });

  it('проверяющий: пропущенный вердикт никогда не становится «подтверждено»', () => {
    const parsed = parseVerdict(
      JSON.stringify({
        overall: 'pass',
        claims: [
          { claim_id: 'c1', status: 'supported', supported_by: ['E2', 'x'], issues: [] },
          { claim_id: 'c9', status: 'supported', supported_by: [], issues: [] },
          { claim_id: 'c2', status: 'maybe', supported_by: [], issues: ['?'] },
        ],
        conflicts: [{ evidence_ids: ['E1', 'E3'], note: 'разные суммы' }, { evidence_ids: ['E1'], note: 'одна' }],
      }),
      ['c1', 'c2', 'c3'],
    );
    expect(parsed.verdicts.get('c1')).toEqual({ status: 'supported', supportedBy: ['E2'] });
    expect(parsed.verdicts.get('c2')!.status).toBe('ambiguous');
    expect(parsed.verdicts.get('c3')!.status).toBe('ambiguous');
    expect(parsed.verdicts.has('c9')).toBe(false);
    expect(parsed.conflicts).toEqual([{ evidenceIds: ['E1', 'E3'] }]);
    expect(parseVerdict('{"overall": "whatever", "claims": []}', []).overall).toBe('repair');
  });
});

describe('отрисовка (перенос Locus answer-renderer)', () => {
  const items = [RETENTION, RETURN_TERM, OLD_ADVANCE, NEW_ADVANCE, PRICE];
  const byLabel = new Map(items.map((i) => [i.label, i]));
  const ctx = { evidenceById: byLabel, allowedSourceUnitIds: new Set(['u1']), versionPolicy: 'current' as const };
  const claims = [
    { claimId: 'c1', text: 'Удержание 3% от стоимости работ.', kind: 'percentage' as const, evidenceIds: ['E1', 'E2'] },
    { claimId: 'c2', text: 'Аванс составляет 20% от цены договора.', kind: 'percentage' as const, evidenceIds: ['E3'] },
    { claimId: 'c3', text: 'Удержание возвращается в течение 30 календарных дней.', kind: 'period' as const, evidenceIds: ['E2'] },
  ];
  const checks = new Map(claims.map((c) => [c.claimId, checkClaim(c, ctx)]));

  it('цитирует только показанные утверждения, сужает цитаты по проверяющему и перенумеровывает', () => {
    const verdicts = new Map([
      ['c1', { status: 'supported' as const, supportedBy: ['E1'] }],
      ['c3', { status: 'supported' as const, supportedBy: [] }],
    ]);
    const r = renderVerifiedAnswer({ claims, checks, verdicts, items, level: 'model' });
    expect(r.answer).toBe('- Удержание 3% от стоимости работ. [1]\n- Удержание возвращается в течение 30 календарных дней. [2]\n\nНе показано утверждений, не подтверждённых документами: 1.');
    expect(r.sources.map((s) => s.label)).toEqual(['E1', 'E2']);
    expect(r.outcome).toBe('confirmed');
    expect(r.claims.find((c) => c.claimId === 'c2')).toMatchObject({ shown: false, status: 'contradicted', issues: ['superseded_evidence'] });
  });

  it('без проверяющего — уровень «правила»; ничего не прошло — честное «не удалось подтвердить»', () => {
    const r = renderVerifiedAnswer({ claims: [claims[1]!], checks, items, level: 'hard_checks' });
    expect(r).toMatchObject({ outcome: 'insufficient', answer: 'Не удалось подтвердить ответ по имеющимся документам.', sources: [] });
  });

  it('Контур (AD-08a-8): разные величины одного вида из разных документов при вопросе об одном значении — расхождение', () => {
    const a = item('E1', 'Аванс составляет 30% от цены договора.', { documentKey: 'contract' });
    const b = item('E2', 'Аванс согласован в размере 20% от цены.', { documentKey: 'letter' });
    const cl = [
      { claimId: 'c1', text: 'Аванс составляет 30% от цены договора.', kind: 'percentage' as const, evidenceIds: ['E1'] },
      { claimId: 'c2', text: 'Аванс согласован в размере 20%.', kind: 'percentage' as const, evidenceIds: ['E2'] },
    ];
    const ev = new Map([a, b].map((i) => [i.label, i]));
    const ch = new Map(cl.map((c) => [c.claimId, checkClaim(c, { evidenceById: ev, allowedSourceUnitIds: null, versionPolicy: 'current' })]));
    const fact = renderVerifiedAnswer({ claims: cl, checks: ch, items: [a, b], level: 'hard_checks', plan: planQuestion('Какой аванс?') });
    expect(fact.outcome).toBe('conflict');
    expect(fact.answer).toContain('В документах есть расхождение по этому вопросу: сравните [1][2].');
    // Обзор: разные значения ожидаемы — расхождение величин не ищется.
    expect(renderVerifiedAnswer({ claims: cl, checks: ch, items: [a, b], level: 'hard_checks', plan: planQuestion('Какие основные условия договора?') }).outcome).toBe('confirmed');
  });
});

describe('пакет и признак редакции (граф фактов D-018, D-028)', () => {
  const cand = (id: string, text: string, o: Partial<IPacketCandidate> = {}): IPacketCandidate => ({
    fragmentId: id,
    text,
    origin: 'document_text',
    sourceUnitId: 'u',
    documentKey: 'main',
    ownerKey: 'contract:1',
    rank: 1,
    reason: 'search:1',
    ...o,
  });
  const main = cand('m31', '3.1. Аванс в размере 20% от цены договора.');
  const main32 = cand('m32', '3.2. Аванс перечисляется в течение 10 дней.', { rank: 2 });
  const ds1 = cand('a1', 'Пункт 3.1 договора изложить в новой редакции: «Аванс в размере 10% от цены договора».', { documentKey: 'ds1', rank: 3 });
  const fact = (factId: string, status: IFragmentFact['status'], factType = 'advance_percent'): IFragmentFact => ({ factId, factType, status });

  it('признак основания — из состояния фактов: перекрыт, конфликт, текущий; перекрытое — после действующих', () => {
    const marks = markVersions([main, main32, ds1], new Map([
      ['m31', [fact('f1', 'superseded')]],
      ['a1', [fact('f2', 'active')]],
    ]));
    expect(marks.get('m31')).toEqual({ note: 'superseded', reason: 'fact:advance_percent:superseded' });
    expect(marks.has('m32')).toBe(false);
    expect(marks.has('a1')).toBe(false);
    expect(buildPacket([main, main32, ds1], marks).map((i) => [i.label, i.fragmentId, i.versionNote])).toEqual([
      ['E1', 'm32', 'current'],
      ['E2', 'a1', 'current'],
      ['E3', 'm31', 'superseded'],
    ]);
    // Основание факта плана остаётся на своём месте (донор): заменённое значение — сразу за действующим, лимит его не отсекает.
    const hits = [cand('a1', ds1.text, { rank: -2, factHit: true, reason: 'fact:advance_percent:active' }), cand('m31', main.text, { rank: -1, factHit: true, reason: 'fact:advance_percent:superseded' }), main32];
    expect(buildPacket(hits, marks, 2).map((i) => [i.fragmentId, i.versionNote])).toEqual([
      ['a1', 'current'],
      ['m31', 'superseded'],
    ]);
    // Фрагмент, подтверждающий и перекрытый, и действующий факт, — не перекрыт; конфликт сильнее всего.
    expect(markVersions([main], new Map([['m31', [fact('f1', 'superseded'), fact('f3', 'active', 'advance_term')]]])).has('m31')).toBe(false);
    expect(markVersions([main], new Map([['m31', [fact('f1', 'superseded'), fact('f4', 'conflict')]]])).get('m31')?.note).toBe('conflict');
  });

  it('факты плана (донор factsForPlan): текущее, за ним заменённое; прежняя редакция — сначала старое; другая сторона цены', () => {
    const f = (factId: string, factType: string, status: IFragmentFact['status'], validFrom: string, supersededByFactId: string | null = null) => ({ factId, factType, status, validFrom, supersededByFactId, fragmentIds: [`frag-${factId}`] });
    const facts = [f('old', 'advance_percent', 'superseded', '2026-01-10', 'new'), f('new', 'advance_percent', 'active', '2026-03-01'), f('price', 'contract_price', 'conflict', '2026-01-10'), f('total', 'estimate_total', 'conflict', '2026-01-10')];
    expect(factsForPlan({ intent: 'fact', entities: ['advance_percent'], versionPolicy: 'current' }, facts).map((h) => h.fragmentId)).toEqual(['frag-new', 'frag-old']);
    expect(factsForPlan({ intent: 'fact', entities: ['advance_percent'], versionPolicy: 'historical' }, facts).map((h) => h.fragmentId)).toEqual(['frag-old', 'frag-new']);
    expect(factsForPlan({ intent: 'fact', entities: ['contract_price'], versionPolicy: 'current' }, facts).map((h) => h.reason)).toEqual(['fact:contract_price:conflict', 'fact:estimate_total:conflict']);
    expect(factsForPlan({ intent: 'overview', entities: [], versionPolicy: 'current' }, facts).map((h) => h.fragmentId)).toEqual(['frag-price', 'frag-new', 'frag-old']);
    expect(factsForPlan({ intent: 'fact', entities: [], versionPolicy: 'current' }, facts)).toEqual([]);
  });
});

describe('план вопроса (перенос Locus query-planner без выбора проекта)', () => {
  it('намерение, сущности, политика редакции, уточняющий вопрос и запрос поиска', () => {
    expect(planQuestion('Какой сейчас размер аванса?')).toMatchObject({ intent: 'fact', entities: ['advance_percent'], versionPolicy: 'current', followUp: false });
    expect(planQuestion('Какой был аванс до подписания допсоглашения?').versionPolicy).toBe('historical');
    expect(planQuestion('Как менялся аванс, все редакции').versionPolicy).toBe('all');
    expect(planQuestion('Какие основные условия договора?').intent).toBe('overview');
    expect(planQuestion('???').needsClarification).toBe(true);
    const turns = [{ question: 'Какой гарантийный срок по договору?', answer: 'Гарантийный срок 5 лет. [1]' }];
    expect(planQuestion('А удержание?', turns)).toMatchObject({ intent: 'follow_up', followUp: true });
    expect(planQuestion('А какой срок?', turns).entities).toEqual(['warranty_period']);
    expect(retrievalQuery('А какой гарантийный срок?', turns)).toBe('А какой гарантийный срок?\nКакой гарантийный срок по договору?');
    expect(retrievalQuery('Какая цена договора по смете и договору?', turns)).toBe('Какая цена договора по смете и договору?');
  });
});
