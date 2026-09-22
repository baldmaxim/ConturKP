// Подписи и оформление статусов источников этапа 03 (BRAND.md §4: подпись + иконка + цвет).
import type {
  IImportItem,
  TFragmentKind,
  TFragmentOrigin,
  TRecognitionPageStatus,
  TRecognitionStatus,
  TBatchStatus,
  TChannelOrigin,
  TDocType,
  TInclusion,
  TItemResolution,
  TItemStatus,
  TOccurrenceKind,
  TRejectReason,
} from '../api/types';
import type { TBadgeTone } from '../components/Badge';
import type { TIconName } from '../components/Icon';

export interface IBadgeMeta {
  label: string;
  icon: TIconName;
  tone: TBadgeTone;
  dashed?: boolean;
}

const lookup = <K extends string>(map: Record<K, string>, code: string | null | undefined): string =>
  code && code in map ? map[code as K] : (code ?? '');

export const BATCH_STATUS: Record<TBatchStatus, IBadgeMeta> = {
  running: { label: 'Обрабатывается', icon: 'hourglass', tone: 'info' },
  completed: { label: 'Готово', icon: 'check', tone: 'success' },
  completed_with_errors: { label: 'Есть отклонённые файлы', icon: 'file-exclamation-point', tone: 'warning', dashed: true },
  failed: { label: 'Сбой обработки', icon: 'circle-x', tone: 'danger' },
};

export const ITEM_STATUS: Record<TItemStatus, IBadgeMeta> = {
  pending: { label: 'Ожидает', icon: 'hourglass', tone: 'muted' },
  registered: { label: 'Зарегистрирован', icon: 'check', tone: 'success' },
  duplicate: { label: 'Дубликат — уже есть такая редакция', icon: 'copy', tone: 'neutral' },
  rejected: { label: 'Отклонён', icon: 'circle-x', tone: 'danger' },
  skipped_partial: { label: 'Файл не докопирован', icon: 'file-exclamation-point', tone: 'warning', dashed: true },
};

export const RESOLUTION: Record<Exclude<TItemResolution, 'none'>, IBadgeMeta> = {
  reimported: { label: 'Заменён повторным импортом', icon: 'repeat', tone: 'neutral' },
  not_applicable: { label: 'Признан неприменимым', icon: 'user-check', tone: 'accent' },
};

/** Отклонённый элемент без исхода блокирует готовность этапа. */
export const NEEDS_OUTCOME: IBadgeMeta = { label: 'Нужен исход', icon: 'hourglass', tone: 'warning', dashed: true };

/** Отклонённый или недокопированный элемент без исхода. */
export const needsOutcome = (item: IImportItem): boolean =>
  (item.status === 'rejected' || item.status === 'skipped_partial') && item.resolution === 'none';

export const REJECT_REASON_LABELS: Record<TRejectReason, string> = {
  path_traversal: 'Путь вне архива или ссылка',
  size_limit: 'Превышен лимит размера',
  type_not_allowed: 'Тип файла не допускается',
  unstable_file: 'Файл менялся при чтении',
  corrupt: 'Файл повреждён',
};

export const rejectReasonLabel = (code: string | null): string => lookup(REJECT_REASON_LABELS, code);

export const BATCH_SOURCE_LABELS: Record<string, string> = {
  upload: 'Загрузка',
  watched_folder: 'Наблюдаемая папка',
};

export const OCCURRENCE_KIND_LABELS: Record<TOccurrenceKind, string> = {
  upload: 'Загрузка',
  archive_member: 'Из архива',
  watched_folder: 'Наблюдаемая папка',
  yandex_disk: 'Яндекс Диск',
  smb: 'Сетевая папка',
  rdweb_export: 'Экспорт RDWeb',
};

export const occurrenceKindLabel = (code: string): string => lookup(OCCURRENCE_KIND_LABELS, code);

export const DOC_TYPE_LABELS: Record<TDocType, string> = {
  tz: 'ТЗ',
  pd: 'ПД',
  rd: 'РД',
  contract: 'Договор',
  boq: 'ВОР',
  qa_form: 'Вопросы-ответы',
  letter: 'Письмо',
  minutes: 'Протокол',
  supplier_quote: 'КП поставщика',
  other: 'Прочее',
};

export const DOC_TYPES = Object.keys(DOC_TYPE_LABELS) as TDocType[];

export const docTypeLabel = (code: string): string => lookup(DOC_TYPE_LABELS, code);

export const INCLUSION_LABELS: Record<TInclusion, string> = {
  included: 'Включена',
  excluded_not_applicable: 'Исключена (неприменимо)',
};

export const CHANNEL_ORIGIN_LABELS: Record<TChannelOrigin, string> = {
  local: 'Локальная',
  yandex_disk: 'Яндекс Диск',
  smb: 'Сетевая папка',
};

export const channelOriginLabel = (code: string): string => lookup(CHANNEL_ORIGIN_LABELS, code);

export const CHANNEL_ERROR_LABELS: Record<string, string> = {
  share_unavailable: 'Папка недоступна',
  outside_intake_root: 'Папка вне разрешённого корня',
  intake_root_not_configured: 'На сервере не заданы корни папок',
  overlaps_storage: 'Папка пересекается с хранилищем',
  internal: 'Внутренняя ошибка',
};

export const channelErrorLabel = (code: string): string => CHANNEL_ERROR_LABELS[code] ?? `Ошибка: ${code}`;

export const INPUT_EVENT_LABELS: Record<string, string> = {
  import_accepted: 'Принята загрузка',
  document_revision_registered: 'Зарегистрирована редакция',
  source_set_changed: 'Изменён состав источников',
  recognition_run_completed: 'Завершено распознавание',
};

export const inputEventLabel = (code: string): string => INPUT_EVENT_LABELS[code] ?? code;

// Статусы прогона распознавания. Слова «проверено» и «полностью» не используются:
// полноту подтверждает только отдельная проверка, а не факт импорта (I18).
export const RECOGNITION_STATUS: Record<TRecognitionStatus, IBadgeMeta> = {
  queued: { label: 'В очереди', icon: 'hourglass', tone: 'muted' },
  running: { label: 'Выполняется', icon: 'loader-circle', tone: 'info' },
  complete: { label: 'Распознавание завершено', icon: 'check', tone: 'success' },
  partial: { label: 'Распознано частично', icon: 'file-exclamation-point', tone: 'warning', dashed: true },
  failed: { label: 'Распознавание не принято', icon: 'circle-x', tone: 'danger' },
  cancelled: { label: 'Распознавание отменено', icon: 'circle-x', tone: 'muted', dashed: true },
};

export const RECOGNITION_PAGE_STATUS: Record<TRecognitionPageStatus, IBadgeMeta> = {
  recognized: { label: 'Распознана', icon: 'check', tone: 'success' },
  missing: { label: 'Не распознана', icon: 'file-question-mark', tone: 'warning', dashed: true },
  failed: { label: 'Ошибка страницы', icon: 'circle-x', tone: 'danger' },
};

export const RECOGNITION_FAILURE_LABELS: Record<string, string> = {
  pdf_missing: 'В архиве нет PDF',
  pdf_mismatch: 'PDF экспорта не совпадает с редакцией документа',
  blocks_json_missing: 'В архиве нет _blocks.json',
  blocks_json_invalid: 'Файл _blocks.json не разобран',
  results_md_missing: 'В архиве нет _results.md',
  schema_version_unsupported: 'Версия схемы экспорта не поддерживается',
  coordinate_space_unsupported: 'Пространство координат не поддерживается',
  archive_unsafe: 'В архиве небезопасный элемент',
  archive_corrupt: 'Архив не читается',
  too_large: 'Экспорт превышает пределы разбора',
  pdf_unreadable: 'Оригинал не открывается — число страниц не подтверждено',
  export_group_mismatch: 'Распознавание в архиве относится к другому документу',
  export_group_ambiguous: 'В архиве несколько подходящих комплектов — выбор неоднозначен',
  not_found: 'Прогон не найден',
  internal: 'Внутренняя ошибка',
};

export const recognitionFailureLabel = (code: string | null): string =>
  code ? (RECOGNITION_FAILURE_LABELS[code] ?? `Отказ: ${code}`) : '';

// I06: происхождение текста — отдельный признак, а не оформление.
export const FRAGMENT_ORIGIN: Record<TFragmentOrigin, IBadgeMeta> = {
  document_text: { label: 'Текст документа', icon: 'scroll-text', tone: 'neutral' },
  recognized_text: { label: 'Распознанный текст RDWeb', icon: 'scan-search', tone: 'info' },
  model_description: { label: 'Описание модели', icon: 'layers', tone: 'accent', dashed: true },
  negotiation_speech: { label: 'Реплика переговоров', icon: 'users', tone: 'neutral' },
  negotiation_hint: { label: 'Подсказка сервиса переговоров', icon: 'info', tone: 'muted', dashed: true },
  email_body: { label: 'Текст письма', icon: 'inbox', tone: 'neutral' },
  attachment_text: { label: 'Текст вложения', icon: 'files', tone: 'neutral' },
};

export const FRAGMENT_KIND_LABELS: Record<TFragmentKind, string> = {
  text_block: 'Текстовый блок',
  image_block: 'Изображение',
  stamp_block: 'Штамп',
  unknown_block: 'Неизвестный тип блока',
  summary: 'Краткое описание',
  description: 'Подробное описание',
  entities: 'Сущности',
  verification: 'Проверка модели',
  unknown_section: 'Неизвестная секция',
};

export const fragmentKindLabel = (code: string): string => lookup(FRAGMENT_KIND_LABELS, code);

export const RECOGNITION_WARNING_LABELS: Record<string, string> = {
  unknown_block_type: 'Неизвестный тип блока — импортирован с пометкой',
  unknown_section_label: 'Неизвестная помеченная секция',
  block_not_in_blocks_json: 'Блок есть в тексте, но не в _blocks.json',
  duplicate_block_id: 'Повторяющийся идентификатор блока',
  duplicate_block_section: 'Повторная секция одного блока',
  duplicate_page_index: 'Повторяющийся номер страницы',
  duplicate_member_role: 'Несколько файлов одной роли — взят один',
  unexpected_member: 'Лишний файл в архиве',
  results_html_missing: 'В архиве нет _results.html',
  page_count_mismatch: 'Число страниц в тексте и в _blocks.json не совпало',
  page_heading_mismatch: 'Заголовок страницы не совпал с её номером',
  stamp_binding_ambiguous: 'Штамп не привязан к блоку — сохранён на уровне страницы',
  coords_missing: 'У блока нет координат',
  coords_out_of_range: 'Координаты вне диапазона — выделение не показано',
  polygon_invalid: 'Многоугольник блока не разобран',
  block_page_unknown: 'Блок ссылается на неизвестную страницу',
  rotation_unexpected: 'Неожиданный угол поворота страницы',
  text_split: 'Длинный текст блока сохранён частями — без потерь',
  blocks_page_count_mismatch: 'Число страниц в _blocks.json не совпало с числом страниц PDF',
  page_index_out_of_range: 'Страница экспорта выходит за пределы PDF',
  page_output_empty: 'У страницы есть заголовок, но нет распознанного содержимого',
};

export const recognitionWarningLabel = (code: string): string => RECOGNITION_WARNING_LABELS[code] ?? code;

const bytesFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

/** «1,5 МБ»; null — пустая строка (отсутствие показывает вызывающий). */
export const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined) {
    return '';
  }
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${bytesFormatter.format(value)} ${units[unit]}`;
};

/** Сокращённый SHA-256 для показа; полный — в title. */
export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 12) : '');

/** Секунды → «15 мин», «1 ч 30 мин», «45 с». */
export const formatSeconds = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds} с`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (hours) {
    parts.push(`${hours} ч`);
  }
  if (minutes) {
    parts.push(`${minutes} мин`);
  }
  if (rest) {
    parts.push(`${rest} с`);
  }
  return parts.join(' ');
};

/** Русское множественное число: plural(3, ['файл', 'файла', 'файлов']) → «файла». */
export const plural = (n: number, forms: [string, string, string]): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return forms[0];
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return forms[1];
  }
  return forms[2];
};
