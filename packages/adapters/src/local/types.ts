// Локальное распознавание форматов вне охвата RDWeb (этап 05a, D-014, D-024). Результат разбора —
// единицы источника (страница PDF, лист XLSX, таблица CSV, тело DOCX) и фрагменты со структурным
// якорем. Координат у локальных фрагментов нет (D-014): якорь указывает место в структуре файла.

export type LocalInputFormat = 'pdf' | 'docx' | 'xlsx' | 'csv';
export type LocalUnitKind = 'pdf_page' | 'xlsx_sheet' | 'csv_table' | 'docx_body';
export type LocalUnitStatus = 'recognized' | 'needs_review' | 'missing' | 'failed';
export type LocalProcessing = 'structured_parser' | 'native_text' | 'native_text+ocr';
export type DocxPart = 'body' | 'footnotes' | 'endnotes';

// Структурный якорь (AD-05a-1). Номера — с единицы, как их видит человек.
export type LocalLocator =
  | { kind: 'pdf_text'; page: number; method: 'native_text' | 'ocr'; block: number }
  | {
      kind: 'xlsx_cells';
      sheet: string;
      sheetIndex: number;
      range: string;
      rowFrom: number;
      rowTo: number;
      colFrom: number;
      colTo: number;
      merged?: string[];
    }
  | { kind: 'csv_rows'; rowFrom: number; rowTo: number; colFrom: number; colTo: number; headerRow: number | null; lineFrom: number; lineTo: number }
  | { kind: 'docx_paragraph'; part: DocxPart; block: number; section: number }
  | { kind: 'docx_table_row'; part: DocxPart; block: number; section: number; table: number; row: number; cellFrom: number; cellTo: number };

// Метрики единицы (перенос донора Locus, apps/rag-api/src/converters.js: textQualityReport,
// recognitionNoiseReport, ocrPageReport). Уверенность движка — диагностическая метрика (OD-6).
export interface ITextMetrics {
  chars: number;
  words: number;
  letterRatio: number;
  replacementRatio: number;
  noiseRatio: number;
  noisyTokens: number;
}

export interface IUnitMetrics extends ITextMetrics {
  // Средняя уверенность OCR-движка по словам страницы, 0–100; null — OCR не выполнялся.
  ocrConfidence: number | null;
  // Символов встроенного текстового слоя PDF до решения об OCR.
  nativeChars: number | null;
}

export interface ILocalUnit {
  index: number;
  kind: LocalUnitKind;
  // Имя листа XLSX или номер страницы PDF; у CSV и DOCX — null.
  label: string | null;
  widthPx: number | null;
  heightPx: number | null;
  // Поворот страницы PDF; у логической единицы — 0.
  rotation: number;
  status: LocalUnitStatus;
  method: 'native_text' | 'ocr' | 'structured';
  metrics: IUnitMetrics;
  issues: string[];
}

export interface ILocalFragment {
  unitIndex: number;
  key: string;
  ordinal: number;
  origin: 'document_text' | 'recognized_text';
  text: string;
  locator: LocalLocator;
  warnings: string[];
  partIndex: number;
  partTotal: number;
}

export interface ILocalResult {
  units: ILocalUnit[];
  fragments: ILocalFragment[];
  // Пропущенные части файла, которые не являются текстом документа (колонтитулы, примечания рецензента,
  // пустые листы, диаграммы): записываются в качество прогона, а не теряются молча.
  skipped: Record<string, number>;
  warnings: string[];
  // Кодировка и разделитель CSV, диапазон страниц OCR и т. п. — без содержимого документа.
  facts: Record<string, string | number | boolean>;
}

// Коды отказа локального прогона: явный отказ вместо угадывания (OD-4, OD-6).
export type LocalFailureCode =
  | 'unsupported_format'
  | 'file_corrupt'
  | 'unsafe_package'
  | 'unsupported_structure'
  | 'encoding_unsupported'
  | 'too_large'
  | 'pdf_unreadable'
  | 'ocr_unavailable'
  | 'ocr_failed'
  | 'no_usable_text'
  | 'recognizer_changed';

export class LocalRecognitionError extends Error {
  readonly code: LocalFailureCode;
  constructor(code: LocalFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

// Пределы разбора (A38 и «очень большой файл», тест 18 решения владельца).
export interface ILocalLimits {
  maxInputBytes: number;
  maxUnzippedBytes: number;
  maxPartBytes: number;
  maxCompressionRatio: number;
  maxZipEntries: number;
  maxCells: number;
  maxPages: number;
  maxOcrPages: number;
  maxTotalTextChars: number;
  maxFragmentChars: number;
}

export const DEFAULT_LOCAL_LIMITS: ILocalLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxUnzippedBytes: 256 * 1024 * 1024,
  maxPartBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxZipEntries: 5000,
  maxCells: 1_000_000,
  maxPages: 10_000,
  maxOcrPages: 300,
  maxTotalTextChars: 64 * 1024 * 1024,
  maxFragmentChars: 20_000,
};

// Буквенное имя столбца Excel: 1 → A, 27 → AA.
export const columnName = (index: number): string => {
  let value = index;
  let name = '';
  while (value > 0) {
    const rem = (value - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
};
