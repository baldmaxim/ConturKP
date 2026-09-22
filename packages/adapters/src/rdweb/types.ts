// Адаптер RDWeb (docs/contracts/adapters.md §3). Чистый разбор: на вход — байты и строки
// из архива, на выход — страницы, фрагменты и предупреждения. Ни сети, ни файловой системы,
// ни БД: внешние ссылки экспорта (crop_url) сохраняются как текст и не загружаются (A38).

export type RdwebFailureCode =
  | 'pdf_missing'
  | 'pdf_mismatch'
  | 'blocks_json_missing'
  | 'blocks_json_invalid'
  | 'results_md_missing'
  | 'schema_version_unsupported'
  | 'coordinate_space_unsupported'
  | 'archive_unsafe'
  | 'archive_corrupt'
  | 'too_large'
  // Достоверное число страниц оригинала получить не удалось: без него полнота недоказуема (R04-03).
  | 'pdf_unreadable'
  // Metadata принадлежит другому комплекту экспорта, чем совпавший по SHA-256 PDF (R04-08).
  | 'export_group_mismatch';

export type RdwebFragmentOrigin = 'recognized_text' | 'model_description';
export type RdwebFragmentKind =
  | 'text_block'
  | 'image_block'
  | 'stamp_block'
  | 'unknown_block'
  | 'summary'
  | 'description'
  | 'entities'
  | 'verification'
  | 'unknown_section';

export interface IRdwebPage {
  pageIndex: number;
  pageLabel: string | null;
  sheetLabel: string | null;
  widthPx: number | null;
  heightPx: number | null;
  rotation: number;
  status: 'recognized' | 'missing';
}

export interface IRdwebFragment {
  origin: RdwebFragmentOrigin;
  fragmentKind: RdwebFragmentKind;
  fragmentKey: string;
  externalBlockId: string | null;
  ordinal: number | null;
  pageIndex: number | null;
  bboxNorm: number[] | null;
  bboxSpace: 'page_unrotated' | 'page_rotated' | null;
  shapeType: 'rectangle' | 'polygon' | null;
  polygonNorm: number[] | null;
  rotation: number | null;
  text: string;
  textSha256: string;
  derivedModelRef: string | null;
  externalCropUrl: string | null;
  warnings: string[];
  // Часть длинного текста блока: разбиение вместо усечения, текст восстановим склейкой (R04-06).
  partIndex: number;
  partTotal: number;
}

// Предупреждение уровня прогона: код и пример, а не поток строк. Копится счётчиком, чтобы
// тысяча одинаковых расхождений не превращалась в тысячу записей.
export interface IRdwebWarning {
  code: string;
  count: number;
  sample: string;
}

export interface IRdwebImport {
  schemaVersion: string;
  documentName: string | null;
  coordinateSpace: string;
  pagesTotal: number;
  pagesRecognized: number;
  status: 'complete' | 'partial';
  pages: IRdwebPage[];
  fragments: IRdwebFragment[];
  warnings: IRdwebWarning[];
  counts: Record<string, number>;
}

export interface IRdwebFailure {
  code: RdwebFailureCode;
  message: string;
}

export type RdwebResult<T> = { ok: true; value: T } | { ok: false; error: IRdwebFailure };

export interface IRdwebLimits {
  maxPages: number;
  maxBlocks: number;
  // Суммарная длина текста всех фрагментов одного прогона. Превышение — отказ, а не молчаливая потеря.
  maxTotalTextChars: number;
  // Жёсткая граница одного фрагмента: совпадает с CHECK таблицы evidence_fragment.
  maxFragmentChars: number;
}

export const DEFAULT_LIMITS: IRdwebLimits = {
  maxPages: 10_000,
  maxBlocks: 200_000,
  maxTotalTextChars: 64 * 1024 * 1024,
  maxFragmentChars: 1_000_000,
};

// Накопитель предупреждений: один код — одна строка с числом и первым примером.
export class WarningBag {
  private readonly map = new Map<string, IRdwebWarning>();

  add(code: string, sample: string): void {
    const found = this.map.get(code);
    if (found) found.count += 1;
    else this.map.set(code, { code, count: 1, sample: sample.slice(0, 200) });
  }

  list(): IRdwebWarning[] {
    return [...this.map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  has(code: string): boolean {
    return this.map.has(code);
  }
}
