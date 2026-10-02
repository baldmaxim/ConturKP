// Граф редакций и производное состояние фактов (D-018, D-028): перенос Locus `version-graph.js` `linkDocumentFamily`
// (HEAD 33c6bcf). Детерминированная функция: одинаковый вход — одинаковое состояние и хэш. Ничего не удаляется:
// перекрытый факт сохраняет основание со статусом `superseded` и концом действия. Значения, которые различаются без
// указанного порядка, помечаются конфликтом, а не выбираются молча; неоднозначность — замечание человеку.
// Отличия Контура: семья — сначала явная связь 06a (допсоглашение / приложение → основной документ); по тексту
// «к договору № …» связываются только документы одного тендера; решения человека — входные рёбра графа.
import { createHash } from 'node:crypto';
import { normalizeDocumentNumber } from './classifier.ts';
import { FACT_TYPE_META, type DocumentKind, type FactType, type IParentRef } from './types.ts';

// Типы, описывающие одну величину в разных документах владельца (цена договора и итог сметы); остальные типы
// сравниваются только внутри семьи договора.
const CROSS_DOCUMENT_GROUPS: Partial<Record<FactType, string>> = { contract_price: 'total_cost', estimate_total: 'total_cost' };

export const crossDocumentCounterparts = (factTypes: readonly string[]): FactType[] => {
  const groups = new Set(factTypes.map((type) => CROSS_DOCUMENT_GROUPS[type as FactType]).filter(Boolean));
  return (Object.keys(CROSS_DOCUMENT_GROUPS) as FactType[]).filter((type) => groups.has(CROSS_DOCUMENT_GROUPS[type]) && !factTypes.includes(type));
};

export interface IGraphDocument {
  documentId: string;
  // Владелец документа: `tender:<id>` или `contract:<id>`; по тексту связываются документы одного владельца-тендера.
  ownerKey: string;
  kind: DocumentKind;
  number: string;
  documentDate: string | null;
  parentRef: IParentRef | null;
  // Явная связь 06a: роль документа договора и его основной документ.
  explicit: { role: 'contract' | 'addendum' | 'appendix'; mainDocumentId: string | null } | null;
}

export interface IGraphFact {
  factId: string;
  documentId: string;
  factType: FactType;
  normalizedKey: string;
  clauseRef: string;
  amends: boolean;
  // Факт непоследней редакции документа: в граф не входит, перекрыт новой редакцией.
  retired?: boolean;
}

export type FactDecisionKind = 'prevails' | 'distinct' | 'rule';

// Решение человека по паре фактов (в порядке записи): `prevails` — факт `factId` действует вместо `otherFactId`;
// `distinct` — значения независимы (ни перекрытия, ни конфликта); `rule` — пара возвращена правилу.
export interface IGraphDecision {
  decisionId: string;
  factId: string;
  otherFactId: string;
  kind: FactDecisionKind;
}

export type FactStatus = 'active' | 'superseded' | 'conflict';
export type SupersededReason = 'amendment' | 'human' | 'document_revision';

export interface IFactStatus {
  factId: string;
  status: FactStatus;
  supersededReason: SupersededReason | null;
  supersededByFactId: string | null;
  validFrom: string | null;
  validTo: string | null;
  decidedBy: 'rule' | 'human';
  decisionId: string | null;
}

export type RelationKind = 'amends' | 'appendix_of' | 'unknown';

export interface IGraphRelation {
  fromDocumentId: string;
  toDocumentId: string | null;
  relation: RelationKind;
  source: '06a' | 'text';
  reason: string;
}

export type RemarkKind = 'parent_not_found' | 'parent_ambiguous' | 'undated_amendment' | 'amendment_target_ambiguous' | 'value_conflict';

export interface IGraphRemark {
  key: string;
  kind: RemarkKind;
  factIds: string[];
  documentIds: string[];
  message: string;
}

export interface IFactGraph {
  relations: IGraphRelation[];
  facts: Map<string, IFactStatus>;
  remarks: IGraphRemark[];
  hash: string;
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const remark = (kind: RemarkKind, factIds: string[], documentIds: string[], message: string): IGraphRemark => {
  const f = [...new Set(factIds)].sort();
  const d = [...new Set(documentIds)].sort();
  return { key: sha(`${kind}|${f.join(',')}|${d.join(',')}`).slice(0, 32), kind, factIds: f, documentIds: d, message };
};

// Даты сравниваются как ISO-строки; документы без даты идут после датированных (порядок не известен).
const byDateThenId = (a: IGraphDocument, b: IGraphDocument): number => {
  if (a.documentDate && b.documentDate && a.documentDate !== b.documentDate) return a.documentDate < b.documentDate ? -1 : 1;
  if (Boolean(a.documentDate) !== Boolean(b.documentDate)) return a.documentDate ? -1 : 1;
  return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
};

export const computeFactGraph = (input: { documents: readonly IGraphDocument[]; facts: readonly IGraphFact[]; decisions?: readonly IGraphDecision[] }): IFactGraph => {
  const docs = [...input.documents].sort((a, b) => (a.documentId < b.documentId ? -1 : 1));
  const docById = new Map(docs.map((d) => [d.documentId, d]));
  const relations: IGraphRelation[] = [];
  const remarks: IGraphRemark[] = [];
  const parentOf = new Map<string, string>();
  const relationOf = new Map<string, RelationKind>();

  // ---- 1. Связь документа с основным договором.
  for (const doc of docs) {
    if (doc.explicit) {
      if (doc.explicit.role === 'contract' || !doc.explicit.mainDocumentId) continue;
      const parent = docById.get(doc.explicit.mainDocumentId);
      const relation: RelationKind = parent ? (doc.explicit.role === 'addendum' ? 'amends' : 'appendix_of') : 'unknown';
      relationOf.set(doc.documentId, relation);
      if (parent) parentOf.set(doc.documentId, parent.documentId);
      relations.push({ fromDocumentId: doc.documentId, toDocumentId: parent?.documentId ?? null, relation, source: '06a', reason: parent ? '' : 'основной документ вне области' });
      continue;
    }
    if (doc.kind !== 'amendment' && doc.kind !== 'appendix') continue;
    const ref = doc.parentRef;
    const candidates = ref?.numberKey
      ? docs.filter((d) => d.kind === 'contract' && !d.explicit && d.ownerKey === doc.ownerKey && normalizeDocumentNumber(d.number) === ref.numberKey && (!ref.date || !d.documentDate || ref.date === d.documentDate))
      : [];
    const parent = candidates.length === 1 ? candidates[0]! : null;
    const relation: RelationKind = parent ? (doc.kind === 'amendment' ? 'amends' : 'appendix_of') : 'unknown';
    relationOf.set(doc.documentId, relation);
    if (parent) parentOf.set(doc.documentId, parent.documentId);
    const reason = parent ? '' : !ref ? 'документ не называет основной договор' : candidates.length ? `несколько договоров № ${ref.number}` : `договор № ${ref.number} не найден`;
    relations.push({ fromDocumentId: doc.documentId, toDocumentId: parent?.documentId ?? null, relation, source: 'text', reason });
    if (!parent) {
      remarks.push(
        remark(
          candidates.length ? 'parent_ambiguous' : 'parent_not_found',
          [],
          [doc.documentId, ...candidates.map((c) => c.documentId)],
          `${doc.kind === 'amendment' ? 'Допсоглашение' : 'Приложение'} № ${doc.number}: ${reason} — связь с договором не установлена.`,
        ),
      );
    }
  }
  const rootOf = (documentId: string): string => parentOf.get(documentId) ?? documentId;

  // ---- 2. Состояние по умолчанию; факты прежних редакций документа — перекрыты новой редакцией.
  const states = new Map<string, IFactStatus>();
  const facts = [...input.facts].sort((a, b) => (a.factId < b.factId ? -1 : 1));
  const live = facts.filter((f) => !f.retired && docById.has(f.documentId));
  for (const f of facts) {
    const doc = docById.get(f.documentId);
    states.set(f.factId, {
      factId: f.factId,
      status: f.retired || !doc ? 'superseded' : 'active',
      supersededReason: f.retired || !doc ? 'document_revision' : null,
      supersededByFactId: null,
      validFrom: doc?.documentDate ?? null,
      validTo: null,
      decidedBy: 'rule',
      decisionId: null,
    });
  }
  const st = (factId: string): IFactStatus => states.get(factId)!;

  // Решения человека: действует последнее решение по паре; `rule` возвращает пару правилу.
  const effective = new Map<string, IGraphDecision>();
  for (const d of input.decisions ?? []) effective.set(pairKey(d.factId, d.otherFactId), d);
  const decided = new Set([...effective.values()].filter((d) => d.kind !== 'rule').flatMap((d) => [d.factId, d.otherFactId]));

  // ---- 3. Допсоглашения — по дате документа; без даты ничего не перекрывают (донор).
  const amendments = docs.filter((d) => relationOf.get(d.documentId) === 'amends').sort(byDateThenId);
  for (const amendment of amendments) {
    const amending = live.filter((f) => f.documentId === amendment.documentId && f.amends);
    if (!amending.length) continue;
    if (!amendment.documentDate) {
      // Замечание — пока человек не решил судьбу изменённых значений (решение по паре снимает вопрос порядка).
      const open = amending.filter((f) => !decided.has(f.factId));
      if (open.length) remarks.push(remark('undated_amendment', open.map((f) => f.factId), [amendment.documentId], `Допсоглашение № ${amendment.number || '—'} без даты: порядок изменений не известен, пункты не перекрыты.`));
      continue;
    }
    const root = rootOf(amendment.documentId);
    const family = new Set(
      docs
        .filter((d) => rootOf(d.documentId) === root && d.documentId !== amendment.documentId && (!d.documentDate || d.documentDate <= amendment.documentDate!))
        .map((d) => d.documentId),
    );
    for (const fact of amending) {
      const candidates = live.filter((f) => family.has(f.documentId) && f.factType === fact.factType && st(f.factId).status === 'active');
      const sameClause = candidates.filter((f) => f.clauseRef && f.clauseRef === fact.clauseRef);
      // Без точного совпадения пункта заменяется только единственный факт, пункт которого не противоречит изменяемому:
      // «пункт 9.9» никогда не перекрывает факт пункта 3.1.
      const compatible = candidates.filter((f) => !(fact.clauseRef && f.clauseRef && f.clauseRef !== fact.clauseRef));
      const targets = sameClause.length ? sameClause : compatible.length === 1 ? compatible : [];
      if (!sameClause.length && compatible.length > 1) {
        remarks.push(
          remark('amendment_target_ambiguous', [fact.factId, ...compatible.map((f) => f.factId)], [amendment.documentId], `Допсоглашение № ${amendment.number || '—'} изменяет пункт ${fact.clauseRef || 'без номера'}: в семье несколько подходящих значений — какое изменено, правило не выбирает.`),
        );
      }
      for (const target of targets) {
        Object.assign(st(target.factId), { status: 'superseded', supersededReason: 'amendment', supersededByFactId: fact.factId, validTo: amendment.documentDate });
      }
      st(fact.factId).validFrom = amendment.documentDate;
    }
  }

  // ---- 4. Решения человека (действующие посчитаны выше).
  const liveIds = new Set(live.map((f) => f.factId));
  const distinct = new Set<string>();
  for (const d of effective.values()) {
    if (d.kind === 'rule' || !liveIds.has(d.factId) || !liveIds.has(d.otherFactId)) continue;
    if (d.kind === 'prevails') {
      Object.assign(st(d.otherFactId), { status: 'superseded', supersededReason: 'human', supersededByFactId: d.factId, decidedBy: 'human', decisionId: d.decisionId });
      if (st(d.factId).status === 'superseded' && st(d.factId).supersededByFactId === d.otherFactId) {
        Object.assign(st(d.factId), { status: 'active', supersededReason: null, supersededByFactId: null, validTo: null, decidedBy: 'human', decisionId: d.decisionId });
      }
      continue;
    }
    distinct.add(pairKey(d.factId, d.otherFactId));
    for (const [a, b] of [
      [d.factId, d.otherFactId],
      [d.otherFactId, d.factId],
    ] as const) {
      if (st(b).status === 'superseded' && st(b).supersededByFactId === a) {
        Object.assign(st(b), { status: 'active', supersededReason: null, supersededByFactId: null, validTo: null, decidedBy: 'human', decisionId: d.decisionId });
      }
    }
  }

  // ---- 5. Конфликт: действующие значения одного типа в семье (или цена и смета владельца), которые различаются,
  // кроме пар, признанных человеком независимыми.
  const markConflict = (members: IGraphFact[], label: string) => {
    const conflicting = new Set<string>();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]!;
        const b = members[j]!;
        if (a.normalizedKey !== b.normalizedKey && !distinct.has(pairKey(a.factId, b.factId))) {
          conflicting.add(a.factId);
          conflicting.add(b.factId);
        }
      }
    }
    if (conflicting.size < 2) return;
    for (const id of conflicting) st(id).status = 'conflict';
    const ids = [...conflicting];
    remarks.push(remark('value_conflict', ids, [...new Set(members.filter((m) => conflicting.has(m.factId)).map((m) => m.documentId))], `${label}: значения различаются без указанного порядка изменения — какое действует, решает человек.`));
  };
  const active = () => live.filter((f) => st(f.factId).status === 'active');
  const families = new Map<string, IGraphFact[]>();
  for (const f of active()) {
    if (CROSS_DOCUMENT_GROUPS[f.factType]) continue;
    const key = `${rootOf(f.documentId)}|${f.factType}`;
    families.set(key, [...(families.get(key) ?? []), f]);
  }
  for (const members of families.values()) markConflict(members, `«${FACT_TYPE_META[members[0]!.factType]?.title ?? members[0]!.factType}» в одной семье договора`);
  const cross = new Map<string, IGraphFact[]>();
  for (const f of active()) {
    const group = CROSS_DOCUMENT_GROUPS[f.factType];
    if (!group) continue;
    const key = `${docById.get(f.documentId)!.ownerKey}|${group}`;
    cross.set(key, [...(cross.get(key) ?? []), f]);
  }
  for (const members of cross.values()) markConflict(members, 'Цена договора и итог сметы');

  const hash = sha(
    JSON.stringify({
      documents: docs.map((d) => [d.documentId, d.ownerKey, d.kind, d.number, d.documentDate, d.parentRef?.numberKey ?? null, d.parentRef?.date ?? null, d.explicit?.role ?? null, d.explicit?.mainDocumentId ?? null]),
      facts: facts.map((f) => [f.factId, f.documentId, f.factType, f.normalizedKey, f.clauseRef, f.amends, Boolean(f.retired)]),
      decisions: [...effective.values()].map((d) => [d.decisionId, d.factId, d.otherFactId, d.kind]).sort(),
    }),
  );
  remarks.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { relations, facts: states, remarks, hash };
};
