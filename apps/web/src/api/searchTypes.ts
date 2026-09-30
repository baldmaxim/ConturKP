import type { TFragmentKind, TFragmentOrigin, TLocalLocator, TRecognitionOutcome, TRecognitionUnitKind } from './recognitionTypes';

// ---- поиск и снимок области (этап 05; portal-api §2.3–2.4)

export type TSearchRunStatus = 'pending' | 'complete' | 'degraded' | 'failed';
export type TSemanticStatus = 'queued' | 'running' | 'complete' | 'unavailable' | 'failed' | 'timeout' | 'cancelled';
export type TSearchBranch = 'exact' | 'fts' | 'vector';

export interface ISearchHit {
  rank: number;
  fragmentId: string;
  origin: TFragmentOrigin;
  matchedVia: TSearchBranch[];
  score: number;
  /** Фрагмент документа договора (этап 06a). */
  contractId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  documentRevisionId: string | null;
  revisionSeq: number | null;
  recognitionRunId: string | null;
  fragmentKind: TFragmentKind | null;
  pageIndex: number | null;
  pageLabel: string | null;
  sheetLabel: string | null;
  /** A43: движок и итог прогона-источника; у локального — якорь и вид единицы. */
  engine: string | null;
  runOutcome: TRecognitionOutcome | null;
  unitKind: TRecognitionUnitKind | null;
  locator: TLocalLocator | null;
  text: string;
  textTruncated: boolean;
}

export interface ISearchRun {
  searchRunId: string;
  status: TSearchRunStatus;
  context: {
    kind: 'tender' | 'contract';
    tenderId: string | null;
    contractId: string | null;
    mode: 'working' | 'review';
    stageId: string | null;
    evidenceScopeId: string | null;
  };
  query: string;
  scopeHash: string;
  scope: {
    units: number;
    pagesRecognized: number;
    pagesTotal: number;
    unitsNotIndexed: number;
    revisionsWithoutRun: number;
    excludedByAcl: number;
    localUnits: number;
    localNeedsReview: number;
  };
  incomplete: boolean;
  semantic: { status: TSemanticStatus; reason: string | null };
  index: { versionId: string; seq: number | null; embeddingModel: string | null };
  rankingVersion: string;
  branchCounts: Record<TSearchBranch, number>;
  /** Слияние точной и полнотекстовой веток, пока смысловая не готова. Итогом не является. */
  lexical: { preliminary: true; items: ISearchHit[] } | null;
  fused: { items: ISearchHit[] } | null;
  emptyMessage: string | null;
  failureCode: string | null;
  deadlineAt: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface IEvidenceScope {
  id: string;
  stageId: string;
  tenderId: string;
  sourceSetRevisionId: string;
  inputVersion: number;
  contentHash: string;
  createdAt: string;
  units: number | null;
  reused?: boolean;
}
