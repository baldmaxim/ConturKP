// Вход и выход программных проверок этапа 09 (09-review-checks-design.md §4): закреплённый вход прогона и черновики
// замечаний с основаниями сторон.
import type { FactType } from '../facts/types.ts';
import type { IRequirementParameter } from '../requirements.ts';
import type { CheckOutcome, Confidence, FindingKind, RuleCheckCode, SourceKind } from './types.ts';

// ---------------------------------------------------------------- Вход

export interface IReviewUnit {
  scopeItemId: string;
  unitType: string;
  label: string;
  // Технический статус единицы (Р-08-7): прогона нет или текста нет.
  technicalStatus: 'ok' | 'not_recognized' | 'no_fragments';
  runStatus: string | null;
  pagesTotal: number | null;
  pagesRecognized: number | null;
  pagesFailed: number;
}

export interface IBasisFragment {
  fragmentId: string;
  documentRevisionId: string | null;
  sourceKind: SourceKind | null;
}

export interface ICoverageObject {
  type: 'evidence_fragment' | 'calculation_revision' | 'decision' | 'manual_confirmation';
  calculationRevisionId: string | null;
  externalPositionId: string | null;
  externalItemId: string | null;
  match: 'explicit_line' | 'complex_rate' | null;
  unitStatus: 'match' | 'mismatch' | 'not_comparable' | null;
}

export interface IReviewRequirement {
  requirementId: string;
  revisionId: string;
  code: string;
  parameters: IRequirementParameter[];
  supports: IBasisFragment[];
  contradicts: IBasisFragment[];
  // Основание — документ договора (06a) или документ вида «договор».
  fromContract: boolean;
  conflicts: { requirementId: string; parameter: string }[];
  conflictNote: string | null;
  coverage: { id: string; state: string; reason: string | null; unitMismatchReason: string | null; objects: ICoverageObject[] } | null;
  hasAssumptionOrQuestion: boolean;
}

export interface ICalcObjectText {
  // Тексты строки и позиции, единица и величина объекта (строки — количество, позиции — объём).
  texts: string[];
  unit: string | null;
  quantity: number | null;
}

export interface IReviewPosition {
  externalPositionId: string;
  name: string;
  unit: string | null;
  section: string | null;
  volume: number | null;
  total: number | null;
  isSection: boolean;
}

export interface IReviewFact {
  factId: string;
  factType: FactType;
  status: 'active' | 'superseded' | 'conflict';
  rawValue: string;
  fragmentIds: string[];
  supersededByFactId: string | null;
  sourceKind: SourceKind | null;
}

export interface IReviewQuestion {
  kind: 'customer_question' | 'qa_item';
  id: string;
  // Для вопросов–ответов — ревизия; для вопроса заказчику — сам вопрос.
  revisionId: string | null;
  fragmentIds: string[];
  askedAt: string | null;
}

export interface IReviewFragment {
  fragmentId: string;
  text: string;
  origin: string;
  hasAssumption: boolean;
}

export interface IReviewInput {
  priority: readonly SourceKind[];
  units: IReviewUnit[];
  importsPending: number;
  registry: { id: string; passCompleted: boolean; unreviewed: number; total: number } | null;
  calculationRevisionId: string | null;
  calcObjects: ReadonlyMap<string, ICalcObjectText>;
  positions: IReviewPosition[];
  requirements: IReviewRequirement[];
  // Фрагменты текста документов снимка с фразами неопределённости ПД (C08) и общее число фрагментов текста документов.
  fragments: IReviewFragment[];
  fragmentsTotal: number;
  facts: IReviewFact[];
  factConflicts: { factIds: string[] }[];
  // Редакции документов оснований, у которых есть более новая редакция: старая → новая.
  newerRevisions: ReadonlyMap<string, string>;
  questions: IReviewQuestion[];
  // Единицы снимка, по которым факты текущих правил ещё не извлечены: конфликты фактов и перекрытия не проверены.
  factsPendingUnits: number;
}

// ---------------------------------------------------------------- Выход

export interface IEvidenceDraft {
  side: 'left' | 'right' | 'context';
  objectType: 'fragment' | 'calculation_object' | 'requirement_revision' | 'evidence_fact' | 'customer_question' | 'qa_item_revision' | 'assumption' | 'document_revision';
  fragmentId?: string;
  calculationRevisionId?: string;
  externalPositionId?: string;
  externalItemId?: string | null;
  requirementRevisionId?: string;
  evidenceFactId?: string;
  customerQuestionId?: string;
  qaItemRevisionId?: string;
  documentRevisionId?: string;
  note?: string;
}

export interface IFindingDraft {
  key: string;
  kind: FindingKind;
  check: RuleCheckCode;
  title: string;
  detail: string | null;
  confidence: Confidence;
  action: string | null;
  suggestedSide: 'left' | 'right' | null;
  evidence: IEvidenceDraft[];
}

export interface ICheckResult {
  check: RuleCheckCode;
  outcome: CheckOutcome;
  reason: string | null;
  counts: Record<string, number>;
}

// ---------------------------------------------------------------- Закреплённый вход (R09-02)

// Вход прогона закрепляется при запуске как JSON: отображения — массивами пар; порядок полей не влияет на хэш.
export const serializeReviewInput = (input: IReviewInput): Record<string, unknown> => ({
  ...input,
  calcObjects: [...input.calcObjects.entries()],
  newerRevisions: [...input.newerRevisions.entries()],
});

export const parseReviewInput = (json: Record<string, unknown>): IReviewInput => {
  const raw = json as unknown as Omit<IReviewInput, 'calcObjects' | 'newerRevisions'> & { calcObjects: [string, ICalcObjectText][]; newerRevisions: [string, string][] };
  return { ...raw, calcObjects: new Map(raw.calcObjects), newerRevisions: new Map(raw.newerRevisions) };
};

