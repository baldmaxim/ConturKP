// pg_dump и pg_restore для копии и проверки восстановления (этап 17, проект §4.3). Поиск: PG_BIN_DIR → PATH →
// docker exec <PG_DOCKER_CONTAINER> (кластер в контейнере, как у ревьюера). Старший номер версии клиента — не ниже
// сервера. Пароль — только в окружении дочернего процесса (PGPASSWORD), не в аргументах и не в журнале;
// shell: false, windowsHide: true. У docker exec нет -t: псевдотерминал испортил бы двоичный поток дампа.
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
  const candidates: Array<{ mode: 'native'; dump: string; restore: string }> = [];
  if (t.env.PG_BIN_DIR) candidates.push({ mode: 'native', dump: p.join(t.env.PG_BIN_DIR, exe('pg_dump')), restore: p.join(t.env.PG_BIN_DIR, exe('pg_restore')) });
  candidates.push({ mode: 'native', dump: exe('pg_dump'), restore: exe('pg_restore') });
  for (const c of candidates) {
    const v = await t.run(c.dump, ['--version']).catch(() => ({ code: null, stdout: '' }));
    const r = await t.run(c.restore, ['--version']).catch(() => ({ code: null, stdout: '' }));
    if (v.code === 0 && r.code === 0) {
      const version = v.stdout.trim().split(/\r?\n/u)[0] ?? '';
      return { mode: 'native', prefix: [], dump: c.dump, restore: c.restore, version, major: majorOf(version), container: null };
    }
  }
  const container = t.env.PG_DOCKER_CONTAINER;
  if (container) {
    const v = await t.run('docker', ['exec', container, 'pg_dump', '--version']).catch(() => ({ code: null, stdout: '' }));
    if (v.code === 0) {
      const version = v.stdout.trim().split(/\r?\n/u)[0] ?? '';
      const prefix = ['docker', 'exec', '-i', ...DOCKER_ENV.flatMap((n) => ['-e', n]), container];
      return { mode: 'docker', prefix, dump: 'pg_dump', restore: 'pg_restore', version, major: majorOf(version), container };
    }
  }
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
