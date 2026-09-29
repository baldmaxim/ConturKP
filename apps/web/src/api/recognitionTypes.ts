// ---- распознавание и доказательства (этап 04)

export type TRecognitionStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
export type TRecognitionPageStatus = 'recognized' | 'missing' | 'failed';
export type TFragmentOrigin = 'document_text' | 'recognized_text' | 'model_description' | 'negotiation_speech' | 'negotiation_hint' | 'email_body' | 'attachment_text';
export type TFragmentKind =
  | 'text_block'
  | 'image_block'
  | 'stamp_block'
  | 'unknown_block'
  | 'summary'
  | 'description'
  | 'entities'
  | 'verification'
  | 'unknown_section';
export type TBboxSpace = 'page_unrotated' | 'page_rotated';

export interface IRecognitionRun {
  id: string;
  documentRevisionId: string;
  documentId: string;
  tenderId: string;
  engine: string;
  engineSchemaVersion: string | null;
  sourceArtifactSha256: string;
  sourceArtifactName: string | null;
  status: TRecognitionStatus;
  pagesTotal: number | null;
  pagesRecognized: number;
  supersedesRunId: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  contentUrl: string;
}

export interface IRecognitionRunAccepted extends IRecognitionRun {
  /** true — архив уже импортировался: второго прогона той же пары не создаётся. */
  reused: boolean;
}

export interface IRecognitionPage {
  pageIndex: number;
  pageLabel: string | null;
  /** Номер листа из штампа: это НЕ номер страницы файла. */
  sheetLabel: string | null;
  widthPx: number | null;
  heightPx: number | null;
  rotation: number;
  status: TRecognitionPageStatus;
}

export interface IRecognitionWarning {
  code: string;
  count: number;
  sample: string;
}

export interface IRecognitionQuality {
  documentName?: string | null;
  coordinateSpace?: string;
  counts?: Record<string, number>;
  warnings?: IRecognitionWarning[];
  archive?: { pdfMember: string | null; extras: string[]; ignored: string[] };
}

export interface IRecognitionRunDetail extends IRecognitionRun {
  supersededByRunId: string | null;
  quality: IRecognitionQuality;
  missingPages: number[];
  pages: IRecognitionPage[];
}

export interface IEvidenceFragment {
  id: string;
  runId: string | null;
  documentRevisionId: string | null;
  origin: TFragmentOrigin;
  fragmentKind: TFragmentKind;
  externalBlockId: string | null;
  ordinal: number | null;
  pageIndex: number | null;
  bboxNorm: number[] | null;
  bboxSpace: TBboxSpace | null;
  shapeType: 'rectangle' | 'polygon' | null;
  polygonNorm: number[] | null;
  rotation: number | null;
  text: string;
  textSha256: string;
  derivedModelRef: string | null;
  /** Справочная ссылка экспорта. Портал её не загружает — показывается текстом (A38). */
  externalCropUrl: string | null;
  warnings: string[];
  /** Часть длинного текста блока: доказательство разбито, а не усечено. */
  partIndex: number;
  partTotal: number;
}

export interface IFragmentPage {
  items: IEvidenceFragment[];
  nextCursor: string | null;
}

export interface IEvidenceDetail extends IEvidenceFragment {
  tenderId: string;
  documentId: string | null;
  runStatus: TRecognitionStatus | null;
  pageLabel: string | null;
  sheetLabel: string | null;
  pageWidthPx: number | null;
  pageHeightPx: number | null;
  pageStatus: TRecognitionPageStatus | null;
  contentUrl: string | null;
}

export interface IFreezeBlockingItem {
  documentRevisionId: string;
  contractId: string | null;
  restricted: boolean;
  documentId: string | null;
  documentTitle: string | null;
  revisionSeq: number;
  reason: 'no_recognition' | 'recognition_in_progress' | 'recognition_failed' | 'recognition_cancelled';
}
