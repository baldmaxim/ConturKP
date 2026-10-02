// Этап 08a, граф фактов D-018 (D-028): правила слоя фактов — перенос тестов Locus `tests/evidence-extraction.test.mjs`
// (HEAD 33c6bcf) на корпусе донора `tests/fixtures/locus-product-v2` и отличия Контура: явная связь 06a, решения
// человека как рёбра графа, факты прежней редакции документа, замечания для человека.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyDocument,
  computeFactGraph,
  extractDocumentFacts,
  FACT_TYPES,
  FACT_TYPE_META,
  type IExtractedFact,
  type IFactGraph,
  type IGraphDecision,
  type IGraphDocument,
  type IGraphFact,
} from '../packages/core/src/index.ts';

const ROOT = join(import.meta.dirname, 'fixtures', 'locus-product-v2');

// Markdown донора → фрагменты Контура: абзац — фрагмент, строка таблицы — фрагмент-строка; заголовок — первый фрагмент.
const spansOf = (md: string, prefix: string) => {
  const blocks: { text: string; tableRow: boolean }[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ text: paragraph.join(' '), tableRow: false });
    paragraph = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('|')) {
      flush();
      if (!/^\|\s*-+/u.test(line)) blocks.push({ text: line, tableRow: true });
    } else if (line === '') flush();
    else paragraph.push(line.replace(/^#+\s*/u, ''));
  }
  flush();
  return blocks.map((b, i) => ({ fragmentId: `${prefix}-f${i}`, ...b }));
};

interface IBuild {
  documents: IGraphDocument[];
  facts: (IGraphFact & IExtractedFact)[];
  graph: IFactGraph;
}

const doc = (id: string, md: string, title = `${id}.md`, o: Partial<IGraphDocument> = {}) => {
  const spans = spansOf(md, id);
  const cls = classifyDocument({ firstPage: spans.slice(0, 8).map((s) => s.text), documentTitle: title });
  const document: IGraphDocument = { documentId: id, ownerKey: 'tender:t1', kind: cls.kind, number: cls.number, documentDate: cls.documentDate, parentRef: cls.parentRef, explicit: null, ...o };
  const facts = extractDocumentFacts(spans).map((f, i) => ({ ...f, factId: `${id}-x${i}`, documentId: id }));
  return { document, facts, spans, cls };
};
const link = (parts: ReturnType<typeof doc>[], decisions: IGraphDecision[] = []): IBuild => {
  const documents = parts.map((p) => p.document);
  const facts = parts.flatMap((p) => p.facts);
  return { documents, facts, graph: computeFactGraph({ documents, facts, decisions }) };
};
const fixture = (project: string): IBuild => {
  const sources = (JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8')) as { sources: { id: string; path: string }[] }).sources;
  const dir = sources.find((s) => s.id === project)!.path.split('/').pop()!;
  const files = ['dogovor-15-p.md', 'ds-01-k-dogovoru-15-p.md', 'pismo-skan.md', 'smeta-stromynka.md', 'dogovor-7-rs.md', 'dogovor-b-44.md'];
  const parts = files.flatMap((file) => {
    try {
      const md = readFileSync(join(ROOT, dir, file), 'utf8');
      return [doc(file.replace(/\.md$/u, ''), md, file.replace(/\.md$/u, file.startsWith('smeta') ? '.xlsx' : '.pdf'))];
    } catch {
      return [];
    }
  });
  return link(parts);
};
const BASE = 'Договор подряда № 10 от 01.01.2026\n\n3.1. Аванс составляет 20% от цены договора.';
const factsOf = (b: IBuild, type: string, status = '') =>
  b.facts.filter((f) => f.factType === type && (!status || b.graph.facts.get(f.factId)!.status === status));
const state = (b: IBuild, f: IGraphFact) => b.graph.facts.get(f.factId)!;

describe('перечень и классификатор (D-028, перенос Locus document-classifier)', () => {
  it('13 типов D-018 по трём судьбам: 2 стороны, цена и смета, 9 кандидатов требований', () => {
    expect(FACT_TYPES).toHaveLength(13);
    const fates = Object.values(FACT_TYPE_META).map((m) => m.fate);
    expect(fates.filter((f) => f === 'contract_card')).toHaveLength(2);
    expect(fates.filter((f) => f === 'economics')).toHaveLength(2);
    expect(fates.filter((f) => f === 'requirement_candidate')).toHaveLength(9);
  });

  it('договор, допсоглашение со ссылкой на договор, смета, письмо, акт', () => {
    const c = (firstPage: string[], documentTitle = 'файл.pdf') => classifyDocument({ firstPage, documentTitle });
    expect(c(['Дополнительное соглашение № 2 от 01.07.2026 к договору подряда № 15-П от 10.02.2026', 'Текст'])).toEqual({
      kind: 'amendment',
      title: 'Дополнительное соглашение № 2 от 01.07.2026 к договору подряда № 15-П от 10.02.2026',
      number: '2',
      documentDate: '2026-07-01',
      parentRef: { number: '15-П', numberKey: '15-п', date: '2026-02-10' },
      method: 'title:amendment',
    });
    const contract = c(['Договор генерального подряда № 7-РС от 02.03.2026', '1. Предмет']);
    expect(contract).toMatchObject({ kind: 'contract', number: '7-РС', documentDate: '2026-03-02' });
    expect(c(['| 1 | a |'], 'smeta.xlsx').kind).toBe('estimate');
    expect(c(['Исх. № 5 от 01.02.2026'], 'scan.pdf').kind).toBe('letter');
    expect(c(['Текст без реквизитов'], 'Заметки.pdf').kind).toBe('other');
    // Акт с номером договора — акт, а не договор (граница кириллического слова после «Акт»).
    expect(c(['Акт сверки по договору № 5 от 01.01.2026'], 'Акт сверки по договору № 5 от 01.01.2026').kind).toBe('act');
    // Заголовок — не обязательно первый фрагмент: шапка «г. Москва» перед ним не мешает.
    expect(c(['г. Москва', 'Договор подряда № 9 от 01.01.2026']).number).toBe('9');
  });
});

describe('извлечение (перенос Locus fact-extractor, rules/1)', () => {
  it('факты договора — с нормализованным значением и условием', () => {
    const b = fixture('pv2-stromynka');
    const value = (type: string, status = '') => factsOf(b, type, status).map((f) => f.normalized);
    expect(value('party_contractor')).toEqual([{ name: 'ООО «СтройМонолит»' }]);
    expect(value('party_customer')).toEqual([{ name: 'ООО «Стромынка Девелопмент»' }]);
    expect(value('vat_rate')).toEqual([{ percent: 20 }]);
    expect(value('retention_percent')).toEqual([{ percent: 3 }]);
    expect(value('warranty_period')).toEqual([{ months: 60 }]);
    expect(value('penalty_rate')).toEqual([{ percent: 0.1, capPercent: 10 }]);
    const retentionReturn = factsOf(b, 'retention_return_term')[0]!;
    expect(retentionReturn.normalized).toEqual({ days: 30, dayKind: 'календарных' });
    expect(retentionReturn.condition).toMatch(/после истечения гарантийного срока/u);
    // «3%» (размер) и «30 дней» (срок) — разные типы.
    expect(factsOf(b, 'retention_percent')[0]!.unit).toBe('%');
    expect(retentionReturn.unit).toBe('days');
    // Поздний пункт о зачёте аванса — не второй срок аванса.
    expect(factsOf(b, 'advance_term')).toHaveLength(2);
  });

  it('срок другого обязательства в следующем предложении — не срок аванса и не срок возврата удержания', () => {
    const facts = (md: string) => doc('a', md).facts;
    expect(facts('Договор подряда № 10 от 01.01.2026\n\nАванс в размере 3%. Подрядчик передает отчет в течение 30 календарных дней после окончания работ.').map((f) => [f.factType, f.normalized])).toEqual([
      ['advance_percent', { percent: 3 }],
    ]);
    expect(facts('Договор подряда № 11 от 01.01.2026\n\nГарантийное удержание составляет 5%. Отчёт возвращается на доработку в течение 10 дней.').map((f) => f.factType)).toEqual(['retention_percent']);
    expect(facts('Договор подряда № 12 от 01.01.2026\n\nНеустойка в размере 0,5% за каждый день. Общая ответственность Подрядчика не более 20% цены.').map((f) => f.normalized)).toEqual([{ percent: 0.5 }]);
    expect(facts('Договор подряда № 13 от 01.01.2026\n\nАванс в размере 3% выплачивается в течение 30 календарных дней с даты подписания.').find((f) => f.factType === 'advance_term')!.normalized).toEqual({
      days: 30,
      dayKind: 'календарных',
    });
  });
});

describe('граф редакций (перенос Locus version-graph)', () => {
  it('допсоглашение перекрывает пункт договора; прежний факт сохраняет основание и срок действия', () => {
    const b = fixture('pv2-stromynka');
    const amendment = b.documents.find((d) => d.kind === 'amendment')!;
    const contract = b.documents.find((d) => d.kind === 'contract')!;
    expect(b.graph.relations).toEqual([{ fromDocumentId: amendment.documentId, toDocumentId: contract.documentId, relation: 'amends', source: 'text', reason: '' }]);
    const [current] = factsOf(b, 'advance_percent', 'active');
    const [old] = factsOf(b, 'advance_percent', 'superseded');
    expect(current!.normalized).toEqual({ percent: 10 });
    expect(current!.documentId).toBe(amendment.documentId);
    expect(current!.clauseRef).toBe('3.1');
    expect(state(b, current!).validFrom).toBe('2026-05-15');
    expect(old!.normalized).toEqual({ percent: 20 });
    expect(state(b, old!)).toMatchObject({ supersededByFactId: current!.factId, supersededReason: 'amendment', validTo: '2026-05-15', decidedBy: 'rule' });
    expect(factsOf(b, 'work_end_date', 'active').map((f) => f.normalized.date)).toEqual(['2027-03-31']);
    expect(factsOf(b, 'work_end_date', 'superseded').map((f) => f.normalized.date)).toEqual(['2026-11-30']);
    expect(factsOf(b, 'work_start_date', 'active').map((f) => f.normalized.date)).toEqual(['2026-03-01']);
  });

  it('цена договора и итог сметы различаются — конфликт и замечание, а не молчаливый выбор', () => {
    const b = fixture('pv2-stromynka');
    const price = factsOf(b, 'contract_price')[0]!;
    const total = factsOf(b, 'estimate_total')[0]!;
    expect(state(b, price).status).toBe('conflict');
    expect(state(b, total).status).toBe('conflict');
    expect(total.normalized).toEqual({ amount: 244800000, currency: '' });
    const conflicts = b.graph.remarks.filter((r) => r.kind === 'value_conflict');
    expect(conflicts.map((r) => r.factIds)).toEqual([[price.factId, total.factId].sort()]);
  });

  it('один договор — ни связей, ни конфликтов', () => {
    for (const project of ['pv2-rusakovskaya', 'pv2-balchug']) {
      const b = fixture(project);
      expect(b.graph.relations).toEqual([]);
      expect(b.graph.remarks).toEqual([]);
      expect([...b.graph.facts.values()].every((s) => s.status === 'active')).toBe(true);
    }
    const balchug = fixture('pv2-balchug');
    expect(factsOf(balchug, 'advance_percent')[0]!.normalized).toEqual({ percent: 30 });
    expect(factsOf(balchug, 'retention_percent')).toEqual([]);
  });

  it('договор допсоглашения не найден — связь неизвестна, ничего не перекрыто, замечание', () => {
    const b = link([doc('base', BASE), doc('ds', 'Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 99 от 01.01.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».')]);
    expect(b.graph.relations[0]).toMatchObject({ relation: 'unknown', source: 'text' });
    expect(b.graph.relations[0]!.reason).toMatch(/не найден/u);
    expect([...b.graph.facts.values()].every((s) => s.status !== 'superseded')).toBe(true);
    expect(b.graph.remarks.map((r) => r.kind)).toContain('parent_not_found');
  });

  it('допсоглашение без даты не перекрывает; разные значения в семье — конфликт; два замечания', () => {
    const b = link([doc('base', BASE), doc('ds', 'Дополнительное соглашение № 1 к договору подряда № 10 от 01.01.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».')]);
    expect(b.graph.relations[0]!.relation).toBe('amends');
    expect(factsOf(b, 'advance_percent').map((f) => state(b, f).status)).toEqual(['conflict', 'conflict']);
    expect(b.graph.remarks.map((r) => r.kind).sort()).toEqual(['undated_amendment', 'value_conflict']);
  });

  it('два факта без номера пункта — допсоглашение не выбирает; замечание о неоднозначной цели', () => {
    const b = link([
      doc('base', 'Договор подряда № 10 от 01.01.2026\n\nАванс составляет 20% от цены договора.\n\nПовторно: аванс составляет 25% от цены договора.'),
      doc('ds', 'Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 10\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».'),
    ]);
    const advances = factsOf(b, 'advance_percent');
    expect(advances.filter((f) => state(b, f).status === 'superseded')).toHaveLength(0);
    expect(advances.filter((f) => state(b, f).status === 'conflict')).toHaveLength(3);
    expect(b.graph.remarks.map((r) => r.kind)).toContain('amendment_target_ambiguous');
  });

  it('изменение явно другого пункта не перекрывает пункт договора', () => {
    const b = link([doc('base', BASE), doc('ds', 'Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 10 от 01.01.2026\n\nПункт 9.9 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».')]);
    const advances = factsOf(b, 'advance_percent');
    expect(advances.map((f) => state(b, f).status)).toEqual(['conflict', 'conflict']);
    expect(advances.every((f) => !state(b, f).supersededByFactId)).toBe(true);
  });

  it('единственный факт без номера пункта заменяется датированным допсоглашением именованного пункта', () => {
    const b = link([
      doc('base', 'Договор подряда № 10 от 01.01.2026\n\nАванс составляет 20% от цены договора.'),
      doc('ds', 'Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 10 от 01.01.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».'),
    ]);
    expect(factsOf(b, 'advance_percent').map((f) => [f.normalized.percent, state(b, f).status])).toEqual([
      [20, 'superseded'],
      [10, 'active'],
    ]);
  });
});

describe('Контур: явная связь 06a, решения человека, прежние редакции', () => {
  const ADDENDUM = 'Дополнительное соглашение № 1 от 01.03.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».';

  it('связь 06a главнее текста: допсоглашение без ссылки «к договору № …» перекрывает пункт основного документа', () => {
    const contract = { ownerKey: 'contract:c1' };
    const b = link([
      doc('base', 'Договор подряда № 10 от 01.01.2026\n\n3.1. Аванс составляет 20% от цены договора.', 'договор.pdf', { ...contract, explicit: { role: 'contract', mainDocumentId: null } }),
      doc('ds', ADDENDUM, 'ДС-1.pdf', { ...contract, explicit: { role: 'addendum', mainDocumentId: 'base' } }),
    ]);
    expect(b.graph.relations).toEqual([{ fromDocumentId: 'ds', toDocumentId: 'base', relation: 'amends', source: '06a', reason: '' }]);
    expect(factsOf(b, 'advance_percent').map((f) => [f.normalized.percent, state(b, f).status])).toEqual([
      [20, 'superseded'],
      [10, 'active'],
    ]);
  });

  it('по тексту связываются только документы одного тендера', () => {
    const b = link([
      doc('base', BASE, 'договор.pdf', { ownerKey: 'tender:t2' }),
      doc('ds', 'Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 10 от 01.01.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».'),
    ]);
    expect(b.graph.relations[0]).toMatchObject({ relation: 'unknown' });
    expect(factsOf(b, 'advance_percent', 'superseded')).toEqual([]);
  });

  it('решение человека: «действует это значение» снимает конфликт; «независимы» — конфликт и перекрытие; «правилу» — возврат', () => {
    const parts = [doc('base', BASE), doc('ds', 'Дополнительное соглашение № 1 к договору подряда № 10 от 01.01.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».')];
    const [oldF, newF] = parts.flatMap((p) => p.facts).filter((f) => f.factType === 'advance_percent');
    const prevails = link(parts, [{ decisionId: 'd1', factId: newF!.factId, otherFactId: oldF!.factId, kind: 'prevails' }]);
    expect(state(prevails, oldF!)).toMatchObject({ status: 'superseded', supersededReason: 'human', supersededByFactId: newF!.factId, decidedBy: 'human', decisionId: 'd1' });
    expect(state(prevails, newF!).status).toBe('active');
    // Решение человека по паре снимает и вопрос порядка недатированного допсоглашения: замечаний нет.
    expect(prevails.graph.remarks).toEqual([]);
    const distinct = link(parts, [{ decisionId: 'd2', factId: oldF!.factId, otherFactId: newF!.factId, kind: 'distinct' }]);
    expect([state(distinct, oldF!).status, state(distinct, newF!).status]).toEqual(['active', 'active']);
    const back = link(parts, [
      { decisionId: 'd1', factId: newF!.factId, otherFactId: oldF!.factId, kind: 'prevails' },
      { decisionId: 'd3', factId: oldF!.factId, otherFactId: newF!.factId, kind: 'rule' },
    ]);
    expect([state(back, oldF!).status, state(back, newF!).status]).toEqual(['conflict', 'conflict']);
    // Хэш графа — от входа: решение меняет хэш, тот же вход — тот же хэш.
    expect(prevails.graph.hash).not.toBe(back.graph.hash);
    expect(link(parts).graph.hash).toBe(link(parts).graph.hash);
  });

  it('«независимы» отменяет и перекрытие правилом между парой', () => {
    const parts = [doc('base', BASE), doc('ds', 'Дополнительное соглашение № 1 от 01.03.2026 к договору подряда № 10 от 01.01.2026\n\nПункт 3.1 договора изложить в новой редакции: «Аванс составляет 10% от цены договора».')];
    const [oldF, newF] = parts.flatMap((p) => p.facts).filter((f) => f.factType === 'advance_percent');
    expect(state(link(parts), oldF!).status).toBe('superseded');
    const b = link(parts, [{ decisionId: 'd1', factId: newF!.factId, otherFactId: oldF!.factId, kind: 'distinct' }]);
    expect(state(b, oldF!)).toMatchObject({ status: 'active', decidedBy: 'human', decisionId: 'd1' });
  });

  it('факт прежней редакции документа — перекрыт новой редакцией и в граф не входит', () => {
    const base = doc('base', BASE);
    const retired = { ...base.facts[0]!, factId: 'old-rev', retired: true };
    const g = computeFactGraph({ documents: [base.document], facts: [...base.facts, retired] });
    expect(g.facts.get('old-rev')).toMatchObject({ status: 'superseded', supersededReason: 'document_revision' });
    expect(g.facts.get(base.facts[0]!.factId)!.status).toBe('active');
  });
});
