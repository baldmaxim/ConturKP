// Сравнение двух выпусков (этап 15; проект docs/architecture/15-send-comparison-design.md §8–§10). Вход — снимки сторон,
// собранные только из закреплённых записей выпуска: снимок области, вход прогона проверок, решения, версии полей и
// файлы комплекта, манифест выпуска. Вывод — ссылки, хэши и коды без свободного текста; текст подставляется при чтении
// по правам читателя. Сопоставление только точное: тот же ID или тот же хэш содержимого; похожее не объединяется.
import { canonicalJson } from '../requirements.ts';
import { sha256Hex } from '../search.ts';

export const RELEASE_COMPARE_METHOD = 'release-compare/15-1';

export type CompareSection = 'sources' | 'requirements' | 'questions' | 'terms' | 'decisions' | 'applications' | 'received';
export const COMPARE_SECTIONS: readonly CompareSection[] = ['sources', 'requirements', 'questions', 'terms', 'decisions', 'applications', 'received'];

export type SourceUnitType = 'document_recognition' | 'mail_message' | 'transcript_revision';

export interface ISourceUnit {
  unitType: SourceUnitType;
  // Логический объект: документ, письмо в ящике, встреча.
  logicalId: string;
  // Редакция документа, ревизия письма, редакция транскрипции.
  revisionId: string;
  // Содержимое: файл редакции, исходное письмо, содержание транскрипции.
  sha256: string | null;
  // Прогон распознавания редакции документа; null — редакция в снимке без распознавания (I18).
  recognitionRunId: string | null;
}

export interface IQaUnit {
  itemId: string;
  revisionId: string;
  contentSha256: string;
  status: 'open' | 'answered' | 'withdrawn';
}

export interface IRequirementSnap {
  requirementId: string;
  revisionId: string;
  contentSha256: string;
  coverageState: string | null;
}

export interface IFactSnap {
  factId: string;
  factType: string;
  normalizedKey: string;
  documentId: string;
  clauseRef: string;
  // Хэш условия применимости (текст в ключи и выводы не попадает).
  conditionSha256: string;
  status: string;
}

export interface IDecisionSnap {
  id: string;
  // Заменённые решения по всей цепочке supersedes.
  supersedes: string[];
}

export interface IRiskSnap {
  id: string;
  code: string;
  subjectType: string;
  subjectId: string;
  subjectKey: string;
}

export interface IHoldDecisionSnap {
  eventId: string;
  decision: 'not_applicable' | 'requires_new_candidate';
  decisionId: string | null;
}

export interface IFileSnap {
  fileId: string;
  path: string;
  sha256: string;
}

export interface IFieldSnap {
  // Шаблон и порядковый номер приложения этого шаблона в комплекте (обычно 1).
  templateId: string;
  slot: number;
  fieldKey: string;
  versionId: string;
  valueSha256: string;
}

export interface IReleaseSnapshot {
  releaseId: string;
  stageId: string;
  manifestSha256: string;
  calculationRevisionId: string;
  sources: ISourceUnit[];
  qa: IQaUnit[];
  // null — у комплекта нет закреплённого входа прогона проверок: требования, факты и открытые вопросы неизвестны.
  review: { requirements: IRequirementSnap[]; facts: IFactSnap[]; openQuestionIds: string[] } | null;
  decisions: IDecisionSnap[];
  risks: IRiskSnap[];
  reviewRiskFindingIds: string[];
  holds: IHoldDecisionSnap[];
  files: IFileSnap[];
  fields: IFieldSnap[];
}

export interface IComparisonItem {
  section: CompareSection;
  change: string;
  subjectType: string;
  key: string;
  leftRef: string | null;
  rightRef: string | null;
  leftSha256: string | null;
  rightSha256: string | null;
  detail: Record<string, unknown>;
}

export interface ISectionSummary {
  left: number;
  right: number;
  unchanged: number;
  changes: Record<string, number>;
  // Раздел не построен: нет закреплённого входа у стороны (I07 — «нет данных», а не «нет изменений»).
  unavailable?: 'left' | 'right' | 'both';
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const item = (section: CompareSection, change: string, subjectType: string, key: string, p: Partial<Omit<IComparisonItem, 'section' | 'change' | 'subjectType' | 'key'>> = {}): IComparisonItem => ({
  section,
  change,
  subjectType,
  key,
  leftRef: p.leftRef ?? null,
  rightRef: p.rightRef ?? null,
  leftSha256: p.leftSha256 ?? null,
  rightSha256: p.rightSha256 ?? null,
  detail: p.detail ?? {},
});

const mapBy = <T>(list: readonly T[], key: (x: T) => string): Map<string, T> => new Map(list.map((x) => [key(x), x]));

// Пары «только слева» ↔ «только справа» с одинаковым значением ключа, по одной (в порядке ID): точное совпадение содержимого.
const pairBy = <T>(left: T[], right: T[], key: (x: T) => string | null, id: (x: T) => string): { pairs: [T, T][]; left: T[]; right: T[] } => {
  const pool = new Map<string, T[]>();
  for (const r of [...right].sort((a, b) => cmp(id(a), id(b)))) {
    const k = key(r);
    if (k !== null) pool.set(k, [...(pool.get(k) ?? []), r]);
  }
  const pairs: [T, T][] = [];
  const restLeft: T[] = [];
  const used = new Set<T>();
  for (const l of [...left].sort((a, b) => cmp(id(a), id(b)))) {
    const k = key(l);
    const r = k === null ? undefined : pool.get(k)?.shift();
    if (r) {
      pairs.push([l, r]);
      used.add(r);
    } else restLeft.push(l);
  }
  return { pairs, left: restLeft, right: right.filter((r) => !used.has(r)) };
};

const summary = (left: number, right: number, unchanged: number, items: readonly IComparisonItem[], section: CompareSection): ISectionSummary => {
  const changes: Record<string, number> = {};
  for (const i of items) if (i.section === section) changes[i.change] = (changes[i.change] ?? 0) + 1;
  return { left, right, unchanged, changes };
};

// ---------------------------------------------------------------- Источники (§9.1)

const UNIT_SUBJECT: Record<SourceUnitType, string> = { document_recognition: 'document_revision', mail_message: 'mail_message_revision', transcript_revision: 'transcript_revision' };

const compareSources = (l: readonly ISourceUnit[], r: readonly ISourceUnit[], out: IComparisonItem[]): number => {
  let unchanged = 0;
  const key = (u: ISourceUnit) => `${u.unitType}:${u.logicalId}`;
  const lm = mapBy(l, key);
  const rm = mapBy(r, key);
  const onlyLeft: ISourceUnit[] = [];
  const onlyRight: ISourceUnit[] = [];
  for (const [k, a] of lm) {
    const b = rm.get(k);
    if (!b) {
      onlyLeft.push(a);
      continue;
    }
    const subject = UNIT_SUBJECT[a.unitType];
    if (a.revisionId !== b.revisionId) {
      out.push(item('sources', 'revision_changed', subject, k, { leftRef: a.revisionId, rightRef: b.revisionId, leftSha256: a.sha256, rightSha256: b.sha256, detail: { unrecognized: unitUnrecognized(b) } }));
    } else if (a.recognitionRunId !== b.recognitionRunId) {
      out.push(item('sources', 'recognition_changed', subject, k, { leftRef: a.revisionId, rightRef: b.revisionId, leftSha256: a.sha256, rightSha256: b.sha256, detail: { leftRunId: a.recognitionRunId, rightRunId: b.recognitionRunId, unrecognized: unitUnrecognized(b) } }));
    } else unchanged += 1;
  }
  for (const [k, b] of rm) if (!lm.has(k)) onlyRight.push(b);
  // То же содержимое под другим логическим объектом — не новый источник (A14): копия, вложение письма, второй ящик.
  const same = pairBy(onlyLeft, onlyRight, (u) => u.sha256, (u) => u.revisionId);
  for (const [a, b] of same.pairs) {
    out.push(item('sources', 'same_content', UNIT_SUBJECT[b.unitType], key(b), { leftRef: a.revisionId, rightRef: b.revisionId, leftSha256: a.sha256, rightSha256: b.sha256, detail: { leftUnitType: a.unitType, rightUnitType: b.unitType } }));
  }
  // Содержимое, которое есть и у неизменившейся единицы другой стороны, — тоже не новый источник.
  const leftShas = new Map(l.filter((u) => u.sha256).map((u) => [u.sha256!, u]));
  const rightShas = new Map(r.filter((u) => u.sha256).map((u) => [u.sha256!, u]));
  for (const b of same.right) {
    const twin = b.sha256 ? leftShas.get(b.sha256) : undefined;
    out.push(
      twin
        ? item('sources', 'same_content', UNIT_SUBJECT[b.unitType], key(b), { leftRef: twin.revisionId, rightRef: b.revisionId, leftSha256: twin.sha256, rightSha256: b.sha256, detail: { leftUnitType: twin.unitType, rightUnitType: b.unitType } })
        : item('sources', 'added', UNIT_SUBJECT[b.unitType], key(b), { rightRef: b.revisionId, rightSha256: b.sha256, detail: { unrecognized: unitUnrecognized(b) } }),
    );
  }
  for (const a of same.left) {
    const twin = a.sha256 ? rightShas.get(a.sha256) : undefined;
    if (!twin) out.push(item('sources', 'removed', UNIT_SUBJECT[a.unitType], key(a), { leftRef: a.revisionId, leftSha256: a.sha256 }));
    else out.push(item('sources', 'same_content', UNIT_SUBJECT[a.unitType], key(a), { leftRef: a.revisionId, rightRef: twin.revisionId, leftSha256: a.sha256, rightSha256: twin.sha256, detail: { leftUnitType: a.unitType, rightUnitType: twin.unitType, duplicateRemoved: true } }));
  }
  return unchanged;
};

const unitUnrecognized = (u: ISourceUnit): boolean => u.unitType === 'document_recognition' && u.recognitionRunId === null;

// ---------------------------------------------------------------- Требования (§9.2)

const compareRequirements = (l: readonly IRequirementSnap[], r: readonly IRequirementSnap[], out: IComparisonItem[]): number => {
  let unchanged = 0;
  const coverage = (a: IRequirementSnap, b: IRequirementSnap, key: string): void => {
    if (a.coverageState === b.coverageState) unchanged += 1;
    else out.push(item('requirements', 'coverage_changed', 'requirement_revision', key, { leftRef: a.revisionId, rightRef: b.revisionId, leftSha256: a.contentSha256, rightSha256: b.contentSha256, detail: { leftCoverage: a.coverageState, rightCoverage: b.coverageState } }));
  };
  const lm = mapBy(l, (x) => x.requirementId);
  const rm = mapBy(r, (x) => x.requirementId);
  const onlyLeft: IRequirementSnap[] = [];
  for (const [id, a] of lm) {
    const b = rm.get(id);
    if (!b) onlyLeft.push(a);
    else if (a.revisionId !== b.revisionId && a.contentSha256 !== b.contentSha256) {
      out.push(item('requirements', 'changed', 'requirement_revision', `requirement:${id}`, { leftRef: a.revisionId, rightRef: b.revisionId, leftSha256: a.contentSha256, rightSha256: b.contentSha256, detail: { leftCoverage: a.coverageState, rightCoverage: b.coverageState } }));
    } else coverage(a, b, `requirement:${id}`);
  }
  const onlyRight = r.filter((x) => !lm.has(x.requirementId));
  // Другой этап — другие ID: то же требование — только по точному хэшу содержания (S15-04).
  const same = pairBy(onlyLeft, onlyRight, (x) => x.contentSha256, (x) => x.revisionId);
  for (const [a, b] of same.pairs) coverage(a, b, `requirement:${b.requirementId}`);
  for (const b of same.right) out.push(item('requirements', 'added', 'requirement_revision', `requirement:${b.requirementId}`, { rightRef: b.revisionId, rightSha256: b.contentSha256, detail: { rightCoverage: b.coverageState } }));
  for (const a of same.left) out.push(item('requirements', 'removed', 'requirement_revision', `requirement:${a.requirementId}`, { leftRef: a.revisionId, leftSha256: a.contentSha256, detail: { leftCoverage: a.coverageState } }));
  return unchanged;
};

// ---------------------------------------------------------------- Вопросы (§9.4)

const compareQa = (l: readonly IQaUnit[], r: readonly IQaUnit[], out: IComparisonItem[]): number => {
  let unchanged = 0;
  const lm = mapBy(l, (x) => x.itemId);
  const rm = mapBy(r, (x) => x.itemId);
  for (const [id, a] of lm) {
    const b = rm.get(id);
    const key = `qa_item:${id}`;
    if (!b) out.push(item('questions', 'removed', 'qa_item_revision', key, { leftRef: a.revisionId, leftSha256: a.contentSha256, detail: { leftStatus: a.status } }));
    else if (a.revisionId === b.revisionId) unchanged += 1;
    else {
      const change = a.status === 'open' && b.status === 'answered' ? 'answered' : a.status !== 'withdrawn' && b.status === 'withdrawn' ? 'withdrawn' : 'changed';
      out.push(item('questions', change, 'qa_item_revision', key, { leftRef: a.revisionId, rightRef: b.revisionId, leftSha256: a.contentSha256, rightSha256: b.contentSha256, detail: { leftStatus: a.status, rightStatus: b.status } }));
    }
  }
  for (const [id, b] of rm) if (!lm.has(id)) out.push(item('questions', 'added', 'qa_item_revision', `qa_item:${id}`, { rightRef: b.revisionId, rightSha256: b.contentSha256, detail: { rightStatus: b.status } }));
  return unchanged;
};

const compareOpenQuestions = (l: readonly string[], r: readonly string[], out: IComparisonItem[]): number => {
  const ls = new Set(l);
  const rs = new Set(r);
  for (const id of rs) if (!ls.has(id)) out.push(item('questions', 'opened', 'customer_question', `customer_question:${id}`, { rightRef: id }));
  for (const id of ls) if (!rs.has(id)) out.push(item('questions', 'closed', 'customer_question', `customer_question:${id}`, { leftRef: id }));
  return [...ls].filter((id) => rs.has(id)).length;
};

// ---------------------------------------------------------------- Условия и факты (§9.5)

const compareFacts = (l: readonly IFactSnap[], r: readonly IFactSnap[], out: IComparisonItem[]): number => {
  let unchanged = 0;
  const identity = (f: IFactSnap) => `${f.factType}|${f.documentId}|${sha256Hex(f.normalizedKey)}`;
  const lm = mapBy(l, identity);
  const rm = mapBy(r, identity);
  const onlyLeft: IFactSnap[] = [];
  for (const [k, a] of lm) {
    const b = rm.get(k);
    if (!b) onlyLeft.push(a);
    else if (a.status !== b.status) out.push(item('terms', 'status_changed', 'evidence_fact', `fact:${k}`, { leftRef: a.factId, rightRef: b.factId, detail: { factType: a.factType, leftStatus: a.status, rightStatus: b.status } }));
    else unchanged += 1;
  }
  const onlyRight = r.filter((f) => !lm.has(identity(f)));
  // То же место документа (тип, документ, пункт, условие) с другим значением — «изменено», только если оно одно с каждой стороны.
  const place = (f: IFactSnap) => (f.clauseRef === '' ? null : `${f.factType}|${f.documentId}|${f.clauseRef}|${f.conditionSha256}`);
  const count = (list: IFactSnap[]) => {
    const m = new Map<string, number>();
    for (const f of list) {
      const p = place(f);
      if (p) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  };
  const lc = count(onlyLeft);
  const rc = count(onlyRight);
  const single = (f: IFactSnap) => {
    const p = place(f);
    return p !== null && lc.get(p) === 1 && rc.get(p) === 1 ? p : null;
  };
  const same = pairBy(onlyLeft, onlyRight, single, (f) => f.factId);
  for (const [a, b] of same.pairs) out.push(item('terms', 'changed', 'evidence_fact', `fact:${identity(b)}`, { leftRef: a.factId, rightRef: b.factId, detail: { factType: b.factType, leftStatus: a.status, rightStatus: b.status } }));
  for (const b of same.right) out.push(item('terms', 'added', 'evidence_fact', `fact:${identity(b)}`, { rightRef: b.factId, detail: { factType: b.factType, rightStatus: b.status } }));
  for (const a of same.left) out.push(item('terms', 'removed', 'evidence_fact', `fact:${identity(a)}`, { leftRef: a.factId, detail: { factType: a.factType, leftStatus: a.status } }));
  return unchanged;
};

// ---------------------------------------------------------------- Решения (§9.6)

const compareDecisions = (l: IReleaseSnapshot, r: IReleaseSnapshot, out: IComparisonItem[]): number => {
  let unchanged = 0;
  const ls = new Set(l.decisions.map((d) => d.id));
  const replaced = new Set<string>();
  for (const d of r.decisions) {
    if (ls.has(d.id)) {
      unchanged += 1;
      continue;
    }
    const old = d.supersedes.find((id) => ls.has(id) && !replaced.has(id));
    if (old) {
      replaced.add(old);
      out.push(item('decisions', 'superseded', 'decision', `decision:${d.id}`, { leftRef: old, rightRef: d.id }));
    } else out.push(item('decisions', 'added', 'decision', `decision:${d.id}`, { rightRef: d.id }));
  }
  const rs = new Set(r.decisions.map((d) => d.id));
  for (const d of l.decisions) if (!rs.has(d.id) && !replaced.has(d.id)) out.push(item('decisions', 'removed', 'decision', `decision:${d.id}`, { leftRef: d.id }));

  // Принятые риски — по предмету (у каждого комплекта свои записи принятия).
  const riskKey = (x: IRiskSnap) => `${x.code}|${x.subjectType}|${x.subjectId}|${sha256Hex(x.subjectKey)}`;
  const lr = mapBy(l.risks, riskKey);
  const rr = mapBy(r.risks, riskKey);
  for (const [k, b] of rr) {
    if (lr.has(k)) unchanged += 1;
    else out.push(item('decisions', 'added', 'risk_acceptance', `risk:${k}`, { rightRef: b.id, detail: { code: b.code, subjectType: b.subjectType, subjectId: b.subjectId } }));
  }
  for (const [k, a] of lr) if (!rr.has(k)) out.push(item('decisions', 'removed', 'risk_acceptance', `risk:${k}`, { leftRef: a.id, detail: { code: a.code, subjectType: a.subjectType, subjectId: a.subjectId } }));

  const lf = new Set(l.reviewRiskFindingIds);
  const rf = new Set(r.reviewRiskFindingIds);
  for (const id of rf) {
    if (lf.has(id)) unchanged += 1;
    else out.push(item('decisions', 'added', 'finding_risk', `finding_risk:${id}`, { rightRef: id }));
  }
  for (const id of lf) if (!rf.has(id)) out.push(item('decisions', 'removed', 'finding_risk', `finding_risk:${id}`, { leftRef: id }));

  const lh = mapBy(l.holds, (h) => h.eventId);
  const rh = mapBy(r.holds, (h) => h.eventId);
  for (const [id, b] of rh) {
    const a = lh.get(id);
    if (!a) out.push(item('decisions', 'added', 'hold_decision', `hold:${id}`, { rightRef: b.decisionId, detail: { eventId: id, rightDecision: b.decision } }));
    else if (a.decision !== b.decision) out.push(item('decisions', 'changed', 'hold_decision', `hold:${id}`, { leftRef: a.decisionId, rightRef: b.decisionId, detail: { eventId: id, leftDecision: a.decision, rightDecision: b.decision } }));
    else unchanged += 1;
  }
  for (const [id, a] of lh) if (!rh.has(id)) out.push(item('decisions', 'removed', 'hold_decision', `hold:${id}`, { leftRef: a.decisionId, detail: { eventId: id, leftDecision: a.decision } }));
  return unchanged;
};

// ---------------------------------------------------------------- Приложения и файлы (§9.7)

const compareApplications = (l: IReleaseSnapshot, r: IReleaseSnapshot, out: IComparisonItem[]): number => {
  let unchanged = 0;
  const lm = mapBy(l.files, (f) => f.path);
  const rm = mapBy(r.files, (f) => f.path);
  const onlyLeft: IFileSnap[] = [];
  for (const [path, a] of lm) {
    const b = rm.get(path);
    if (!b) onlyLeft.push(a);
    else if (a.sha256 !== b.sha256) out.push(item('applications', 'changed', 'candidate_file', `file:${sha256Hex(path)}`, { leftRef: a.fileId, rightRef: b.fileId, leftSha256: a.sha256, rightSha256: b.sha256 }));
    else unchanged += 1;
  }
  const onlyRight = r.files.filter((f) => !lm.has(f.path));
  const same = pairBy(onlyLeft, onlyRight, (f) => f.sha256, (f) => f.path);
  for (const [a, b] of same.pairs) out.push(item('applications', 'renamed', 'candidate_file', `file:${sha256Hex(b.path)}`, { leftRef: a.fileId, rightRef: b.fileId, leftSha256: a.sha256, rightSha256: b.sha256 }));
  for (const b of same.right) out.push(item('applications', 'added', 'candidate_file', `file:${sha256Hex(b.path)}`, { rightRef: b.fileId, rightSha256: b.sha256 }));
  for (const a of same.left) out.push(item('applications', 'removed', 'candidate_file', `file:${sha256Hex(a.path)}`, { leftRef: a.fileId, leftSha256: a.sha256 }));

  const fieldKey = (f: IFieldSnap) => `${f.templateId}#${f.slot}:${f.fieldKey}`;
  const lf = mapBy(l.fields, fieldKey);
  const rf = mapBy(r.fields, fieldKey);
  for (const [k, b] of rf) {
    const a = lf.get(k);
    const detail = { templateId: b.templateId, slot: b.slot, fieldKey: b.fieldKey };
    if (!a) out.push(item('applications', 'added', 'field_version', `field:${k}`, { rightRef: b.versionId, rightSha256: b.valueSha256, detail }));
    else if (a.valueSha256 !== b.valueSha256) out.push(item('applications', 'changed', 'field_version', `field:${k}`, { leftRef: a.versionId, rightRef: b.versionId, leftSha256: a.valueSha256, rightSha256: b.valueSha256, detail }));
    else unchanged += 1;
  }
  for (const [k, a] of lf) if (!rf.has(k)) out.push(item('applications', 'removed', 'field_version', `field:${k}`, { leftRef: a.versionId, leftSha256: a.valueSha256, detail: { templateId: a.templateId, slot: a.slot, fieldKey: a.fieldKey } }));
  return unchanged;
};

// ---------------------------------------------------------------- Получено между выпусками (§10)

export type ReceivedStatus = 'in_scope' | 'out_of_scope' | 'late_recognized' | 'same_content_new_name' | 'not_recognized';

export interface IReceivedInput {
  kind: 'document_revision' | 'document_occurrence' | 'mail_message';
  // Редакция, место получения, письмо.
  id: string;
  // Редакция документа (у места получения — его редакция); у письма — ревизия письма в правом снимке, если есть.
  revisionId: string | null;
  sha256: string | null;
  // Получено в интервале (левое закрепление; правое закрепление].
  inInterval: boolean;
  // Место получения — не первое у своей редакции: то же содержимое под новым именем или из другого места.
  repeatOccurrence: boolean;
  inRightScope: boolean;
  rightRecognized: boolean;
  // Прогон распознавания правого снимка создан после левого закрепления.
  recognizedAfterLeft: boolean;
  // Решение руководителя по событию получения (комплект правой, затем левой стороны).
  disposition: 'not_applicable' | 'requires_new_candidate' | 'none';
  decisionId: string | null;
}

export const receivedStatus = (x: IReceivedInput): ReceivedStatus | null => {
  if (x.kind === 'document_occurrence') return x.inInterval && x.repeatOccurrence ? 'same_content_new_name' : null;
  if (x.kind === 'mail_message') return x.inInterval ? (x.inRightScope ? 'in_scope' : 'out_of_scope') : null;
  if (x.inInterval) return !x.inRightScope ? 'out_of_scope' : x.rightRecognized ? 'in_scope' : 'not_recognized';
  // Получена до левого закрепления, распознана после него и вошла в правый снимок распознанной (поздно распознана).
  return x.inRightScope && x.rightRecognized && x.recognizedAfterLeft ? 'late_recognized' : null;
};

const receivedItems = (inputs: readonly IReceivedInput[], out: IComparisonItem[]): void => {
  for (const x of inputs) {
    const status = receivedStatus(x);
    if (!status) continue;
    out.push(
      item('received', status, x.kind, `${x.kind}:${x.id}`, {
        rightRef: x.kind === 'document_revision' ? x.id : x.revisionId,
        rightSha256: x.sha256,
        detail: {
          ...(x.kind !== 'document_revision' ? { subjectId: x.id } : {}),
          ...(status === 'out_of_scope' ? { disposition: x.disposition, decisionId: x.decisionId } : {}),
        },
      }),
    );
  }
};

// ---------------------------------------------------------------- Итог

export type CalculationState = { state: 'same_revision'; revisionId: string } | { state: 'compared'; comparisonId: string; resultSha256: string } | { state: 'failed'; comparisonId: string; reason: string };

export interface IReleaseComparisonResult {
  items: IComparisonItem[];
  sections: Record<CompareSection, ISectionSummary>;
  resultSha256: string;
}

const SECTION_ORDER = new Map(COMPARE_SECTIONS.map((s, i) => [s, i]));

export const compareReleaseSnapshots = (left: IReleaseSnapshot, right: IReleaseSnapshot, received: readonly IReceivedInput[], calculation: CalculationState): IReleaseComparisonResult => {
  const items: IComparisonItem[] = [];
  const sections = {} as Record<CompareSection, ISectionSummary>;
  sections.sources = summary(left.sources.length, right.sources.length, compareSources(left.sources, right.sources, items), items, 'sources');
  const unavailable = !left.review && !right.review ? 'both' : !left.review ? 'left' : !right.review ? 'right' : null;
  if (left.review && right.review) {
    sections.requirements = summary(left.review.requirements.length, right.review.requirements.length, compareRequirements(left.review.requirements, right.review.requirements, items), items, 'requirements');
    sections.terms = summary(left.review.facts.length, right.review.facts.length, compareFacts(left.review.facts, right.review.facts, items), items, 'terms');
  } else {
    sections.requirements = { left: left.review?.requirements.length ?? 0, right: right.review?.requirements.length ?? 0, unchanged: 0, changes: {}, unavailable: unavailable! };
    sections.terms = { left: left.review?.facts.length ?? 0, right: right.review?.facts.length ?? 0, unchanged: 0, changes: {}, unavailable: unavailable! };
  }
  let questionsUnchanged = compareQa(left.qa, right.qa, items);
  if (left.review && right.review) questionsUnchanged += compareOpenQuestions(left.review.openQuestionIds, right.review.openQuestionIds, items);
  sections.questions = summary(left.qa.length + (left.review?.openQuestionIds.length ?? 0), right.qa.length + (right.review?.openQuestionIds.length ?? 0), questionsUnchanged, items, 'questions');
  const count = (s: IReleaseSnapshot) => s.decisions.length + s.risks.length + s.reviewRiskFindingIds.length + s.holds.length;
  sections.decisions = summary(count(left), count(right), compareDecisions(left, right, items), items, 'decisions');
  sections.applications = summary(left.files.length + left.fields.length, right.files.length + right.fields.length, compareApplications(left, right, items), items, 'applications');
  receivedItems(received, items);
  sections.received = summary(0, 0, 0, items, 'received');
  items.sort((a, b) => SECTION_ORDER.get(a.section)! - SECTION_ORDER.get(b.section)! || cmp(a.subjectType, b.subjectType) || cmp(a.change, b.change) || cmp(a.key, b.key));
  const resultSha256 = sha256Hex(
    `kontur.release_compare.v1\n${canonicalJson({
      method: RELEASE_COMPARE_METHOD,
      left: left.manifestSha256,
      right: right.manifestSha256,
      calculation: calculation.state === 'same_revision' ? { state: calculation.state } : calculation.state === 'compared' ? { state: calculation.state, resultSha256: calculation.resultSha256 } : { state: calculation.state, reason: calculation.reason },
      sections,
      items,
    })}`,
  );
  return { items, sections, resultSha256 };
};
