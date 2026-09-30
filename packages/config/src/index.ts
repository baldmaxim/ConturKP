// Конфигурация процессов портала из переменных окружения (ADR-011 §3).
// Значения секретов никогда не выводятся: отчёт содержит только «задано / не задано».
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const MIB = 1024 * 1024;

export type KonturEnv = 'development' | 'test' | 'production';

export interface ITlsConfig {
  certFile: string;
  keyFile: string;
}

// Лимиты импорта (A38): размер загрузки, распаковки и число элементов архива.
export interface IImportLimits {
  maxUploadBytes: number;
  maxEntryBytes: number;
  maxArchiveTotalBytes: number;
  maxArchiveEntries: number;
  // Отношение распакованного размера к сжатому для одного элемента (защита от zip-бомб).
  maxCompressionRatio: number;
}

// Пределы разбора экспорта распознавания (этап 04): метаданные архива читаются в память
// целиком, поэтому граница задаётся явно, а не надеждой на размер архива.
export interface IRecognitionLimits {
  maxMetadataBytes: number;
  // Суммарная память всех буферизуемых metadata-кандидатов архива: отдельного файла мало,
  // потому что кандидатов может быть много (R04-01).
  maxMetadataTotalBytes: number;
  maxTotalTextChars: number;
  // Оригинал читается в память ради достоверного числа страниц (R04-03).
  maxPdfBytes: number;
  // Предел числа страниц оригинала: из него строятся страницы прогона и объекты разбора (R04-11).
  maxPages: number;
}

// Модель эмбеддингов (ADR-012 §25, D-013): только локальный сервер модели на loopback или в LAN.
// none — модели нет, версия индекса строится без векторов, смысловая ветка честно недоступна.
// fake — детерминированный поддельный провайдер для тестов и разработки; в production запрещён.
export type EmbeddingProviderKind = 'none' | 'openai_compatible' | 'fake';

export interface IEmbeddingConfig {
  provider: EmbeddingProviderKind;
  baseUrl: string | null;
  model: string | null;
  revision: string;
  apiKey: string | null;
  dim: number | null;
  template: 'plain' | 'e5';
  timeoutMs: number;
  batchSize: number;
}

// Поиск портала (ADR-012 §14–15, ADR-004 §7a).
export interface ISearchConfig {
  // Срок смысловой ветки: просроченный прогон становится degraded (semantic_timeout).
  semanticDeadlineMs: number;
  // Единиц источника в одной пачке index.build (шаг фоновой полосы ограничен).
  indexBuildUnitsPerBatch: number;
  // Проход обслуживания worker: просроченные прогоны, задания индексации, активация, удаление.
  maintenanceIntervalMs: number;
  // Проверка доступности модели и пробного вектора (отпечаток).
  modelCheckIntervalMs: number;
}

// TenderHub (этап 06, ADR-007 §5–8): только чтение официального API по X-API-Key. Ключ живёт
// только в окружении процесса worker; без адреса или ключа выгрузка честно недоступна (U-04,
// integration_not_configured), запуск портала из-за необязательной интеграции не останавливается.
export interface ITenderHubConfig {
  baseUrl: string | null;
  apiKey: string | null;
  timeoutMs: number;
  // Собственный предел запросов в минуту — ниже лимита ключа у источника (по умолчанию 120).
  rateLimitPerMinute: number;
  // Окно лимита источника — минута; в тестах короче, из окружения не задаётся.
  rateLimitWindowMs: number;
  maxResponseBytes: number;
  // Попыток одной выгрузки: изменение данных во время чтения, сеть, 429 после ожидания.
  captureAttempts: number;
}

// Локальное распознавание (этап 05a, D-014, D-024). OCR-движок — tesseract.js (WASM внутри worker,
// модели rus и eng из npm, без сети) или none: тогда страницы PDF без текстового слоя не распознаются
// и прогон честно получает ocr_unavailable. Пределы — для «очень большого файла» (A38, тест 18).
export type LocalOcrEngineKind = 'tesseract_js' | 'none';

export interface ILocalRecognitionConfig {
  ocrEngine: LocalOcrEngineKind;
  ocrDpi: number;
  ocrPageTimeoutMs: number;
  maxInputBytes: number;
  maxUnzippedBytes: number;
  maxCells: number;
  maxOcrPages: number;
  // Редакций за один автоматический проход worker (OD-2).
  autoBatch: number;
}

// Почта (этап 07, D-025): предел файла EML и одного вложения. Вложение сверх предела — отказ вложения
// (метаданные и хэш без байтов), письмо сверх предела — детерминированный отказ разбора.
export interface IMailConfig {
  maxEmlBytes: number;
  maxAttachmentBytes: number;
}

export interface IAppConfig {
  env: KonturEnv;
  databaseUrl: string;
  storageRoot: string;
  httpHost: string;
  httpPort: number;
  allowedOrigins: string[];
  tls: ITlsConfig | null;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  workerHeartbeatSeconds: number;
  workerStaleSeconds: number;
  webDistDir: string | null;
  limits: IImportLimits;
  // Наблюдаемые папки допускаются только внутри этих корней (проверка realpath при каждом скане).
  intakeRoots: string[];
  intakeStabilitySeconds: number;
  jobLeaseSeconds: number;
  gpuTakeoverGraceSeconds: number;
  recognition: IRecognitionLimits;
  embedding: IEmbeddingConfig;
  search: ISearchConfig;
  tenderhub: ITenderHubConfig;
  localRecognition: ILocalRecognitionConfig;
  mail: IMailConfig;
}

interface IConfigKey {
  name: string;
  secret: boolean;
  required: boolean;
  purpose: string;
}

// Ключи интеграций перечислены, чтобы проверка конфигурации показывала, задан ли ключ.
// Интеграционные учётные данные живут только в окружении процесса и не связаны
// с пользовательскими сессиями (ADR-006 §14); сами интеграции реализуются на этапах 04–16.
export const CONFIG_KEYS: IConfigKey[] = [
  { name: 'KONTUR_ENV', secret: false, required: true, purpose: 'режим: development / test / production' },
  { name: 'DATABASE_URL', secret: true, required: true, purpose: 'подключение приложения (роль kontur_app)' },
  { name: 'DATABASE_MIGRATOR_URL', secret: true, required: false, purpose: 'подключение для миграций (роль kontur_migrator)' },
  { name: 'DATABASE_ADMIN_URL', secret: true, required: false, purpose: 'суперпользователь только для db:setup' },
  { name: 'STORAGE_ROOT', secret: false, required: true, purpose: 'корень файлового хранилища (ADR-003)' },
  { name: 'HTTP_HOST', secret: false, required: false, purpose: 'адрес прослушивания, по умолчанию 127.0.0.1' },
  { name: 'HTTP_PORT', secret: false, required: false, purpose: 'порт, по умолчанию 3200 (не 3000 — занят Quantor)' },
  { name: 'ALLOWED_ORIGINS', secret: false, required: true, purpose: 'разрешённые Origin через запятую' },
  { name: 'TLS_CERT_FILE', secret: false, required: false, purpose: 'сертификат HTTPS (обязателен вне 127.0.0.1)' },
  { name: 'TLS_KEY_FILE', secret: true, required: false, purpose: 'закрытый ключ HTTPS' },
  { name: 'SESSION_IDLE_MINUTES', secret: false, required: false, purpose: 'истечение неактивной сессии, по умолчанию 720' },
  { name: 'SESSION_ABSOLUTE_HOURS', secret: false, required: false, purpose: 'абсолютный срок сессии, по умолчанию 168' },
  { name: 'WEB_DIST_DIR', secret: false, required: false, purpose: 'каталог собранного интерфейса' },
  { name: 'INTAKE_ROOTS', secret: false, required: false, purpose: 'корни наблюдаемых папок через «;» (без них каналы не сканируются)' },
  { name: 'INTAKE_STABILITY_SECONDS', secret: false, required: false, purpose: 'сколько секунд файл не меняется до импорта, по умолчанию 10' },
  { name: 'IMPORT_MAX_UPLOAD_MB', secret: false, required: false, purpose: 'лимит загрузки, по умолчанию 512' },
  { name: 'IMPORT_MAX_ENTRY_MB', secret: false, required: false, purpose: 'лимит элемента архива после распаковки, по умолчанию 1024' },
  { name: 'IMPORT_MAX_ARCHIVE_MB', secret: false, required: false, purpose: 'лимит суммы распаковки архива, по умолчанию 4096' },
  { name: 'IMPORT_MAX_ARCHIVE_ENTRIES', secret: false, required: false, purpose: 'лимит числа элементов архива, по умолчанию 5000' },
  { name: 'JOB_LEASE_SECONDS', secret: false, required: false, purpose: 'аренда задания, по умолчанию 60' },
  { name: 'RECOGNITION_MAX_METADATA_MB', secret: false, required: false, purpose: 'лимит _blocks.json и _results.md в памяти, по умолчанию 64' },
  { name: 'RECOGNITION_MAX_TEXT_MB', secret: false, required: false, purpose: 'лимит суммарного текста фрагментов одного прогона, по умолчанию 64' },
  { name: 'RECOGNITION_MAX_METADATA_TOTAL_MB', secret: false, required: false, purpose: 'лимит суммы metadata-кандидатов архива в памяти, по умолчанию 128' },
  { name: 'RECOGNITION_MAX_PDF_MB', secret: false, required: false, purpose: 'лимит чтения оригинала для подсчёта страниц, по умолчанию 256' },
  { name: 'RECOGNITION_MAX_PAGES', secret: false, required: false, purpose: 'предел числа страниц оригинала для разбора, по умолчанию 10000' },
  { name: 'LOCAL_OCR_ENGINE', secret: false, required: false, purpose: 'локальный OCR: tesseract_js (по умолчанию, без сети) или none, этап 05a' },
  { name: 'LOCAL_OCR_DPI', secret: false, required: false, purpose: 'разрешение растра страницы PDF для OCR, по умолчанию 300' },
  { name: 'LOCAL_OCR_MAX_PAGES', secret: false, required: false, purpose: 'предел страниц PDF, которым нужен OCR, по умолчанию 300' },
  { name: 'LOCAL_RECOGNITION_MAX_INPUT_MB', secret: false, required: false, purpose: 'предел файла DOCX, XLSX, CSV и PDF для локального распознавания, по умолчанию 64' },
  { name: 'LOCAL_RECOGNITION_MAX_UNZIPPED_MB', secret: false, required: false, purpose: 'предел распакованного объёма DOCX и XLSX, по умолчанию 256' },
  { name: 'LOCAL_RECOGNITION_MAX_CELLS', secret: false, required: false, purpose: 'предел ячеек XLSX и CSV, по умолчанию 1000000' },
  { name: 'MAIL_MAX_EML_MB', secret: false, required: false, purpose: 'предел файла письма EML, МиБ, по умолчанию 50' },
  { name: 'MAIL_MAX_ATTACHMENT_MB', secret: false, required: false, purpose: 'предел одного вложения письма, МиБ, по умолчанию 25' },
  { name: 'TENDERHUB_URL', secret: false, required: false, purpose: 'адрес TenderHub (https; http только loopback), этап 06' },
  { name: 'TENDERHUB_API_KEY', secret: true, required: false, purpose: 'ключ TenderHub thk_… с областью tenders:read (заголовок X-API-Key), этап 06' },
  { name: 'TENDERHUB_TIMEOUT_SECONDS', secret: false, required: false, purpose: 'таймаут запроса к TenderHub, по умолчанию 300 (таймаут сервера TenderHub — 5 мин)' },
  { name: 'TENDERHUB_RATE_LIMIT_PER_MINUTE', secret: false, required: false, purpose: 'собственный лимит запросов в минуту, по умолчанию 100 (у ключа TenderHub — 120)' },
  { name: 'TENDERHUB_MAX_RESPONSE_MB', secret: false, required: false, purpose: 'предел распакованного ответа TenderHub, по умолчанию 512' },
  { name: 'TENDERHUB_CAPTURE_ATTEMPTS', secret: false, required: false, purpose: 'попыток одной выгрузки расчёта, по умолчанию 3' },
  { name: 'EMBEDDING_PROVIDER', secret: false, required: false, purpose: 'модель эмбеддингов: none (по умолчанию), openai_compatible, fake (не в production)' },
  { name: 'EMBEDDING_BASE_URL', secret: false, required: false, purpose: 'адрес локального сервера модели (/v1), только loopback или LAN (D-013)' },
  { name: 'EMBEDDING_MODEL', secret: false, required: false, purpose: 'имя модели эмбеддингов на сервере модели' },
  { name: 'EMBEDDING_MODEL_REVISION', secret: false, required: false, purpose: 'ревизия весов модели: входит в отпечаток версии индекса' },
  { name: 'EMBEDDING_API_KEY', secret: true, required: false, purpose: 'ключ сервера модели, если он его требует' },
  { name: 'EMBEDDING_DIM', secret: false, required: false, purpose: 'ожидаемая размерность векторов (не больше 4000)' },
  { name: 'EMBEDDING_INPUT_TEMPLATE', secret: false, required: false, purpose: 'шаблон входа модели: plain (по умолчанию) или e5 (query:/passage:)' },
  { name: 'EMBEDDING_TIMEOUT_SECONDS', secret: false, required: false, purpose: 'таймаут запроса к модели, по умолчанию 30' },
  { name: 'EMBEDDING_BATCH_SIZE', secret: false, required: false, purpose: 'текстов в одном запросе к модели, по умолчанию 32' },
  { name: 'SEARCH_SEMANTIC_DEADLINE_SECONDS', secret: false, required: false, purpose: 'срок смысловой ветки поиска, по умолчанию 60' },
  { name: 'MAILHUB_URL', secret: false, required: false, purpose: 'интеграция MailHub (этап 07)' },
  { name: 'MAILHUB_TOKEN', secret: true, required: false, purpose: 'интеграция MailHub (этап 07)' },
  { name: 'YANDEX_DISK_TOKEN', secret: true, required: false, purpose: 'размещение на Яндекс Диске (этап 14)' },
  { name: 'SMB_USERNAME', secret: false, required: false, purpose: 'размещение в сетевой папке (этап 14)' },
  { name: 'SMB_PASSWORD', secret: true, required: false, purpose: 'размещение в сетевой папке (этап 14)' },
];

const localRecognitionFrom = (env: Env, problems: string[]): ILocalRecognitionConfig => {
  const engine = env.LOCAL_OCR_ENGINE ?? 'tesseract_js';
  if (engine !== 'tesseract_js' && engine !== 'none') problems.push(`LOCAL_OCR_ENGINE: «${engine}» — допустимо tesseract_js или none`);
  const dpi = intFrom(env, 'LOCAL_OCR_DPI', 300, problems);
  if (dpi < 100 || dpi > 600) problems.push('LOCAL_OCR_DPI: от 100 до 600');
  return {
    ocrEngine: engine === 'none' ? 'none' : 'tesseract_js',
    ocrDpi: dpi,
    ocrPageTimeoutMs: 180_000,
    maxInputBytes: intFrom(env, 'LOCAL_RECOGNITION_MAX_INPUT_MB', 64, problems) * MIB,
    maxUnzippedBytes: intFrom(env, 'LOCAL_RECOGNITION_MAX_UNZIPPED_MB', 256, problems) * MIB,
    maxCells: intFrom(env, 'LOCAL_RECOGNITION_MAX_CELLS', 1_000_000, problems),
    maxOcrPages: intFrom(env, 'LOCAL_OCR_MAX_PAGES', 300, problems),
    autoBatch: 20,
  };
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Конфигурация некорректна: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost';

const intFrom = (env: Env, name: string, fallback: number, problems: string[]): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${name} должно быть положительным целым`);
    return fallback;
  }
  return n;
};

const PROVIDERS: readonly EmbeddingProviderKind[] = ['none', 'openai_compatible', 'fake'];

// Адрес TenderHub: https, либо http только на loopback (локальный Go BFF). Та же проверка — в адаптере.
const tenderHubUrlProblem = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'некорректный адрес';
  }
  if (url.username || url.password) return 'учётные данные в адресе недопустимы';
  if (url.search || url.hash) return 'адрес без параметров запроса и якоря';
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && (host === 'localhost' || host === '::1' || /^127\./u.test(host))) return null;
  return 'только https (http допустим лишь для loopback)';
};

const tenderhubFrom = (env: Env, problems: string[]): ITenderHubConfig => {
  const baseUrl = env.TENDERHUB_URL || null;
  const apiKey = env.TENDERHUB_API_KEY || null;
  if (baseUrl) {
    const problem = tenderHubUrlProblem(baseUrl);
    if (problem) problems.push(`TENDERHUB_URL: ${problem}`);
  }
  return {
    baseUrl,
    apiKey,
    timeoutMs: intFrom(env, 'TENDERHUB_TIMEOUT_SECONDS', 300, problems) * 1000,
    rateLimitPerMinute: intFrom(env, 'TENDERHUB_RATE_LIMIT_PER_MINUTE', 100, problems),
    rateLimitWindowMs: 60_000,
    maxResponseBytes: intFrom(env, 'TENDERHUB_MAX_RESPONSE_MB', 512, problems) * MIB,
    captureAttempts: intFrom(env, 'TENDERHUB_CAPTURE_ATTEMPTS', 3, problems),
  };
};

// Только настройки TenderHub — для live-smoke (U-04) без полной конфигурации процесса.
export const loadTenderHubConfig = (env: Env = process.env): { tenderhub: ITenderHubConfig; problems: string[] } => {
  const problems: string[] = [];
  return { tenderhub: tenderhubFrom(env, problems), problems };
};

// Та же проверка, что у провайдера (packages/adapters): loopback, частные сети, локальные зоны.
const isLocalUrl = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if ([/^10\./u, /^127\./u, /^192\.168\./u, /^172\.(1[6-9]|2\d|3[01])\./u, /^169\.254\./u].some((re) => re.test(host))) return true;
  if (/^f[cd][0-9a-f]{2}:/u.test(host) || host.startsWith('fe80:')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host) || host.includes(':')) return false;
  return !host.includes('.') || /\.(lan|local|internal|home\.arpa)$/u.test(host);
};

const embeddingFrom = (env: Env, problems: string[]): IEmbeddingConfig => {
  const raw = env.EMBEDDING_PROVIDER || 'none';
  const provider = (PROVIDERS as readonly string[]).includes(raw) ? (raw as EmbeddingProviderKind) : 'none';
  if (provider !== raw) problems.push('EMBEDDING_PROVIDER должно быть none, openai_compatible или fake');
  const template = env.EMBEDDING_INPUT_TEMPLATE || 'plain';
  if (template !== 'plain' && template !== 'e5') problems.push('EMBEDDING_INPUT_TEMPLATE должно быть plain или e5');
  return {
    provider,
    baseUrl: env.EMBEDDING_BASE_URL || null,
    model: env.EMBEDDING_MODEL || null,
    revision: env.EMBEDDING_MODEL_REVISION || 'unspecified',
    apiKey: env.EMBEDDING_API_KEY || null,
    dim: env.EMBEDDING_DIM ? intFrom(env, 'EMBEDDING_DIM', 0, problems) : null,
    template: template === 'e5' ? 'e5' : 'plain',
    timeoutMs: intFrom(env, 'EMBEDDING_TIMEOUT_SECONDS', 30, problems) * 1000,
    batchSize: intFrom(env, 'EMBEDDING_BATCH_SIZE', 32, problems),
  };
};

export const loadConfig = (env: Env = process.env): IAppConfig => {
  const problems: string[] = [];
  const kontEnv = env.KONTUR_ENV;
  if (kontEnv !== 'development' && kontEnv !== 'test' && kontEnv !== 'production') {
    problems.push('KONTUR_ENV должно быть development, test или production');
  }
  for (const key of CONFIG_KEYS) {
    if (key.required && !env[key.name]) problems.push(`${key.name} не задано`);
  }
  const httpHost = env.HTTP_HOST || '127.0.0.1';
  const httpPort = intFrom(env, 'HTTP_PORT', 3200, problems);
  const certFile = env.TLS_CERT_FILE;
  const keyFile = env.TLS_KEY_FILE;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    problems.push('TLS_CERT_FILE и TLS_KEY_FILE задаются только вместе');
  }
  const tls = certFile && keyFile ? { certFile, keyFile } : null;
  // Без TLS портал слушает только loopback (ADR-006 §13): доступ из LAN только по HTTPS.
  if (!tls && !isLoopback(httpHost)) {
    problems.push('без TLS допускается только HTTP_HOST=127.0.0.1; для LAN задайте TLS_CERT_FILE и TLS_KEY_FILE');
  }
  if (kontEnv === 'production' && !tls) {
    problems.push('в production обязателен TLS');
  }
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    let url: URL | null = null;
    try {
      url = new URL(origin);
    } catch {
      problems.push(`ALLOWED_ORIGINS: некорректный origin «${origin}»`);
      continue;
    }
    if (url.origin !== origin) problems.push(`ALLOWED_ORIGINS: «${origin}» должен быть origin без пути`);
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
      problems.push(`ALLOWED_ORIGINS: «${origin}» — http допустим только для loopback`);
    }
  }
  const config: IAppConfig = {
    env: (kontEnv ?? 'development') as KonturEnv,
    databaseUrl: env.DATABASE_URL ?? '',
    storageRoot: env.STORAGE_ROOT ?? '',
    httpHost,
    httpPort,
    allowedOrigins,
    tls,
    sessionIdleMinutes: intFrom(env, 'SESSION_IDLE_MINUTES', 720, problems),
    sessionAbsoluteHours: intFrom(env, 'SESSION_ABSOLUTE_HOURS', 168, problems),
    workerHeartbeatSeconds: 10,
    workerStaleSeconds: 60,
    webDistDir: env.WEB_DIST_DIR || null,
    limits: {
      maxUploadBytes: intFrom(env, 'IMPORT_MAX_UPLOAD_MB', 512, problems) * MIB,
      maxEntryBytes: intFrom(env, 'IMPORT_MAX_ENTRY_MB', 1024, problems) * MIB,
      maxArchiveTotalBytes: intFrom(env, 'IMPORT_MAX_ARCHIVE_MB', 4096, problems) * MIB,
      maxArchiveEntries: intFrom(env, 'IMPORT_MAX_ARCHIVE_ENTRIES', 5000, problems),
      maxCompressionRatio: 200,
    },
    intakeRoots: (env.INTAKE_ROOTS ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean),
    intakeStabilitySeconds: intFrom(env, 'INTAKE_STABILITY_SECONDS', 10, problems),
    jobLeaseSeconds: intFrom(env, 'JOB_LEASE_SECONDS', 60, problems),
    gpuTakeoverGraceSeconds: 120,
    recognition: {
      maxMetadataBytes: intFrom(env, 'RECOGNITION_MAX_METADATA_MB', 64, problems) * MIB,
      maxMetadataTotalBytes: intFrom(env, 'RECOGNITION_MAX_METADATA_TOTAL_MB', 128, problems) * MIB,
      maxTotalTextChars: intFrom(env, 'RECOGNITION_MAX_TEXT_MB', 64, problems) * MIB,
      maxPdfBytes: intFrom(env, 'RECOGNITION_MAX_PDF_MB', 256, problems) * MIB,
      maxPages: intFrom(env, 'RECOGNITION_MAX_PAGES', 10_000, problems),
    },
    embedding: embeddingFrom(env, problems),
    search: {
      semanticDeadlineMs: intFrom(env, 'SEARCH_SEMANTIC_DEADLINE_SECONDS', 60, problems) * 1000,
      indexBuildUnitsPerBatch: 5,
      maintenanceIntervalMs: 5000,
      modelCheckIntervalMs: 60_000,
    },
    tenderhub: tenderhubFrom(env, problems),
    localRecognition: localRecognitionFrom(env, problems),
    mail: {
      maxEmlBytes: intFrom(env, 'MAIL_MAX_EML_MB', 50, problems) * MIB,
      maxAttachmentBytes: intFrom(env, 'MAIL_MAX_ATTACHMENT_MB', 25, problems) * MIB,
    },
  };
  for (const root of config.intakeRoots) {
    if (!isAbsolute(root)) problems.push(`INTAKE_ROOTS: «${root}» должен быть абсолютным путём`);
  }
  const e = config.embedding;
  if (e.provider === 'openai_compatible') {
    if (!e.baseUrl) problems.push('EMBEDDING_BASE_URL обязателен для EMBEDDING_PROVIDER=openai_compatible');
    else if (!isLocalUrl(e.baseUrl)) problems.push('EMBEDDING_BASE_URL: только loopback или LAN, облачного пути нет (D-013)');
    if (!e.model) problems.push('EMBEDDING_MODEL обязателен для EMBEDDING_PROVIDER=openai_compatible');
  }
  if (e.provider === 'fake' && config.env === 'production') problems.push('EMBEDDING_PROVIDER=fake в production запрещён: поддельная модель не рабочая');
  if (e.dim !== null && e.dim > 4000) problems.push('EMBEDDING_DIM не больше 4000 (ADR-012 §6)');
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
};

export interface IConfigReportLine {
  name: string;
  state: 'задано' | 'не задано';
  secret: boolean;
  required: boolean;
  purpose: string;
}

// Отчёт для config:check: только признак наличия, без значений (ADR-011 §3, I17).
export const configReport = (env: Env = process.env): IConfigReportLine[] =>
  CONFIG_KEYS.map((key) => ({
    name: key.name,
    state: env[key.name] ? 'задано' : 'не задано',
    secret: key.secret,
    required: key.required,
    purpose: key.purpose,
  }));

export const readTls = (tls: ITlsConfig): { cert: Buffer; key: Buffer } => ({
  cert: readFileSync(tls.certFile),
  key: readFileSync(tls.keyFile),
});
