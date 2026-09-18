// Ограничение перебора паролей: неудачные попытки по логину и по адресу за скользящее окно.
// Хранится в памяти процесса: портал — один процесс server (ADR-001); перезапуск сбрасывает счётчики.

const WINDOW_MS = 15 * 60_000;
const MAX_PER_LOGIN = 5;
const MAX_PER_IP = 20;

export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly clock: () => Date;

  constructor(clock: () => Date) {
    this.clock = clock;
  }

  private recent(key: string): number[] {
    const since = this.clock().getTime() - WINDOW_MS;
    const list = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  blocked(login: string, ip: string): boolean {
    return this.recent(`login:${login}`).length >= MAX_PER_LOGIN || this.recent(`ip:${ip}`).length >= MAX_PER_IP;
  }

  fail(login: string, ip: string): void {
    const now = this.clock().getTime();
    for (const key of [`login:${login}`, `ip:${ip}`]) this.failures.set(key, [...this.recent(key), now]);
  }

  succeed(login: string): void {
    this.failures.delete(`login:${login}`);
  }
}
