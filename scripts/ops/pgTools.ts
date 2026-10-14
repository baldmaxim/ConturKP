// pg_dump и pg_restore для копии и проверки восстановления (этап 17, проект §4.3). Поиск: явно заданные PG_BIN_DIR,
// затем PG_DOCKER_CONTAINER (docker exec — кластер в контейнере, как у ревьюера), затем PATH. Старший номер версии
// клиента — не ниже сервера. Пароль — только в окружении дочернего процесса (PGPASSWORD), не в аргументах и не в
// журнале; shell: false, windowsHide: true. У docker exec нет -t: псевдотерминал испортил бы двоичный поток дампа.
// В режиме docker инструмент подключается к серверу внутри своего контейнера, а не к адресу из URL: какой это
// кластер, сверяет clusterIdentityProblem через psql того же маршрута (R17-03).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { posix, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export interface IPgTool {
  mode: 'native' | 'docker';
  // argv до имени программы: [] для native, ['docker', 'exec', '-i', …, контейнер] для docker.
  prefix: string[];
  dump: string;
  restore: string;
  // psql того же маршрута — сверка кластера и базы, к которым подключатся pg_dump и pg_restore; null — не найден.
  psql: string | null;
  version: string;
  major: number;
  container: string | null;
}

export interface IToolEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  run: (file: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;
}

const majorOf = (version: string): number => Number(/(\d+)(?:\.\d+)?/u.exec(version.replace(/^[^\d]*/u, ''))?.[1] ?? 0);

// Подключение из URL: переменные libpq для дочернего процесса. В режиме docker адрес и порт — внутри контейнера.
export const pgEnvOf = (url: string, tool: Pick<IPgTool, 'mode'>, env: Record<string, string | undefined> = {}): Record<string, string> => {
  const u = new URL(url);
  const out: Record<string, string> = {
    PGUSER: decodeURIComponent(u.username),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//u, '')),
    PGHOST: tool.mode === 'docker' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/gu, ''),
    PGPORT: tool.mode === 'docker' ? (env.PG_DOCKER_PORT ?? '5432') : u.port || '5432',
    PGAPPNAME: 'kontur-kp-ops',
  };
  if (u.password) out.PGPASSWORD = decodeURIComponent(u.password);
  return out;
};

// Имена libpq передаются в контейнер без значений: docker берёт их из своего окружения (-e ИМЯ).
const DOCKER_ENV = ['PGUSER', 'PGDATABASE', 'PGHOST', 'PGPORT', 'PGPASSWORD', 'PGAPPNAME'];

export const findPgTools = async (t: IToolEnv): Promise<IPgTool | { error: string }> => {
  const p = t.platform === 'win32' ? win32 : posix;
  const exe = (name: string): string => (t.platform === 'win32' ? `${name}.exe` : name);
  const ok = async (file: string, args: string[]): Promise<{ code: number | null; stdout: string }> => t.run(file, args).catch(() => ({ code: null, stdout: '' }));
  const native = async (dir: string | null): Promise<IPgTool | null> => {
    const at = (name: string): string => (dir ? p.join(dir, exe(name)) : exe(name));
    const v = await ok(at('pg_dump'), ['--version']);
    const r = await ok(at('pg_restore'), ['--version']);
    if (v.code !== 0 || r.code !== 0) return null;
    const q = await ok(at('psql'), ['--version']);
    const version = v.stdout.trim().split(/\r?\n/u)[0] ?? '';
    return { mode: 'native', prefix: [], dump: at('pg_dump'), restore: at('pg_restore'), psql: q.code === 0 ? at('psql') : null, version, major: majorOf(version), container: null };
  };
  // Явная настройка важнее PATH: администратор, задавший контейнер, имеет в виду его (R17-03).
  if (t.env.PG_BIN_DIR) {
    const found = await native(t.env.PG_BIN_DIR);
    if (found) return found;
  }
  const container = t.env.PG_DOCKER_CONTAINER;
  if (container) {
    const v = await ok('docker', ['exec', container, 'pg_dump', '--version']);
    if (v.code === 0) {
      const q = await ok('docker', ['exec', container, 'psql', '--version']);
      const version = v.stdout.trim().split(/\r?\n/u)[0] ?? '';
      const prefix = ['docker', 'exec', '-i', ...DOCKER_ENV.flatMap((n) => ['-e', n]), container];
      return { mode: 'docker', prefix, dump: 'pg_dump', restore: 'pg_restore', psql: q.code === 0 ? 'psql' : null, version, major: majorOf(version), container };
    }
  }
  const fromPath = await native(null);
  if (fromPath) return fromPath;
  return { error: 'не найдены pg_dump и pg_restore: задайте PG_BIN_DIR (каталог bin PostgreSQL) или PG_DOCKER_CONTAINER (контейнер с PostgreSQL)' };
};

export const versionProblem = (tool: IPgTool, serverVersionNum: number): string | null => {
  const serverMajor = Math.floor(serverVersionNum / 10000);
  return tool.major >= serverMajor ? null : `версия pg_dump ${tool.major} ниже версии сервера ${serverMajor}: нужен клиент PostgreSQL ${serverMajor} или новее`;
};

const argv = (tool: IPgTool, program: string, args: string[]): { file: string; args: string[] } =>
  tool.prefix.length > 0 ? { file: tool.prefix[0]!, args: [...tool.prefix.slice(1), program, ...args] } : { file: program, args };

// Окружение без чужих PG*-переменных: процесс получает ровно то подключение, которое задано.
const childEnv = (pgEnv: Record<string, string>): NodeJS.ProcessEnv => {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PG')) base[k] = v;
  return { ...base, ...pgEnv };
};

export interface IRunResult {
  code: number | null;
  stderr: string;
}

const STDERR_LIMIT = 4000;

// pg_dump -Fc со снимком: stdout → файл с SHA-256 на лету (одинаково для native и docker).
export const runPgDump = async (
  tool: IPgTool,
  url: string,
  o: { snapshotId: string; excludeTableData: readonly string[]; outFile: string; env?: Record<string, string | undefined> },
): Promise<IRunResult & { sizeBytes: number; sha256: string; command: string }> => {
  const args = ['--format=custom', '--no-password', `--snapshot=${o.snapshotId}`, ...o.excludeTableData.map((t) => `--exclude-table-data=${t}`)];
  const a = argv(tool, tool.dump, args);
  const child = spawn(a.file, a.args, { env: childEnv(pgEnvOf(url, tool, o.env ?? process.env)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += d.toString('utf8');
  });
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  await pipeline(child.stdout, tap, createWriteStream(o.outFile, { flags: 'wx' }));
  const code = await exited;
  return { code, stderr: stderr.slice(0, STDERR_LIMIT), sizeBytes: size, sha256: hash.digest('hex'), command: [a.file, ...a.args].join(' ') };
};

// pg_restore из файла через stdin (custom-формат читается последовательно) одной транзакцией; section — одна из
// секций дампа (pre-data, data, post-data): между ними восстановление исправляет функции старых дампов (S17-20).
export const runPgRestore = async (
  tool: IPgTool,
  url: string,
  dumpFile: string,
  env: Record<string, string | undefined> = process.env,
  section?: 'pre-data' | 'data' | 'post-data',
): Promise<IRunResult & { command: string }> => {
  const a = argv(tool, tool.restore, [
    '--single-transaction',
    '--exit-on-error',
    '--no-password',
    ...(section ? [`--section=${section}`] : []),
    `--dbname=${new URL(url).pathname.replace(/^\//u, '')}`,
  ]);
  const child = spawn(a.file, a.args, { env: childEnv(pgEnvOf(url, tool, env)), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, shell: false });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += d.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  await pipeline(createReadStream(dumpFile), child.stdin).catch(() => undefined);
  const code = await exited;
  return { code, stderr: stderr.slice(0, STDERR_LIMIT), command: [a.file, ...a.args].join(' ') };
};

// Один запрос через psql того же маршрута, что у pg_dump и pg_restore: ответ — без заголовков, одна строка.
export const runPsql = async (tool: IPgTool, url: string, sql: string, env: Record<string, string | undefined> = process.env): Promise<IRunResult & { stdout: string }> => {
  if (!tool.psql) return { code: null, stderr: 'psql не найден рядом с pg_restore', stdout: '' };
  const a = argv(tool, tool.psql, ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  const child = spawn(a.file, a.args, { env: childEnv(pgEnvOf(url, tool, env)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => {
    if (stdout.length < STDERR_LIMIT) stdout += d.toString('utf8');
  });
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += d.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on('close', (c) => resolve(c));
    child.on('error', () => resolve(null));
  });
  return { code, stdout: stdout.trim(), stderr: stderr.slice(0, STDERR_LIMIT) };
};

// Текстом: идентификатор кластера больше безопасного int8 разборщика pg (pool.ts).
export const CLUSTER_ID_SQL = 'SELECT system_identifier::text AS system_identifier FROM pg_control_system()';

// Кластер, к которому подключится инструмент, — тот же, что у прямого подключения по URL (R17-03): в режиме docker
// pg_restore идёт в сервер своего контейнера, и без сверки охранники и запись смотрели бы в разные кластеры.
// directId — идентификатор кластера, прочитанный прямым подключением по тому же URL. null — совпадает.
export const clusterIdentityProblem = async (tool: IPgTool, url: string, directId: string, env: Record<string, string | undefined> = process.env): Promise<string | null> => {
  const r = await runPsql(tool, url, CLUSTER_ID_SQL, env);
  const where = tool.mode === 'docker' ? `контейнер PG_DOCKER_CONTAINER=${tool.container}` : 'клиент PostgreSQL';
  if (r.code !== 0) return `не удалось сверить кластер инструмента (${where}): ${r.stderr.trim().slice(0, 300) || `код ${r.code}`}`;
  if (r.stdout !== directId) return `инструмент подключится к другому кластеру PostgreSQL (${where}): идентификатор ${r.stdout || '—'}, у адреса из настроек — ${directId}`;
  return null;
};

