// Процессы портала для эксплуатационных сценариев (этап 17): запуск server и worker с заданным окружением, остановка
// по IPC (на Windows child.kill() — всегда TerminateProcess, штатную остановку проверяет только IPC), ожидание /ready.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface IProc {
  name: string;
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

export const startNode = (name: string, script: string, o: { cwd: string; env: NodeJS.ProcessEnv }): IProc => {
  const child = spawn(process.execPath, [script], { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { name, child, output: () => out, exited };
};

// Штатная остановка: команда по IPC; не завершился за срок — жёсткое завершение (результат — null).
export const stopNode = async (p: IProc, timeoutMs: number): Promise<number | null> => {
  if (p.child.exitCode !== null) return p.child.exitCode;
  if (p.child.connected) p.child.send({ type: 'shutdown' });
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs).unref());
  const r = await Promise.race([p.exited, timer]);
  if (r === 'timeout') {
    p.child.kill('SIGKILL');
    await p.exited;
    return null;
  }
  return r;
};

export const killNode = async (p: IProc): Promise<void> => {
  if (p.child.exitCode !== null) return;
  p.child.kill('SIGKILL');
  await p.exited;
};

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const waitReady = async (base: string, timeoutMs: number): Promise<{ ok: boolean; body: unknown }> => {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/v1/ready`);
      last = await r.json();
      if (r.status === 200) return { ok: true, body: last };
    } catch {
      // сервер ещё не слушает
    }
    await sleep(500);
  }
  return { ok: false, body: last };
};

// Минимальный клиент API с cookie и CSRF, как браузер.
export class ApiClient {
  private readonly cookies = new Map<string, string>();
  private readonly base: string;
  private readonly origin: string;
  constructor(base: string, origin: string) {
    this.base = base;
    this.origin = origin;
  }

  async call(path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (this.cookies.size > 0) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const method = o.method ?? 'GET';
    if (method !== 'GET') {
      headers.Origin = this.origin;
      const csrf = this.cookies.get('kkp_csrf');
      if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
    }
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${this.base}/api/v1${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    for (const c of r.headers.getSetCookie()) {
      const pair = c.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      const value = pair.slice(i + 1);
      if (value === '') this.cookies.delete(pair.slice(0, i));
      else this.cookies.set(pair.slice(0, i), value);
    }
    return r;
  }
}
