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
  { name: 'HTTP_PORT', secret: false, required: false, purpose: 'порт, по умолчанию 3000' },
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
  { name: 'TENDERHUB_URL', secret: false, required: false, purpose: 'интеграция TenderHub (этап 06)' },
  { name: 'TENDERHUB_API_KEY', secret: true, required: false, purpose: 'интеграция TenderHub (этап 06)' },
  { name: 'LOCALAI_URL', secret: false, required: false, purpose: 'внутренний адрес LocalAI (этап 05); наружу не публикуется' },
  { name: 'LOCALAI_TOKEN', secret: true, required: false, purpose: 'сервисный доступ к LocalAI (этап 05)' },
  { name: 'MAILHUB_URL', secret: false, required: false, purpose: 'интеграция MailHub (этап 07)' },
  { name: 'MAILHUB_TOKEN', secret: true, required: false, purpose: 'интеграция MailHub (этап 07)' },
  { name: 'YANDEX_DISK_TOKEN', secret: true, required: false, purpose: 'размещение на Яндекс Диске (этап 14)' },
  { name: 'SMB_USERNAME', secret: false, required: false, purpose: 'размещение в сетевой папке (этап 14)' },
  { name: 'SMB_PASSWORD', secret: true, required: false, purpose: 'размещение в сетевой папке (этап 14)' },
];

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
  const httpPort = intFrom(env, 'HTTP_PORT', 3000, problems);
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
  };
  for (const root of config.intakeRoots) {
    if (!isAbsolute(root)) problems.push(`INTAKE_ROOTS: «${root}» должен быть абсолютным путём`);
  }
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
