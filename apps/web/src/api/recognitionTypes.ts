// ---- распознавание и доказательства (этап 04)

export type TRecognitionStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
// needs_review — единица прочитана, но не прошла шлюз качества локального распознавания (этап 05a, OD-6).
export type TRecognitionPageStatus = 'recognized' | 'missing' | 'failed' | 'needs_review';
/** Итог прогона словарём владельца (OD-6): partial показывается как «требует проверки». */
export type TRecognitionOutcome = 'queued' | 'running' | 'complete' | 'needs_review' | 'failed' | 'cancelled';
/** Единица источника (AD-05a-1): страница PDF или логическая единица файла без пикселей. */
export type TRecognitionUnitKind = 'pdf_page' | 'xlsx_sheet' | 'csv_table' | 'docx_body';

/** Структурный якорь локального фрагмента (AD-05a-1). Номера — с единицы. */
export type TLocalLocator =
  | { kind: 'pdf_text'; page: number; method: 'native_text' | 'ocr'; block: number }
  | { kind: 'xlsx_cells'; sheet: string; sheetIndex: number; range: string; rowFrom: number; rowTo: number; colFrom: number; colTo: number; merged?: string[] }
  | { kind: 'csv_rows'; rowFrom: number; rowTo: number; colFrom: number; colTo: number; headerRow: number | null; lineFrom: number; lineTo: number }
  | { kind: 'docx_paragraph'; part: 'body' | 'footnotes' | 'endnotes'; block: number; section: number }
  | { kind: 'docx_table_row'; part: 'body' | 'footnotes' | 'endnotes'; block: number; section: number; table: number; row: number; cellFrom: number; cellTo: number };

export interface ILocalRecognizerInfo {
  recognizerId: string;
  recognizerVersion: string;
  inputFormat: string;
  processing: string;
  languages: string[];
}
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
  outcome: TRecognitionOutcome;
  /** Прогон выбирается автоподбором снимка и текущей области (AD-05a-3). */
  preferred: boolean;
  mediaType: string;
  /** Локальный прогон: автоматический проход или явная команда; у RDWeb — импорт экспорта. */
  trigger: 'auto' | 'command' | 'import';
  recognizer: ILocalRecognizerInfo | null;
  recognizerFingerprint: string | null;
  recognizerConfigHash: string | null;
}

/** Ответ команды локального распознавания: без качества и текста (этап 05a). */
export interface ILocalRecognitionAccepted {
  reused: boolean;
  run: { id: string; documentRevisionId: string; engine: string; status: TRecognitionStatus; outcome: TRecognitionOutcome; createdAt: string };
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
  unitKind: TRecognitionUnitKind;
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
  // Локальный прогон (этап 05a): итог, признаки единиц и пропуски — без текста документа.
  verdict?: 'complete' | 'needs_review' | 'failed';
  units?: { index: number; kind: TRecognitionUnitKind; status: TRecognitionPageStatus; method: string; issues: string[]; metrics: Record<string, number | null> }[];
  skipped?: Record<string, number>;
  facts?: Record<string, string | number | boolean>;
}

export interface IRecognitionRunDetail extends IRecognitionRun {
  supersededByRunId: string | null;
  quality: IRecognitionQuality;
  missingPages: number[];
  reviewUnits: number[];
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
  /** Якорь локального фрагмента; у RDWeb — null. Координат у локального фрагмента нет (D-014). */
  locator: TLocalLocator | null;
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
  unitKind: TRecognitionUnitKind | null;
  runEngine: string | null;
  runOutcome: TRecognitionOutcome | null;
  mediaType: string | null;
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
