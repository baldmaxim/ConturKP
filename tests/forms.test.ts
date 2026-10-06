// Ядро форм этапа 11 (D-031; проект §4, §5): схема forms/1, значения, применимость и обязательность, несовместимые
// варианты, список незавершённых, сверка полей одного смысла в одном контексте, перенос на новую ревизию, гейт
// цитат предложения модели. Демонстрационные формы — вымышленный текст в структуре реальных форм компании.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applicability,
  checkConsistency,
  contextOf,
  draftIssues,
  fieldMap,
  gateSuggestion,
  parseFormSuggestions,
  planMigration,
  schemaKeys,
  schemaSha256,
  validateSchema,
  validateValue,
  type FieldValue,
  type IFieldObservation,
  type IFieldStatus,
  type IFormSchema,
} from '../packages/core/src/index.ts';

const load = (name: string): IFormSchema => {
  const r = validateSchema(JSON.parse(readFileSync(`docs/forms/${name}.forms.json`, 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.schema;
};
const KEY = load('demo-key-conditions');
const KP = load('demo-kp-letter');
const F = fieldMap(KEY);

const statuses = (values: Record<string, FieldValue | null>, extra: Record<string, Partial<IFieldStatus>> = {}): Map<string, IFieldStatus> =>
  new Map(Object.entries(values).map(([k, v]) => [k, { value: v, state: v === null ? null : 'accepted', stale: false, ...extra[k] }]));

const FILLED: Record<string, FieldValue | null> = {
  price_kind: 'firm',
  estimate_units: 'Сметы составляются по этажам и секциям.',
  site_upkeep_month: '25',
  duration_months: '32',
  advance_percent: '30',
  advance_security: 'none',
  compensation_mechanism: 'inflation',
  inflation_threshold: '5',
  methodology_variant: 'inflation_only',
  warranty_months: '36',
};

describe('схема forms/1', () => {
  it('демо-формы проходят проверку; ключи и безусловно обязательные поля — для второй линии БД; отпечаток не зависит от пробелов', () => {
    expect(schemaKeys(KEY).requiredKeys).toEqual(['price_kind', 'estimate_units', 'site_upkeep_month', 'duration_months', 'advance_percent', 'compensation_mechanism', 'warranty_months']);
    expect(schemaSha256(KEY)).toBe(schemaSha256(JSON.parse(JSON.stringify(KEY, null, 4)) as IFormSchema));
  });

  it('повтор ключа, ссылка на неизвестное поле и цикл применимости отвергаются до утверждения', () => {
    const base = { schemaVersion: 'forms/1', title: 'т', sections: [{ key: 's', title: 'с', fields: [] as unknown[] }] };
    const dup = { ...base, sections: [{ key: 's', title: 'с', fields: [{ key: 'a', type: 'text', label: 'А' }, { key: 'a', type: 'text', label: 'Б' }] }] };
    const unknown = { ...base, sections: [{ key: 's', title: 'с', fields: [{ key: 'a', type: 'text', label: 'А', applicableWhen: { field: 'zz', op: 'notEmpty' } }] }] };
    const cycle = {
      ...base,
      sections: [{ key: 's', title: 'с', fields: [{ key: 'a', type: 'text', label: 'А', applicableWhen: { field: 'b', op: 'notEmpty' } }, { key: 'b', type: 'text', label: 'Б', applicableWhen: { field: 'a', op: 'notEmpty' } }] }],
    };
    const msg = (x: unknown) => {
      const r = validateSchema(x);
      return r.ok ? '' : r.issues.map((i) => i.message).join(' | ');
    };
    expect(msg(dup)).toMatch(/повторяется/u);
    expect(msg(unknown)).toMatch(/неизвестное поле/u);
    expect(msg(cycle)).toMatch(/цикл применимости: a → b → a|цикл применимости: b → a → b/u);
    expect(msg({ ...base, schemaVersion: 'forms/2' })).toMatch(/forms\/1/u);
  });
});

describe('значения и правила', () => {
  it('число — точная десятичная строка («2,5» → «2.5»), пределы и знаки; дата — календарная; вариант — из списка', () => {
    expect(validateValue(F.get('advance_percent')!, '2,5')).toEqual({ ok: true, value: '2.5' });
    expect(validateValue(F.get('advance_percent')!, '101').ok).toBe(false);
    expect(validateValue(F.get('advance_percent')!, '1.234').ok).toBe(false);
    expect(validateValue(F.get('duration_months')!, '1e3').ok).toBe(false);
    expect(validateValue(fieldMap(KP).get('letter_date')!, '2026-02-30').ok).toBe(false);
    expect(validateValue(F.get('price_kind')!, 'other').ok).toBe(false);
  });

  it('длинная формулировка: 50 000 символов кириллицы с переносами строк сохраняется без изменений; сверх предела — отказ', () => {
    const long = `${'Позиция заказчика по условию: согласовать в протоколе разногласий.\n'.repeat(800)}`.slice(0, 50000);
    expect([...long].length).toBe(50000);
    expect(validateValue(F.get('customer_notes')!, long)).toEqual({ ok: true, value: long });
    expect(validateValue(F.get('customer_notes')!, `${long}ж`).ok).toBe(false);
  });

  it('таблица: обязательная ячейка, лишняя колонка, предел строк', () => {
    const t = F.get('not_included')!;
    expect(validateValue(t, [{ item: 'Снос зданий', note: null }])).toEqual({ ok: true, value: [{ item: 'Снос зданий', note: null }] });
    expect(validateValue(t, [{ item: '' }]).ok).toBe(false);
    expect(validateValue(t, [{ item: 'а', extra: 'б' }]).ok).toBe(false);
    expect(validateValue(t, Array.from({ length: 301 }, () => ({ item: 'а' }))).ok).toBe(false);
  });

  it('условно применимое поле: порог инфляции нужен только при механизме с инфляцией; неприменимое не требуется', () => {
    const a = applicability(KEY, new Map(Object.entries({ ...FILLED, compensation_mechanism: 'basket', inflation_threshold: null })));
    expect(a.applicable.has('inflation_threshold')).toBe(false);
    expect(a.required.has('basket_corridor')).toBe(true);
    const b = applicability(KEY, new Map(Object.entries({ ...FILLED, compensation_mechanism: 'none' })));
    expect(b.applicable.has('methodology_variant')).toBe(false);
    // Условная обязательность: обеспечение аванса не требуется при нулевом авансе.
    expect(applicability(KEY, new Map(Object.entries({ ...FILLED, advance_percent: '0' }))).required.has('advance_security')).toBe(false);
  });
});

describe('список незавершённых пунктов', () => {
  it('обязательное поле, «требует обсуждения», «устарело», «перенесено», несовместимые варианты; пустой список — у заполненной формы', () => {
    expect(draftIssues(KEY, statuses(FILLED), [], 'd1').filter((i) => i.blocking)).toEqual([]);
    const issues = draftIssues(
      KEY,
      statuses(
        { ...FILLED, duration_months: null, methodology_variant: 'basket_only', retention_percent: '2', payment_days: '10' },
        { retention_percent: { stale: true }, payment_days: { state: 'carried_over' }, site_upkeep_month: { state: 'needs_discussion', comment: 'уточнить сумму', responsibleName: 'Инженер 1' } },
      ),
      [],
      'd1',
    );
    expect(issues.map((i) => [i.kind, i.fieldKey ?? i.label])).toEqual([
      ['required_empty', 'duration_months'],
      ['constraint', 'methodology_matches_mechanism'],
      ['stale', 'retention_percent'],
      ['carried_over', 'payment_days'],
      ['needs_discussion', 'site_upkeep_month'],
    ]);
    expect(issues.find((i) => i.kind === 'needs_discussion')!.message).toBe('требует обсуждения (ответственный — Инженер 1): уточнить сумму');
    expect(draftIssues(KEY, statuses({ ...FILLED, advance_percent: '0', advance_security: 'bank_guarantee' }), [], 'd1').map((i) => i.label)).toContain('advance_security_zero');
  });
});

describe('сверка полей одного смысла (D-031 В-11-6, В-11-7)', () => {
  const obs = (draftId: string, schema: IFormSchema, key: string, value: FieldValue | null, values: Record<string, FieldValue | null> = {}): IFieldObservation => {
    const f = fieldMap(schema).get(key)!;
    return {
      draftId,
      draftTitle: draftId,
      fieldKey: key,
      label: f.label,
      type: f.type,
      unit: f.type === 'number' ? (f.unit ?? null) : null,
      groupKeys: f.meaning ? [f.meaning] : [],
      context: contextOf(f, (k) => values[k] ?? null),
      value,
    };
  };

  it('одинаковый контекст: разные значения — противоречие; равные (30 и 30.00) — нет; позиция заказчика — другой предмет', () => {
    const found = checkConsistency([obs('КУ', KEY, 'advance_percent', '30'), obs('КП', KP, 'advance_percent', '20'), obs('КУ', KEY, 'customer_advance_percent', '10')]);
    expect(found.map((x) => [x.kind, x.a.draftId, x.b?.draftId, x.reason])).toEqual([['contradiction', 'КУ', 'КП', 'значения различаются']]);
    expect(checkConsistency([obs('КУ', KEY, 'advance_percent', '30'), obs('КП', KP, 'advance_percent', '30.00')])).toEqual([]);
  });

  it('неизвестное — не совпадение: пустое значение одной стороны — «не сверено»; разная единица — не сравнивается', () => {
    const found = checkConsistency([obs('КУ', KEY, 'warranty_months', '36'), obs('КП', KP, 'warranty_months', null)]);
    expect(found.map((x) => [x.kind, x.reason])).toEqual([['unverified', 'значение одного из полей неизвестно']]);
    const months = obs('КУ', KEY, 'warranty_months', '36');
    expect(checkConsistency([months, { ...obs('КП', KP, 'warranty_months', '3'), context: { ...months.context, unit: 'лет' } }])).toEqual([]);
  });

  it('факт того же смысла: расхождение — противоречие, совпадение — нет, факт в конфликте — «не сверено»', () => {
    const fact = (text: string, status: 'active' | 'conflict' = 'active') => ({ groupKey: 'fact:advance_percent', kind: 'fact' as const, id: 'f1', title: 'Размер аванса', text, status });
    expect(checkConsistency([obs('КУ', KEY, 'advance_percent', '30')], [fact('Аванс составляет 30% от цены')])).toEqual([]);
    expect(checkConsistency([obs('КУ', KEY, 'advance_percent', '30')], [fact('Аванс составляет 20% от цены')]).map((x) => x.kind)).toEqual(['contradiction']);
    expect(checkConsistency([obs('КУ', KEY, 'advance_percent', '30')], [fact('Аванс 30%', 'conflict')]).map((x) => x.kind)).toEqual(['unverified']);
  });

  it('противоречие попадает в список незавершённых обоих приложений и блокирует «заполнено»', () => {
    const found = checkConsistency([obs('КУ', KEY, 'advance_percent', '30'), obs('КП', KP, 'advance_percent', '20')]);
    const issues = draftIssues(KEY, statuses(FILLED), found, 'КУ');
    expect(issues.filter((i) => i.blocking).map((i) => [i.kind, i.message])).toEqual([['contradiction', 'противоречие — «Общий аванс» в приложении «КП»: значения различаются']]);
  });
});

describe('перенос на новую ревизию (D-031 В-11-8)', () => {
  it('значения по ключу и типу переносятся; изменения подписи, единицы, вариантов и применимости показываются; несовместимые — в отчёте', () => {
    const next = JSON.parse(JSON.stringify(KEY)) as IFormSchema;
    const sec = (k: string) => next.sections.find((s) => s.key === k)!;
    const f = (s: string, k: string) => sec(s).fields.find((x) => x.key === k)! as unknown as Record<string, unknown>;
    f('general', 'duration_months').label = 'Срок строительства до ЗОС';
    f('payments', 'payment_days').unit = 'кал. дн.';
    (f('general', 'price_kind').options as { value: string; label: string }[]).pop();
    f('warranty', 'warranty_finishing_months').type = 'text';
    f('compensation', 'inflation_threshold').applicableWhen = { field: 'compensation_mechanism', op: 'eq', value: 'inflation' };
    sec('lists').fields = sec('lists').fields.filter((x) => x.key !== 'attention');
    sec('lists').fields.push({ key: 'nominated', type: 'text', label: 'Номинированные поставщики', required: true });
    const plan = planMigration(KEY, next, new Map(Object.entries({ ...FILLED, payment_days: '10', warranty_finishing_months: '24', attention: [{ item: 'Класс бетона' }], price_kind: 'approximate' })));
    const carried = Object.fromEntries(plan.carried.map((c) => [c.key, c.changes.map((x) => x.kind)]));
    expect(carried.duration_months).toEqual(['label']);
    expect(carried.payment_days).toEqual(['unit']);
    expect(carried.inflation_threshold).toEqual(['applicability']);
    expect(plan.dropped.map((d) => [d.key, d.reason])).toEqual([
      ['price_kind', 'invalid'],
      ['warranty_finishing_months', 'type_changed'],
      ['attention', 'removed'],
    ]);
    expect(plan.added).toEqual([{ key: 'nominated', label: 'Номинированные поставщики', required: true }]);
  });
});

describe('гейт цитат предложения модели (D-031 В-11-5)', () => {
  const input = {
    fieldKey: 'advance_percent',
    label: 'Общий аванс',
    type: 'number' as const,
    help: null,
    unit: '%',
    options: null,
    fragments: [
      { label: 'E1', fragmentId: 'f1', origin: 'recognized_text', text: 'Заказчик выплачивает аванс в размере 30% от цены договора.' },
      { label: 'E2', fragmentId: 'f2', origin: 'negotiation_hint', text: 'Обсуждали аванс 40%.' },
    ],
  };
  const field = F.get('advance_percent')!;

  it('дословная цитата письменного основания с тем же числом проходит', () => {
    const g = gateSuggestion(field, input, { value: '30', rationale: 'аванс из договора', citations: [{ evidence: 'E1', quote: 'аванс в размере 30% от цены' }] });
    expect(g).toMatchObject({ passed: true, value: '30', citations: [{ fragmentId: 'f1', quote: 'аванс в размере 30% от цены' }] });
  });

  it('ложная цитата, неписьменное основание, число не из цитаты и неизвестный фрагмент отвергаются', () => {
    const codes = (raw: { value: unknown; citations: unknown }) => gateSuggestion(field, input, { rationale: 'x', ...raw }).issues.map((i) => i.code);
    expect(codes({ value: '30', citations: [{ evidence: 'E1', quote: 'аванс в размере 30% без гарантии' }] })).toEqual(['quote_not_in_fragment']);
    expect(codes({ value: '40', citations: [{ evidence: 'E2', quote: 'аванс 40%' }] })).toEqual(['non_documentary']);
    expect(codes({ value: '35', citations: [{ evidence: 'E1', quote: 'аванс в размере 30% от цены' }] })).toEqual(['value_not_in_quote']);
    expect(codes({ value: '30', citations: [{ evidence: 'E9', quote: 'x' }] })).toEqual(['unknown_evidence']);
    expect(codes({ value: '30', citations: [] })).toEqual(['no_citation']);
  });

  it('разбор ответа: поле не из входа и повтор — отбрасываются; невалидный JSON — отказ', () => {
    const r = parseFormSuggestions(
      JSON.stringify({ fields: [{ fieldKey: 'advance_percent', value: '30', rationale: 'р', citations: [{ evidence: 'E1', quote: 'аванс в размере 30%' }] }, { fieldKey: 'advance_percent', value: '30' }, { fieldKey: 'zz', value: '1' }] }),
      { draftTitle: 'КУ', fields: [input] },
      F,
    );
    expect(r.ok && r.items.map((i) => [i.fieldKey, i.passed, i.issues.map((x) => x.code)])).toEqual([
      ['advance_percent', true, []],
      ['advance_percent', false, ['duplicate_field']],
      ['zz', false, ['unknown_field']],
    ]);
    expect(parseFormSuggestions('не json', { draftTitle: 'КУ', fields: [input] }, F)).toEqual({ ok: false });
  });
});
