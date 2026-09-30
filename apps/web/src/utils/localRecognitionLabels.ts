// Подписи локального распознавания (этап 05a, D-024): движок, итог прогона словарём владельца (OD-6),
// вид единицы и структурный якорь (AD-05a-1), признаки качества, причины отказа, политика маршрута PDF.
import type { TFragmentOrigin, TLocalLocator, TRecognitionOutcome, TRecognitionRoute, TRecognitionUnitKind } from '../api/types';
import { formatTimecode } from './mailLabels';
import { FRAGMENT_ORIGIN, recognitionFailureLabel, type IBadgeMeta } from './sourceLabels';

export const ENGINE_LABELS: Record<string, string> = {
  rdweb_export: 'Экспорт RDWeb',
  rdweb_api: 'RDWeb',
  local_ocr: 'Локальное распознавание',
  text_layer: 'Текстовый слой',
};

export const engineLabel = (engine: string | null | undefined): string => (engine ? (ENGINE_LABELS[engine] ?? engine) : '');

export const isLocalEngine = (engine: string | null | undefined): boolean => engine === 'local_ocr';

export const RECOGNITION_OUTCOME: Record<TRecognitionOutcome, IBadgeMeta> = {
  queued: { label: 'В очереди', icon: 'hourglass', tone: 'muted' },
  running: { label: 'Выполняется', icon: 'loader-circle', tone: 'info' },
  complete: { label: 'Полностью', icon: 'check', tone: 'success' },
  needs_review: { label: 'Требует проверки', icon: 'file-exclamation-point', tone: 'warning', dashed: true },
  failed: { label: 'Не распознано', icon: 'circle-x', tone: 'danger' },
  cancelled: { label: 'Отменено', icon: 'circle-x', tone: 'muted', dashed: true },
};

export const UNIT_KIND_LABELS: Record<TRecognitionUnitKind, string> = {
  pdf_page: 'страница PDF',
  xlsx_sheet: 'лист книги',
  csv_table: 'таблица CSV',
  docx_body: 'текст документа',
};

// Происхождение с учётом движка (A43, I06): распознанный текст локального OCR не выдаётся за RDWeb.
export const originMeta = (origin: TFragmentOrigin, engine: string | null | undefined): IBadgeMeta => {
  const base = FRAGMENT_ORIGIN[origin];
  if (!isLocalEngine(engine)) {
    return base;
  }
  if (origin === 'recognized_text') {
    return { ...base, label: 'Распознанный текст · локальный OCR', dashed: true };
  }
  if (origin === 'document_text') {
    return { ...base, label: 'Текст документа · локально' };
  }
  return base;
};

const PART_LABELS: Record<string, string> = { body: '', footnotes: 'Сноски: ', endnotes: 'Концевые сноски: ' };

/** «Лист «Сводная», A7:E7», «Строка 12», «Таблица 1, строка 3», «Стр. 2, блок 1 · OCR». */
export const anchorLabel = (l: TLocalLocator): string => {
  switch (l.kind) {
    case 'pdf_text':
      return `Стр. ${l.page}, блок ${l.block}${l.method === 'ocr' ? ' · OCR' : ''}`;
    case 'xlsx_cells':
      return `Лист «${l.sheet}», ${l.range}`;
    case 'csv_rows':
      return l.rowFrom === l.rowTo ? `Строка ${l.rowFrom}` : `Строки ${l.rowFrom}–${l.rowTo}`;
    case 'docx_paragraph':
      return `${PART_LABELS[l.part] ?? ''}абзац ${l.block}, раздел ${l.section}`.replace(/^а/u, 'А');
    case 'docx_table_row':
      return `${PART_LABELS[l.part] ?? ''}таблица ${l.table}, строка ${l.row}`.replace(/^т/u, 'Т');
    case 'mail_body':
      return `Блок ${l.block} текста письма${l.quoted ? ' · цитата прежней переписки' : ''}`;
    case 'transcript_segment':
      return `Сегмент ${l.segment} · ${formatTimecode(l.startMs)}–${formatTimecode(l.endMs)}`;
  }
};

export const LOCAL_ISSUE_LABELS: Record<string, string> = {
  text_layer_insufficient: 'текстового слоя нет или его мало',
  ocr_unavailable: 'OCR не настроен',
  ocr_empty: 'OCR не нашёл текста',
  ocr_unreadable: 'текст OCR нечитаем — в доказательства не взят',
  low_ocr_confidence: 'низкая уверенность OCR',
  low_text_density: 'мало букв в тексте',
  encoding_noise: 'сломанная кодировка текста',
  ocr_page_failed: 'сбой OCR страницы',
  formula_without_value: 'формула без сохранённого значения',
  unterminated_quote: 'незакрытая кавычка — структура таблицы нарушена',
  docx_alt_chunk: 'внедрённый фрагмент не прочитан',
  bad_shared_string: 'ссылка на отсутствующую строку книги',
  cell_outside_row: 'ячейка вне своей строки',
  sheet_name_invalid: 'некорректное имя листа',
};

export const localIssueLabel = (code: string): string => LOCAL_ISSUE_LABELS[code] ?? code;

const LOCAL_FAILURE_LABELS: Record<string, string> = {
  unsupported_format: 'Формат не входит в перечень локального распознавания',
  file_corrupt: 'Файл повреждён',
  unsafe_package: 'Файл небезопасен: выход за корень, шифрование или zip-бомба',
  unsupported_structure: 'Структура файла не поддерживается',
  encoding_unsupported: 'Кодировка CSV не UTF-8 и не Windows-1251',
  too_large: 'Файл превышает пределы разбора',
  pdf_unreadable: 'PDF не открывается или защищён паролем',
  ocr_unavailable: 'Нужен OCR, а он не настроен',
  ocr_failed: 'OCR не удался на нескольких страницах подряд',
  no_usable_text: 'Пригодного текста нет',
  recognizer_changed: 'Распознаватель изменился после постановки — нужна новая постановка',
};

export const localFailureLabel = (code: string | null, engine: string | null | undefined): string =>
  isLocalEngine(engine) && code ? (LOCAL_FAILURE_LABELS[code] ?? recognitionFailureLabel(code)) : recognitionFailureLabel(code);

export const ROUTE_LABELS: Record<TRecognitionRoute, string> = {
  auto: 'Авто: локально — только по команде',
  local: 'Разрешено локальное распознавание',
  rdweb: 'Только RDWeb',
};

export const ROUTES = Object.keys(ROUTE_LABELS) as TRecognitionRoute[];

const LOCAL_FORMATS = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
]);

/** Перечень локального распознавания (OD-4): PDF, DOCX, XLSX, CSV. */
export const isLocalFormat = (mediaType: string | null | undefined): boolean => !!mediaType && LOCAL_FORMATS.has(mediaType);
export const isPdf = (mediaType: string | null | undefined): boolean => mediaType === 'application/pdf';
