// Конфигурация процессов портала из переменных окружения (ADR-011 §3).
// Значения секретов никогда не выводятся: отчёт содержит только «задано / не задано».
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export * from './lifecycle.ts';
export * from './build.ts';

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
  // Проверка доступности модели и пробного вектора (отпечаток). Проба — настоящий запрос к модели:
  // у LM Studio он загружает модель и продлевает её срок в памяти, поэтому редко (этап 17, S17-07).
  modelCheckIntervalMs: number;
  // Повтор пробы, пока модель недоступна: такой запрос модель не загружает.
  modelRetryIntervalMs: number;
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
  // Стабильный идентификатор экземпляра TenderHub (D-030): без него пары source_lineage остаются предложениями.
  instanceId: string | null;
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

// Генеративная модель для извлечения кандидатов (этап 08, OD-08-2, ADR-009 §5): по умолчанию — локальный
// OpenAI-совместимый сервер (LM Studio, llama.cpp server) на целевом ПК; облачного запасного пути нет.
// none — модели нет, прогон анализа честно отказывает; fake — детерминированный поддельный провайдер
// для тестов и разработки, в production запрещён.
export type ChatModelProviderKind = 'none' | 'openai_compatible' | 'fake';

export interface IChatModelConfig {
  provider: ChatModelProviderKind;
  baseUrl: string | null;
  model: string | null;
  revision: string;
  apiKey: string | null;
  timeoutMs: number;
  // Символов текста фрагментов в одном запросе: пачка ограничена, чтобы не держать слот gpu (ADR-004 §7a).
  maxInputChars: number;
  maxOutputTokens: number;
  // json_object — просить у сервера режим JSON; none — только инструкция промпта (не все серверы его знают).
  jsonMode: 'none' | 'json_object';
}

// Ответное ядро (этап 08a, D-027 AD-08a-6): проверяющий — необязательный (off — уровень «правила»; same_model —
// отдельный прогон того же шлюза), исправление черновика — не больше двух (по умолчанию одно), пакет — не больше
// ANSWER_PACKET_LIMIT оснований.
// Конвертер в PDF для превью файлов выпуска (этап 12; D-032 В-12-2; ADR-013): LibreOffice без интерфейса.
// sofficePath null — поиск soffice в PATH и в стандартном каталоге установки Windows.
export interface IOfficeConfig {
  sofficePath: string | null;
  convertTimeoutMs: number;
}

export interface IAnswerConfig {
  verifierMode: 'off' | 'same_model';
  maxRepairs: number;
  packetLimit: number;
}

// Почта (этап 07, D-025): предел файла EML и одного вложения. Вложение сверх предела — отказ вложения
// (метаданные и хэш без байтов), письмо сверх предела — детерминированный отказ разбора.
export interface IMailConfig {
  maxEmlBytes: number;
  maxAttachmentBytes: number;
}

// Размещение (этап 14; D-034): оба назначения — файловые (папка синхронизации Яндекс Диска, сетевая папка), секретов нет.
// Срок ожидания одной файловой операции; истечение у записи и переноса — неизвестный исход (A29).
export interface IDeliveryConfig {
  operationTimeoutMs: number;
}

// Этап 16 (ADR-010; проект §2, §7): MCP-сервер портала. Выключен по умолчанию; лимит вызовов инструментов — на токен.
export interface IMcpConfig {
  enabled: boolean;
  callsPerMinute: number;
  callsPerHour: number;
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
  // Срок штатной остановки процесса (этап 17, проект §3.4); stoptimeout службы — не меньше срока + 10 с.
  shutdownGraceSeconds: number;
  // restore_check — worker на восстановленной копии (проект §4.4): без внешних действий — размещений, сканов
  // наблюдаемых папок и выгрузок TenderHub; пути назначений в копии указывают на настоящие папки.
  workerMode: 'normal' | 'restore_check';
  recognition: IRecognitionLimits;
  embedding: IEmbeddingConfig;
  search: ISearchConfig;
  tenderhub: ITenderHubConfig;
  localRecognition: ILocalRecognitionConfig;
  mail: IMailConfig;
  chatModel: IChatModelConfig;
  answer: IAnswerConfig;
  office: IOfficeConfig;
  delivery: IDeliveryConfig;
  mcp: IMcpConfig;
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
  { name: 'MODEL_PROVIDER', secret: false, required: false, purpose: 'генеративная модель этапа 08: none (по умолчанию), openai_compatible или fake' },
  { name: 'MODEL_BASE_URL', secret: false, required: false, purpose: 'адрес OpenAI-совместимого сервера модели (только loopback или LAN, D-013)' },
  { name: 'MODEL_NAME', secret: false, required: false, purpose: 'имя модели на сервере' },
  { name: 'MODEL_REVISION', secret: false, required: false, purpose: 'версия или квантование модели — входит в ключ повтора прогона' },
  { name: 'MODEL_API_KEY', secret: true, required: false, purpose: 'ключ сервера модели, если он требуется' },
  { name: 'MODEL_TIMEOUT_SECONDS', secret: false, required: false, purpose: 'ожидание ответа модели, по умолчанию 120' },
  { name: 'MODEL_MAX_INPUT_CHARS', secret: false, required: false, purpose: 'символов фрагментов в одном запросе, по умолчанию 12000' },
  { name: 'MODEL_MAX_OUTPUT_TOKENS', secret: false, required: false, purpose: 'предел ответа модели, по умолчанию 2048' },
  { name: 'MODEL_JSON_MODE', secret: false, required: false, purpose: 'none (по умолчанию) или json_object — режим JSON сервера' },
  { name: 'ANSWER_VERIFIER', secret: false, required: false, purpose: 'проверяющий ответа этапа 08a: off (по умолчанию, уровень «правила») или same_model' },
  { name: 'ANSWER_MAX_REPAIRS', secret: false, required: false, purpose: 'исправлений черновика ответа, 0–1 (AD-08a-6), по умолчанию 1' },
  { name: 'ANSWER_PACKET_LIMIT', secret: false, required: false, purpose: 'оснований в пакете ответа, 1–30, по умолчанию 12' },
  { name: 'SEARCH_SEMANTIC_DEADLINE_SECONDS', secret: false, required: false, purpose: 'срок смысловой ветки поиска, по умолчанию 60' },
  { name: 'SOFFICE_PATH', secret: false, required: false, purpose: 'путь к soffice LibreOffice для PDF-превью комплекта (этап 12; на Windows — soffice.com); без него — поиск в PATH и в каталоге установки Windows' },
  { name: 'OFFICE_CONVERT_TIMEOUT_SECONDS', secret: false, required: false, purpose: 'предел конвертации одного файла в PDF, по умолчанию 120' },
  { name: 'MAILHUB_URL', secret: false, required: false, purpose: 'интеграция MailHub (этап 07)' },
  { name: 'MAILHUB_TOKEN', secret: true, required: false, purpose: 'интеграция MailHub (этап 07)' },
  // Этап 14 (D-034): Яндекс Диск — локальная синхронизируемая папка, сетевая папка — права учётной записи службы worker;
  // токена и пароля нет (YANDEX_DISK_TOKEN, SMB_USERNAME, SMB_PASSWORD убраны). Пути назначений — в БД, задаёт администратор.
  // Этап 17: сборка, копии и проверка восстановления (команды ops:backup и ops:restore-check, не процессы портала).
  { name: 'KONTUR_BUILD', secret: false, required: false, purpose: 'коммит установленной сборки (на установке из ZIP — из комментария архива); в рабочей копии Git — из .git' },
  { name: 'BACKUP_DATABASE_URL', secret: true, required: false, purpose: 'подключение роли kontur_backup для ops:backup' },
  { name: 'BACKUP_ROOT', secret: false, required: false, purpose: 'каталог копий на другом диске или сетевом ресурсе (не внутри STORAGE_ROOT)' },
  { name: 'PG_BIN_DIR', secret: false, required: false, purpose: 'каталог bin PostgreSQL с pg_dump и pg_restore (иначе — PATH)' },
  { name: 'PG_DOCKER_CONTAINER', secret: false, required: false, purpose: 'контейнер с PostgreSQL, если кластер в Docker: pg_dump и pg_restore через docker exec' },
  { name: 'RESTORE_ADMIN_URL', secret: true, required: false, purpose: 'суперпользователь кластера проверки восстановления (никогда не рабочая база)' },
  { name: 'RESTORE_STORAGE_ROOT', secret: false, required: false, purpose: 'пустой каталог хранилища для проверки восстановления' },
  // Этап 17: остановка служб и очередь.
  { name: 'SHUTDOWN_GRACE_SECONDS', secret: false, required: false, purpose: 'срок штатной остановки server и worker, по умолчанию 20; stoptimeout службы — на 10 с больше' },
  { name: 'GPU_TAKEOVER_GRACE_SECONDS', secret: false, required: false, purpose: 'защитный интервал перехвата слота GPU после аренды, по умолчанию 180; не меньше таймаута модели + 30' },
  { name: 'WORKER_MODE', secret: false, required: false, purpose: 'normal (по умолчанию) или restore_check — worker на восстановленной копии без внешних действий' },
  { name: 'EMBEDDING_PROBE_INTERVAL_SECONDS', secret: false, required: false, purpose: 'период пробы модели эмбеддингов, пока она отвечает, по умолчанию 3600 (проба загружает модель в LM Studio)' },
  { name: 'DELIVERY_OPERATION_TIMEOUT_SECONDS', secret: false, required: false, purpose: 'срок одной файловой операции размещения, по умолчанию 60' },
  // Этап 16 (ADR-010): точка /mcp для чат-клиентов. Токены выпускают пользователи в портале; в настройках их нет.
  { name: 'MCP_ENABLED', secret: false, required: false, purpose: 'включить MCP-сервер портала (true / false), по умолчанию false' },
  { name: 'MCP_CALLS_PER_MINUTE', secret: false, required: false, purpose: 'лимит вызовов инструментов MCP на токен в минуту, по умолчанию 60' },
  { name: 'MCP_CALLS_PER_HOUR', secret: false, required: false, purpose: 'лимит вызовов инструментов MCP на токен в час, по умолчанию 600' },
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

// Идентификатор экземпляра задаётся явно и не меняется: адрес подключения идентичностью экземпляра не считается (D-030).
const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const instanceIdFrom = (env: Env, problems: string[]): string | null => {
  const raw = env.TENDERHUB_INSTANCE_ID?.trim();
  if (!raw) return null;
  if (!INSTANCE_ID_RE.test(raw)) {
    problems.push('TENDERHUB_INSTANCE_ID: латиница, цифры, «.», «_», «-», до 64 символов');
    return null;
  }
  return raw;
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
    instanceId: instanceIdFrom(env, problems),
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

const CHAT_PROVIDERS: readonly ChatModelProviderKind[] = ['none', 'openai_compatible', 'fake'];

const answerFrom = (env: Env, problems: string[]): IAnswerConfig => {
  const raw = env.ANSWER_VERIFIER || 'off';
  if (raw !== 'off' && raw !== 'same_model') problems.push('ANSWER_VERIFIER должно быть off или same_model');
  // 0 — допустимое значение (без исправления), поэтому не через intFrom (он требует положительное).
  const repairsRaw = env.ANSWER_MAX_REPAIRS;
  const maxRepairs = repairsRaw === undefined || repairsRaw === '' ? 1 : repairsRaw === '0' || repairsRaw === '1' ? Number(repairsRaw) : -1;
  if (maxRepairs < 0) problems.push('ANSWER_MAX_REPAIRS — 0 или 1 (AD-08a-6)');
  const packetLimit = intFrom(env, 'ANSWER_PACKET_LIMIT', 12, problems);
  if (packetLimit < 1 || packetLimit > 30) problems.push('ANSWER_PACKET_LIMIT — от 1 до 30');
  return { verifierMode: raw === 'same_model' ? 'same_model' : 'off', maxRepairs: Math.min(1, Math.max(0, maxRepairs)), packetLimit: Math.min(30, Math.max(1, packetLimit)) };
};

const chatModelFrom = (env: Env, problems: string[]): IChatModelConfig => {
  const raw = env.MODEL_PROVIDER || 'none';
  const provider = (CHAT_PROVIDERS as readonly string[]).includes(raw) ? (raw as ChatModelProviderKind) : 'none';
  if (provider !== raw) problems.push('MODEL_PROVIDER должно быть none, openai_compatible или fake');
  const jsonMode = env.MODEL_JSON_MODE || 'none';
  if (jsonMode !== 'none' && jsonMode !== 'json_object') problems.push('MODEL_JSON_MODE должно быть none или json_object');
  return {
    provider,
    baseUrl: env.MODEL_BASE_URL || null,
    model: env.MODEL_NAME || null,
    revision: env.MODEL_REVISION || 'unspecified',
    apiKey: env.MODEL_API_KEY || null,
    timeoutMs: intFrom(env, 'MODEL_TIMEOUT_SECONDS', 120, problems) * 1000,
    maxInputChars: intFrom(env, 'MODEL_MAX_INPUT_CHARS', 12000, problems),
    maxOutputTokens: intFrom(env, 'MODEL_MAX_OUTPUT_TOKENS', 2048, problems),
    jsonMode: jsonMode === 'json_object' ? 'json_object' : 'none',
  };
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
    gpuTakeoverGraceSeconds: intFrom(env, 'GPU_TAKEOVER_GRACE_SECONDS', 180, problems),
    shutdownGraceSeconds: intFrom(env, 'SHUTDOWN_GRACE_SECONDS', 20, problems),
    workerMode: env.WORKER_MODE === 'restore_check' ? 'restore_check' : 'normal',
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
      modelCheckIntervalMs: intFrom(env, 'EMBEDDING_PROBE_INTERVAL_SECONDS', 3600, problems) * 1000,
      modelRetryIntervalMs: 60_000,
    },
    tenderhub: tenderhubFrom(env, problems),
    localRecognition: localRecognitionFrom(env, problems),
    mail: {
      maxEmlBytes: intFrom(env, 'MAIL_MAX_EML_MB', 50, problems) * MIB,
      maxAttachmentBytes: intFrom(env, 'MAIL_MAX_ATTACHMENT_MB', 25, problems) * MIB,
    },
    chatModel: chatModelFrom(env, problems),
    answer: answerFrom(env, problems),
    office: { sofficePath: env.SOFFICE_PATH?.trim() || null, convertTimeoutMs: intFrom(env, 'OFFICE_CONVERT_TIMEOUT_SECONDS', 120, problems) * 1000 },
    delivery: { operationTimeoutMs: intFrom(env, 'DELIVERY_OPERATION_TIMEOUT_SECONDS', 60, problems) * 1000 },
    mcp: {
      enabled: (env.MCP_ENABLED ?? 'false').trim().toLowerCase() === 'true',
      callsPerMinute: intFrom(env, 'MCP_CALLS_PER_MINUTE', 60, problems),
      callsPerHour: intFrom(env, 'MCP_CALLS_PER_HOUR', 600, problems),
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
  const m = config.chatModel;
  if (m.provider === 'openai_compatible') {
    if (!m.baseUrl) problems.push('MODEL_BASE_URL обязателен для MODEL_PROVIDER=openai_compatible');
    else if (!isLocalUrl(m.baseUrl)) problems.push('MODEL_BASE_URL: только loopback или LAN, облачного пути нет (D-013)');
    if (!m.model) problems.push('MODEL_NAME обязателен для MODEL_PROVIDER=openai_compatible');
  }
  if (m.provider === 'fake' && config.env === 'production') problems.push('MODEL_PROVIDER=fake в production запрещён: поддельная модель не рабочая');
  if (m.maxInputChars < 500) problems.push('MODEL_MAX_INPUT_CHARS не меньше 500');
  // ADR-004 §7: перехват слота GPU — только когда шаг прежнего держателя заведомо закончился (S17-08).
  const longestModelStepSeconds = Math.ceil(Math.max(m.timeoutMs, e.timeoutMs) / 1000);
  if (config.gpuTakeoverGraceSeconds < longestModelStepSeconds + 30) {
    problems.push(`GPU_TAKEOVER_GRACE_SECONDS не меньше ${longestModelStepSeconds + 30}: наибольший таймаут модели (${longestModelStepSeconds} с) плюс 30 с`);
  }
  if (config.shutdownGraceSeconds < 5) problems.push('SHUTDOWN_GRACE_SECONDS не меньше 5');
  if (env.WORKER_MODE && env.WORKER_MODE !== 'normal' && env.WORKER_MODE !== 'restore_check') problems.push('WORKER_MODE — normal или restore_check');
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
