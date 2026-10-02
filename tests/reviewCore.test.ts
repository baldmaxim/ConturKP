// Этап 09: ядро программных проверок без БД (packages/core/src/review). Сравнение параметра со строкой, количества и
// единицы (В-09-6), фразы неопределённости ПД, вид источника и предлагаемая сторона (В-09-1), конфликт фактов,
// итог прогона и сводка (I07, I18), разбор ответа модели (ADR-009).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_PRIORITY,
  FINDING_KIND_META,
  findingKey,
  hasPdUncertainty,
  normalizeUnit,
  parseHypotheses,
  quantityOf,
  REVIEW_CHECKS,
  reviewSummary,
  runRuleChecks,
  runStatusOf,
  sourceKindOf,
  suggestedSide,
  valueFoundIn,
  type IReviewInput,
} from '../packages/core/src/index.ts';

const empty = (o: Partial<IReviewInput> = {}): IReviewInput => ({
  priority: DEFAULT_SOURCE_PRIORITY,
  units: [{ scopeItemId: 'u1', unitType: 'document_recognition', label: 'ТЗ', technicalStatus: 'ok', runStatus: 'complete', pagesTotal: 1, pagesRecognized: 1, pagesFailed: 0 }],
  importsPending: 0,
  registry: { id: 'r1', passCompleted: true, unreviewed: 0, total: 1 },
  calculationRevisionId: 'c1',
  calcObjects: new Map(),
  positions: [],
  requirements: [],
  fragments: [],
  facts: [],
  factConflicts: [],
  newerRevisions: new Map(),
  questions: [],
  factsPendingUnits: 0,
  ...o,
});

describe('сравнение параметра со строкой расчёта (C04)', () => {
  it('«№1» ≠ «№2»; «№ 1» = «№1»; склонение слова не мешает', () => {
    expect(valueFoundIn('№1', ['Светильник светодиодный №2'])).toBe(false);
    expect(valueFoundIn('№ 2', ['Светильник светодиодный №2'])).toBe(true);
    expect(valueFoundIn('клинкерный кирпич', ['Облицовка фасада клинкерным кирпичом'])).toBe(true);
    expect(valueFoundIn('B30', ['Бетон B25'])).toBe(false);
  });
});

describe('количества и единицы (C06, D-029 В-09-6)', () => {
  it('количество — число с единицей измерения; иначе текстовый параметр', () => {
    expect(quantityOf({ name: 'Объём', value: '55', unit: 'м3' })).toEqual({ value: 55, unit: 'м3' });
    expect(quantityOf({ name: 'Объём', value: '1 250,5', unit: 'куб.м' })).toEqual({ value: 1250.5, unit: 'м3' });
    expect(quantityOf({ name: 'Тип', value: '№1', unit: null })).toBeNull();
    expect(quantityOf({ name: 'Срок', value: '30', unit: 'дней' })).toBeNull();
    expect(normalizeUnit('М²')).toBe('м2');
  });

  it('несопоставимые единицы — неопределённость (низкая уверенность), а не «пройдено»', () => {
    const input = empty({
      requirements: [
        {
          requirementId: 'q1',
          revisionId: 'v1',
          code: 'R-0001',
          parameters: [{ name: 'Объём', value: '10', unit: 'м3' }],
          supports: [{ fragmentId: 'f1', documentRevisionId: 'd1', sourceKind: 'tz' }],
          contradicts: [],
          fromContract: false,
          conflicts: [],
          conflictNote: null,
          coverage: { id: 'cv', state: 'covered', reason: null, unitMismatchReason: null, objects: [{ type: 'calculation_revision', calculationRevisionId: 'c1', externalPositionId: 'p1', externalItemId: 'l1', match: 'explicit_line', unitStatus: 'not_comparable' }] },
          hasAssumptionOrQuestion: false,
        },
      ],
      calcObjects: new Map([['c1|p1|l1', { texts: ['Бетон'], unit: 'т', quantity: 24 }]]),
    });
    const out = runRuleChecks(input);
    const f = out.findings.find((x) => x.kind === 'quantity_uncertain')!;
    expect(f.confidence).toBe('low');
    expect(out.results.find((r) => r.check === 'quantities')!.outcome).toBe('failed');
  });
});

describe('неопределённость ПД (C08, A06)', () => {
  it('фразы «уточняется в РД», «будет уточнено», «ориентировочно»', () => {
    expect(hasPdUncertainty('Марка бетона уточняется в РД.')).toBe(true);
    expect(hasPdUncertainty('Состав определяется рабочей документацией.')).toBe(true);
    expect(hasPdUncertainty('Объём будет уточнён после изысканий.')).toBe(true);
    expect(hasPdUncertainty('Ориентировочная площадь 500 м2.')).toBe(true);
    expect(hasPdUncertainty('Выполнить по РД шифр 12-КЖ.')).toBe(false);
    expect(hasPdUncertainty('Партия поставки уточняется заказчиком в письме.')).toBe(false);
  });
});

describe('приоритет источников (D-029 В-09-1)', () => {
  it('вид источника — по происхождению и документу; подсказка переговоров не источник', () => {
    expect(sourceKindOf({ origin: 'recognized_text', docType: 'tz', contractDocument: false })).toBe('tz');
    expect(sourceKindOf({ origin: 'recognized_text', docType: 'other', contractDocument: true })).toBe('contract');
    expect(sourceKindOf({ origin: 'qa_answer', docType: null, contractDocument: false })).toBe('qa_answer');
    expect(sourceKindOf({ origin: 'email_body', docType: null, contractDocument: false })).toBe('customer_letter');
    expect(sourceKindOf({ origin: 'negotiation_hint', docType: null, contractDocument: false })).toBeNull();
  });

  it('предлагаемая сторона — выше по приоритету; одного вида — не различает; дата не участвует', () => {
    expect(suggestedSide(DEFAULT_SOURCE_PRIORITY, 'customer_letter', 'contract')).toBe('right');
    expect(suggestedSide(DEFAULT_SOURCE_PRIORITY, 'tz', 'pd_rd')).toBe('left');
    expect(suggestedSide(DEFAULT_SOURCE_PRIORITY, 'qa_answer', 'qa_answer')).toBeNull();
    expect(suggestedSide(['pd_rd', 'tz', 'contract', 'qa_answer', 'customer_letter', 'minutes', 'negotiation_speech', 'other'], 'tz', 'pd_rd')).toBe('right');
  });

  it('конфликт фактов: обе стороны, предлагаемая сторона, ключ не зависит от порядка', () => {
    const facts = [
      { factId: 'a', factType: 'advance_percent' as const, status: 'conflict' as const, rawValue: '20%', fragmentIds: ['fa'], supersededByFactId: null, sourceKind: 'customer_letter' as const },
      { factId: 'b', factType: 'advance_percent' as const, status: 'conflict' as const, rawValue: '10%', fragmentIds: ['fb'], supersededByFactId: null, sourceKind: 'contract' as const },
    ];
    const one = runRuleChecks(empty({ facts, factConflicts: [{ factIds: ['a', 'b'] }] })).findings.find((f) => f.kind === 'source_conflict')!;
    const two = runRuleChecks(empty({ facts, factConflicts: [{ factIds: ['b', 'a'] }] })).findings.find((f) => f.kind === 'source_conflict')!;
    expect(one.key).toBe(two.key);
    expect(one.evidence.filter((e) => e.side === 'left').length).toBeGreaterThan(0);
    expect(one.evidence.filter((e) => e.side === 'right').length).toBeGreaterThan(0);
    expect(one.suggestedSide).toBe('right');
    expect(one.title).toMatch(/Размер аванса/u);
  });

  it('факты не извлечены — конфликты «неполно», а не «пройдено»', () => {
    const r = runRuleChecks(empty({ factsPendingUnits: 2 })).results.find((x) => x.check === 'source_conflicts')!;
    expect(r).toMatchObject({ outcome: 'incomplete', reason: 'факты не извлечены по единицам снимка — 2' });
  });
});

describe('итог и сводка (I07, I18)', () => {
  it('пустой снимок, нет реестра, нет расчёта — неполнота с причинами', () => {
    const out = runRuleChecks(empty({ units: [], registry: null, calculationRevisionId: null }));
    const by = Object.fromEntries(out.results.map((r) => [r.check, r]));
    expect(by.processing).toMatchObject({ outcome: 'incomplete', reason: 'снимок области пуст: проверять нечего' });
    expect(by.registry).toMatchObject({ outcome: 'incomplete' });
    expect(runStatusOf(out.results.map((r) => r.outcome))).toBe('completed_with_gaps');
    expect(out.results).toHaveLength(REVIEW_CHECKS.length - 1);
  });

  it('«замечаний нет» — только при полном прогоне без нерешённого, без гипотез, без принятого риска и при актуальных входах', () => {
    const base = { status: 'completed' as const, outcomes: ['passed' as const, 'not_applicable' as const], unsettledFindings: 0, acceptedRisks: 0, openSuggestions: 0, outdated: false };
    expect(reviewSummary(base).kind).toBe('clean');
    expect(reviewSummary({ ...base, status: 'running' }).kind).toBe('running');
    expect(reviewSummary({ ...base, status: 'completed_with_gaps', outcomes: ['incomplete'] }).kind).toBe('incomplete');
    expect(reviewSummary({ ...base, unsettledFindings: 1 }).kind).toBe('findings');
    expect(reviewSummary({ ...base, openSuggestions: 1 }).kind).toBe('findings');
    expect(reviewSummary({ ...base, acceptedRisks: 1 }).kind).toBe('risk_accepted');
    expect(reviewSummary({ ...base, outdated: true }).kind).toBe('outdated');
    expect(reviewSummary({ ...base, status: 'failed' }).kind).toBe('failed');
  });

  it('таблица критичности D-029: «критичное» — только человек; технические замечания риском не принимаются', () => {
    expect(Object.values(FINDING_KIND_META).some((m) => (m.severity as string | null) === 'critical')).toBe(false);
    expect(FINDING_KIND_META.stale_basis).toMatchObject({ severity: 'major', riskAcceptable: false });
    expect(FINDING_KIND_META.registry_incomplete).toMatchObject({ severity: 'major', riskAcceptable: false });
    expect(FINDING_KIND_META.customer_silence.severity).toBe('minor');
    expect(findingKey('coverage_gap', 'x')).not.toBe(findingKey('coverage_gap', 'y'));
  });
});

describe('ответ модели (ADR-009)', () => {
  it('ссылки только на вход; ложная цитата отбрасывается; не JSON — отказ', () => {
    const ok = parseHypotheses(
      JSON.stringify({ hypotheses: [
        { title: 'Нет молниезащиты', rationale: 'нет позиции', left: { fragmentId: 'f1' }, right: { positionId: 'p1' } },
        { title: 'Ложная', rationale: 'x', left: { fragmentId: 'zz' }, right: null },
        { title: 'Ложная справа', rationale: 'x', left: { fragmentId: 'f1' }, right: { positionId: 'pz' } },
      ] }),
      new Set(['f1']),
      new Set(['p1']),
    );
    expect(ok).toMatchObject({ ok: true, dropped: 2 });
    if (ok.ok) expect(ok.items).toEqual([expect.objectContaining({ title: 'Нет молниезащиты', leftFragmentId: 'f1', right: { positionId: 'p1' } })]);
    expect(parseHypotheses('нет', new Set(), new Set())).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseHypotheses('{"x":1}', new Set(), new Set())).toEqual({ ok: false, reason: 'schema_mismatch' });
  });
});
